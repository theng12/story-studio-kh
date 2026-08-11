/**
 * Shared FFmpeg utilities used by both the video generator and audio merge generator.
 * Uses ffmpeg-manager for binary path resolution (supports bundled + system FFmpeg).
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { getFFmpegPath, getFFprobePath, getFFmpegStatus } from '../services/ffmpeg-manager.js'
import { trackChild } from '../services/job-queue.js'

// ── Watchdog helper ─────────────────────────────────────────────────────

/**
 * Arm a wall-clock watchdog for a spawned ffmpeg/ffprobe process. On
 * timeout: SIGTERM, then SIGKILL 5s later if the process is still alive
 * (ffmpeg occasionally ignores SIGTERM mid-filter-init).
 *
 * `wasKilled()` tells the caller's `close` handler whether the signal
 * came from the watchdog — necessary because user-cancel (trackChild
 * SIGTERM) and watchdog kill both arrive as signal=SIGTERM but need
 * distinct error messages so the job log disambiguates them.
 */
function armWatchdog(proc: ChildProcess, timeoutMs: number): { wasKilled: () => boolean; clear: () => void } {
  let killed = false
  const termTimer = setTimeout(() => {
    killed = true
    try { proc.kill('SIGTERM') } catch { /* already exited */ }
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already exited */ }
    }, 5000)
    proc.once('close', () => clearTimeout(killTimer))
  }, timeoutMs)
  return {
    wasKilled: () => killed,
    clear: () => clearTimeout(termTimer),
  }
}

function formatWatchdogError(timeoutMs: number, stderr: string): Error {
  const label = timeoutMs < 60_000
    ? `${Math.round(timeoutMs / 1000)}-second`
    : `${Math.max(1, Math.round(timeoutMs / 60_000))}-minute`
  const lines = stderr.split('\n').filter(l => l.trim())
  const tail = lines.slice(-5).join('\n') || '(no stderr captured)'
  return new Error(
    `FFmpeg exceeded ${label} wall-clock watchdog — job killed to free the queue. Last stderr: ${tail}`,
  )
}

/** Default watchdog for read-only ffprobe/ffmpeg metadata calls. */
export const PROBE_TIMEOUT_MS = 30_000

/**
 * Shared watchdog entry point for probe-style spawns outside this module
 * (ffmpeg-validation, ffprobe-check, ffmpeg-manager status check). Same
 * contract as the internal `armWatchdog` — callers handle `wasKilled()`
 * in their close handler and surface a timeout-appropriate error.
 */
export function armProbeWatchdog(
  proc: ChildProcess,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): { wasKilled: () => boolean; clear: () => void } {
  return armWatchdog(proc, timeoutMs)
}

// ── Concat-Demuxer List Formatting ──────────────────────────────────────

/**
 * Format a single `file '<path>'` line for an FFmpeg concat-demuxer list.
 *
 * The concat demuxer reads its list file line-by-line; each line is a
 * directive. A filename containing a literal \n / \r / \0 would break out
 * of its `file '...'` envelope and inject a new directive on the next
 * parsed line. Those bytes are valid in POSIX filenames, so AI-suggested
 * music track names, user renames, or bulk-rename scripts could plausibly
 * produce one — throw with the bad bytes visible (JSON.stringify) so the
 * user can fix the source filename rather than silently losing data.
 *
 * The single-quote escape below (`'\''`) is the lenient form we've shipped
 * for a while; FFmpeg's documented grammar is actually a bare backslash
 * escape, but the lenient form works in practice and tightening it risks
 * breaking existing rendered paths.
 */
export function formatConcatFileLine(p: string): string {
  if (/[\n\r\0]/.test(p)) {
    throw new Error(
      `Cannot include file in FFmpeg concat list — filename contains a newline/CR/NUL byte: ${JSON.stringify(p)}. Rename the file before retrying.`,
    )
  }
  return `file '${p.replace(/'/g, "'\\''")}'`
}

// ── Filter-graph argument escaping ──────────────────────────────────────

