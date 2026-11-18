import type { VideoFrameConfig } from '../models/types.js'

export interface VideoFrameFilterOptions {
  inputLabel: string
  /** Optional FFmpeg input label for a still or looping video board. */
  backgroundInputLabel?: string
  outputLabel: string
  prefix: string
  width: number
  height: number
  fps: number
  config: VideoFrameConfig
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function safeColor(value: unknown, fallback: string): string {
  const color = String(value || '').trim()
  return /^(?:#[0-9a-fA-F]{6}|[a-zA-Z]{3,20})$/.test(color) ? color : fallback
}

/** Build a self-contained FFmpeg graph that places video inside a configurable
 * matte + border and masks the media corners. Pixel controls are authored at
 * 1080p and scale with output height so a preset looks consistent at 720p/4K. */
export function buildVideoFrameFilter(options: VideoFrameFilterOptions): string[] {
  const { inputLabel, backgroundInputLabel, outputLabel, prefix, width, height, fps, config } = options
  const insetPct = clamp(config.inset_pct, 0, 25, 4)
  const scale = height / 1080
  const borderPx = Math.round(clamp(config.border_width, 0, 160, 12) * scale)
  const insetPx = Math.round(Math.min(width, height) * insetPct / 100)
  const outerX = insetPx
  const outerY = insetPx
  const outerW = Math.max(16, width - outerX * 2)
  const outerH = Math.max(16, height - outerY * 2)
  const innerX = Math.min(Math.floor(width / 2) - 4, outerX + borderPx)
  const innerY = Math.min(Math.floor(height / 2) - 4, outerY + borderPx)
  const innerW = Math.max(8, width - innerX * 2)
  const innerH = Math.max(8, height - innerY * 2)
  const radius = Math.round(Math.min(
    clamp(config.corner_radius, 0, 300, 28) * scale,
    innerW / 2,
    innerH / 2,
  ))
  const background = safeColor(config.background_color, '#101820')
  const border = safeColor(config.border_color, '#FFFFFF')
  const fit = config.fit === 'contain' ? 'decrease' : 'increase'
  const fitTail = fit === 'increase'
    ? `,crop=${innerW}:${innerH}`
    : `,pad=${innerW}:${innerH}:(ow-iw)/2:(oh-ih)/2:color=${background}`

  const media = `${prefix}media`
  const bg = `${prefix}bg`
  const borderLayer = `${prefix}border`
  // The rounded-corner alpha, computed ONCE: one frame of `geq`, looped, merged
  // per frame. A per-frame `geq` over every pixel was about two-thirds of a
  // one channel's render (1.4.264, measured); the output is pixel-identical.
  const mask = `${prefix}mask`
  const rgb = `${prefix}rgb`
  const corners = `if(lt(X,${radius})*lt(Y,${radius}),if(lte(pow(X-${radius},2)+pow(Y-${radius},2),${radius * radius}),255,0),if(gte(X,W-${radius})*lt(Y,${radius}),if(lte(pow(X-(W-${radius}),2)+pow(Y-${radius},2),${radius * radius}),255,0),if(lt(X,${radius})*gte(Y,H-${radius}),if(lte(pow(X-${radius},2)+pow(Y-(H-${radius}),2),${radius * radius}),255,0),if(gte(X,W-${radius})*gte(Y,H-${radius}),if(lte(pow(X-(W-${radius}),2)+pow(Y-(H-${radius}),2),${radius * radius}),255,0),255))))`
  const mediaChain = radius > 0
    ? [
        `${inputLabel}scale=${innerW}:${innerH}:force_original_aspect_ratio=${fit}${fitTail},format=rgba[${rgb}]`,
        `color=c=white:s=${innerW}x${innerH}:r=${Math.max(1, Math.round(fps))},trim=end_frame=1,format=gray,geq=lum='${corners}',loop=loop=-1:size=1[${mask}]`,
        `[${rgb}][${mask}]alphamerge=shortest=1[${media}]`,
      ]
    : [`${inputLabel}scale=${innerW}:${innerH}:force_original_aspect_ratio=${fit}${fitTail},format=rgba[${media}]`]

  const backgroundChain = backgroundInputLabel
    ? `${backgroundInputLabel}setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[${bg}]`
    : `color=c=${background}:s=${width}x${height}:r=${Math.max(1, Math.round(fps))}[${bg}]`

  return [
    ...mediaChain,
    backgroundChain,
    `[${bg}]drawbox=x=${outerX}:y=${outerY}:w=${outerW}:h=${outerH}:color=${border}:t=fill[${borderLayer}]`,
    `[${borderLayer}][${media}]overlay=${innerX}:${innerY}:shortest=1,format=yuv420p${outputLabel}`,
  ]
}
