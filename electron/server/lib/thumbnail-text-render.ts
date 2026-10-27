/**
 * The thumbnail text renderer.
 *
 * Draws a real headline (Khmer first, any script later) onto a COPY of a text-free thumbnail, at
 * exactly 1280x720, and reports what it did.
 *
 * ## Why the face comes from a Fontconfig directory, not `fontfile`
 *
 * sharp accepts both `text.font` (a Pango font description) and `text.fontfile`. Measured on this
 * build (libvips 8.18.6 / Pango 1.58.2):
 *
 *   - with `fontfile` and **no** `font`, the file is honoured but the size is ignored (a fixed,
 *     far-too-small metric), so a headline cannot be fitted to a box;
 *   - with a family in `font`, `fontfile` is **silently ignored** — Inter, Anton, Moul, Kantumruy
 *     Pro and Battambang all rendered byte-identically, i.e. the system face drew the headline.
 *
 * Neither is acceptable: the first cannot be sized, the second letters the customer's art in a face
 * nobody chose. So `lib/thumbnail-fonts.ts` prepares a Fontconfig configuration that lists the
 * bundled directory, and each face is requested by its real family name — deterministic, correctly
 * sized, and Khmer-shaped. The self-check below relies on a non-existent family resolving
 * differently, which is what proves a request was honoured rather than substituted.
 *
 * ## What the report means
 *
 * `glyphs_complete` / `missing_characters` come from the **font file's own cmap**, never from "it
 * rendered": a fallback face has the glyphs too, so pixels cannot prove coverage (AGENTS §6 — a
 * silent substitution and a correct render must not look the same).
 */

import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import type { ThumbnailTextRenderReport, ThumbnailTextStyle, TextAnchor, TextFill } from '../contracts/thumbnail-text.js'
import { THUMBNAIL_TEXT_CANVAS } from '../contracts/thumbnail-text.js'
import { configureFontconfig, fontFilePath, requireFont, ThumbnailFontError, type FontManifestEntry } from './thumbnail-fonts.js'
import { glyphCoverage } from './font-coverage.js'

/**
 * Pango in this renderer takes points at 96dpi, so a requested pixel size is scaled by 96/72.
 * Measured: requesting 100 yields a ~74px cap height for Inter, matching that ratio.
 */
const POINTS_PER_PIXEL = 96 / 72

/** Weight → Pango's own style word, so the request is unambiguous. */
const WEIGHT_STYLE: Array<[number, string]> = [
  [100, 'Thin'], [200, 'Ultra-Light'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'],
  [600, 'Semi-Bold'], [700, 'Bold'], [800, 'Ultra-Bold'], [900, 'Heavy'],
]

/** The face the self-check requests to prove a family request is really applied. */
const PROBE_FAMILY = 'Story Studio Font Probe (not a real family)'

/** Characters that never carry a line of their own and are not drawn. */
const INVISIBLE = /[​﻿]/

export interface RenderedThumbnail {
  png: Buffer
  report: ThumbnailTextRenderReport
}

export interface RenderInput {
  /** Bytes of the source thumbnail (PNG or JPEG). */
  sourceBytes: Buffer
  text: string
  style: ThumbnailTextStyle
  /**
   * The frame to draw at. Absent means the YouTube thumbnail size, which is what every existing
   * caller gets — so adding this changed no thumbnail by a pixel.
   */
  canvas?: { width: number; height: number }
  /**
   * The channel's mark burned onto the same copy: a handle set in a bundled font and, when one is
   * set, the logo image. Both are optional and both simply draw nothing when disabled, which is
   * why a channel with no logo yet is not a special case anywhere.
   */
  branding?: RenderBranding
}

/**
 * The handle and logo layer.
 *
 * Owner, 2026-10-27: the handle defaults to the channel's own and may be overridden; the logo is a
 * file the owner will make later, so the layer exists now and draws nothing until there is one.
 */
export interface RenderBranding {
  handle: {
    enabled: boolean
    text: string
    font_id: string
    weight: number
    size_px: number
    color: string
    opacity: number
  }
  logo: {
    enabled: boolean
    /** Absolute path to the logo art, or null when the channel has none yet. */
    path: string | null
    /** Logo width, in percent of the canvas width. */
    width_pct: number
    opacity: number
  }
  position: TextAnchor
  /** Distance from the nearest edge, in percent of the canvas. */
  margin_pct: number
}

/** A refusal the route turns into a plain 400 with the message intact. */
export class ThumbnailTextRefusal extends Error {
  /** What the renderer learned before it stopped (why it did not fit, which glyphs are missing). */
  report: ThumbnailTextRenderReport | undefined
  constructor(message: string, report?: ThumbnailTextRenderReport) {
    super(message)
    this.name = 'ThumbnailTextRefusal'
    this.report = report
  }
}

// ── Text segmentation ──────────────────────────────────────────────────────

/** True when `text` has letters with case at all (Khmer does not, so `uppercase` is a no-op there). */
export function textHasCase(text: string): boolean {
  return text.toUpperCase() !== text.toLowerCase()
}

/** Grapheme clusters, so a Khmer cluster (base + coeng + subscript) is never split in two. */
export function graphemes(line: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map(part => part.segment)
  }
  return [...line]
}

