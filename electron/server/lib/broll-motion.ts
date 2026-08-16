/**
 * B-Roll motion filters — a thin adapter over the declarative registry.
 *
 * These are camera moves applied to FOOTAGE, not to stills. `zoompan` (which
 * every scene animation uses) generates a whole clip from ONE input frame, so
 * pointing it at moving video freezes the clip on its first picture. The
 * footage engine in `lib/scene-effect-compiler.ts` uses a time-varying
 * `scale`+`crop` window instead, which works on every input frame regardless
 * of source type.
 *
 * v1.2.0 moved the hardcoded switch that used to live here into
 * `contracts/scene-effect-presets.ts` as data. The emitted FFmpeg is
 * unchanged: `__tests__/scene-effect-registry.test.ts` compares 45 filter
 * strings captured from the v1.1.0 tree, byte for byte.
 *
 * Each filter produces one output frame of the requested size. The caller
 * stitches the result after the trim step and before the xfade step.
 */

import { compileSceneMotion } from './scene-effect-compiler.js'
import {
  BUILT_IN_FOOTAGE_MOTIONS,
  DEFAULT_FOOTAGE_MOTION_ID,
  findFootageMotion,
} from '../contracts/scene-effect-presets.js'

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
  /** Output width/height (1920x1080 for the B-Roll assembly path). */
  w?: number
  h?: number
}

/**
 * One filter string ready to plug into a `[N:v] trim=…, [filter] [vN]` chain.
 *
 * An unrecognised or empty motion falls back to `static`, which is a plain
 * scale-and-pad — the same shape the no-motion path uses, so callers can
 * branch on a motion id without special-casing the static case.
 */
export function buildBrollMotion(opts: MotionOpts): string {
  const entry = findFootageMotion(opts.motion) || findFootageMotion(DEFAULT_FOOTAGE_MOTION_ID)!
  return compileSceneMotion(entry.document, {
    w: opts.w || 1920,
    h: opts.h || 1080,
    // Footage moves are paced from the clock, not from a frame count; the
    // compiler only reads `fps` for the still engine.
    fps: 25,
    duration: opts.duration,
  }).join(',')
}

/** UI-friendly catalogue mirror — labels + hints for the picker. */
export interface MotionDef {
  id: BrollMotion
  label: string
  hint: string
}

/**
 * DERIVED from the registry, so a new motion appears in the picker the moment
 * it appears in the library. Until v1.2.0 this was a hand-written array and
 * `broll.vue` held a second hand-written copy of it; the two had already
 * drifted apart on every hint string.
 */
export const BROLL_MOTIONS: MotionDef[] = BUILT_IN_FOOTAGE_MOTIONS.map(m => ({
  id: m.id as BrollMotion,
  label: m.name,
  hint: m.description,
}))

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
