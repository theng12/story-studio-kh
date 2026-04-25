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
