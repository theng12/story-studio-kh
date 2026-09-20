/**
 * Stage-validation helpers for the FFmpeg pipeline.
 *
 * Every stage of video assembly (per-clip prep, xfade chunk, intermediate
 * concat, audio premix, final encode) can silently produce a file that
 * looks fine on disk but contains zero usable packets. The downstream
 * stage then fails with a confusing `return code -22` / `Nothing was
 * written into output file` from FFmpeg, hundreds of lines after the
 * real problem.
 *
 * These helpers wrap `ffprobe` so each stage can prove its output is
 * decodeable BEFORE handing it to the next stage. When something is
 * broken, we surface it at the source — with the failing path and the
 * specific symptom (zero bytes, zero frames, missing video stream) —
 * instead of letting the failure mask the cause.
 */

import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { getFFprobePath } from '../services/ffmpeg-manager.js'
import { armProbeWatchdog, PROBE_TIMEOUT_MS } from './ffmpeg-utils.js'

export interface MediaInfo {
  durationSec: number
  /** Video stream duration, independent of a potentially longer audio track. */
  videoDurationSec?: number
  /** Audio stream duration, independent of a potentially longer video track. */
  audioDurationSec?: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  frameRate?: number
  /** nb_frames from ffprobe — best-effort. May be undefined on streams
   *  without a frame count in the container (mpegts, raw streams). */
  videoFrames?: number
  /** Pixel format reported by ffprobe (e.g. yuv420p, yuv444p). Useful for
   *  spotting mismatches that x264/x265 reject at init. */
  pixelFormat?: string
}

function streamDuration(stream: { duration?: unknown; duration_ts?: unknown; time_base?: unknown } | undefined): number | undefined {
  if (!stream) return undefined
  const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : undefined
  const ratio = (value: unknown) => {
    const [numerator, denominator] = String(value ?? '').split('/').map(Number)
    return positive((numerator ?? NaN) / (denominator ?? NaN))
  }
  const duration = positive(Number(stream.duration))
  if (duration !== undefined) return duration
  const timeBase = ratio(stream.time_base)
  if (timeBase !== undefined) {
    const fromTicks = positive(Number(stream.duration_ts) * timeBase)
    if (fromTicks !== undefined) return fromTicks
  }
  return undefined
}

/** Read the video's clock without substituting the container/audio duration. */
export function videoStreamDuration(stream: { duration?: unknown; duration_ts?: unknown; time_base?: unknown; nb_frames?: unknown; avg_frame_rate?: unknown; r_frame_rate?: unknown } | undefined): number | undefined {
  const duration = streamDuration(stream)
  if (duration !== undefined) return duration
  if (!stream) return undefined
  const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : undefined
  const ratio = (value: unknown) => {
    const [numerator, denominator] = String(value ?? '').split('/').map(Number)
    return positive((numerator ?? NaN) / (denominator ?? NaN))
  }
  const frameRate = ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate)
  return frameRate === undefined ? undefined : positive(Number(stream.nb_frames) / frameRate)
}

/**
 * Inspect a media file via ffprobe. Returns parsed metadata or throws if
 * ffprobe itself can't run. Returns a struct with `hasVideo=false` /
 * `durationSec=0` if the file is decodeable but empty — caller decides
 * whether that's fatal.
 */
export async function getMediaInfo(filePath: string): Promise<MediaInfo> {
  if (!existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`)
  }
  const ffprobeBin = await getFFprobePath()
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobeBin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    // Read-only metadata probe — 30s is plenty. Without this watchdog a
    // single pathological input pins the job queue indefinitely (H1/H2).
    const watchdog = armProbeWatchdog(proc)

    proc.on('error', err => {
      watchdog.clear()
      reject(new Error(`ffprobe failed to start: ${err.message}`))
    })
    proc.on('close', code => {
      watchdog.clear()
      if (watchdog.wasKilled()) {
        reject(new Error(
          `ffprobe exceeded ${Math.round(PROBE_TIMEOUT_MS / 1000)}-second watchdog for ${filePath}`,
        ))
        return
      }
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code} for ${filePath}: ${stderr.trim().slice(-200)}`))
        return
      }
      try {
        const data = JSON.parse(stdout)
        const streams = Array.isArray(data.streams) ? data.streams : []
        const v = streams.find((s: any) => s.codec_type === 'video')
        const a = streams.find((s: any) => s.codec_type === 'audio')
        const fmtDur = parseFloat(data?.format?.duration)
        const vDur = v ? parseFloat(v.duration) : NaN
        const aDur = a ? parseFloat(a.duration) : NaN
        const durationSec = [fmtDur, vDur, aDur].find(n => Number.isFinite(n) && n > 0) ?? 0

        let frameRate: number | undefined
        if (v?.r_frame_rate && typeof v.r_frame_rate === 'string') {
          const [num, den] = v.r_frame_rate.split('/').map(Number)
          if (num && den) frameRate = num / den
        }
        const nbFrames = v?.nb_frames ? parseInt(v.nb_frames, 10) : NaN

        resolve({
          durationSec,
          videoDurationSec: videoStreamDuration(v),
          audioDurationSec: streamDuration(a),
          hasVideo: !!v,
          hasAudio: !!a,
          videoCodec: v?.codec_name,
          audioCodec: a?.codec_name,
          width: v?.width,
          height: v?.height,
          frameRate,
          videoFrames: Number.isFinite(nbFrames) && nbFrames >= 0 ? nbFrames : undefined,
          pixelFormat: v?.pix_fmt,
        })
      } catch (e: any) {
        reject(new Error(`ffprobe parse failed for ${filePath}: ${e.message}`))
      }
    })
  })
}

