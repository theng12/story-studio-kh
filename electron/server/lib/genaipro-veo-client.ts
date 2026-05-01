/**
 * GenAIPro Veo V2 client — video + image generation.
 * Docs: https://docs.genaipro.vn/ (tag: "Veo V2")
 * Base: https://genaipro.vn/api
 *
 * Flow: POST /v2/veo/{endpoint} → 202 { histories: [{id}, ...] } →
 *       poll GET /v2/veo/tasks/{id} until status=completed → { file_urls: [...] }
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { redactSecrets } from './redact-secrets.js'
import { sleepCancellable } from './http-retry.js'

const BASE = 'https://genaipro.vn/api'
const POLL_INTERVAL = 5000
const MAX_WAIT = 600000 // 10 minutes per task

type AspectRatio = 'landscape' | 'portrait'

const ASPECT_MAP: Record<AspectRatio, string> = {
  landscape: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  portrait: 'VIDEO_ASPECT_RATIO_PORTRAIT',
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface History { id: string; status?: string; prompt?: string }
interface TaskStatus { id: string; status: 'processing' | 'completed' | 'failed'; file_urls?: string[]; error?: string }

async function submitJson(endpoint: string, apiKey: string, body: Record<string, any>): Promise<History[]> {
  const resp = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Veo submit failed (${resp.status}): ${redactSecrets(err, apiKey).slice(0, 300)}`)
  }
  const data = await resp.json() as { histories?: History[] }
  if (!data.histories?.length) throw new Error('Veo did not return histories')
  return data.histories
}

async function submitMultipart(endpoint: string, apiKey: string, fields: Record<string, string | number>, files: Array<{ name: string; path: string }>): Promise<History[]> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v))
  for (const f of files) {
    const buf = await fs.readFile(f.path)
    const ext = path.extname(f.path).toLowerCase().replace('.', '') || 'png'
    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : `image/${ext}`
    form.append(f.name, new Blob([new Uint8Array(buf)], { type: mime }), path.basename(f.path))
  }
  const resp = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Veo multipart submit failed (${resp.status}): ${redactSecrets(err, apiKey).slice(0, 300)}`)
  }
  const data = await resp.json() as { histories?: History[] }
  if (!data.histories?.length) throw new Error('Veo did not return histories')
  return data.histories
}

async function pollTask(taskId: string, apiKey: string, isCancelled?: () => boolean): Promise<string[]> {
  const deadline = Date.now() + MAX_WAIT
  while (Date.now() < deadline) {
    if (isCancelled?.()) throw new Error('Cancelled by user')
    await sleepCancellable(POLL_INTERVAL, isCancelled)
    const resp = await fetch(`${BASE}/v2/veo/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(`Veo poll failed (${resp.status}): ${redactSecrets(err, apiKey).slice(0, 200)}`)
    }
    const task = await resp.json() as TaskStatus
    if (task.status === 'completed') return task.file_urls || []
    if (task.status === 'failed') throw new Error(`Veo task failed: ${task.error || 'unknown error'}`)
  }
  throw new Error(`Veo task ${taskId} timed out after ${MAX_WAIT / 1000}s`)
}

async function waitForAllTasks(tasks: History[], apiKey: string, isCancelled?: () => boolean): Promise<string[]> {
  const results = await Promise.all(tasks.map(t => pollTask(t.id, apiKey, isCancelled)))
  return results.flat()
}

export async function textToVideo(opts: {
  apiKey: string
  prompt: string
  aspectRatio: AspectRatio
  numberOfVideos: number
  isCancelled?: () => boolean
}): Promise<{ urls: string[]; taskIds: string[] }> {
  if (opts.isCancelled?.()) throw new Error('Cancelled by user')
  const histories = await submitJson('/v2/veo/text-to-video', opts.apiKey, {
    prompt: opts.prompt,
    aspect_ratio: ASPECT_MAP[opts.aspectRatio],
    number_of_videos: Math.max(1, Math.min(4, opts.numberOfVideos)),
  })
  const urls = await waitForAllTasks(histories, opts.apiKey, opts.isCancelled)
  return { urls, taskIds: histories.map(h => h.id) }
}

export async function framesToVideo(opts: {
  apiKey: string
  prompt: string
  aspectRatio: AspectRatio
  numberOfVideos: number
  startImagePath: string
  endImagePath?: string
  isCancelled?: () => boolean
}): Promise<{ urls: string[]; taskIds: string[] }> {
  if (opts.isCancelled?.()) throw new Error('Cancelled by user')
  const fields: Record<string, string | number> = {
    prompt: opts.prompt,
    aspect_ratio: ASPECT_MAP[opts.aspectRatio],
    number_of_videos: String(Math.max(1, Math.min(4, opts.numberOfVideos))),
  }
  const files: Array<{ name: string; path: string }> = [
    { name: 'start_image', path: opts.startImagePath },
  ]
  if (opts.endImagePath) files.push({ name: 'end_image', path: opts.endImagePath })

  const histories = await submitMultipart('/v2/veo/frames-to-video', opts.apiKey, fields, files)
  const urls = await waitForAllTasks(histories, opts.apiKey, opts.isCancelled)
  return { urls, taskIds: histories.map(h => h.id) }
}

export async function ingredientsToVideo(opts: {
  apiKey: string
  prompt: string
  aspectRatio: AspectRatio
  numberOfVideos: number
  referenceImagePaths: string[]
  isCancelled?: () => boolean
}): Promise<{ urls: string[]; taskIds: string[] }> {
  if (!opts.referenceImagePaths.length || opts.referenceImagePaths.length > 3) {
    throw new Error('ingredientsToVideo requires 1-3 reference images')
  }
  if (opts.isCancelled?.()) throw new Error('Cancelled by user')
  const fields: Record<string, string | number> = {
    prompt: opts.prompt,
    aspect_ratio: ASPECT_MAP[opts.aspectRatio],
    number_of_videos: String(Math.max(1, Math.min(4, opts.numberOfVideos))),
  }
  const files = opts.referenceImagePaths.map(p => ({ name: 'reference_images', path: p }))
  const histories = await submitMultipart('/v2/veo/ingredients-to-video', opts.apiKey, fields, files)
  const urls = await waitForAllTasks(histories, opts.apiKey, opts.isCancelled)
  return { urls, taskIds: histories.map(h => h.id) }
}

/** Download a video URL to disk.
 *  Cleans up a partial/empty file if the download fails so the generator's
 *  "skip if exists" guard doesn't mistake a truncated clip for cache.
 *
 *  Streams via pipeline so the optional `onProgress` can report bytes
 *  received as they arrive (rather than the old behavior of buffering the
 *  whole video in memory before writing).
 */
export async function downloadVideo(
  url: string,
  destPath: string,
  onProgress?: (bytesReceived: number, totalBytes?: number) => void,
): Promise<void> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!resp.ok || !resp.body) throw new Error(`Video download failed: ${resp.status}`)
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  const cl = resp.headers.get('content-length')
  const total = cl ? Number(cl) || undefined : undefined
  let received = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      try { onProgress?.(received, total) } catch { /* never let UI plumbing kill a download */ }
      cb(null, chunk)
    },
  })
  const writeStream = createWriteStream(destPath)
  try {
    await pipeline(Readable.fromWeb(resp.body as any), counter, writeStream)
  } catch (e) {
    await fs.rm(destPath, { force: true }).catch(() => {})
    throw e
  }
  const stat = await fs.stat(destPath)
  if (stat.size === 0) {
    await fs.rm(destPath, { force: true }).catch(() => {})
    throw new Error('Video download returned 0 bytes')
  }
}
