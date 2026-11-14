/**
 * Story's local-first footage library (v1.4.402).
 *
 * The Gateway owns the footage catalogue and store; this Mac owns a copy of the
 * clips it has actually used, under the folder the owner configured
 * (`footage_root`). The order is deliberate:
 *
 *   1. **Local first.** `resolveFootage()` looks for `<sha256>.<ext>` in the
 *      footage root and returns it without calling the Gateway. A machine with
 *      the clip on disk works with the Gateway switched off.
 *   2. **Fetch on miss.** `fetchFootage()` downloads once, checks the bytes
 *      really hash to the clip id, writes the sidecar and the media atomically,
 *      and never downloads the same clip again while the copy is sound.
 *   3. **Honest states.** A missing or unwritable root names the folder and
 *      that it may be an unplugged drive; a Gateway that cannot be reached
 *      names the clip and says so. Neither reads as "there are no clips".
 *
 * Nothing is deleted. A local file whose bytes no longer match its name is
 * moved to Story's Trash (a `_trash` beside the footage, so the rename never
 * crosses drives) and fetched again.
 */
import fs from 'fs/promises'
import { createReadStream } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { getFootageRoot, getGenStudioUrl } from './app-settings.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { TRASH_DIRNAME, APP_TRASH, moveToTrashSync } from '../lib/trash-move.js'
import {
  downloadFootageFile,
  type FootageCatalogueRow,
} from '../lib/footage-client.js'

const CLIP_ID = /^[0-9a-f]{64}$/
const LOCAL_CLIP_NAME = /^([0-9a-f]{64})\.([a-z0-9]+)$/
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi'])
const MEDIA_TYPE_EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
}

/** `<sha256>.json`, written beside the clip with only what the Gateway published. */
export interface FootageSidecar {
  sha256: string
  bytes: number
  mime: string
  fetched_at: string
  title: string | null
  source: string | null
  licence: string | null
  /** The Gateway's `provenance` (e.g. "Wikimedia stock"), verbatim. */
  origin: string | null
  source_id?: string
  source_url?: string
  licence_note?: string
  author?: string
  attribution?: string
  filetype?: string
  resolution?: string
  codec?: string
  duration_seconds?: number
  width?: number
  height?: number
  fps?: number
  filesize_bytes?: number
  tags?: string[]
  ai_generated?: boolean
}

function clipId(value: string): string {
  const id = String(value || '').trim().toLowerCase()
  if (!CLIP_ID.test(id)) {
    throw new Error(`The stock clip "${value || 'unknown'}" has no valid identifier, so it cannot be resolved.`)
  }
  return id
}

function clipLabel(row: FootageCatalogueRow | undefined, id: string): string {
  return typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : id.slice(0, 12)
}

/**
 * The configured folder, ready to use. Created 0700 when it is Story's own new
 * folder; an existing folder keeps the owner's permissions.
 */
async function footageRootReady(): Promise<string> {
  const root = await getFootageRoot()
  assertWriteIsolatedInTests(root, 'footage-root')
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await fs.stat(root)).isDirectory()) throw new Error('it is a file, not a folder')
  } catch (error: any) {
    throw new Error(
      `The footage folder "${root}" is not available (${error?.message || String(error)}). `
      + 'It may be on a drive that is not connected, or a folder Story Studio cannot write into.',
    )
  }
  return root
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve())
  })
  return hash.digest('hex')
}

/** The exact clip file, matched on the FULL `<sha256>.<ext>` name, never a prefix. */
async function findLocalName(root: string, id: string): Promise<string | null> {
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`The footage folder "${root}" could not be read (${error?.message || String(error)}).`)
  }
  for (const name of names.sort()) {
    const match = LOCAL_CLIP_NAME.exec(name)
    if (!match || match[1] !== id) continue
    // `<sha256>.json` is the sidecar, not the clip: only the stored containers count.
    if (!VIDEO_EXTENSIONS.has(match[2]!) && match[2] !== 'bin') continue
    return name
  }
  return null
}

function moveCorruptToTrash(root: string, name: string): void {
  // A `_trash` inside the footage folder keeps the move a rename: a NAS or
  // external drive must never need a cross-volume copy to retire bad bytes.
  const bucket = path.join(root, TRASH_DIRNAME, APP_TRASH, 'footage')
  assertWriteIsolatedInTests(bucket, 'footage-trash')
  moveToTrashSync(path.join(root, name), path.join(bucket, name), 'footage-corrupt')
  // The sidecar describes the bytes that just failed, so it goes with them.
  const sidecar = path.join(root, `${LOCAL_CLIP_NAME.exec(name)![1]}.json`)
  try { moveToTrashSync(sidecar, path.join(bucket, path.basename(sidecar)), 'footage-corrupt') } catch { /* none beside it */ }
}

/** The verified local clip, or null when this Mac does not have it. */
async function verifiedLocalClip(root: string, id: string): Promise<string | null> {
  const name = await findLocalName(root, id)
  if (!name) return null
  const file = path.join(root, name)
  let actual: string
  try {
    actual = await sha256File(file)
  } catch (error: any) {
    throw new Error(`The footage clip "${file}" could not be read (${error?.message || String(error)}). It is in the footage folder but this Mac cannot open it.`)
  }
  if (actual === id) return file
  moveCorruptToTrash(root, name)
  return null
}

