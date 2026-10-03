/**
 * The shapes the Video Assembly picker offers (v1.4.15).
 *
 * ── This list is a convenience, not a constraint ──
 *
 * The assembler PARSES the ratio it is given rather than matching it against a
 * list: `resolveRenderCanvas` in `electron/server/lib/render-canvas.ts` turns
 * any `W:H` string into a canvas, so nothing here limits what can be rendered.
 * That matters because the owner's standing rule is that a thing he might want
 * different later is data, not a constant — and the deepest version of that is
 * an engine with no list at all.
 *
 * What this array does is decide which shapes are one click away. A format that
 * recommends something else (`imagePrompts.recommendedAspect`) has its shape
 * ADDED to the picker automatically by `aspectRatioOptions()` below, so a
 * channel set to 4:5 gets 4:5 in its picker without anyone editing this file.
 * Adding a shape here is a one-line data edit with no other code to change.
 */

export interface AspectRatioOption {
  value: string
  label: string
}

export const COMMON_ASPECT_RATIOS: AspectRatioOption[] = [
  { value: '16:9', label: '16:9 — Widescreen (YouTube standard)' },
  { value: '9:16', label: '9:16 — Vertical (Shorts, Reels, TikTok)' },
  { value: '1:1', label: '1:1 — Square' },
  { value: '4:5', label: '4:5 — Portrait (Instagram feed)' },
  { value: '21:9', label: '21:9 — Ultrawide' },
]

export const DEFAULT_ASPECT_RATIO = '16:9'

/** `'9:16'` → `{ w: 9, h: 16 }`. Mirrors the backend parser deliberately. */
export function parseAspectRatio(value?: string | null): { w: number; h: number } | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i)
  if (!match) return null
  const w = Number(match[1])
  const h = Number(match[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { w, h }
}

const SHORT_EDGE: Record<string, number> = { '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160 }

/** The exact frame a given pair will render at, so the picker can show it. */
export function canvasFor(resolution?: string | null, aspect?: string | null): { w: number; h: number } {
  const short = SHORT_EDGE[resolution || ''] ?? 1080
  const ratio = parseAspectRatio(aspect) ?? parseAspectRatio(DEFAULT_ASPECT_RATIO)!
  const even = (v: number) => { const r = Math.round(v); return r % 2 === 0 ? r : r + 1 }
  return ratio.w >= ratio.h
    ? { w: even((short * ratio.w) / ratio.h), h: even(short) }
    : { w: even(short), h: even((short * ratio.h) / ratio.w) }
}

/**
 * The picker's options, with any shape the project or the format is already
 * using folded in — a saved preset from a channel set to something exotic must
 * never silently snap to the nearest listed shape.
 */
export function aspectRatioOptions(...alsoInclude: (string | null | undefined)[]): AspectRatioOption[] {
  const out = [...COMMON_ASPECT_RATIOS]
  for (const extra of alsoInclude) {
    if (!extra || !parseAspectRatio(extra)) continue
    if (out.some(o => o.value === extra)) continue
    out.push({ value: extra, label: `${extra} — from this channel's format` })
  }
  return out
}
