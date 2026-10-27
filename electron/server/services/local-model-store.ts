/**
 * Local model store — the files half of duplicate screening.
 *
 * Downloads EmbeddingGemma 2 (and the ONNX runtime that runs it) into Story's
 * own app-support folder, ONLY when the owner turns the feature on (owner,
 * 2026-10-27). Nothing here is in the DMG: the shipped app grows by neither
 * the weights (≈970 MB) nor the native runtime (≈46 MB) for a feature that is
 * off by default.
 *
 * Rules this file keeps:
 *
 * - **Pinned and verified.** Every file is fetched from ONE immutable
 *   Hugging Face revision and checked against a pinned size and SHA-256 before
 *   it is used. A mismatch is refused, the bad bytes are discarded, and the
 *   download starts clean rather than resuming onto a lie.
 * - **Resumable, honestly.** A partial file resumes with a Range request and
 *   the final hash decides whether the resumed bytes were right. A server that
 *   ignores the range, or a hash mismatch on a resumed file, means restart —
 *   never "close enough".
 * - **Removal goes to Story's Trash, never `rm`** (AGENTS.md working rules).
 * - **Never a model endpoint.** This is the one named exception to §7's
 *   single-endpoint rule: a file download. No generation request is sent, and
 *   nothing read from here routes any model.
 * - **Never a fallback.** If the store is absent or unreadable the caller gets
 *   `not_checked` with a reason; this module invents no numbers.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  LOCAL_EMBEDDING_FILES,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_RUNTIME_FILES,
  modelFileUrl,
  runtimeFileUrl,
  totalModelBytes,
  totalRuntimeBytes,
  type ModelFileSpec,
} from '../contracts/local-duplicate-screening.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { getUserDataDir } from './project-manager.js'

/** A `.part` suffix marks bytes that have not been verified yet. */
const PART_SUFFIX = '.part'

export type LocalModelPhase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'done'
  | 'error'

export interface LocalModelProgress {
  phase: LocalModelPhase
  /** 0–100, over model + runtime bytes together. */
  percent: number
  message: string
  /** Bytes fetched so far, and the total expected. */
  bytes_done: number
  bytes_total: number
  /** The file currently being fetched, for a status line worth reading. */
  file?: string
  started_at?: number
  finished_at?: number
  error?: string
}

/**
 * The feature's app-support folder. `getUserDataDir()` is resolved on every
 * access (never captured) so a test that redirects STORY_STUDIO_DATA_DIR, or a
 * packaged app whose path appears late, both get the right answer.
 */
export function localModelRoot(): string {
  return path.join(getUserDataDir(), 'embedding-models')
}

/** The pinned model revision this app qualified. One directory per revision, so a bump re-downloads cleanly. */
export function localModelDir(): string {
  return path.join(localModelRoot(), LOCAL_EMBEDDING_MODEL.revision)
}

/** The fetched runtime, beside the model but versioned the same way. */
export function localRuntimeDir(): string {
  return path.join(
    localModelRoot(),
    `runtime-${LOCAL_EMBEDDING_MODEL.runtime.package}-${LOCAL_EMBEDDING_MODEL.runtime.version}`,
  )
}

export interface LocalModelStatus {
  /** Every expected file is present with its published size and hash. */
  installed: boolean
  /** Enough bytes are on disk for the feature to be worth switching on. */
  partial: boolean
  /** Bytes currently on disk for this revision (verified + in-progress). */
  bytes_present: number
  /** Total this feature will occupy. */
  bytes_total: number
  /** Human-readable, for the status line. */
  size_label: string
  /** Files that are missing or failed verification, by relative path. */
  missing: string[]
  model_dir: string
  runtime_dir: string
  /** The model's identity, so the page can say what it is rather than "the model". */
  model_id: string
  license: string
  revision: string
}

// ── Progress, mirrored for a polling UI (the FFmpeg install precedent) ──────

let progressState: LocalModelProgress = { phase: 'idle', percent: 0, message: '', bytes_done: 0, bytes_total: 0 }

export function getLocalModelProgress(): LocalModelProgress {
  return { ...progressState }
}

export function _resetLocalModelProgressForTesting(): void {
  progressState = { phase: 'idle', percent: 0, message: '', bytes_done: 0, bytes_total: 0 }
}

function setProgress(patch: Partial<LocalModelProgress>): void {
  progressState = { ...progressState, ...patch }
}

// ── Verification ───────────────────────────────────────────────────────────

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

