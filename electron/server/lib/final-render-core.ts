import type {
  VideoAgedArchiveFilm,
  VideoFilmGrain,
  VideoLogoConfig,
  VideoOverlay,
  VideoVignetteConfig,
} from '../models/types.js'
import {
  buildEncoderArgs,
  crfToVideotoolboxQ,
  videoBitrateCapKbps,
} from './final-render-encoder.js'
import {
  buildAgedArchiveFilmFilters,
  calculateLogoPosition,
  computeVignetteAngle,
  scaleAuthoredPosition,
} from './video-effects.js'

export type GraphPart = { filters: string[]; output: string }
export type GraphInput = { input: string; allocLabel: () => string }

export type FinalInputMode =
  | { kind: 'single' }
  | { kind: 'loop_stream' }
  | { kind: 'loop_still'; decoder: string | null }

export type EncodeTier = {
  label: string
  note?: string
  build: () => string[]
  /** Optional gate: only run if the previous tier failed in a way this
   *  tier can address. For tier 2 we keep the historical libx265-EINVAL
   *  guard so well-behaved H.265 jobs aren't quietly downgraded to H.264
   *  on unrelated failures. */
  shouldRun?: (prevError: any) => boolean
  /** Human-readable description of what gets dropped at this tier. */
  degraded?: string
  /** True when this tier bypasses `filter_complex` entirely, so every
   *  burned-in feature the user asked for is discarded. */
  dropsBurnedInFeatures?: boolean
}

export function buildFinalInputArgs(mediaPath: string, mode: FinalInputMode): string[] {
  if (mode.kind === 'single') return ['-i', mediaPath]
  if (mode.kind === 'loop_stream') return ['-stream_loop', '-1', '-i', mediaPath]
  return [...(mode.decoder ? ['-c:v', mode.decoder] : []), '-loop', '1', '-i', mediaPath]
}

