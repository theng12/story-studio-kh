/**
 * Subtitle helpers for the video assembly step.
 *
 * Three responsibilities:
 *   1. Convert chapter metadata (title + start/end seconds) into a valid SRT.
 *   2. Validate and normalize an externally-supplied .srt / .vtt file.
 *   3. Build the libass `force_style` string that burns subtitles in with
 *      the user-picked style.
 *
 * Keep this module free of Express / FFmpeg imports — it's pure string
 * plumbing so the subtitle generator can unit-test it.
 */

import type { VideoSubtitleStyle } from '../models/types.js'
import {
  CUE_ANIMATION_DEFAULTS,
  hasPreciseSubtitleAnchor,
  normalizeSubtitleStyle,
  SUBTITLE_REFERENCE_HEIGHT,
  type SubtitleStyleDocument,
} from '../contracts/subtitle-style.js'
import {
  estimatedWordTimingSource,
  splitCueWords,
  type TimedWord,
  type WordTimingPrecision,
  type WordTimingSource,
} from './subtitle-word-timing.js'

export interface Chapter {
  title: string
  start_sec: number
  end_sec: number
}

/** v1.0.143+ — Cue shape used by the parser + stitcher. Mirrors what
 *  callers expect from an SRT line (timestamps in seconds, payload
 *  text already unwrapped — newlines collapsed to spaces when callers
 *  want it as one line). */
export interface SrtCue {
  index: number
  start_sec: number
  end_sec: number
  text: string
}

/** v1.0.143+ — Lenient SRT parser. Handles both LF and CRLF newlines,
 *  optional cue index lines, both `,` and `.` as the millisecond
 *  separator (some tools emit one, some the other), and forgives
 *  trailing whitespace. Returns an empty array on unparseable input
 *  rather than throwing — callers decide whether to surface an error. */
export function parseSrt(raw: string): SrtCue[] {
  if (!raw || typeof raw !== 'string') return []
  // Normalise line endings + strip BOM. Whisper / ffmpeg sometimes
  // emit BOM on macOS, which would otherwise eat the first index line.
  const normalized = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = normalized.split(/\n\n+/).map(b => b.trim()).filter(Boolean)
  const cues: SrtCue[] = []
  const TS = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
  let autoIdx = 0
  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.length === 0) continue
    // First line is either an index or the timestamp itself.
    let i = 0
    let cueIdx = ++autoIdx
    if (/^\d+$/.test(lines[i]!.trim())) {
      cueIdx = parseInt(lines[i]!.trim(), 10)
      i++
    }
    const tsLine = lines[i]
    if (!tsLine) continue
    const m = TS.exec(tsLine)
    if (!m) continue
    const start = parseInt(m[1]!, 10) * 3600 + parseInt(m[2]!, 10) * 60 + parseInt(m[3]!, 10) + parseInt(m[4]!.padEnd(3, '0'), 10) / 1000
    const end = parseInt(m[5]!, 10) * 3600 + parseInt(m[6]!, 10) * 60 + parseInt(m[7]!, 10) + parseInt(m[8]!.padEnd(3, '0'), 10) / 1000
    const text = lines.slice(i + 1).join(' ').trim()
    if (!text) continue
    cues.push({ index: cueIdx, start_sec: start, end_sec: end, text })
  }
  return cues
}