export type FileVerdict = 'ok' | 'missing' | 'wrong-size' | 'wrong-hash'

/**
 * Is this file exactly the pinned bytes?
 *
 * Size is checked first because it is free, and it is also the only check that
 * can run on a `.part` file mid-download. The hash is what decides.
 */
export async function verifyFile(file: string, spec: ModelFileSpec): Promise<FileVerdict> {
  let stat: fs.Stats
  try {
    stat = await fsp.stat(file)
  } catch {
    return 'missing'
  }
  if (!stat.isFile()) return 'missing'
  if (stat.size !== spec.bytes) return 'wrong-size'
  if (!spec.sha256) return 'wrong-size'
  return (await sha256OfFile(file)) === spec.sha256 ? 'ok' : 'wrong-hash'
}

/** Which files are on disk and correct. One list per store, so the status is not two half-answers. */
async function missingFiles(dir: string, files: ModelFileSpec[]): Promise<string[]> {
  const missing: string[] = []
  for (const spec of files) {
    if ((await verifyFile(path.join(dir, spec.path), spec)) !== 'ok') missing.push(spec.path)
  }
  return missing
}

export async function localModelStatus(): Promise<LocalModelStatus> {
  const modelDir = localModelDir()
  const runtimeDir = localRuntimeDir()
  const [missingModel, missingRuntime] = await Promise.all([
    missingFiles(modelDir, LOCAL_EMBEDDING_FILES),
    missingFiles(runtimeDir, LOCAL_RUNTIME_FILES),
  ])
  const missing = [...missingModel, ...missingRuntime]
  const bytesTotal = totalModelBytes() + totalRuntimeBytes()
  const bytesPresent = await bytesOnDisk(modelDir, runtimeDir)
  return {
    installed: missing.length === 0,
    partial: bytesPresent > 0 && missing.length > 0,
    bytes_present: bytesPresent,
    bytes_total: bytesTotal,
    size_label: formatTotal(bytesTotal),
    missing,
    model_dir: modelDir,
    runtime_dir: runtimeDir,
    model_id: LOCAL_EMBEDDING_MODEL.model_id,
    license: LOCAL_EMBEDDING_MODEL.license,
    revision: LOCAL_EMBEDDING_MODEL.revision,
  }
}

function formatTotal(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/** Real bytes for this revision: finished files plus any resumable partial. */
async function bytesOnDisk(modelDir: string, runtimeDir: string): Promise<number> {
  let total = 0
  for (const [dir, files] of [[modelDir, LOCAL_EMBEDDING_FILES], [runtimeDir, LOCAL_RUNTIME_FILES]] as const) {
    for (const spec of files) {
      for (const candidate of [path.join(dir, spec.path), path.join(dir, spec.path) + PART_SUFFIX]) {
        try {
          const stat = await fsp.stat(candidate)
          if (stat.isFile()) total += stat.size
        } catch { /* absent is zero, not a failure */ }
      }
    }
  }
  return total
}

/**
 * Set by a test to decide "is the model installed?" without a 1 GB download.
 *
 * Exists so the check tests can run against stub vectors and no model at all.
 * Writing exact-size stand-in files was the obvious alternative and it was
 * worse: the fixture harness snapshots the sandbox, so each run materialised
 * ~1 GB of zeros on the owner's disk for a test that never reads a byte of it.
 */
let installedOverride: boolean | null = null
export function _setLocalModelInstalledForTesting(installed: boolean | null): void {
  installedOverride = installed
}

/** Cheap existence check for the hot path — no hashing. The worker verifies nothing. */
export async function localModelLooksInstalled(): Promise<boolean> {
  if (installedOverride !== null) return installedOverride
  try {
    for (const spec of LOCAL_EMBEDDING_FILES) {
      const stat = await fsp.stat(path.join(localModelDir(), spec.path))
      if (!stat.isFile() || stat.size !== spec.bytes) return false
    }
    for (const spec of LOCAL_RUNTIME_FILES) {
      const stat = await fsp.stat(path.join(localRuntimeDir(), spec.path))
      if (!stat.isFile() || stat.size !== spec.bytes) return false
    }
    return true
  } catch {
    return false
  }
}

// ── Download ───────────────────────────────────────────────────────────────

interface DownloadResult {
  file: string
  bytes: number
}

/** One `fetch`, following redirects (Hugging Face serves through a CDN). */
async function fetchWithRange(url: string, from: number): Promise<Response> {
  const headers: Record<string, string> = {}
  if (from > 0) headers.Range = `bytes=${from}-`
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok && response.status !== 206) {
    throw new Error(`The model server answered ${response.status} ${response.statusText} for ${path.basename(url)}.`)
  }
  return response
}

