/**
 * Scene motion → per-frame render plan, for the native scene-clip renderer.
 *
 * `scene-effect-compiler.ts` turns a motion document into FFmpeg filters. This turns the SAME
 * document into numbers: one `{ z, cx, cy, rot, blur, gain }` row per output frame, which the
 * native helper (`native/scene-clip`) renders with Core Image and encodes with VideoToolbox.
 * The helper knows nothing about move names; every decision about what a move *is* lives here,
 * next to the compiler it mirrors, so a new move or a changed parameter reaches both renderers
 * from the one document.
 *
 * Geometry is in OUTPUT pixels (the `w`x`h` frame), origin top-left, which is the space FFmpeg's
 * `zoompan` expressions are written in once the 2x supersample is divided back out:
 *
 *   - the picture is fitted and padded onto a `w`x`h` canvas (scale+pad in the FFmpeg chain);
 *   - a frame shows the canvas window centred on `(cx, cy)`, `w/z` by `h/z` large, rotated by `rot`.
 *
 * What differs from `zoompan` on purpose: `zoompan` truncates its crop origin to whole pixels of
 * the supersampled canvas (that is what the 2x supersample exists to hide), the plan keeps the
 * fraction, so the move is as smooth as the supersampled version at a fraction of the cost.
 *
 * Anything the plan cannot express returns `{ supported: false, reason }` and the caller renders
 * that scene with FFmpeg instead. The reason is logged.
 */

import type { SceneMotionDocument } from '../contracts/scene-effects.js'

export interface MotionPlanFrame {
  /** Magnification of the canvas, 1 = the fitted picture fills the frame. */
  z: number
  /** Canvas point landing in the middle of the output frame. */
  cx: number
  cy: number
  /** Clockwise rotation of the canvas about that point, radians. */
  rot: number
  /** Gaussian sigmas, applied in order. */
  blur: number[]
  /** 0..1 brightness multiplier. */
  gain: number
}

export type MotionPlan =
  | {
      supported: true
      kind: 'camera' | 'spin' | 'static'
      frames: MotionPlanFrame[]
      /** The size the FFmpeg chain prepares the still at before the camera stage (scale + pad). */
      prepared: { w: number; h: number }
    }
  | { supported: false; reason: string }

export interface MotionPlanOpts {
  w: number
  h: number
  fps: number
  /** Clip length in seconds, the same number the FFmpeg chain is given. */
  duration: number
}

/**
 * A still loaded with `-loop 1` arrives at the filter graph as a 25 fps stream (the image2
 * demuxer's default), and the output `-r` resamples AFTER the filters. So every filter that reads
 * the clock (`rotate`'s `t`, the blur gates, `fade`'s frame counter) sees 25 fps timestamps, not
 * the output's. `zoompan` is the exception: it builds its own frames from one input. Measured
 * against FFmpeg 8.1: at 25 fps output frame n is input frame n; at 24 fps the cfr resampler drops one
 * 25 fps input frame every 24 frames once the first 28 have passed (frames 52, 76, 100... of a long clip);
 * at other rates it is the nearest input frame, ties going down.
 */
export const STILL_INPUT_FPS = 25

export function stillInputFrame(n: number, fps: number): number {
  if (fps === 25) return n
  if (fps === 24) return n + Math.max(0, Math.floor((n - 28) / 24))
  return Math.floor(n * STILL_INPUT_FPS / fps + 0.5 - 1e-9)
}

/** `zoompan` clamps its zoom to this band. */
const ZOOM_MIN = 1
const ZOOM_MAX = 10

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * How many frames the FFmpeg path produces for this clip, so the native clip has the same
 * length to the frame: `zoompan` makes `round(fps * duration)`; the looped-still path is cut by
 * `-t` and so makes `ceil(fps * duration)`.
 */
export function plannedFrameCount(camera: boolean, fps: number, duration: number): number {
  const exact = fps * duration
  return camera ? Math.max(1, Math.round(exact)) : Math.max(1, Math.ceil(exact - 1e-6))
}

/** Same even-rounding the compiler uses when it enlarges the prepared source. */
function preparedSize(value: number, scalePct: number): number {
  if (scalePct === 100) return value
  return Math.round(value * (scalePct / 100) / 2) * 2
}