/**
 * The local copy of a clip, or null when this Mac does not have it.
 *
 * The bytes are hashed before they are returned, so a torn download or a file
 * swapped under the same name is never handed to a render. (Shortcut: this
 * reads the whole clip on every local hit; add a size/mtime index when clips
 * routinely run to gigabytes and resolves get hot.)
 */
export async function resolveFootage(sha256: string): Promise<string | null> {
  const id = clipId(sha256)
  const root = await footageRootReady()
  return verifiedLocalClip(root, id)
}

function sidecarFor(
  id: string,
  bytes: Buffer,
  mime: string,
  row: FootageCatalogueRow | undefined,
): FootageSidecar {
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)
  const sidecar: FootageSidecar = {
    sha256: id,
    bytes: bytes.length,
    mime,
    fetched_at: new Date().toISOString(),
    title: text(row?.title),
    source: text(row?.source),
    licence: text(row?.licence),
    origin: text(row?.provenance),
  }
  for (const key of ['source_id', 'source_url', 'licence_note', 'author', 'attribution', 'filetype', 'resolution', 'codec'] as const) {
    const value = text(row?.[key])
    if (value !== null) sidecar[key] = value
  }
  for (const key of ['duration_seconds', 'width', 'height', 'fps', 'filesize_bytes'] as const) {
    const value = row?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) sidecar[key] = value
  }
  if (Array.isArray(row?.tags)) {
    sidecar.tags = row.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
  }
  // Only when the Gateway published a boolean; absent is absent, never false.
  if (typeof row?.ai_generated === 'boolean') sidecar.ai_generated = row.ai_generated
  return sidecar
}

/** Temp + fsync + rename, 0600. The same crash-safety as `writeJsonAtomic`, for bytes. */
async function writeBytesAtomic(target: string, bytes: Buffer): Promise<void> {
  const dir = path.dirname(target)
  const staging = `${target}.part-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    const handle = await fs.open(staging, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(staging, target)
  } catch (error) {
    await fs.unlink(staging).catch(() => {})
    throw error
  }
  if (process.platform !== 'win32') {
    try {
      const dirHandle = await fs.open(dir, 'r')
      try { await dirHandle.sync() } finally { await dirHandle.close() }
    } catch { /* directory fsync is best-effort, as in atomic-store */ }
  }
}

async function gatewayFailure(error: any, label: string, id: string): Promise<Error> {
  const detail = error?.name === 'AbortError'
    ? 'the request timed out'
    : String(error?.message || 'no answer from the Gateway')
  if (typeof error?.statusCode === 'number') {
    return new Error(`The Gateway could not send "${label}" (${detail}). Nothing was downloaded.`)
  }
  if (/^No Gateway API Key configured/.test(detail)) {
    return new Error(`${detail} The stock clip "${label}" is not on this Mac, so it could not be downloaded.`)
  }
  let where = 'the Gateway'
  try { where = await getGenStudioUrl() } catch { /* the default name is still honest */ }
  return new Error(
    `The stock clip "${label}" (${id.slice(0, 12)}…) is not on this Mac and the Gateway is unreachable at ${where} (${detail}). `
    + 'Nothing was downloaded. Reconnect the Gateway and try again.',
  )
}

/**
 * The clip on this Mac, downloading it once when it is absent. `catalogueRow`
 * is the row the caller already has from search or the library listing, and is
 * where the sidecar's licence and origin come from; without it the sidecar
 * still records the identity and measured bytes, and the unpublished fields
 * stay null. A present clip never touches the network.
 */
export async function fetchFootage(sha256: string, catalogueRow?: FootageCatalogueRow): Promise<string> {
  const id = clipId(sha256)
  return withLock(`footage:${id}`, async () => {
    const local = await resolveFootage(id)
    if (local) return local
    const root = await footageRootReady()
    const row = catalogueRow
    const label = clipLabel(row, id)

    let downloaded: Awaited<ReturnType<typeof downloadFootageFile>>
    try {
      downloaded = await downloadFootageFile(id)
    } catch (error: any) {
      throw await gatewayFailure(error, label, id)
    }
    if (!downloaded.bytes.length) {
      throw new Error(`The Gateway sent no bytes for "${label}". Nothing was stored.`)
    }
    const actual = createHash('sha256').update(downloaded.bytes).digest('hex')
    if (actual !== id) {
      throw new Error(
        `The Gateway sent the wrong content for "${label}" (expected ${id.slice(0, 12)}…, received ${actual.slice(0, 12)}…). `
        + 'Nothing was stored.',
      )
    }

    const mime = downloaded.contentType.split(';')[0]!.trim().toLowerCase()
    const publishedExt = typeof row?.filetype === 'string' ? row.filetype.replace(/^\./, '').toLowerCase() : ''
    const extension = MEDIA_TYPE_EXTENSION[mime] || (VIDEO_EXTENSIONS.has(publishedExt) ? publishedExt : 'bin')
    const target = path.join(root, `${id}.${extension}`)
    try {
      // Sidecar first: media never appears with its provenance still missing.
      await writeJsonAtomic(path.join(root, `${id}.json`), sidecarFor(id, downloaded.bytes, mime, row), { mode: 0o600 })
      await writeBytesAtomic(target, downloaded.bytes)
    } catch (error: any) {
      throw new Error(
        `The clip "${label}" was downloaded but could not be saved in the footage folder "${root}" (${error?.message || String(error)}). `
        + 'Nothing was stored. The folder may have been disconnected or is read-only.',
      )
    }
    return target
  })
}
