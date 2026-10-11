/**
 * Strict validation for scene-effect documents.
 *
 * Separate from `contracts/scene-effects.ts` on purpose: that module is
 * dependency-free so the pickers can import its defaults, registries and
 * normalisers as VALUES without pulling zod into the browser bundle. This
 * module is the backend / content-pack side, and it is deliberately strict
 * where the normaliser is deliberately lenient:
 *
 *   - `normalizeSceneMotion()` / `normalizeSceneOverlay()` run against data
 *     already on the customer's disk. Refusing to load is never the right
 *     answer there, so they clamp and fall back.
 *   - `parseSceneMotionDocument()` / `parseSceneOverlayDocument()` run against
 *     NEW input — an API body, a downloaded content pack. Unknown fields are
 *     rejected BY NAME, because an effect authored for a newer engine must fail
 *     loudly rather than render something the author never designed.
 *
 * Written in the same idiom as `content-packs/schemas.ts` and
 * `contracts/subtitle-style-schema.ts`: `.strict()` objects, bounded numbers,
 * enums pulled from the shared constant arrays so the schema and the TypeScript
 * union can never drift.
 */

import { z } from 'zod'
import { LOOP_VARIANTS } from './effect-loops.js'
import {
  COLOR_GRADE_PRESETS,
  LEAK_BLENDS,
  LETTERBOX_MODES,
  LETTERBOX_RATIOS,
  LIVING_MOTIONS,
  OUTLINE_MASK_NAME,
  REGION_MAX_POINTS,
  REGION_MAX_SHAPES,
  MOTION_PAN_MODES,
  MOTION_RATE_UNITS,
  MOTION_SOURCES,
  MOTION_ZOOM_MODES,
  OVERLAY_ANCHORS,
  SCENE_EFFECT_SCHEMA_VERSION,
  SCRIM_EDGES,
  normalizeSceneMotion,
  normalizeSceneOverlay,
  type SceneMotionDocument,
  type SceneOverlayDocument,
} from './scene-effects.js'

/** Anything a text renderer or a path parser has no business receiving. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a #RRGGBB colour')
const opacity = z.number().min(0).max(1)

/**
 * An FFmpeg colour: `#RRGGBB`, or one of its named colours. Named colours are
 * bounded to plain letters so a colour string can never become filtergraph
 * syntax.
 */
const ffmpegColor = z.string().regex(/^(#[0-9A-Fa-f]{6}|[a-zA-Z]{3,24})$/, 'must be #RRGGBB or a colour name')

/**
 * Text drawn into the picture. Filtergraph metacharacters are escaped at
 * compile time, but a newline or a control character has no legitimate use in a
 * lower third and would survive escaping as a layout surprise.
 */
const drawableText = (max: number) =>
  z.string().max(max).refine(v => !CONTROL_CHARS.test(v), 'must not contain control characters')

// ── Motion ──────────────────────────────────────────────────────────────────

export const SceneMotionFramingSchema = z.object({
  source_scale_pct: z.number().min(100).max(400),
}).strict()

export const SceneMotionZoomSchema = z.object({
  mode: z.enum(MOTION_ZOOM_MODES),
  fixed_pct: z.number().min(100).max(400),
  from_pct: z.number().min(10).max(400),
  to_pct: z.number().min(10).max(400),
  base_pct: z.number().min(100).max(400),
  amplitude_pct: z.number().min(0).max(100),
}).strict()

export const SceneMotionPanSchema = z.object({
  mode: z.enum(MOTION_PAN_MODES),
  x: z.number().min(-400).max(400),
  y: z.number().min(-400).max(400),
  rate_unit: z.enum(MOTION_RATE_UNITS),
}).strict()

export const SceneMotionSpinSchema = z.object({
  rate_rad_per_sec: z.number().min(-1).max(1),
}).strict()

export const SceneMotionFadeSchema = z.object({
  in: z.boolean(),
  out: z.boolean(),
  max_sec: z.number().min(0).max(10),
  share_of_clip: z.number().min(0).max(0.5),
}).strict()

export const SceneMotionFocusSchema = z.object({
  stages: z.array(z.object({
    sigma: z.number().min(0).max(50),
    until_share: z.number().min(0).max(1),
  }).strict()).max(8),
}).strict().superRefine((focus, ctx) => {
  // A stage list that goes backwards would emit a `between(t,a,b)` with b < a,
  // which never fires — the blur would silently vanish partway through.
  for (let i = 1; i < focus.stages.length; i++) {
    if (focus.stages[i]!.until_share <= focus.stages[i - 1]!.until_share) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', i, 'until_share'],
        message: 'focus stages must run forwards in time',
      })
    }
  }
})

