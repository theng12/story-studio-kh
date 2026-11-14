/**
 * Deterministic local chart renderer for the unified timeline.
 *
 * ZERO CREDIT, NO EXTERNAL SERVICE: this module builds an SVG string with
 * plain template code (no chart library, no new dependency) and rasterises it
 * with the already-installed `sharp`. Nothing here imports a Gateway or
 * client module — `__tests__/chart-render.test.ts` enforces that with a
 * source check.
 *
 * Identical input → byte-identical PNG: no timestamps, no random ids, a
 * stable font stack and fixed formatting. Labels are truncated with an
 * ellipsis to their slot so they never overlap; the text summary returned
 * alongside the PNG keeps the full labels for alt text.
 */
import sharp from 'sharp'
import { describeChart, parseChartSpec, type ChartSpec, type ResolvedChartSpec } from '../contracts/chart-spec.js'

/**
 * Series/text palette — mirrors the frontend tokens in
 * `frontend/assets/css/main.css` (`--accent`, `--success`, `--warning`,
 * `--info`, `--error` on `--bg-primary` / `--text-primary`). Flat fills only:
 * no gradients, no shadows.
 */
const PALETTE = ['#f59e4b', '#4ade80', '#fbbf24', '#60a5fa', '#f87171'] as const
const BG = '#0f1117'
const GRID = '#2e3142'
const AXIS = '#3a3d50'
const TEXT = '#e8eaf0'
const MUTED = '#8f97a9'
const INK = '#0f1117'

