/**
 * The parameter panel for every effect kind — ONE table for the Video
 * Assembly effect picker and the Effects Library page — plus the badge and
 * render-cost figures shown on each effect card.
 *
 * ZERO RUNTIME DEPENDENCIES beyond the other contract modules: the pages import
 * it through `@shared`.
 *
 * Keyed by KIND, never by effect id, so a new effect of an existing kind (or a
 * content-pack effect) gets its controls for free. Every range here is the
 * normaliser's own range in `scene-effects.ts`; a slider can never offer a
 * value the render would clamp away.
 */

import { LOOP_VARIANT_INFO, loopParticleCount, normalizeLoopShape, type LoopShapeField, type LoopVariant } from './effect-loops.js'
import { COLOR_GRADE_PRESETS, LIVING_MOTIONS, OVERLAY_ANCHORS, type OverlayKind, type SceneOverlayDocument } from './scene-effects.js'

/**
 * Where each scope's effects start in the shared stack order when they carry no
 * explicit `order` — whole episode first, then theme runs, then single scenes.
 * One table for the render (`services/episode-effects.ts`) and the page, so the
 * stack the owner sees is the stack that renders.
 */
export const EFFECT_SCOPE_ORDER_BASE = { project: -100_000, episode: 0, theme: 100_000, scene: 200_000 } as const

export type ParamFormat = 'number' | 'percent' | 'share' | 'px' | 'sec' | 'deg' | 'times'

export interface ParamField {
  key: string
  label: string
  type: 'number' | 'color' | 'nullable-color' | 'text' | 'select' | 'seed'
  min?: number
  max?: number
  step?: number
  options?: readonly string[]
  /** Words to show for a select's options; the stored value stays the option itself. */
  option_labels?: Readonly<Record<string, string>>
  format?: ParamFormat
  /** True when changing it re-makes a baked loop (about two seconds), not just the tint. */
  rebake?: boolean
}

const LOOP_SHAPE_FIELDS: Record<LoopShapeField, Omit<ParamField, 'key'>> = {
  amount: { label: 'Amount', type: 'number', min: 0, max: 100, step: 1, format: 'percent', rebake: true },
  size: { label: 'Size', type: 'number', min: 0.25, max: 4, step: 0.05, format: 'times', rebake: true },
  speed: { label: 'Speed', type: 'number', min: 0.25, max: 4, step: 0.05, format: 'times', rebake: true },
  wind_deg: { label: 'Wind angle', type: 'number', min: -45, max: 45, step: 1, format: 'deg', rebake: true },
  sway: { label: 'Sway', type: 'number', min: 0, max: 1, step: 0.05, format: 'share', rebake: true },
  layers: { label: 'Depth layers', type: 'number', min: 1, max: 3, step: 1, format: 'number', rebake: true },
  twinkle: { label: 'Twinkle', type: 'number', min: 0, max: 1, step: 0.05, format: 'share', rebake: true },
  region_top: { label: 'Band top', type: 'number', min: 0, max: 1, step: 0.01, format: 'share', rebake: true },
  region_bottom: { label: 'Band bottom', type: 'number', min: 0, max: 1, step: 0.01, format: 'share', rebake: true },
  scale: { label: 'Scale', type: 'number', min: 0.25, max: 4, step: 0.05, format: 'times', rebake: true },
  beam: { label: 'Stay in the beam', type: 'number', min: 0, max: 1, step: 0.05, format: 'share', rebake: true },
  seed: { label: 'Seed', type: 'seed', min: 0, max: 99999, step: 1, rebake: true },
  loop_sec: { label: 'Loop length', type: 'number', min: 1, max: 30, step: 1, format: 'sec', rebake: true },
}

