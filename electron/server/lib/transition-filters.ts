/**
 * Filter graph builders for scene-to-scene transitions.
 *
 * The video assembly pipeline prepares one MP4 per scene clip ahead of
 * time (see prepareSceneClips in generators/video.ts). Those clips
 * originally got concatenated via FFmpeg's concat demuxer with -c:v copy,
 * which is fast but cannot produce blended transitions.
 *
 * When the user picks a transition (or enables per-scene randomization)
 * we build an xfade filter_complex chain here and encode once to the
 * intermediate MP4. The concat demuxer is still used when transition='none'
 * because it's dramatically faster for the common "hard cut" case.
 */

import { TRANSITIONS, getTransition, type TransitionDef } from '../models/transitions.js'

export interface TransitionPickPlan {
  /**
   * Exactly N-1 entries, where N is the number of scene clips.
   * Each entry is the xfade keyword FFmpeg should apply at the boundary
   * between clip[i] and clip[i+1].
   */
  xfadeKeywords: string[]
  /** The duration used for each xfade boundary, seconds. */
  durationSec: number
}

/**
 * Pick transitions for every scene boundary given the user's randomize
 * settings. Deterministic when a `seed` is provided so two renders with
 * the same preset produce the same sequence.
 */
export function planTransitions(opts: {
  clipCount: number
  durationSec: number
  primaryId: string
  pool: string[]
  randomizeMode: 'off' | 'single' | 'per-scene'
  seed?: number
}): TransitionPickPlan {
  const boundaries = Math.max(0, opts.clipCount - 1)
  if (boundaries === 0) return { xfadeKeywords: [], durationSec: opts.durationSec }

  const rand = mulberry32(opts.seed ?? 1)

  let keywords: string[] = []
  if (opts.randomizeMode === 'per-scene' && opts.pool.length > 0) {
    for (let i = 0; i < boundaries; i++) {
      const pick = opts.pool[Math.floor(rand() * opts.pool.length)]
      keywords.push(resolveXfade(pick))
    }
  } else if (opts.randomizeMode === 'single' && opts.pool.length > 0) {
    const pick = opts.pool[Math.floor(rand() * opts.pool.length)]
    const kw = resolveXfade(pick)
    for (let i = 0; i < boundaries; i++) keywords.push(kw)
  } else {
    const kw = resolveXfade(opts.primaryId)
    for (let i = 0; i < boundaries; i++) keywords.push(kw)
  }

  return { xfadeKeywords: keywords, durationSec: opts.durationSec }
}

/**
 * Build the -filter_complex graph that xfades N uniformly-long clips
 * into a single video stream labelled `[vout]`. Caller is responsible for
 * passing `-map '[vout]'` and the right input list.
 *
 * Assumes clips are all the same duration. The concat list in video.ts
 * already enforces that for recycled scenes; if you extend this to
 * variable-length clips the offset calculation must accumulate actual
 * durations instead of multiplying by a constant.
 */
export function buildXfadeFilterComplex(opts: {
  inputCount: number
  clipDuration: number
  transitionDuration: number
  xfadeKeywords: string[]  // length === inputCount - 1
}): string {
  const { inputCount, clipDuration, transitionDuration, xfadeKeywords } = opts
  if (inputCount < 2) throw new Error('buildXfadeFilterComplex needs at least 2 inputs')
  if (xfadeKeywords.length !== inputCount - 1) {
    throw new Error(`expected ${inputCount - 1} transitions, got ${xfadeKeywords.length}`)
  }
  if (transitionDuration >= clipDuration) {
    throw new Error(`transitionDuration (${transitionDuration}) must be shorter than clipDuration (${clipDuration})`)
  }

  const stepDur = clipDuration - transitionDuration
  const parts: string[] = []

  // Reset each input's timestamps so xfade offsets are predictable.
  for (let i = 0; i < inputCount; i++) {
    parts.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`)
  }

  // Chain: xfade pairs feed into the next xfade left-input.
  let leftLabel = 'v0'
  for (let i = 0; i < xfadeKeywords.length; i++) {
    const rightLabel = `v${i + 1}`
    const outLabel = (i === xfadeKeywords.length - 1) ? 'vout' : `m${i}`
    const offset = ((i + 1) * stepDur).toFixed(3)
    parts.push(
      `[${leftLabel}][${rightLabel}]xfade=transition=${xfadeKeywords[i]}:duration=${transitionDuration}:offset=${offset}[${outLabel}]`
    )
    leftLabel = outLabel
  }

  return parts.join(';')
}

/**
 * Build an xfade graph for clips with real, per-input durations.
 *
 * FFmpeg's xfade `offset` is measured against the current left-hand stream.
 * After each xfade, the accumulated stream becomes shorter by one transition
 * overlap, so the next offset is:
 *   accumulatedOutputDuration - transitionDuration
 *
 * This is required for timestamp-planned scene assembly where each scene clip
 * inherits its [start_sec, end_sec] window. The uniform builder above is still
 * correct for classic recycled scenes where every input has the same duration.
 */
export function buildVariableXfadeFilterComplex(opts: {
  inputDurations: number[]
  transitionDuration: number
  xfadeKeywords: string[]
}): string {
  const { inputDurations, transitionDuration, xfadeKeywords } = opts
  const inputCount = inputDurations.length
  if (inputCount < 2) throw new Error('buildVariableXfadeFilterComplex needs at least 2 inputs')
  if (xfadeKeywords.length !== inputCount - 1) {
    throw new Error(`expected ${inputCount - 1} transitions, got ${xfadeKeywords.length}`)
  }
  const shortest = Math.min(...inputDurations)
  if (transitionDuration >= shortest) {
    throw new Error(`transitionDuration (${transitionDuration}) must be shorter than shortest clip (${shortest})`)
  }

  const parts: string[] = []
  for (let i = 0; i < inputCount; i++) {
    parts.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`)
  }

  let leftLabel = 'v0'
  let accumulatedDuration = inputDurations[0]!
  for (let i = 0; i < xfadeKeywords.length; i++) {
    const rightLabel = `v${i + 1}`
    const outLabel = (i === xfadeKeywords.length - 1) ? 'vout' : `m${i}`
    const offset = Math.max(0, accumulatedDuration - transitionDuration)
    parts.push(
      `[${leftLabel}][${rightLabel}]xfade=transition=${xfadeKeywords[i]}:duration=${transitionDuration}:offset=${offset.toFixed(3)}[${outLabel}]`
    )
    accumulatedDuration = accumulatedDuration + inputDurations[i + 1]! - transitionDuration
    leftLabel = outLabel
  }

  return parts.join(';')
}

/** Resolve a user-facing transition id (e.g. "wipe-left") to the xfade keyword. */
export function resolveXfade(id: string): string {
  const def: TransitionDef | null = getTransition(id)
  if (def && def.xfade) return def.xfade
  // Unknown or "none" — default to the basic fade so the filter graph stays valid.
  return 'fade'
}

/** Tiny seeded PRNG (mulberry32) — identical across Node and browser. */
function mulberry32(seed: number) {
  let a = seed | 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** All registered xfade keywords — useful for validators. */
export function knownXfadeKeywords(): string[] {
  return TRANSITIONS.map(t => t.xfade)
}
