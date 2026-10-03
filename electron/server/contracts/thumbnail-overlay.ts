/**
 * The thumbnail template text overlay — ONE implementation shared by the
 * server composer (`lib/thumbnail-composer.ts`, rasterised by sharp/librsvg)
 * and the live preview in the template editor (drawn by the browser).
 *
 * Both sides build the very same SVG document from the very same template, so
 * line breaks, positions, sizes, colours, the dim gradient and accent strokes
 * agree exactly. What can still differ is glyph drawing: the browser and
 * librsvg may pick a slightly different face from a font-family chain and
 * draw letters a hair wider or narrower. That is why the editor labels its
 * preview "final render may differ slightly".
 *
 * SVG-text limitations to know up front:
 *
 *   1. SVG `<text>` does NOT word-wrap. We manually break lines based
 *      on a font-metric ESTIMATE (no librsvg readback, no canvas API
 *      in Node main). The estimate is good enough for Impact / Arial
 *      Black at YouTube thumbnail scale; for narrow / wide custom
 *      fonts the user may need to tune `maxWidth` on the zone.
 *   2. `fontFamily` resolves through the system font catalog. Stick
 *      to fonts every Mac has by default: Impact, Arial Black, Arial,
 *      Helvetica Neue, Georgia, Times New Roman.
 *
 * Pure module: no Node or DOM APIs, so the frontend imports it through the
 * `@shared` alias.
 */

type XAnchor = 'left' | 'center' | 'right'
type YAnchor = 'top' | 'middle' | 'bottom'

/** Structural subset of models/types.ts ThumbnailTextZone. */
export interface OverlayTextZone {
  name: string
  defaultText?: string
  x: XAnchor
  y: YAnchor
  xOffset?: number
  yOffset?: number
  maxWidth: number
  fontFamily: string
  fontSize: number
  fontWeight?: 'normal' | 'bold' | 'black' | number | string
  fill?: string
  letterSpacing?: number
  uppercase?: boolean
  lineHeight?: number
  textAnchor?: 'start' | 'middle' | 'end'
  shadow?: { dx?: number; dy?: number; blur?: number; color?: string }
  wrapTuningMultiplier?: number
}

/** Structural subset of models/types.ts ThumbnailTemplate. */
export interface OverlayTemplate {
  canvas?: { width: number; height: number }
  backgroundDimGradient?: {
    side: 'left' | 'right' | 'top' | 'bottom' | 'full'
    coverage?: number
    color?: string
    strength?: number
  }
  textZones?: OverlayTextZone[]
  accentStrokes?: Array<{ x: XAnchor; xOffset?: number; y: number; width: number; thickness?: number; color?: string }>
}

export interface OverlayText {
  /** Text overrides keyed by zone `name`; falls back to the zone's defaultText. */
  textByZone?: Record<string, string>
  /** Substitution context for `{episode_title}` / `{episode_code}` / `{niche_name}`. */
  context?: { episode_title?: string; episode_code?: string; niche_name?: string }
}

export interface TextZoneLayout {
  lines: string[]
  /** SVG text-anchor x (canvas px). */
  x: number
  anchor: 'start' | 'middle' | 'end'
  firstBaseline: number
  lineStep: number
  weight: number
  letterSpacing: number
  /** The block the zone occupies: maxWidth wide, one line step per line
   *  (at least one), top at the first line's em-box top. Canvas px. */
  box: { left: number; top: number; width: number; height: number }
}

export const DEFAULT_THUMBNAIL_CANVAS = { width: 1920, height: 1080 }

/** The neutral "where the portrait goes" background used by template
 *  previews (server preview.png and the editor's live preview). */
