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

import { getTransition, type TransitionDef } from '../models/transitions.js'
import { regionMergeStatements } from './scene-effect-compiler.js'
import { mulberry32 } from './seeded-random.js'

export interface TransitionPickPlan {
  /**
   * Exactly N-1 entries, where N is the number of scene clips.
   * Each entry is the xfade keyword FFmpeg should apply at the boundary
   * between clip[i] and clip[i+1].
   */
  xfadeKeywords: string[]
  /** The duration used for each xfade boundary, seconds. */
  durationSec: number
  /**
   * E1 — the transition id at each boundary, present only when one of them has an engine
   * (soft blur dissolve, dip to black, ink or watercolour bleed). Absent, every boundary is the
   * plain xfade it always was.
   */
  ids?: string[]
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

  const ids: string[] = []
  if (opts.randomizeMode === 'per-scene' && opts.pool.length > 0) {
    for (let i = 0; i < boundaries; i++) ids.push(opts.pool[Math.floor(rand() * opts.pool.length)]!)
  } else if (opts.randomizeMode === 'single' && opts.pool.length > 0) {
    const pick = opts.pool[Math.floor(rand() * opts.pool.length)]!
    for (let i = 0; i < boundaries; i++) ids.push(pick)
  } else {
    for (let i = 0; i < boundaries; i++) ids.push(opts.primaryId)
  }
  const keywords = ids.map(resolveXfade)
  return {
    xfadeKeywords: keywords,
    durationSec: opts.durationSec,
    ...(ids.some(id => getTransition(id)?.engine) ? { ids: ids.map(id => getTransition(id)?.id ?? id) } : {}),
  }
}

/** The boundaries of `ids` that need {@link buildEngineTransitionFilterComplex}. */
export function hasTransitionEngine(ids: readonly string[] | undefined): boolean {
  return !!ids?.some(id => getTransition(id)?.engine)
}

/** The plain xfade keyword every engine boundary falls back to. */
export function fallbackXfadeKeywords(ids: readonly string[]): string[] {
  return ids.map(resolveXfade)
}

/** The tags every scene clip is encoded with (`sceneClipEncodeArgs`); metadata only, no conversion. */
const CLIP_TAGS = 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709'

/** Seconds of full black a Dip to Black holds in the middle of its transition. */
export const DIP_BLACK_HOLD_SEC = 0.3
/** How soft the Soft Blur Dissolve gets at its middle, px at 1080 lines. */
export const BLUR_DISSOLVE_SIGMA_PX = 12

/**
 * The xfade chain of {@link buildVariableXfadeFilterComplex}, with E1's engine boundaries:
 *
 *  - **Dip to black** (`clip-ramp`/`dip`): the outgoing clip fades to black over the first
 *    (T − hold)/2 of the overlap and stays black; the incoming one is black until (T + hold)/2 and
 *    then fades up. Crossfaded, the middle `hold` seconds are pure black.
 *  - **Soft blur dissolve** (`clip-ramp`/`blur`): over the overlap a blurred copy of each clip is
 *    faded in (outgoing) or out (incoming) on top of it, then the two are crossfaded — both are
 *    softest at the middle. The blur only runs during the overlap.
 *  - **Ink / watercolour bleed** (`matte`): the boundary is cut out of the chain with `trim` and
 *    rebuilt as `maskedmerge(outgoing tail, incoming head, matte)` between the untouched parts —
 *    the same offsets and the same total length as the xfade it replaces. `matteInput(i)` names the
 *    baked matte for boundary i; null (the bake failed) makes it a plain crossfade.
 *
 * Plain boundaries in the same chunk are the same xfade statements as always.
 */
