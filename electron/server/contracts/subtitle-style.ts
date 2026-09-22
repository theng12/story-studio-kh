/**
 * Subtitle style document — the declarative caption look shared by the
 * renderer, the preview endpoint, the properties panel and (later) content
 * packs.
 *
 * ZERO RUNTIME DEPENDENCIES ON PURPOSE. The renderer imports this module as
 * a VALUE (defaults + presets + normaliser), so it must not drag zod into
 * the browser bundle — see the note at the top of `contracts/index.ts`. The
 * strict zod validator lives next door in `contracts/subtitle-style-schema.ts`
 * and is imported by the backend only.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 *
 * 1. **A style is data.** No functions, no expressions, no code. Everything a
 *    caption can look like is a named field with a documented range and a
 *    default; the engine (`lib/subtitle-builder.ts`) is the only thing that
 *    knows how to turn those fields into ASS override tags. This is what makes
 *    a style shippable as a content pack — packs may never carry executable
 *    content, so anything the engine cannot do from plain data can never ship.
 *
 * 2. **Pixel values mean "pixels at a 1920x1080 reference frame."** Every
 *    `_px` field below is interpreted at that reference and scaled by
 *    outputHeight/1080 at render time. A 640x360 preview and a 1080p burn
 *    therefore agree on relative size — that agreement is a tested property.
 *
 * 3. **`schema_version` is required on a v2 document.** A document that
 *    carries it is validated strictly (unknown fields are rejected by name).
 *    A document that does NOT carry it is a legacy flat `VideoSubtitleStyle`
 *    and is upgraded by `normalizeSubtitleStyle()` with byte-identical
 *    rendering output. Every project on disk and every saved preset today
 *    holds the legacy shape, so that path is permanent, not transitional.
 *
 * 4. **Nullable means "inherit", never "unset".** A handful of fields default
 *    to `null` because their honest default is another field's value
 *    (`word.inactive_color_hex` follows the primary colour) or a libass
 *    coupling (`box.padding_px` follows the outline width, because with an
 *    opaque box libass reuses the Outline value as the box padding). Writing a
 *    number there overrides the inheritance.
 */

export const SUBTITLE_STYLE_SCHEMA_VERSION = 2 as const

/** Reference frame every `_px` field is expressed against. */
export const SUBTITLE_REFERENCE_HEIGHT = 1080

/**
 * Opacity that round-trips to ASS alpha byte 0x80 — the value the v1 engine
 * hardcoded for the "semi" backdrop. `1 - 128/255`, not `0.5`.
 */
export const SEMI_BOX_OPACITY = 1 - 128 / 255

// ── Enumerations ────────────────────────────────────────────────────────────

export const SUBTITLE_BOX_MODES = ['none', 'semi', 'full', 'rounded'] as const
export type SubtitleBoxMode = (typeof SUBTITLE_BOX_MODES)[number]

export const SUBTITLE_VERTICAL_POSITIONS = ['top', 'center', 'bottom'] as const
export type SubtitleVerticalPosition = (typeof SUBTITLE_VERTICAL_POSITIONS)[number]

export const SUBTITLE_ALIGNMENTS = ['left', 'center', 'right'] as const
export type SubtitleAlignment = (typeof SUBTITLE_ALIGNMENTS)[number]

/**
 * How lines are broken.
 *   - `engine`      — Story Studio wraps at `max_chars_per_line` and libass is
 *                     told not to re-wrap (ASS WrapStyle 2). The default, and
 *                     the only mode in which `max_chars_per_line` /
 *                     `max_lines` mean anything.
 *   - `balanced`    — libass wraps inside the margins, upper line wider (0).
 *   - `bottom-wider`— libass wraps inside the margins, lower line wider (3).
 *   - `end-of-line` — libass wraps only at the right margin (1).
 */
export const SUBTITLE_WRAP_STYLES = ['engine', 'balanced', 'bottom-wider', 'end-of-line'] as const
export type SubtitleWrapStyle = (typeof SUBTITLE_WRAP_STYLES)[number]

