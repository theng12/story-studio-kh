import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'path'

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
export async function resolveYouTubeSourceRevision(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return `${CONTENT_SHA256_PREFIX}${hash.digest('hex')}`
}

/**
 * Hash an already-open render without closing it. The upload generator keeps
 * this descriptor open for its later chunk reads, so an atomic final-video
 * replacement cannot make the recorded bytes differ from the bytes sent.
 */
export async function resolveYouTubeSourceRevisionFromHandle(file: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk)
  return `${CONTENT_SHA256_PREFIX}${hash.digest('hex')}`
}

/** Resolve the exact final video used by both upload admission and execution. */
export async function findYouTubeSourceVideoPath(
  paths: { episode_dir: string; video_dir: string },
  slug: string,
  code: string,
  title: string,
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
  const externalDir = await resolveExternalFinalVideoDir(slug, normalizedCode, title)
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