/** Convert seconds (float) to an SRT `HH:MM:SS,mmm` timestamp. */
export function formatSrtTime(totalSec: number): string {
  if (!isFinite(totalSec) || totalSec < 0) totalSec = 0
  const ms = Math.round(totalSec * 1000)
  const hh = Math.floor(ms / 3_600_000)
  const mm = Math.floor((ms % 3_600_000) / 60_000)
  const ss = Math.floor((ms % 60_000) / 1000)
  const mmm = ms % 1000
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(mmm)}`
}

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n) }
function pad3(n: number): string { return n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n) }

/**
 * The cues a burn will actually use once intro captions are dropped (v1.4.0).
 *
 * `hide_during_intro` omits everything before the story starts from the BURN
 * copy while leaving the full SRT sidecar untouched. That trim used to live
 * inline in the renderer, which meant the caption preflight frames — whose only
 * job is to show what the burn will show — could have been drawn from a cue list
 * the burn was never going to use. One function, both callers.
 *
 * Timestamps are never rewritten: a kept cue stays exactly where the narration
 * puts it. Only the leading cues disappear.
 */
export function trimCuesBeforeStoryStart(cues: SrtCue[], storyStartSec: number): SrtCue[] {
  if (!(storyStartSec > 0)) return cues
  const kept = cues.filter(c => c.end_sec > storyStartSec + 0.001)
  // Dropping EVERY cue would mean burning nothing at all, which is never what
  // "hide the intro captions" was asked to do. Better the untrimmed list than a
  // video that silently loses its subtitles.
  return kept.length && kept.length < cues.length ? kept : cues
}

/** Word-aware text wrapping. Greedy fill-up-to-max-chars, cap at max_lines
 *  so the final line gets an ellipsis rather than overflow.  */
export function wrapText(text: string, maxChars: number, maxLines: number): string {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = w
      if (lines.length >= maxLines) break
    }
  }
  if (current && lines.length < maxLines) lines.push(current)
  // If we truncated, append an ellipsis to the last line.
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[.,;:!?]*$/, '') + '…'
  }
  return lines.join('\n')
}

/**
 * v1.0.438 — like wrapText, but NEVER drops text. Word-wraps into lines of
 * ≤ maxChars, then groups those lines into chunks of ≤ maxLines lines each.
 * A cue that's too long to fit `maxLines` lines becomes MULTIPLE chunks
 * (the caller shows them sequentially across the cue's time window) instead of
 * being truncated with an ellipsis. Each returned chunk is its lines joined by
 * '\n'. Always returns at least one chunk.
 */
export function wrapTextToChunks(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w
    // `!current` keeps a single word longer than maxChars on its own line
    // rather than dropping it.
    if (candidate.length <= maxChars || !current) {
      current = candidate
    } else {
      lines.push(current)
      current = w
    }
  }
  if (current) lines.push(current)
  const safeMaxLines = Math.max(1, maxLines)
  const chunks: string[] = []
  for (let i = 0; i < lines.length; i += safeMaxLines) {
    chunks.push(lines.slice(i, i + safeMaxLines).join('\n'))
  }
  return chunks.length ? chunks : ['']
}

/**
 * v1.0.517 — the user-facing style contract: every pixel value in
 * VideoSubtitleStyle (font_size_px, outline_px) means "pixels at a
 * 1920×1080 reference frame". The CSS preview in SubtitleStylePicker
 * renders on that assumption, so both render paths must translate into
 * whatever coordinate space libass actually uses:
 *
 *   - `subtitles=` filter on an SRT (buildAssStyle): ffmpeg synthesizes an
 *     ASS script with the libass default PlayRes of 384×288, and
 *     force_style values are interpreted in THAT space, then scaled up to
 *     the output frame. (`original_size=` does NOT change this — it only
 *     corrects aspect-ratio distortion.) So "px at 1080" values must be
 *     pre-scaled by 288/1080 ≈ 0.267 or they render 3.75× too big — the
 *     v1.0.413→516 bug where FontSize=35 burned in at ~131px.
 *   - `ass=` filter on a generated document (srtToAss): we control PlayRes
 *     directly, so values scale by playResY/1080 (a no-op at 1080p).
 *
 * Both factors verified empirically against the bundled ffmpeg: FontSize=35
 * unscaled renders an 80px-tall cap height at 1080p; scaled, 21px — identical
 * to an explicit PlayRes-1080 ASS document. Outline and margins scale the
 * same way (the synthesized header has ScaledBorderAndShadow: yes).
 */
const SRT_DEFAULT_PLAYRES_Y = 288
const REFERENCE_HEIGHT = 1080

/** Round to 2 decimals — libass parses Fontsize/Outline as floats. */
function round2(n: number): number { return Math.round(n * 100) / 100 }

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function hasPreciseSubtitlePlacement(style: VideoSubtitleStyle): boolean {
  return Number.isFinite(style.position_x_pct) && Number.isFinite(style.position_y_pct)
}

export interface ResolvedSubtitlePlacement {
  x: number
  y: number
  safeMarginPx: number
  alignment: number
}

/** Resolve precise percentage placement into safe, edge-aware ASS anchors. */
export function resolveSubtitlePlacement(
  style: VideoSubtitleStyle,
  width: number,
  height: number,
): ResolvedSubtitlePlacement {
  const w = Math.max(2, Math.round(width || 1920))
  const h = Math.max(2, Math.round(height || 1080))
  const safePct = clamp(Number(style.safe_margin_pct) || 8, 5, 20)
  const xPct = hasPreciseSubtitlePlacement(style)
    ? clamp(Number(style.position_x_pct), safePct, 100 - safePct)
    : style.align === 'left' ? safePct : style.align === 'right' ? 100 - safePct : 50
  const yPct = hasPreciseSubtitlePlacement(style)
    ? clamp(Number(style.position_y_pct), safePct, 100 - safePct)
    : style.position === 'top' ? safePct : style.position === 'center' ? 50 : 100 - safePct

  // Anchor text inward at the outer thirds so its box grows away from the
  // protected edges. This is what keeps a dragged caption inside the frame.
  const hAlign = xPct <= 33 ? 0 : xPct >= 67 ? 2 : 1
  const vBase = yPct <= 33 ? 7 : yPct >= 67 ? 1 : 4
  return {
    x: Math.round((w * xPct) / 100),
    y: Math.round((h * yPct) / 100),
    safeMarginPx: Math.round((h * safePct) / 100),
    alignment: vBase + hAlign,
  }
}
/**
 * ── The caption engine (v1.1.0) ────────────────────────────────────────────
 *
 * One renderer, driven entirely by a declarative `SubtitleStyleDocument`. It
 * does not add a new rendering technology — every effect below is a libass
 * override tag that the `ass=` filter already understood. What changed is that
 * the tags are now PARAMETERISED by data instead of hardcoded per animation.
 *
 * Tag vocabulary used, and what each field drives:
 *   `\pos` `\move`   precise placement, slide-up / slide-down
 *   `\fad`           cue animation in_ms / out_ms
 *   `\fscx` `\fscy`  cue `pop`, word `pop`
 *   `\t(...)`        every timed transition (colour, scale, alpha, border)
 *   `\1c` `\3c`      word active/inactive colour, active outline
 *   `\1a` `\alpha`   opacity, and the word `reveal` / `typewriter` modes
 *   `\bord` `\3c`    the word highlighter blob
 *   `\blur`          edge.blur_px
 *   `\shad` `\xshad` `\yshad`   shadow depth and explicit offsets
 *   `\fsp`           letter spacing (also the ASS `Spacing` style field)
 *
 * ── Why every word block restates its resting state ────────────────────────
 *
 * libass applies override blocks strictly in text order, so a `\t` attached to
 * word 2 keeps animating words 3, 4, … unless a LATER block sets the same
 * property statically. Each word's block therefore begins by re-asserting the
 * resting value of every property that mode animates, and only then adds its
 * own transitions. Drop that and a highlight sweep smears across the rest of
 * the line.
 *
 * ── The scale contract ─────────────────────────────────────────────────────
 *
 * PlayResX/Y are the real output size and every `_px` field is multiplied by
 * `height / 1080`, so a 640x360 preview and a 1920x1080 burn describe the same
 * caption at different resolutions. `subtitle-ass.test.ts` asserts that
 * equality directly — it is the property that makes the preview trustworthy.
 */

/** ASS timestamp: `H:MM:SS.cc` (centiseconds). */
function assTime(totalSec: number): string {
  if (!isFinite(totalSec) || totalSec < 0) totalSec = 0
  const cs = Math.round(totalSec * 100)
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(c)}`
}