/** Whole-cue entrance/exit animation. The first four are the v1 vocabulary. */
export const SUBTITLE_CUE_ANIMATIONS = ['none', 'fade', 'pop', 'slide-up', 'slide-down'] as const
export type SubtitleCueAnimation = (typeof SUBTITLE_CUE_ANIMATIONS)[number]

/**
 * Word-level behaviour.
 *   - `off`        — the whole cue appears at once. v1 behaviour.
 *   - `highlight`  — the whole cue is visible; the active word swaps colour.
 *   - `pop`        — `highlight`, and the active word also scales up and back.
 *   - `reveal`     — words fade in one at a time and stay.
 *   - `single`     — exactly one word on screen at a time.
 *   - `typewriter` — like `reveal` but with an instant, un-eased appearance.
 */
export const SUBTITLE_WORD_MODES = ['off', 'highlight', 'pop', 'reveal', 'single', 'typewriter'] as const
export type SubtitleWordMode = (typeof SUBTITLE_WORD_MODES)[number]

// ── Document ────────────────────────────────────────────────────────────────

export interface SubtitleTypography {
  /** Any face libass can resolve through fontconfig. */
  font_family: string
  /** 8-200 px at the 1080 reference. */
  font_size_px: number
  bold: boolean
  italic: boolean
  /** ASS `Spacing` / `\fsp`. -20..60 px at the 1080 reference. */
  letter_spacing_px: number
  /**
   * Extra gap between wrapped lines, 0..80 px at the 1080 reference.
   * libass has NO line-spacing property, so this is emulated by inserting a
   * spacer line at the requested height between wrapped lines. Only positive
   * values are possible, and with an opaque box the spacer picks up a box
   * strip of its own. Default 0 emits nothing at all.
   */
  line_spacing_px: number
  /** Uppercase the caption text before rendering. */
  all_caps: boolean
  /** Wrap target, 8-120. Only meaningful when `wrap_style` is `engine`. */
  max_chars_per_line: number
  /** 1-6. Cues longer than this are SPLIT across the cue window, never cut. */
  max_lines: number
  wrap_style: SubtitleWrapStyle
}

/** `#RRGGBB` plus an independent 0..1 opacity, because ASS keeps them apart. */
export interface SubtitleColors {
  primary_hex: string
  primary_opacity: number
  /**
   * ASS SecondaryColour. Unused by the engine's own word modes (which drive
   * colour through `\t` transforms rather than karaoke), but it is part of the
   * ASS style line and a pack may want it set. `null` follows `primary_hex`.
   */
  secondary_hex: string | null
  secondary_opacity: number
  outline_hex: string
  outline_opacity: number
  shadow_hex: string
  shadow_opacity: number
  /** Box / backdrop fill. Used by box modes `semi`, `full` and `rounded`. */
  box_hex: string
  box_opacity: number
}

export interface SubtitleBox {
  /**
   *   - `none`    — no backdrop (ASS BorderStyle 1).
   *   - `semi`    — translucent box (BorderStyle 3, box opacity as given).
   *   - `full`    — opaque box (BorderStyle 3).
   *   - `rounded` — APPROXIMATION. libass cannot round an opaque box, so this
   *                 draws a thick round-joined outline in the box colour
   *                 instead, which reads as a soft blob hugging the glyphs
   *                 rather than a rectangle. The text keeps no separate
   *                 outline in this mode.
   */
  mode: SubtitleBoxMode
  /**
   * Box padding, 0..80 px at the 1080 reference. `null` follows the outline
   * width — that is libass's own behaviour, since with BorderStyle 3 the ASS
   * `Outline` value IS the box padding.
   */
  padding_px: number | null
  /** Corner radius for `rounded`, 0..60 px at the 1080 reference. */
  corner_radius_px: number
}

export interface SubtitleEdge {
  /** Stroke width, 0..40 px at the 1080 reference. */
  outline_px: number
  /** ASS `Shadow` depth, 0..40 px at the 1080 reference. */
  shadow_px: number
  /** `\xshad` override, -40..40 px. 0 leaves the depth-driven diagonal shadow. */
  shadow_offset_x_px: number
  /** `\yshad` override, -40..40 px. 0 leaves the depth-driven diagonal shadow. */
  shadow_offset_y_px: number
  /** `\blur`, 0..20. Softens outline AND shadow — that is what libass does. */
  blur_px: number
}

