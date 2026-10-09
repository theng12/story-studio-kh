/**
 * Logo shape (owner, 2026-10-09: "smooth its corners, or place it in a circle").
 * The shaped logo is made ONCE per render as a still PNG of the logo's rendered
 * size (sharp + an anti-aliased SVG mask), so the FFmpeg graph is unchanged and
 * never runs a per-frame `geq`.
 */
import sharp from 'sharp'

export type LogoShape = 'none' | 'rounded' | 'circle'

export function logoShapeOf(value: unknown): LogoShape {
  return value === 'rounded' || value === 'circle' ? value : 'none'
}

/** Corner radius as a share of the logo's shorter side, 1–50 %. Default 20 %. */
export function logoCornerRadiusPct(value: unknown): number {
  const pct = Number(value)
  return Number.isFinite(pct) ? Math.max(1, Math.min(50, Math.round(pct))) : 20
}

/** The mask the logo is cut to: a rounded rectangle, or a circle filling a square. */
export function logoShapeMaskSvg(width: number, height: number, shape: Exclude<LogoShape, 'none'>, radiusPct = 20): string {
  const body = shape === 'circle'
    ? `<circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 2}"/>`
    : (() => {
        const r = Math.round(Math.min(width, height) * logoCornerRadiusPct(radiusPct) / 100)
        return `<rect x="0" y="0" width="${width}" height="${height}" rx="${r}" ry="${r}"/>`
      })()
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`
}

/**
 * Write the logo cut to `shape` at `widthPx` wide (a circle is centre-fitted to a
 * square). Its own transparency is kept: the mask only removes more.
 */
export async function writeShapedLogo(source: string, output: string, widthPx: number, shape: Exclude<LogoShape, 'none'>, radiusPct?: number): Promise<{ width: number; height: number }> {
  const width = Math.max(2, Math.round(widthPx))
  const resized = shape === 'circle'
    ? sharp(source).resize(width, width, { fit: 'cover', position: 'centre' })
    : sharp(source).resize({ width })
  const { data, info } = await resized.ensureAlpha().png().toBuffer({ resolveWithObject: true })
  await sharp(data)
    .composite([{ input: Buffer.from(logoShapeMaskSvg(info.width, info.height, shape, radiusPct)), blend: 'dest-in' }])
    .png()
    .toFile(output)
  return { width: info.width, height: info.height }
}
