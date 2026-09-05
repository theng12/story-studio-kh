import { createHash } from 'node:crypto'
import fsp from 'fs/promises'
import path from 'path'

/** Cheap identity for a multi-gigabyte render: name, size, and modification time. */
export async function resolveYouTubeSourceRevision(filePath: string): Promise<string> {
  const info = await fsp.stat(filePath)
  return createHash('sha256')
    .update(`${path.basename(filePath)}:${info.size}:${info.mtimeMs}`)
    .digest('hex')
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
