/**
 * Scene effects — the declarative documents behind every camera move and every
 * overlay Story Studio can render.
 *
 * ZERO RUNTIME DEPENDENCIES ON PURPOSE, exactly as
 * `contracts/subtitle-style.ts` is. The picker components import the defaults,
 * the built-in registries and the normalisers as VALUES, so this module must
 * not drag zod into the browser bundle. Strict validation lives next door in
 * `contracts/scene-effects-schema.ts` and is imported by the backend only.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 *
 * 1. **An effect is data.** No functions, no expressions, no code. Every effect
 *    is a named field with a documented range and a default; the compiler
 *    (`lib/scene-effect-compiler.ts`) is the only thing that knows how to turn
 *    those fields into FFmpeg filters. That is what makes an effect shippable
 *    as a content pack later — packs may never carry executable content, so
 *    anything the compiler cannot do from plain data can never ship as a pack.
 *
 * 2. **Pixel values mean "pixels at a 1920x1080 reference frame."** Every `_px`
 *    field is interpreted at that reference and scaled by outputHeight/1080 at
 *    compile time, the same rule v1.1.0 established for subtitles.
 *
 * 3. **Nullable means "inherit" or "unbounded", never "unset".** `end_sec: null`
 *    runs to the end of the clip; `secondary_color_hex: null` follows the
 *    primary colour. Writing a value overrides the inheritance.
 *
 * ── Two documents, one registry ────────────────────────────────────────────
 *
 * A **motion** transforms the picture: it decides which pixels of the source
 * end up in the frame, and the frame is the only thing it produces. A camera
 * move has no content of its own.
 *
 * An **overlay** composites something ON TOP of a finished frame. It has
 * content (a colour wash, a bar, a line of text, an image), an anchor, a size,
 * an opacity and a live window — none of which a Ken Burns push has any concept
 * of, and all of which lower-thirds and corner logos require.
 *
 * They are therefore two schemas, and the split is structural rather than
 * cosmetic: motions compile to a LINEAR filter chain applied per source clip,
 * before the clips are stitched. Overlays compile to a filtergraph FRAGMENT —
 * some of them (light leaks, corner logos) genuinely need a second branch and a
 * blend — applied once to the composed timeline. One schema covering both would
 * have to leave most of itself null on every instance and would still need the
 * compiler to branch on which half was filled in.
 *
 * They share this module, the `SceneEffectDescriptor` metadata wrapper, the
 * built-in registry in `contracts/scene-effect-presets.ts`, the strict schema
 * next door, and the preview endpoint.
 */

export const SCENE_EFFECT_SCHEMA_VERSION = 1 as const

/** Reference frame every `_px` field is expressed against. */
export const SCENE_EFFECT_REFERENCE_HEIGHT = 1080

// ═══════════════════════════════════════════════════════════════════════════
// Motion
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Which pipeline renders the motion.
 *
 *   - `still`   — the source is ONE image and the clip is generated from it.
 *                 Rendered with `zoompan`, which produces `d` frames from a
 *                 single input frame.
 *   - `footage` — the source is already moving video. `zoompan` cannot be used
 *                 (it would freeze the clip on its first frame), so the camera
 *                 is a time-varying `scale`/`crop` window instead.
 *
 * This is not an implementation detail leaking into data: the same named move
 * genuinely differs between the two, which is why `Slow Zoom In` over footage
 * and `Zoom In` over a still are separate registry entries with separate
 * magnitudes rather than one entry rendered two ways.
 */
export const MOTION_SOURCES = ['still', 'footage'] as const
export type MotionSource = (typeof MOTION_SOURCES)[number]

/**
 * Magnification over the clip.
 *   - `none`  — the camera does not zoom. No `zoompan` zoom term is emitted.
 *   - `fixed` — constant magnification, `fixed_pct`. Used by pans, which need
 *               the source magnified so there is something to pan within.
 *   - `ramp`  — linear from `from_pct` to `to_pct`.
 *   - `sine`  — `base_pct` plus `amplitude_pct`, one full cycle per clip.
 */
