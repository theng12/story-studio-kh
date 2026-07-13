/**
 * Per-scene animation filter builders.
 *
 * Each function returns an array of filter-chain tokens that — when joined
 * with "," — scale a still image to an animated clip at the requested
 * (w×h) resolution over `frames` frames at `fps` fps.
 *
 * Invariants every builder must satisfy:
 *   - Output frame size is exactly w×h.
 *   - Output SAR is 1 (setsar=1 at the end).
 *   - Output pixel format is left for the caller to append (typically yuv420p).
 *
 * The scale+pad prelude differs for zoompan-based animations (needs
 * supersampled source so the virtual camera has pixels to zoom into)
 * vs plain animations (no supersampling needed). Keep that distinction
 * in mind when adding new types.
 */

import type { VideoSceneAnimation } from '../models/types.js'

export interface AnimationFilterOpts {
  type: string
  params: VideoSceneAnimation
  w: number
  h: number
  fps: number
  duration: number
}

/**
 * Standard frame normalisation chain: scale to fit, pad with black, force SAR
 * to 1, pin the output fps, normalise to yuv420p. Every clip that flows into
 * the final concat — scene, intro, post-audio filler — must emit this shape
 * so xfade and concat can stitch them without size/SAR mismatches.
 *
 * Returned as an array because FFmpeg filter chains join tokens with `,`.
 * Hand-writing the equivalent string is how the post_fade.mp4 bug happened
 * on FFmpeg 8.1 — a stray `:setsar=1` looks like a `pad` option. Use this
 * helper; never concatenate `pad` + `setsar` by hand again.
 */
export function normalizeFrame(w: number, h: number, fps: number): string[] {
  // `setsar` intentionally comes BEFORE `pad`. FFmpeg 8.1 mis-parses
  // `pad=...:color=black,setsar=1` as if `setsar` were a pad option,
  // which blew up post_fade.mp4 renders on long episodes. Putting setsar
  // upstream sidesteps the adjacency without changing the output frame.
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    'setsar=1',
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
    'format=yuv420p',
  ]
}

/** Pick a supersampling multiplier that balances quality vs memory cost.
 *  v1.0.515 — was 4× at ≤1080p, which upscaled every source to 7680×4320
 *  (33 MP) before zoompan. zoompan is single-threaded and its per-frame cost
 *  scales with canvas area, so 4× cost ~4× the wall-clock of 2× for no
 *  visible gain (sources are typically 1–2 MP — there's no extra detail to
 *  sample past ~2×). 2× (3840×2160 at 1080p) is the standard anti-jitter
 *  level and renders scenes in seconds instead of minutes. */
export function supersampleMultiplier(_w: number, _h: number): number {
  return 2
}

/**
 * v1.0.515 — animation types whose filter chain is driven by `zoompan`.
 * zoompan generates the ENTIRE clip from a single input frame (`d` frames
 * per input frame), so callers should feed the image ONCE — using
 * `-loop 1 -t D` made ffmpeg decode + supersample-upscale the same PNG
 * ~25×D times for frames zoompan never consumed (~90% of scene-prep time).
 */
const ZOOMPAN_TYPES = new Set([
  'ken-burns', 'ken-burns-reverse', 'zoom-in', 'zoom-out', 'slow-push',
  'slow-pull', 'dolly-in', 'parallax-drift', 'pan-left', 'pan-right',
  'pan-up', 'pan-down', 'pan-diag-tl', 'pan-diag-tr', 'pan-diag-bl',
  'pan-diag-br', 'breathe', 'pulse',
])
export function isZoompanAnimation(type: string): boolean {
  return ZOOMPAN_TYPES.has(type)
}

