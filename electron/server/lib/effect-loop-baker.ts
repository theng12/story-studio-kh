/**
 * Bake atmosphere loops (rain, snow, fireflies, fog…) into small grey H.264
 * clips, once, and cache them.
 *
 * The frames come from `contracts/effect-loops.ts` — the same program the
 * Effects Library's live `<canvas>` preview runs — piped straight into FFmpeg.
 * A 12-second 720p particle loop bakes in well under two seconds and weighs
 * tens of kilobytes; noise loops bake at a quarter size and are scaled up at
 * render time.
 *
 * The cache key is the loop's SHAPE plus its size and frame rate. Colour,
 * brightness and darkening are applied when the loop is composited, so changing
 * them never re-bakes.
 */

import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

import {
  createLoopRenderer,
  loopBakeFps,
  loopBakeSize,
  loopFrameCount,
  loopShapeKey,
  type LoopShape,
} from '../contracts/effect-loops.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { trackChild } from '../services/job-queue.js'
import { assertWriteIsolatedInTests } from './test-isolation.js'
import { appendCappedTail } from './ffmpeg-utils.js'

const require = createRequire(import.meta.url)

/** Bumped when the renderer's output changes, so stale loops are never reused. */
export const LOOP_BAKE_VERSION = 1

/** Loops are tiny; this many is a few tens of megabytes at most. */
const MAX_CACHED_LOOPS = 400

/** Resolved on every call, for the same reason as `services/preview-cache.ts`. */
export function effectLoopCacheRoot(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) return path.join(process.env.STORY_STUDIO_DATA_DIR, 'effect-loops')
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'effect-loops')
  } catch { /* not in Electron */ }
  return path.join(process.cwd(), '.effect-loops')
}

export interface BakedLoop {
  path: string
  width: number
  height: number
  fps: number
  frames: number
  /** False when the loop came from the cache. */
  baked: boolean
  /** Wall-clock milliseconds spent baking (0 for a cache hit). */
  bake_ms: number
}

export function loopCacheKey(shape: LoopShape, outW: number, outH: number, outFps: number): string {
  const { w, h } = loopBakeSize(shape, outW, outH)
  const fps = loopBakeFps(shape, outFps)
  return `loop-v${LOOP_BAKE_VERSION}|${loopShapeKey(shape)}|${w}x${h}@${fps}`
}

function cacheFile(key: string): string {
  return path.join(effectLoopCacheRoot(), `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 24)}.mp4`)
}

const inFlight = new Map<string, Promise<BakedLoop>>()

/**
 * Return the baked loop for one shape at one output size and frame rate,
 * baking it first when it is not cached. Concurrent requests for the same loop
 * share one bake.
 */
export async function bakeEffectLoop(shape: LoopShape, outW: number, outH: number, outFps: number): Promise<BakedLoop> {
  const { w, h } = loopBakeSize(shape, outW, outH)
  const fps = loopBakeFps(shape, outFps)
  const frames = loopFrameCount(shape, fps)
  const key = loopCacheKey(shape, outW, outH, outFps)
  const target = cacheFile(key)
  try {
    const stat = fs.statSync(target)
    if (stat.isFile() && stat.size > 0) {
      const now = Date.now() / 1000
      fs.utimesSync(target, now, now)
      return { path: target, width: w, height: h, fps, frames, baked: false, bake_ms: 0 }
    }
  } catch { /* not cached */ }

  const pending = inFlight.get(target)
  if (pending) return pending
  const job = (async () => {
    assertWriteIsolatedInTests(target, 'effect-loops')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const started = Date.now()
    const temp = `${target}.${process.pid}.${Date.now()}.tmp.mp4`
    try {
      await pipeFramesToFfmpeg(shape, w, h, fps, frames, temp)
      fs.renameSync(temp, target)
    } catch (error) {
      try { fs.unlinkSync(temp) } catch { /* nothing to clean */ }
      throw error
    }
    evictOldLoops().catch(() => { /* best effort */ })
    return { path: target, width: w, height: h, fps, frames, baked: true, bake_ms: Date.now() - started }
  })()
  inFlight.set(target, job)
  try {
    return await job
  } finally {
    inFlight.delete(target)
  }
}

async function pipeFramesToFfmpeg(shape: LoopShape, w: number, h: number, fps: number, frames: number, out: string): Promise<void> {
  const ffmpeg = await getFFmpegPath()
  const renderer = createLoopRenderer(shape, w, h, frames)
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(fps), '-i', '-',
    // Every frame a keyframe would bloat the loop; one GOP per loop keeps the
    // wrap point a clean keyframe for `-stream_loop`.
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'gray', '-g', String(frames),
    '-movflags', '+faststart', '-f', 'mp4', out,
  ]
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    trackChild(proc)
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr = appendCappedTail(stderr, chunk.toString()) })
    proc.on('error', err => reject(new Error(`FFmpeg failed to start for the effect loop: ${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Baking the ${shape.variant} loop failed (FFmpeg exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`))
    })
    proc.stdin.on('error', () => { /* surfaced through close */ })
    const frame = new Uint8Array(w * h)
    let index = 0
    const writeMore = () => {
      while (index < frames) {
        renderer.draw(index++, frame)
        if (!proc.stdin.write(Buffer.from(frame))) {
          proc.stdin.once('drain', writeMore)
          return
        }
      }
      proc.stdin.end()
    }
    writeMore()
  })
}

async function evictOldLoops(): Promise<void> {
  const root = effectLoopCacheRoot()
  assertWriteIsolatedInTests(root, 'effect-loops')
  const files = (await fs.promises.readdir(root)).filter(f => f.endsWith('.mp4') && !f.includes('.tmp.'))
  if (files.length <= MAX_CACHED_LOOPS) return
  const stats = await Promise.all(files.map(async f => ({ f, m: (await fs.promises.stat(path.join(root, f))).mtimeMs })))
  stats.sort((a, b) => a.m - b.m)
  // Loops are a cache, rebuilt in seconds from their shape — removing the
  // oldest is not data loss, and an open render keeps reading its descriptor.
  await Promise.all(stats.slice(0, stats.length - MAX_CACHED_LOOPS).map(e => fs.promises.unlink(path.join(root, e.f)).catch(() => {})))
}