/**
 * The points a line may be broken at, greedily: after a space or U+200B, or at an explicit "\n".
 *
 * Khmer writes no inter-word spaces, so a paragraph is very often ONE token — which is why the
 * cluster pass below exists rather than being an edge case.
 */
function breakTokens(paragraph: string): string[] {
  const tokens: string[] = []
  let current = ''
  for (const cluster of graphemes(paragraph)) {
    current += cluster
    if (cluster === ' ' || cluster === '​' || cluster === '\t' || cluster === ' ') {
      tokens.push(current)
      current = ''
    }
  }
  if (current) tokens.push(current)
  return tokens
}

interface Wrapped {
  lines: string[]
  overflow: boolean
}

/**
 * Greedy wrap of `text` at the widest size whose measured width fits `usableWidth`, capped at
 * `maxLines`.
 *
 * `widthOf` measures one line at the candidate size — the only operation that needs the renderer.
 * A token wider than the box is broken between clusters (Khmer's last resort) rather than allowed
 * to overflow.
 */
export async function wrapText(
  text: string,
  maxLines: number,
  usableWidth: number,
  widthOf: (line: string) => Promise<number>,
): Promise<Wrapped> {
  const lines: string[] = []
  let overflow = false

  const pushLine = async (line: string): Promise<void> => {
    const trimmed = line.replace(/[\s​]+$/, '')
    if (!trimmed) return
    lines.push(trimmed)
  }

  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const tokens = breakTokens(paragraph).filter(token => !INVISIBLE.test(token.replace(/[\s​]/g, '')))
    if (!tokens.length) continue
    let current = ''
    for (const token of tokens) {
      const candidate = current + token
      if ((await widthOf(candidate.replace(/[\s​]+$/, ''))) <= usableWidth) {
        current = candidate
        continue
      }
      await pushLine(current)
      current = token
      if ((await widthOf(token.replace(/[\s​]+$/, ''))) <= usableWidth) continue
      // The token alone is too wide: break it between clusters.
      let piece = ''
      for (const cluster of graphemes(token.replace(/[\s​]+$/, ''))) {
        const wider = piece + cluster
        if (piece && (await widthOf(wider)) > usableWidth) {
          await pushLine(piece)
          piece = cluster
        } else {
          piece = wider
        }
      }
      current = piece
    }
    await pushLine(current)
  }

  if (!lines.length) lines.push('')
  const finalLines = lines.slice(0, Math.max(1, maxLines))
  const wasTruncated = lines.length > maxLines
  return { lines: finalLines, overflow: wasTruncated || overflow }
}

// ── Rendering primitives ───────────────────────────────────────────────────

/** Parse `#RRGGBB`/`#RGB`; anything unreadable falls back to white rather than throwing mid-render. */
export function hexToRgb(hex: string): { r: number, g: number, b: number } {
  const value = (hex || '').trim().replace(/^#/, '')
  const expanded = value.length === 3 ? value.split('').map(c => c + c).join('') : value
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return { r: 255, g: 255, b: 255 }
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  }
}