export interface SubtitlePlacement {
  position: SubtitleVerticalPosition
  align: SubtitleAlignment
  /** Precise anchor as a percentage of the canvas; both must be set to apply. */
  position_x_pct: number | null
  position_y_pct: number | null
  /** Protected edge band, 5..20% of the frame. */
  safe_margin_pct: number
  /** ASS MarginL/R/V, 0..300 px at the 1080 reference. */
  margin_px: number
}

export interface SubtitleCueAnimationSettings {
  type: SubtitleCueAnimation
  /** Fade-in, 0..3000 ms. */
  in_ms: number
  /** Fade-out, 0..3000 ms. */
  out_ms: number
  /** Scale/travel easing duration, 0..3000 ms. Used by `pop`. */
  transform_ms: number
  /** Starting scale for `pop`, 10..200 %. */
  pop_from_pct: number
  /** Slide distance for `slide-up` / `slide-down`, 0..400 px at 1080. */
  travel_px: number
}

export interface SubtitleWordSettings {
  mode: SubtitleWordMode
  /** Colour of the word currently being spoken. */
  active_color_hex: string
  active_opacity: number
  /** Resting colour of the other words. `null` follows `color.primary_hex`. */
  inactive_color_hex: string | null
  inactive_opacity: number
  /** Active-word scale for `pop`, 100..300 %. */
  active_scale_pct: number
  /** Ease duration into and out of the active state, 0..1000 ms. */
  transition_ms: number
  /** Outline colour while active. `null` follows `color.outline_hex`. */
  active_outline_hex: string | null
  active_outline_opacity: number
  /**
   * Draw a filled block behind the active word (highlighter-pen look).
   * APPROXIMATION: libass has no per-word background, so this widens the
   * active word's outline to `highlight_box_px` in `highlight_box_hex`. The
   * result hugs the glyphs — a rounded blob, not a rectangle.
   */
  highlight_box: boolean
  highlight_box_hex: string
  highlight_box_opacity: number
  /** Blob thickness for `highlight_box`, 0..60 px at the 1080 reference. */
  highlight_box_px: number
}

export interface SubtitleStyleDocument {
  schema_version: typeof SUBTITLE_STYLE_SCHEMA_VERSION
  typography: SubtitleTypography
  color: SubtitleColors
  box: SubtitleBox
  edge: SubtitleEdge
  placement: SubtitlePlacement
  animation: SubtitleCueAnimationSettings
  word: SubtitleWordSettings
}

/** A partial document, as a preset or a pack may express it. */
export type SubtitleStylePatch = {
  [K in keyof Omit<SubtitleStyleDocument, 'schema_version'>]?: Partial<SubtitleStyleDocument[K]>
} & { schema_version?: number }

// ── Defaults ────────────────────────────────────────────────────────────────

/**
 * Per-animation timing defaults. These are the exact numbers the v1 engine
 * hardcoded, kept in one table so `normalizeSubtitleStyle` can reproduce v1
 * output byte-for-byte from a legacy style that names only the animation.
 */
export const CUE_ANIMATION_DEFAULTS: Record<SubtitleCueAnimation, Pick<SubtitleCueAnimationSettings, 'in_ms' | 'out_ms' | 'transform_ms' | 'pop_from_pct' | 'travel_px'>> = {
  none: { in_ms: 0, out_ms: 0, transform_ms: 0, pop_from_pct: 72, travel_px: 36 },
  fade: { in_ms: 180, out_ms: 180, transform_ms: 0, pop_from_pct: 72, travel_px: 36 },
  pop: { in_ms: 60, out_ms: 60, transform_ms: 150, pop_from_pct: 72, travel_px: 36 },
  'slide-up': { in_ms: 160, out_ms: 80, transform_ms: 0, pop_from_pct: 72, travel_px: 36 },
  'slide-down': { in_ms: 160, out_ms: 80, transform_ms: 0, pop_from_pct: 72, travel_px: 36 },
}