/** Stable stack — machine-local fonts only, chosen once so output repeats. */
const FONT = `-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif`
const ELLIPSIS = '…'

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function num(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

/** Plain axis/tick format: integers bare, otherwise at most two decimals. */
function formatNumber(value: number): string {
  return num(Math.round(value * 100) / 100)
}

/**
 * Truncate to `maxPx` at `fontSize` using an average glyph width (0.62em).
 * shortcut: estimated widths, not measured glyphs — upgrade to real text
 * measurement only if a font mismatch ever lets a label touch its neighbour.
 */
function fitLabel(text: string, maxPx: number, fontSize: number): string {
  const chars = Array.from(text)
  const maxChars = Math.max(1, Math.floor(maxPx / (fontSize * 0.62)))
  if (chars.length <= maxChars) return text
  if (maxChars === 1) return ELLIPSIS
  return `${chars.slice(0, maxChars - 1).join('')}${ELLIPSIS}`
}

function svgShell(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">${body}</svg>`
}

interface PlotBox {
  x: number
  y: number
  w: number
  h: number
}

/** Shared cartesian frame for bar and line: title strip, axes, gridlines. */
function cartesianFrame(spec: ResolvedChartSpec, body: string[]): { plot: PlotBox; y: (value: number) => number; slot: number } {
  const { width: W, height: H } = spec
  const titleSize = Math.max(18, Math.round(W * 0.025))
  const labelSize = Math.max(11, Math.round(Math.min(W, H) * 0.018))

  const minV = Math.min(0, ...spec.values)
  let maxV = Math.max(0, ...spec.values)
  if (minV === maxV) maxV = minV + 1

  const ticks = [0, 1, 2, 3, 4].map(i => minV + ((maxV - minV) * i) / 4)
  const tickText = ticks.map(formatNumber)
  const valueColW = Math.max(...tickText.map(t => t.length)) * labelSize * 0.62

  const padLeft = Math.round(valueColW + labelSize * 1.6)
  const padRight = Math.round(labelSize * 1.2)
  const padTop = Math.round(spec.title ? titleSize * 2.6 : titleSize * 1.4)
  const padBottom = Math.round(labelSize * 3.4)

  const plot: PlotBox = { x: padLeft, y: padTop, w: W - padLeft - padRight, h: H - padTop - padBottom }
  const y = (value: number) => plot.y + (plot.h * (maxV - value)) / (maxV - minV)
  const slot = plot.w / spec.values.length

  if (spec.title) {
    body.push(`<text x="${num(plot.x + plot.w / 2)}" y="${num(titleSize * 1.5)}" font-size="${titleSize}" font-weight="600" fill="${TEXT}" text-anchor="middle">${esc(fitLabel(spec.title, plot.w, titleSize))}</text>`)
  }

  for (const [i, tick] of ticks.entries()) {
    const ty = y(tick)
    body.push(`<line x1="${num(plot.x)}" y1="${num(ty)}" x2="${num(plot.x + plot.w)}" y2="${num(ty)}" stroke="${GRID}" stroke-width="1"/>`)
    body.push(`<text x="${num(plot.x - labelSize * 0.7)}" y="${num(ty)}" font-size="${labelSize}" fill="${MUTED}" text-anchor="end" dominant-baseline="middle">${esc(tickText[i])}</text>`)
  }
  body.push(`<line x1="${num(plot.x)}" y1="${num(plot.y)}" x2="${num(plot.x)}" y2="${num(plot.y + plot.h)}" stroke="${AXIS}" stroke-width="1"/>`)
  body.push(`<line x1="${num(plot.x)}" y1="${num(plot.y + plot.h)}" x2="${num(plot.x + plot.w)}" y2="${num(plot.y + plot.h)}" stroke="${AXIS}" stroke-width="1"/>`)
  // Zero baseline gets its own stronger line when the data crosses it.
  if (minV < 0) {
    const zero = y(0)
    body.push(`<line x1="${num(plot.x)}" y1="${num(zero)}" x2="${num(plot.x + plot.w)}" y2="${num(zero)}" stroke="${AXIS}" stroke-width="2"/>`)
  }

  // Category labels: truncated to the slot so neighbours cannot overlap;
  // a slot too narrow for one character drops the label entirely.
  const charW = labelSize * 0.62
  for (const [i, label] of spec.labels.entries()) {
    const center = plot.x + slot * i + slot / 2
    const maxPx = slot - charW * 0.5
    if (maxPx < charW * 1.5) continue
    const text = fitLabel(label, maxPx, labelSize)
    body.push(`<text x="${num(center)}" y="${num(plot.y + plot.h + labelSize * 1.9)}" font-size="${labelSize}" fill="${MUTED}" text-anchor="middle">${esc(text)}</text>`)
  }

  return { plot, y, slot }
}

function barSvg(spec: ResolvedChartSpec): string {
  const body: string[] = [`<rect width="${spec.width}" height="${spec.height}" fill="${BG}"/>`]
  const { plot, y, slot } = cartesianFrame(spec, body)
  const labelSize = Math.max(11, Math.round(Math.min(spec.width, spec.height) * 0.018))
  const zeroY = y(Math.max(0, Math.min(0, ...spec.values)))
  const barW = Math.max(2, Math.min(slot * 0.64, spec.width * 0.06))

  for (const [i, value] of spec.values.entries()) {
    const top = Math.min(y(value), zeroY)
    const h = Math.abs(y(value) - zeroY)
    const x = plot.x + slot * i + (slot - barW) / 2
    body.push(`<rect x="${num(x)}" y="${num(top)}" width="${num(barW)}" height="${num(h)}" fill="${PALETTE[0]}"/>`)
    // Value caption only when it fits its slot without touching a neighbour.
    const caption = formatNumber(value)
    if (slot >= caption.length * labelSize * 0.62 + labelSize) {
      const cy = value >= 0 ? top - labelSize * 0.4 : top + h + labelSize * 1.1
      body.push(`<text x="${num(x + barW / 2)}" y="${num(cy)}" font-size="${num(labelSize * 0.9)}" fill="${TEXT}" text-anchor="middle" dominant-baseline="${value >= 0 ? 'auto' : 'hanging'}">${esc(caption)}</text>`)
    }
  }
  return svgShell(spec.width, spec.height, body.join(''))
}

function lineSvg(spec: ResolvedChartSpec): string {
  const body: string[] = [`<rect width="${spec.width}" height="${spec.height}" fill="${BG}"/>`]
  const { plot, y, slot } = cartesianFrame(spec, body)
  const labelSize = Math.max(11, Math.round(Math.min(spec.width, spec.height) * 0.018))

  const points = spec.values.map((value, i) => `${num(plot.x + slot * i + slot / 2)},${num(y(value))}`)
  body.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${PALETTE[0]}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`)

  const dotR = Math.max(3, labelSize * 0.38)
  for (const [i, value] of spec.values.entries()) {
    const cx = plot.x + slot * i + slot / 2
    const cy = y(value)
    body.push(`<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(dotR)}" fill="${BG}" stroke="${PALETTE[0]}" stroke-width="3"/>`)
    const caption = formatNumber(value)
    if (slot >= caption.length * labelSize * 0.62 + labelSize) {
      body.push(`<text x="${num(cx)}" y="${num(cy - dotR - labelSize * 0.5)}" font-size="${num(labelSize * 0.9)}" fill="${TEXT}" text-anchor="middle">${esc(caption)}</text>`)
    }
  }
  return svgShell(spec.width, spec.height, body.join(''))
}

