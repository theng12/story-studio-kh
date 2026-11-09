/**
 * The text layer for a head/outro title card.
 *
 * A title card used to be one `drawtext` call with no wrapping, so any title wider than the frame was
 * clipped at both ends (Origin Field EP0031, 2026-11-08: a 70-character title on one line). This
 * module measures and draws the SAME face Pango will render, wraps and shrinks the block until it
 * fits inside the safe margins, and reports the raster bounds it actually drew. `generators/video.ts`
 * overlays the PNG on the card background, so what was measured is exactly what is in the video.
 *
 * The measurement and drawing primitives are the thumbnail renderer's (`wrapText`, `nearestWeight`,
 * `paintFill`, `buildOutline`, `applyOpacity`) and the bundled-font manifest, not a second renderer.
 */

import crypto from 'node:crypto'
import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import {
  configureFontconfig,
  fontFilePath,
  readFontManifest,
  type FontManifestEntry,
} from './thumbnail-fonts.js'
import { glyphCoverage } from './font-coverage.js'
import { escapePangoMarkup } from './chapter-title-font.js'
import {
  applyOpacity,
  buildOutline,
  nearestWeight,
  paintFill,
  readRgba,
  wrapText,
} from './thumbnail-text-render.js'

/** Pango takes points at 96 dpi, so a requested pixel size is scaled by 96/72. */
const POINTS_PER_PIXEL = 96 / 72
const LINE_HEIGHT = 1.2
const OUTLINE_PX = 2
const OUTLINE_OPACITY = 0.65

/** Where the text block must stay, as a fraction of the frame's short edge (at least 24 px). */
const SAFE_MARGIN_FRACTION = 0.05

export interface TitleCardProof {
  /** The exact text that was drawn. */
  text: string
  /** SHA-256 of `text`; a proof whose hash does not describe its text is not trusted. */
  text_sha256: string
  /** SHA-256 of the rendered transparent text layer, so the proof names the pixels it came from. */
  rendered_sha256: string
  /** Raster ink bounds in frame pixels. `right`/`bottom` are exclusive. */
  bounds: { left: number; top: number; right: number; bottom: number }
  frame: { width: number; height: number }
  safe_margin_px: number
  nonblank_pixels: number
  font_id: string
  font_px: number
  lines: number
}

export interface TitleCardTextLayer {
  png: Buffer
  proof: TitleCardProof
}

export interface TitleCardTextInput {
  text: string
  subtitle?: string
  style: 'gold' | 'white' | 'neon' | 'minimal'
  kind: 'title' | 'outro'
  width: number
  height: number
  /** The size the card has always used for a short title; fitting never grows past it. */
  basePx: number
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeMarginPx(width: number, height: number): number {
  return Math.max(24, Math.round(Math.min(width, height) * SAFE_MARGIN_FRACTION))
}

/** The card's style colour as a real hex value plus its opacity. */
function stylePaint(style: TitleCardTextInput['style']): { color: string, opacity: number } {
  switch (style) {
    case 'gold': return { color: '#FFD700', opacity: 1 }
    case 'neon': return { color: '#00FFCC', opacity: 1 }
    case 'minimal': return { color: '#FFFFFF', opacity: 0.8 }
    default: return { color: '#FFFFFF', opacity: 1 }
  }
}

/**
 * The bundled face that can draw every character of `text`. Inter first (the card's ordinary
 * Latin look), then the Khmer and Han faces, then anything else the build ships.
 */
async function chooseFont(text: string): Promise<FontManifestEntry> {
  const manifest = await readFontManifest()
  const preferred = ['inter', 'kantumruy-pro', 'noto-sans-sc']
    .map(id => manifest.fonts.find(font => font.id === id))
    .filter((font): font is FontManifestEntry => !!font)
  const ordered = [...preferred, ...manifest.fonts.filter(font => !preferred.includes(font))]
  for (const font of ordered) {
    if ((await glyphCoverage(fontFilePath(font), text)).complete) return font
  }
  throw new Error(
    `No bundled font can draw the ${inputSummary(text)}. Choose different title text — nothing was rendered.`,
  )
}

function inputSummary(text: string): string {
  return `title text ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)}`
}

function fontDescription(font: FontManifestEntry, px: number): string {
  return `${font.family} ${nearestWeight(400, font.weights)} ${Math.max(1, Math.round(px * POINTS_PER_PIXEL))}`
}

async function renderLine(text: string, font: FontManifestEntry, px: number): Promise<Buffer> {
  // sharp parses `text` as Pango markup; a literal `&`, `<` or `>` must stay a glyph, never a tag.
  const rendered = await sharp({ text: { text: escapePangoMarkup(text), font: fontDescription(font, px), rgba: true } }).png().toBuffer()
  try {
    return await sharp(rendered).trim({ threshold: 1 }).png().toBuffer()
  } catch {
    return rendered
  }
}

async function sizeOf(png: Buffer): Promise<{ width: number, height: number }> {
  const metadata = await sharp(png).metadata()
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 }
}

