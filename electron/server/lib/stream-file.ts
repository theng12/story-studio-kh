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