/**
 * Fetch one file into `dir`, resuming a `.part` when the server cooperates.
 *
 * `onBytes` is called with the running total so the caller can drive one
 * progress bar across every file. The returned file is verified — this
 * function either hands back pinned bytes or throws.
 */
async function downloadFile(
  url: string,
  dir: string,
  spec: ModelFileSpec,
  onBytes: (delta: number) => void,
): Promise<DownloadResult> {
  await fsp.mkdir(path.dirname(path.join(dir, spec.path)), { recursive: true })
  const finalPath = path.join(dir, spec.path)
  const partPath = finalPath + PART_SUFFIX

  // Already there and correct? Nothing to fetch. This is what makes a retry
  // after a partly failed run cost only the files that are actually missing.
  if ((await verifyFile(finalPath, spec)) === 'ok') return { file: finalPath, bytes: 0 }

  let resumeFrom = 0
  try {
    const stat = await fsp.stat(partPath)
    // A `.part` at or past the expected size cannot be a prefix of the answer.
    resumeFrom = stat.size < spec.bytes ? stat.size : 0
    if (resumeFrom === 0) await fsp.rm(partPath, { force: true })
  } catch { resumeFrom = 0 }

  let response: Response
  try {
    response = await fetchWithRange(url, resumeFrom)
  } catch (error: any) {
    throw new Error(`Could not reach the model server for ${spec.path} (${error?.message || 'network error'}).`)
  }

  // A 200 to a ranged request means the server sent the whole file from byte 0;
  // appending it to a partial would corrupt the result, so start over.
  const resuming = resumeFrom > 0 && response.status === 206
  if (resumeFrom > 0 && !resuming) {
    await fsp.rm(partPath, { force: true })
    onBytes(-resumeFrom)
    process.stderr.write(`[local-model] ${spec.path}: server ignored the resume range; restarting that file cleanly.\n`)
  }

  const body = response.body
  if (!body) throw new Error(`The model server sent no bytes for ${spec.path}.`)

  let written = 0
  const source = Readable.fromWeb(body as any)
  source.on('data', (chunk: Buffer) => {
    written += chunk.length
    onBytes(chunk.length)
  })
  try {
    await pipeline(source, fs.createWriteStream(partPath, { flags: resuming ? 'a' : 'w' }))
  } catch (error: any) {
    throw new Error(`The download of ${spec.path} stopped early (${error?.message || 'stream error'}). It will resume.`)
  }

  const verdict = await verifyFile(partPath, spec)
  if (verdict !== 'ok') {
    // Bad bytes are never promoted. Removing the partial makes the next
    // attempt a clean start rather than a resume onto a lie.
    await fsp.rm(partPath, { force: true })
    onBytes(-(resumeFrom + written))
    throw new Error(
      verdict === 'wrong-hash'
        ? `${spec.path} did not match its published SHA-256, so it was discarded. The download will restart that file.`
        : `${spec.path} arrived ${written} bytes when ${spec.bytes} were expected, so it was discarded and will restart.`,
    )
  }
  await fsp.rename(partPath, finalPath)
  return { file: finalPath, bytes: written }
}

let downloadInFlight: Promise<LocalModelStatus> | null = null

/**
 * Fetch exactly one file, with its resume and hash rules.
 *
 * Exported for tests only. `downloadLocalModel` walks the manifest in order, so
 * a test that wants to prove "the second file's bad hash is refused" cannot
 * reach that file without also serving the first one correctly. This seam lets
 * the resume and hash rules be proved on the file they are about, against the
 * same code the real download runs.
 */
export async function _downloadOneFileForTesting(
  url: string,
  dir: string,
  spec: ModelFileSpec,
): Promise<{ file: string; bytes: number }> {
  return downloadFile(url, dir, spec, () => {})
}

/**
 * Download the model and the runtime, verifying every file.
 *
 * **One at a time** (owner's rule for the worker, and it applies here too): a
 * second call joins the first rather than starting a competing transfer.
 */
