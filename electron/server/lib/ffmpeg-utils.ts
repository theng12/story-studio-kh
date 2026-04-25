/**
 * Shared FFmpeg utilities used by both the video generator and audio merge generator.
 * Uses ffmpeg-manager for binary path resolution (supports bundled + system FFmpeg).
 */

import { spawn, type ChildProcess } from 'child_process'
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
 * breaking existing rendered paths. See audit-reports/07-ffmpeg.md §3.
 */
export function formatConcatFileLine(p: string): string {
  if (/[\n\r\0]/.test(p)) {
    throw new Error(
      `Cannot include file in FFmpeg concat list — filename contains a newline/CR/NUL byte: ${JSON.stringify(p)}. Rename the file before retrying.`,
    )
  }
  return `file '${p.replace(/'/g, "'\\''")}'`
}

// ── Run FFmpeg Command ──────────────────────────────────────────────────

export async function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  const ffmpegBin = await getFFmpegPath()
  const { timeoutMs } = opts
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Register against the current job (via AsyncLocalStorage) so cancelJob
    // can SIGTERM us. No-op outside a job context.
    trackChild(proc)

    let stderr = ''
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

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

export async function checkFfmpeg(): Promise<{ installed: boolean; version?: string; has_drawtext: boolean; has_libass: boolean }> {
  const status = await getFFmpegStatus()
  return {
    installed: status.installed,
    version: status.version,
    has_drawtext: status.has_drawtext,
    has_libass: status.has_libass,
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
