/**
 * Sidecar task-manifest reader/writer.
 *
 * Purpose: when a provider accepts an async generation submit (TTS, image,
 * video), we persist the returned task_id keyed by the expected output
 * filename. The reconciler later uses this for deterministic recovery
 * even if the immediate download/poll step times out or crashes.
 *
 * Storage: `.task-manifest.json` at the ROOT of the asset subfolder
 * (e.g. `{episode}/TN0001 - 07 Audio Assets/.task-manifest.json`).
 *
 * Why the asset subfolder (not the episode root)? Filename keys are unique
 * within a subfolder (e.g. `TN0001_Chapter_03.mp3`), and different asset
 * types have different naming. One manifest per subfolder keeps the schema
 * flat and prevents cross-contamination.
 *
 * Most writes are best-effort. Paid/durable provider boundaries use the
 * strict writer before submission so a missing sidecar can never turn an
 * uncertain request into duplicate provider work.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { withCrossProcessLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { clearImageValidationCache, isDecodableImage } from '../lib/image-validation.js'

const FILENAME = '.task-manifest.json'

/** The exact GenStudio output combination an original image request used. */
export interface PaidImageOutputSelector {
  resolution: string
  aspect_ratio: string
  width: number
  height: number
  reference_mode: 'normal' | 'reference-guided'
}

/** One ordered, content-addressed local reference supplied to an image request. */
export interface PaidImageReferenceInput {
  role: string
  path: string
  sha256: string
}

export interface TaskManifestEntry {
  provider: string        // 'genaipro' | 'fal' | 'kie' | 'kie-video' | 'fal-video' | 'elevenlabs'
  task_id: string
  submitted_at: string    // ISO 8601
  input_hash?: string     // sha256 of the input text/prompt, for collision detection
  // Optional provider-specific recovery hints. Filled by callers that know
  // their provider's polling needs more than just `task_id`. Always
  // optional → existing entries (audio prior to image/video recovery)
  // remain valid.
  //
  // poll_path  — kie.ai videos use a non-default sub-path per model
  //              (`/veo/record-info`, `/runway/record-info`, …). Storing
  //              it here means the reconciler doesn't have to re-derive
  //              the right path from the model id at recovery time.
  // result_url — fal.ai's queue API hands back a direct `response_url`
  //              at submit time; storing it lets the reconciler GET the
  //              result without re-resolving a status URL chain. Also
  //              useful as a debugging breadcrumb for any provider.
  poll_path?: string
  result_url?: string
  /** Stable Story-to-provider identity used to replay an ambiguous submit
   * without creating a second provider task. */
  idempotency_key?: string
  /** Append-only originals, scoped by this output key; explicit reruns add a new key. */
  subtitle_originals?: Record<string, {
    task_id: string
    idempotency_key: string
    input_hash: string
  }>
  operation?: 'tts' | 'transcription' | 'image' | 'video'
  /** Exact GenStudio operation selected for a video task. */
  variant_operation?: string
  /**
   * Last provider state Story Studio actually observed for `task_id`
   * ('prepared' before submit, then 'accepted' … 'succeeded' | 'failed').
   *
   * This is the ONLY local record that a saved provider job is terminal. Without
   * it a recovery path re-reads an ancient failed job forever instead of
   * submitting fresh work, so every durable image/audio boundary must write it.
   */
  last_state?: string
  /**
   * Logical Story-side attempt this entry belongs to.
   *
   * A deliberate retry after a TERMINAL provider failure derives a NEW scope
   * deterministically from the failed task id (see `resolveImageRetryScope`),
   * which changes the idempotency key and therefore guarantees exactly one
   * genuinely fresh provider job. Persisting the scope is what makes that retry
   * identity stable: if the fresh submission's response is lost, the next
   * attempt reads the same scope back, rebuilds the same idempotency key, and
   * re-attaches to the already-paid job instead of creating a second one.
   */
  request_scope?: string
  /**
   * Original image facts written before the first provider POST. They are
   * additive: older sidecars remain readable but cannot authorise paid reuse.
   */
  original_output_selector?: PaidImageOutputSelector
  original_reference_inputs?: PaidImageReferenceInput[]
  original_reference_identity_hash?: string
  original_output_path?: string
  /** Additive job-authoritative paid-replacement commitment facts. */
  replacement_of_task_id?: string
  replacement_scope?: string
  replacement_quoted_credits?: number
  replacement_price_version?: string
  replacement_committed_at?: string
  /** Full identities displaced only by an explicit customer replacement. */
  superseded_image_requests?: ImageRequestIdentityEvidence[]
  /**
   * Whether this transcription was REQUESTED with per-word timestamps.
   *
   * The only local record of it. Story Studio started asking for word timings
   * in v1.1.0; transcripts made before that stay coarse unless the customer
   * deliberately re-transcribes, and nothing else on disk distinguishes the
   * two. The Subtitles page reads this so the difference is visible instead of
   * being an unexplained quality gap between two episodes in one project.
   */
  word_timestamps?: boolean
}