export function buildEngineTransitionFilterComplex(opts: {
  inputDurations: number[]
  transitionDuration: number
  ids: string[]
  width: number
  height: number
  fps: number
  matteInput?: (boundary: number) => string | null
}): string {
  const { inputDurations, transitionDuration: T, ids, width, height, fps } = opts
  const count = inputDurations.length
  if (count < 2) throw new Error('buildEngineTransitionFilterComplex needs at least 2 inputs')
  if (ids.length !== count - 1) throw new Error(`expected ${count - 1} transitions, got ${ids.length}`)
  if (T >= Math.min(...inputDurations)) throw new Error(`transitionDuration (${T}) must be shorter than shortest clip (${Math.min(...inputDurations)})`)
  const defs = ids.map(id => getTransition(id))
  const f = (n: number) => n.toFixed(3)
  const parts: string[] = []
  let n = 0
  const alloc = () => `[tx${n++}]`
  const hold = Math.min(DIP_BLACK_HOLD_SEC, T / 2)
  const sigma = Math.max(0.5, BLUR_DISSOLVE_SIGMA_PX * height / 1080)

  for (let i = 0; i < count; i++) {
    const d = inputDurations[i]!
    const head = i > 0 ? defs[i - 1] : null
    const tail = i < count - 1 ? defs[i] : null
    // One time base everywhere: `concat` (the bleed) answers in microseconds, and xfade refuses a mismatch.
    // One set of colour tags everywhere too: a grey matte tagged differently from the clips makes
    // FFmpeg convert its planes as if they were colour, and the merge then leaks the next scene's chroma.
    const chain = ['setpts=PTS-STARTPTS', 'settb=AVTB', CLIP_TAGS]
    if (head?.ramp === 'dip') chain.push(`fade=t=in:st=${f((T + hold) / 2)}:d=${f((T - hold) / 2)}`)
    if (tail?.ramp === 'dip') chain.push(`fade=t=out:st=${f(d - T)}:d=${f((T - hold) / 2)}`)
    const blurs = [head?.ramp === 'blur' ? 'head' : null, tail?.ramp === 'blur' ? 'tail' : null].filter(Boolean) as Array<'head' | 'tail'>
    if (!blurs.length) { parts.push(`[${i}:v]${chain.join(',')}[v${i}]`); continue }
    const copies = blurs.map(() => alloc())
    const sharp = alloc()
    parts.push(`[${i}:v]${chain.join(',')},split=${blurs.length + 1}${sharp}${copies.join('')}`)
    let base = sharp
    blurs.forEach((side, k) => {
      const window = side === 'head' ? `lt(t,${f(T)})` : `gte(t,${f(d - T)})`
      const fade = side === 'head' ? `fade=t=out:st=0:d=${f(T)}:alpha=1` : `fade=t=in:st=${f(d - T)}:d=${f(T)}:alpha=1`
      const soft = alloc()
      const out = k === blurs.length - 1 ? `[v${i}]` : alloc()
      parts.push(`${copies[k]}gblur=sigma=${sigma.toFixed(2)}:enable='${window}',format=yuva420p,${fade}${soft}`)
      parts.push(`${base}${soft}overlay=0:0:enable='${window}',format=yuv420p${out}`)
      base = out
    })
  }

  let left = '[v0]'
  let accumulated = inputDurations[0]!
  for (let i = 0; i < ids.length; i++) {
    const right = `[v${i + 1}]`
    const out = i === ids.length - 1 ? '[vout]' : `[m${i}]`
    const offset = Math.max(0, accumulated - T)
    const def = defs[i]
    const matte = def?.engine === 'matte' ? opts.matteInput?.(i) ?? null : null
    if (matte) {
      const lp = alloc(), lt = alloc(), pre = alloc(), tailClip = alloc()
      const rp = alloc(), rr = alloc(), headClip = alloc(), rest = alloc(), sized = alloc(), merged = alloc(), mixed = alloc()
      // The three merged streams get the same frame grid, or framesync emits a frame for every
      // microsecond of rounding between them.
      const grid = `setpts=N/(${fps}*TB)`
      // xfade's arithmetic, frame for frame: the outgoing picture up to `offset`, then every frame of
      // the incoming one. The mixed part is exactly the incoming head (T s); the outgoing tail is
      // held a frame longer in case it is a frame short, and anything past T is dropped.
      parts.push(
        `${left}split=2${lp}${lt}`,
        `${lp}trim=end=${f(offset)},setpts=PTS-STARTPTS${pre}`,
        `${lt}trim=start=${f(offset)},${grid},tpad=stop_mode=clone:stop=2${tailClip}`,
        `${right}split=2${rp}${rr}`,
        `${rp}trim=end=${f(T)},${grid}${headClip}`,
        `${rr}trim=start=${f(T)},setpts=PTS-STARTPTS${rest}`,
        `${matte}settb=AVTB,${grid},scale=${width}:${height}:flags=bicubic,tpad=stop_mode=clone:stop=2${sized}`,
        ...regionMergeStatements(tailClip, headClip, sized, merged, alloc).map(st => st.replace(/format=yuv420p(\[[^\]]+\])$/, `format=yuv420p,${CLIP_TAGS}$1`)),
        `${merged}trim=end=${f(T)},${grid}${mixed}`,
        `${pre}${mixed}${rest}concat=n=3:v=1:a=0${out}`,
      )
    } else {
      const keyword = def?.engine ? 'fade' : resolveXfade(ids[i]!)
      parts.push(`${left}${right}xfade=transition=${keyword}:duration=${T}:offset=${f(offset)}${out}`)
    }
    accumulated = accumulated + inputDurations[i + 1]! - T
    left = out
  }
  return parts.join(';')
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