/** ASS colour override value, `&HBBGGRR&` — no alpha (that is `\1a`/`\3a`). */
function assColorTag(hex: string): string {
  const cleaned = hex.replace('#', '').padStart(6, '0').toLowerCase()
  return `&H${cleaned.slice(4, 6)}${cleaned.slice(2, 4)}${cleaned.slice(0, 2)}&`
}

/** ASS alpha override value, `&HAA&`. Opacity 1 → `&H00&` (fully opaque). */
function assAlphaTag(opacity: number): string {
  const a = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255)))
  return `&H${a.toString(16).padStart(2, '0').toUpperCase()}&`
}

/** Style-line colour, `&HAABBGGRR` (no trailing `&` — the style line has none). */
function assStyleColor(hex: string, opacity: number): string {
  const cleaned = hex.replace('#', '').padStart(6, '0').toLowerCase()
  const a = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255)))
  return `&H${a.toString(16).padStart(2, '0').toLowerCase()}${cleaned.slice(4, 6)}${cleaned.slice(2, 4)}${cleaned.slice(0, 2)}`
}

/** Convert `#RRGGBB` to libass `&HBBGGRR&` (force_style form, alpha = opaque). */
function hexToAss(hex: string): string {
  return `&H00${assColorTag(hex).slice(2)}`
}

/** Resolve the style's own colour+opacity into a `\Nc\Na` override pair. */
function colorOverride(channel: '1' | '3' | '4', hex: string, opacity: number): string {
  const tag = `\\${channel}c${assColorTag(hex)}`
  return opacity >= 1 ? tag : `${tag}\\${channel}a${assAlphaTag(opacity)}`
}

/** Placement resolved against a v2 document rather than the legacy shape. */
export interface ResolvedSubtitleAnchor extends ResolvedSubtitlePlacement {
  precise: boolean
}

export function resolveSubtitleAnchor(
  style: SubtitleStyleDocument,
  width: number,
  height: number,
): ResolvedSubtitleAnchor {
  const legacy: VideoSubtitleStyle = {
    font_family: style.typography.font_family,
    font_size_px: style.typography.font_size_px,
    color_hex: style.color.primary_hex,
    outline_color_hex: style.color.outline_hex,
    outline_px: style.edge.outline_px,
    background: style.box.mode === 'rounded' ? 'none' : style.box.mode,
    position: style.placement.position,
    align: style.placement.align,
    max_chars_per_line: style.typography.max_chars_per_line,
    max_lines: style.typography.max_lines,
    safe_margin_pct: style.placement.safe_margin_pct,
    ...(style.placement.position_x_pct !== null ? { position_x_pct: style.placement.position_x_pct } : {}),
    ...(style.placement.position_y_pct !== null ? { position_y_pct: style.placement.position_y_pct } : {}),
  }
  return { ...resolveSubtitlePlacement(legacy, width, height), precise: hasPreciseSubtitleAnchor(style) }
}