/** Variant-specific wording for the shared shape fields. */
const LOOP_LABELS: Partial<Record<LoopVariant, Partial<Record<LoopShapeField, string>>>> = {
  rain: { size: 'Streak length', speed: 'Fall speed' },
  snow: { size: 'Flake size', speed: 'Fall speed' },
  fireflies: { twinkle: 'Blink', sway: 'Wander' },
  embers: { speed: 'Rise speed', twinkle: 'Flicker' },
  fog: { amount: 'Density', speed: 'Drift speed', region_top: 'Mist top' },
  'cloud-shadows': { amount: 'Coverage', speed: 'Drift speed' },
  'light-rays': { amount: 'Rays', wind_deg: 'Angle', region_bottom: 'Reach' },
  aurora: { amount: 'Curtains', sway: 'Wave', twinkle: 'Pulse', region_top: 'Sky top', region_bottom: 'Lowest hem' },
  'moon-glow': { size: 'Glow size', twinkle: 'Breathing', beam: 'Across', region_top: 'Height' },
  'sky-clouds': { amount: 'Cloud cover', speed: 'Drift speed', region_bottom: 'Lowest cloud' },
  caustics: { amount: 'Brightness', scale: 'Pattern size', speed: 'Drift speed' },
  'window-drops': { amount: 'Drops', size: 'Drop size', speed: 'Slide speed' },
  paper: { amount: 'Texture', scale: 'Grain size' },
  'film-dust': { amount: 'Specks', size: 'Speck size', layers: 'Scratches' },
}

const ATMOSPHERE_LOOK_FIELDS: ParamField[] = [
  { key: 'color_hex', label: 'Colour', type: 'color' },
  { key: 'secondary_color_hex', label: 'Second colour', type: 'nullable-color' },
  { key: 'opacity', label: 'Brightness', type: 'number', min: 0, max: 1, step: 0.01, format: 'percent' },
  { key: 'darken', label: 'Darken picture', type: 'number', min: 0, max: 0.5, step: 0.01, format: 'percent' },
]

const ANCHOR_OPTIONS = OVERLAY_ANCHORS