export function planStillMotion(doc: SceneMotionDocument, opts: MotionPlanOpts): MotionPlan {
  const { w, h, fps, duration } = opts
  if (doc.source !== 'still') return { supported: false, reason: `motion source is ${doc.source}, not still` }
  if (!(w > 0 && h > 0 && fps > 0 && duration > 0)) return { supported: false, reason: 'bad geometry or duration' }
  if (!Number.isInteger(fps)) return { supported: false, reason: `non-integer frame rate ${fps}` }
  const scalePct = doc.framing.source_scale_pct

  // 1. Rotation — the compiler's first branch, and it ignores zoom/pan/focus/fade entirely.
  if (doc.spin.rate_rad_per_sec !== 0) {
    const count = plannedFrameCount(false, fps, duration)
    const z = preparedSize(w, scalePct) / w
    const frames: MotionPlanFrame[] = []
    for (let n = 0; n < count; n++) {
      frames.push({ z, cx: w / 2, cy: h / 2, rot: doc.spin.rate_rad_per_sec * (stillInputFrame(n, fps) / STILL_INPUT_FPS), blur: [], gain: 1 })
    }
    return { supported: true, kind: 'spin', frames, prepared: { w: preparedSize(w, scalePct), h: preparedSize(h, scalePct) } }
  }

  // 2. A virtual camera (`zoompan`). Focus and fade are not part of this branch in the compiler.
  if (doc.zoom.mode !== 'none' || doc.pan.mode !== 'none') {
    if (doc.pan.mode === 'traverse') return { supported: false, reason: 'traverse pan is a footage move' }
    const count = plannedFrameCount(true, fps, duration)
    const ss = scalePct / 100
    const perFrame = (magnitude: number) => doc.pan.rate_unit === 'source-px-per-frame'
      ? magnitude / ss               // authored on the prepared (supersampled) source
      : magnitude / fps              // output px per second
    const panX = doc.pan.mode === 'rate' ? perFrame(doc.pan.x) : 0
    const panY = doc.pan.mode === 'rate' ? perFrame(doc.pan.y) : 0

    const frames: MotionPlanFrame[] = []
    for (let n = 0; n < count; n++) {
      let zoom: number
      switch (doc.zoom.mode) {
        case 'fixed': zoom = doc.zoom.fixed_pct / 100; break
        case 'ramp': {
          const from = doc.zoom.from_pct / 100
          const to = doc.zoom.to_pct / 100
          zoom = from + n * ((to - from) / count)
          break
        }
        case 'sine':
          zoom = doc.zoom.base_pct / 100 + (doc.zoom.amplitude_pct / 100) * Math.sin(n * 2 * Math.PI / count)
          break
        default: zoom = 1
      }
      zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX)
      const winW = w / zoom
      const winH = h / zoom
      // zoompan: x = iw/2 - iw/zoom/2 + on*rate, held inside the picture.
      const x0 = clamp(w / 2 - winW / 2 + n * panX, 0, Math.max(0, w - winW))
      const y0 = clamp(h / 2 - winH / 2 + n * panY, 0, Math.max(0, h - winH))
      frames.push({ z: zoom, cx: x0 + winW / 2, cy: y0 + winH / 2, rot: 0, blur: [], gain: 1 })
    }
    return { supported: true, kind: 'camera', frames, prepared: { w: preparedSize(w, scalePct), h: preparedSize(h, scalePct) } }
  }

  // 3. No camera: fit, pad, then the focus ramp and the fades.
  const count = plannedFrameCount(false, fps, duration)
  const frames: MotionPlanFrame[] = []
  const fadeLength = Math.min(doc.fade.max_sec, duration * doc.fade.share_of_clip)
  // The compiler prints these with toFixed(2) (blur gates, fade-out) or raw (fade-in length); the
  // plan reads the same printed numbers, because that is what FFmpeg is given.
  const fadeOutStart = Number(Math.max(0, duration - fadeLength).toFixed(2))
  const fadeOutLength = Number(fadeLength.toFixed(2))
  // `fade` counts FRAMES of the 25 fps stream: round(d * 25) of them, half up.
  const framesOf = (seconds: number) => Math.max(1, Math.round(seconds * STILL_INPUT_FPS + 1e-9))
  const gates = doc.focus.stages.map((stage, index) => {
    const previous = index === 0 ? 0 : doc.focus.stages[index - 1]!.until_share
    return {
      sigma: stage.sigma,
      from: index === 0 ? null : Number((duration * previous).toFixed(2)),
      until: Number((duration * stage.until_share).toFixed(2)),
    }
  })
  for (let n = 0; n < count; n++) {
    const idx = stillInputFrame(n, fps)
    const t = idx / STILL_INPUT_FPS
    // `lt(t,until)` for the first stage, `between(t,from,until)` (inclusive both ends) after it.
    const blur = gates
      .filter(gate => gate.from === null ? t < gate.until : t >= gate.from && t <= gate.until)
      .map(gate => gate.sigma)
    let gain = 1
    if (doc.fade.in && fadeLength > 0) gain *= clamp(idx / framesOf(fadeLength), 0, 1)
    if (doc.fade.out && fadeLength > 0) {
      gain *= clamp(1 - (idx - framesOf(fadeOutStart)) / framesOf(fadeOutLength), 0, 1)
    }
    frames.push({ z: 1, cx: w / 2, cy: h / 2, rot: 0, blur, gain })
  }
  return {
    supported: true, kind: 'static', frames,
    prepared: { w: preparedSize(w, scalePct), h: preparedSize(h, scalePct) },
  }
}