export function nearestWeight(wanted: number): string {
  return WEIGHT_STYLE.reduce(
    (best, entry) => Math.abs(entry[0] - wanted) < Math.abs(best[0] - wanted) ? entry : best,
    WEIGHT_STYLE[3]!,
  )[1]
}

function fontDescription(font: FontManifestEntry, weight: number, px: number): string {
  return `${font.family} ${nearestWeight(weight)} ${Math.max(1, Math.round(px * POINTS_PER_PIXEL))}`
}

function blankLayer(width: number, height: number): import('sharp').Sharp {
  return sharp({
    create: {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
}

/** Render one line and trim it to its ink, so the buffer's size IS the drawn size. */
async function renderLine(text: string, font: FontManifestEntry, weight: number, px: number): Promise<Buffer> {
  const rendered = await sharp({
    text: { text, font: fontDescription(font, weight, px), rgba: true },
  }).png().toBuffer()
  try {
    // threshold 1 drops fully transparent rows/columns only, so antialiasing is not nibbled.
    return await sharp(rendered).trim({ threshold: 1 }).png().toBuffer()
  } catch {
    // A blank line has no ink to trim — keep the untrimmed buffer (its height is the line box).
    return rendered
  }
}

async function sizeOf(png: Buffer): Promise<{ width: number, height: number }> {
  const metadata = await sharp(png).metadata()
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 }
}

/**
 * Read a PNG as raw RGBA bytes.
 *
 * All the effect work below is done on these bytes rather than with libvips blend modes, because
 * `extractChannel('alpha')` returns a greyscale image whose own alpha is opaque — so a `dest-in`
 * composite silently produces a solid rectangle instead of a mask. Raw alpha arithmetic is what
 * makes "the fill colour is really applied" a fact rather than a hope.
 */
export async function readRgba(png: Buffer): Promise<{ data: Buffer, width: number, height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Wrap raw RGBA bytes back into a PNG. */
export async function writeRgba(data: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

/**
 * Colourise a shape: keep its alpha, replace its RGB.
 *
 * Pango fills text with the requested colour (black here) and keeps the shape in the alpha channel,
 * so the colour is applied by rewriting RGB and leaving alpha alone.
 */
async function tint(png: Buffer, color: string): Promise<Buffer> {
  const { data, width, height } = await readRgba(png)
  const { r, g, b } = hexToRgb(color)
  const out = Buffer.from(data)
  for (let index = 0; index < out.length; index += 4) {
    out[index] = r
    out[index + 1] = g
    out[index + 2] = b
  }
  return writeRgba(out, width, height)
}

/** Per-pixel linear blend of the gradient's two colours across the tile at `angle`. */
async function gradientFill(png: Buffer, fill: TextFill): Promise<Buffer> {
  const { data, width, height } = await readRgba(png)
  const from = hexToRgb(fill.color)
  const to = hexToRgb(fill.color2!)
  const angle = Number.isFinite(fill.angle) ? Number(fill.angle) : 90
  const radians = (angle * Math.PI) / 180
  const projected = (x: number, y: number) => x * Math.cos(radians) + y * Math.sin(radians)
  // The gradient runs across the tile's own extent along the angle, so it always fills it exactly.
  const corners = [projected(0, 0), projected(width, 0), projected(0, height), projected(width, height)]
  const low = Math.min(...corners)
  const span = Math.max(1e-6, Math.max(...corners) - low)
  const out = Buffer.from(data)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = Math.max(0, Math.min(1, (projected(x, y) - low) / span))
      const index = (y * width + x) * 4
      out[index] = Math.round(from.r + (to.r - from.r) * t)
      out[index + 1] = Math.round(from.g + (to.g - from.g) * t)
      out[index + 2] = Math.round(from.b + (to.b - from.b) * t)
    }
  }
  return writeRgba(out, width, height)
}

/** Paint the fill onto a shape: a solid colour, or a linear gradient across it. */
export async function paintFill(png: Buffer, fill: TextFill): Promise<Buffer> {
  if (fill.type === 'gradient' && fill.color2) return gradientFill(png, fill)
  return tint(png, fill.color)
}

/**
 * Grow the ink outward by `widthPx`, in `color` — the outline.
 *
 * The outline is the DIFFERENCE between the grown silhouette and the glyphs themselves: the area
 * the shape's alpha reaches when stamped at every offset within `widthPx`, minus the shape. Keeping
 * the glyphs out of it is what leaves the fill visible on top — stamping the silhouette and drawing
 * the text over it looked identical in a green test but rendered every headline black.
 */
export async function buildOutline(png: Buffer, widthPx: number, color: string): Promise<Buffer> {
  const { data, width, height } = await readRgba(png)
  const radius = Math.max(1, Math.round(widthPx))
  const grownWidth = width + radius * 2
  const grownHeight = height + radius * 2
  const { r, g, b } = hexToRgb(color)
  const out = Buffer.alloc(grownWidth * grownHeight * 4, 0)

  // Offsets covering the disc of `radius`, so the growth is round rather than square.
  const offsets: Array<[number, number]> = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy])
    }
  }
  // A source pixel's own coverage, so antialiased edges grow smoothly.
  const coverage = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 4 + 3]! / 255

  for (let y = 0; y < grownHeight; y++) {
    for (let x = 0; x < grownWidth; x++) {
      // Grown silhouette: the strongest coverage any offset can reach this pixel with.
      let silhouette = 0
      for (const [dx, dy] of offsets) {
        const value = coverage(x - radius - dx, y - radius - dy)
        if (value > silhouette) silhouette = value
        if (silhouette >= 1) break
      }
      if (silhouette <= 0) continue
      const glyph = coverage(x - radius, y - radius)
      const ring = Math.max(0, silhouette - glyph)
      if (ring <= 0) continue
      const index = (y * grownWidth + x) * 4
      out[index] = r
      out[index + 1] = g
      out[index + 2] = b
      out[index + 3] = Math.round(ring * 255)
    }
  }
  return writeRgba(out, grownWidth, grownHeight)
}

