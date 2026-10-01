/**
 * Small JPEG derivatives of scene images, for the review grids.
 *
 * Scene Review and Motion Review show each still in a box a couple of hundred pixels wide but were
 * fetching and decoding the full-resolution file (3-5 MB, ~6 MB decoded) for every card. A 480 px JPEG
 * is ~30-60 KB. The originals are never touched: the derivative lives in `<project>/.cache/thumbs`,
 * is regenerable at any time, and is keyed by the source's size and mtime so a re-rendered scene gets a
 * new thumbnail. One file per scene is kept (an older derivative is removed when a new one lands), so
 * the folder is bounded by the scene count. Counted by the Free up space audit.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

export const THUMB_WIDTH = 480
export const THUMB_QUALITY = 78

export function thumbCacheRoot(projectDir: string): string {
  return path.join(projectDir, '.cache', 'thumbs')
}

const inFlight = new Map<string, Promise<string>>()
let active = 0
const waiting: Array<() => void> = []
const MAX_CONCURRENT = 2

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>(resolve => waiting.push(resolve))
  active++
  try { return await work() } finally {
    active--
    waiting.shift()?.()
  }
}

/** Path of the derivative for `source`, creating it if it is missing or out of date. Throws if it cannot. */
export async function ensureThumbnail(opts: {
  projectDir: string
  group: string // episode code
  id: string // scene id
  source: string
  width?: number
}): Promise<string> {
  const width = opts.width ?? THUMB_WIDTH
  const stat = await fs.stat(opts.source)
  const dir = path.join(thumbCacheRoot(opts.projectDir), opts.group)
  const prefix = `${opts.id}.`
  const target = path.join(dir, `${prefix}${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-w${width}.jpg`)
  const existing = await fs.stat(target).catch(() => null)
  if (existing?.isFile() && existing.size > 0) return target
  const pending = inFlight.get(target)
  if (pending) return pending
  const job = slot(async () => {
    await fs.mkdir(dir, { recursive: true })
    const partial = `${target}.partial-${process.pid}`
    try {
      await sharp(opts.source, { failOn: 'none' })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: THUMB_QUALITY })
        .toFile(partial)
      await fs.rename(partial, target)
    } catch (error) {
      await fs.rm(partial, { force: true }).catch(() => {})
      throw error
    }
    // One derivative per scene: drop the ones made from an earlier version of the image.
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (name.startsWith(prefix) && path.join(dir, name) !== target) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
      }
    }
    return target
  }).finally(() => { inFlight.delete(target) })
  inFlight.set(target, job)
  return job
}

/** Total bytes of a project's derivative cache (0 when there is none). */
export async function thumbCacheBytes(projectDir: string): Promise<number> {
  if (!projectDir) return 0
  const root = thumbCacheRoot(projectDir)
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) total += (await fs.stat(full).catch(() => null))?.size ?? 0
    }
  }
  await walk(root)
  return total
}
