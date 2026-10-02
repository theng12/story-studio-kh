import { pipeline } from 'node:stream'
import type { Readable } from 'node:stream'
import type { ServerResponse } from 'node:http'

/**
 * Send a file stream to the client, and let go of the file when the client does.
 *
 * `stream.pipe(res)` never closes the source when the response ends early. A video preview that is
 * scrubbed, or a page that is navigated away from mid-image, aborts its request and the read stream —
 * with its file descriptor — stayed open. Measured: 30 aborted downloads left 30 descriptors open
 * (`pipeline`: 0). macOS gives a GUI app 256 by default, so a session of scrubbing ends in EMFILE and
 * the app can no longer open ANY file. `pipe` also attaches no 'error' listener to the source, so a
 * file that vanished mid-read raised an uncaught exception and the app's crash dialog.
 *
 * An early close by the client is normal, not an error; anything else is logged.
 */
export function streamTo(res: ServerResponse, source: Readable): void {
  pipeline(source, res, (error) => {
    if (!error) return
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'EPIPE') return
    console.warn(`[stream] file response failed: ${error.message}`)
  })
}

/**
 * Cache headers for a preview whose URL names a PATH, not a version.
 *
 * A re-merged or re-generated file lands at the same path, so `max-age=3600` let the in-app player
 * replay the old bytes for up to an hour. The browser may keep a copy but must ask first, and the
 * answer is a cheap 304 while size and mtime are unchanged. Returns true when a 304 was sent and
 * the caller must stop.
 */
export function revalidatePreview(
  req: { headers: Record<string, string | string[] | undefined> },
  res: ServerResponse & { status(code: number): unknown; set(name: string, value: string): unknown },
  stat: { size: number; mtimeMs: number; mtime: Date },
): boolean {
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  res.set('ETag', etag)
  res.set('Last-Modified', stat.mtime.toUTCString())
  res.set('Cache-Control', 'private, no-cache')
  const sent = req.headers['if-none-match']
  const wanted = Array.isArray(sent) ? sent.join(',') : sent
  if (wanted && wanted.split(',').some(tag => tag.trim() === etag)) {
    res.status(304)
    res.end()
    return true
  }
  return false
}