const FIELDS_BY_KIND: Record<OverlayKind, ParamField[]> = {
  vignette: [
    { key: 'intensity', label: 'Strength', type: 'number', min: 0, max: 1, step: 0.05, format: 'share' },
  ],
  'film-grain': [
    { key: 'amount', label: 'Amount', type: 'number', min: 0, max: 100, step: 1 },
  ],
  'light-leak': [
    { key: 'color_hex', label: 'Colour', type: 'color' },
    { key: 'intensity', label: 'Strength', type: 'number', min: 0, max: 1, step: 0.05, format: 'share' },
    { key: 'softness', label: 'Softness', type: 'number', min: 0, max: 1, step: 0.05, format: 'share' },
    { key: 'from_anchor', label: 'Starts at', type: 'select', options: ANCHOR_OPTIONS },
    { key: 'to_anchor', label: 'Drifts to', type: 'select', options: ANCHOR_OPTIONS },
  ],
  letterbox: [
    { key: 'ratio', label: 'Aspect ratio', type: 'select', options: ['2.35:1', '2.00:1', '1.85:1', 'custom'] },
    { key: 'bar_share', label: 'Bar depth (custom only)', type: 'number', min: 0, max: 0.4, step: 0.01, format: 'share' },
    {
      key: 'mode', label: 'Picture', type: 'select', options: ['fit', 'cover'],
      option_labels: { fit: 'Keep the whole picture', cover: 'Cinematic crop (covers edges)' },
    },
  ],
  'lower-third': [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'subtitle', label: 'Subtitle', type: 'text' },
    { key: 'title_size_px', label: 'Title size', type: 'number', min: 8, max: 200, step: 1, format: 'px' },
    { key: 'anchor', label: 'Position', type: 'select', options: ANCHOR_OPTIONS },
    { key: 'margin_px', label: 'Margin', type: 'number', min: 0, max: 400, step: 4, format: 'px' },
  ],
  'corner-logo': [
    { key: 'image_path', label: 'Image path', type: 'text' },
    { key: 'anchor', label: 'Corner', type: 'select', options: ANCHOR_OPTIONS },
    { key: 'width_pct', label: 'Width', type: 'number', min: 0.01, max: 1, step: 0.01, format: 'share' },
    { key: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.05, format: 'share' },
    { key: 'margin_px', label: 'Margin', type: 'number', min: 0, max: 400, step: 4, format: 'px' },
  ],
  'gradient-scrim': [
    { key: 'edge', label: 'Edge', type: 'select', options: ['top', 'bottom', 'left', 'right'] },
    { key: 'color_hex', label: 'Colour', type: 'color' },
    { key: 'opacity', label: 'Strength', type: 'number', min: 0, max: 1, step: 0.05, format: 'share' },
    { key: 'coverage', label: 'Reach', type: 'number', min: 0.02, max: 1, step: 0.02, format: 'share' },
    { key: 'steps', label: 'Smoothness', type: 'number', min: 2, max: 64, step: 1 },
  ],
  // Resolved per variant by `effectParamFields`; never read directly.
  'atmosphere-loop': [],
  bloom: [
    { key: 'threshold', label: 'Glow above', type: 'number', min: 0, max: 1, step: 0.01, format: 'percent' },
    { key: 'strength', label: 'Strength', type: 'number', min: 0, max: 1, step: 0.01, format: 'percent' },
    { key: 'radius_px', label: 'Radius', type: 'number', min: 1, max: 80, step: 1, format: 'px' },
  ],
  flicker: [
    { key: 'amount', label: 'Amount', type: 'number', min: 0, max: 0.3, step: 0.005, format: 'percent' },
    { key: 'speed', label: 'Speed', type: 'number', min: 0.1, max: 4, step: 0.05, format: 'times' },
  ],
  lightning: [
    { key: 'strength', label: 'Flash strength', type: 'number', min: 0, max: 1, step: 0.01, format: 'percent' },
    { key: 'period_sec', label: 'A chance every', type: 'number', min: 2, max: 300, step: 1, format: 'sec' },
    { key: 'chance', label: 'Chance of a strike', type: 'number', min: 0, max: 1, step: 0.01, format: 'percent' },
    { key: 'seed', label: 'Seed', type: 'seed', min: 0, max: 99999, step: 1 },
  ],
  'heat-shimmer': [
    { key: 'strength_px', label: 'Strength', type: 'number', min: 0, max: 16, step: 0.5, format: 'px' },
    { key: 'scale', label: 'Ripple size', type: 'number', min: 0.25, max: 4, step: 0.05, format: 'times' },
    { key: 'speed', label: 'Speed', type: 'number', min: 0.25, max: 4, step: 0.05, format: 'times' },
    { key: 'region_top', label: 'Band top', type: 'number', min: 0, max: 1, step: 0.01, format: 'share' },
    { key: 'region_bottom', label: 'Band bottom', type: 'number', min: 0, max: 1, step: 0.01, format: 'share' },
    { key: 'seed', label: 'Seed', type: 'seed', min: 0, max: 99999, step: 1 },
  ],
  'color-grade': [
    { key: 'preset', label: 'Preset', type: 'select', options: COLOR_GRADE_PRESETS },
    { key: 'brightness', label: 'Brightness', type: 'number', min: -1, max: 1, step: 0.01 },
    { key: 'contrast', label: 'Contrast', type: 'number', min: 0, max: 3, step: 0.01, format: 'times' },
    { key: 'saturation', label: 'Saturation', type: 'number', min: 0, max: 3, step: 0.01, format: 'times' },
    { key: 'warmth', label: 'Warmth', type: 'number', min: -1, max: 1, step: 0.01 },
    { key: 'tint', label: 'Tint', type: 'number', min: -1, max: 1, step: 0.01 },
  ],
  // The outline itself (`region`) is uploaded per scene, not a slider.
  'living-region': [
    {
      key: 'motion', label: 'Motion', type: 'select', options: LIVING_MOTIONS,
      option_labels: {
        flame: 'Candle flame (flicker + wobble)', fire: 'Fire pit (slower, coarser flames)',
        glow: 'Candle light glow', 'fire-glow': 'Fire-pit light glow',
        steam: 'Steam (rising drift)', water: 'Water (ripple + shimmer)', sky: 'Sky (slow drift)', pulse: 'Moon / lamp pulse',
      },
    },
    { key: 'strength', label: 'Strength', type: 'number', min: 0, max: 3, step: 0.05, format: 'times' },
    { key: 'speed', label: 'Speed', type: 'number', min: 0.25, max: 4, step: 0.05, format: 'times' },
    // Read only when the effect is on the whole episode, a theme or Video Assembly's list.
    { key: 'outline', label: 'Outline name (whole episode)', type: 'text' },
  ],
  'shooting-star': [
    { key: 'color_hex', label: 'Colour', type: 'color' },
    { key: 'opacity', label: 'Brightness', type: 'number', min: 0, max: 1, step: 0.01, format: 'percent' },
    { key: 'size', label: 'Size', type: 'number', min: 0.5, max: 2, step: 0.05, format: 'times' },
    { key: 'period_sec', label: 'A chance every', type: 'number', min: 4, max: 600, step: 1, format: 'sec' },
    { key: 'chance', label: 'Chance of a star', type: 'number', min: 0, max: 1, step: 0.01, format: 'percent' },
    { key: 'region_top', label: 'Sky top', type: 'number', min: 0, max: 1, step: 0.01, format: 'share' },
    { key: 'region_bottom', label: 'Sky bottom', type: 'number', min: 0, max: 1, step: 0.01, format: 'share' },
    { key: 'seed', label: 'Seed', type: 'seed', min: 0, max: 99999, step: 1 },
  ],
  'bedtime-dimming': [
    { key: 'darken_pct', label: 'Darker by', type: 'number', min: 0, max: 50, step: 1, format: 'percent' },
    { key: 'warmth_pct', label: 'Warmer by', type: 'number', min: 0, max: 100, step: 1, format: 'percent' },
    { key: 'desaturate_pct', label: 'Less colour by', type: 'number', min: 0, max: 30, step: 1, format: 'percent' },
    { key: 'start_pct', label: 'Starts at (% of the episode)', type: 'number', min: 0, max: 99, step: 1, format: 'percent' },
    { key: 'full_pct', label: 'Full at (% of the episode)', type: 'number', min: 1, max: 100, step: 1, format: 'percent' },
  ],
}