/** The shipped default look — Clean Broadcast, and the v1 default. */
export function defaultSubtitleStyle(): SubtitleStyleDocument {
  return {
    schema_version: SUBTITLE_STYLE_SCHEMA_VERSION,
    typography: {
      font_family: 'Helvetica',
      font_size_px: 28,
      bold: false,
      italic: false,
      letter_spacing_px: 0,
      line_spacing_px: 0,
      all_caps: false,
      max_chars_per_line: 42,
      max_lines: 2,
      wrap_style: 'engine',
    },
    color: {
      primary_hex: '#FFFFFF',
      primary_opacity: 1,
      secondary_hex: null,
      secondary_opacity: 1,
      outline_hex: '#000000',
      outline_opacity: 1,
      shadow_hex: '#000000',
      shadow_opacity: 1,
      box_hex: '#000000',
      box_opacity: 1,
    },
    box: { mode: 'none', padding_px: null, corner_radius_px: 12 },
    edge: { outline_px: 2, shadow_px: 0, shadow_offset_x_px: 0, shadow_offset_y_px: 0, blur_px: 0 },
    placement: {
      position: 'bottom',
      align: 'center',
      position_x_pct: null,
      position_y_pct: null,
      safe_margin_pct: 8,
      margin_px: 40,
    },
    animation: { type: 'none', ...CUE_ANIMATION_DEFAULTS.none },
    word: {
      mode: 'off',
      active_color_hex: '#FFD400',
      active_opacity: 1,
      inactive_color_hex: null,
      inactive_opacity: 1,
      active_scale_pct: 118,
      transition_ms: 90,
      active_outline_hex: null,
      active_outline_opacity: 1,
      highlight_box: false,
      highlight_box_hex: '#FFD400',
      highlight_box_opacity: 1,
      highlight_box_px: 14,
    },
  }
}

// ── Normalisation ───────────────────────────────────────────────────────────

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (typeof value === 'string' && (allowed as readonly string[]).includes(value)) ? value as T : fallback
}

const HEX = /^#[0-9a-fA-F]{6}$/

function pickHex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (HEX.test(trimmed)) return trimmed.toUpperCase()
  // Tolerate `#RGB` and a missing '#'; anything else falls back rather than
  // producing a colour the customer never chose.
  const bare = trimmed.replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(bare)) {
    return `#${bare.split('').map(c => c + c).join('').toUpperCase()}`
  }
  if (/^[0-9a-fA-F]{6}$/.test(bare)) return `#${bare.toUpperCase()}`
  return fallback
}

function pickNullableHex(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (value === undefined) return fallback
  const resolved = pickHex(value, '')
  return resolved || fallback
}

