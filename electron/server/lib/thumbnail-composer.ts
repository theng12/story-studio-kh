/**
 * Niche-templated thumbnail composer (v1.0.104+).
 *
 * Takes a source image and a ThumbnailTemplate, then returns a PNG buffer with
 * the template's text shape composited over it. The whole point is so the
 * user can drop a randomized portrait into the Compose modal and get
 * back the SAME thumbnail layout the channel always uses — title text
 * baked in, subtitle banner baked in, accent rule, logo slot.
 *
 * SVG-text limitations to know up front:
 *
 *   1. SVG `<text>` does NOT word-wrap. We manually break lines based
 *      on a font-metric ESTIMATE (no librsvg readback, no canvas API
 *      in Node main). The estimate is good enough for Impact / Arial
 *      Black at YouTube thumbnail scale; for narrow / wide custom
 *      fonts the user may need to tune `maxWidth` on the zone.
 *   2. `fontFamily` resolves through librsvg's system catalog. Stick
 *      to fonts every Mac has by default: Impact, Arial Black, Arial,
 *      Helvetica Neue, Georgia, Times New Roman. Custom fonts only
 *      work if they're installed at the OS level — we don't ship our
 *      own font assets yet.
 *   3. We composite via sharp's `.composite()`. The portrait is the
 *      base, then a single full-canvas SVG with gradient + strokes +
 *      text, then (optionally) a separate logo image. Order matters:
 *      gradient renders BELOW text in the SVG via z-order.
 */

import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import fsp from 'fs/promises'
import type {
  ThumbnailTemplate,
  ThumbnailTextZone,
  ThumbnailAccentStroke,
} from '../models/types.js'

export interface ComposeInput {
  /** Source image path on disk (the portrait/background). */
  sourcePath: string
  /** Layout template. v1.0.105+ takes the template directly (decoupled
   *  from niches) — the route is responsible for resolving the
   *  effective template via the loader's project-override → niche-default chain. */
  template: ThumbnailTemplate
  /** Text overrides keyed by zone `name`. Empty / undefined falls
   *  back to the zone's `defaultText` (with placeholder substitution
   *  applied). Example: `{ title: "A Prayer for Anxious Hearts" }`. */
  textByZone?: Record<string, string>
  /** Substitution context for `{episode_title}` / `{episode_code}` /
   *  `{niche_name}` in zone `defaultText`. */
  context?: {
    episode_title?: string
    episode_code?: string
    niche_name?: string
  }
  /** Optional logo image — local path or already-fetched buffer. If
   *  the template has a `logoSlot` AND this is provided, the logo is
   *  composited at the slot position. */
  logo?: { buffer?: Buffer; path?: string }
}

/**
 * Compose a thumbnail. Returns a PNG buffer ready to write to disk.
 *
 * Throws when no template is supplied.
 */
export async function composeThumbnail(input: ComposeInput): Promise<Buffer> {
  const tmpl = input.template
  if (!tmpl) {
    throw new Error('composeThumbnail called without a template — pass an effective ThumbnailTemplate (see thumbnail-template-loader).')
  }
  const canvas = tmpl.canvas || { width: 1920, height: 1080 }

  // 1. Resize source image to canvas size, cover-fit (crops to fill).
  //    `position: 'attention'` lets sharp pick the salient region; for
  //    portraits this keeps the face on canvas instead of cropping it
  //    out from one side.
  const baseBuf = await sharp(input.sourcePath)
    .resize(canvas.width, canvas.height, { fit: 'cover', position: 'attention' })
    .toBuffer()

  // 2. Build the full-canvas SVG overlay (gradient + strokes + text).
  const overlaySvg = buildOverlaySvg(tmpl, canvas, input)
  const overlayBuf = Buffer.from(overlaySvg, 'utf8')

  // 3. Composite. SVG overlay on top of base portrait.
  const layers: OverlayOptions[] = [
    { input: overlayBuf, top: 0, left: 0 },
  ]

  // 4. Optional logo overlay — composited LAST (above text), so the
  //    user's channel mark stays readable even if a text zone overlaps
  //    its slot.
  if (tmpl.logoSlot && (input.logo?.buffer || input.logo?.path)) {
    const logoBytes = input.logo.buffer
      ?? await fsp.readFile(input.logo.path!)
    // Resize to slot width; height auto. PNG output preserves alpha
    // so transparent logos composite cleanly.
    const logoBuf = await sharp(logoBytes)
      .resize({ width: tmpl.logoSlot.width })
      .png()
      .toBuffer()
    const logoMeta = await sharp(logoBuf).metadata()
    const logoH = logoMeta.height || tmpl.logoSlot.width
    const { left, top } = resolveAnchor(
      tmpl.logoSlot.x, tmpl.logoSlot.y,
      tmpl.logoSlot.xOffset ?? 0, tmpl.logoSlot.yOffset ?? 0,
      canvas.width, canvas.height,
      tmpl.logoSlot.width, logoH,
    )
    layers.push({ input: logoBuf, top, left })
  }

  const out = await sharp(baseBuf).composite(layers).png().toBuffer()
  return out
}

