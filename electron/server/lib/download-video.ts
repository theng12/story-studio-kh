/**
 * Generic streaming video downloader. Used by every video provider's
 * recovery path (kie, fal) to pull a finished clip URL onto disk.
 *
 * Streams via pipeline so the optional `onProgress` can report bytes
 * received as they arrive (rather than buffering the whole video in
 * memory before writing). Cleans up partial/empty files on failure so
 * the generator's "skip if exists" guard doesn't mistake a truncated
 * clip for cache.
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { createIdleAbort } from './idle-abort.js'

/**
 * How long a transfer may deliver NOTHING before it is over.
 *
 * Deliberately generous: a slow line that keeps moving is progress, so the only thing this catches is
 * a connection that has genuinely stopped. It must also stay comfortably shorter than any ceiling that
 * wraps the caller, so the transport reports its own timeout first and the row names the real cause.
 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000

export async function downloadVideo(
  url: string,
  destPath: string,
  onProgress?: (bytesReceived: number, totalBytes?: number) => void,
  headers?: Record<string, string>,
  /** Tests shorten the idle bound; production keeps the constant. */
  options: { idleTimeoutMs?: number } = {},
): Promise<void> {
  const idleBoundMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS
  // 1.4.415 — an IDLE bound, not a total-time one. `AbortSignal.timeout(300_000)` here was the same
  // 300 000 ms as the reconciler's phase ceiling, so a transfer of more than five minutes could never
  // finish and the row reported a stall while the file was still arriving. A transfer that keeps
  // delivering bytes is progress, whatever its total duration; one that stops delivering is over.
  const idle = createIdleAbort(idleBoundMs, seconds => `Download stalled: no bytes for ${seconds}s`)
  let resp: Response
  try {
    resp = await fetch(url, {
      ...(headers ? { headers } : {}),
      signal: idle.signal,
      redirect: 'follow',
    })
  } catch (error) {
    idle.dispose()
    throw error
  }
  if (!resp.ok || !resp.body) throw new Error(`Video download failed: ${resp.status}`)
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  const cl = resp.headers.get('content-length')
  const total = cl ? Number(cl) || undefined : undefined
  let received = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      idle.touch()
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
  idle.dispose()
  const stat = await fs.stat(destPath)
  if (stat.size === 0) {
    await fs.rm(destPath, { force: true }).catch(() => {})
    throw new Error('Video download returned 0 bytes')
  }
}