/** Multiply the alpha channel by `opacity`. */
export async function applyOpacity(png: Buffer, opacity: number): Promise<Buffer> {
  const factor = Math.max(0, Math.min(1, opacity))
  if (factor >= 1) return png
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const out = Buffer.from(data)
  for (let index = 3; index < out.length; index += 4) out[index] = Math.round(out[index]! * factor)
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}

/** The rounded background panel behind the text. */
export async function buildBackground(width: number, height: number, style: ThumbnailTextStyle): Promise<Buffer> {
  const pad = Math.max(0, Math.round(style.background.padding_px))
  const w = Math.max(1, width + pad * 2)
  const h = Math.max(1, height + pad * 2)
  const r = Math.min(Math.max(0, style.background.radius_px), Math.min(w, h) / 2)
  const { r: red, g: green, b: blue } = hexToRgb(style.background.color)
  const hex = `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${hex}"/></svg>`,
  )
  return applyOpacity(await sharp(svg).png().toBuffer(), style.background.opacity)
}

/** The whole text block: lines painted, aligned, outlined, filled. */
async function buildTextBlock(
  lines: string[],
  font: FontManifestEntry,
  style: ThumbnailTextStyle,
  fontPx: number,
): Promise<{ png: Buffer, width: number, height: number }> {
  const rendered: Array<{ png: Buffer, width: number, height: number }> = []
  for (const line of lines) {
    const png = await renderLine(line, font, style.weight, fontPx)
    rendered.push({ png, ...(await sizeOf(png)) })
  }
  const lineHeightPx = Math.max(1, Math.round(fontPx * Math.max(0.5, style.line_height)))
  const widest = Math.max(1, ...rendered.map(line => line.width))
  const tallest = Math.max(1, ...rendered.map(line => line.height))
  const totalHeight = lineHeightPx * Math.max(0, rendered.length - 1) + tallest

  const overlays: OverlayOptions[] = []
  let top = 0
  for (const line of rendered) {
    const left = style.align === 'left' ? 0
      : style.align === 'right' ? widest - line.width
        : Math.round((widest - line.width) / 2)
    overlays.push({ input: line.png, left: Math.max(0, left), top })
    top += lineHeightPx
  }

  const block = await blankLayer(widest, totalHeight).composite(overlays).png().toBuffer()
  let painted = await paintFill(block, style.fill)

  // The outline is ONLY the ring — the filled text must be composited on top of it.
  // `buildOutline` returns a buffer `2*widthPx` larger on each side with just the outline.
  let composed = painted
  if (style.outline.enabled && style.outline.width_px > 0) {
    const outline = await buildOutline(painted, style.outline.width_px, style.outline.color)
    const outlineMeta = await sizeOf(outline)
    const paintedMeta = await sizeOf(painted)
    // Center the painted text over the outline canvas.
    const textLeft = Math.round((outlineMeta.width - paintedMeta.width) / 2)
    const textTop = Math.round((outlineMeta.height - paintedMeta.height) / 2)
    composed = await blankLayer(outlineMeta.width, outlineMeta.height)
      .composite([
        { input: outline, left: 0, top: 0 },
        { input: painted, left: textLeft, top: textTop },
      ])
      .png()
      .toBuffer()
  }

  composed = await applyOpacity(composed, style.opacity)
  return { png: composed, ...(await sizeOf(composed)) }
}