export const THUMBNAIL_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
    <defs>
      <radialGradient id="bg" cx="50%" cy="60%" r="75%">
        <stop offset="0%" stop-color="#3a3a52" stop-opacity="1"/>
        <stop offset="60%" stop-color="#1c1c2a" stop-opacity="1"/>
        <stop offset="100%" stop-color="#0a0a14" stop-opacity="1"/>
      </radialGradient>
      <radialGradient id="lit" cx="35%" cy="50%" r="22%">
        <stop offset="0%" stop-color="#8b7a5e" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="#8b7a5e" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1920" height="1080" fill="url(#bg)"/>
    <ellipse cx="672" cy="540" rx="380" ry="450" fill="url(#lit)"/>
    <text x="672" y="560" text-anchor="middle"
          font-family="'Helvetica Neue', Arial, sans-serif"
          font-size="34" fill="#ffffff" fill-opacity="0.32"
          letter-spacing="6">PLACEHOLDER PORTRAIT</text>
  </svg>`

/** The text a template PREVIEW paints: the sample title goes into the
 *  `title` zone and `{episode_title}`; `{niche_name}` reads PREVIEW. Used by
 *  the server's preview.png and the editor's live preview alike. */
export function previewOverlayText(sampleTitle: string): OverlayText {
  return { textByZone: { title: sampleTitle }, context: { episode_title: sampleTitle, niche_name: 'PREVIEW' } }
}

/** Resolve the text one zone paints: override > defaultText, placeholders
 *  substituted, uppercased when the zone asks. Empty string = nothing. */
export function resolveZoneText(z: OverlayTextZone, input: OverlayText): string {
  let text = input.textByZone?.[z.name] ?? z.defaultText ?? ''
  text = substitute(text, input.context || {})
  if (!text.trim()) return ''
  return z.uppercase ? text.toUpperCase() : text
}

/** Where and how one text zone is laid out on the canvas. */
export function layoutTextZone(
  z: OverlayTextZone,
  canvas: { width: number; height: number },
  input: OverlayText,
): TextZoneLayout {
  const text = resolveZoneText(z, input)
  const weight = typeof z.fontWeight === 'number'
    ? z.fontWeight
    : (z.fontWeight === 'black' ? 900 : z.fontWeight === 'bold' ? 700 : Number(z.fontWeight) || 400)
  const letterSpacing = z.letterSpacing ?? 0
  const tuning = typeof z.wrapTuningMultiplier === 'number' && z.wrapTuningMultiplier > 0
    ? z.wrapTuningMultiplier
    : 1
  const lines = text ? wrapText(text, z.maxWidth, z.fontSize, weight, letterSpacing, tuning) : []

  const anchor = z.textAnchor || (z.x === 'left' ? 'start' : z.x === 'right' ? 'end' : 'middle')
  const xOff = z.xOffset ?? 0
  let x: number
  if (z.x === 'left') x = xOff
  else if (z.x === 'right') x = canvas.width - xOff
  else x = canvas.width / 2 + xOff

  const lineStep = z.fontSize * (z.lineHeight ?? 1.1)
  const blockH = lineStep * Math.max(1, lines.length)

  // Baseline of the FIRST line. For y='bottom', the last line's
  // baseline sits at canvas.height - yOff; for y='top', the first
  // line's baseline sits at yOff + fontSize (so the cap-height aligns
  // visually at yOff); for y='middle', center the block.
  const yOff = z.yOffset ?? 0
  let firstBaseline: number
  if (z.y === 'top') firstBaseline = yOff + z.fontSize
  else if (z.y === 'bottom') firstBaseline = canvas.height - yOff - (blockH - z.fontSize)
  else firstBaseline = (canvas.height - blockH) / 2 + yOff + z.fontSize

  const left = anchor === 'start' ? x : anchor === 'end' ? x - z.maxWidth : x - z.maxWidth / 2
  return {
    lines, x, anchor, firstBaseline, lineStep, weight, letterSpacing,
    box: { left, top: firstBaseline - z.fontSize, width: z.maxWidth, height: blockH },
  }
}

/** Build the full-canvas SVG (dim gradient + accent strokes + text) that is
 *  composited over the background. */
export function buildOverlaySvg(tmpl: OverlayTemplate, input: OverlayText = {}): string {
  const canvas = tmpl.canvas || DEFAULT_THUMBNAIL_CANVAS
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`,
  )

  // ── Gradient dim ────────────────────────────────────────────────────
  if (tmpl.backgroundDimGradient) {
    const g = tmpl.backgroundDimGradient
    const coverage = g.coverage ?? 0.6
    const strength = Math.min(1, Math.max(0, g.strength ?? 0.7))
    const color = escapeAttr(g.color || '#000000')
    // SVG linear gradients take coords in 0..1 by default
    // (gradientUnits=objectBoundingBox).
    let x1 = 0, y1 = 0, x2 = 0, y2 = 0
    const stopAOffset = 0, stopBOffset = 1
    let aOpacity = 0, bOpacity = strength
    if (g.side === 'right') {
      x1 = 1 - coverage; y1 = 0.5; x2 = 1; y2 = 0.5
    } else if (g.side === 'left') {
      x1 = 0; y1 = 0.5; x2 = coverage; y2 = 0.5
      aOpacity = strength; bOpacity = 0
    } else if (g.side === 'top') {
      x1 = 0.5; y1 = 0; x2 = 0.5; y2 = coverage
      aOpacity = strength; bOpacity = 0
    } else if (g.side === 'bottom') {
      x1 = 0.5; y1 = 1 - coverage; x2 = 0.5; y2 = 1
    } else /* full */ {
      x1 = 0; y1 = 0.5; x2 = 1; y2 = 0.5
      aOpacity = strength; bOpacity = strength
    }
    parts.push(
      `<defs><linearGradient id="dim" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`,
      `<stop offset="${stopAOffset}" stop-color="${color}" stop-opacity="${aOpacity}"/>`,
      `<stop offset="${stopBOffset}" stop-color="${color}" stop-opacity="${bOpacity}"/>`,
      `</linearGradient></defs>`,
      `<rect x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="url(#dim)"/>`,
    )
  }

  // ── Accent strokes (horizontal rules / dividers) ────────────────────
  for (const s of tmpl.accentStrokes || []) {
    const thickness = s.thickness ?? 4
    const color = escapeAttr(s.color || '#ffffff')
    const xOff = s.xOffset ?? 0
    let cx: number
    if (s.x === 'left') cx = xOff
    else if (s.x === 'right') cx = canvas.width - xOff
    else cx = canvas.width / 2 + xOff
    parts.push(
      `<line x1="${cx - s.width / 2}" y1="${s.y}" x2="${cx + s.width / 2}" y2="${s.y}" stroke="${color}" stroke-width="${thickness}" stroke-linecap="square"/>`,
    )
  }

  // ── Text zones ──────────────────────────────────────────────────────
  for (const z of tmpl.textZones || []) parts.push(renderTextZone(z, canvas, input))

  parts.push(`</svg>`)
  return parts.join('')
}