export interface ImageRequestIdentityEvidence {
  provider: string
  task_id: string
  submitted_at: string
  input_hash?: string
  idempotency_key?: string
  operation?: 'image'
  last_state?: string
  request_scope?: string
}

export interface Manifest {
  schema_version: 1
  tasks: Record<string, TaskManifestEntry>
}

function manifestPath(assetDir: string): string {
  return path.join(assetDir, FILENAME)
}

export async function readManifest(assetDir: string): Promise<Manifest> {
  const p = manifestPath(assetDir)
  if (!existsSync(p)) return { schema_version: 1, tasks: {} }
  try {
    const raw = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Manifest>
    if (parsed?.schema_version === 1 && parsed.tasks && typeof parsed.tasks === 'object') {
      return { schema_version: 1, tasks: parsed.tasks }
    }
  } catch { /* corrupt — start fresh rather than propagate */ }
  return { schema_version: 1, tasks: {} }
}

/** Paid commitment must never turn a corrupt sidecar into a new authority. */
export async function readManifestStrict(assetDir: string): Promise<Manifest> {
  const p = manifestPath(assetDir)
  const raw = await fs.readFile(p, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<Manifest>
  if (parsed?.schema_version !== 1 || !parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)) {
    throw new Error('task manifest is invalid')
  }
  for (const entry of Object.values(parsed.tasks)) {
    const originals = entry?.subtitle_originals
    if (originals === undefined) continue // Legacy tasks can still recover for free.
    if (!originals || typeof originals !== 'object' || Array.isArray(originals)
      || Object.entries(originals).some(([key, original]) => !original
        || ![original.task_id, original.idempotency_key, original.input_hash].every(v => typeof v === 'string' && v.trim())
        || key !== original.idempotency_key)) throw new Error('task manifest subtitle original identity is invalid')
  }
  return { schema_version: 1, tasks: parsed.tasks }
}

function samePaidImageOriginal(left: TaskManifestEntry, right: TaskManifestEntry): boolean {
  return left.task_id === right.task_id
    && left.idempotency_key === right.idempotency_key
    && left.input_hash === right.input_hash
    && left.request_scope === right.request_scope
    && left.original_output_path === right.original_output_path
    && left.original_reference_identity_hash === right.original_reference_identity_hash
    && JSON.stringify(left.original_output_selector) === JSON.stringify(right.original_output_selector)
    && JSON.stringify(left.original_reference_inputs) === JSON.stringify(right.original_reference_inputs)
}

function sameImageAttempt(
  left: TaskManifestEntry | undefined,
  right: TaskManifestEntry | null,
): boolean {
  if (!right) return !left
  return Boolean(left)
    && left!.provider === right.provider
    && left!.input_hash === right.input_hash
    && left!.idempotency_key === right.idempotency_key
    && left!.request_scope === right.request_scope
    && (Boolean(right.idempotency_key) || left!.task_id === right.task_id)
}

function mergeSupersededImageRequests(
  previous: ImageRequestIdentityEvidence[] | undefined,
  next: ImageRequestIdentityEvidence[] | undefined,
): ImageRequestIdentityEvidence[] | undefined {
  const merged = [...(previous || []), ...(next || [])]
  if (!merged.length) return undefined
  return merged.filter((entry, index) => merged.findIndex(candidate =>
    candidate.task_id === entry.task_id
    && candidate.idempotency_key === entry.idempotency_key
    && candidate.request_scope === entry.request_scope,
  ) === index)
}

