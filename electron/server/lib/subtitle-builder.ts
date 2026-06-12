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

export interface Chapter {
  title: string
  start_sec: number
  end_sec: number
}

/** Convert a list of chapters into a valid SRT string. Each chapter is one
 *  cue, displayed for the full chapter window. That matches how audiobook-
 *  style sleep stories tend to use subtitles (section markers, not word-
 *  for-word captions). For word-level subtitling, use Whisper instead. */
export function chaptersToSrt(chapters: Chapter[], opts?: { max_lines?: number; max_chars_per_line?: number }): string {
  const max_chars = opts?.max_chars_per_line ?? 42
  const max_lines = opts?.max_lines ?? 2
  const parts: string[] = []
  let idx = 1
  for (const c of chapters) {
    if (c.end_sec <= c.start_sec) continue
    const wrapped = wrapText(c.title, max_chars, max_lines)
    parts.push(String(idx))
    parts.push(`${formatSrtTime(c.start_sec)} --> ${formatSrtTime(c.end_sec)}`)
    parts.push(wrapped)
    parts.push('')
    idx++
  }
  return parts.join('\n')
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
 * Build the libass `force_style=...` fragment for the `subtitles=` filter.
 * Colours are encoded as `&HBBGGRR&` (yes, reversed — that's an ASS quirk).
 * Alignment / outline / background controls map to libass's Style Override
 * parameter names.
 */
export function buildAssStyle(style: VideoSubtitleStyle): string {
  const fontName = style.font_family || 'Helvetica'
  const fontSize = style.font_size_px || 28

  // Libass numeric alignment: 1=bottom-left, 2=bottom-center, 3=bottom-right,
  // 4=middle-left, 5=middle-center, 6=middle-right,
  // 7=top-left, 8=top-center, 9=top-right.
  const vBase = style.position === 'top' ? 7 : style.position === 'center' ? 4 : 1
  const hOffset = style.align === 'center' ? 1 : style.align === 'right' ? 2 : 0
  const alignment = vBase + hOffset

  // Libass BorderStyle: 1 = outlined, 3 = opaque box.
  const borderStyle = style.background === 'full' ? 3 : style.background === 'semi' ? 3 : 1
  const backColour = style.background === 'full'
    ? '&H00000000&'   // solid black box
    : style.background === 'semi'
      ? '&H80000000&'  // 50% black
      : '&H00000000&'  // invisible (outlined mode ignores BackColour anyway)

  const outline = Math.max(0, Math.min(style.outline_px ?? 2, 6))

  const parts: Record<string, string | number> = {
    FontName: fontName,
    FontSize: fontSize,
    PrimaryColour: hexToAss(style.color_hex || '#FFFFFF'),
    OutlineColour: hexToAss(style.outline_color_hex || '#000000'),
    BackColour: backColour,
    BorderStyle: borderStyle,
    Outline: outline,
    Shadow: 0,
    Alignment: alignment,
    MarginV: 40,
    MarginL: 40,
    MarginR: 40,
  }

  return Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(',')
}

/** Convert `#RRGGBB` to libass `&HBBGGRRAA&` (alpha = 0 = opaque). */
function hexToAss(hex: string): string {
  const cleaned = hex.replace('#', '').padStart(6, '0').toLowerCase()
  const r = cleaned.slice(0, 2)
  const g = cleaned.slice(2, 4)
  const b = cleaned.slice(4, 6)
  return `&H00${b}${g}${r}&`
}

// ── v1.0.353 — animated captions (full ASS document) ────────────────────────
//
// `force_style` on the `subtitles=` filter can only set a static style — it
// can't animate. For an entrance animation we render a complete ASS file and
// burn it with the `ass=` filter instead. SRT cues → ASS Dialogue lines, each
// prefixed with the chosen animation's override tags.

export type SubtitleAnimation = 'none' | 'fade' | 'pop' | 'slide-up'

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

/** Per-line override tags for the entrance animation. `\move`/`\pos` anchor on
 *  the style's alignment point, so slide-up's coords are derived from the
 *  resolution + position/align + margin. */
function animationTag(animation: SubtitleAnimation, style: VideoSubtitleStyle, w: number, h: number): string {
  if (animation === 'fade') return '{\\fad(180,180)}'
  if (animation === 'pop') return '{\\fad(60,60)\\fscx72\\fscy72\\t(0,150,\\fscx100\\fscy100)}'
  if (animation === 'slide-up') {
    const marginV = 40
    const x = style.align === 'left' ? 40 : style.align === 'right' ? Math.max(40, w - 40) : Math.round(w / 2)
    const yEnd = style.position === 'top' ? marginV : style.position === 'center' ? Math.round(h / 2) : Math.max(marginV, h - marginV)
    const yStart = style.position === 'top' ? Math.max(0, yEnd - 36) : yEnd + 36
    return `{\\fad(160,80)\\move(${x},${yStart},${x},${yEnd})}`
  }
  return ''
}

/**
 * Render SRT cues into a complete ASS document with the user's style + an
 * entrance animation per line. Used by video.ts when `style.animation` is set;
 * the static `force_style` path stays for `animation: 'none'`.
 */
export function srtToAss(
  cues: SrtCue[],
  style: VideoSubtitleStyle,
  opts: { width: number; height: number; animation: SubtitleAnimation },
): string {
  const w = Math.max(2, Math.round(opts.width || 1920))
  const h = Math.max(2, Math.round(opts.height || 1080))
  const fontName = style.font_family || 'Helvetica'
  const fontSize = style.font_size_px || 28
  const vBase = style.position === 'top' ? 7 : style.position === 'center' ? 4 : 1
  const hOffset = style.align === 'center' ? 1 : style.align === 'right' ? 2 : 0
  const alignment = vBase + hOffset
  const borderStyle = (style.background === 'full' || style.background === 'semi') ? 3 : 1
  const backColour = style.background === 'full' ? '&H00000000' : style.background === 'semi' ? '&H80000000' : '&H00000000'
  const outline = Math.max(0, Math.min(style.outline_px ?? 2, 6))
  const primary = hexToAss(style.color_hex || '#FFFFFF').replace(/&$/, '')
  const outlineCol = hexToAss(style.outline_color_hex || '#000000').replace(/&$/, '')
  const maxChars = style.max_chars_per_line ?? 42
  const maxLines = style.max_lines ?? 2

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize},${primary},${primary},${outlineCol},${backColour},0,0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},40,40,40,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  const events = cues.map(c => {
    const tag = animationTag(opts.animation, style, w, h)
    // Wrap to the style's width, hard-break with \N, and neutralise any braces
    // in the source text so they can't be read as override blocks.
    const text = wrapText(c.text, maxChars, maxLines).replace(/\r?\n/g, '\\N').replace(/\{/g, '(').replace(/\}/g, ')')
    return `Dialogue: 0,${assTime(c.start_sec)},${assTime(c.end_sec)},Default,,0,0,0,,${tag}${text}`
  })

  return [...header, ...events].join('\n') + '\n'
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
): Chapter[] {
  const out: Chapter[] = []
  let cursor = 0
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
