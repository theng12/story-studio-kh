/**
 * The reveal compiler: a `SceneRevealDocument` in, an FFmpeg filter graph out.
 *
 * **One primitive does the work.** A reveal is a chain of `xfade` steps — the
 * same filter the scene-to-scene transitions already use
 * (`lib/transition-filters.ts`) — and the picture itself is driven by the still
 * camera engine that already exists (`compileSceneMotion`), so the drift during
 * a hold is the *same code* as Ken Burns rather than a second implementation of
 * it.
 *
 * The chain is:
 *
 * ```
 * field ──xfade(r1)──▶ layer1 ──xfade(r2)──▶ … ──xfade(rN)──▶ picture ──xfade(e)──▶ tint …
 * ```
 *
 * `xfade` advances the timeline by the *right-hand* input's length, so the
 * durations are chosen the other way round from how they read: the field is
 * only as long as the first transition, each layer is only as long as its own,
 * and the picture carries the hold. That arithmetic is in `planRevealStages`,
 * and `assertStagesAdvance` refuses a plan whose transitions overlap — a graph
 * that produces a shorter clip than the timeline expects is how an episode
 * drifts out of sync with its narration.
 */

import {
  normalizeSceneReveal,
  type ResolvedRevealTiming,
  type SceneRevealDocument,
  type SceneRevealLayer,
} from '../contracts/scene-reveal.js'
import { mergeSceneMotion, type SceneMotionDocument } from '../contracts/scene-effects.js'
import { defaultSceneMotion } from '../contracts/scene-effects.js'
import { compileSceneMotion } from './scene-effect-compiler.js'
import { getTransition } from '../models/transitions.js'

export interface RevealCompileOpts {
  w: number
  h: number
  fps: number
  timing: ResolvedRevealTiming
  /** The input label carrying the still, e.g. `0:v`. */
  sourceLabel?: string
  /**
   * The picture's drift was already rendered to a clip (by the native scene-clip helper), so input
   * `0:v` is that clip and the still itself, needed only for an image-mode field, is input `1:v`.
   * Everything the reveal DOES (the field, the xfade wipes, the micro-events) is unchanged and
   * still FFmpeg's — only the expensive `zoompan` stage is replaced, so timing and easing are
   * bit-identical to the all-FFmpeg graph.
   */
  prerenderedPicture?: boolean
}

/** One step of the chain, in the order it is applied. */
export interface RevealStage {
  /** `field` for the opening state, `layer` for a palette layer, `picture` last. */
  kind: 'field' | 'layer' | 'picture' | 'tint'
  /** The xfade keyword that brings this stage in. The field's own entry is `''`. */
  transition: string
  /** How long this stage's own transition runs, seconds. */
  duration: number
  /**
   * How long the STREAM this stage brings in must be.
   *
   * `xfade` advances the accumulated timeline by the right-hand input's whole
   * length, not by the transition: the output is `offset + right_duration`. So
   * an intermediate stage only needs its own transition's worth of frames,
   * while the picture (and every micro-event after it) has to carry everything
   * from its offset to the end of the clip.
   */
  segment: number
  /** Where the transition starts on the accumulated timeline, seconds. */
  offset: number
  /** The colour a `field`/`layer` stage draws; undefined for the picture. */
  colour?: string
  /** A palette layer's own description, kept for logs and tests. */
  layer?: SceneRevealLayer
}

/**
 * The chain plan — the arithmetic, isolated so it can be tested without FFmpeg.
 *
 * Palette layers divide the reveal window by their `share_pct`; micro-events
 * become tint steps *after* the reveal, at the offsets `resolveRevealTiming`
 * staged. Every number is rounded to milliseconds so a plan compiled twice is
 * byte-identical — this project's whole method depends on same-input-same-output,
 * and a float that prints as `1.2000000000000002` would break it.
 */