export function downloadLocalModel(
  onProgress?: (progress: LocalModelProgress) => void,
): Promise<LocalModelStatus> {
  if (downloadInFlight) return downloadInFlight
  downloadInFlight = (async () => {
    const modelDir = localModelDir()
    const runtimeDir = localRuntimeDir()
    await fsp.mkdir(modelDir, { recursive: true })
    await fsp.mkdir(runtimeDir, { recursive: true })

    const bytesTotal = totalModelBytes() + totalRuntimeBytes()
    const bytesAlready = await bytesOnDisk(modelDir, runtimeDir)
    let bytesDone = 0
    const startedAt = Date.now()

    const emit = (patch: Partial<LocalModelProgress>) => {
      setProgress({ bytes_done: Math.max(0, Math.min(bytesTotal, bytesAlready + bytesDone)), bytes_total: bytesTotal, ...patch })
      setProgress({ percent: Math.round((progressState.bytes_done / Math.max(1, bytesTotal)) * 100) })
      onProgress?.(getLocalModelProgress())
    }

    let lastEmit = 0
    const onBytes = (delta: number) => {
      bytesDone += delta
      // Emitting per chunk would spend more time formatting than downloading.
      const now = Date.now()
      if (now - lastEmit < 250) return
      lastEmit = now
      emit({})
    }

    emit({ phase: 'downloading', message: 'Preparing the download…', started_at: startedAt })

    try {
      for (const spec of LOCAL_EMBEDDING_FILES) {
        emit({ phase: 'downloading', file: spec.path, message: `Downloading ${spec.path}…` })
        await downloadFile(modelFileUrl(spec.path), modelDir, spec, onBytes)
      }
      for (const spec of LOCAL_RUNTIME_FILES) {
        emit({ phase: 'downloading', file: spec.path, message: `Downloading the inference runtime (${spec.path})…` })
        await downloadFile(runtimeFileUrl(spec.path), runtimeDir, spec, onBytes)
      }

      emit({ phase: 'verifying', message: 'Checking every file against its published size and hash…' })
      const status = await localModelStatus()
      if (!status.installed) {
        throw new Error(`The download finished but ${status.missing.length} file(s) did not verify: ${status.missing.join(', ')}.`)
      }
      setProgress({
        phase: 'done', percent: 100, message: 'Ready.', file: undefined,
        bytes_done: status.bytes_present, bytes_total: status.bytes_total, finished_at: Date.now(), error: undefined,
      })
      onProgress?.(getLocalModelProgress())
      return status
    } catch (error: any) {
      const message = error?.message || String(error)
      setProgress({ phase: 'error', message, error: message, finished_at: Date.now() })
      onProgress?.(getLocalModelProgress())
      throw error
    } finally {
      downloadInFlight = null
    }
  })()
  return downloadInFlight
}

// ── Removal ────────────────────────────────────────────────────────────────

export interface RemoveResult {
  removed: string[]
  /** Where the files went, so the message can say it. */
  trash_dir: string
  problems: string[]
}

/**
 * Move the downloaded model (and runtime) to Story's Trash.
 *
 * Deliberately `moveToTrashSync` and not `rm`: this repo's rule is that every
 * removal is recoverable, and the model is nearly a gigabyte of the owner's
 * bandwidth. The Trash root is Story's own (`<Library>/_trash`), which the
 * Trash page already lists.
 */
export async function removeLocalModel(): Promise<RemoveResult> {
  const removed: string[] = []
  const problems: string[] = []
  const roots = [localModelDir(), localRuntimeDir()]
  // Routed through `trashRootFor`, never a hand-built `_trash` path: the app has
  // ONE Trash convention (`electron/server/__tests__/universal-trash.test.ts`
  // enforces it), and the model store is not exempt from it. Its "library" is the
  // model root, so Trash lands beside the downloaded revisions and the Trash page
  // lists it like any other removal.
  const trashBase = localModelTrashDir()
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue
    try {
      const target = path.join(trashBase, path.basename(dir), path.basename(dir))
      const moved = moveToTrashSync(dir, target, 'embedding-model')
      removed.push(moved)
    } catch (error: any) {
      problems.push(`${path.basename(dir)}: ${error?.message || 'could not be moved to the Trash'}`)
    }
  }
  if (!removed.length && !problems.length) {
    problems.push('There was nothing downloaded to remove.')
  }
  _resetLocalModelProgressForTesting()
  return { removed, trash_dir: trashBase, problems }
}

/** Exported for the route's message; keeps the trash location in one place. */
export function localModelTrashDir(): string {
  return trashRootFor(localModelRoot(), localModelRoot(), 'model-store')
}
