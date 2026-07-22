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
import { studioFetch } from './studio-auth.js'

export async function downloadVideo(
  url: string,
  destPath: string,
  onProgress?: (bytesReceived: number, totalBytes?: number) => void,
  headers?: Record<string, string>,
): Promise<void> {
  // Studio artifacts may require the shared fleet credential. Cloud CDN URLs
  // tolerate the extra header, so one authenticated fetch path is safe for
  // both Hub/Studio results and existing fal/kie downloads.
  const resp = headers
    ? await fetch(url, { headers, signal: AbortSignal.timeout(300_000), redirect: 'follow' })
    : await studioFetch(url, { signal: AbortSignal.timeout(300_000) })
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
