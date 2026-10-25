/**
 * Thumbnail text layer — the shared contract between the main process and the renderer.
 *
 * Owner, 2026-10-24: real type drawn onto a copy of a text-free thumbnail, for Khmer first and any
 * language later. The art is never changed; the result is a separate file pinned for upload.
 * Presets carry the LOOK only (font, size rule, colours, effects, placement) — never the headline
 * words and never the chosen thumbnail (AGENTS §5: reusable look → include; episode-specific → exclude).
 *
 * Built for expansion: fonts declare the writing systems (ISO 15924 script codes) they cover, so a
 * new language needs only a new font entry, not new code.
 */

/** ISO 15924 script code, lower case: 'khmr', 'latn', 'thai', 'hani', 'cyrl', … */
export type ScriptCode = string

export interface ThumbnailFont {
  /** Stable id, e.g. 'kantumruy-pro'. Presets store this, never a file path. */
  id: string
  /** What the picker shows, e.g. 'Kantumruy Pro'. */
  label: string
  /** Writing systems this font can draw. A font is offered only for text it covers. */
  scripts: ScriptCode[]
  /** Weights the font actually ships (variable fonts list their usable stops). */
  weights: number[]
  /** 'display' fonts are headline faces (Moul); 'text' fonts are general (Kantumruy Pro). */
  role: 'display' | 'text'
  license: string
  /** 'bundled': shipped in the app and identical on every Mac. Nothing else is offered in v1. */
  source: 'bundled'
}

export type TextAnchor =
  | 'top-left' | 'top' | 'top-right'
  | 'left' | 'center' | 'right'
  | 'bottom-left' | 'bottom' | 'bottom-right'

export interface TextFill {
  type: 'solid' | 'gradient'
  /** CSS hex, '#RRGGBB'. */
  color: string
  /** Second colour of a gradient. */
  color2?: string
  /** Gradient direction in degrees (0 = left→right, 90 = top→bottom). */
  angle?: number
}

/** The look a preset saves. Every field is reusable across episodes. */
export interface ThumbnailTextStyle {
  font_id: string
  /** Font weight to use; must be one the font lists. */
  weight: number
  /**
   * 'fit': the largest size (between min and max) at which the whole text fits the placement box,
   * wrapping as needed — short titles grow, long titles shrink (owner point 4).
   * 'fixed': exactly `px`, wrapping inside the box; refused if it cannot fit `max_lines`.
   */
  size: { mode: 'fit' | 'fixed'; px?: number; min_px: number; max_px: number }
  max_lines: number
  align: 'left' | 'center' | 'right'
  line_height: number
  letter_spacing: number
  /** Upper-case Latin/Cyrillic/Greek letters; ignored by scripts without case (Khmer). */
  uppercase: boolean
  fill: TextFill
  /** Fill opacity, 0–1. */
  opacity: number
  outline: { enabled: boolean; color: string; width_px: number }
  shadow: { enabled: boolean; color: string; opacity: number; dx: number; dy: number; blur_px: number }
  background: { enabled: boolean; color: string; opacity: number; padding_px: number; radius_px: number }
  /**
   * Where the text lives, in percent of the 1280x720 canvas: the box the text is fitted into,
   * placed by its anchor. x/y are the anchor point.
   */
  placement: { anchor: TextAnchor; x_pct: number; y_pct: number; width_pct: number; height_pct: number }
}

/** A saved or built-in look. */
export interface ThumbnailTextPreset {
  id: string
  name: string
  /** Built-in presets ship with the app and cannot be edited (they can be copied). */
  builtin: boolean
  style: ThumbnailTextStyle
}

/** The canvas every render is made at — the YouTube thumbnail size, so nothing is resampled later. */
export const THUMBNAIL_TEXT_CANVAS = { width: 1280, height: 720 } as const

/** POST …/thumbnail-text/preview and …/thumbnail-text/apply request body. */
export interface ThumbnailTextRenderRequest {
  /** A bare filename in the episode's thumbnail folder (never a path). Must be text-free art. */
  source_filename: string
  /** The headline. '\n' forces a line break. */
  text: string
  style: ThumbnailTextStyle
}

/** What a render reports beside the image. */
export interface ThumbnailTextRenderReport {
  /** The size actually used (after fitting). */
  font_px: number
  lines: number
  /** True when every character was drawn by the chosen font (no fallback face, no missing glyph). */
  glyphs_complete: boolean
  /** Characters the font could not draw (refused on apply). */
  missing_characters: string[]
  /** Set when the text could not fit the box even at min_px / max_lines (refused on apply). */
  overflow: boolean
}

/** Sidecar written beside an applied variant: what it was made from, so a stale one is refused. */
export interface ThumbnailTextSidecar {
  schema: 1
  source_filename: string
  source_sha256: string
  source_bytes: number
  text: string
  style: ThumbnailTextStyle
  font_sha256: string
  rendered_at: string
  app_version: string
}

/** One applied variant as the page lists it. */
export interface ThumbnailTextVariant {
  filename: string
  source_filename: string
  text: string
  /** True when the source art changed (or vanished) since this was made: never uploaded then. */
  stale: boolean
  stale_reason: string | null
}

/** POST …/thumbnail-text/suggestions response. */
export interface ThumbnailTextSuggestions {
  /** The language the suggestions are written in (BCP-47 base, e.g. 'km'), and why. */
  language: string
  language_source: 'channel' | 'script' | 'title'
  suggestions: Array<{ text: string; length: 'short' | 'medium' | 'long' }>
  /** The writing model that made them, as the Gateway published it. */
  model: string | null
}