export function buildFinalOverlayFilters(
  io: GraphInput,
  layer: VideoOverlay,
  inputIndex: number,
  w: number,
  h: number,
  gateEnable: string,
): GraphPart {
  // Build per-layer scaled/keyed source label.
  let scaleExpr = ''
  let scaledW = -1   // -1 = unknown (only known when scale_pct is used)
  if (typeof layer.scale_pct === 'number' && layer.scale_pct > 0) {
    // Percentage-of-canvas-width scale (v1.0.63+, compilation foregrounds).
    // Height auto via `-1` to preserve aspect ratio. Even pixel rounding so
    // yuv420p subsampling doesn't reject the chain.
    const targetW = Math.max(2, Math.round(w * Math.min(0.95, layer.scale_pct)))
    const evenW = targetW - (targetW % 2)
    scaleExpr = `scale=${evenW}:-2`
    scaledW = evenW
  } else {
    const scaleMode = layer.scale || 'cover'
    if (scaleMode === 'cover') {
      // Fill canvas, crop overflow. Preserves aspect ratio.
      scaleExpr = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
      scaledW = w
    } else if (scaleMode === 'contain') {
      // Fit inside canvas, transparent letterbox. Useful for frame mattes.
      scaleExpr = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`
      scaledW = w
    }
    // 'native' = no scale; layer composites at its source dimensions.
  }

  const parts: string[] = []
  if (scaleExpr) parts.push(scaleExpr)
  if (layer.chroma_key) {
    const ck = layer.chroma_key
    const hex = ck.color.startsWith('#') ? '0x' + ck.color.slice(1) : ck.color
    parts.push(`chromakey=color=${hex}:similarity=${ck.similarity ?? 0.15}:blend=${ck.blend ?? 0.1}`)
  }
  const opacity = layer.opacity ?? 1
  if (opacity < 1) {
    // Mix alpha with `aa=`. format=rgba ensures the input has an
    // alpha channel even when the source is yuv420p (no alpha).
    parts.push(`format=rgba,colorchannelmixer=aa=${opacity}`)
  }

  const srcLabel = io.allocLabel()
  const srcChain = parts.length
    ? `[${inputIndex}:v]${parts.join(',')}${srcLabel}`
    : `[${inputIndex}:v]null${srcLabel}`

  // Composite onto running base. Compose per-layer time range with
  // the global effects gate (intro/post-audio). The two are AND-ed.
  //
  // position_anchor (v1.0.63+) computes x/y from a named region —
  // `(W-w)/2` etc — using FFmpeg overlay-filter shorthands that the
  // engine resolves at draw time against the actual source size.
  // Falls back to `position.x` / `position.y` literals when no
  // anchor is set.
  let x = layer.position?.x ?? '0'
  let y = layer.position?.y ?? '0'
  if (layer.position_anchor) {
    const margin = Math.round(h * 0.04)   // ~4% inset for edge-anchored placements
    switch (layer.position_anchor) {
      case 'center':
        x = '(W-w)/2'; y = '(H-h)/2'
        break
      case 'top-third':
        x = '(W-w)/2'; y = `(H/3-h/2)`
        break
      case 'bottom-third':
        x = '(W-w)/2'; y = `(2*H/3-h/2)`
        break
      case 'lower-right':
        x = `W-w-${margin}`; y = `H-h-${margin}`
        break
      case 'lower-left':
        x = `${margin}`; y = `H-h-${margin}`
        break
    }
  }
  const enableExprs: string[] = []
  if (gateEnable) {
    // Existing gateEnable is `:enable='between(t,a,b)'` — strip wrapper
    // so we can AND it with the per-layer expression.
    const m = /^:enable='([^']+)'$/.exec(gateEnable)
    if (m) enableExprs.push(m[1]!)
  }
  if (layer.time_range) {
    const tr = layer.time_range
    if (tr.end_s != null) enableExprs.push(`between(t,${tr.start_s ?? 0},${tr.end_s})`)
    else if (tr.start_s) enableExprs.push(`gte(t,${tr.start_s})`)
  }
  const layerEnable = enableExprs.length ? `:enable='${enableExprs.join('*')}'` : ''

  const dst = io.allocLabel()
  return {
    filters: [srcChain, `${io.input}${srcLabel}overlay=${x}:${y}${layerEnable}${dst}`],
    output: dst,
  }
}

export function buildFinalVignetteFilters(io: GraphInput, vignette: VideoVignetteConfig, gateEnable: string): GraphPart {
  const angle = computeVignetteAngle(vignette.strength ?? 0.7)
  const output = io.allocLabel()
  return { filters: [`${io.input}vignette=angle=${angle.toFixed(4)}:mode=forward:eval=init${gateEnable}${output}`], output }
}

export function buildFinalFilmGrainFilters(io: GraphInput, filmGrain: VideoFilmGrain, gateEnable: string): GraphPart {
  const str = Math.round(filmGrain.strength ?? 15)
  const output = io.allocLabel()
  return { filters: [`${io.input}noise=alls=${str}:allf=t+u${gateEnable}${output}`], output }
}

export function buildFinalArchiveFilters(io: GraphInput, archiveFilm: VideoAgedArchiveFilm, width: number, height: number, gateEnable: string): GraphPart {
  const grade = io.allocLabel()
  const noise = io.allocLabel()
  const marked = io.allocLabel()
  const base = io.allocLabel()
  const weave = io.allocLabel()
  const shifted = io.allocLabel()
  const archive = io.allocLabel()
  return {
    filters: buildAgedArchiveFilmFilters({
      input: io.input, output: archive, grade, noise, marked, base, weave, shifted,
      width, height, strength: archiveFilm.strength, gateSuffix: gateEnable,
    }),
    output: archive,
  }
}

export function buildFinalLogoFilters(
  io: GraphInput,
  logo: VideoLogoConfig,
  inputIndex: number,
  w: number,
  h: number,
  gateEnable: string,
): GraphPart {
  const logoW = Math.round(w * (logo.scale || 0.1))
  const pos = calculateLogoPosition(logo.position, logo.margin || 20,
    scaleAuthoredPosition(logo.custom_x, w, 1920, logoW), scaleAuthoredPosition(logo.custom_y, h, 1080))
  const opacity = logo.opacity ?? 1

  const output = io.allocLabel()
  const filters = [`[${inputIndex}:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[logo]`]

  // If the global dual-sided gate is on (`gateEnable` non-empty), the logo
  // piggybacks on it so intro/title/tail/outro all stay logo-free. Otherwise
  // fall back to the legacy 10s hardcode when the user only toggled
  // `hide_during_intro`. When neither is on, the logo runs every frame.
  let logoEnable = ''
  if (gateEnable) {
    logoEnable = gateEnable
  } else if (logo.hide_during_intro) {
    logoEnable = `:enable='gt(t,10)'`
  }
  filters.push(`${io.input}[logo]overlay=${pos.x}:${pos.y}${logoEnable}${output}`)
  return { filters, output }
}

export function describeFinalBurnIns(opts: {
  colorGrading: boolean
  vignette: boolean
  filmGrain: boolean
  agedArchiveFilm: boolean
  letterbox: boolean
  frame: boolean
  overlayLayers: readonly Pick<VideoOverlay, 'chroma_key'>[]
  hasLogo: boolean
  subtitles: boolean
  contextualCueCount: number
  stackEntryCount: number
}): string[] {
  const requestedBurnIns: string[] = []
  if (opts.colorGrading) requestedBurnIns.push('color grading')
  if (opts.vignette) requestedBurnIns.push('vignette')
  if (opts.filmGrain) requestedBurnIns.push('film grain')
  if (opts.agedArchiveFilm) requestedBurnIns.push('aged archive film')
  if (opts.letterbox) requestedBurnIns.push('letterbox')
  if (opts.frame) requestedBurnIns.push('frame')
  if (opts.overlayLayers.length) {
    requestedBurnIns.push(
      opts.overlayLayers.some(l => l.chroma_key)
        ? `${opts.overlayLayers.length} overlay layer(s) incl. chroma key`
        : `${opts.overlayLayers.length} overlay layer(s)`,
    )
  }
  if (opts.hasLogo) requestedBurnIns.push('logo')
  if (opts.subtitles) requestedBurnIns.push('burned-in subtitles')
  if (opts.contextualCueCount) requestedBurnIns.push(`${opts.contextualCueCount} contextual cue(s)`)
  if (opts.stackEntryCount) requestedBurnIns.push(`${opts.stackEntryCount} Effects Library effect(s)`)
  return requestedBurnIns
}

export function buildFinalEncodeTiers(opts: {
  format: string
  codec?: 'h264' | 'h265'
  effort: string
  quality: { crf: number; preset: string }
  bitrateKbps?: number | null
  preEncoderArgs: readonly string[]
  videoInputPath: string
  premixedAudioPath: string
  targetDuration: number
  outputFile: string
}): EncodeTier[] {
  const encoderArgs = (useCodec: 'h264' | 'h265', effortOverride?: string): string[] => buildEncoderArgs({
    codec: useCodec,
    format: opts.format,
    crf: opts.quality.crf,
    effort: effortOverride ?? opts.effort,
    bitrateKbps: opts.bitrateKbps ?? undefined,
  })
  const effectiveCodec: 'h264' | 'h265' = (opts.format === 'webm' || opts.codec !== 'h265') ? 'h264' : 'h265'
  const buildFullArgs = (useCodec: 'h264' | 'h265', effortOverride?: string): string[] => [
    ...opts.preEncoderArgs,
    ...encoderArgs(useCodec, effortOverride),
    '-t', opts.targetDuration.toString(),
    opts.outputFile,
  ]
  const codecLabel = (useCodec: 'h264' | 'h265'): string => {
    if (opts.format === 'webm') return `VP9 · CRF ${opts.quality.crf}`
    const cap = videoBitrateCapKbps(opts.bitrateKbps)
    if (opts.effort === 'hardware') return cap ? `H.264 · hardware (videotoolbox, ${cap} kbit/s)` : `H.264 · hardware (videotoolbox, q:v ${crfToVideotoolboxQ(opts.quality.crf)})`
    if (cap && opts.format !== 'webm') return `${useCodec === 'h265' ? 'HEVC (H.265)' : 'H.264'} · preset ${opts.effort} · capped at ${cap} kbit/s`
    if (useCodec === 'h265') return `HEVC (H.265) · preset ${opts.effort}`
    return `H.264 · preset ${opts.effort}`
  }
  const buildMinimalArgs = (useCodec: 'h264' | 'h265'): string[] => [
    '-y', '-i', opts.videoInputPath, '-i', opts.premixedAudioPath,
    '-map', '0:v', '-map', '1:a',
    ...encoderArgs(useCodec),
    '-t', opts.targetDuration.toString(),
    opts.outputFile,
  ]

  return [
    {
      label: codecLabel(effectiveCodec),
      build: () => buildFullArgs(effectiveCodec),
    },
    {
      // Hardware (videotoolbox) → software libx264, FULL filter graph intact.
      label: `H.264 · libx264 ${opts.quality.preset} (hardware fallback, full effects)`,
      note: '(retry, libx264 software)',
      degraded: 'hardware encoder unavailable — re-encoded on CPU (same effects, slower)',
      shouldRun: () => opts.effort === 'hardware',
      build: () => buildFullArgs('h264', opts.quality.preset),
    },
    {
      label: codecLabel('h264') + ' (fallback)',
      note: '(retry, H.264)',
      degraded: 'codec downgraded to H.264',
      // Original guard: only swap codec when the failure stderr matches
      // the known libx265 EINVAL signature.
      shouldRun: (e) => {
        if (effectiveCodec !== 'h265') return false
        const s: string = e?.stderr || ''
        return s.includes('libx265') && s.includes('return code -22')
      },
      build: () => buildFullArgs('h264'),
    },
    {
      label: 'H.264 · no effects (recovery)',
      note: '(recovery, H.264 minimal)',
      degraded: 'all post effects removed (vignette/grain/grade/chroma/subtitles/letterbox/logo)',
      dropsBurnedInFeatures: true,
      build: () => buildMinimalArgs('h264'),
    },
  ]
}