export const SceneMotionDocumentSchema = z.object({
  schema_version: z.literal(SCENE_EFFECT_SCHEMA_VERSION),
  source: z.enum(MOTION_SOURCES),
  framing: SceneMotionFramingSchema,
  zoom: SceneMotionZoomSchema,
  pan: SceneMotionPanSchema,
  spin: SceneMotionSpinSchema,
  fade: SceneMotionFadeSchema,
  focus: SceneMotionFocusSchema,
  float: z.object({
    amplitude_pct: z.number().min(0).max(2),
    period_sec: z.number().min(3).max(30),
    seed: z.number().int().min(0).max(2 ** 31 - 1),
  }).strict().optional(),
}).strict().superRefine((doc, ctx) => {
  if (doc.source !== 'footage') return
  // The footage engine builds ONE crop window. A zoom animates the window's
  // scale and a traverse animates its position; doing both would need two
  // conflicting `scale` steps, so the compiler would have to silently drop one.
  if (doc.zoom.mode !== 'none' && doc.pan.mode !== 'none') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a footage motion cannot both zoom and pan — the crop window can only do one',
    })
  }
  if (doc.pan.mode === 'rate') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pan', 'mode'],
      message: 'a footage motion pans by traverse, not by rate — it knows its slack up front',
    })
  }
  if (doc.spin.rate_rad_per_sec !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['spin', 'rate_rad_per_sec'],
      message: 'the footage engine has no rotation stage',
    })
  }
})

// ── Overlay ─────────────────────────────────────────────────────────────────

const TimingSchema = z.object({
  start_sec: z.number().min(0).max(86400),
  end_sec: z.number().min(0).max(86400).nullable(),
  // Optional so every document written before fades existed still validates.
  fade_in_sec: z.number().min(0).max(60).optional(),
  fade_out_sec: z.number().min(0).max(60).optional(),
}).strict().superRefine((timing, ctx) => {
  if (timing.end_sec !== null && timing.end_sec < timing.start_sec) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_sec'], message: 'must not end before it starts' })
  }
})

const share = z.number().min(0).max(1)

/** 1.4.284 — an outline of one scene's picture: an uploaded mask, or shapes in 0..1 coordinates. */
export const SceneRegionSchema = z.object({
  mask: z.string().regex(OUTLINE_MASK_NAME, 'must be the name of an uploaded outline, e.g. "s4-window.png"').optional(),
  shapes: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('ellipse'), cx: share, cy: share, rx: share, ry: share }).strict(),
    z.object({ type: z.literal('rect'), x: share, y: share, w: share, h: share }).strict(),
    z.object({ type: z.literal('polygon'), points: z.array(z.tuple([share, share])).min(3).max(REGION_MAX_POINTS) }).strict(),
  ])).max(REGION_MAX_SHAPES).optional(),
  feather_px: z.number().min(0).max(80).optional(),
}).strict().refine(r => !!r.mask || !!r.shapes?.length, 'an outline needs a mask image or at least one shape')

const overlayBase = {
  schema_version: z.literal(SCENE_EFFECT_SCHEMA_VERSION),
  timing: TimingSchema,
  region: SceneRegionSchema.optional(),
}

export const VignetteOverlaySchema = z.object({
  kind: z.literal('vignette'),
  ...overlayBase,
  intensity: opacity,
}).strict()

export const FilmGrainOverlaySchema = z.object({
  kind: z.literal('film-grain'),
  ...overlayBase,
  amount: z.number().min(0).max(100),
  temporal: z.boolean(),
  uniform: z.boolean(),
}).strict()