/**
 * Per-assetDir write chain. Parallel workers (audio chunks, image variants,
 * video clips) all call recordTask concurrently for *different* filenames
 * in the *same* manifest. The body is a read-modify-write across two
 * awaits, so without serialization two interleaved calls can race:
 *
 *   A: read m  (tasks: {})
 *   B: read m  (tasks: {})  ← still empty, A hasn't written yet
 *   A: m.tasks.a = entryA; write
 *   B: m.tasks.b = entryB; write  ← clobbers A's write, entryA is lost
 *
 * Lost entries silently break retry-then-repair: the reconciler can't find
 * the in-flight task and the user double-pays on the next retry.
 *
 * Fix: chain writes per assetDir. Different folders don't block each
 * other, but writes to the same manifest serialize. The chain settles
 * regardless of outcome (.catch swallows so one failure doesn't poison
 * the chain). Map entry is reset to a resolved promise on settle to
 * avoid an unbounded promise chain in long-running sessions.
 */
const writeChains = new Map<string, Promise<void>>()

async function writeTaskEntry(
  assetDir: string,
  filename: string,
  entry: TaskManifestEntry,
  strict: boolean,
): Promise<void> {
  const key = path.resolve(assetDir)
  const previous = writeChains.get(key) ?? Promise.resolve()
  const operation = previous.then(async () => {
    await fs.mkdir(assetDir, { recursive: true })
    const m = strict ? await readManifestStrict(assetDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1 as const, tasks: {} } as Manifest
      throw error
    }) : await readManifest(assetDir)
    const latest = m.tasks[filename]
    const originals = latest?.subtitle_originals || {}
    if (entry.subtitle_originals && (!latest || latest.idempotency_key !== entry.idempotency_key
      || latest.input_hash !== entry.input_hash || (latest.task_id && latest.task_id !== entry.task_id))) {
      throw new Error('task manifest current identity changed before subtitle original binding')
    }
    for (const [originalKey, original] of Object.entries(entry.subtitle_originals || {})) {
      const saved = originals[originalKey]
      if (saved ? saved.task_id !== original.task_id || saved.idempotency_key !== original.idempotency_key || saved.input_hash !== original.input_hash
        : originalKey !== original.idempotency_key || !latest || latest.idempotency_key !== original.idempotency_key
          || latest.input_hash !== original.input_hash || (latest.task_id && latest.task_id !== original.task_id)) {
        throw new Error('task manifest subtitle original identity changed before paid commitment')
      }
    }
    const superseded = mergeSupersededImageRequests(
      latest?.superseded_image_requests,
      entry.superseded_image_requests,
    )
    m.tasks[filename] = {
      ...entry,
      ...(latest?.subtitle_originals || entry.subtitle_originals
        ? { subtitle_originals: { ...entry.subtitle_originals, ...originals } } : {}),
      ...(superseded ? { superseded_image_requests: superseded } : {}),
    }
    await writeJsonAtomic(manifestPath(assetDir), m)
  })
  // Keep a non-rejecting tail in the chain so one failed write cannot block
  // later assets in the same folder. Strict callers still await `operation`
  // and receive the original persistence error before provider submission.
  const tail = operation.catch(() => {})
  writeChains.set(key, tail)
  void tail.finally(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key)
  })

  if (strict) {
    await operation
    return
  }
  try {
    await operation
  } catch (e: any) {
    console.warn(`[task-manifest] could not record ${filename}:`, e.message)
  }
}

/**
 * Record a task-id for a given output filename. Never throws — if the
 * manifest can't be written, we log and continue so generation flows
 * aren't disrupted by a sidecar hiccup.
 */
export async function recordTask(
  assetDir: string,
  filename: string,
  entry: TaskManifestEntry,
): Promise<void> {
  await writeTaskEntry(assetDir, filename, entry, false)
}

