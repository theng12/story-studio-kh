/**
 * B-Roll motion filters — Ken-Burns-style camera moves applied to VIDEO
 * sources (not stills). The existing animation-filters.ts is built on
 * `zoompan`, which is a still-image-to-video filter and doesn't compose
 * cleanly with already-moving video frames. This module uses `scale` +
 * `crop` with time-varying expressions instead — works on every input
 * frame regardless of source type.
 *
 * Each filter produces a 1920×1080 frame. Caller stitches the result
 * after the trim step and before the xfade step.
 */

export type BrollMotion =
  | 'static'
  | 'zoom-in'
  | 'zoom-out'
  | 'pan-left'
  | 'pan-right'
  | 'pan-up'
  | 'pan-down'

export interface MotionOpts {
  motion: BrollMotion
  /** Clip's target duration in seconds — drives the rate of motion. */
  duration: number
  /** Output width/height (1920×1080 for the B-Roll assembly path). */
  w?: number
  h?: number
}

/**
 * Returns one filter string ready to plug into a `[N:v] trim=…, [filter] [vN]`
 * chain. The filter scales the source to fit the output frame (1080p),
 * pads to cover, then applies a time-varying crop that produces the
 * requested motion.
 *
 * Static = scale+pad with no motion. Same shape the no-motion path
 * already uses — kept here so callers can branch on motion id without
 * special-casing the static case.
 *
 * Notes on the math
 * - `t` is the current playhead time in seconds inside this segment.
 *   So progress is `t/duration` from 0 to 1 over the segment's run.
 * - Zoom magnitude is 6.7% (1.0 → 1.067). Subtle enough to read as a
 *   slow gentle camera move at prayer / devotional pacing; aggressive
 *   enough to be visible. Two-decimal because ffmpeg's crop x/y are
 *   pixel-rounded.
 * - Pan magnitude is the horizontal/vertical headroom afforded by the
 *   1.05× pre-scale (≈ 96px on 1920 / 54px on 1080). Same subtle band.
 * - Final `scale=W:H` lossless smooths any rounding artifacts at the
 *   1920×1080 boundary, since `crop` outputs whatever it cropped (could
 *   be 1919×1080 due to rounding under some t values).
 */
export function buildBrollMotion(opts: MotionOpts): string {
  const w = opts.w || 1920
  const h = opts.h || 1080
  const d = Math.max(0.1, opts.duration)
  const dStr = d.toFixed(3)

  // Static (no motion). Same shape as the existing no-animation path.
  if (opts.motion === 'static' || !opts.motion) {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,` +
           `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`
  }

  // Implementation notes — why these specific filters
  //
  // Earlier versions used time-varying `crop` with max()-clamped w/h to
  // simulate zoom. libx264 choked on the resulting variable-sized
  // frames ("Could not open encoder before EOF"). The fix is to keep
  // frame size CONSTANT throughout the motion filter and animate the
  // CONTENT instead — either by sliding a fixed-size crop window over
  // a pre-scaled larger source (pan), or by scaling the source to a
  // time-varying size and cropping a fixed center window (zoom).
  //
  // `scale=...:eval=frame` recomputes the scale params on every frame
  // (default `eval=init` would freeze them at first frame). `flags=
  // lanczos` is sharper than the default bicubic at small zoom factors.
  // Final `scale=w:h` is the safety net — ensures output frame size is
  // exact even when intermediate filters have rounding edges.

  const ssZoom = 1.10  // zoom magnitude: 1.0 → 1.10 over the segment

  switch (opts.motion) {
    case 'zoom-in': {
      // Source grows from 1.00× → 1.10× over the segment. Center crop
      // stays a fixed 1920×1080, so as the source grows, the effective
      // framing zooms IN toward the subject. Output frame size is
      // CONSTANT 1920×1080 throughout — libx264 can't ingest variable
      // sizes mid-stream so this matters.
      return `scale=w='${w}*(1+${(ssZoom - 1).toFixed(4)}*t/${dStr})':h=-2:eval=frame:flags=lanczos,` +
             `crop=${w}:${h}:(in_w-${w})/2:(in_h-${h})/2,setsar=1`
    }
    case 'zoom-out': {
      // Source shrinks from 1.10× → 1.00× over the segment. Center crop
      // stays fixed; effective framing pulls back over time.
      return `scale=w='${w}*(${ssZoom.toFixed(4)}-${(ssZoom - 1).toFixed(4)}*t/${dStr})':h=-2:eval=frame:flags=lanczos,` +
             `crop=${w}:${h}:(in_w-${w})/2:(in_h-${h})/2,setsar=1`
    }
    case 'pan-left':
    case 'pan-right': {
      // Pre-scale to ssW×h (wider than output), then slide a fixed
      // 1920-wide crop window across the horizontal slack.
      const ssW = Math.round(w * 1.10)
      const slackX = ssW - w  // pixels of horizontal headroom
      const dir = opts.motion === 'pan-left'
        ? `${slackX}-${slackX}*t/${dStr}`   // right → left
        : `${slackX}*t/${dStr}`             // left → right
      return `scale=${ssW}:${h}:force_original_aspect_ratio=increase:flags=lanczos,` +
             `crop=${w}:${h}:x='${dir}':y='(in_h-${h})/2',setsar=1`
    }
    case 'pan-up':
    case 'pan-down': {
      const ssH = Math.round(h * 1.10)
      const slackY = ssH - h
      const dir = opts.motion === 'pan-up'
        ? `${slackY}-${slackY}*t/${dStr}`
        : `${slackY}*t/${dStr}`
      return `scale=${w}:${ssH}:force_original_aspect_ratio=increase:flags=lanczos,` +
             `crop=${w}:${h}:x='(in_w-${w})/2':y='${dir}',setsar=1`
    }
  }
  // Fallback — exhaustive switch should make this unreachable.
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,` +
         `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`
}

/** UI-friendly catalogue mirror — labels + hints for the picker. */
export interface MotionDef {
  id: BrollMotion
  label: string
  hint: string
}

export const BROLL_MOTIONS: MotionDef[] = [
  { id: 'static',    label: 'Static',        hint: 'No camera move. Cleanest cuts; lets the footage carry the rhythm.' },
  { id: 'zoom-in',   label: 'Slow Zoom In',  hint: 'Subtle push toward the subject over the clip. Adds intimacy.' },
  { id: 'zoom-out',  label: 'Slow Zoom Out', hint: 'Subtle pull-back. Reveals more of the scene over time.' },
  { id: 'pan-left',  label: 'Pan Left',      hint: 'Camera drifts left across the frame.' },
  { id: 'pan-right', label: 'Pan Right',     hint: 'Camera drifts right across the frame.' },
  { id: 'pan-up',    label: 'Pan Up',        hint: 'Camera drifts upward.' },
  { id: 'pan-down',  label: 'Pan Down',      hint: 'Camera drifts downward.' },
]

/** Pick a random motion from the rotation pool (deterministic with seed). */
export function pickRotatedMotion(pool: BrollMotion[], seed: number): BrollMotion {
  if (!pool.length) return 'static'
  // Mulberry32 for reproducibility — same seed → same pick.
  let s = seed | 0
  s = (s + 0x6D2B79F5) | 0
  let t = Math.imul(s ^ (s >>> 15), 1 | s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return pool[Math.floor(u * pool.length)]!
}