/**
 * Resolve an anchor (x: left/center/right, y: top/middle/bottom +
 * offsets) into absolute (left, top) for sharp's composite API.
 * Width/height of the painted element are needed to make 'right' /
 * 'bottom' / 'center' anchor by the element's far/center edge.
 */
function resolveAnchor(
  xAnchor: 'left' | 'center' | 'right',
  yAnchor: 'top' | 'middle' | 'bottom',
  xOff: number, yOff: number,
  canvasW: number, canvasH: number,
  elementW: number, elementH: number,
): { left: number; top: number } {
  let left: number
  let top: number
  if (xAnchor === 'left') left = xOff
  else if (xAnchor === 'right') left = canvasW - xOff - elementW
  else /* center */ left = Math.round((canvasW - elementW) / 2) + xOff
  if (yAnchor === 'top') top = yOff
  else if (yAnchor === 'bottom') top = canvasH - yOff - elementH
  else /* middle */ top = Math.round((canvasH - elementH) / 2) + yOff
  return { left: Math.max(0, left), top: Math.max(0, top) }
}

/** Build the SVG that gets composited over the base portrait. */
function buildOverlaySvg(
  tmpl: ThumbnailTemplate,
  canvas: { width: number; height: number },
  input: ComposeInput,
): string {
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`,
  )

  // ── Gradient dim ────────────────────────────────────────────────────
  if (tmpl.backgroundDimGradient) {
    const g = tmpl.backgroundDimGradient
    const coverage = g.coverage ?? 0.6
    const strength = Math.min(1, Math.max(0, g.strength ?? 0.7))
    const color = g.color || '#000000'
    // SVG linear gradients take coords in 0..1 by default
    // (gradientUnits=objectBoundingBox).
    let x1 = 0, y1 = 0, x2 = 0, y2 = 0
    let stopAOffset = 0, stopBOffset = 1
    let aOpacity = 0, bOpacity = strength
    if (g.side === 'right') {
      // Fade from transparent at left edge of gradient zone to dim at
      // the right edge of the canvas. Gradient zone spans from
      // (1-coverage)..1 along x.
      x1 = 1 - coverage; y1 = 0.5
      x2 = 1; y2 = 0.5
    } else if (g.side === 'left') {
      x1 = 0; y1 = 0.5
      x2 = coverage; y2 = 0.5
      aOpacity = strength; bOpacity = 0
    } else if (g.side === 'top') {
      x1 = 0.5; y1 = 0
      x2 = 0.5; y2 = coverage
      aOpacity = strength; bOpacity = 0
    } else if (g.side === 'bottom') {
      x1 = 0.5; y1 = 1 - coverage
      x2 = 0.5; y2 = 1
    } else /* full */ {
      // Solid dim across the entire canvas.
      x1 = 0; y1 = 0.5; x2 = 1; y2 = 0.5
      aOpacity = strength; bOpacity = strength
      stopAOffset = 0; stopBOffset = 1
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
    const strokeW = s.width
    const thickness = s.thickness ?? 4
    const color = s.color || '#ffffff'
    const xOff = s.xOffset ?? 0
    let cx: number
    if (s.x === 'left') cx = xOff
    else if (s.x === 'right') cx = canvas.width - xOff
    else cx = canvas.width / 2 + xOff
    const x1 = cx - strokeW / 2
    const x2 = cx + strokeW / 2
    parts.push(
      `<line x1="${x1}" y1="${s.y}" x2="${x2}" y2="${s.y}" stroke="${color}" stroke-width="${thickness}" stroke-linecap="square"/>`,
    )
  }

  // ── Text zones ──────────────────────────────────────────────────────
  for (const z of tmpl.textZones || []) {
    parts.push(renderTextZone(z, canvas, input))
  }

  parts.push(`</svg>`)
  return parts.join('')
}

/**
 * Render one text zone as SVG. Handles substitution, uppercase, manual
 * line wrapping, and drop shadow via SVG filter.
 */
function renderTextZone(
  z: ThumbnailTextZone,
  canvas: { width: number; height: number },
  input: ComposeInput,
): string {
  // 1. Resolve text — explicit override > defaultText with placeholders.
  let text = input.textByZone?.[z.name] ?? z.defaultText ?? ''
  text = substitute(text, input.context || {})
  if (!text.trim()) return '' // nothing to render
  if (z.uppercase) text = text.toUpperCase()

  // 2. Wrap to fit maxWidth.
  const weight = typeof z.fontWeight === 'number'
    ? z.fontWeight
    : (z.fontWeight === 'black' ? 900 : z.fontWeight === 'bold' ? 700 : 400)
  const letterSpacing = z.letterSpacing ?? 0
  const tuning = typeof z.wrapTuningMultiplier === 'number' && z.wrapTuningMultiplier > 0
    ? z.wrapTuningMultiplier
    : 1
  const lines = wrapText(text, z.maxWidth, z.fontSize, weight, letterSpacing, tuning)

  // 3. Anchor + positioning.
  const xAnchor = z.textAnchor || (z.x === 'left' ? 'start' : z.x === 'right' ? 'end' : 'middle')
  const xOff = z.xOffset ?? 0
  let xPos: number
  if (z.x === 'left') xPos = xOff
  else if (z.x === 'right') xPos = canvas.width - xOff
  else xPos = canvas.width / 2 + xOff

  const lineHeight = z.lineHeight ?? 1.1
  const lineStep = z.fontSize * lineHeight
  const blockH = lineStep * lines.length

  // Baseline of the FIRST line. For y='bottom', the last line's
  // baseline sits at canvas.height - yOff; for y='top', the first
  // line's baseline sits at yOff + fontSize (so the cap-height aligns
  // visually at yOff); for y='middle', center the block.
  const yOff = z.yOffset ?? 0
  let firstBaseline: number
  if (z.y === 'top') {
    firstBaseline = yOff + z.fontSize
  } else if (z.y === 'bottom') {
    firstBaseline = canvas.height - yOff - (blockH - z.fontSize)
  } else {
    // Middle: center the visual block around canvas.height/2 + yOff.
    const blockTop = (canvas.height - blockH) / 2 + yOff
    firstBaseline = blockTop + z.fontSize
  }

  // 4. Drop shadow via SVG filter (one filter per zone to avoid id
  //    collisions when multiple zones declare shadows).
  let filterDefs = ''
  let filterAttr = ''
  if (z.shadow) {
    const filterId = `shadow-${z.name.replace(/[^a-z0-9_-]/gi, '')}`
    const sh = z.shadow
    filterDefs = `<defs><filter id="${filterId}" x="-20%" y="-20%" width="140%" height="140%">`
      + `<feDropShadow dx="${sh.dx ?? 0}" dy="${sh.dy ?? 3}" stdDeviation="${(sh.blur ?? 10) / 2}" flood-color="${sh.color || '#000000'}" flood-opacity="0.85"/>`
      + `</filter></defs>`
    filterAttr = ` filter="url(#${filterId})"`
  }

  // 5. Build the <text> with one <tspan> per line. tspan dy steps the
  //    cursor down by `lineStep` from the previous line.
  const tspans = lines.map((line, i) =>
    `<tspan x="${xPos}" dy="${i === 0 ? 0 : lineStep}">${escapeXml(line)}</tspan>`,
  ).join('')

  return [
    filterDefs,
    `<text x="${xPos}" y="${firstBaseline}"`
      + ` font-family="${escapeAttr(z.fontFamily)}"`
      + ` font-size="${z.fontSize}"`
      + ` font-weight="${weight}"`
      + ` fill="${z.fill || '#ffffff'}"`
      + ` text-anchor="${xAnchor}"`
      + (letterSpacing ? ` letter-spacing="${letterSpacing}"` : '')
      + filterAttr
      + `>${tspans}</text>`,
  ].join('')
}

/**
 * Per-character width estimate. Librsvg doesn't expose font metrics to
 * Node, so we approximate by class:
 *
 *   - NARROW glyphs (i, l, j, 1, punctuation, etc.) take ~half the
 *     baseline width
 *   - WIDE glyphs (M, W, m, w, %, @, etc.) take ~1.6×
 *   - Everything else uses the baseline (a function of fontSize + weight)
 *
 * Tuned against Impact / Arial Black at YouTube thumbnail scale
 * (fontSize ~70-140). For other fonts, dial the zone's
 * `wrapTuningMultiplier` in the niche JSON — see ThumbnailTextZone.
 */
const NARROW_CHARS = new Set([
  'i', 'I', 'l', 'L', 'j', 'J', '1', 'f', 't', 'r',
  '.', ',', ';', ':', '!', '|', '\'', '`', '(', ')', '[', ']',
])
const WIDE_CHARS = new Set([
  'M', 'W', 'm', 'w', 'Q', '@', '%', '&', '#',
])