/** Entry point — dispatches to per-type builders. Unknown types fall back to static. */
export function buildAnimationFilter(opts: AnimationFilterOpts): string[] {
  const { type, params, w, h, fps, duration } = opts
  const frames = Math.max(1, Math.round(fps * duration))
  const ss = supersampleMultiplier(w, h)
  const ssW = w * ss, ssH = h * ss

  switch (type) {
    case 'ken-burns':         return kenBurns(params, w, h, ssW, ssH, fps, frames)
    case 'ken-burns-reverse': return kenBurnsReverse(params, w, h, ssW, ssH, fps, frames)
    case 'zoom-in':           return simpleZoom(w, h, ssW, ssH, fps, frames, 1.0, 1.12, 'center')
    case 'zoom-out':          return simpleZoom(w, h, ssW, ssH, fps, frames, 1.12, 1.0, 'center')
    case 'slow-push':         return simpleZoom(w, h, ssW, ssH, fps, frames, 1.0, 1.06, 'center')
    case 'slow-pull':         return simpleZoom(w, h, ssW, ssH, fps, frames, 1.06, 1.0, 'center')
    case 'dolly-in':          return dollyIn(w, h, ssW, ssH, fps, frames)
    case 'parallax-drift':    return parallaxDrift(params, w, h, ssW, ssH, fps, frames, ss)
    case 'pan-left':          return directionalPan(w, h, ssW, ssH, fps, frames, ss, 'left', 2)
    case 'pan-right':         return directionalPan(w, h, ssW, ssH, fps, frames, ss, 'right', 2)
    case 'pan-up':            return directionalPan(w, h, ssW, ssH, fps, frames, ss, 'up', 2)
    case 'pan-down':          return directionalPan(w, h, ssW, ssH, fps, frames, ss, 'down', 2)
    case 'pan-diag-tl':       return diagonalPan(w, h, ssW, ssH, fps, frames, ss, 'up', 'left', 1.5)
    case 'pan-diag-tr':       return diagonalPan(w, h, ssW, ssH, fps, frames, ss, 'up', 'right', 1.5)
    case 'pan-diag-bl':       return diagonalPan(w, h, ssW, ssH, fps, frames, ss, 'down', 'left', 1.5)
    case 'pan-diag-br':       return diagonalPan(w, h, ssW, ssH, fps, frames, ss, 'down', 'right', 1.5)
    case 'breathe':           return breathe(params, w, h, ssW, ssH, fps, frames, 0.02, 1.03)
    case 'pulse':          return breathe(params, w, h, ssW, ssH, fps, frames, 0.04, 1.05)
    case 'rotate-cw':      return rotate(w, h, fps, duration, +0.02)
    case 'rotate-ccw':     return rotate(w, h, fps, duration, -0.02)
    case 'fade-in':        return plain(w, h).concat([`fade=t=in:st=0:d=${Math.min(1.5, duration / 2)}`])
    case 'fade-out': {
      const fadeDur = Math.min(1.5, duration / 2)
      const fadeStart = Math.max(0, duration - fadeDur)
      return plain(w, h).concat([`fade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeDur.toFixed(2)}`])
    }
    case 'blur-focus': {
      // Box blur ramping down: strong early, zero by the end.
      // Can't easily animate boxblur params, so use two enable-gated
      // filter applications that blend over time.
      return plain(w, h).concat([
        `gblur=sigma=8:enable='lt(t,${(duration * 0.3).toFixed(2)})'`,
        `gblur=sigma=4:enable='between(t,${(duration * 0.3).toFixed(2)},${(duration * 0.6).toFixed(2)})'`,
        `gblur=sigma=1.5:enable='between(t,${(duration * 0.6).toFixed(2)},${(duration * 0.85).toFixed(2)})'`,
      ])
    }
    case 'none':
    default:
      return plain(w, h)
  }
}

function plain(w: number, h: number): string[] {
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
  ]
}

function kenBurns(p: VideoSceneAnimation, w: number, h: number, ssW: number, ssH: number, fps: number, frames: number): string[] {
  const zoomStart = (p.zoom_start || 100) / 100
  const zoomEnd = (p.zoom_end || 108) / 100
  const zoomInc = (zoomEnd - zoomStart) / frames
  return [
    `scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease`,
    `pad=${ssW}:${ssH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `zoompan=z='${zoomStart}+on*${zoomInc.toFixed(10)}':x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`,
    `scale=${w}:${h}:flags=lanczos`,
    'setsar=1',
  ]
}

function simpleZoom(
  w: number, h: number, ssW: number, ssH: number, fps: number, frames: number,
  startZoom: number, endZoom: number, anchor: 'center',
): string[] {
  const inc = (endZoom - startZoom) / frames
  // Anchor is always center for these — off-center zooms are Ken Burns.
  return [
    `scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease`,
    `pad=${ssW}:${ssH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `zoompan=z='${startZoom}+on*${inc.toFixed(10)}':x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`,
    `scale=${w}:${h}:flags=lanczos`,
    'setsar=1',
  ]
}

function dollyIn(w: number, h: number, ssW: number, ssH: number, fps: number, frames: number): string[] {
  // Zoom from 100% → 108% while the framing drifts slightly downward —
  // reads as a dolly-in with a gentle tilt-down. Good for establishing shots.
  const startZ = 1.0, endZ = 1.08
  const inc = (endZ - startZ) / frames
  return [
    `scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease`,
    `pad=${ssW}:${ssH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `zoompan=z='${startZ}+on*${inc.toFixed(10)}':x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2)+on*0.6)':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`,
    `scale=${w}:${h}:flags=lanczos`,
    'setsar=1',
  ]
}

function parallaxDrift(p: VideoSceneAnimation, w: number, h: number, ssW: number, ssH: number, fps: number, frames: number, ss: number): string[] {
  const dir = p.parallax_direction || 'right'
  const speed = p.parallax_speed || 2
  return directionalPan(w, h, ssW, ssH, fps, frames, ss, dir as any, speed)
}