/**
 * Escape an arbitrary value for use as an FFmpeg *filter option value*
 * inside a `-filter_complex` / `-vf` graph description.
 *
 * FFmpeg unescapes a filter option value TWICE, both passes via
 * `av_get_token()`:
 *
 *   1. The filtergraph parser takes a filter's whole argument list as one
 *      token (terminators: `[`, `]`, `,`, `;`).
 *   2. `av_opt_set_from_string()` then splits that argument list into
 *      `key=value` pairs (terminator: `:`).
 *
 * At *each* level `\` escapes the next character, and a `'` opens a literal
 * run that ends at the next `'`. The trap: **a backslash is not an escape
 * inside a quoted run**. So the intuitive "wrap the value in single quotes"
 * approach fails the instant the value itself contains an apostrophe — the
 * value's own `'` closes the quote early and everything after it is
 * reparsed as filter syntax. That is exactly how one contextual cue reading
 * `Constantinople's main avenue` took down an entire 333-scene render: the
 * whole graph was rejected, not just that cue.
 *
 * Quoting also cannot express a literal newline, so two-line overlays were
 * impossible to encode inline no matter how the quotes were arranged.
 *
 * Therefore: do not quote at all. Backslash-escape for level 2, then
 * backslash-escape that result again for level 1, and emit the value bare
 * (`text=...`, no surrounding quotes). It then survives both passes
 * byte-for-byte — apostrophes, colons, commas, percent signs, backslashes,
 * brackets, semicolons and literal newlines included.
 *
 * Verified against the real FFmpeg parser in
 * `__tests__/ffmpeg-filter-escape.test.ts`, which feeds each case through
 * an actual `ffmpeg -filter_complex` invocation rather than regex-matching
 * our own output.
 */