export const LightLeakOverlaySchema = z.object({
  kind: z.literal('light-leak'),
  ...overlayBase,
  color_hex: hex,
  intensity: opacity,
  softness: opacity,
  from_anchor: z.enum(OVERLAY_ANCHORS),
  to_anchor: z.enum(OVERLAY_ANCHORS),
  blend: z.enum(LEAK_BLENDS),
}).strict()

export const LetterboxOverlaySchema = z.object({
  kind: z.literal('letterbox'),
  ...overlayBase,
  ratio: z.enum(LETTERBOX_RATIOS),
  bar_share: z.number().min(0).max(0.4),
  color: ffmpegColor,
  mode: z.enum(LETTERBOX_MODES).default('fit'),
}).strict()

export const LowerThirdOverlaySchema = z.object({
  kind: z.literal('lower-third'),
  ...overlayBase,
  title: drawableText(200),
  subtitle: drawableText(200),
  font_family: z.string().min(1).max(120),
  title_size_px: z.number().min(8).max(200),
  subtitle_size_px: z.number().min(8).max(200),
  title_color_hex: hex,
  subtitle_color_hex: hex.nullable(),
  bar: z.boolean(),
  bar_color_hex: hex,
  bar_opacity: opacity,
  padding_px: z.number().min(0).max(200),
  anchor: z.enum(OVERLAY_ANCHORS),
  margin_px: z.number().min(0).max(400),
  fade_in_ms: z.number().min(0).max(3000),
  fade_out_ms: z.number().min(0).max(3000),
}).strict()

export const CornerLogoOverlaySchema = z.object({
  kind: z.literal('corner-logo'),
  ...overlayBase,
  /**
   * A filesystem path. Escaped at compile time, but a path carrying a newline
   * or a NUL has no legitimate form and is refused outright rather than
   * escaped into something that merely parses.
   */
  image_path: z.string().max(1024).refine(v => !CONTROL_CHARS.test(v), 'must not contain control characters'),
  anchor: z.enum(OVERLAY_ANCHORS),
  margin_px: z.number().min(0).max(400),
  width_pct: z.number().min(0.01).max(1),
  opacity,
}).strict()

export const GradientScrimOverlaySchema = z.object({
  kind: z.literal('gradient-scrim'),
  ...overlayBase,
  edge: z.enum(SCRIM_EDGES),
  color_hex: hex,
  opacity,
  coverage: z.number().min(0.02).max(1),
  steps: z.number().int().min(2).max(64),
}).strict()

const unit = z.number().min(0).max(1)
const seed = z.number().int().min(0).max(2 ** 31 - 1)

export const AtmosphereLoopOverlaySchema = z.object({
  kind: z.literal('atmosphere-loop'),
  ...overlayBase,
  variant: z.enum(LOOP_VARIANTS),
  amount: z.number().min(0).max(100),
  size: z.number().min(0.25).max(4),
  speed: z.number().min(0.25).max(4),
  wind_deg: z.number().min(-45).max(45),
  sway: unit,
  layers: z.number().int().min(1).max(3),
  twinkle: unit,
  region_top: unit,
  region_bottom: unit,
  scale: z.number().min(0.25).max(4),
  beam: unit,
  seed,
  loop_sec: z.number().min(1).max(30),
  color_hex: hex,
  secondary_color_hex: hex.nullable(),
  opacity,
  darken: z.number().min(0).max(0.5),
}).strict()

export const BloomOverlaySchema = z.object({
  kind: z.literal('bloom'),
  ...overlayBase,
  threshold: unit,
  strength: unit,
  radius_px: z.number().min(1).max(80),
  color_hex: hex.optional(),
}).strict()

export const FlickerOverlaySchema = z.object({
  kind: z.literal('flicker'),
  ...overlayBase,
  amount: z.number().min(0).max(0.3),
  speed: z.number().min(0.1).max(4),
}).strict()

export const LightningOverlaySchema = z.object({
  kind: z.literal('lightning'),
  ...overlayBase,
  strength: unit,
  period_sec: z.number().min(2).max(300),
  chance: unit,
  seed,
}).strict()

