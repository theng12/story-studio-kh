import { createHash } from 'crypto'

/**
 * The Sketch Draw closing hold: how long the finished drawing stays on screen at the end of a
 * scene. A SELECTION, never a number copied from anywhere: it resolves to exact frames per scene
 * from the scene's own length and the live frame rate.
 *
 *   off    no hold; the drawing and colour use the whole scene, only the last frame is complete.
 *   auto   follows the clip: 2.5 s, or half the scene when the scene is shorter than 5 s.
 *   fixed  a number of seconds the owner sets.
 *   range  min-max seconds, randomized per scene and derived from episode + scene id, so a re-render
 *          gives the same hold and freshness stays stable.
 *
 * Every resolved hold is at most half the scene (at least 1 frame), so the drawing always has
 * time. Scene length and narration never change. No dependencies: the backend, tests and the
 * native-helper job all import this one definition.
 */
export type SketchHoldSetting =
  | { mode: 'off' }
  | { mode: 'auto' }
  | { mode: 'fixed'; seconds: number }
  | { mode: 'range'; min_seconds: number; max_seconds: number }

export const SKETCH_HOLD_MODES = ['off', 'auto', 'fixed', 'range'] as const
export const DEFAULT_SKETCH_HOLD: SketchHoldSetting = { mode: 'auto' }
/** Input sanity only (the clamp to half the scene is what really bounds a hold). */
export const SKETCH_HOLD_MAX_SECONDS = 60

const seconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= SKETCH_HOLD_MAX_SECONDS

/** A valid setting, or a plain sentence saying what to fix. Unknown keys are ignored, never trusted. */
export function parseSketchHold(value: unknown): { ok: true; hold: SketchHoldSetting } | { ok: false; error: string } {
  const raw = (value ?? null) as Record<string, unknown> | null
  const bad = (error: string) => ({ ok: false as const, error })
  if (!raw || typeof raw !== 'object') return bad('Choose a closing hold: off, auto, a fixed number of seconds, or a range.')
  switch (raw.mode) {
    case 'off': return { ok: true, hold: { mode: 'off' } }
    case 'auto': return { ok: true, hold: { mode: 'auto' } }
    case 'fixed':
      if (!seconds(raw.seconds)) return bad(`Enter the hold in seconds, more than 0 and at most ${SKETCH_HOLD_MAX_SECONDS}.`)
      return { ok: true, hold: { mode: 'fixed', seconds: raw.seconds } }
    case 'range':
      if (!seconds(raw.min_seconds) || !seconds(raw.max_seconds)) return bad(`Enter the range in seconds, each more than 0 and at most ${SKETCH_HOLD_MAX_SECONDS}.`)
      if (raw.min_seconds > raw.max_seconds) return bad('The shortest hold cannot be longer than the longest hold.')
      return { ok: true, hold: { mode: 'range', min_seconds: raw.min_seconds, max_seconds: raw.max_seconds } }
    default: return bad('Choose a closing hold: off, auto, a fixed number of seconds, or a range.')
  }
}

/** Stored values heal to the default only when ABSENT; a stored value that does not parse is an error to surface. */
export function sketchHoldSelection(value: unknown): SketchHoldSetting {
  if (value === undefined || value === null) return DEFAULT_SKETCH_HOLD
  const parsed = parseSketchHold(value)
  if ('error' in parsed) throw new Error(`The channel's saved Sketch Draw hold is not valid. ${parsed.error}`)
  return parsed.hold
}

/** Identity of the hold setting, recorded beside each clip as evidence of what it was rendered under. */
export function sketchHoldFingerprint(hold: SketchHoldSetting): string {
  return createHash('sha256').update(JSON.stringify(hold)).digest('hex')
}

/**
 * Auto: min(2.5 s, half the clip), at least 1 frame. Under 3 frames only the finished image fits
 * (the helper requires hold_frames === frames there). Mirrors `sketchDefaultHold` in SketchDraw.swift.
 */
export function sketchDefaultHoldFrames(frames: number, fps: number): number {
  if (frames < 3) return frames
  return Math.min(frames - 2, Math.max(1, Math.round(Math.min(2.5 * fps, frames / 2))))
}

/** A repeatable value in [0, 1) for one scene of one episode. Only the episode and scene id feed it. */
export function sketchHoldUnit(episodeId: string, sceneId: string): number {
  const digest = createHash('sha256').update(`sketch-hold\n${episodeId.trim().toUpperCase()}\n${sceneId}`).digest()
  return digest.readUIntBE(0, 6) / 2 ** 48
}

/** The most a hold may take: half the scene, and the helper's own 1..frames-2 bound. */
function holdCeiling(frames: number): number {
  return Math.min(frames - 2, Math.max(1, Math.floor(frames / 2)))
}

/** The exact `hold_frames` for one scene. The only place a setting becomes a frame count. */
export function resolveSketchHoldFrames(
  hold: SketchHoldSetting,
  scene: { episodeId: string; sceneId: string; frames: number; fps: number },
): number {
  const { frames, fps } = scene
  if (!Number.isInteger(frames) || frames < 1 || !Number.isInteger(fps) || fps < 1) throw new Error('A Sketch Draw hold needs a whole number of frames and a frame rate.')
  if (frames < 3) return frames
  let wanted: number
  switch (hold.mode) {
    case 'off': return 1
    // The helper rounds half a clip to the nearest frame; the ceiling keeps an odd-frame clip at or under half.
    case 'auto': return Math.min(holdCeiling(frames), sketchDefaultHoldFrames(frames, fps))
    case 'fixed': wanted = hold.seconds * fps; break
    case 'range': wanted = (hold.min_seconds + sketchHoldUnit(scene.episodeId, scene.sceneId) * (hold.max_seconds - hold.min_seconds)) * fps; break
  }
  return Math.min(holdCeiling(frames), Math.max(1, Math.round(wanted)))
}