function pickNullableNumber(value: unknown, min: number, max: number, fallback: number | null): number | null {
  if (value === null) return null
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** The legacy flat style, as every project and saved preset on disk holds it. */
export interface LegacySubtitleStyle {
  font_family?: string
  font_size_px?: number
  color_hex?: string
  outline_color_hex?: string
  outline_px?: number
  background?: 'none' | 'semi' | 'full'
  position?: 'top' | 'center' | 'bottom'
  align?: 'left' | 'center' | 'right'
  position_x_pct?: number
  position_y_pct?: number
  safe_margin_pct?: number
  max_chars_per_line?: number
  max_lines?: number
  animation?: 'none' | 'fade' | 'pop' | 'slide-up'
}

function isV2(value: any): boolean {
  return !!value && typeof value === 'object' && typeof value.schema_version === 'number'
}

/**
 * Upgrade ANY stored subtitle style into a v2 document.
 *
 * A legacy flat object maps field-for-field, and every field the legacy shape
 * did not have takes a default chosen so the rendered ASS is byte-identical to
 * what the v1 engine produced (that equivalence is locked by golden fixtures
 * in `__tests__/subtitle-ass.test.ts`). A v2 object is clamped into range.
 *
 * Lenient by design — this runs against data already on the customer's disk,
 * where refusing to load is never the right answer. Strict validation with
 * unknown-field rejection is `parseSubtitleStyleDocument()` in
 * `contracts/subtitle-style-schema.ts`, and is for packs and API input.
 */
export function normalizeSubtitleStyle(input: unknown): SubtitleStyleDocument {
  const d = defaultSubtitleStyle()
  if (!input || typeof input !== 'object') return d
  return isV2(input) ? normalizeV2(input as any, d) : normalizeLegacy(input as LegacySubtitleStyle, d)
}

function normalizeLegacy(s: LegacySubtitleStyle, d: SubtitleStyleDocument): SubtitleStyleDocument {
  const animation = pickEnum(s.animation, SUBTITLE_CUE_ANIMATIONS, 'none')
  const hasPrecise = Number.isFinite(s.position_x_pct) && Number.isFinite(s.position_y_pct)
  const background = pickEnum(s.background, ['none', 'semi', 'full'] as const, 'none')
  return {
    ...d,
    typography: {
      ...d.typography,
      font_family: typeof s.font_family === 'string' && s.font_family ? s.font_family : d.typography.font_family,
      font_size_px: clampNumber(s.font_size_px, 8, 200, d.typography.font_size_px),
      max_chars_per_line: clampNumber(s.max_chars_per_line, 8, 120, d.typography.max_chars_per_line),
      max_lines: clampNumber(s.max_lines, 1, 6, d.typography.max_lines),
    },
    color: {
      ...d.color,
      primary_hex: pickHex(s.color_hex, d.color.primary_hex),
      outline_hex: pickHex(s.outline_color_hex, d.color.outline_hex),
      // v1 wrote BackColour &H80000000 for 'semi' and &H00000000 for 'full'.
      // ASS alpha 0x80 = 128/255 transparent, so the equivalent opacity is
      // 1 - 128/255 — NOT 0.5, which would round back out to 0x7F.
      box_opacity: background === 'semi' ? SEMI_BOX_OPACITY : 1,
    },
    box: { ...d.box, mode: background },
    edge: { ...d.edge, outline_px: clampNumber(s.outline_px, 0, 40, d.edge.outline_px) },
    placement: {
      ...d.placement,
      position: pickEnum(s.position, SUBTITLE_VERTICAL_POSITIONS, d.placement.position),
      align: pickEnum(s.align, SUBTITLE_ALIGNMENTS, d.placement.align),
      position_x_pct: hasPrecise ? Number(s.position_x_pct) : null,
      position_y_pct: hasPrecise ? Number(s.position_y_pct) : null,
      safe_margin_pct: clampNumber(s.safe_margin_pct, 5, 20, d.placement.safe_margin_pct),
    },
    animation: { type: animation, ...CUE_ANIMATION_DEFAULTS[animation] },
  }
}

function normalizeV2(s: any, d: SubtitleStyleDocument): SubtitleStyleDocument {
  const t = s.typography || {}
  const c = s.color || {}
  const b = s.box || {}
  const e = s.edge || {}
  const p = s.placement || {}
  const a = s.animation || {}
  const w = s.word || {}
  const animType = pickEnum(a.type, SUBTITLE_CUE_ANIMATIONS, d.animation.type)
  const animDefaults = CUE_ANIMATION_DEFAULTS[animType]
  const xPct = pickNullableNumber(p.position_x_pct, 0, 100, d.placement.position_x_pct)
  const yPct = pickNullableNumber(p.position_y_pct, 0, 100, d.placement.position_y_pct)
  const hasPrecise = xPct !== null && yPct !== null
  return {
    schema_version: SUBTITLE_STYLE_SCHEMA_VERSION,
    typography: {
      font_family: typeof t.font_family === 'string' && t.font_family ? t.font_family : d.typography.font_family,
      font_size_px: clampNumber(t.font_size_px, 8, 200, d.typography.font_size_px),
      bold: pickBool(t.bold, d.typography.bold),
      italic: pickBool(t.italic, d.typography.italic),
      letter_spacing_px: clampNumber(t.letter_spacing_px, -20, 60, d.typography.letter_spacing_px),
      line_spacing_px: clampNumber(t.line_spacing_px, 0, 80, d.typography.line_spacing_px),
      all_caps: pickBool(t.all_caps, d.typography.all_caps),
      max_chars_per_line: clampNumber(t.max_chars_per_line, 8, 120, d.typography.max_chars_per_line),
      max_lines: clampNumber(t.max_lines, 1, 6, d.typography.max_lines),
      wrap_style: pickEnum(t.wrap_style, SUBTITLE_WRAP_STYLES, d.typography.wrap_style),
    },
    color: {
      primary_hex: pickHex(c.primary_hex, d.color.primary_hex),
      primary_opacity: clampNumber(c.primary_opacity, 0, 1, d.color.primary_opacity),
      secondary_hex: pickNullableHex(c.secondary_hex, d.color.secondary_hex),
      secondary_opacity: clampNumber(c.secondary_opacity, 0, 1, d.color.secondary_opacity),
      outline_hex: pickHex(c.outline_hex, d.color.outline_hex),
      outline_opacity: clampNumber(c.outline_opacity, 0, 1, d.color.outline_opacity),
      shadow_hex: pickHex(c.shadow_hex, d.color.shadow_hex),
      shadow_opacity: clampNumber(c.shadow_opacity, 0, 1, d.color.shadow_opacity),
      box_hex: pickHex(c.box_hex, d.color.box_hex),
      box_opacity: clampNumber(c.box_opacity, 0, 1, d.color.box_opacity),
    },
    box: {
      mode: pickEnum(b.mode, SUBTITLE_BOX_MODES, d.box.mode),
      padding_px: pickNullableNumber(b.padding_px, 0, 80, d.box.padding_px),
      corner_radius_px: clampNumber(b.corner_radius_px, 0, 60, d.box.corner_radius_px),
    },
    edge: {
      outline_px: clampNumber(e.outline_px, 0, 40, d.edge.outline_px),
      shadow_px: clampNumber(e.shadow_px, 0, 40, d.edge.shadow_px),
      shadow_offset_x_px: clampNumber(e.shadow_offset_x_px, -40, 40, d.edge.shadow_offset_x_px),
      shadow_offset_y_px: clampNumber(e.shadow_offset_y_px, -40, 40, d.edge.shadow_offset_y_px),
      blur_px: clampNumber(e.blur_px, 0, 20, d.edge.blur_px),
    },
    placement: {
      position: pickEnum(p.position, SUBTITLE_VERTICAL_POSITIONS, d.placement.position),
      align: pickEnum(p.align, SUBTITLE_ALIGNMENTS, d.placement.align),
      position_x_pct: hasPrecise ? xPct : null,
      position_y_pct: hasPrecise ? yPct : null,
      safe_margin_pct: clampNumber(p.safe_margin_pct, 5, 20, d.placement.safe_margin_pct),
      margin_px: clampNumber(p.margin_px, 0, 300, d.placement.margin_px),
    },
    animation: {
      type: animType,
      in_ms: clampNumber(a.in_ms, 0, 3000, animDefaults.in_ms),
      out_ms: clampNumber(a.out_ms, 0, 3000, animDefaults.out_ms),
      transform_ms: clampNumber(a.transform_ms, 0, 3000, animDefaults.transform_ms),
      pop_from_pct: clampNumber(a.pop_from_pct, 10, 200, animDefaults.pop_from_pct),
      travel_px: clampNumber(a.travel_px, 0, 400, animDefaults.travel_px),
    },
    word: {
      mode: pickEnum(w.mode, SUBTITLE_WORD_MODES, d.word.mode),
      active_color_hex: pickHex(w.active_color_hex, d.word.active_color_hex),
      active_opacity: clampNumber(w.active_opacity, 0, 1, d.word.active_opacity),
      inactive_color_hex: pickNullableHex(w.inactive_color_hex, d.word.inactive_color_hex),
      inactive_opacity: clampNumber(w.inactive_opacity, 0, 1, d.word.inactive_opacity),
      active_scale_pct: clampNumber(w.active_scale_pct, 100, 300, d.word.active_scale_pct),
      transition_ms: clampNumber(w.transition_ms, 0, 1000, d.word.transition_ms),
      active_outline_hex: pickNullableHex(w.active_outline_hex, d.word.active_outline_hex),
      active_outline_opacity: clampNumber(w.active_outline_opacity, 0, 1, d.word.active_outline_opacity),
      highlight_box: pickBool(w.highlight_box, d.word.highlight_box),
      highlight_box_hex: pickHex(w.highlight_box_hex, d.word.highlight_box_hex),
      highlight_box_opacity: clampNumber(w.highlight_box_opacity, 0, 1, d.word.highlight_box_opacity),
      highlight_box_px: clampNumber(w.highlight_box_px, 0, 60, d.word.highlight_box_px),
    },
  }
}

/** Deep-merge a partial patch (a preset body) onto a full document. */
export function mergeSubtitleStyle(base: SubtitleStyleDocument, patch: SubtitleStylePatch | null | undefined): SubtitleStyleDocument {
  if (!patch) return base
  return normalizeSubtitleStyle({
    schema_version: SUBTITLE_STYLE_SCHEMA_VERSION,
    typography: { ...base.typography, ...(patch.typography || {}) },
    color: { ...base.color, ...(patch.color || {}) },
    box: { ...base.box, ...(patch.box || {}) },
    edge: { ...base.edge, ...(patch.edge || {}) },
    placement: { ...base.placement, ...(patch.placement || {}) },
    animation: { ...base.animation, ...(patch.animation || {}) },
    word: { ...base.word, ...(patch.word || {}) },
  })
}

/** True when both precise anchors are set, so `\pos` should be emitted. */
export function hasPreciseSubtitleAnchor(style: SubtitleStyleDocument): boolean {
  return style.placement.position_x_pct !== null && style.placement.position_y_pct !== null
}

/**
 * A word mode, a cue animation, precise placement, blur, an explicit shadow
 * offset, extra line spacing and a rounded box all need per-line override
 * tags, which only a full ASS document can carry. `force_style=` on the
 * `subtitles=` filter can express none of them.
 *
 * The engine renders a full ASS document in every case anyway (see
 * `buildSubtitleAss`) — this predicate exists so callers can explain WHY in a
 * job log, and so the legacy `force_style` fallback knows it is lossy.
 */
export function requiresAssDocument(style: SubtitleStyleDocument): boolean {
  return style.word.mode !== 'off'
    || style.animation.type !== 'none'
    || hasPreciseSubtitleAnchor(style)
    || style.edge.blur_px > 0
    || style.edge.shadow_offset_x_px !== 0
    || style.edge.shadow_offset_y_px !== 0
    || style.typography.line_spacing_px > 0
    || style.box.mode === 'rounded'
    || style.typography.all_caps
}

/**
 * The requested caption features a `force_style=` fallback drops, named for a
 * job log and for `declareJobDegraded`.
 *
 * `requiresAssDocument` answers "is the fallback lossy at all"; this answers
 * "what exactly will be missing", which is what the verified-completion
 * contract (AGENTS.md §8) needs: a fallback that ships without these can no
 * longer report a clean success. Line wrapping belongs here even though it is
 * not in `requiresAssDocument` — `force_style` ignores `max_chars_per_line` /
 * `max_lines` on every style, which is the original reason the ASS document
 * became the only styled path.
 */
export function assOnlySubtitleFeatures(style: SubtitleStyleDocument): string[] {
  const features: string[] = []
  if (style.word.mode !== 'off') features.push(`word-by-word captions (${style.word.mode})`)
  if (style.animation.type !== 'none') features.push(`caption animation (${style.animation.type})`)
  if (hasPreciseSubtitleAnchor(style)) features.push('precise caption placement')
  if (style.edge.blur_px > 0) features.push('caption blur')
  if (style.edge.shadow_offset_x_px !== 0 || style.edge.shadow_offset_y_px !== 0) features.push('caption shadow offset')
  if (style.typography.line_spacing_px > 0) features.push('caption line spacing')
  if (style.box.mode === 'rounded') features.push('rounded caption box')
  if (style.typography.all_caps) features.push('ALL CAPS captions')
  if (style.typography.max_chars_per_line > 0 && style.typography.max_lines > 0) features.push('caption line wrapping')
  return features
}