/** How much wider/taller an outlined block is than its bare text, on each side. */
export function outlineMargin(style: ThumbnailTextStyle): number {
  return style.outline.enabled ? Math.max(0, Math.round(style.outline.width_px)) : 0
}

// ── Placement ──────────────────────────────────────────────────────────────

export interface Box { left: number, top: number, width: number, height: number }

function anchorParts(anchor: string): { vertical: string, horizontal: string } {
  const map: Record<string, { vertical: string, horizontal: string }> = {
    'top-left': { vertical: 'top', horizontal: 'left' },
    'top': { vertical: 'top', horizontal: 'center' },
    'top-right': { vertical: 'top', horizontal: 'right' },
    'left': { vertical: 'middle', horizontal: 'left' },
    'center': { vertical: 'middle', horizontal: 'center' },
    'right': { vertical: 'middle', horizontal: 'right' },
    'bottom-left': { vertical: 'bottom', horizontal: 'left' },
    'bottom': { vertical: 'bottom', horizontal: 'center' },
    'bottom-right': { vertical: 'bottom', horizontal: 'right' },
  }
  return map[anchor] ?? map.center!
}

/**
 * The placement box in pixels: `x_pct`/`y_pct` is the anchor point, `width_pct`/`height_pct` sizes
 * the box, and the result is clamped inside the canvas so a headline near an edge is drawn at the
 * edge rather than off it.
 */
export function placementBox(style: ThumbnailTextStyle, canvasWidth: number, canvasHeight: number): Box {
  const width = Math.max(1, Math.round((style.placement.width_pct / 100) * canvasWidth))
  const height = Math.max(1, Math.round((style.placement.height_pct / 100) * canvasHeight))
  const anchorX = (style.placement.x_pct / 100) * canvasWidth
  const anchorY = (style.placement.y_pct / 100) * canvasHeight
  const { vertical, horizontal } = anchorParts(style.placement.anchor)
  const left = horizontal === 'left' ? anchorX : horizontal === 'right' ? anchorX - width : anchorX - width / 2
  const top = vertical === 'top' ? anchorY : vertical === 'bottom' ? anchorY - height : anchorY - height / 2
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value))
  return {
    left: Math.round(clamp(left, canvasWidth - width)),
    top: Math.round(clamp(top, canvasHeight - height)),
    width,
    height,
  }
}

// ── Branding (handle + logo) ───────────────────────────────────────────────

/** Gap between the logo and the handle inside the mark row, at a 1080px short edge. */
const BRAND_GAP_RATIO = 0.018

/**
 * Build the mark row: [logo][space][handle], or whichever of the two is switched on.
 *
 * One row rather than two independent corners, because "the handle and the logo" is one mark and a
 * channel that has only one of them should look deliberate rather than broken. Returns null when
 * nothing is switched on OR when the logo file does not exist — the caller then draws no mark at
 * all, which is the honest outcome for a channel that has not set one yet.
 */
