import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import type { LabelDesign } from '../contracts/label-design.js'

/**
 * Renders an image-backed label: the design's transparent PNG, scaled to a
 * frame-proportional size, with the cue's own words fitted into its text box.
 *
 * Text is drawn here, never by the image model, so spelling is exact. Size is
 * driven by the WORDS: a short place name lands near a fifth to a quarter of
 * the frame width, a long one grows only as far as it must, and both ends are
 * clamped to a cap and a readable floor.
 */

const LABEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'label-designs')

/** Where the built-in design assets live. Exported so tests can point elsewhere. */
export function labelDesignAssetPath(asset: string): string {
  return path.join(LABEL_DIR, 'assets', asset)
}

export async function readLabelDesigns(): Promise<LabelDesign[]> {
  const directory = path.join(LABEL_DIR, 'catalogue.d')
  const files = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const catalogues = [path.join(LABEL_DIR, 'catalogue.json'), ...files.filter(file => file.endsWith('.json')).sort().map(file => path.join(directory, file))]
  const designs: LabelDesign[] = []
  for (const file of catalogues) {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(raw?.designs)) throw new Error(`Invalid label catalogue: ${file}`)
    designs.push(...raw.designs)
  }
  return designs
}

export async function findLabelDesign(id: string): Promise<LabelDesign | null> {
  return (await readLabelDesigns()).find(design => design.id === id) ?? null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Frame-proportional base: the frame width, which is the short side on a vertical frame. */
export function labelFrameBase(frameW: number): number {
  return Math.max(1, Math.round(frameW))
}

async function measure(text: string, fontPx: number): Promise<{ width: number; height: number; png: Buffer }> {
  const png = await sharp({ text: { text, font: `sans-serif, ${Math.round(fontPx)}`, rgba: true } }).png().toBuffer()
  let trimmed = png
  try { trimmed = await sharp(png).trim({ threshold: 1 }).png().toBuffer() } catch { /* blank line */ }
  const meta = await sharp(trimmed).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0, png: trimmed }
}

/** Split a long label into at most two balanced lines. */
function splitLines(text: string): string[] {
  const words = text.trim().split(/\s+/)
  if (words.length < 2 || text.trim().length <= 22) return [text.trim()]
  let best = [text.trim()]
  let bestDelta = Infinity
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    const delta = Math.abs(a.length - b.length)
    if (delta < bestDelta) { bestDelta = delta; best = [a, b] }
  }
  return best
}

export interface LabelRenderInput {
  design: LabelDesign
  title: string
  subtitle?: string
  frame_w: number
  frame_h: number
  /** Asset file; defaults to the built-in directory. */
  asset_path?: string
}

export interface LabelRenderOutput {
  png: Buffer
  width: number
  height: number
  /** Where the design's anchor sits, as fractions of the rendered PNG. */
  anchor: { x: number; y: number }
}