function pieSvg(spec: ResolvedChartSpec): string {
  const { width: W, height: H } = spec
  const titleSize = Math.max(18, Math.round(W * 0.025))
  const labelSize = Math.max(11, Math.round(Math.min(W, H) * 0.018))
  const body: string[] = [`<rect width="${W}" height="${H}" fill="${BG}"/>`]

  if (spec.title) {
    body.push(`<text x="${num(W / 2)}" y="${num(titleSize * 1.5)}" font-size="${titleSize}" font-weight="600" fill="${TEXT}" text-anchor="middle">${esc(fitLabel(spec.title, W - labelSize * 2, titleSize))}</text>`)
  }

  const sum = spec.values.reduce((acc, v) => acc + v, 0)
  const top = spec.title ? titleSize * 2.6 : titleSize * 1.4
  const legendX = W * 0.62
  const r = Math.min(W * 0.26, (H - top) * 0.42)
  const cx = Math.min(legendX - r - labelSize, W * 0.3)
  const cy = top + (H - top) / 2

  let angle = -Math.PI / 2
  const fractions = spec.values.map(v => v / sum)
  for (const [i, fraction] of fractions.entries()) {
    const sweep = fraction * Math.PI * 2
    const color = PALETTE[i % PALETTE.length]
    if (fraction >= 0.9999) {
      body.push(`<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${color}"/>`)
    } else {
      const a1 = angle + sweep
      const x0 = cx + r * Math.cos(angle)
      const y0 = cy + r * Math.sin(angle)
      const x1 = cx + r * Math.cos(a1)
      const y1 = cy + r * Math.sin(a1)
      const large = sweep > Math.PI ? 1 : 0
      body.push(`<path d="M ${num(cx)} ${num(cy)} L ${num(x0)} ${num(y0)} A ${num(r)} ${num(r)} 0 ${large} 1 ${num(x1)} ${num(y1)} Z" fill="${color}"/>`)
      // Percentage inside the slice only when it is big enough to read.
      if (fraction >= 0.08) {
        const mid = angle + sweep / 2
        const lx = cx + r * 0.62 * Math.cos(mid)
        const ly = cy + r * 0.62 * Math.sin(mid)
        body.push(`<text x="${num(lx)}" y="${num(ly)}" font-size="${num(labelSize * 1.1)}" font-weight="600" fill="${INK}" text-anchor="middle" dominant-baseline="middle">${Math.round(fraction * 100)}%</text>`)
      }
    }
    angle += sweep
  }

  // Legend: colour swatch + truncated label + percentage, stacked to fit.
  const rows = spec.labels.length
  const available = H - top - labelSize
  const spacing = Math.max(labelSize * 1.2, Math.min(labelSize * 2.1, available / rows))
  const legendSize = Math.max(9, Math.min(labelSize, spacing * 0.8))
  const legendTop = top + Math.max(0, (available - spacing * rows) / 2) + spacing / 2
  const swatch = legendSize
  const textX = legendX + swatch + legendSize * 0.6
  const textMax = W - textX - labelSize
  for (const [i, label] of spec.labels.entries()) {
    const rowY = legendTop + spacing * i
    const color = PALETTE[i % PALETTE.length]
    body.push(`<rect x="${num(legendX)}" y="${num(rowY - swatch / 2)}" width="${num(swatch)}" height="${num(swatch)}" fill="${color}"/>`)
    const pct = `${Math.round(fractions[i] * 100)}%`
    const pctW = pct.length * legendSize * 0.62 + legendSize * 0.5
    const text = fitLabel(label, textMax - pctW, legendSize)
    body.push(`<text x="${num(textX)}" y="${num(rowY)}" font-size="${num(legendSize)}" fill="${TEXT}" dominant-baseline="middle">${esc(text)}</text>`)
    body.push(`<text x="${num(W - labelSize)}" y="${num(rowY)}" font-size="${num(legendSize)}" fill="${MUTED}" text-anchor="end" dominant-baseline="middle">${pct}</text>`)
  }

  return svgShell(W, H, body.join(''))
}

/** Build the chart's SVG string (validated the same way as a render). */
export function buildChartSvg(input: ChartSpec): string {
  const spec = parseChartSpec(input)
  if (spec.kind === 'bar') return barSvg(spec)
  if (spec.kind === 'line') return lineSvg(spec)
  return pieSvg(spec)
}

export interface ChartRenderResult {
  png: Buffer
  width: number
  height: number
  /** Plain-text summary for callers to show or attach as alt text. */
  summary: string
}

/** Rasterise a chart segment to PNG locally — zero credit, no network. */
export async function renderChartPng(input: ChartSpec): Promise<ChartRenderResult> {
  const spec = parseChartSpec(input)
  const svg = spec.kind === 'bar' ? barSvg(spec) : spec.kind === 'line' ? lineSvg(spec) : pieSvg(spec)
  const png = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer()
  return { png, width: spec.width, height: spec.height, summary: describeChart(spec) }
}