export const HeatShimmerOverlaySchema = z.object({
  kind: z.literal('heat-shimmer'),
  ...overlayBase,
  strength_px: z.number().min(0).max(16),
  scale: z.number().min(0.25).max(4),
  speed: z.number().min(0.25).max(4),
  region_top: unit,
  region_bottom: unit,
  seed,
}).strict()

export const ColorGradeOverlaySchema = z.object({
  kind: z.literal('color-grade'),
  ...overlayBase,
  preset: z.enum(COLOR_GRADE_PRESETS),
  brightness: z.number().min(-1).max(1),
  contrast: z.number().min(0).max(3),
  saturation: z.number().min(0).max(3),
  warmth: z.number().min(-1).max(1),
  tint: z.number().min(-1).max(1),
}).strict()

export const LivingRegionOverlaySchema = z.object({
  kind: z.literal('living-region'),
  ...overlayBase,
  motion: z.enum(LIVING_MOTIONS),
  strength: z.number().min(0).max(3),
  speed: z.number().min(0.25).max(4),
  outline: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be an outline name such as "fire" or "window"').max(40).optional(),
}).strict()

export const ShootingStarOverlaySchema = z.object({
  kind: z.literal('shooting-star'),
  ...overlayBase,
  color_hex: hex,
  opacity,
  size: z.number().min(0.5).max(2),
  period_sec: z.number().min(4).max(600),
  chance: unit,
  seed,
  region_top: unit,
  region_bottom: unit,
}).strict()

export const BedtimeDimmingOverlaySchema = z.object({
  kind: z.literal('bedtime-dimming'),
  ...overlayBase,
  darken_pct: z.number().min(0).max(50),
  warmth_pct: z.number().min(0).max(100),
  desaturate_pct: z.number().min(0).max(30),
  start_pct: z.number().min(0).max(99),
  full_pct: z.number().min(1).max(100),
}).strict()

export const SceneOverlayDocumentSchema = z.discriminatedUnion('kind', [
  VignetteOverlaySchema,
  FilmGrainOverlaySchema,
  LightLeakOverlaySchema,
  LetterboxOverlaySchema,
  LowerThirdOverlaySchema,
  CornerLogoOverlaySchema,
  GradientScrimOverlaySchema,
  AtmosphereLoopOverlaySchema,
  BloomOverlaySchema,
  FlickerOverlaySchema,
  LightningOverlaySchema,
  HeatShimmerOverlaySchema,
  ColorGradeOverlaySchema,
  LivingRegionOverlaySchema,
  ShootingStarOverlaySchema,
  BedtimeDimmingOverlaySchema,
])

// ── Errors ──────────────────────────────────────────────────────────────────

export class SceneEffectValidationError extends Error {
  /** Bad input: running the job again stops here again, so no automatic retry (services/job-retry-policy.ts isNonRetryableError). */
  readonly retryable = false
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`Scene effect is not valid: ${issues.join('; ')}`)
    this.name = 'SceneEffectValidationError'
    this.issues = issues
  }
}

/**
 * Turn a zod issue list into messages that NAME the offending field, so an
 * effect built for a newer engine says which key it used rather than
 * "invalid input".
 */
function describe(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const at = issue.path.length ? issue.path.join('.') : '(root)'
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as z.ZodIssue & { keys: string[] }).keys
      return `unknown field${keys.length === 1 ? '' : 's'} ${keys.map(k => `"${at === '(root)' ? k : `${at}.${k}`}"`).join(', ')}`
        + ' — this effect was authored for a newer engine'
    }
    return `${at}: ${issue.message}`
  })
}

/** Validate a COMPLETE motion document. One message per problem. */
export function parseSceneMotionDocument(input: unknown): SceneMotionDocument {
  const result = SceneMotionDocumentSchema.safeParse(input)
  if (!result.success) throw new SceneEffectValidationError(describe(result.error))
  // Clamp-and-canonicalise so a validated document and a normalised one are
  // the same object shape.
  return normalizeSceneMotion(result.data)
}

/** Validate a COMPLETE overlay document. */
export function parseSceneOverlayDocument(input: unknown): SceneOverlayDocument {
  const result = SceneOverlayDocumentSchema.safeParse(input)
  if (!result.success) throw new SceneEffectValidationError(describe(result.error))
  return normalizeSceneOverlay(result.data)
}