/** The controls one effect document shows. */
export function effectParamFields(doc: Pick<SceneOverlayDocument, 'kind'> & { variant?: LoopVariant }): ParamField[] {
  if (doc.kind !== 'atmosphere-loop') return FIELDS_BY_KIND[doc.kind] || []
  const variant: LoopVariant = doc.variant && doc.variant in LOOP_VARIANT_INFO ? doc.variant : 'rain'
  const labels = LOOP_LABELS[variant] || {}
  const shape = LOOP_VARIANT_INFO[variant].fields.map(key => ({
    key, ...LOOP_SHAPE_FIELDS[key], ...(labels[key] ? { label: labels[key]! } : {}),
  }))
  // Cloud shadows are drawn in black; a second colour would mean nothing.
  const look = variant === 'cloud-shadows' || variant === 'moon-glow' || variant === 'paper'
    ? ATMOSPHERE_LOOK_FIELDS.filter(f => f.key === 'opacity').map(f => ({ ...f, label: 'Darkness' }))
    : ATMOSPHERE_LOOK_FIELDS
  return [...shape, ...look]
}

// ═══════════════════════════════════════════════════════════════════════════
// Card badge and render cost
// ═══════════════════════════════════════════════════════════════════════════

export function effectBadge(doc: SceneOverlayDocument): string {
  if (doc.kind === 'atmosphere-loop') {
    const method = LOOP_VARIANT_INFO[doc.variant].method
    return method === 'noise' ? 'Noise loop' : method === 'light' ? 'Light loop' : 'Particle loop'
  }
  if (doc.kind === 'lower-third' || doc.kind === 'corner-logo' || doc.kind === 'letterbox' || doc.kind === 'gradient-scrim') return 'Overlay'
  if (doc.kind === 'shooting-star') return 'Rare event'
  if (doc.kind === 'bedtime-dimming') return 'Whole episode'
  return 'Live filter'
}