/**
 * Durable variant for provider boundaries where losing the request identity
 * could duplicate paid work. A failed write aborts before submission instead
 * of silently degrading recovery guarantees.
 */
export async function recordTaskStrict(
  assetDir: string,
  filename: string,
  entry: TaskManifestEntry,
): Promise<void> {
  await writeTaskEntry(assetDir, filename, entry, true)
}

/** Claim one scene image identity under the same durable lock used to promote it. */
export async function compareAndRecordImageTaskStrict(
  assetDir: string,
  filename: string,
  expected: TaskManifestEntry | null,
  next: TaskManifestEntry,
): Promise<void> {
  await withCrossProcessLock(manifestPath(assetDir), async () => {
    const manifest = await readManifestStrict(assetDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1 as const, tasks: {} } as Manifest
      throw error
    })
    if (!sameImageAttempt(manifest.tasks[filename], expected)) {
      throw new Error('Scene image ownership changed before the request could be recorded.')
    }
    await recordTaskStrict(assetDir, filename, next)
  })
}

/** Claim a manual missing-image request only if no completed output won first. */
export async function claimMissingImageTaskStrict(
  assetDir: string,
  filename: string,
  outputPath: string,
  expected: TaskManifestEntry | null,
  next: TaskManifestEntry,
): Promise<boolean> {
  return withCrossProcessLock(manifestPath(assetDir), async () => {
    const manifest = await readManifestStrict(assetDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1 as const, tasks: {} } as Manifest
      throw error
    })
    if (!sameImageAttempt(manifest.tasks[filename], expected)) {
      throw new Error('Scene image ownership changed before the request could be recorded.')
    }
    if (await isDecodableImage(outputPath)) return false
    await recordTaskStrict(assetDir, filename, next)
    return true
  })
}

/** Promote and checkpoint only while this exact request still owns the manifest row. */
export async function promoteCurrentImageTaskArtifactStrict(
  assetDir: string,
  filename: string,
  expected: TaskManifestEntry,
  stagingPath: string,
  outputPath: string,
  checkpoint: () => Promise<void>,
): Promise<boolean> {
  return withCrossProcessLock(manifestPath(assetDir), async () => {
    const current = (await readManifestStrict(assetDir)).tasks[filename]
    if (!sameImageAttempt(current, expected)) {
      await fs.rm(stagingPath, { force: true }).catch(() => {})
      return false
    }
    await fs.rename(stagingPath, outputPath)
    clearImageValidationCache(outputPath)
    await checkpoint()
    return true
  })
}

/**
 * Merge only paid commitment fields into the latest strict sidecar entry.
 * The persisted original identity must still equal the entry the decision
 * revalidated before any network read; a concurrent original update blocks.
 */
export async function recordPaidImageReplacementStrict(
  assetDir: string,
  filename: string,
  expected: TaskManifestEntry,
): Promise<void> {
  await withCrossProcessLock(manifestPath(assetDir), async () => {
    const key = path.resolve(assetDir)
    const previous = writeChains.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const manifest = await readManifestStrict(assetDir)
      const latest = manifest.tasks[filename]
      if (!latest || !samePaidImageOriginal(latest, expected)) {
        throw new Error('task manifest original identity changed before paid commitment')
      }
      manifest.tasks[filename] = {
        ...latest,
        replacement_of_task_id: expected.replacement_of_task_id,
        replacement_scope: expected.replacement_scope,
        replacement_quoted_credits: expected.replacement_quoted_credits,
        replacement_price_version: expected.replacement_price_version,
        replacement_committed_at: expected.replacement_committed_at,
      }
      await writeJsonAtomic(manifestPath(assetDir), manifest)
    })
    const tail = operation.catch(() => {})
    writeChains.set(key, tail)
    void tail.finally(() => {
      if (writeChains.get(key) === tail) writeChains.delete(key)
    })
    await operation
  })
}

export function getTaskEntry(manifest: Manifest, filename: string): TaskManifestEntry | null {
  return manifest.tasks[filename] || null
}

export function hashInput(input: string): string {
  // First 16 hex chars is plenty for collision detection within one episode.
  return 'sha256:' + createHash('sha256').update(input).digest('hex').slice(0, 16)
}