export const MOTION_ZOOM_MODES = ['none', 'fixed', 'ramp', 'sine'] as const
export type MotionZoomMode = (typeof MOTION_ZOOM_MODES)[number]

/**
 * Lateral camera movement.
 *   - `none`     — no drift.
 *   - `rate`     — drift at a constant speed, in the unit named by `rate_unit`.
 *                  The distance covered depends on how long the clip is.
 *   - `traverse` — cross a signed fraction of the available headroom over the
 *                  clip, however long it is. Only the `footage` engine can do
 *                  this, because it knows the slack up front.
 */
export const MOTION_PAN_MODES = ['none', 'rate', 'traverse'] as const
export type MotionPanMode = (typeof MOTION_PAN_MODES)[number]

/**
 * The unit `pan.x` / `pan.y` are expressed in when `pan.mode` is `rate`.
 *
 *   - `output-px-per-second` — the honest unit: how far the framing travels
 *     across the OUTPUT frame each second. Independent of fps.
 *   - `source-px-per-frame` — travel per rendered FRAME, measured on the
 *     prepared (scaled) source. fps-dependent, so a clip rendered at 60fps
 *     drifts more than the same clip at 25fps.
 *
 * The second unit exists because `dolly-in` was authored that way in v1.0 and
 * its output is pinned. Prefer `output-px-per-second` for anything new.
 *
 * The unit also fixes how the number is PRINTED, so that pinned output stays
 * byte-identical: a derived per-second rate is emitted at six decimal places,
 * an authored per-frame rate is emitted exactly as authored.
 */
export const MOTION_RATE_UNITS = ['output-px-per-second', 'source-px-per-frame'] as const
export type MotionRateUnit = (typeof MOTION_RATE_UNITS)[number]

export interface SceneMotionFraming {
  /**
   * How large the source is prepared, as a percentage of the output frame,
   * before the camera stage runs. 100 = no preparation.
   *
   * 200 is the supersample the `still` engine uses so `zoompan` has real pixels
   * to sample rather than inventing them; 110 is the coverage a rotation needs
   * so its corners never show. For a `footage` `traverse` pan the enlargement
   * applies only to the traversed axis — that IS the slack the pan crosses.
   */
  source_scale_pct: number
}

export interface SceneMotionZoom {
  mode: MotionZoomMode
  /** `fixed` — constant magnification, 100..400 %. */
  fixed_pct: number
  /** `ramp` — magnification at the first frame, 10..400 %. */
  from_pct: number
  /** `ramp` — magnification at the last frame, 10..400 %. */
  to_pct: number
  /** `sine` — resting magnification, 100..400 %. */
  base_pct: number
  /** `sine` — swing either side of `base_pct`, 0..100 %. */
  amplitude_pct: number
}

export interface SceneMotionPan {
  mode: MotionPanMode
  /**
   * Horizontal drift. Negative moves the framing LEFT across the picture.
   * `rate` — in `rate_unit`, -400..400.
   * `traverse` — signed share of the horizontal slack, -1..1.
   */
  x: number
  /** Vertical drift. Negative moves the framing UP. Same units as `x`. */
  y: number
  rate_unit: MotionRateUnit
}

export interface SceneMotionSpin {
  /** Rotation rate in radians per second, -1..1. 0 = no rotation. */
  rate_rad_per_sec: number
}

export interface SceneMotionFade {
  in: boolean
  out: boolean
  /** Longest a fade may last, 0..10 seconds. */
  max_sec: number
  /** Fade length as a share of the clip, 0..0.5, capped by `max_sec`. */
  share_of_clip: number
}

