/**
 * The Effects Library's live preview: draw one frame of a scene with its
 * effect stack on a `<canvas>`.
 *
 * Atmosphere loops (rain, snow, fireflies, fog…) are drawn by the SAME program
 * that bakes them for the render (`@shared/effect-loops`), so particle
 * positions, sizes, timing and seeds match the video. The other effects are
 * close canvas equivalents of their FFmpeg filters — grade through CSS filters
 * with the backend's preset table, flicker and lightning through the same
 * formulas the render evaluates — and "Render Exact Preview" is the check that
 * shows the real graph. Heat shimmer and the corner logo are not drawn live;
 * the page says so beside the canvas.
 */

import {
  createLoopRenderer,
  flickerOffset,
  lightningLevel,
  loopBakeFps,
  loopFrameCount,
  type LoopRenderer,
} from '@shared/effect-loops'
import { COLOR_GRADE_PRESET_VALUES, atmosphereLoopShape, type SceneOverlayDocument } from '@shared/scene-effects'
import { LOOP_VARIANT_INFO, loopShapeKey } from '@shared/effect-loops'

/** Effects the canvas cannot show honestly; the exact preview can. */
export const NOT_DRAWN_LIVE: ReadonlySet<SceneOverlayDocument['kind']> = new Set(['heat-shimmer', 'corner-logo', 'living-region'])

export interface CameraMove {
  /** Zoom from 1 to `1 + zoom` and back across `period_sec` — the slow zoom stills get. */
  zoom: number
  pan_x: number
  period_sec: number
}

export const SLOW_ZOOM: CameraMove = { zoom: 0.08, pan_x: 0, period_sec: 16 }
export const NO_CAMERA: CameraMove = { zoom: 0, pan_x: 0, period_sec: 16 }

type Ctx = CanvasRenderingContext2D

interface LoopLayer { renderer: LoopRenderer; buffer: Uint8Array; canvas: HTMLCanvasElement | OffscreenCanvas; fps: number }

/**
 * Holds the per-loop renderers between frames so dragging a colour or the
 * brightness never rebuilds particles, and a shape change rebuilds only that loop.
 */
export class EffectCanvasRenderer {
  private loops = new Map<string, LoopLayer>()
  private grain: HTMLCanvasElement | OffscreenCanvas | null = null
  private scratch: HTMLCanvasElement | OffscreenCanvas | null = null

  constructor(private readonly makeCanvas: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas) {}

  /** Forget loops no longer in the stack. */
  prune(docs: readonly SceneOverlayDocument[], w: number, h: number): void {
    const live = new Set<string>()
    for (const doc of docs) for (const key of this.loopKeys(doc, w, h)) live.add(key)
    for (const key of this.loops.keys()) if (!live.has(key)) this.loops.delete(key)
  }

  private loopKeys(doc: SceneOverlayDocument, w: number, h: number): string[] {
    if (doc.kind !== 'atmosphere-loop') return []
    const subsets: Array<0 | 1 | 2> = doc.secondary_color_hex && doc.secondary_color_hex !== doc.color_hex ? [1, 2] : [0]
    return subsets.map(sub => `${loopShapeKey(atmosphereLoopShape(doc, sub))}@${w}x${h}`)
  }

  private loopLayer(doc: Extract<SceneOverlayDocument, { kind: 'atmosphere-loop' }>, subset: 0 | 1 | 2, w: number, h: number): LoopLayer {
    const shape = atmosphereLoopShape(doc, subset)
    const key = `${loopShapeKey(shape)}@${w}x${h}`
    let layer = this.loops.get(key)
    if (!layer) {
      // Draw at a fraction of the canvas, as the bake does; the browser scales up.
      const scale = LOOP_VARIANT_INFO[doc.variant].bake_scale
      // The canvas size times the variant's own bake scale, as the bake does:
      // particles at full size (a half-size streak scaled up reads as blocks),
      // soft fog and rays small and smoothed back up.
      const lw = Math.max(2, Math.round(w * scale))
      const lh = Math.max(2, Math.round(h * scale))
      const fps = loopBakeFps(shape, 24)
      const renderer = createLoopRenderer(shape, lw, lh, loopFrameCount(shape, fps))
      layer = { renderer, buffer: new Uint8Array(lw * lh), canvas: this.makeCanvas(lw, lh), fps }
      this.loops.set(key, layer)
    }
    return layer
  }