function baselineCharWidth(fontSize: number, fontWeight: number): number {
  if (fontWeight >= 800) return fontSize * 0.5   // Impact / Arial Black
  if (fontWeight >= 600) return fontSize * 0.55  // semibold sans
  return fontSize * 0.58                          // regular sans / serif
}

/** Visual width of one glyph, in px. */
function charWidth(c: string, fontSize: number, fontWeight: number): number {
  const base = baselineCharWidth(fontSize, fontWeight)
  if (NARROW_CHARS.has(c)) return base * 0.5
  if (WIDE_CHARS.has(c)) return base * 1.6
  if (c === ' ') return base * 0.55
  return base
}

/** Sum visual widths across a string. Includes per-glyph variance plus
 *  the per-glyph letter-spacing the SVG will apply at render time. */
function measureText(
  s: string,
  fontSize: number,
  fontWeight: number,
  letterSpacing: number,
): number {
  let w = 0
  for (let i = 0; i < s.length; i++) {
    w += charWidth(s[i]!, fontSize, fontWeight) + letterSpacing
  }
  return w - letterSpacing // no spacing after the last glyph
}

/**
 * Word-wrap `text` into lines that fit `maxWidth`. Uses the per-
 * character estimate above so narrow-heavy strings ("INVITATION TO
 * PEACE") don't wrap one word early. `tuningMultiplier` (default 1)
 * lets the niche template dial wrapping looser (>1) or tighter (<1)
 * for non-stock fonts.
 */
function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontWeight: number,
  letterSpacing: number,
  tuningMultiplier: number = 1,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  // Divide budget by the tuning multiplier so >1 expands the budget
  // (text wraps later) and <1 shrinks it (text wraps earlier).
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

/** Substitute {episode_title} / {episode_code} / {niche_name} in a
 *  defaultText string. Unknown placeholders pass through unchanged. */
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
  return s.replace(/"/g, '&quot;')
}