export async function renderLabelDesign(input: LabelRenderInput): Promise<LabelRenderOutput> {
  const { design, frame_w } = input
  const base = labelFrameBase(frame_w)
  const asset = sharp(input.asset_path ?? labelDesignAssetPath(design.asset))
  const meta = await asset.metadata()
  const naturalW = meta.width ?? 1
  const naturalH = meta.height ?? 1
  const aspect = naturalW / naturalH
  const box = design.text_box

  const nominal = clamp(base * 0.042, 14, 72)
  const floor = Math.max(11, base * 0.014)
  // A tall design is limited by its height: width alone let one run past the frame.
  const capWidth = Math.min(base * 0.32, input.frame_h * 0.3 * aspect)
  const minWidth = Math.min(base * 0.16, capWidth)
  const raw = input.subtitle ? `${input.title}\n${input.subtitle}` : input.title
  const lines = splitLines(raw.replace(/\n+/g, ' '))

  let fontPx = nominal
  let textW = 0
  let textH = 0
  let renderedLines: { png: Buffer; width: number; height: number }[] = []
  for (let attempt = 0; attempt < 40; attempt++) {
    renderedLines = []
    textW = 0
    textH = 0
    for (const line of lines) {
      const m = await measure(line, fontPx)
      renderedLines.push(m)
      textW = Math.max(textW, m.width)
      textH += m.height
    }
    // The width the asset needs for this text at its own proportions.
    const needed = Math.max(textW / Math.max(0.05, box.width), (textH / Math.max(0.05, box.height)) * aspect)
    if (needed <= capWidth || fontPx <= floor) break
    fontPx = Math.max(floor, fontPx * 0.9)
  }

  const neededWidth = Math.max(textW / Math.max(0.05, box.width), (textH / Math.max(0.05, box.height)) * aspect)
  const width = Math.round(clamp(neededWidth, minWidth, capWidth))
  const height = Math.round(width / aspect)

  const size = { width, height, fit: 'fill' as const }
  const layers: Array<{ input: Buffer; left: number; top: number }> = []
  const boxX = Math.round(box.x * width)
  const boxY = Math.round(box.y * height)
  const boxW = Math.round(box.width * width)
  const boxH = Math.round(box.height * height)
  const lineGap = Math.round(fontPx * 0.22)
  const blockH = renderedLines.reduce((sum, l) => sum + l.height, 0) + lineGap * (renderedLines.length - 1)
  let cursorY = boxY + Math.max(0, Math.round((boxH - blockH) / 2))
  for (const line of renderedLines) {
    const scaled = line.width > boxW
      ? await sharp(line.png).resize({ width: boxW }).png().toBuffer()
      : line.png
    const m = await sharp(scaled).metadata()
    const w = m.width ?? 0
    const h = m.height ?? 0
    const left = boxX + Math.round((boxW - w) / 2)
    layers.push({ input: scaled, left, top: cursorY })
    cursorY += h + lineGap
  }

  const png = await sharp(await asset.resize(size).png().toBuffer())
    .composite(layers)
    .png()
    .toBuffer()

  const anchor = design.anchor ?? { x: 0.5, y: 0.5 }
  return { png, width, height, anchor }
}

/**
 * A leader line from the label's anchor to a target the label points at.
 * Returned as a frame-sized transparent PNG so it can be overlaid at 0,0.
 */
export async function renderLeaderLine(input: {
  frame_w: number
  frame_h: number
  from: { x: number; y: number }
  to: { x: number; y: number }
  color?: string
  progress?: number
}): Promise<Buffer> {
  const { frame_w, frame_h, from, to } = input
  const color = input.color ?? '#f4c75d'
  const x1 = from.x * frame_w
  const y1 = from.y * frame_h
  const progress = clamp(input.progress ?? 1, 0, 1)
  const x2 = (from.x + (to.x - from.x) * progress) * frame_w
  const y2 = (from.y + (to.y - from.y) * progress) * frame_h
  const stroke = Math.max(3, Math.round(Math.min(frame_w, frame_h) * 0.005))
  const dot = stroke * 2.4
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame_w}" height="${frame_h}" viewBox="0 0 ${frame_w} ${frame_h}">
  <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>
  <circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="${dot.toFixed(1)}" fill="${color}" stroke="#242322" stroke-width="${Math.max(1, Math.round(stroke / 2))}"/>
</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** Write the short entrance at output frame rate; FFmpeg repeats its last frame. */
export async function writeLabelRevealFrames(
  prefix: string, fps: number, files: string[],
  frame: (progress: number) => Promise<Buffer>,
): Promise<string> {
  const count = Math.max(2, Math.ceil(fps * 0.3) + 1)
  for (let i = 0; i < count; i++) {
    const filename = `${prefix}-${String(i).padStart(4, '0')}.png`
    files.push(filename)
    await fs.writeFile(filename, await frame(i / (count - 1)))
  }
  return `${prefix}-%04d.png`
}

export async function renderLabelWipe(png: Buffer, width: number, height: number, progress: number): Promise<Buffer> {
  const visible = Math.round(width * progress)
  if (visible <= 0) return sharp({ create: { width, height, channels: 4, background: '#00000000' } }).png().toBuffer()
  if (visible >= width) return png
  const left = await sharp(png).extract({ left: 0, top: 0, width: visible, height }).png().toBuffer()
  return sharp({ create: { width, height, channels: 4, background: '#00000000' } }).composite([{ input: left, left: 0, top: 0 }]).png().toBuffer()
}
