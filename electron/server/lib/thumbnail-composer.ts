/**
 * Niche-templated thumbnail composer (v1.0.104+).
 *
 * Takes a source image and a ThumbnailTemplate, then returns a PNG buffer with
 * the template's text shape composited over it. The whole point is so the
 * user can drop a randomized portrait into the Compose modal and get
 * back the SAME thumbnail layout the channel always uses — title text
 * baked in, subtitle banner baked in, accent rule, logo slot.
 *
 * The overlay SVG (dim gradient, accent strokes, wrapped text) is built by
 * `contracts/thumbnail-overlay.ts`, which the template editor's live preview
 * also uses — see that file for the text-layout rules and their limits. We
 * composite via sharp's `.composite()`: the portrait is the base, then the
 * full-canvas overlay SVG, then (optionally) a separate logo image.
 */

import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import fsp from 'fs/promises'
import type { ThumbnailTemplate } from '../models/types.js'
import { buildOverlaySvg } from '../contracts/thumbnail-overlay.js'

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
  //    Shared with the template editor's live preview — one layout.
  const overlaySvg = buildOverlaySvg(tmpl, input)
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