export function planRevealStages(
  doc: SceneRevealDocument,
  timing: ResolvedRevealTiming,
): RevealStage[] {
  const layers = doc.family === 'palette' ? doc.layers : []
  const reveal = timing.reveal_seconds
  const total = timing.total_seconds

  // ── The transitions, in order ────────────────────────────────────────────
  //
  // One per palette layer, then one for the picture itself: the picture is
  // revealed *by* a transition, so it needs a slice of the window or the layers
  // would consume the whole arrival. Layer shares weight the split; the
  // picture's slice is one unit of its own.
  const shares = layers.length ? normalizeShares(layers) : []
  const weights = layers.length ? [...shares, 100] : [100]
  const weightTotal = weights.reduce((sum, value) => sum + value, 0)
  const steps = weights.map(weight => round3((reveal * weight) / weightTotal))
  // Rounding can lose a millisecond or two; the last step absorbs it so the
  // arrival is exactly `timing.reveal_seconds` long.
  const drift = round3(reveal - steps.reduce((sum, value) => sum + value, 0))
  steps[steps.length - 1] = round3(steps[steps.length - 1]! + drift)

  interface Step { kind: RevealStage['kind']; transition: string; duration: number; offset: number; colour?: string; layer?: SceneRevealLayer }
  const transitions: Step[] = layers.map((layer, index) => ({
    kind: 'layer' as const,
    transition: layer.transition,
    duration: steps[index]!,
    offset: 0,
    colour: layer.colour,
    layer,
  }))
  transitions.push({
    kind: 'picture',
    transition: doc.transition,
    duration: steps[steps.length - 1]!,
    offset: 0,
  })

  // Offsets are cumulative: each transition starts where the previous one ended.
  let running = 0
  for (const step of transitions) {
    step.offset = running
    running = round3(running + step.duration)
  }

  const stages: RevealStage[] = [{
    kind: 'field', transition: '', duration: transitions[0]!.duration, segment: 0,
    offset: 0, colour: doc.field.colour,
  }]
  for (const step of transitions) {
    stages.push({
      kind: step.kind,
      transition: step.transition,
      duration: step.duration,
      offset: step.offset,
      segment: 0,
      ...(step.colour ? { colour: step.colour } : {}),
      ...(step.layer ? { layer: step.layer } : {}),
    })
  }

  // Micro-events during the hold: a short re-grade of the same drifting picture,
  // at the offsets the pacer staged.
  for (const [index, at] of timing.micro_event_offsets.entries()) {
    stages.push({
      kind: 'tint',
      transition: index % 2 === 0 ? 'fade' : 'fadeblack',
      duration: round3(Math.min(0.9, Math.max(0.4,
        timing.hold_seconds / (timing.micro_event_offsets.length + 1)))),
      segment: 0,
      offset: round3(at),
    })
  }

  // ── The segments ─────────────────────────────────────────────────────────
  //
  // `xfade(A, B, offset, duration)` emits `offset + len(B)` seconds, so a stage's
  // stream has to live from its own offset until the *next* transition finishes —
  // not just for its own duration. The last stage carries the rest of the clip.
  // Getting this wrong is not a visual glitch: the clip comes out shorter than
  // the timeline allocated and the narration drifts scenes later.
  for (const [index, stage] of stages.entries()) {
    const next = stages[index + 1]
    stage.segment = next
      ? round3(next.offset + next.duration - stage.offset)
      : round3(total - stage.offset)
  }
  // The field has no transition of its own, so its duration is how long it is
  // alone on screen — which is exactly its segment.
  stages[0]!.duration = stages[0]!.segment
  return stages
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Layer shares are weights, not percentages: they are normalised to sum to 100. */
function normalizeShares(layers: SceneRevealLayer[]): number[] {
  const total = layers.reduce((sum, layer) => sum + layer.share_pct, 0)
  if (total <= 0) return layers.map(() => 100 / layers.length)
  return layers.map(layer => (layer.share_pct / total) * 100)
}

/**
 * Refuse a plan whose *transitions* overlap or run past the clip.
 *
 * The invariant is about transitions, not segments: a field and the picture it
 * reveals are on screen together for the length of the reveal — that overlap is
 * the crossfade, not a mistake. What must never overlap is one transition with
 * the next, and the chain must end exactly where the timeline says it does.
 *
 * Why fail here rather than let FFmpeg sort it out: an overlapping chain still
 * *renders*, and produces a clip shorter than the timeline allocated it. That
 * shows up as narration drifting against the picture several scenes later,
 * which is expensive to trace back; this names the stage instead.
 */
export function assertStagesAdvance(stages: RevealStage[], totalSeconds: number): void {
  let transitionEnd = 0
  let last: RevealStage | null = null
  for (const stage of stages) {
    last = stage
    if (stage.kind === 'field') {
      if (stage.segment <= 0) throw new Error('reveal field has no duration')
      continue
    }
    if (stage.duration <= 0) throw new Error(`reveal stage ${stage.kind} has no transition length`)
    if (stage.offset + 0.001 < transitionEnd) {
      throw new Error(
        `reveal stage ${stage.kind} starts at ${stage.offset}s, before the previous transition `
        + `ended at ${transitionEnd}s — overlapping transitions shorten the clip`,
      )
    }
    transitionEnd = round3(stage.offset + stage.duration)
  }
  if (last) {
    const end = round3(last.offset + last.segment)
    if (Math.abs(end - round3(totalSeconds)) > 0.01) {
      throw new Error(
        `reveal stages end at ${end}s but the scene is ${totalSeconds}s — the clip would be `
        + (end < totalSeconds ? 'short of its window' : 'trimmed mid-transition'),
      )
    }
  }
}

export interface CompiledReveal {
  /** `filter_complex` fragments, in order. */
  filters: string[]
  /** The label carrying the finished clip. */
  output: string
  /** Seconds the graph is built to produce. */
  duration: number
  /** Whether the picture stream comes from `zoompan` (i.e. a single-frame input). */
  singleFrameInput: boolean
}

/** `#rrggbb` → the `0xRRGGBB` literal FFmpeg's `color=` filter wants. */
export function ffmpegColour(hex: string): string {
  return `0x${hex.replace('#', '').toLowerCase()}`
}

/**
 * The drift the hold gets, as a camera-move document.
 *
 * Reusing `SceneMotionDocument` is the point: the hold's push-in is compiled by
 * the same code as `Ken Burns`, so its supersampling, its rounding and its
 * lanczos rescale are already the ones this app ships. A second zoompan builder
 * here would be free to drift away from that one.
 */
export function revealDriftMotion(doc: SceneRevealDocument): SceneMotionDocument {
  const from = doc.hold.drift_direction === 'in' ? 100 : 100 + doc.hold.drift_pct
  const to = doc.hold.drift_direction === 'in' ? 100 + doc.hold.drift_pct : 100
  return mergeSceneMotion(defaultSceneMotion(), {
    source: 'still',
    framing: { source_scale_pct: 200 },
    zoom: { mode: 'ramp', from_pct: from, to_pct: to },
  })
}

/**
 * Compile the whole graph.
 *
 * One input: the still. The picture is split once per consumer (the reveal and
 * each micro-event's re-grade), because a filter output can only be consumed
 * once; each copy is graded identically apart from the tint, so the drift is
 * continuous *through* a micro-event rather than restarting at it.
 */
export function compileSceneReveal(
  input: SceneRevealDocument,
  opts: RevealCompileOpts,
): CompiledReveal {
  const doc = normalizeSceneReveal(input)
  const { w, h, fps } = opts
  const timing = opts.timing
  const source = opts.sourceLabel ?? '0:v'
  const stages = planRevealStages(doc, timing)
  assertStagesAdvance(stages, timing.total_seconds)

  const picture = stages.find(stage => stage.kind === 'picture')!
  const tints = stages.filter(stage => stage.kind === 'tint')
  const filters: string[] = []

  // The source is split once for the image field (which needs the frame BEFORE
  // the camera move, so the field and the picture are the same geometry), and
  // otherwise goes straight into the picture chain.
  const imageField = doc.field.mode === 'image'
  const prerendered = opts.prerenderedPicture === true
  if (imageField) filters.push(prerendered ? '[1:v]null[fieldsrc]' : '[0:v]split=2[raw][fieldsrc]')
  const rawLabel = imageField && !prerendered ? 'raw' : '0:v'

  // The picture chain, then ONE split of the *normalised* stream for the
  // micro-event re-grades. Splitting here rather than at the source is the fix
  // for a real failure: an xfade input must share the first input's size, pixel
  // format AND frame rate, and a copy taken before `zoompan` had the source's
  // own (e.g. 25 fps, 1024x576) — FFmpeg then refused the whole graph with
  // "Failed to configure output pad on Parsed_xfade".
  // A prerendered drift is already the camera's output at the canvas size; `fps` pins the time base
  // the colour fields and xfade expect (a decoded mp4's is not 1/fps).
  const pictureTokens = prerendered
    ? [`fps=${fps}`, 'setsar=1']
    : compileSceneMotion(revealDriftMotion(doc), { w, h, fps, duration: picture.segment })
  const gradeLabels = ['[base]', ...tints.map((_, index) => `[tintcopy${index + 1}]`)].join('')
  filters.push(
    `[${rawLabel}]${pictureTokens.join(',')},format=yuv420p,split=${1 + tints.length}${gradeLabels}`,
  )

  // One re-grade per micro-event: the same frames, nudged. The grade is
  // deliberately small — a settle, not a flash.
  for (const [index, tint] of tints.entries()) {
    const grade = index % 2 === 0
      ? 'eq=saturation=1.04:contrast=1.01:brightness=0.01'
      : 'eq=saturation=1.07:contrast=1.015:brightness=0.02'
    filters.push(
      `[tintcopy${index + 1}]${grade},trim=duration=${tint.segment},`
      + `setpts=PTS-STARTPTS[tint${index + 1}]`,
    )
  }

  // The opening state.
  if (imageField) {
    filters.push(...fieldImageFilters(doc, opts))
  } else {
    filters.push(
      `color=c=${ffmpegColour(doc.field.colour)}:s=${w}x${h}:r=${fps}:d=${stages[0]!.segment},`
      + `format=yuv420p,setsar=1[field]`,
    )
  }

  // Palette layers: flat colour fields, each only as long as its own step.
  stages.filter(stage => stage.kind === 'layer').forEach((stage, index) => {
    filters.push(
      `color=c=${ffmpegColour(stage.colour ?? doc.field.colour)}:s=${w}x${h}:r=${fps}:d=${stage.segment},`
      + `format=yuv420p,setsar=1[layer${index + 1}]`,
    )
  })

  // The chain.
  let accumulated = 'field'
  let layerIndex = 0
  let tintIndex = 0
  const chain = stages.filter(stage => stage.kind !== 'field')
  chain.forEach((stage, position) => {
    const last = position === chain.length - 1
    const out = last ? 'vout' : `acc${position + 1}`
    const right = stage.kind === 'picture'
      ? 'base'
      : stage.kind === 'layer'
        ? `layer${++layerIndex}`
        : `tint${++tintIndex}`
    filters.push(
      `[${accumulated}][${right}]xfade=transition=${keywordFor(stage)}`
      + `:duration=${stage.duration}:offset=${stage.offset}[${out}]`,
    )
    accumulated = out
  })
  if (accumulated !== 'vout') filters.push(`[${accumulated}]null[vout]`)

  return {
    filters,
    output: 'vout',
    duration: timing.total_seconds,
    singleFrameInput: true,
  }
}

/** Palette layers and micro-events both arrive through a named xfade keyword. */
function keywordFor(stage: RevealStage): string {
  if (stage.kind === 'tint') return stage.transition
  const def = getTransition(stage.transition)
  if (def && def.xfade) return def.xfade
  // An unknown id is a data problem, not a crash: the picture still arrives,
  // through the plainest transition there is.
  return 'fade'
}

/**
 * The field when it is built from the picture itself.
 *
 * Same geometry as the picture (same letterbox, same size, same fps), so a
 * `darken` or `duotone` field is the *same frame* with the light taken out —
 * that is what makes "lights up" read as the same picture arriving rather than
 * a cut between two similar ones. `tpad` clones that single frame for the
 * length of the first transition, since a still input is one frame.
 */
function fieldImageFilters(doc: SceneRevealDocument, opts: RevealCompileOpts): string[] {
  const { w, h, fps } = opts
  const prelude = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
  ]
  const treatment: string[] = []
  switch (doc.field.treatment) {
    case 'blur': {
      const sigma = Math.max(4, Math.round((doc.field.amount_pct / 100) * 32))
      treatment.push(`gblur=sigma=${sigma}`)
      break
    }
    case 'duotone': {
      // A tinted monochrome: greyscale, then a cast derived from the field
      // colour. `colorbalance` takes -1..1 per channel, so the hex becomes an
      // offset from neutral. The contract calls this "duotone" and says what it
      // renders; this is that implementation.
      const { r, g, b } = rgb(doc.field.colour)
      const strength = doc.field.amount_pct / 100
      const mid = (channel: number) => round3(((channel / 255) - 0.5) * 2 * strength)
      treatment.push('hue=s=0', 'eq=contrast=1.12:brightness=-0.04')
      treatment.push(`colorbalance=rm=${mid(r)}:gm=${mid(g)}:bm=${mid(b)}`)
      break
    }
    case 'darken': {
      const amount = (doc.field.amount_pct / 100) * 0.65
      treatment.push(`eq=brightness=-${round3(amount)}:saturation=0.92`)
      break
    }
    default:
      break
  }
  // Rounded like every other reveal duration: the graph is compared and receipted
  // as text, and a float that prints as `1.333333` is noise in both.
  const fieldSeconds = round3(opts.timing.reveal_seconds)
  return [
    `[fieldsrc]${[...prelude, ...treatment].join(',')},format=yuv420p,`
    + `tpad=stop_mode=clone:stop_duration=${fieldSeconds}[field]`,
  ]
}

function rgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '')
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  }
}