/**
 * One step of a blur ramp. Blur runs at `sigma` until `until_share` of the clip
 * has elapsed, then the next stage takes over; after the last stage the picture
 * is sharp. An empty `stages` array means no blur at all.
 *
 * Stages exist rather than a single "blur from N to 0" because FFmpeg's `gblur`
 * cannot animate its own sigma — the ramp has to be built from time-gated
 * applications, and how many steps to spend is an authoring choice.
 */
export interface SceneMotionFocusStage {
  /** Gaussian sigma, 0..50. */
  sigma: number
  /** End of this stage as a share of the clip, 0..1. Must increase. */
  until_share: number
}

export interface SceneMotionFocus {
  stages: SceneMotionFocusStage[]
}

export interface SceneMotionDocument {
  schema_version: typeof SCENE_EFFECT_SCHEMA_VERSION
  source: MotionSource
  framing: SceneMotionFraming
  zoom: SceneMotionZoom
  pan: SceneMotionPan
  spin: SceneMotionSpin
  fade: SceneMotionFade
  focus: SceneMotionFocus
}

export type SceneMotionPatch = {
  [K in keyof Omit<SceneMotionDocument, 'schema_version' | 'source'>]?: Partial<SceneMotionDocument[K]>
} & { schema_version?: number; source?: MotionSource }