async function buildBrandRow(
  branding: RenderBranding,
  canvas: { width: number; height: number },
): Promise<{ png: Buffer; width: number; height: number } | null> {
  const parts: Array<{ png: Buffer; width: number; height: number }> = []

  if (branding.logo.enabled && branding.logo.path) {
    try {
      const width = Math.max(1, Math.round((branding.logo.width_pct / 100) * canvas.width))
      const resized = await sharp(branding.logo.path)
        .resize({ width, withoutEnlargement: true })
        .ensureAlpha()
        .png()
        .toBuffer()
      parts.push({ png: await applyOpacity(resized, branding.logo.opacity), ...(await sizeOf(resized)) })
    } catch {
      // A logo that cannot be read is not a reason to lose the handle, or the artwork.
    }
  }

  if (branding.handle.enabled && branding.handle.text.trim()) {
    const font = await requireFont(branding.handle.font_id)
    const rendered = await renderLine(branding.handle.text.trim(), font, branding.handle.weight, branding.handle.size_px)
    const painted = await applyOpacity(await tint(rendered, branding.handle.color), branding.handle.opacity)
    parts.push({ png: painted, ...(await sizeOf(painted)) })
  }

  if (!parts.length) return null
  const gap = parts.length > 1 ? Math.round(BRAND_GAP_RATIO * canvas.width) : 0
  const width = parts.reduce((total, part) => total + part.width, 0) + gap * (parts.length - 1)
  const height = Math.max(...parts.map(part => part.height))
  const overlays: OverlayOptions[] = []
  let left = 0
  for (const part of parts) {
    overlays.push({ input: part.png, left, top: Math.round((height - part.height) / 2) })
    left += part.width + gap
  }
  const png = await blankLayer(width, height).composite(overlays).png().toBuffer()
  return { png, width, height }
}

/** Where the mark row sits, clamped inside the canvas. */
export function brandingBox(
  branding: RenderBranding,
  row: { width: number; height: number },
  canvas: { width: number; height: number },
): { left: number; top: number } {
  const { vertical, horizontal } = anchorParts(branding.position)
  const margin = Math.round((Math.max(0, branding.margin_pct) / 100) * Math.min(canvas.width, canvas.height))
  const left = horizontal === 'left' ? margin
    : horizontal === 'right' ? canvas.width - margin - row.width
      : Math.round((canvas.width - row.width) / 2)
  const top = vertical === 'top' ? margin
    : vertical === 'bottom' ? canvas.height - margin - row.height
      : Math.round((canvas.height - row.height) / 2)
  const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit - 1, value))
  return { left: clamp(left, canvas.width - row.width + 1), top: clamp(top, canvas.height - row.height + 1) }
}

// ── Font self-check ────────────────────────────────────────────────────────

/**
 * Prove the requested family is the face Pango applies.
 *
 * A substituted face is indistinguishable from a resolved one by looking at the output, so the
 * check renders the headline text twice — once in the bundled family, once in a family that does
 * not exist — and refuses when the two agree. That is AGENTS §6 applied to typography: "the face is
 * right" and "I could not tell which face this is" must not produce the same result.
 */
let probePromise: Promise<void> | null = null

async function probeFamily(font: FontManifestEntry): Promise<void> {
  const sample = 'Hamburgefonstiv'
  const [target, probe] = await Promise.all([
    sharp({ text: { text: sample, font: `${font.family} Regular 40`, rgba: true } }).png().toBuffer(),
    sharp({ text: { text: sample, font: `${PROBE_FAMILY} Regular 40`, rgba: true } }).png().toBuffer(),
  ])
  const [targetSize, probeSize] = await Promise.all([sizeOf(target), sizeOf(probe)])
  if (target.length === probe.length && targetSize.width === probeSize.width && targetSize.height === probeSize.height) {
    throw new ThumbnailTextRefusal(
      `The bundled font "${font.label}" could not be selected, so this headline would have been drawn `
      + 'in a face nobody chose. Nothing was rendered. Reinstall Story Studio if this repeats.',
    )
  }
}