function renderTextZone(
  z: OverlayTextZone,
  canvas: { width: number; height: number },
  input: OverlayText,
): string {
  const l = layoutTextZone(z, canvas, input)
  if (!l.lines.length) return ''

  // Drop shadow via SVG filter (one filter per zone to avoid id
  // collisions when multiple zones declare shadows).
  let filterDefs = ''
  let filterAttr = ''
  if (z.shadow) {
    const filterId = `shadow-${z.name.replace(/[^a-z0-9_-]/gi, '')}`
    const sh = z.shadow
    filterDefs = `<defs><filter id="${filterId}" x="-20%" y="-20%" width="140%" height="140%">`
      + `<feDropShadow dx="${sh.dx ?? 0}" dy="${sh.dy ?? 3}" stdDeviation="${(sh.blur ?? 10) / 2}" flood-color="${escapeAttr(sh.color || '#000000')}" flood-opacity="0.85"/>`
      + `</filter></defs>`
    filterAttr = ` filter="url(#${filterId})"`
  }

  // One <tspan> per line; dy steps the cursor down by `lineStep`.
  const tspans = l.lines.map((line, i) =>
    `<tspan x="${l.x}" dy="${i === 0 ? 0 : l.lineStep}">${escapeXml(line)}</tspan>`,
  ).join('')

  return filterDefs
    + `<text x="${l.x}" y="${l.firstBaseline}"`
    + ` font-family="${escapeAttr(z.fontFamily)}"`
    + ` font-size="${z.fontSize}"`
    + ` font-weight="${l.weight}"`
    + ` fill="${escapeAttr(z.fill || '#ffffff')}"`
    + ` text-anchor="${l.anchor}"`
    + (l.letterSpacing ? ` letter-spacing="${l.letterSpacing}"` : '')
    + filterAttr
    + `>${tspans}</text>`
}

/**
 * Per-character width estimate. Librsvg doesn't expose font metrics to
 * Node, so we approximate by class: NARROW glyphs take ~half the baseline
 * width, WIDE glyphs ~1.6×, everything else the baseline (a function of
 * fontSize + weight). Tuned against Impact / Arial Black at YouTube
 * thumbnail scale; for other fonts dial the zone's `wrapTuningMultiplier`.
 */
const NARROW_CHARS = new Set([
  'i', 'I', 'l', 'L', 'j', 'J', '1', 'f', 't', 'r',
  '.', ',', ';', ':', '!', '|', '\'', '`', '(', ')', '[', ']',
])
const WIDE_CHARS = new Set(['M', 'W', 'm', 'w', 'Q', '@', '%', '&', '#'])

function baselineCharWidth(fontSize: number, fontWeight: number): number {
  if (fontWeight >= 800) return fontSize * 0.5   // Impact / Arial Black
  if (fontWeight >= 600) return fontSize * 0.55  // semibold sans
  return fontSize * 0.58                          // regular sans / serif
}

function charWidth(c: string, fontSize: number, fontWeight: number): number {
  const base = baselineCharWidth(fontSize, fontWeight)
  if (NARROW_CHARS.has(c)) return base * 0.5
  if (WIDE_CHARS.has(c)) return base * 1.6
  if (c === ' ') return base * 0.55
  return base
}

function measureText(s: string, fontSize: number, fontWeight: number, letterSpacing: number): number {
  let w = 0
  for (let i = 0; i < s.length; i++) w += charWidth(s[i]!, fontSize, fontWeight) + letterSpacing
  return w - letterSpacing // no spacing after the last glyph
}

/** Word-wrap `text` into lines that fit `maxWidth` (estimated widths).
 *  `tuningMultiplier` > 1 wraps later, < 1 wraps sooner. */
function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontWeight: number,
  letterSpacing: number,
  tuningMultiplier = 1,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const budget = maxWidth / Math.max(0.1, tuningMultiplier)
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w
    if (measureText(candidate, fontSize, fontWeight, letterSpacing) > budget && current) {
      lines.push(current)
      current = w
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines
}

function substitute(
  text: string,
  ctx: { episode_title?: string; episode_code?: string; niche_name?: string },
): string {
  return text
    .replace(/\{episode_title\}/g, ctx.episode_title ?? '')
    .replace(/\{episode_code\}/g, ctx.episode_code ?? '')
    .replace(/\{niche_name\}/g, ctx.niche_name ?? '')
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
