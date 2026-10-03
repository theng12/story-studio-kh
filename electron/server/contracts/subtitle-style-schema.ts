/**
 * Strict validation for a v2 subtitle style document.
 *
 * Separate from `contracts/subtitle-style.ts` on purpose: that module is
 * dependency-free so the renderer can import its defaults, presets and
 * normaliser as VALUES without pulling zod into the browser bundle. This
 * module is the backend/content-pack side, and it is deliberately strict where
 * the normaliser is deliberately lenient:
 *
 *   - `normalizeSubtitleStyle()` runs against data already on the customer's
 *     disk. Refusing to load is never the right answer there, so it clamps and
 *     falls back.
 *   - `parseSubtitleStyleDocument()` runs against NEW input — an API body, a
 *     downloaded content pack. Unknown fields are rejected BY NAME, because a
 *     pack authored for a newer engine must fail loudly rather than render
 *     something the author never designed.
 *
 * Written in the same idiom as `content-packs/schemas.ts`: `.strict()` objects,
 * bounded numbers, enums pulled from the shared constant arrays so the schema
 * and the TypeScript union can never drift.
 */

import { z } from 'zod'
import {
  SUBTITLE_ALIGNMENTS,
  SUBTITLE_BOX_MODES,
  SUBTITLE_CUE_ANIMATIONS,
  SUBTITLE_STYLE_SCHEMA_VERSION,
  SUBTITLE_VERTICAL_POSITIONS,
  SUBTITLE_WORD_MODES,
  SUBTITLE_WRAP_STYLES,
  normalizeSubtitleStyle,
  type SubtitleStyleDocument,
} from './subtitle-style.js'

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a #RRGGBB colour')
const opacity = z.number().min(0).max(1)
const px = (min: number, max: number) => z.number().min(min).max(max)

export const SubtitleTypographySchema = z.object({
  font_family: z.string().min(1).max(120),
  font_size_px: px(8, 200),
  bold: z.boolean(),
  italic: z.boolean(),
  letter_spacing_px: px(-20, 60),
  line_spacing_px: px(0, 80),
  all_caps: z.boolean(),
  max_chars_per_line: z.number().int().min(8).max(120),
  max_lines: z.number().int().min(1).max(6),
  wrap_style: z.enum(SUBTITLE_WRAP_STYLES),
}).strict()

export const SubtitleColorsSchema = z.object({
  primary_hex: hex,
  primary_opacity: opacity,
  secondary_hex: hex.nullable(),
  secondary_opacity: opacity,
  outline_hex: hex,
  outline_opacity: opacity,
  shadow_hex: hex,
  shadow_opacity: opacity,
  box_hex: hex,
  box_opacity: opacity,
}).strict()

export const SubtitleBoxSchema = z.object({
  mode: z.enum(SUBTITLE_BOX_MODES),
  padding_px: px(0, 80).nullable(),
  corner_radius_px: px(0, 60),
}).strict()

export const SubtitleEdgeSchema = z.object({
  outline_px: px(0, 40),
  shadow_px: px(0, 40),
  shadow_offset_x_px: px(-40, 40),
  shadow_offset_y_px: px(-40, 40),
  blur_px: px(0, 20),
}).strict()

export const SubtitlePlacementSchema = z.object({
  position: z.enum(SUBTITLE_VERTICAL_POSITIONS),
  align: z.enum(SUBTITLE_ALIGNMENTS),
  position_x_pct: z.number().min(0).max(100).nullable(),
  position_y_pct: z.number().min(0).max(100).nullable(),
  safe_margin_pct: z.number().min(5).max(20),
  margin_px: px(0, 300),
}).strict()

export const SubtitleCueAnimationSchema = z.object({
  type: z.enum(SUBTITLE_CUE_ANIMATIONS),
  in_ms: z.number().min(0).max(3000),
  out_ms: z.number().min(0).max(3000),
  transform_ms: z.number().min(0).max(3000),
  pop_from_pct: z.number().min(10).max(200),
  travel_px: px(0, 400),
}).strict()

export const SubtitleWordSchema = z.object({
  mode: z.enum(SUBTITLE_WORD_MODES),
  active_color_hex: hex,
  active_opacity: opacity,
  inactive_color_hex: hex.nullable(),
  inactive_opacity: opacity,
  active_scale_pct: z.number().min(100).max(300),
  transition_ms: z.number().min(0).max(1000),
  active_outline_hex: hex.nullable(),
  active_outline_opacity: opacity,
  highlight_box: z.boolean(),
  highlight_box_hex: hex,
  highlight_box_opacity: opacity,
  highlight_box_px: px(0, 60),
}).strict()

export const SubtitleStyleDocumentSchema = z.object({
  schema_version: z.literal(SUBTITLE_STYLE_SCHEMA_VERSION),
  typography: SubtitleTypographySchema,
  color: SubtitleColorsSchema,
  box: SubtitleBoxSchema,
  edge: SubtitleEdgeSchema,
  placement: SubtitlePlacementSchema,
  animation: SubtitleCueAnimationSchema,
  word: SubtitleWordSchema,
}).strict()

/** A style expressed as a partial patch — every group and field optional. */
export const SubtitleStylePatchSchema = z.object({
  schema_version: z.literal(SUBTITLE_STYLE_SCHEMA_VERSION).optional(),
  typography: SubtitleTypographySchema.partial().strict().optional(),
  color: SubtitleColorsSchema.partial().strict().optional(),
  box: SubtitleBoxSchema.partial().strict().optional(),
  edge: SubtitleEdgeSchema.partial().strict().optional(),
  placement: SubtitlePlacementSchema.partial().strict().optional(),
  animation: SubtitleCueAnimationSchema.partial().strict().optional(),
  word: SubtitleWordSchema.partial().strict().optional(),
}).strict()

export class SubtitleStyleValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`Subtitle style is not valid: ${issues.join('; ')}`)
    this.name = 'SubtitleStyleValidationError'
    this.issues = issues
  }
}

/**
 * Turn a zod issue list into messages that NAME the offending field, so a pack
 * built for a newer engine says which key it used rather than "invalid input".
 */
function describe(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const at = issue.path.length ? issue.path.join('.') : '(root)'
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as z.ZodIssue & { keys: string[] }).keys
      return `unknown field${keys.length === 1 ? '' : 's'} ${keys.map(k => `"${at === '(root)' ? k : `${at}.${k}`}"`).join(', ')} — this style was authored for a newer subtitle engine`
    }
    return `${at}: ${issue.message}`
  })
}

/**
 * Validate a COMPLETE v2 document. Throws `SubtitleStyleValidationError` with
 * one message per problem; unknown fields are named individually.
 */
export function parseSubtitleStyleDocument(input: unknown): SubtitleStyleDocument {
  const result = SubtitleStyleDocumentSchema.safeParse(input)
  if (!result.success) throw new SubtitleStyleValidationError(describe(result.error))
  // Clamp-and-canonicalise (hex casing, precise-anchor pairing) so a validated
  // document and a normalised one are the same object shape.
  return normalizeSubtitleStyle(result.data)
}
