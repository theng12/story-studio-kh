import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'path'
import type { ProjectFactsCache } from './utils.js'

const CONTENT_SHA256_PREFIX = 'sha256:'

/** True only for the versioned, byte-for-byte source identity written by current uploads. */
export function isContentSha256Revision(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value)
}

/**
 * Byte-for-byte identity for a rendered source. The prefix keeps old
 * name/size/mtime fingerprints distinguishable: a legacy receipt is useful
 * history, but it is never evidence that today's local bytes were uploaded.
 */
export async function resolveYouTubeSourceRevision(filePath: string, onBytes?: (bytes: number) => void): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { highWaterMark: HASH_CHUNK_BYTES })
  // A drive that stops answering (unplugged, asleep) would otherwise leave the read, and
  // whatever waits on it ("Verifying…"), hanging for ever.
  const stall = setTimeout(() => stream.destroy(Object.assign(
    new Error(`Reading ${path.basename(filePath)} stopped: its drive did not answer for ${Math.round(hashStallMs() / 1000)} seconds. Check the drive is connected, then try again.`),
    { code: 'ESTALLED' },
  )), hashStallMs())
  try {
    for await (const chunk of stream) {
      hash.update(chunk)
      stall.refresh()
      onBytes?.(chunk.length)
    }
  } finally { clearTimeout(stall) }
  return `${CONTENT_SHA256_PREFIX}${hash.digest('hex')}`
}

function hashStallMs(): number { return Number(process.env.STORY_HASH_STALL_MS) || 60_000 }

/**
 * Read size for hashing. Node's default 64 KiB stream chunk turns an 840 MB
 * final into ~12,800 sequential event-loop turns; in the live app each turn
 * waits behind whatever else the server is doing, so a hash that takes ~1 s in
 * isolation took 25 s while a render ran (measured 2026-09-12). 4 MiB chunks
 * cut that to ~200 turns. The digest is byte-identical either way.
 */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024

interface CachedSourceRevision {
  signature: string
  result: Promise<string>
}

const revisionCache = new Map<string, CachedSourceRevision>()
const MAX_REVISION_CACHE_ENTRIES = 256

/**
 * The same byte-for-byte revision, remembered per path while the file's
 * size, mtime and inode are unchanged.
 *
 * For interactive admission (Upload Center preview and the upload route), where
 * the owner clicks Review, then Upload, and each click re-hashed the whole final,
 * and (1.4.289) for moves to Story's Trash, which can always be undone: Free up
 * space read each final three times. Archiving (which removes the original)
 * keeps calling `resolveYouTubeSourceRevision` and re-reads every byte, and the upload
 * generator still hashes the OPEN handle it sends from — that is the check that
 * refuses a file replaced after confirmation, and it is not cached.
 *
 * A replacement at the same path is revalidated: an atomic rename changes the
 * inode, an in-place rewrite changes size or mtime. In-flight hashes are
 * shared, so a bulk review and a concurrent upload click read the file once.
 */
export async function resolveYouTubeSourceRevisionCached(filePath: string, onBytes?: (bytes: number) => void): Promise<string> {
  const stat = await fsp.stat(filePath)
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ino}`
  const cached = revisionCache.get(filePath)
  if (cached?.signature === signature) return cached.result
  const result = resolveYouTubeSourceRevision(filePath, onBytes)
  if (revisionCache.size >= MAX_REVISION_CACHE_ENTRIES) {
    const oldest = revisionCache.keys().next().value
    if (oldest) revisionCache.delete(oldest)
  }
  const entry = { signature, result }
  revisionCache.set(filePath, entry)
  result.catch(() => {
    // A failed read must not be remembered as this file's identity.
    if (revisionCache.get(filePath) === entry) revisionCache.delete(filePath)
  })
  return result
}

export function __clearSourceRevisionCacheForTests(): void {
  revisionCache.clear()
}

/**
 * Hash an already-open render without closing it. The upload generator keeps
 * this descriptor open for its later chunk reads, so an atomic final-video
 * replacement cannot make the recorded bytes differ from the bytes sent.
 */
export async function resolveYouTubeSourceRevisionFromHandle(file: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false, highWaterMark: HASH_CHUNK_BYTES })) hash.update(chunk)
  return `${CONTENT_SHA256_PREFIX}${hash.digest('hex')}`
}

/** Resolve the exact final video used by both upload admission and execution. */
export async function findYouTubeSourceVideoPath(
  paths: { episode_dir: string; video_dir: string },
  slug: string,
  code: string,
  title: string,
  cache?: ProjectFactsCache,
): Promise<string> {
  const normalizedCode = code.toUpperCase()
  const videoExts = ['.mp4', '.mov', '.mkv', '.webm', '.m4v']
  const isVideo = (name: string) => videoExts.some(ext => name.toLowerCase().endsWith(ext))
  const isCanonical = (name: string) => name.startsWith(`${normalizedCode}_final_video.`) && isVideo(name)
  const validFile = async (dir: string, name: string): Promise<string> => {
    const candidate = path.join(dir, name)
    const stat = await fsp.stat(candidate).catch(() => null)
    return stat?.isFile() && stat.size > 0 ? candidate : ''
  }

  const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
  const externalDir = await resolveExternalFinalVideoDir(slug, normalizedCode, title, cache)
  if (externalDir) {
    const externalFiles = await fsp.readdir(externalDir).catch(() => [])
    const final = externalFiles.find(isCanonical)
    if (final) {
      const valid = await validFile(externalDir, final)
      if (valid) return valid
    }
  }

  const localFiles = await fsp.readdir(paths.video_dir).catch(() => [])
  const final = localFiles.find(isCanonical)
  return final ? validFile(paths.video_dir, final) : ''
}