/** A still with no camera move: fit to frame, pad, done. */
export function defaultSceneMotion(): SceneMotionDocument {
  return {
    schema_version: SCENE_EFFECT_SCHEMA_VERSION,
    source: 'still',
    framing: { source_scale_pct: 100 },
    zoom: { mode: 'none', fixed_pct: 100, from_pct: 100, to_pct: 108, base_pct: 103, amplitude_pct: 2 },
    pan: { mode: 'none', x: 0, y: 0, rate_unit: 'output-px-per-second' },
    spin: { rate_rad_per_sec: 0 },
    fade: { in: false, out: false, max_sec: 1.5, share_of_clip: 0.5 },
    focus: { stages: [] },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Overlay
// ═══════════════════════════════════════════════════════════════════════════

export const OVERLAY_KINDS = [
  'vignette',
  'film-grain',
  'light-leak',
  'letterbox',
  'lower-third',
  'corner-logo',
  'gradient-scrim',
] as const
export type OverlayKind = (typeof OVERLAY_KINDS)[number]

/** The nine anchor points an overlay can hang from, plus the whole frame. */
export const OVERLAY_ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const
export type OverlayAnchor = (typeof OVERLAY_ANCHORS)[number]

export const SCRIM_EDGES = ['top', 'bottom', 'left', 'right'] as const
export type ScrimEdge = (typeof SCRIM_EDGES)[number]

/** Cinematic bar ratios. `custom` uses `bar_share`. */
export const LETTERBOX_RATIOS = ['2.35:1', '2.00:1', '1.85:1', 'custom'] as const
export type LetterboxRatio = (typeof LETTERBOX_RATIOS)[number]

/** How a light leak is mixed into the picture. */
export const LEAK_BLENDS = ['screen', 'lighten', 'addition'] as const
export type LeakBlend = (typeof LEAK_BLENDS)[number]

/** When the overlay is live. `end_sec: null` runs to the end of the clip. */
export interface OverlayTiming {
  start_sec: number
  end_sec: number | null
}

export interface OverlayBase {
  schema_version: typeof SCENE_EFFECT_SCHEMA_VERSION
  timing: OverlayTiming
}

export interface VignetteOverlay extends OverlayBase {
  kind: 'vignette'
  /**
   * 0 = barely there, 1 = heavy corners. Mapped onto FFmpeg's `vignette`
   * lens angle, which grows stronger as it approaches PI/2; the mapped band
   * stops short of that extreme so the centre never dims like an exposure cut.
   */
  intensity: number
}

export interface FilmGrainOverlay extends OverlayBase {
  kind: 'film-grain'
  /** Noise strength, 0..100. */
  amount: number
  /** Re-roll the grain every frame. Off = a fixed pattern, which reads as dirt. */
  temporal: boolean
  /** Uniform rather than Gaussian distribution. Uniform is the filmic default. */
  uniform: boolean
}

export interface LightLeakOverlay extends OverlayBase {
  kind: 'light-leak'
  color_hex: string
  /** Peak strength of the leak, 0..1. */
  intensity: number
  /**
   * How soft the leak's falloff is, 0..1. 0 is a tight hotspot, 1 spreads
   * across most of the frame.
   */
  softness: number
  /** Where the leak sits at `timing.start_sec`. */
  from_anchor: OverlayAnchor
  /** Where it has drifted to by the end. Same anchor = a static glow. */
  to_anchor: OverlayAnchor
  blend: LeakBlend
}

export interface LetterboxOverlay extends OverlayBase {
  kind: 'letterbox'
  ratio: LetterboxRatio
  /** `custom` only — each bar's height as a share of the frame, 0..0.4. */
  bar_share: number
  /** An FFmpeg colour: a name such as `black`, or `#RRGGBB`. */
  color: string
}

export interface LowerThirdOverlay extends OverlayBase {
  kind: 'lower-third'
  title: string
  subtitle: string
  font_family: string
  /** 8..200 px at the 1080 reference. */
  title_size_px: number
  /** 8..200 px at the 1080 reference. */
  subtitle_size_px: number
  title_color_hex: string
  subtitle_color_hex: string | null
  /** Backing bar behind the text. */
  bar: boolean
  bar_color_hex: string
  bar_opacity: number
  /** Space between the bar edge and the text, 0..200 px at 1080. */
  padding_px: number
  anchor: OverlayAnchor
  /** Distance from the anchored frame edges, 0..400 px at 1080. */
  margin_px: number
  /** Fade the whole block in and out, 0..3000 ms each. */
  fade_in_ms: number
  fade_out_ms: number
}

export interface CornerLogoOverlay extends OverlayBase {
  kind: 'corner-logo'
  /**
   * Absolute path to a PNG/JPEG. Empty means the overlay compiles to nothing —
   * an unset logo is not an error, it is simply not drawn.
   *
   * A content pack supplying this must have it resolved to a path INSIDE the
   * pack before it reaches the compiler; the compiler refuses a path containing
   * filtergraph metacharacters rather than escaping its way around them.
   */
  image_path: string
  anchor: OverlayAnchor
  /** Distance from the anchored frame edges, 0..400 px at 1080. */
  margin_px: number
  /** Width as a share of the frame width, 0.01..1. Height follows the aspect. */
  width_pct: number
  opacity: number
}

export interface GradientScrimOverlay extends OverlayBase {
  kind: 'gradient-scrim'
  edge: ScrimEdge
  color_hex: string
  /** Opacity at the frame edge, fading to zero inwards. 0..1. */
  opacity: number
  /** How far in the scrim reaches, as a share of that dimension. 0.02..1. */
  coverage: number
  /**
   * Number of bands the ramp is built from, 2..64.
   *
   * APPROXIMATION, see `approximation` on the registry entry: FFmpeg's
   * `drawbox` cannot draw a gradient, so the ramp is a stack of flat bands at
   * stepped opacity. More bands is smoother and costs more filter nodes.
   */
  steps: number
}

export type SceneOverlayDocument =
  | VignetteOverlay
  | FilmGrainOverlay
  | LightLeakOverlay
  | LetterboxOverlay
  | LowerThirdOverlay
  | CornerLogoOverlay
  | GradientScrimOverlay

/** A partial overlay, as a preset or a pack expresses it. `kind` is required. */
export type SceneOverlayPatch =
  { kind: OverlayKind } & Partial<Omit<SceneOverlayDocument, 'kind'>> & Record<string, unknown>

const DEFAULT_TIMING: OverlayTiming = { start_sec: 0, end_sec: null }

/** The shipped default for one overlay kind, before any preset patch. */
export function defaultSceneOverlay(kind: OverlayKind): SceneOverlayDocument {
  const base = { schema_version: SCENE_EFFECT_SCHEMA_VERSION, timing: { ...DEFAULT_TIMING } } as const
  switch (kind) {
    case 'vignette':
      return { ...base, kind, intensity: 0.7 }
    case 'film-grain':
      return { ...base, kind, amount: 15, temporal: true, uniform: true }
    case 'light-leak':
      return {
        ...base, kind, color_hex: '#FF9A3C', intensity: 0.35, softness: 0.6,
        from_anchor: 'top-right', to_anchor: 'center-right', blend: 'screen',
      }
    case 'letterbox':
      return { ...base, kind, ratio: '2.35:1', bar_share: 0.12, color: 'black' }
    case 'lower-third':
      return {
        ...base, kind, title: '', subtitle: '', font_family: 'Helvetica',
        title_size_px: 44, subtitle_size_px: 28,
        title_color_hex: '#FFFFFF', subtitle_color_hex: null,
        bar: true, bar_color_hex: '#101014', bar_opacity: 0.72,
        padding_px: 28, anchor: 'bottom-left', margin_px: 72,
        fade_in_ms: 320, fade_out_ms: 320,
      }
    case 'corner-logo':
      return {
        ...base, kind, image_path: '', anchor: 'bottom-right',
        margin_px: 40, width_pct: 0.1, opacity: 0.8,
      }
    case 'gradient-scrim':
      return {
        ...base, kind, edge: 'bottom', color_hex: '#000000',
        opacity: 0.75, coverage: 0.34, steps: 24,
      }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Registry metadata
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Picker groups for camera moves. App-owned on purpose, exactly as
 * `RECENCY_STRATEGY_IDS` is: a content pack chooses which existing group its
 * move belongs to, and cannot invent a new section of the picker — a new
 * section is engine behaviour, and a pack ships data.
 *
 * `groupedAnimations()` in `models/animations.ts` builds a fixed record from
 * these six, so an unlisted category would land on `undefined` and throw.
 */
export const SCENE_MOTION_CATEGORIES = ['zoom', 'pan', 'ambient', 'rotate', 'effect', 'static'] as const
export type SceneMotionCategory = (typeof SCENE_MOTION_CATEGORIES)[number]

/** Footage moves are one group of their own — they render on a different engine. */
export const FOOTAGE_MOTION_CATEGORY = 'footage' as const

/** Every group a camera move may claim, still or footage. */
export type MotionCategory = SceneMotionCategory | typeof FOOTAGE_MOTION_CATEGORY

/** Picker groups for overlays. App-owned for the same reason. */
export const OVERLAY_CATEGORIES = ['light', 'texture', 'framing', 'title', 'brand'] as const
export type OverlayCategory = (typeof OVERLAY_CATEGORIES)[number]

/**
 * The user-facing wrapper around one built-in document. This is also the shape
 * a content pack item carries: `'scene-effect'` and `'overlay'` were added to
 * `ContentPackItemKindSchema` in v1.2.1, and the pack loader produces exactly
 * this record so a pack entry and a built-in are interchangeable everywhere
 * downstream except in their `origin`.
 */
export interface SceneEffectDescriptor<TDoc> {
  id: string
  name: string
  /** One line, shown under the name in the picker. */
  description: string
  /** Grouping for the picker. */
  category: string
  /**
   * Honest note about what FFmpeg cannot render exactly, shown in the UI.
   * An effect that quietly renders something other than its name is worse than
   * one that says what it actually does.
   */
  approximation?: string
  document: TDoc
}

export type SceneMotionEntry = SceneEffectDescriptor<SceneMotionDocument>
export type SceneOverlayEntry = SceneEffectDescriptor<SceneOverlayDocument>

// ═══════════════════════════════════════════════════════════════════════════
// Normalisation — lenient, for data already on the customer's disk
// ═══════════════════════════════════════════════════════════════════════════

function num(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (typeof value === 'string' && (allowed as readonly string[]).includes(value)) ? value as T : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

const HEX = /^#[0-9a-fA-F]{6}$/

export function pickHex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const bare = value.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(bare)) return `#${bare.split('').map(c => c + c).join('').toUpperCase()}`
  if (/^[0-9a-fA-F]{6}$/.test(bare)) return `#${bare.toUpperCase()}`
  return fallback
}

function nullableHex(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (value === undefined) return fallback
  const resolved = pickHex(value, '')
  return resolved || fallback
}

function text(value: unknown, max: number, fallback: string): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback
}

/**
 * An FFmpeg colour word or `#RRGGBB`. Anything else falls back, because a
 * colour the customer never chose is better than a filtergraph parse error.
 */
export function pickFfmpegColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (HEX.test(trimmed)) return trimmed.toUpperCase()
  if (/^[a-zA-Z]{3,24}$/.test(trimmed)) return trimmed.toLowerCase()
  return fallback
}

function normalizeTiming(value: any, d: OverlayTiming): OverlayTiming {
  const v = value || {}
  const start = num(v.start_sec, 0, 86400, d.start_sec)
  const rawEnd = v.end_sec
  if (rawEnd === null || rawEnd === undefined) return { start_sec: start, end_sec: d.end_sec === null ? null : d.end_sec }
  const end = num(rawEnd, 0, 86400, start)
  // An end before the start would compile to a window that never opens.
  return { start_sec: start, end_sec: end < start ? null : end }
}

/** Upgrade / clamp any stored motion document. Never throws. */
export function normalizeSceneMotion(input: unknown): SceneMotionDocument {
  const d = defaultSceneMotion()
  if (!input || typeof input !== 'object') return d
  const s = input as any
  const framing = s.framing || {}
  const zoom = s.zoom || {}
  const pan = s.pan || {}
  const spin = s.spin || {}
  const fade = s.fade || {}
  const focus = s.focus || {}
  const rawStages: any[] = Array.isArray(focus.stages) ? focus.stages : d.focus.stages
  return {
    schema_version: SCENE_EFFECT_SCHEMA_VERSION,
    source: pickEnum(s.source, MOTION_SOURCES, d.source),
    framing: { source_scale_pct: num(framing.source_scale_pct, 100, 400, d.framing.source_scale_pct) },
    zoom: {
      mode: pickEnum(zoom.mode, MOTION_ZOOM_MODES, d.zoom.mode),
      fixed_pct: num(zoom.fixed_pct, 100, 400, d.zoom.fixed_pct),
      from_pct: num(zoom.from_pct, 10, 400, d.zoom.from_pct),
      to_pct: num(zoom.to_pct, 10, 400, d.zoom.to_pct),
      base_pct: num(zoom.base_pct, 100, 400, d.zoom.base_pct),
      amplitude_pct: num(zoom.amplitude_pct, 0, 100, d.zoom.amplitude_pct),
    },
    pan: {
      mode: pickEnum(pan.mode, MOTION_PAN_MODES, d.pan.mode),
      x: num(pan.x, -400, 400, d.pan.x),
      y: num(pan.y, -400, 400, d.pan.y),
      rate_unit: pickEnum(pan.rate_unit, MOTION_RATE_UNITS, d.pan.rate_unit),
    },
    spin: { rate_rad_per_sec: num(spin.rate_rad_per_sec, -1, 1, d.spin.rate_rad_per_sec) },
    fade: {
      in: bool(fade.in, d.fade.in),
      out: bool(fade.out, d.fade.out),
      max_sec: num(fade.max_sec, 0, 10, d.fade.max_sec),
      share_of_clip: num(fade.share_of_clip, 0, 0.5, d.fade.share_of_clip),
    },
    focus: {
      stages: rawStages
        .filter(stage => stage && typeof stage === 'object')
        .slice(0, 8)
        .map(stage => ({
          sigma: num(stage.sigma, 0, 50, 0),
          until_share: num(stage.until_share, 0, 1, 1),
        })),
    },
  }
}

/** Deep-merge a partial patch (a preset body) onto a full motion document. */
export function mergeSceneMotion(base: SceneMotionDocument, patch: SceneMotionPatch | null | undefined): SceneMotionDocument {
  if (!patch) return base
  return normalizeSceneMotion({
    schema_version: SCENE_EFFECT_SCHEMA_VERSION,
    source: patch.source ?? base.source,
    framing: { ...base.framing, ...(patch.framing || {}) },
    zoom: { ...base.zoom, ...(patch.zoom || {}) },
    pan: { ...base.pan, ...(patch.pan || {}) },
    spin: { ...base.spin, ...(patch.spin || {}) },
    fade: { ...base.fade, ...(patch.fade || {}) },
    focus: { ...base.focus, ...(patch.focus || {}) },
  })
}

/** Upgrade / clamp any stored overlay document. Never throws. */
export function normalizeSceneOverlay(input: unknown): SceneOverlayDocument {
  const s = (input && typeof input === 'object' ? input : {}) as any
  const kind = pickEnum(s.kind, OVERLAY_KINDS, 'vignette')
  const d = defaultSceneOverlay(kind)
  const timing = normalizeTiming(s.timing, d.timing)
  switch (d.kind) {
    case 'vignette':
      return { ...d, timing, intensity: num(s.intensity, 0, 1, d.intensity) }
    case 'film-grain':
      return {
        ...d, timing,
        amount: num(s.amount, 0, 100, d.amount),
        temporal: bool(s.temporal, d.temporal),
        uniform: bool(s.uniform, d.uniform),
      }
    case 'light-leak':
      return {
        ...d, timing,
        color_hex: pickHex(s.color_hex, d.color_hex),
        intensity: num(s.intensity, 0, 1, d.intensity),
        softness: num(s.softness, 0, 1, d.softness),
        from_anchor: pickEnum(s.from_anchor, OVERLAY_ANCHORS, d.from_anchor),
        to_anchor: pickEnum(s.to_anchor, OVERLAY_ANCHORS, d.to_anchor),
        blend: pickEnum(s.blend, LEAK_BLENDS, d.blend),
      }
    case 'letterbox':
      return {
        ...d, timing,
        ratio: pickEnum(s.ratio, LETTERBOX_RATIOS, d.ratio),
        bar_share: num(s.bar_share, 0, 0.4, d.bar_share),
        color: pickFfmpegColor(s.color, d.color),
      }
    case 'lower-third':
      return {
        ...d, timing,
        title: text(s.title, 200, d.title),
        subtitle: text(s.subtitle, 200, d.subtitle),
        font_family: text(s.font_family, 120, d.font_family) || d.font_family,
        title_size_px: num(s.title_size_px, 8, 200, d.title_size_px),
        subtitle_size_px: num(s.subtitle_size_px, 8, 200, d.subtitle_size_px),
        title_color_hex: pickHex(s.title_color_hex, d.title_color_hex),
        subtitle_color_hex: nullableHex(s.subtitle_color_hex, d.subtitle_color_hex),
        bar: bool(s.bar, d.bar),
        bar_color_hex: pickHex(s.bar_color_hex, d.bar_color_hex),
        bar_opacity: num(s.bar_opacity, 0, 1, d.bar_opacity),
        padding_px: num(s.padding_px, 0, 200, d.padding_px),
        anchor: pickEnum(s.anchor, OVERLAY_ANCHORS, d.anchor),
        margin_px: num(s.margin_px, 0, 400, d.margin_px),
        fade_in_ms: num(s.fade_in_ms, 0, 3000, d.fade_in_ms),
        fade_out_ms: num(s.fade_out_ms, 0, 3000, d.fade_out_ms),
      }
    case 'corner-logo':
      return {
        ...d, timing,
        image_path: text(s.image_path, 1024, d.image_path),
        anchor: pickEnum(s.anchor, OVERLAY_ANCHORS, d.anchor),
        margin_px: num(s.margin_px, 0, 400, d.margin_px),
        width_pct: num(s.width_pct, 0.01, 1, d.width_pct),
        opacity: num(s.opacity, 0, 1, d.opacity),
      }
    case 'gradient-scrim':
      return {
        ...d, timing,
        edge: pickEnum(s.edge, SCRIM_EDGES, d.edge),
        color_hex: pickHex(s.color_hex, d.color_hex),
        opacity: num(s.opacity, 0, 1, d.opacity),
        coverage: num(s.coverage, 0.02, 1, d.coverage),
        steps: Math.round(num(s.steps, 2, 64, d.steps)),
      }
  }
}

/** Merge a partial overlay patch onto the default for its kind. */
export function mergeSceneOverlay(kind: OverlayKind, patch: Record<string, unknown> | null | undefined): SceneOverlayDocument {
  const base = defaultSceneOverlay(kind)
  if (!patch) return base
  return normalizeSceneOverlay({ ...base, ...patch, kind })
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy adapter — the flat `VideoSceneAnimation` shape on disk today
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Which fields of the legacy flat `VideoSceneAnimation` a built-in motion
 * honours. v1.0 wired these per animation type by hand; expressing it as an
 * enum on the registry entry keeps the branch out of the compiler, which never
 * sees anything but a finished document.
 *
 *   - `none`         — the move ignores the legacy params entirely (every
 *                      fixed-magnitude zoom and pan did).
 *   - `zoom`         — `zoom_start` / `zoom_end` drive the ramp.
 *   - `zoom-reversed`— the same two, applied end-to-start.
 *   - `parallax`     — `parallax_direction` / `parallax_speed` drive the pan.
 *   - `breathe`      — `breathe_base_zoom` / `breathe_amplitude` drive the sine.
 */
export const LEGACY_MOTION_BINDINGS = ['none', 'zoom', 'zoom-reversed', 'parallax', 'breathe'] as const
export type LegacyMotionBinding = (typeof LEGACY_MOTION_BINDINGS)[number]

/** The legacy flat animation params, as every project on disk holds them. */
export interface LegacySceneAnimationParams {
  zoom_start?: number
  zoom_end?: number
  parallax_direction?: 'left' | 'right' | 'up' | 'down'
  parallax_speed?: number
  breathe_amplitude?: number
  breathe_base_zoom?: number
}

/**
 * Apply the legacy params to a built-in motion document.
 *
 * v1.0 read every one of these through `||`, so a stored ZERO fell back to the
 * built-in default rather than meaning "none". That is preserved deliberately:
 * projects on disk were authored against it, and changing it would silently
 * restyle finished episodes.
 */
export function applyLegacyMotionParams(
  document: SceneMotionDocument,
  binding: LegacyMotionBinding,
  params: LegacySceneAnimationParams | null | undefined,
): SceneMotionDocument {
  const p = params || {}
  switch (binding) {
    case 'none':
      return document
    case 'zoom':
      return mergeSceneMotion(document, {
        zoom: { from_pct: p.zoom_start || 100, to_pct: p.zoom_end || 108 },
      })
    case 'zoom-reversed':
      return mergeSceneMotion(document, {
        zoom: { from_pct: p.zoom_end || 108, to_pct: p.zoom_start || 100 },
      })
    case 'parallax': {
      const speed = p.parallax_speed || 2
      const dir = p.parallax_direction || 'right'
      const x = dir === 'left' ? -speed : dir === 'right' ? speed : 0
      const y = dir === 'up' ? -speed : dir === 'down' ? speed : 0
      return mergeSceneMotion(document, { pan: { x, y } })
    }
    case 'breathe':
      return mergeSceneMotion(document, {
        zoom: {
          base_pct: p.breathe_base_zoom || document.zoom.base_pct,
          amplitude_pct: p.breathe_amplitude || document.zoom.amplitude_pct,
        },
      })
  }
}
