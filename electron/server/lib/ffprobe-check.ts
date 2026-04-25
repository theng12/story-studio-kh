/**
 * Pre-upload ffprobe sanity checks. Catches obviously-broken files before
 * we burn upload bandwidth hitting YouTube's API (and more importantly,
 * before we occupy a row in the user's job queue for something that'll
 * fail on the remote side).
 *
 * Intentionally narrow: check it's a playable container with a video
 * stream, surface duration + resolution + audio-track presence. Any other
 * ffprobe-derivable fact is a later addition.
 */

import { spawn } from 'child_process'
import { getFFprobePath } from '../services/ffmpeg-manager.js'
import { armProbeWatchdog } from './ffmpeg-utils.js'

export interface ProbeResult {
  ok: boolean
  durationSec: number
  width: number
  height: number
  hasVideo: boolean
  hasAudio: boolean
  /** YouTube imposes a max of 12 hours today; we flag at 11h to leave margin. */
  exceedsDurationLimit: boolean
  /** Human-readable error when `ok: false`. */
  error?: string
}

const YT_MAX_DURATION_SEC = 11 * 60 * 60  // 11 hours (YouTube's limit is 12h)

export async function probeForUpload(filePath: string): Promise<ProbeResult> {
  const empty: ProbeResult = {
    ok: false, durationSec: 0, width: 0, height: 0,
    hasVideo: false, hasAudio: false, exceedsDurationLimit: false,
  }
  const ffprobeBin = await getFFprobePath().catch(() => '')
  if (!ffprobeBin) {
    return { ...empty, error: 'ffprobe not available — install FFmpeg in Settings → FFmpeg before uploading.' }
  }

  const data = await new Promise<any>((resolve) => {
    const proc = spawn(ffprobeBin, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })

    // Pre-upload probe — 30s watchdog so an unreadable/frozen file doesn't
    // wedge the upload job. Resolving null routes through the existing
    // "couldn't probe" error path, which is the right UX.
    const watchdog = armProbeWatchdog(proc)

    proc.on('error', () => {
      watchdog.clear()
      resolve(null)
    })
    proc.on('close', (code) => {
      watchdog.clear()
      if (watchdog.wasKilled()) return resolve(null)
      if (code !== 0) return resolve(null)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
  })

  if (!data) return { ...empty, error: 'Could not probe file — it may be corrupt or not a valid video.' }

  const streams: any[] = Array.isArray(data.streams) ? data.streams : []
  const vStream = streams.find(s => s.codec_type === 'video')
  const aStream = streams.find(s => s.codec_type === 'audio')
  const durationSec = Number(data.format?.duration) || 0
  const width = Number(vStream?.width) || 0
  const height = Number(vStream?.height) || 0

  if (!vStream) {
    return { ...empty, error: 'No video stream detected — YouTube rejects audio-only files via this upload path.' }
  }
  if (durationSec <= 0) {
    return { ...empty, error: 'Could not determine duration — file may be truncated.' }
  }
  const exceeds = durationSec > YT_MAX_DURATION_SEC
  return {
    ok: !exceeds,
    durationSec,
    width,
    height,
    hasVideo: true,
    hasAudio: !!aStream,
    exceedsDurationLimit: exceeds,
    error: exceeds ? `Duration ${Math.round(durationSec / 60)} min exceeds YouTube's 12-hour cap (we flag at 11h for margin).` : undefined,
  }
}