/** ASS `WrapStyle` for the document's wrap mode. */
function assWrapStyle(style: SubtitleStyleDocument): number {
  switch (style.typography.wrap_style) {
    case 'balanced': return 0
    case 'end-of-line': return 1
    case 'bottom-wider': return 3
    default: return 2   // 'engine' — Story Studio pre-wraps, libass must not re-wrap
  }
}

/**
 * The `[V4+ Styles]` line and the numbers every per-line override builds on.
 * Shared by the ASS document and the legacy `force_style` fallback so the two
 * can never disagree about what a style means.
 */
interface ResolvedStyleNumbers {
  fontName: string
  fontSize: number
  bold: number
  italic: number
  spacing: number
  primary: string
  secondary: string
  outlineCol: string
  backColour: string
  shadowCol: string
  borderStyle: number
  /** ASS `Outline` — the stroke width, or the box padding when BorderStyle=3. */
  outline: number
  shadow: number
  alignment: number
  margin: number
  scale: number
}

function resolveStyleNumbers(
  style: SubtitleStyleDocument,
  scale: number,
  alignment: number,
): ResolvedStyleNumbers {
  const rounded = style.box.mode === 'rounded'
  const opaqueBox = style.box.mode === 'full' || style.box.mode === 'semi'
  // libass BorderStyle: 1 = outlined, 3 = opaque box. A 'rounded' box has no
  // libass equivalent, so it is drawn as a thick round-joined outline in the
  // box colour — see SubtitleBox.mode.
  const borderStyle = opaqueBox ? 3 : 1
  // With BorderStyle 3 the ASS `Outline` value IS the box padding, which is
  // why box.padding_px defaults to null ("follow the outline width").
  const outlinePx = rounded
    ? style.box.corner_radius_px
    : opaqueBox
      ? (style.box.padding_px ?? style.edge.outline_px)
      : style.edge.outline_px
  return {
    fontName: style.typography.font_family || 'Helvetica',
    fontSize: round2(style.typography.font_size_px * scale),
    bold: style.typography.bold ? 1 : 0,
    italic: style.typography.italic ? 1 : 0,
    spacing: round2(style.typography.letter_spacing_px * scale),
    primary: assStyleColor(style.color.primary_hex, style.color.primary_opacity),
    secondary: assStyleColor(
      style.color.secondary_hex ?? style.color.primary_hex,
      style.color.secondary_hex === null ? style.color.primary_opacity : style.color.secondary_opacity,
    ),
    // In 'rounded' mode the outline IS the backdrop, so it takes the box colour.
    outlineCol: rounded
      ? assStyleColor(style.color.box_hex, style.color.box_opacity)
      : assStyleColor(style.color.outline_hex, style.color.outline_opacity),
    backColour: assStyleColor(style.color.box_hex, opaqueBox ? style.color.box_opacity : 1),
    shadowCol: assStyleColor(style.color.shadow_hex, style.color.shadow_opacity),
    borderStyle,
    outline: round2(outlinePx * scale),
    shadow: round2(style.edge.shadow_px * scale),
    alignment,
    margin: Math.round(style.placement.margin_px * scale),
    scale,
  }
}

/**
 * Per-cue override tags: precise placement plus the entrance animation.
 * Fragments are emitted in a fixed order so the output is stable and
 * diff-able, and so a style with every new field at its default reproduces the
 * v1 engine's bytes exactly.
 */