  /** Draw `image` with the camera move and every effect in `docs`, in order, at time `t`. */
  draw(ctx: Ctx, image: CanvasImageSource | null, docs: readonly SceneOverlayDocument[], t: number, camera: CameraMove = SLOW_ZOOM): void {
    const { width: W, height: H } = ctx.canvas
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    // Camera: a slow zoom that eases in and out, the move stills get by default.
    const phase = (1 - Math.cos((2 * Math.PI * t) / camera.period_sec)) / 2
    const s = 1 + camera.zoom * phase
    if (image) {
      const iw = (image as any).naturalWidth || (image as any).width || W
      const ih = (image as any).naturalHeight || (image as any).height || H
      const cover = Math.max(W / iw, H / ih) * s
      const dw = iw * cover, dh = ih * cover
      ctx.drawImage(image, (W - dw) / 2 + camera.pan_x * W * phase, (H - dh) / 2, dw, dh)
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, H)
      g.addColorStop(0, '#1c2a3a'); g.addColorStop(0.6, '#3b4a5a'); g.addColorStop(1, '#6b5a4a')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }
    ctx.restore()
    for (const doc of docs) this.drawEffect(ctx, doc, t)
  }

  private selfFilter(ctx: Ctx, filter: string, alpha = 1, op: GlobalCompositeOperation = 'source-over'): void {
    const { width: W, height: H } = ctx.canvas
    if (!this.scratch || this.scratch.width !== W || this.scratch.height !== H) this.scratch = this.makeCanvas(W, H)
    const sctx = this.scratch.getContext('2d') as Ctx
    sctx.clearRect(0, 0, W, H)
    sctx.drawImage(ctx.canvas, 0, 0)
    ctx.save()
    ctx.filter = filter
    ctx.globalAlpha = alpha
    ctx.globalCompositeOperation = op
    ctx.drawImage(this.scratch as any, 0, 0)
    ctx.restore()
  }

  private drawEffect(ctx: Ctx, doc: SceneOverlayDocument, t: number): void {
    const { width: W, height: H } = ctx.canvas
    const k = H / 1080
    switch (doc.kind) {
      case 'atmosphere-loop': {
        if (doc.darken > 0) {
          ctx.save(); ctx.fillStyle = `rgba(0,0,0,${(doc.darken * 1.2).toFixed(3)})`; ctx.fillRect(0, 0, W, H); ctx.restore()
          this.selfFilter(ctx, `saturate(${(1 - doc.darken * 1.5).toFixed(3)})`)
        }
        const two = !!doc.secondary_color_hex && doc.secondary_color_hex !== doc.color_hex
        const tints: Array<[0 | 1 | 2, string]> = two ? [[1, doc.color_hex], [2, doc.secondary_color_hex!]] : [[0, doc.color_hex]]
        for (const [subset, hex] of tints) {
          const layer = this.loopLayer(doc, subset, W, H)
          const frame = Math.floor(t * layer.fps) % layer.renderer.frames
          layer.renderer.draw(frame, layer.buffer)
          const lctx = layer.canvas.getContext('2d') as Ctx
          const img = lctx.createImageData(layer.renderer.width, layer.renderer.height)
          const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
          for (let i = 0, j = 0; i < layer.buffer.length; i++, j += 4) {
            img.data[j] = r; img.data[j + 1] = g; img.data[j + 2] = b
            img.data[j + 3] = layer.buffer[i]! * doc.opacity
          }
          lctx.putImageData(img, 0, 0)
          ctx.save(); ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(layer.canvas as any, 0, 0, W, H)
          ctx.restore()
        }
        return
      }
      case 'color-grade':
        this.selfFilter(ctx, gradeCssFilter(doc))
        return
      case 'bloom':
        this.selfFilter(ctx, `brightness(${(1 + (1 - doc.threshold) * 0.8).toFixed(2)}) contrast(${(1 + doc.threshold * 4).toFixed(2)}) blur(${Math.max(1, doc.radius_px * k).toFixed(1)}px)`, doc.strength * 0.8, 'screen')
        return
      case 'flicker': {
        const off = flickerOffset(t, doc.amount, doc.speed)
        this.selfFilter(ctx, `brightness(${(1 + off * 2.2).toFixed(3)})`)
        return
      }
      case 'lightning': {
        const level = lightningLevel(t, doc.period_sec, doc.chance, doc.seed) * doc.strength * 0.6
        if (level > 0.01) {
          ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = `rgba(235,240,255,${Math.min(1, level).toFixed(3)})`; ctx.fillRect(0, 0, W, H); ctx.restore()
        }
        return
      }
      case 'vignette': {
        const g = ctx.createRadialGradient(W / 2, H / 2, H * (0.75 - doc.intensity * 0.45), W / 2, H / 2, Math.hypot(W, H) / 2)
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${(0.35 + doc.intensity * 0.55).toFixed(2)})`)
        ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore()
        return
      }
      case 'film-grain': {
        if (!this.grain) this.grain = this.makeCanvas(320, 180)
        const gctx = this.grain.getContext('2d') as Ctx
        const img = gctx.createImageData(320, 180)
        for (let j = 0; j < img.data.length; j += 4) {
          const v = 128 + (Math.random() - 0.5) * 255
          img.data[j] = v; img.data[j + 1] = v; img.data[j + 2] = v; img.data[j + 3] = 255
        }
        gctx.putImageData(img, 0, 0)
        ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = Math.min(0.6, doc.amount / 100)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(this.grain as any, 0, 0, W, H)
        ctx.restore()
        return
      }
      case 'light-leak': {
        const x = W * (doc.to_anchor.includes('left') ? 0.15 : doc.to_anchor.includes('right') ? 0.85 : 0.5)
        const y = H * (doc.to_anchor.startsWith('top') ? 0.15 : doc.to_anchor.startsWith('bottom') ? 0.85 : 0.5)
        const g = ctx.createRadialGradient(x, y, 0, x, y, H * (0.4 + doc.softness * 0.6))
        g.addColorStop(0, hexA(doc.color_hex, doc.intensity)); g.addColorStop(1, hexA(doc.color_hex, 0))
        ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore()
        return
      }
      case 'letterbox': {
        const ratio = doc.ratio === 'custom' ? null : Number(doc.ratio.split(':')[0])
        const bar = ratio ? Math.max(0, (H - W / ratio) / 2) : H * doc.bar_share
        const fill = doc.color.startsWith('#') ? doc.color : 'black'
        if (doc.mode !== 'cover' && bar > 0) {
          // Fit (the default): the whole picture shrinks into the band, as the render does.
          if (!this.scratch || this.scratch.width !== W || this.scratch.height !== H) this.scratch = this.makeCanvas(W, H)
          const sctx = this.scratch.getContext('2d') as Ctx
          sctx.clearRect(0, 0, W, H); sctx.drawImage(ctx.canvas, 0, 0)
          const band = H - bar * 2, bw = W * band / H
          ctx.save(); ctx.fillStyle = fill; ctx.fillRect(0, 0, W, H)
          ctx.drawImage(this.scratch as any, (W - bw) / 2, bar, bw, band); ctx.restore()
          return
        }
        ctx.save(); ctx.fillStyle = fill
        ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar); ctx.restore()
        return
      }
      case 'gradient-scrim': {
        const span = (doc.edge === 'top' || doc.edge === 'bottom' ? H : W) * doc.coverage
        const g = doc.edge === 'bottom' ? ctx.createLinearGradient(0, H, 0, H - span)
          : doc.edge === 'top' ? ctx.createLinearGradient(0, 0, 0, span)
          : doc.edge === 'left' ? ctx.createLinearGradient(0, 0, span, 0)
          : ctx.createLinearGradient(W, 0, W - span, 0)
        g.addColorStop(0, hexA(doc.color_hex, doc.opacity)); g.addColorStop(1, hexA(doc.color_hex, 0))
        ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore()
        return
      }
      case 'lower-third': {
        if (!doc.title && !doc.subtitle) return
        ctx.save()
        const size = doc.title_size_px * k
        ctx.font = `600 ${size}px ${doc.font_family}, sans-serif`
        const text = doc.title || doc.subtitle
        const m = doc.margin_px * k
        const w = ctx.measureText(text).width + doc.padding_px * k * 2
        if (doc.bar) { ctx.fillStyle = hexA(doc.bar_color_hex, doc.bar_opacity); ctx.fillRect(m, H - m - size * 1.8, w, size * 1.8) }
        ctx.fillStyle = doc.title_color_hex
        ctx.fillText(text, m + doc.padding_px * k, H - m - size * 0.5)
        ctx.restore()
        return
      }
      default:
        // heat-shimmer, corner-logo, living-region: shown by Render Exact Preview only.
        return
    }
  }
}

function hexA(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

/**
 * The grade as CSS filters, from the backend's own preset table — the same
 * approximation Video Assembly's effect preview uses (eq maps to brightness,
 * contrast and saturate; warmth to a small hue rotation).
 */
export function gradeCssFilter(doc: Extract<SceneOverlayDocument, { kind: 'color-grade' }>): string {
  const base = COLOR_GRADE_PRESET_VALUES[doc.preset] ?? COLOR_GRADE_PRESET_VALUES.none
  const brightness = base.brightness + doc.brightness
  const contrast = base.contrast * doc.contrast
  const saturation = base.saturation * doc.saturation
  const warmth = base.warmth + doc.warmth
  const parts = [`brightness(${(1 + brightness).toFixed(3)})`, `contrast(${contrast.toFixed(3)})`, `saturate(${saturation.toFixed(3)})`]
  const warmDeg = warmth * -30
  if (Math.abs(warmDeg) > 0.5) parts.push(`hue-rotate(${warmDeg.toFixed(1)}deg)`)
  if (warmth > 0.05) parts.push(`sepia(${Math.min(0.5, warmth).toFixed(2)})`)
  return parts.join(' ')
}