interface Block {
  png: Buffer
  width: number
  height: number
}

/** Render the wrapped lines into one block, painted and outlined like the old card. */
async function buildBlock(
  lines: string[],
  font: FontManifestEntry,
  px: number,
  color: string,
  opacity: number,
  outlinePx = OUTLINE_PX,
): Promise<Block> {
  const rendered: Array<{ png: Buffer, width: number, height: number }> = []
  for (const line of lines) {
    const png = await renderLine(line, font, px)
    rendered.push({ png, ...(await sizeOf(png)) })
  }
  const lineHeightPx = Math.max(1, Math.round(px * LINE_HEIGHT))
  const widest = Math.max(1, ...rendered.map(line => line.width))
  const tallest = Math.max(1, ...rendered.map(line => line.height))
  // Actual trimmed ink can be taller than `px * 1.2` (ascenders + descenders), and drawing the next
  // line at that stride let a descender touch the line below (Origin Field preview, 2026-11-09).
  // The stride is the measured tallest ink plus a 2px gap, never less than the old 1.2 line box.
  const stride = Math.max(lineHeightPx, tallest + 2)
  const totalHeight = stride * Math.max(0, rendered.length - 1) + tallest

  const overlays: OverlayOptions[] = []
  let top = 0
  for (const line of rendered) {
    overlays.push({ input: line.png, left: Math.round((widest - line.width) / 2), top })
    top += stride
  }
  const block = await sharp({
    create: { width: widest, height: totalHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(overlays).png().toBuffer()
  const painted = await paintFill(block, { type: 'solid', color })

  const outline = await applyOpacity(await buildOutline(painted, outlinePx, '#000000'), OUTLINE_OPACITY)
  const outlineMeta = await sizeOf(outline)
  const paintedMeta = await sizeOf(painted)
  const composed = await sharp({
    create: { width: outlineMeta.width, height: outlineMeta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([
    { input: outline, left: 0, top: 0 },
    { input: painted, left: Math.round((outlineMeta.width - paintedMeta.width) / 2), top: Math.round((outlineMeta.height - paintedMeta.height) / 2) },
  ]).png().toBuffer()

  const final = await applyOpacity(composed, opacity)
  return { png: final, ...(await sizeOf(final)) }
}

interface Attempt {
  fits: boolean
  titleLines: string[]
  subtitleLines: string[]
  titlePx: number
  subtitlePx: number
  widest: number
  totalHeight: number
}

/**
 * Draw the card text into a full-frame transparent PNG, or refuse loudly.
 *
 * Fitting never grows past `basePx` (a short title keeps today's size), and shrinks only as far as
 * 35% of it; a block that still does not fit is an error naming the measured size, never a clipped
 * or empty card.
 */
export async function renderTitleCardTextLayer(input: TitleCardTextInput): Promise<TitleCardTextLayer> {
  const text = String(input.text || '').trim()
  if (!text) throw new Error('A title card was enabled with no text — nothing was rendered.')
  // A card that cannot possibly be read is refused, not shrunk into illegibility or clipped. The
  // bound also keeps a pathological single token from asking Pango for a 100,000px-wide bitmap.
  if (text.length > 5000) {
    throw new Error(
      `Nothing was rendered: the title card text is ${text.length} characters, too long to fit a `
      + `${input.width}x${input.height} card legibly. Shorten it.`,
    )
  }
  const subtitle = String(input.subtitle || '').trim()
  const width = Math.max(1, Math.round(input.width))
  const height = Math.max(1, Math.round(input.height))
  const margin = safeMarginPx(width, height)
  const usableWidth = Math.max(1, width - margin * 2 - OUTLINE_PX * 2)
  const usableHeight = Math.max(1, height - margin * 2 - OUTLINE_PX * 2)
  const basePx = Math.max(1, Math.round(input.basePx))
  const minPx = Math.max(20, Math.round(basePx * 0.35))

  configureFontconfig()
  const font = await chooseFont(`${text}\n${subtitle}`)
  const paint = stylePaint(input.style)
  const widthCache = new Map<string, number>()

  const measureWidth = async (line: string, px: number): Promise<number> => {
    const key = `${px}\u0000${line}`
    const hit = widthCache.get(key)
    if (hit !== undefined) return hit
    // A token longer than a line is measured at a smaller probe size and scaled linearly. Pango
    // shapes the same glyphs; this only keeps the probe bitmap bounded. Wrapped lines are short and
    // are measured at their real size.
    const measurePx = line.length > 200 ? Math.min(px, 48) : px
    const raw = (await sizeOf(await renderLine(line, font, measurePx))).width
    const value = measurePx === px ? raw : Math.round(raw * (px / measurePx))
    widthCache.set(key, value)
    return value
  }

  const attempt = async (titlePx: number): Promise<Attempt> => {
    if (widthCache.size > 4000) widthCache.clear()
    const subtitlePx = Math.max(22, Math.round(titlePx * 0.48))
    const titleWrapped = await wrapText(text, 1000, usableWidth, line => measureWidth(line, titlePx))
    const subtitleWrapped = subtitle
      ? await wrapText(subtitle, 1000, usableWidth, line => measureWidth(line, subtitlePx))
      : { lines: [] as string[], overflow: false }

    const measureBlock = async (lines: string[], px: number) => {
      const lineHeightPx = Math.max(1, Math.round(px * LINE_HEIGHT))
      let widest = 0
      let tallest = 0
      for (const line of lines) {
        widest = Math.max(widest, await measureWidth(line, px))
        tallest = Math.max(tallest, (await sizeOf(await renderLine(line, font, px))).height)
      }
      const stride = Math.max(lineHeightPx, tallest + 2)
      return { widest, height: stride * Math.max(0, lines.length - 1) + tallest }
    }

    const titleBox = await measureBlock(titleWrapped.lines, titlePx)
    const subtitleBox = subtitleWrapped.lines.length ? await measureBlock(subtitleWrapped.lines, subtitlePx) : null
    const gap = subtitleBox ? Math.round(titlePx * 0.5) : 0
    const totalHeight = titleBox.height + (subtitleBox ? gap + subtitleBox.height : 0)
    const widest = Math.max(titleBox.widest, subtitleBox?.widest ?? 0)
    return {
      fits: !titleWrapped.overflow && !subtitleWrapped.overflow
        && widest <= usableWidth && totalHeight <= usableHeight,
      titleLines: titleWrapped.lines,
      subtitleLines: subtitleWrapped.lines,
      titlePx,
      subtitlePx,
      widest,
      totalHeight,
    }
  }

  // The base size is the existing look. Only when it does not fit does the size shrink; fitting is
  // monotone in px, so a bisection finds the largest size that still fits.
  let best: Attempt | null = null
  const atBase = await attempt(basePx)
  if (atBase.fits) {
    best = atBase
  } else {
    let low = minPx
    let high = basePx
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = await attempt(mid)
      if (candidate.fits) {
        best = candidate
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
  }
  if (!best) {
    const smallest = await attempt(minPx)
    throw new Error(
      `Nothing was rendered: the title card text does not fit inside ${width}x${height} with `
      + `${margin}px safe margins even at ${minPx}px (it measures ${Math.round(smallest.widest)}x`
      + `${Math.round(smallest.totalHeight)}px against ${usableWidth}x${usableHeight}px). `
      + 'Shorten the title or use a wider frame.',
    )
  }

  const titleBlock = await buildBlock(best.titleLines, font, best.titlePx, paint.color, paint.opacity)
  const subtitleBlock = best.subtitleLines.length
    ? await buildBlock(best.subtitleLines, font, best.subtitlePx, '#FFFFFF', 1, 1)
    : null
  const gap = subtitleBlock ? Math.round(best.titlePx * 0.5) : 0
  const totalHeight = titleBlock.height + (subtitleBlock ? gap + subtitleBlock.height : 0)
  const top = Math.round((height - totalHeight) / 2)
  const layers: OverlayOptions[] = [
    { input: titleBlock.png, left: Math.round((width - titleBlock.width) / 2), top },
  ]
  if (subtitleBlock) {
    layers.push({
      input: subtitleBlock.png,
      left: Math.round((width - subtitleBlock.width) / 2),
      top: top + titleBlock.height + gap,
    })
  }

  const png = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(layers).png().toBuffer()

  // Measure the raster that will actually be overlaid. A block that somehow escaped the box is a
  // refusal here, not a clipped card in the finished video.
  const { data } = await readRgba(png)
  let left = width
  let topBound = height
  let right = 0
  let bottom = 0
  let nonblank = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! <= 8) continue
      nonblank += 1
      if (x < left) left = x
      if (y < topBound) topBound = y
      if (x + 1 > right) right = x + 1
      if (y + 1 > bottom) bottom = y + 1
    }
  }
  if (nonblank === 0) {
    throw new Error(`Nothing was rendered: the title card text "${text}" drew no visible pixels.`)
  }
  if (left < margin || topBound < margin || right > width - margin || bottom > height - margin) {
    throw new Error(
      `Nothing was rendered: the title card text drew at ${left},${topBound}-${right},${bottom}, `
      + `outside the ${margin}px safe margins of the ${width}x${height} frame.`,
    )
  }

  return {
    png,
    proof: {
      text,
      text_sha256: sha256(text),
      rendered_sha256: sha256(png),
      bounds: { left, top: topBound, right, bottom },
      frame: { width, height },
      safe_margin_px: margin,
      nonblank_pixels: nonblank,
      font_id: font.id,
      font_px: best.titlePx,
      lines: best.titleLines.length,
    },
  }
}
