/**
 * Is this scene clip interchangeable with the clip FFmpeg would have made?
 *
 * Everything downstream of `prepareSceneClips` — the xfade chain's inputs, the stream-copy concat,
 * the final pass — assumes one frame shape: size, frame rate, pixel format, time base and colour
 * tags. A native clip is checked against it before it is accepted; a mismatch sends THAT scene
 * back to FFmpeg. Pure on a parsed ffprobe stream so the rules are unit-testable.
 *
 * Codec parameters (profile, entropy coder, SPS) are NOT compared: the native clip is encoded by
 * VideoToolbox, the FFmpeg clip by x264, and they differ by design. That is safe only because the
 * native path is used when the xfade stage DECODES and re-encodes every clip; a stream-copy
 * consumer would need identical SPS, so `prepareSceneClips` keeps FFmpeg for those (see
 * `nativeClipsAreSafeToXfade`).
 */

import { spawn } from 'node:child_process'
import { getFFprobePath } from '../services/ffmpeg-manager.js'
import { armProbeWatchdog, PROBE_TIMEOUT_MS } from './ffmpeg-utils.js'

export interface ProbedVideoStream {
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  time_base?: string
  color_range?: string
  color_space?: string
  color_primaries?: string
  color_transfer?: string
  duration?: string
  nb_frames?: string
  field_order?: string
}

export interface ExpectedSceneClip {
  w: number
  h: number
  fps: number
  /** Seconds. */
  duration: number
}

function ratio(value: string | undefined): number {
  const [n, d] = String(value ?? '').split('/').map(Number)
  return d ? (n ?? NaN) / d : Number(n)
}

/** Empty list = compatible. Each entry names one violated expectation. */
export function sceneClipCompatibilityProblems(stream: ProbedVideoStream | undefined, expected: ExpectedSceneClip): string[] {
  if (!stream) return ['no video stream']
  const problems: string[] = []
  const want = (label: string, got: unknown, wanted: unknown) => {
    if (got !== wanted) problems.push(`${label} ${String(got)} (want ${String(wanted)})`)
  }
  want('codec', stream.codec_name, 'h264')
  want('width', stream.width, expected.w)
  want('height', stream.height, expected.h)
  want('pix_fmt', stream.pix_fmt, 'yuv420p')
  if (Math.abs(ratio(stream.r_frame_rate) - expected.fps) > 0.001) problems.push(`frame rate ${stream.r_frame_rate} (want ${expected.fps})`)
  // FFmpeg's mp4 muxer writes fps*512 ticks per second; xfade refuses inputs whose time bases differ.
  want('time_base', stream.time_base, `1/${expected.fps * 512}`)
  want('color_range', stream.color_range, 'tv')
  want('color_space', stream.color_space, 'bt709')
  // libx264 leaves primaries/transfer unsignalled even when asked (ffprobe says `unknown`); both that
  // and an explicit bt709 are the same picture, anything else is a real mismatch.
  const bt709OrUnset = (value: string | undefined) => !value || value === 'unknown' || value === 'bt709'
  if (!bt709OrUnset(stream.color_primaries)) problems.push(`color_primaries ${stream.color_primaries}`)
  if (!bt709OrUnset(stream.color_transfer)) problems.push(`color_transfer ${stream.color_transfer}`)
  const duration = Number(stream.duration)
  // One frame of slack either way: the FFmpeg path itself lands on a frame boundary.
  if (!Number.isFinite(duration) || Math.abs(duration - expected.duration) > 1 / expected.fps + 0.02) {
    problems.push(`duration ${stream.duration} (want ${expected.duration.toFixed(3)})`)
  }
  return problems
}

export async function probeVideoStream(filePath: string): Promise<ProbedVideoStream | undefined> {
  const ffprobe = await getFFprobePath()
  return new Promise(resolve => {
    const proc = spawn(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-print_format', 'json', '-show_streams', filePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    const watchdog = armProbeWatchdog(proc, PROBE_TIMEOUT_MS)
    let out = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.on('error', () => { watchdog.clear(); resolve(undefined) })
    proc.on('close', () => {
      watchdog.clear()
      try { resolve((JSON.parse(out) as { streams?: ProbedVideoStream[] }).streams?.[0]) } catch { resolve(undefined) }
    })
  })
}