function directionalPan(
  w: number, h: number, ssW: number, ssH: number, fps: number, frames: number, ss: number,
  dir: 'left' | 'right' | 'up' | 'down', speed: number,
): string[] {
  const panPerFrame = (speed * ss) / fps
  let xExpr: string, yExpr: string
  if (dir === 'left') {
    xExpr = `floor(iw/2-(iw/zoom/2)-on*${panPerFrame.toFixed(6)})`
    yExpr = `floor(ih/2-(ih/zoom/2))`
  } else if (dir === 'right') {
    xExpr = `floor(iw/2-(iw/zoom/2)+on*${panPerFrame.toFixed(6)})`
    yExpr = `floor(ih/2-(ih/zoom/2))`
  } else if (dir === 'up') {
    xExpr = `floor(iw/2-(iw/zoom/2))`
    yExpr = `floor(ih/2-(ih/zoom/2)-on*${panPerFrame.toFixed(6)})`
  } else {
    xExpr = `floor(iw/2-(iw/zoom/2))`
    yExpr = `floor(ih/2-(ih/zoom/2)+on*${panPerFrame.toFixed(6)})`
  }
  return [
    `scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease`,
    `pad=${ssW}:${ssH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `zoompan=z=1.08:x='${xExpr}':y='${yExpr}':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`,
    `scale=${w}:${h}:flags=lanczos`,
    'setsar=1',
  ]
}

function breathe(p: VideoSceneAnimation, w: number, h: number, ssW: number, ssH: number, fps: number, frames: number, amplitudeDefault: number, baseDefault: number): string[] {
  // User-supplied params override defaults so the existing UI keeps working.
  const baseZoom = p.breathe_base_zoom ? p.breathe_base_zoom / 100 : baseDefault
  const amplitude = p.breathe_amplitude ? p.breathe_amplitude / 100 : amplitudeDefault
  return [
    `scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease`,
    `pad=${ssW}:${ssH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `zoompan=z='${baseZoom}+${amplitude}*sin(on*2*PI/${frames})':x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`,
    `scale=${w}:${h}:flags=lanczos`,
    'setsar=1',
  ]
}

function kenBurnsReverse(p: VideoSceneAnimation, w: number, h: number, ssW: number, ssH: number, fps: number, frames: number): string[] {
  // Swap zoom endpoints — starts tight and pulls back. User can still tune
  // zoom_start / zoom_end via preset params; we just apply them in reverse
  // direction when they left the defaults (start > end).
  const zStart = (p.zoom_end || 108) / 100      // finish of ken-burns = start of reverse
  const zEnd = (p.zoom_start || 100) / 100
  const zoomInc = (zEnd - zStart) / frames
  return [
    `scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease`,
    `pad=${ssW}:${ssH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `zoompan=z='${zStart}+on*${zoomInc.toFixed(10)}':x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`,
    `scale=${w}:${h}:flags=lanczos`,
    'setsar=1',
  ]
}

function diagonalPan(
  w: number, h: number, ssW: number, ssH: number, fps: number, frames: number, ss: number,
  vert: 'up' | 'down', horiz: 'left' | 'right', speed: number,
): string[] {
  // Two-axis pan — combine the x + y expressions of directionalPan. Speed is
  // divided by √2 per axis so the diagonal distance matches the single-axis
  // rate (otherwise diagonals pan noticeably faster than pan-left/right).
  const axialSpeed = speed / Math.SQRT2
  const panPerFrame = (axialSpeed * ss) / fps
  const xSign = horiz === 'left' ? '-' : '+'
  const ySign = vert === 'up' ? '-' : '+'
  const xExpr = `floor(iw/2-(iw/zoom/2)${xSign}on*${panPerFrame.toFixed(6)})`
  const yExpr = `floor(ih/2-(ih/zoom/2)${ySign}on*${panPerFrame.toFixed(6)})`
  return [
    `scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease`,
    `pad=${ssW}:${ssH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `zoompan=z=1.08:x='${xExpr}':y='${yExpr}':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`,
    `scale=${w}:${h}:flags=lanczos`,
    'setsar=1',
  ]
}

function rotate(w: number, h: number, fps: number, duration: number, radPerSec: number): string[] {
  // rotate filter is frame-by-frame; pad after so we don't show the rotated corners.
  // Scale up first so after rotation + crop we still have full coverage.
  const ssW = Math.round(w * 1.1)
  const ssH = Math.round(h * 1.1)
  // Rotation is measured in radians; we use `t` time var so it moves smoothly over duration.
  return [
    `scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease`,
    `pad=${ssW}:${ssH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `rotate='${radPerSec}*t':ow=${w}:oh=${h}:c=black@0`,
    `crop=${w}:${h}`,
    'setsar=1',
  ]
}