/**
 * CPU-seconds one 1080p frame of this effect costs in the final pass, measured
 * on the M2 Max with the bundled FFmpeg 8.1 (music-format study, 2026-10-03:
 * per-effect figures from SPEC §12, stack calibration below). Scales with pixel
 * count at other sizes.
 */
const CPU_SEC_PER_FRAME_BY_KIND: Record<OverlayKind, number> = {
  vignette: 0.003,
  'film-grain': 0.0024,
  'light-leak': 0.012,
  letterbox: 0.0005,
  'lower-third': 0.001,
  'corner-logo': 0.002,
  'gradient-scrim': 0.003,
  'atmosphere-loop': 0.0113,
  bloom: 0.0076,
  flicker: 0.001,
  lightning: 0.001,
  'heat-shimmer': 0.0175,
  'color-grade': 0.0044,
  // Paid per scene clip, not in the final pass: two moving maps, a displace and a masked merge.
  'living-region': 0.03,
  // A small sprite overlay whose position is two expressions; most frames it is switched off.
  'shooting-star': 0.0012,
  // One eq whose lookup tables are rebuilt each frame (plan §C: ~3–4 min on a 2-hour episode).
  'bedtime-dimming': 0.0046,
}

/** A bloom with `color_hex` (halation): the glow becomes a colour layer laid over the picture. */
const TINTED_BLOOM_CPU_SEC = 0.0092

/** One extra full-frame overlay, paid when a plain filter fades in or out. */
const FADE_WRAPPER_CPU_SEC = 0.011

export function effectCostPerFrame(doc: SceneOverlayDocument): number {
  let cost = CPU_SEC_PER_FRAME_BY_KIND[doc.kind] ?? 0.005
  if (doc.kind === 'atmosphere-loop') {
    const tints = doc.secondary_color_hex && doc.secondary_color_hex !== doc.color_hex ? 2 : 1
    cost = cost * tints + (doc.darken > 0 ? 0.001 : 0)
  }
  // Halation: the tinted glow is laid over as a colour layer, about half again a plain bloom.
  if (doc.kind === 'bloom' && doc.color_hex) cost = TINTED_BLOOM_CPU_SEC
  const fades = (doc.timing.fade_in_sec || 0) > 0 || (doc.timing.fade_out_sec || 0) > 0
  if (fades && !['atmosphere-loop', 'flicker', 'lightning', 'lower-third', 'shooting-star', 'bedtime-dimming'].includes(doc.kind)) cost += FADE_WRAPPER_CPU_SEC
  return cost
}

/**
 * Cores the final pass keeps busy on average with a stack of effects, measured
 * end to end on the M2 Max (2026-10-03): the Rainy Night stack (grade, fog,
 * rain, lightning, vignette, grain) over 60 s of 1080p24 used 0.043 CPU-s a
 * frame at 95 fps — about 4.1 cores, adding 11.3 s of wall time per minute of
 * video over the bare pass. A single overlay alone parallelises better; a stack
 * is a chain. Rounded down so the estimate errs long.
 */
export const STACK_EFFECTIVE_CORES = 4

/** Wall-clock minutes a stack adds to a render of `durationSec` at `w`×`h`, `fps`. */
export function estimateStackMinutes(
  docs: readonly SceneOverlayDocument[],
  opts: { durationSec: number; fps: number; w: number; h: number },
): number {
  const pixels = (opts.w * opts.h) / (1920 * 1080)
  const frames = opts.durationSec * opts.fps
  const cpu = docs.reduce((sum, doc) => sum + effectCostPerFrame(doc), 0) * pixels * frames
  return cpu / STACK_EFFECTIVE_CORES / 60
}

/** "1,400 drops" for a loop, or null. */
export function effectAmountLabel(doc: SceneOverlayDocument): string | null {
  if (doc.kind !== 'atmosphere-loop') return null
  const info = LOOP_VARIANT_INFO[doc.variant]
  if (!info.unit) return null
  const count = loopParticleCount(normalizeLoopShape(doc, doc.variant))
  return `${count.toLocaleString('en-US')} ${info.unit}`
}