function cueOverrideFragments(style: SubtitleStyleDocument, w: number, h: number): string[] {
  const anchor = resolveSubtitleAnchor(style, w, h)
  const a = style.animation
  const pos = anchor.precise ? `\\pos(${anchor.x},${anchor.y})` : ''
  const fragments: string[] = []

  if (a.type === 'slide-up' || a.type === 'slide-down') {
    const scale = h / SUBTITLE_REFERENCE_HEIGHT
    const travel = Math.round(a.travel_px * scale)
    const x = anchor.x
    const yEnd = anchor.y
    const safeTop = anchor.safeMarginPx
    const safeBottom = h - anchor.safeMarginPx
    // Slide-up starts BELOW its resting place and rises; slide-down mirrors it.
    // Either way the start point is clamped inside the safe band, and flips to
    // the other side when the preferred one would leave the frame.
    const preferred = a.type === 'slide-up' ? yEnd + travel : yEnd - travel
    const inside = a.type === 'slide-up' ? preferred <= safeBottom : preferred >= safeTop
    const yStart = inside
      ? preferred
      : a.type === 'slide-up'
        ? Math.max(safeTop, yEnd - travel)
        : Math.min(safeBottom, yEnd + travel)
    fragments.push(`\\fad(${a.in_ms},${a.out_ms})`)
    fragments.push(`\\move(${x},${yStart},${x},${yEnd})`)
  } else {
    if (pos) fragments.push(pos)
    if (a.type === 'fade' || a.type === 'pop') fragments.push(`\\fad(${a.in_ms},${a.out_ms})`)
    if (a.type === 'pop') {
      fragments.push(`\\fscx${a.pop_from_pct}\\fscy${a.pop_from_pct}\\t(0,${a.transform_ms},\\fscx100\\fscy100)`)
    }
  }

  // Everything below is new in v1.1.0 and silent at its default, which is what
  // keeps a legacy style byte-identical to the v1 output.
  if (style.edge.blur_px > 0) fragments.push(`\\blur${round2(style.edge.blur_px * (h / SUBTITLE_REFERENCE_HEIGHT))}`)
  if (style.edge.shadow_offset_x_px !== 0) {
    fragments.push(`\\xshad${round2(style.edge.shadow_offset_x_px * (h / SUBTITLE_REFERENCE_HEIGHT))}`)
  }
  if (style.edge.shadow_offset_y_px !== 0) {
    fragments.push(`\\yshad${round2(style.edge.shadow_offset_y_px * (h / SUBTITLE_REFERENCE_HEIGHT))}`)
  }
  return fragments
}

/** Neutralise braces so cue text can never be read as an override block. */
function escapeAssText(text: string): string {
  return text.replace(/\{/g, '(').replace(/\}/g, ')')
}

/**
 * Join wrapped lines. libass has no line-spacing property, so a positive
 * `line_spacing_px` inserts a spacer line — a hard space at the requested
 * height — between them. See SubtitleTypography.line_spacing_px for the
 * caveats; at the default 0 this emits a plain `\N` and nothing else.
 */
function joinLines(lines: string[], style: SubtitleStyleDocument, scale: number): string {
  const gap = style.typography.line_spacing_px
  if (gap <= 0) return lines.join('\\N')
  const gapSize = round2(gap * scale)
  const bodySize = round2(style.typography.font_size_px * scale)
  return lines.join(`\\N{\\fs${gapSize}}\\h{\\fs${bodySize}}\\N`)
}

/**
 * The resting state a word block must re-assert before its own transitions,
 * for exactly the properties this mode animates. See the note at the top of
 * the engine for why omitting any of these smears the effect down the line.
 */
function wordRestingState(style: SubtitleStyleDocument, numbers: ResolvedStyleNumbers): string {
  const w = style.word
  const inactiveHex = w.inactive_color_hex ?? style.color.primary_hex
  switch (w.mode) {
    case 'highlight':
    case 'pop': {
      let out = colorOverride('1', inactiveHex, w.inactive_opacity)
      if (w.mode === 'pop') out += '\\fscx100\\fscy100'
      if (w.active_outline_hex !== null || w.highlight_box) {
        out += colorOverride('3', style.color.outline_hex, style.color.outline_opacity)
      }
      if (w.highlight_box) out += `\\bord${numbers.outline}`
      return out
    }
    case 'reveal':
    case 'typewriter':
      return `\\alpha${assAlphaTag(0)}`
    case 'single':
      return colorOverride('1', w.active_color_hex, w.active_opacity)
    default:
      return ''
  }
}

/** The timed part of a word block: what changes, when, for how long. */
function wordTransitions(
  style: SubtitleStyleDocument,
  numbers: ResolvedStyleNumbers,
  startMs: number,
  endMs: number,
): string {
  const w = style.word
  const inactiveHex = w.inactive_color_hex ?? style.color.primary_hex
  // A zero-length `\t` window is not an animation libass can interpolate, so
  // an instant change still needs one millisecond to happen in.
  const ease = Math.max(1, Math.round(w.transition_ms))
  const on: string[] = []
  const off: string[] = []

  switch (w.mode) {
    case 'highlight':
    case 'pop': {
      on.push(colorOverride('1', w.active_color_hex, w.active_opacity))
      off.push(colorOverride('1', inactiveHex, w.inactive_opacity))
      if (w.mode === 'pop') {
        on.push(`\\fscx${w.active_scale_pct}\\fscy${w.active_scale_pct}`)
        off.push('\\fscx100\\fscy100')
      }
      if (w.active_outline_hex !== null) {
        on.push(colorOverride('3', w.active_outline_hex, w.active_outline_opacity))
        off.push(colorOverride('3', style.color.outline_hex, style.color.outline_opacity))
      }
      if (w.highlight_box) {
        on.push(`\\bord${round2(w.highlight_box_px * numbers.scale)}`)
        on.push(colorOverride('3', w.highlight_box_hex, w.highlight_box_opacity))
        off.push(`\\bord${numbers.outline}`)
        off.push(colorOverride('3', style.color.outline_hex, style.color.outline_opacity))
      }
      break
    }
    case 'reveal':
      on.push(`\\alpha${assAlphaTag(1)}`)
      break
    case 'typewriter':
      // Same mechanism as reveal, but deliberately un-eased: a typewriter
      // letter does not fade in.
      return `\\t(${startMs},${startMs + 1},\\alpha${assAlphaTag(1)})`
    default:
      return ''
  }

  const parts = [`\\t(${startMs},${startMs + ease},${on.join('')})`]
  if (off.length) parts.push(`\\t(${endMs},${endMs + ease},${off.join('')})`)
  return parts.join('')
}