/**
 * Cheap pre-flight: is this file present and non-empty on disk? Catches
 * the case where FFmpeg exited 0 but the muxer wrote a 0-byte container
 * (happens when a stream received no packets but the muxer still flushed
 * the header). If you only check exit code you'd march into the next
 * stage with garbage.
 */
export function fileExistsNonEmpty(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    return statSync(filePath).size > 0
  } catch {
    return false
  }
}

export interface AssertVideoOpts {
  /** Path label for error messages. Defaults to the file path. */
  label?: string
  /** Require the file to contain a video stream with non-zero duration. */
  requireVideo?: boolean
  /** Require an audio stream. */
  requireAudio?: boolean
  /** Minimum acceptable duration in seconds. Defaults to 0.1. */
  minDurationSec?: number
}

/**
 * Throw a descriptive error if `filePath` doesn't satisfy the requirements.
 * Use this between pipeline stages so a broken intermediate is caught at
 * the source, not after another 5 minutes of useless work.
 *
 * Errors include the failing path, file size, and a one-line ffprobe
 * summary so the job log shows exactly what went wrong.
 */
export async function assertValidMedia(filePath: string, opts: AssertVideoOpts = {}): Promise<MediaInfo> {
  const label = opts.label || filePath
  const minDur = opts.minDurationSec ?? 0.1

  if (!existsSync(filePath)) {
    throw new Error(`[validate] ${label}: file does not exist (${filePath})`)
  }
  let size = 0
  try { size = statSync(filePath).size } catch { /* ignore */ }
  if (size === 0) {
    throw new Error(`[validate] ${label}: file is 0 bytes (${filePath})`)
  }

  let info: MediaInfo
  try {
    info = await getMediaInfo(filePath)
  } catch (e: any) {
    throw new Error(`[validate] ${label}: ffprobe failed (${e.message})`)
  }

  if (opts.requireVideo && !info.hasVideo) {
    throw new Error(`[validate] ${label}: missing video stream (${size} bytes)`)
  }
  if (opts.requireAudio && !info.hasAudio) {
    throw new Error(`[validate] ${label}: missing audio stream (${size} bytes)`)
  }
  if (info.durationSec < minDur) {
    throw new Error(
      `[validate] ${label}: duration ${info.durationSec.toFixed(3)}s below minimum ${minDur}s ` +
      `(${size} bytes, video=${info.hasVideo}, audio=${info.hasAudio})`
    )
  }
  // Empty video stream — codec exists but no frames decoded. This is the
  // exact symptom that produces "Nothing was written into output file" at
  // the next stage. nb_frames may be undefined for some containers, so we
  // only flag it when ffprobe explicitly reported 0.
  if (opts.requireVideo && info.videoFrames === 0) {
    throw new Error(`[validate] ${label}: video stream reports 0 frames (${size} bytes)`)
  }
  return info
}

/** Format a MediaInfo as a one-line summary suitable for the job log. */
export function summarizeMedia(info: MediaInfo): string {
  const parts: string[] = []
  if (info.hasVideo) {
    const dims = (info.width && info.height) ? `${info.width}x${info.height}` : '?x?'
    const fps = info.frameRate ? `@${info.frameRate.toFixed(2)}fps` : ''
    const px = info.pixelFormat ? ` ${info.pixelFormat}` : ''
    const fr = info.videoFrames != null ? ` ${info.videoFrames}f` : ''
    parts.push(`video=${info.videoCodec || '?'} ${dims}${fps}${px}${fr}`)
  }
  if (info.hasAudio) {
    parts.push(`audio=${info.audioCodec || '?'}`)
  }
  parts.push(`dur=${info.durationSec.toFixed(2)}s`)
  return parts.join(' · ')
}