/** Run the self-check once per process. */
async function ensureFontsResolve(font: FontManifestEntry): Promise<void> {
  if (!probePromise) {
    probePromise = probeFamily(font).catch(error => {
      probePromise = null
      throw error
    })
  }
  return probePromise
}

/** Forget the self-check result (tests, a font swap on disk). */
export function resetFontProbe(): void {
  probePromise = null
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Render `text` in `style` onto `sourceBytes`.
 *
 * The source is scaled and cropped to cover and drawn at exactly 1280x720 — the size YouTube wants,
 * so nothing downstream resamples a headline the customer approved.
 */
export async function renderThumbnailText(input: RenderInput): Promise<RenderedThumbnail> {
  configureFontconfig()

  const style = input.style
  const canvas = input.canvas ?? THUMBNAIL_TEXT_CANVAS
  const font = await requireFont(style.font_id)
  const text = style.uppercase && textHasCase(input.text) ? input.text.toUpperCase() : input.text

  if (!text.trim()) {
    throw new ThumbnailTextRefusal(
      'Type a headline first — there is nothing to draw.',
      { font_px: 0, lines: 0, glyphs_complete: false, missing_characters: [], overflow: false }
    )
  }

  // Coverage from the font file's own cmap.
  const coverage = await glyphCoverage(fontFilePath(font), text)
  if (!coverage.complete) {
    throw new ThumbnailTextRefusal(
      `${font.label} cannot draw ${coverage.missing.map(c => `"${c}"`).join(', ')}. `
      + 'Choose a font that covers this headline, or change the headline.',
      { font_px: 0, lines: 0, glyphs_complete: false, missing_characters: coverage.missing, overflow: false }
    )
  }

  await ensureFontsResolve(font)

  const box = placementBox(style, canvas.width, canvas.height)
  const pad = style.background.enabled ? Math.max(0, Math.round(style.background.padding_px)) : 0
  const margin = outlineMargin(style)
  // The outlined, padded block — not the bare text — is what has to fit inside the box, so the
  // budget subtracts the outline's own growth on both sides.
  const usableWidth = Math.max(1, box.width - pad * 2 - margin * 2)
  const usableHeight = Math.max(1, box.height - pad * 2 - margin * 2)

  const widthCache = new Map<string, number>()
  const measureWidth = async (line: string, px: number): Promise<number> => {
    const key = `${px}\u0000${line}`
    const hit = widthCache.get(key)
    if (hit !== undefined) return hit
    const width = (await sizeOf(await renderLine(line, font, style.weight, px))).width
    widthCache.set(key, width)
    return width
  }

  /** Try a candidate size: wrap, measure, and decide whether it fits the box. */
  const attempt = async (px: number) => {
    if (widthCache.size > 4000) widthCache.clear()
    const wrapped = await wrapText(text, Math.max(1, style.max_lines), usableWidth, line => measureWidth(line, px))
    const lineHeightPx = Math.max(1, Math.round(px * Math.max(0.5, style.line_height)))
    let widest = 0
    let tallest = 0
    for (const line of wrapped.lines) {
      widest = Math.max(widest, await measureWidth(line, px))
      tallest = Math.max(tallest, (await sizeOf(await renderLine(line, font, style.weight, px))).height)
    }
    const blockHeight = lineHeightPx * Math.max(0, wrapped.lines.length - 1) + tallest
    return {
      fits: !wrapped.overflow && widest <= usableWidth && blockHeight <= usableHeight,
      overflow: wrapped.overflow,
      lines: wrapped.lines,
      widest,
      blockHeight,
    }
  }

  let fontPx: number
  let result: Awaited<ReturnType<typeof attempt>>

  if (style.size.mode === 'fixed') {
    fontPx = Math.max(1, Math.round(style.size.px ?? style.size.min_px))
    result = await attempt(fontPx)
    if (!result.fits) {
      const why = result.overflow
        ? `it needs more than ${Math.max(1, style.max_lines)} line(s)`
        : `it measures ${Math.round(result.widest)}x${Math.round(result.blockHeight)}px and the box allows ${usableWidth}x${usableHeight}px`
      throw new ThumbnailTextRefusal(
        `Nothing was written: at ${fontPx}px this headline does not fit — ${why}. `
        + 'Lower the size, raise "max lines", shorten the headline, or widen the placement box.',
        { font_px: fontPx, lines: result.lines.length, glyphs_complete: true, missing_characters: [], overflow: true }
      )
    }
  } else {
    // 'fit' — the largest size in [min, max] that fits. Short titles grow, long titles shrink
    // (owner point 4). Fitting is monotone in px, so a bisection finds the exact boundary.
    const min = Math.max(1, Math.round(style.size.min_px))
    const max = Math.max(min, Math.round(style.size.max_px))
    let low = min
    let high = max
    let best: Awaited<ReturnType<typeof attempt>> | null = null
    let bestSize = min
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = await attempt(mid)
      if (candidate.fits) {
        best = candidate
        bestSize = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    if (!best) {
      const smallest = await attempt(min)
      const why = smallest.overflow
        ? `it needs more than ${Math.max(1, style.max_lines)} line(s)`
        : `it measures ${Math.round(smallest.widest)}x${Math.round(smallest.blockHeight)}px and the box allows ${usableWidth}x${usableHeight}px`
      throw new ThumbnailTextRefusal(
        `Nothing was written: this headline does not fit the placement box even at ${min}px — ${why}. `
        + 'Raise "max lines", shorten the headline, or widen the box.',
        { font_px: min, lines: smallest.lines.length, glyphs_complete: true, missing_characters: [], overflow: true }
      )
    }
    fontPx = bestSize
    result = best
  }

  const block = await buildTextBlock(result.lines, font, style, fontPx)
  // `block` carries the outline's growth, so its own centre is the centre of the drawn headline.
  // Aligning by the `align` setting therefore shifts the WHOLE block (outline included) rather
  // than the bare text, which is what keeps the outline symmetric on every line.
  const clamp = (value: number, span: number, limit: number) =>
    Math.round(Math.max(0, Math.min(limit - span, value)))
  const blockLeft = clamp(
    style.align === 'left' ? box.left + pad + margin
      : style.align === 'right' ? box.left + box.width - pad - margin - block.width
        : box.left + (box.width - block.width) / 2,
    block.width,
    canvas.width,
  )
  const blockTop = clamp(box.top + (box.height - block.height) / 2, block.height, canvas.height)

  const layers: OverlayOptions[] = []

  if (style.background.enabled) {
    layers.push({
      input: await buildBackground(block.width, block.height, style),
      left: Math.round(blockLeft - pad),
      top: Math.round(blockTop - pad),
    })
  }

  if (style.shadow.enabled) {
    const blurred = await sharp(block.png).blur(Math.max(0, style.shadow.blur_px)).png().toBuffer()
    const shadow = await applyOpacity(await tint(blurred, style.shadow.color), style.shadow.opacity)
    layers.push({
      input: shadow,
      left: Math.round(blockLeft + style.shadow.dx),
      top: Math.round(blockTop + style.shadow.dy),
    })
  }

  layers.push({ input: block.png, left: blockLeft, top: blockTop })

  // The mark rides ON TOP of the words: a handle that the quote covers is not a handle.
  if (input.branding) {
    const row = await buildBrandRow(input.branding, canvas)
    if (row) {
      const at = brandingBox(input.branding, row, canvas)
      layers.push({ input: row.png, left: at.left, top: at.top })
    }
  }

  const overlay = await sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(layers).png().toBuffer()

  const backdrop = await sharp(input.sourceBytes)
    .resize(canvas.width, canvas.height, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer()

  const png = await sharp(backdrop)
    .composite([{ input: overlay, left: 0, top: 0 }])
    .png()
    .toBuffer()

  const meta = await sizeOf(png)
  if (meta.width !== canvas.width || meta.height !== canvas.height) {
    throw new Error(
      `The renderer produced ${meta.width}x${meta.height}; this frame must be `
      + `${canvas.width}x${canvas.height}.`,
    )
  }

  return {
    png,
    report: {
      font_px: fontPx,
      lines: result.lines.length,
      glyphs_complete: true,
      missing_characters: [],
      overflow: false,
    },
  }
}

export { ThumbnailFontError }