/** Word modes that stay hidden until their moment start from `\alpha` opaque. */
function wordHiddenPrefix(style: SubtitleStyleDocument): string {
  return (style.word.mode === 'reveal' || style.word.mode === 'typewriter')
    ? `\\alpha${assAlphaTag(0)}`
    : ''
}

export interface SubtitleAssResult {
  /** The complete ASS document, ready for `ass=filename=…`. */
  ass: string
  /** Whether the word timings used were measured or interpolated. */
  wordPrecision: WordTimingPrecision | null
  /** How many Dialogue events were emitted — a completion check, not a guess. */
  events: number
}

export interface SubtitleAssOptions {
  width: number
  height: number
  /**
   * Where per-word times come from. Defaults to interpolation from the cue,
   * which stamps every word `estimated`. See `lib/subtitle-word-timing.ts`.
   */
  wordTiming?: WordTimingSource
}

/**
 * Render cues into a complete ASS document using a v2 style.
 *
 * This is the ONLY renderer. Both burn paths and the preview endpoint call it,
 * which is what makes the preview faithful: the preview is literally the same
 * document at a smaller PlayRes.
 */
export function buildSubtitleAssDocument(
  cues: SrtCue[],
  style: SubtitleStyleDocument,
  opts: SubtitleAssOptions,
): SubtitleAssResult {
  const w = Math.max(2, Math.round(opts.width || 1920))
  const h = Math.max(2, Math.round(opts.height || 1080))
  const scale = h / SUBTITLE_REFERENCE_HEIGHT
  const anchor = resolveSubtitleAnchor(style, w, h)
  const vBase = style.placement.position === 'top' ? 7 : style.placement.position === 'center' ? 4 : 1
  const hOffset = style.placement.align === 'center' ? 1 : style.placement.align === 'right' ? 2 : 0
  const alignment = anchor.precise ? anchor.alignment : vBase + hOffset
  const n = resolveStyleNumbers(style, scale, alignment)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    `WrapStyle: ${assWrapStyle(style)}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${n.fontName},${n.fontSize},${n.primary},${n.secondary},${n.outlineCol},${n.backColour},${n.bold},${n.italic},0,0,100,100,${n.spacing},0,${n.borderStyle},${n.outline},${n.shadow},${n.alignment},${n.margin},${n.margin},${n.margin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  const cueFragments = cueOverrideFragments(style, w, h)
  const cueTag = cueFragments.length ? `{${cueFragments.join('')}}` : ''
  const maxChars = style.typography.max_chars_per_line
  const maxLines = style.typography.max_lines
  const wordMode = style.word.mode !== 'off'
  const source = opts.wordTiming ?? estimatedWordTimingSource

  const events: string[] = []
  let wordPrecision: WordTimingPrecision | null = null

  for (const c of cues) {
    const display = style.typography.all_caps ? c.text.toUpperCase() : c.text
    if (!display.trim()) continue

    if (!wordMode) {
      // v1.0.438 — SPLIT (never truncate) a cue too long for maxLines, so no
      // spoken words are lost. Each chunk takes an equal slice of the window.
      const chunks = wrapTextToChunks(display, maxChars, maxLines)
      const count = chunks.length
      const span = Math.max(0, c.end_sec - c.start_sec)
      chunks.forEach((chunk, i) => {
        const start = count === 1 ? c.start_sec : c.start_sec + (span * i) / count
        const end = count === 1 ? c.end_sec : c.start_sec + (span * (i + 1)) / count
        const text = joinLines(chunk.split('\n').map(escapeAssText), style, scale)
        events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${cueTag}${text}`)
      })
      continue
    }

    // ── Word modes ───────────────────────────────────────────────────────
    const words = source.forCue({ ...c, text: display })
    if (!words.length) continue
    wordPrecision = wordPrecision === 'estimated' ? 'estimated' : source.precision
    if (words.some(word => word.precision === 'estimated')) wordPrecision = 'estimated'

    if (style.word.mode === 'single') {
      // Exactly one word on screen: one Dialogue per word, no per-word blocks
      // needed because there is nothing else on the line to bleed into.
      const resting = wordRestingState(style, n)
      for (const word of words) {
        const tag = resting ? `{${cueFragments.join('')}${resting}}` : cueTag
        events.push(
          `Dialogue: 0,${assTime(word.start_sec)},${assTime(word.end_sec)},Default,,0,0,0,,${tag}${escapeAssText(word.text)}`,
        )
      }
      continue
    }

    const chunks = wrapTextToChunks(display, maxChars, maxLines)
    let cursor = 0
    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      const chunkWordCount = lines.reduce((sum, line) => sum + splitCueWords(line).length, 0)
      const chunkWords = words.slice(cursor, cursor + chunkWordCount)
      cursor += chunkWordCount
      if (!chunkWords.length) continue
      const start = chunkWords[0]!.start_sec
      const end = chunkWords[chunkWords.length - 1]!.end_sec
      const rendered = renderWordLines(lines, chunkWords, style, n, start, scale)
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${cueTag}${rendered}`)
    }
  }

  return {
    ass: [...header, ...events].join('\n') + '\n',
    wordPrecision: wordMode ? (wordPrecision ?? source.precision) : null,
    events: events.length,
  }
}

/** Build one Dialogue body: each word carrying its own override block. */
function renderWordLines(
  lines: string[],
  words: TimedWord[],
  style: SubtitleStyleDocument,
  numbers: ResolvedStyleNumbers,
  lineStartSec: number,
  scale: number,
): string {
  const hidden = wordHiddenPrefix(style)
  const resting = wordRestingState(style, numbers)
  let index = 0
  const out: string[] = []
  for (const line of lines) {
    const lineWords = splitCueWords(line)
    const pieces: string[] = []
    for (const raw of lineWords) {
      const timed = words[index]
      index++
      if (!timed) { pieces.push(escapeAssText(raw)); continue }
      const startMs = Math.max(0, Math.round((timed.start_sec - lineStartSec) * 1000))
      const endMs = Math.max(startMs, Math.round((timed.end_sec - lineStartSec) * 1000))
      const block = `${hidden || resting}${wordTransitions(style, numbers, startMs, endMs)}`
      pieces.push(block ? `{${block}}${escapeAssText(raw)}` : escapeAssText(raw))
    }
    out.push(pieces.join(' '))
  }
  return joinLines(out, style, scale)
}

/**
 * The lossy fallback: a `force_style=` fragment for the `subtitles=` filter.
 *
 * Kept only for the case where the ASS document could not be built (an
 * unparseable subtitle file), because it can express NONE of: word modes, cue
 * animation, precise placement, blur, shadow offsets, line spacing, all-caps,
 * or the engine's own line wrapping — `max_chars_per_line` and `max_lines` are
 * silently ignored on this path because libass wraps the raw SRT itself.
 * Anything that reaches here renders differently from the preview. Callers say
 * so in the job log.
 *
 * Pixel values are pre-scaled from the 1080 reference into the SRT-default
 * 384x288 PlayRes space that force_style is interpreted in (see the scaling
 * note above `SRT_DEFAULT_PLAYRES_Y`).
 */
export function buildSubtitleForceStyle(style: SubtitleStyleDocument): string {
  const scale = SRT_DEFAULT_PLAYRES_Y / REFERENCE_HEIGHT
  const vBase = style.placement.position === 'top' ? 7 : style.placement.position === 'center' ? 4 : 1
  const hOffset = style.placement.align === 'center' ? 1 : style.placement.align === 'right' ? 2 : 0
  const n = resolveStyleNumbers(style, scale, vBase + hOffset)
  // v1 capped the outline at 6px here; the schema's own 0-40 bound now governs,
  // and the UI never offered more than 6, so no stored style changes meaning.
  const parts: Record<string, string | number> = {
    FontName: n.fontName,
    FontSize: n.fontSize,
    PrimaryColour: hexToAss(style.color.primary_hex),
    OutlineColour: hexToAss(style.box.mode === 'rounded' ? style.color.box_hex : style.color.outline_hex),
    BackColour: `${n.backColour}&`,
    BorderStyle: n.borderStyle,
    Outline: n.outline,
    Shadow: n.shadow,
    Alignment: n.alignment,
    MarginV: n.margin,
    MarginL: n.margin,
    MarginR: n.margin,
  }
  return Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(',')
}

// ── Legacy adapters ─────────────────────────────────────────────────────────
//
// Both signatures predate the style document and are still what the older call
// sites and tests use. They normalise and delegate — there is no second
// implementation to drift. `subtitle-ass.test.ts` pins their output against
// golden fixtures captured from the v1 engine, so "identical rendering for an
// old-shaped style" is a checked property rather than a claim.

/** @deprecated Use `buildSubtitleForceStyle(normalizeSubtitleStyle(style))`. */
export function buildAssStyle(style: VideoSubtitleStyle): string {
  return buildSubtitleForceStyle(normalizeSubtitleStyle(style))
}

export type SubtitleAnimation = 'none' | 'fade' | 'pop' | 'slide-up'

/** @deprecated Use `buildSubtitleAssDocument`. */
export function srtToAss(
  cues: SrtCue[],
  style: VideoSubtitleStyle,
  opts: { width: number; height: number; animation: SubtitleAnimation },
): string {
  const normalized = normalizeSubtitleStyle({ ...style, animation: opts.animation })
  return buildSubtitleAssDocument(cues, normalized, { width: opts.width, height: opts.height }).ass
}

/**
 * Minimal SRT validator — accepts well-formed SRT, or coerces VTT into SRT
 * by dropping the `WEBVTT` header, renumbering cues, and rewriting `HH:MM:SS.mmm`
 * into `HH:MM:SS,mmm`.
 */
export function normalizeSrtOrVtt(raw: string, opts?: { source_filename?: string }): { srt: string; cues: number; warnings: string[] } {
  const warnings: string[] = []
  let text = raw.replace(/\r\n/g, '\n').trim()

  // Strip VTT header + NOTE blocks if present.
  const isVtt = /^WEBVTT/i.test(text) || opts?.source_filename?.toLowerCase().endsWith('.vtt')
  if (isVtt) {
    text = text.replace(/^WEBVTT[^\n]*\n+/i, '')
    text = text.replace(/^NOTE[\s\S]*?\n\n/gm, '')
    // VTT timestamps use '.' for ms — SRT expects ','.
    text = text.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')
  }

  // Split into cue blocks by blank lines.
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
  const out: string[] = []
  let idx = 1
  for (const block of blocks) {
    const lines = block.split('\n')
    // If the first line is purely a number, assume it's the original index
    // (which we'll renumber). If not, synthesize one.
    if (/^\d+$/.test(lines[0])) lines.shift()
    if (lines.length < 2) {
      warnings.push(`Skipped malformed cue near index ${idx}`)
      continue
    }
    const timingLine = lines[0]
    if (!/-->/.test(timingLine)) {
      warnings.push(`Skipped cue ${idx}: missing "-->"`)
      continue
    }
    const textLines = lines.slice(1)
    out.push(String(idx))
    out.push(timingLine)
    out.push(textLines.join('\n'))
    out.push('')
    idx++
  }

  return { srt: out.join('\n'), cues: idx - 1, warnings }
}

/** Estimate per-chapter timings given the ordered durations of each
 *  chapter MP3 plus the silence gap that separates them. Source of truth
 *  for the 'chapters' subtitle mode. */
export function chaptersFromDurations(
  items: Array<{ title: string; duration_sec: number }>,
  gap_sec: number,
  /** v1.0.397 — start the timeline at this offset (seconds) so chapter cues
   *  line up with a merged track that begins with an intro. Default 0. */
  start_offset_sec = 0,
): Chapter[] {
  const out: Chapter[] = []
  let cursor = Math.max(0, start_offset_sec)
  for (const it of items) {
    const start = cursor
    const end = cursor + Math.max(0, it.duration_sec)
    out.push({ title: it.title, start_sec: start, end_sec: end })
    cursor = end + Math.max(0, gap_sec)
  }
  return out
}

/**
 * Format a chapter list as the YouTube-description timestamp block:
 *
 *   0:00 Intro
 *   4:32 Chapter 1
 *   12:08 Chapter 2
 *
 * YouTube auto-detects this format and turns it into clickable chapter
 * markers ONLY when:
 *   - the first line starts at 0:00
 *   - timestamps are non-decreasing
 *   - there are at least 3 of them
 *
 * We force the first line to 0:00 (overriding the helper's first start
 * if it was nonzero), and we skip output entirely when fewer than 3
 * chapters are present so an under-3 list doesn't render as broken.
 */
export function formatChapterTimestamps(chapters: Chapter[]): string {
  if (!chapters || chapters.length < 3) return ''
  const lines: string[] = []
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!
    const start = i === 0 ? 0 : Math.max(0, Math.floor(ch.start_sec))
    lines.push(`${formatTimestamp(start)} ${ch.title || `Chapter ${i + 1}`}`)
  }
  return lines.join('\n')
}

/** Format `seconds` as `M:SS` (under 1 hour) or `H:MM:SS`. YouTube
 *  accepts both; the H:MM:SS form kicks in past 60 minutes. */
function formatTimestamp(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }
  return `${m}:${String(sec).padStart(2, '0')}`
}