export function escapeFilterArgValue(value: string): string {
  // Level 2 — the option-value tokenizer stops at ':'.
  const level2 = value.replace(/([\\':])/g, '\\$1')
  // Level 1 — the filtergraph tokenizer stops at '[', ']', ',' and ';'.
  return level2.replace(/([\\'[\],;])/g, '\\$1')
}

/**
 * Escape a filesystem path for use as an FFmpeg filter option value —
 * `ass=filename=…`, `subtitles=filename=…`.
 *
 * Two steps. Windows separators are normalised to forward slashes first:
 * FFmpeg accepts them on every platform, and it stops `C:\Users\…` becoming a
 * thicket of escaped backslashes. Then the ordinary two-level filter escape
 * applies — which is the part a path containing an apostrophe needs. An
 * episode folder like `EP0068 - Rome's Fall` used to close the quoted run
 * early and take the whole graph down with it, dropping the burned-in
 * subtitles into the no-effects recovery tier. Same defect as the contextual
 * cues, same fix, one implementation.
 *
 * The result is emitted unquoted, so call sites must NOT wrap it in quotes.
 */
export function escapeFilterPath(p: string): string {
  return escapeFilterArgValue(p.replace(/\\/g, '/'))
}

// ── Still-image decoder sniffing (v1.0.515) ─────────────────────────────
// FFmpeg 8.x's image2 demuxer picks the decoder by FILE EXTENSION. Nearly
// every scene image in the wild is a JPEG saved as `.png` (image providers
// return JPEG; ingest paths stored the bytes verbatim) — so ffmpeg selects
// the PNG decoder, decode fails, and with `-loop 1` it RETRIES FOREVER:
// zero frames out, job stuck at "1/160" with no progress (the 2026-07-05
// EP0012 wedge, reproduced in isolation). Sniffing the real magic bytes and
// passing an explicit `-c:v <decoder>` input option makes the same file
// decode instantly regardless of its extension.

import { open as fsOpen } from 'fs/promises'

/** Identify a still image's real format from magic bytes (value = the ffmpeg
 *  decoder name). Null = not a decodable still image (corrupt / html error
 *  page / wrong file). */
export async function sniffStillFormat(filePath: string): Promise<'mjpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'tiff' | null> {
  let fh: Awaited<ReturnType<typeof fsOpen>> | null = null
  try {
    fh = await fsOpen(filePath, 'r')
    const buf = Buffer.alloc(12)
    const { bytesRead } = await fh.read(buf, 0, 12, 0)
    if (bytesRead < 12) return null
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'mjpeg'
    if (buf.readUInt32BE(0) === 0x89504e47) return 'png'
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
    if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif'
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'                                   // 'BM'
    if (buf.readUInt32LE(0) === 0x002a4949 || buf.readUInt32BE(0) === 0x4d4d002a) return 'tiff' // II*\0 / MM\0*
    return null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * Input args that pin the correct decoder for a still image, e.g.
 * `['-c:v','mjpeg']`. Place BEFORE the `-i`. Throws a clear, actionable
 * error when the file isn't a recognizable image — infinitely better than
 * ffmpeg's silent retry loop.
 */
export async function stillDecoderArgs(filePath: string): Promise<string[]> {
  // Missing file → no hint. ffmpeg fails INSTANTLY on a missing input with a
  // clear "No such file or directory" (no wedge risk) — and unit tests /
  // callers with not-yet-materialized paths keep the legacy arg shape.
  if (!existsSync(filePath)) return []
  const fmt = await sniffStillFormat(filePath)
  if (!fmt) {
    // Existing file with an unrecognizable signature WOULD wedge ffmpeg's
    // loop — refuse loudly with the fix in hand.
    throw new Error(
      `Image is not a decodable PNG/JPEG/WebP (corrupt or wrong file type): ${filePath}. ` +
      `Regenerate or replace this image, then retry.`,
    )
  }
  return ['-c:v', fmt]
}

// ── Bounded stderr accumulation (v1.0.512) ──────────────────────────────
// FFmpeg emits a LOT of stderr over a long render (per-frame progress lines,
// verbose warnings). Accumulating it into one string with `stderr += chunk`
// grew UNBOUNDED and, on a long enough render, exceeded V8's maximum string
// length (~512 MB) → `RangeError: Invalid string length` thrown from the
// socket 'data' handler, ballooning the main-process heap to GBs first (the
// 2026-07-04 crash). We only ever need the TAIL for error diagnosis, so keep
// the last N KB. Every FFmpeg runner uses this instead of `+=`.
export const FFMPEG_LOG_TAIL_MAX = 256 * 1024
export function appendCappedTail(current: string, chunk: string, max = FFMPEG_LOG_TAIL_MAX): string {
  const next = current + chunk
  return next.length > max ? next.slice(next.length - max) : next
}

// ── Run FFmpeg Command ──────────────────────────────────────────────────

export async function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  const ffmpegBin = await getFFmpegPath()
  const { timeoutMs } = opts
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Register against the current job (via AsyncLocalStorage) so a proven local stop
    // can SIGTERM us. No-op outside a job context.
    trackChild(proc)

    let stderr = ''
    proc.stderr.on('data', (data: Buffer) => { stderr = appendCappedTail(stderr, data.toString()) })

    const watchdog = timeoutMs && timeoutMs > 0 ? armWatchdog(proc, timeoutMs) : null

    proc.on('error', (err) => {
      watchdog?.clear()
      reject(new Error(`FFmpeg failed to start: ${err.message}`))
    })

    proc.on('close', (code, signal) => {
      watchdog?.clear()
      if (code === 0) {
        resolve()
        return
      }
      // Watchdog fired first → surface the distinct watchdog error so
      // logs don't conflate queue-blocking hangs with user cancels.
      if (watchdog?.wasKilled()) {
        reject(formatWatchdogError(timeoutMs!, stderr))
        return
      }
      // SIGTERM / SIGKILL from a cancel shows up as either a null code with
      // a signal name, or code 255. Surface it as a clear "cancelled"
      // message so the user's logs don't look like a crash.
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error(`FFmpeg killed (${signal})`))
        return
      }
      const lines = stderr.split('\n').filter(l => l.trim())
      const errorLine = lines.slice(-5).join('\n')
      reject(new Error(`FFmpeg exited with code ${code}:\n${errorLine}`))
    })
  })
}

// ── Get Audio/Video Duration via ffprobe ────────────────────────────────

export async function getAudioDuration(filePath: string): Promise<number | undefined> {
  const ffprobeBin = await getFFprobePath()
  return new Promise((resolve) => {
    const proc = spawn(ffprobeBin, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let output = ''
    proc.stdout.on('data', (data: Buffer) => {
      output += data.toString()
    })

    // Probe watchdog — resolves `undefined` on timeout rather than hanging
    // a scan. Callers already treat `undefined` as "couldn't probe", so a
    // single pathological file doesn't wedge a 300-file scan.
    const watchdog = armWatchdog(proc, PROBE_TIMEOUT_MS)

    proc.on('error', () => {
      watchdog.clear()
      resolve(undefined)
    })
    proc.on('close', (code) => {
      watchdog.clear()
      if (watchdog.wasKilled()) {
        resolve(undefined)
        return
      }
      if (code === 0) {
        try {
          const data = JSON.parse(output)
          const duration = parseFloat(data.format?.duration)
          resolve(isNaN(duration) ? undefined : duration)
        } catch {
          resolve(undefined)
        }
      } else {
        resolve(undefined)
      }
    })
  })
}

// ── Check FFmpeg Availability ───────────────────────────────────────────

export async function checkFfmpeg(): Promise<{
  installed: boolean
  version?: string
  has_drawtext: boolean
  has_libass: boolean
  hw_encoders: { h264: boolean; h265: boolean }
}> {
  const status = await getFFmpegStatus()
  return {
    installed: status.installed,
    version: status.version,
    has_drawtext: status.has_drawtext,
    has_libass: status.has_libass,
    hw_encoders: status.hw_encoders,
  }
}

// Module-level cache for filter availability
let _hasDrawtext: boolean | null = null
let _hasLibass: boolean | null = null
export async function hasDrawtextFilter(): Promise<boolean> {
  if (_hasDrawtext !== null) return _hasDrawtext
  const check = await checkFfmpeg()
  _hasDrawtext = check.has_drawtext
  return _hasDrawtext
}
export async function hasLibass(): Promise<boolean> {
  if (_hasLibass !== null) return _hasLibass
  const check = await checkFfmpeg()
  _hasLibass = check.has_libass
  return _hasLibass
}
