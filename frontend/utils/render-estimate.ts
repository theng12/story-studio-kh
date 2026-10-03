/**
 * Video Assembly's file-size and render-time estimate — one implementation for
 * the live estimator and the quick-start preset cards.
 *
 * CALIBRATED FROM A MEASURED RENDER (Dreamlands EP0002, 2026-10-03, M-series
 * Mac): 2:10:25 of 1080p30 H.264 on the Media Engine ("YouTube — Fast",
 * quality medium), Pan Right on 295 scenes, crossfades, burned subtitles,
 * music → 5.91 GB in 30 min. The old table said ~3.3 GB and ~5 min because it
 * modelled only the final encode at a guessed hardware bitrate.
 *   - size: 5.91 GB over 7,825 s = 6.2 Mbit/s → the hardware factor is 2.06×
 *     the medium-preset baseline (videotoolbox at q:v spends far more bits on
 *     still footage than libx264 CRF 23), not the 1.15× that was guessed.
 *   - time: 1,800 s / 7,825 s = 0.23 s of work per output second. The encode
 *     itself is the small part; scene-clip prep (~12 min), crossfade chunks and
 *     the subtitle burn are the rest, and they run whatever the encoder.
 * ponytail: one measured render; re-measure (or learn from finished jobs) when
 * estimates drift on another Mac or another kind of episode.
 */

export interface RenderEstimateSettings {
  resolution: string
  fps: number
  quality: string
  encoding_effort: string
  codec: string
  format: string
  /** Bitrate the hardware encoder targets / the software encoder caps at, kbit/s; 0 = none. */
  video_bitrate_kbps?: number
}

/** Mbit/s at 1080p30, libx264 `medium`, per quality tier. */
const BASE_MBPS_BY_QUALITY: Record<string, number> = { compact: 0.8, fast: 1.5, medium: 3.0, high: 6.0 }
const RESOLUTION_FACTOR: Record<string, number> = { '720p': 0.44, '1080p': 1.0, '1440p': 1.78, '4k': 4.0 }
const FPS_FACTOR: Record<number, number> = { 24: 0.85, 25: 0.88, 30: 1.0, 60: 1.6 }
/** Measured: hardware 2.06 (see above). Software presets keep their relative guesses. */
const PRESET_FACTOR: Record<string, number> = { ultrafast: 2.0, medium: 1.0, slow: 0.75, hardware: 2.06 }
const CODEC_FACTOR: Record<string, number> = { h264: 1.0, h265: 0.65 }

/** Final-encode seconds per output second at 1080p H.264. */
const ENCODE_SEC_PER_SEC: Record<string, number> = { ultrafast: 0.1, medium: 0.4, slow: 1.2, hardware: 0.04 }
const CODEC_SPEED_FACTOR: Record<string, number> = { h264: 1.0, h265: 3.0 }
const RESOLUTION_SPEED_FACTOR: Record<string, number> = { '720p': 0.5, '1080p': 1.0, '1440p': 1.8, '4k': 4.5 }
/** Measured: everything that is not the final encode (0.23 − 0.04 s per output second at 1080p). */
const PIPELINE_SEC_PER_SEC = 0.19

export function estimateRender(s: RenderEstimateSettings, durationSec: number): { sizeGb: number; seconds: number } {
  const codec = s.format === 'webm' ? 'h264' : s.codec
  let mbps = (BASE_MBPS_BY_QUALITY[s.quality] || 3)
    * (RESOLUTION_FACTOR[s.resolution] || 1)
    * (FPS_FACTOR[s.fps] || 1)
    * (PRESET_FACTOR[s.encoding_effort] || 1)
    * (CODEC_FACTOR[codec] || 1)
  const capMbps = (s.video_bitrate_kbps || 0) / 1000
  if (capMbps > 0) mbps = s.encoding_effort === 'hardware' ? capMbps : Math.min(mbps, capMbps)
  const resolutionSpeed = RESOLUTION_SPEED_FACTOR[s.resolution] || 1
  const perSec = (ENCODE_SEC_PER_SEC[s.encoding_effort] || 0.4) * (CODEC_SPEED_FACTOR[codec] || 1) * resolutionSpeed
    + PIPELINE_SEC_PER_SEC * resolutionSpeed
  return { sizeGb: (mbps * durationSec) / 8 / 1024, seconds: perSec * durationSec }
}

export function formatEstimateGb(sizeGb: number): string {
  return Math.max(0.1, sizeGb).toFixed(sizeGb < 1 ? 2 : 1)
}

export function formatEstimateTime(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`
  if (secs < 3600) return `${Math.round(secs / 60)} min`
  const h = Math.floor(secs / 3600)
  const m = Math.round((secs % 3600) / 60)
  return `${h}h ${m}m`
}
