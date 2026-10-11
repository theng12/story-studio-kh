/**
 * The scene-effect compiler — the ONLY thing that turns an effect document
 * into FFmpeg.
 *
 * Everything upstream of this file is data: a motion or an overlay is a set of
 * named fields with documented ranges (`contracts/scene-effects.ts`), and the
 * built-in library is a list of those documents (`contracts/scene-effect-presets.ts`).
 * Nothing here branches on an effect's NAME. If a look cannot be reached from
 * the fields, the fix is a new field, not a new case.
 *
 * That is the property that makes an effect shippable as a content pack later:
 * a pack may never carry executable content, so anything this compiler cannot
 * do from plain JSON can never ship as a pack.
 *
 * ── Byte-identity ───────────────────────────────────────────────────────────
 *
 * Thirty-one of the motions and four of the overlays reproduce v1.1.0's hardcoded
 * output EXACTLY. `__tests__/scene-effect-registry.test.ts` compares 1,163
 * filter strings captured from the v1.1.0 tree before any of this existed.
 * A number of the formatting rules below therefore look arbitrary — an integer
 * printed bare where a fraction is printed at four places, a fade-in duration
 * printed raw where a fade-out is printed at two. They are, and they are
 * preserved on purpose: every one of them changes bytes that finished episodes
 * were rendered with. Each is commented where it lives.
 */

import {
  SCENE_EFFECT_REFERENCE_HEIGHT,
  atmosphereLoopShape,
  floatOffset,
  shootingStarShape,
  type BedtimeDimmingOverlay,
  type ShootingStarOverlay,
  type AtmosphereLoopOverlay,
  type LivingRegionOverlay,
  type OverlayAnchor,
  type SceneMotionDocument,
  type SceneOverlayDocument,
} from '../contracts/scene-effects.js'
import { loopBakeSize, loopFrameCount, type LoopShape } from '../contracts/effect-loops.js'
import { buildColorGradingFilters } from './color-grade.js'
import { escapeFilterArgValue, escapeFilterPath } from './ffmpeg-utils.js'

// ═══════════════════════════════════════════════════════════════════════════
// Shared numeric formatting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A constant term inside an FFmpeg expression.
 *
 * Integers print bare, fractions at four places. v1.0 wrote the zoom-in ramp as
 * `1+0.1000*t/D` and the zoom-out ramp as `1.1000-0.1000*t/D`; this one rule
 * reproduces both without knowing which effect it is compiling.
 */
function term(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}

/** `+x` / `-x`, or nothing at all when the term contributes nothing. */
function signedTerm(value: number, render: (magnitude: number) => string): string {
  if (value === 0) return ''
  return `${value < 0 ? '-' : '+'}on*${render(Math.abs(value))}`
}

/** Scale a `_px` value authored at the 1080 reference onto this output frame. */
export function scaleReferencePx(px: number, outputHeight: number): number {
  return px * (outputHeight / SCENE_EFFECT_REFERENCE_HEIGHT)
}

// ═══════════════════════════════════════════════════════════════════════════
// Motion
// ═══════════════════════════════════════════════════════════════════════════

export interface MotionCompileOpts {
  w: number
  h: number
  fps: number
  /** Clip length in seconds. Paces every time-varying term. */
  duration: number
}

/**
 * Compile a motion document into a LINEAR filter chain.
 *
 * The result is an array of filter tokens the caller joins with `,`. It has
 * exactly one input and one output and contains no labels, so it drops into a
 * `-vf` value or into one leg of a larger `-filter_complex` unchanged. That
 * linearity is the structural difference from an overlay, which may need a
 * second branch and therefore returns labelled statements instead.
 */
export function compileSceneMotion(doc: SceneMotionDocument, opts: MotionCompileOpts): string[] {
  return doc.source === 'footage' ? compileFootageMotion(doc, opts) : compileStillMotion(doc, opts)
}

/**
 * The size the source is prepared at.
 *
 * Rounded to an EVEN number whenever the source is enlarged, because a chroma-
 * subsampled pipeline cannot carry an odd dimension. v1.0 rounded to the
 * nearest integer, so a rotation at 110% of a 270-high frame asked for 297 and
 * the encoder refused the whole clip — which is why `Rotate CW` and
 * `Rotate CCW` produced no preview at all in the picker. Every pinned v1.1.0
 * case happens to land even already, so fixing it changes nothing that shipped.
 *
 * At 100% the value is passed through untouched: it is the caller's output
 * frame, not something this function gets to choose.
 */
function preparedSize(value: number, scalePct: number): number {
  if (scalePct === 100) return value
  return Math.round(value * (scalePct / 100) / 2) * 2
}

/** `scale`+`pad` prelude for the still engine. */
function stillPrelude(w: number, h: number, scalePct: number): string[] {
  const sw = preparedSize(w, scalePct)
  const sh = preparedSize(h, scalePct)
  return [
    `scale=${sw}:${sh}:force_original_aspect_ratio=decrease`,
    `pad=${sw}:${sh}:(ow-iw)/2:(oh-ih)/2:color=black`,
  ]
}

function compileStillMotion(doc: SceneMotionDocument, opts: MotionCompileOpts): string[] {
  const { w, h, fps, duration } = opts
  const scalePct = doc.framing.source_scale_pct
  const prelude = stillPrelude(w, h, scalePct)

  // 1. Rotation. Its own shape: the source is oversized purely so the rotated
  //    corners never enter the frame, and there is no virtual camera.
  if (doc.spin.rate_rad_per_sec !== 0) {
    return [
      ...prelude,
      `rotate='${doc.spin.rate_rad_per_sec}*t':ow=${w}:oh=${h}:c=black@0`,
      `crop=${w}:${h}`,
      'setsar=1',
    ]
  }

  // 2. A virtual camera, driven by `zoompan`. zoompan generates the WHOLE clip
  //    from one input frame, which is why it can only serve stills.
  if (doc.zoom.mode !== 'none' || doc.pan.mode !== 'none') {
    const frames = Math.max(1, Math.round(fps * duration))
    const sw = preparedSize(w, scalePct)
    const sh = preparedSize(h, scalePct)
    const ss = scalePct / 100

    let zoomTerm: string
    switch (doc.zoom.mode) {
      case 'fixed':
        // Unquoted, because a bare constant needs no expression parsing —
        // and because that is what v1.0 emitted.
        zoomTerm = String(doc.zoom.fixed_pct / 100)
        break
      case 'ramp': {
        const from = doc.zoom.from_pct / 100
        const to = doc.zoom.to_pct / 100
        // Ten places: zoompan advances the zoom once per frame, so the
        // per-frame increment on a long clip is small enough that four would
        // visibly quantise the move.
        zoomTerm = `'${from}+on*${((to - from) / frames).toFixed(10)}'`
        break
      }
      case 'sine':
        zoomTerm = `'${doc.zoom.base_pct / 100}+${doc.zoom.amplitude_pct / 100}*sin(on*2*PI/${frames})'`
        break
      default:
        zoomTerm = '1'
    }

    // A per-second rate is DERIVED (it depends on fps and on the supersample),
    // so it is printed at six places. A per-frame rate was AUTHORED, so it is
    // printed exactly as authored. See MOTION_RATE_UNITS.
    const renderRate = doc.pan.rate_unit === 'source-px-per-frame'
      ? (magnitude: number) => String(magnitude)
      : (magnitude: number) => ((magnitude * ss) / fps).toFixed(6)
    const panX = doc.pan.mode === 'rate' ? doc.pan.x : 0
    const panY = doc.pan.mode === 'rate' ? doc.pan.y : 0
    // E1 — handheld float, in source pixels of the prepared canvas (`iw`), clock = on/fps.
    const drift = doc.float ? floatExpressions(doc.float, fps) : { x: '', y: '' }
    // E3 — aimed at the subject. A guided tour cannot be one zoompan expression, so FFmpeg aims at
    // its first point (the subject) — the caller says so in the log.
    const aim = doc.aim?.target ? aimExpressions(doc, doc.aim.target) : { x: '', y: '' }

    return [
      ...prelude,
      `zoompan=z=${zoomTerm}`
        + `:x='floor(iw/2-(iw/zoom/2)${signedTerm(panX, renderRate)}${drift.x}${aim.x})'`
        + `:y='floor(ih/2-(ih/zoom/2)${signedTerm(panY, renderRate)}${drift.y}${aim.y})'`
        + `:d=${frames}:s=${sw}x${sh}:fps=${fps}`,
      `scale=${w}:${h}:flags=lanczos`,
      'setsar=1',
    ]
  }

  // 3. No camera at all: fit, pad, then whatever post-processing is declared.
  return [...prelude, 'setsar=1', ...focusTokens(doc, duration), ...fadeTokens(doc, duration)]
}

/** `aimProgress()` and the target as zoompan terms (`+iw*dx*progress`), clipped inside the picture by zoompan. */
function aimExpressions(doc: SceneMotionDocument, target: [number, number]): { x: string; y: string } {
  let progress = '1'
  if (doc.zoom.mode === 'ramp') {
    const peak = Math.max(doc.zoom.from_pct, doc.zoom.to_pct) / 100
    progress = peak > 1.0001 ? `min(1,max(0,(zoom-1)/${(peak - 1).toFixed(6)}))` : '0'
  }
  return {
    x: `+iw*${(target[0] - 0.5).toFixed(5)}*${progress}`,
    y: `+ih*${(target[1] - 0.5).toFixed(5)}*${progress}`,
  }
}

/**
 * `floatOffset()` as zoompan terms: `+iw*(…)` for x, `+ih*(…)` for y. The phases are computed here
 * (they depend only on the seed), so FFmpeg evaluates three sines per axis per frame.
 */
function floatExpressions(float: NonNullable<SceneMotionDocument['float']>, fps: number): { x: string; y: string } {
  const a = float.amplitude_pct / 100
  const p = float.period_sec
  const ph = (i: number) => (Math.sin((float.seed + 1) * 12.9898 + i * 78.233) * 43758.5453) % (Math.PI * 2)
  const wave = (o: number) => [[0.5, 1], [0.3, 1.618], [0.2, 2.414]]
    .map(([w, m], i) => `${w}*sin(2*PI*on/${fps}/${(m! * p).toFixed(4)}+${ph(o + i).toFixed(6)})`).join('+')
  return { x: `+iw*${a.toFixed(5)}*(${wave(0)})`, y: `+ih*${a.toFixed(5)}*(${wave(3)})` }
}

/**
 * The blur ramp. `gblur` cannot animate its own sigma, so the ramp is built
 * from time-gated applications at decreasing strength — which is exactly why
 * the document holds a list of stages rather than a start and an end.
 */
function focusTokens(doc: SceneMotionDocument, duration: number): string[] {
  const out: string[] = []
  let previous = 0
  for (const stage of doc.focus.stages) {
    const until = (duration * stage.until_share).toFixed(2)
    const gate = previous === 0
      ? `lt(t,${until})`
      : `between(t,${(duration * previous).toFixed(2)},${until})`
    out.push(`gblur=sigma=${stage.sigma}:enable='${gate}'`)
    previous = stage.until_share
  }
  return out
}

function fadeTokens(doc: SceneMotionDocument, duration: number): string[] {
  const out: string[] = []
  const length = Math.min(doc.fade.max_sec, duration * doc.fade.share_of_clip)
  // The two directions print differently. v1.0 wrote the fade-in duration raw
  // and the fade-out start and duration at two places; both are pinned.
  if (doc.fade.in) out.push(`fade=t=in:st=0:d=${length}`)
  if (doc.fade.out) {
    out.push(`fade=t=out:st=${Math.max(0, duration - length).toFixed(2)}:d=${length.toFixed(2)}`)
  }
  return out
}

/**
 * The footage engine.
 *
 * `zoompan` is unusable here — it turns whatever it is given into a clip
 * generated from a single frame, which would freeze real footage on its first
 * picture. The camera is a time-varying `scale`/`crop` window instead, and the
 * output frame size is held CONSTANT throughout: libx264 cannot ingest a
 * variable frame size mid-stream, and an earlier max()-clamped crop that did
 * vary produced "Could not open encoder before EOF".
 */
function compileFootageMotion(doc: SceneMotionDocument, opts: MotionCompileOpts): string[] {
  const { w, h } = opts
  const dStr = Math.max(0.1, opts.duration).toFixed(3)
  const scalePct = doc.framing.source_scale_pct

  if (doc.zoom.mode === 'ramp') {
    const from = doc.zoom.from_pct / 100
    const to = doc.zoom.to_pct / 100
    const magnitude = Math.abs(to - from)
    // `eval=frame` recomputes the scale on every frame; the default `eval=init`
    // would freeze it at the first. `lanczos` is sharper than the default
    // bicubic at the small factors these moves use.
    return [
      `scale=w='${w}*(${term(from)}${to >= from ? '+' : '-'}${magnitude.toFixed(4)}*t/${dStr})':h=-2:eval=frame:flags=lanczos`,
      `crop=${w}:${h}:(in_w-${w})/2:(in_h-${h})/2`,
      'setsar=1',
    ]
  }

  if (doc.pan.mode === 'traverse' && (doc.pan.x !== 0 || doc.pan.y !== 0)) {
    // Enlarge only the axes actually traversed; the untraversed axis stays at
    // the output size so nothing is thrown away.
    const sw = doc.pan.x !== 0 ? preparedSize(w, scalePct) : w
    const sh = doc.pan.y !== 0 ? preparedSize(h, scalePct) : h
    const slackX = sw - w
    const slackY = sh - h
    return [
      `scale=${sw}:${sh}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${w}:${h}:x='${traverseExpr(doc.pan.x, slackX, dStr, `(in_w-${w})/2`)}'`
        + `:y='${traverseExpr(doc.pan.y, slackY, dStr, `(in_h-${h})/2`)}'`,
      'setsar=1',
    ]
  }

  // No camera: cover the frame and stop. Note this leg emits no `setsar` — the
  // caller's own chain supplies one, and v1.0's output is pinned without it.
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
  ]
}

/**
 * Where the crop window sits over the slack.
 *
 * A negative share starts at the far side and travels back to zero; a positive
 * share starts at zero and travels out. A zero share holds the window centred,
 * and the leading `0+` of the positive case is omitted — both preserved from
 * v1.0's emitted strings.
 */
function traverseExpr(share: number, slack: number, dStr: string, centered: string): string {
  if (share === 0 || slack <= 0) return centered
  const travel = Math.round(slack * Math.abs(share))
  return share < 0 ? `${travel}-${travel}*t/${dStr}` : `${travel}*t/${dStr}`
}

// ═══════════════════════════════════════════════════════════════════════════
// Overlay
// ═══════════════════════════════════════════════════════════════════════════

export interface OverlayCompileOpts {
  /** The label carrying the picture to draw on, e.g. `[v3]`. */
  input: string
  /** The label the finished composite must be written to. */
  output: string
  /** Allocates a fresh intermediate label. Only branching overlays use it. */
  allocLabel: () => string
  w: number
  h: number
  /** Length of the stream being overlaid, seconds. Bounds an open-ended window. */
  duration: number
  /**
   * An extra enable EXPRESSION (no `:enable=` wrapper) the caller wants ANDed
   * with the overlay's own window — the intro/outro gate, in practice.
   */
  gateExpression?: string
  /** Output frame rate. Atmosphere loops and shimmer generate frames at it. Default 24. */
  fps?: number
  /**
   * The input label (e.g. `[5:v]`) carrying the baked loop for one shape, or
   * null when it was not baked. The caller bakes every shape
   * `overlayLoopShapes()` names and opens each as a looping input before
   * compiling — the compiler itself never touches the filesystem.
   */
  loopInput?: (shape: LoopShape) => string | null
  /**
   * E1 — where the story runs, seconds (after the intro, until the post-audio tail). Bedtime
   * dimming ramps across it. Absent = the whole stream.
   */
  timeline?: { start: number; end: number }
}

/**
 * The baked loops an overlay needs, one per colour. Empty for every kind that
 * is a plain filter.
 */
export function overlayLoopShapes(doc: SceneOverlayDocument): LoopShape[] {
  if (doc.kind === 'shooting-star') return [shootingStarShape(doc)]
  if (doc.kind !== 'atmosphere-loop') return []
  if (doc.secondary_color_hex && doc.secondary_color_hex !== doc.color_hex) {
    return [atmosphereLoopShape(doc, 1), atmosphereLoopShape(doc, 2)]
  }
  return [atmosphereLoopShape(doc, 0)]
}

/** True when the overlay fades in or out of its window. */
function hasFades(doc: SceneOverlayDocument): boolean {
  return (doc.timing.fade_in_sec || 0) > 0 || (doc.timing.fade_out_sec || 0) > 0
}

/** Kinds that fade natively — through their own alpha or their own expression. */
const NATIVE_FADE_KINDS = new Set<SceneOverlayDocument['kind']>(['atmosphere-loop', 'flicker', 'lightning', 'lower-third', 'shooting-star', 'bedtime-dimming'])

/**
 * Compile one overlay into filtergraph STATEMENTS.
 *
 * Returns `null` when the overlay draws nothing at all — an unset logo path, a
 * bar height that rounds to zero. That is not an error; it is an overlay with
 * nothing to say, and the caller simply keeps its current label.
 */
export function compileSceneOverlay(doc: SceneOverlayDocument, opts: OverlayCompileOpts): string[] | null {
  // A fade on a plain filter: run the filter on a copy, fade the copy's alpha
  // in and out across the window, and lay it back over the untouched picture.
  // Only when a fade is asked for — every pre-fade effect compiles exactly as
  // it always has.
  if (hasFades(doc) && !NATIVE_FADE_KINDS.has(doc.kind)) return compileWithFadeWrapper(doc, opts)
  const { input, output, w, h } = opts
  const enable = overlayEnableSuffix(doc, opts)

  switch (doc.kind) {
    case 'vignette':
      return [`${input}vignette=angle=${vignetteAngle(doc.intensity).toFixed(4)}:mode=forward:eval=init${enable}${output}`]

    case 'film-grain': {
      const flags = [doc.temporal ? 't' : '', doc.uniform ? 'u' : ''].filter(Boolean).join('+')
      const amount = Math.round(doc.amount)
      return [`${input}noise=alls=${amount}${flags ? `:allf=${flags}` : ''}${enable}${output}`]
    }

    case 'letterbox': {
      const bar = doc.ratio === 'custom'
        ? evenDown(h * doc.bar_share)
        : letterboxBarHeight(w, h, doc.ratio)
      if (bar <= 0) return null
      if (doc.mode === 'cover') return [`${input}${letterboxBars(bar, doc.color, enable)}${output}`]
      return letterboxFit(input, output, w, h, bar, doc.color, enable, opts.allocLabel)
    }

    case 'gradient-scrim': {
      const bands = scrimBands(doc, w, h, enable)
      return bands.length ? [`${input}${bands.join(',')}${output}`] : null
    }

    case 'light-leak': {
      // The only construction FFmpeg offers for a soft moving glow: copy the
      // frame, paint the copy flat in the leak colour, let `vignette` carve a
      // radial falloff into it, and mix the result back in. `blend` supports
      // the timeline, so the window lives on the mix rather than on the paint —
      // gating the paint instead would screen the untouched frame with itself
      // and brighten everything.
      const branch = opts.allocLabel()
      const copy = opts.allocLabel()
      const leak = opts.allocLabel()
      const from = anchorFraction(doc.from_anchor)
      const to = anchorFraction(doc.to_anchor)
      const drift = leakDriftExpr(doc, opts)
      const angle = LEAK_ANGLE_MAX - doc.softness * (LEAK_ANGLE_MAX - LEAK_ANGLE_MIN)
      const x0 = leakAxisExpr(from.x * w, to.x * w, drift)
      const y0 = leakAxisExpr(from.y * h, to.y * h, drift)
      const evalMode = drift ? 'frame' : 'init'
      // `format=gbrp` before the split, `format=yuv420p` after the blend, and
      // both are load-bearing. Screen is an RGB operator: left in YUV, `blend`
      // screens the CHROMA planes against a neutral of 128 and the picture goes
      // magenta — measured, not assumed. Converting on each branch separately
      // is not enough either; only converting BEFORE the split makes the
      // disabled state round-trip back to the original frame. The cost is one
      // extra colour conversion for the whole clip whenever a leak is enabled,
      // which is the honest price of a correct screen blend.
      return [
        `${input}format=gbrp,split=2${branch}${copy}`,
        `${copy}drawbox=x=0:y=0:w=iw:h=ih:color=${ffColor(doc.color_hex)}:t=fill,`
          + `vignette=a=${angle.toFixed(4)}:x0=${escapeFilterArgValue(x0)}:y0=${escapeFilterArgValue(y0)}:eval=${evalMode}${leak}`,
        `${branch}${leak}blend=all_mode=${doc.blend}:all_opacity=${doc.intensity.toFixed(3)}${enable}`
          + `,format=yuv420p${output}`,
      ]
    }

    case 'corner-logo': {
      if (!doc.image_path.trim()) return null
      const logoW = evenDown(w * doc.width_pct)
      if (logoW <= 0) return null
      const label = opts.allocLabel()
      const margin = Math.round(scaleReferencePx(doc.margin_px, h))
      const pos = anchorOverlayPosition(doc.anchor, margin)
      return [
        `movie=filename=${escapeFilterPath(doc.image_path)},scale=${logoW}:-1,`
          + `format=rgba,colorchannelmixer=aa=${doc.opacity.toFixed(3)}${label}`,
        `${input}${label}overlay=${pos.x}:${pos.y}${enable}${output}`,
      ]
    }

    case 'lower-third': {
      const parts = lowerThirdDrawtext(doc, opts)
      if (!parts.length) return null
      return [`${input}${parts.join(',')}${output}`]
    }

    case 'atmosphere-loop':
      return compileAtmosphereLoop(doc, opts)

    case 'bloom': {
      if (doc.color_hex) return compileTintedBloom(doc as Extract<SceneOverlayDocument, { kind: 'bloom' }> & { color_hex: string }, opts)
      // Luma-only screen blend of the blurred highlights. Screen is an RGB idea,
      // and in YUV it would tint the chroma planes (see light-leak); applied to
      // the luma plane only, with the chroma opacities at zero, the glow stays
      // neutral and needs no colour conversion.
      if (doc.strength <= 0) return null
      const a = opts.allocLabel(), b = opts.allocLabel(), glow = opts.allocLabel()
      const t = Math.round(doc.threshold * 254)
      const sigma = Math.max(0.5, scaleReferencePx(doc.radius_px, h) / 2)
      return [
        `${input}split=2${a}${b}`,
        `${b}lutyuv=y=${escapeFilterArgValue(`if(gt(val,${t}),(val-${t})*255/${255 - t},0)`)}${enable},`
          + `gblur=sigma=${sigma.toFixed(2)}:planes=1${enable}${glow}`,
        `${a}${glow}blend=c0_mode=screen:c0_opacity=${doc.strength.toFixed(3)}:c1_opacity=0:c2_opacity=0${enable}${output}`,
      ]
    }

    case 'flicker': {
      if (doc.amount <= 0) return null
      const f = (1.7 * doc.speed).toFixed(4)
      const wave = `(0.5*sin(2*PI*${f}*t)+0.3*sin(2*PI*${f}*2.31*t+1.3)+0.2*sin(2*PI*${f}*5.17*t+2.1))`
      const env = envelopeExpression(doc, opts)
      const expr = `${doc.amount.toFixed(4)}*${wave}${env ? `*${env}` : ''}`
      return [`${input}eq=brightness=${escapeFilterArgValue(expr)}:eval=frame${enable}${output}`]
    }

    case 'lightning': {
      if (doc.strength <= 0 || doc.chance <= 0) return null
      const env = envelopeExpression(doc, opts)
      const expr = `${(doc.strength * 0.6).toFixed(4)}*${lightningExpression(doc.period_sec, doc.chance, doc.seed)}${env ? `*${env}` : ''}`
      return [`${input}eq=brightness=${escapeFilterArgValue(expr)}:eval=frame${enable}${output}`]
    }

    case 'heat-shimmer':
      return compileHeatShimmer(doc, opts)

    case 'color-grade': {
      const statements = buildColorGradingFilters(
        { enabled: true, ...doc } as any,
        enable,
        { input, output, allocLabel: opts.allocLabel },
      )
      return statements.length ? statements : null
    }

    // Drawn on its scene's clip by `lib/scene-stage.ts` (it needs the still's
    // outline), never on the composed timeline.
    case 'living-region':
      return null

    case 'shooting-star':
      return compileShootingStar(doc, opts)

    case 'bedtime-dimming':
      return compileBedtimeDimming(doc, opts)
  }
}

// ── E1 (1.4.287) ────────────────────────────────────────────────────────────

/**
 * Halation: the blurred highlights become the alpha of a flat colour layer laid over the picture.
 * A tinted glow needs colour, so it cannot ride the luma plane the way the plain bloom does.
 */
function compileTintedBloom(doc: Extract<SceneOverlayDocument, { kind: 'bloom' }> & { color_hex: string }, opts: OverlayCompileOpts): string[] | null {
  if (doc.strength <= 0) return null
  const enable = overlayEnableSuffix(doc, opts)
  const a = opts.allocLabel(), b = opts.allocLabel(), glow = opts.allocLabel(), tint = opts.allocLabel(), layer = opts.allocLabel()
  const t = Math.round(doc.threshold * 254)
  const sigma = Math.max(0.5, scaleReferencePx(doc.radius_px, opts.h) / 2)
  return [
    `${opts.input}split=2${a}${b}`,
    `${b}lutyuv=y=${escapeFilterArgValue(`if(gt(val,${t}),(val-${t})*255/${255 - t},0)`)},gblur=sigma=${sigma.toFixed(2)}:planes=1,`
      + `extractplanes=y,lut=c0=${escapeFilterArgValue(`min(255,val*${(doc.strength * 2).toFixed(4)})`)}${glow}`,
    `color=c=${ffColor(doc.color_hex)}:s=${opts.w}x${opts.h}:r=${opts.fps || 24}${tint}`,
    `${tint}${glow}alphamerge${layer}`,
    `${a}${layer}overlay=0:0:shortest=1${enable}${opts.output}`,
  ]
}

/**
 * `shootingStarAt()` from `contracts/effect-loops.ts` as FFmpeg expressions: the baked streak
 * sprite loops every life (L s) and is switched on only for the life of a star, which always starts
 * on a multiple of L, so the sprite is at its first frame when it appears. x and y place its box at
 * the slot's hashed spot in the sky band.
 */
export function shootingStarExpressions(doc: ShootingStarOverlay, w: number, h: number, fps: number): { enable: string; x: string; y: string; life: number } {
  const shape = shootingStarShape(doc)
  const box = loopBakeSize(shape, w, h)
  const life = loopFrameCount(shape, fps) / fps
  const p = doc.period_sec.toFixed(4)
  const s = (doc.seed * 78.233).toFixed(4)
  const hash = (offset: string, v: number) => `st(${v},sin((ld(0)${offset})*12.9898+${s})*43758.5453);st(${v},ld(${v})-floor(ld(${v})))`
  const L = life.toFixed(6)
  const enable = `(st(0,floor(t/${p}));${hash('', 1)};${hash('+0.25', 2)};`
    + `st(3,${L}*floor((ld(0)*${p}+${p}*(0.1+0.75*ld(2)))/${L}));`
    + `lt(ld(1),${doc.chance.toFixed(4)})*gte(t,ld(3))*lt(t,ld(3)+${L}))`
  const top = doc.region_top * h
  const room = Math.max(0, (doc.region_bottom - doc.region_top) * h - box.h)
  const x = `(st(0,floor(t/${p}));${hash('+0.5', 1)};ld(1)*${Math.max(0, w - box.w)})`
  const y = `(st(0,floor(t/${p}));${hash('+0.75', 1)};${top.toFixed(2)}+ld(1)*${room.toFixed(2)})`
  return { enable, x, y, life }
}

function compileShootingStar(doc: ShootingStarOverlay, opts: OverlayCompileOpts): string[] | null {
  if (doc.opacity <= 0 || doc.chance <= 0) return null
  const sprite = opts.loopInput?.(shootingStarShape(doc)) ?? null
  if (!sprite) return null
  const fps = opts.fps || 24
  const { enable, x, y } = shootingStarExpressions(doc, opts.w, opts.h, fps)
  const box = loopBakeSize(shootingStarShape(doc), opts.w, opts.h)
  const window = overlayEnableExpression(doc, opts)
  const mask = opts.allocLabel(), tint = opts.allocLabel(), layer = opts.allocLabel()
  const gain = doc.opacity < 0.999 ? `,lut=c0=${escapeFilterArgValue(`val*${doc.opacity.toFixed(4)}`)}` : ''
  return [
    `${sprite}format=gray,setsar=1${gain}${mask}`,
    `color=c=${ffColor(doc.color_hex)}:s=${box.w}x${box.h}:r=${fps}${tint}`,
    `${tint}${mask}alphamerge${layer}`,
    `${opts.input}${layer}overlay=x=${escapeFilterArgValue(x)}:y=${escapeFilterArgValue(y)}:eval=frame:shortest=1`
      + `:enable=${escapeFilterArgValue(window ? `${enable}*${window}` : enable)}${opts.output}`,
  ]
}

/**
 * Bedtime dimming. K(t) eases 0→1 (smoothstep) from `start_pct` to `full_pct` of the story
 * timeline (`opts.timeline`, else the whole stream) and holds at 1 after it. At K = 1:
 *   - darker by `darken_pct`: contrast 1−d with brightness −0.437·d scales the picture's luma above
 *     video black (16) by exactly (1−d) — eq pivots on code 127.5, so the brightness term moves
 *     that pivot down to 16;
 *   - warmer: gamma_r up and gamma_b down (eq applies them to the chroma planes; 40% ≈ 6500 K → 4500 K);
 *   - less colour: saturation 1−c.
 * Every term is an expression of `t`, so a segmented resume renders the same frames.
 */
function compileBedtimeDimming(doc: BedtimeDimmingOverlay, opts: OverlayCompileOpts): string[] | null {
  const d = doc.darken_pct / 100, c = doc.desaturate_pct / 100, w = (doc.warmth_pct / 100) * DIMMING_WARMTH_GAMMA
  if (d <= 0 && c <= 0 && w <= 0) return null
  const span = opts.timeline ?? { start: 0, end: opts.duration }
  const length = Math.max(0.001, span.end - span.start)
  const from = span.start + length * doc.start_pct / 100
  const to = span.start + length * doc.full_pct / 100
  const K = `(st(0,clip((t-${from.toFixed(3)})/${Math.max(0.001, to - from).toFixed(3)},0,1));ld(0)*ld(0)*(3-2*ld(0)))`
  const terms = [
    ...(d > 0 ? [`contrast=${escapeFilterArgValue(`1-${d.toFixed(4)}*${K}`)}`, `brightness=${escapeFilterArgValue(`-${(d * DIMMING_BRIGHTNESS_PER_DARKEN).toFixed(4)}*${K}`)}`] : []),
    ...(c > 0 ? [`saturation=${escapeFilterArgValue(`1-${c.toFixed(4)}*${K}`)}`] : []),
    ...(w > 0 ? [`gamma_r=${escapeFilterArgValue(`1+${w.toFixed(4)}*${K}`)}`, `gamma_b=${escapeFilterArgValue(`1-${w.toFixed(4)}*${K}`)}`] : []),
  ]
  return [`${opts.input}eq=${terms.join(':')}:eval=frame${overlayEnableSuffix(doc, opts)}${opts.output}`]
}

/** (127.5 − 16) / 255: eq's brightness that, with contrast 1−d, scales tv-range luma about black. */
export const DIMMING_BRIGHTNESS_PER_DARKEN = 111.5 / 255

/** eq gamma per unit of warmth: gamma_r 1.3 / gamma_b 0.7 measured as roughly a 6500 K → 4500 K shift on grey. */
export const DIMMING_WARMTH_GAMMA = 0.75

// ── Living pictures (1.4.284) ───────────────────────────────────────────────

/**
 * The moving part of a living picture, from the 2026-10-11 mock-ups
 * (`_orchestra/living-mock/mk2.sh`). Displacement maps are written in the
 * mock's pixel units on a 540-line map and scaled up, so the ripple looks the
 * same at any output size; `x`/`y` are the swing either side of 128 (no swing =
 * no displace), `bright`/`sat` are `eq` expressions of `t`.
 */
function livingTerms(doc: LivingRegionOverlay): { x: string[]; y: string[]; bright: string; sat: string } {
  const v = doc.speed, s = doc.strength
  const T = (rate: number) => `T*${(rate * v).toFixed(4)}`
  const t = (rate: number) => `t*${(rate * v).toFixed(4)}`
  const wave = (amp: number, phase: string) => `${(amp * s).toFixed(3)}*sin(2*PI*(${phase}))`
  const flicker = `(0.09*sin(2*PI*${t(3.1)})+0.05*sin(2*PI*${t(7.7)}+1)+0.04*sin(2*PI*${t(13.3)}+2))`
  // The fire pit's slower flicker (mk2.sh `FF`).
  const fireFlicker = `(0.08*sin(2*PI*${t(2.3)})+0.06*sin(2*PI*${t(5.9)}+1)+0.04*sin(2*PI*${t(11.1)}+2))`
  switch (doc.motion) {
    case 'fire':
      // mk2.sh's fire section: a coarser ripple (Y/16, Y/29) with an X/13 cross term, so a fire pit
      // never gets the candle's fine zig-zag shimmer on the wall inside its outline.
      return {
        x: [wave(5, `Y/16-${T(2.8)}`), wave(3, `Y/29+${T(1.7)}`)],
        y: [wave(7, `X/13+${T(2.2)}`), wave(5, `Y/20-${T(3.6)}`)],
        bright: `${(1.2 * s).toFixed(3)}*${fireFlicker}`, sat: '',
      }
    case 'fire-glow':
      return { x: [], y: [], bright: `${(0.5 * s).toFixed(3)}*${fireFlicker}`, sat: '' }
    case 'flame':
      return {
        x: [wave(3, `Y/12-${T(3.2)}`), wave(2, `Y/21+${T(2.1)}`)],
        y: [wave(4, `X/9+${T(2.6)}`), wave(3, T(5.3))],
        bright: `${s.toFixed(3)}*${flicker}`, sat: '',
      }
    case 'glow':
      return { x: [], y: [], bright: `${(0.45 * s).toFixed(3)}*${flicker}`, sat: '' }
    case 'steam':
      return { x: [wave(7, `Y/48+${T(0.35)}`)], y: [wave(9, `Y/40+${T(0.5)}`)], bright: '', sat: '' }
    case 'water':
      return {
        x: [wave(3, `Y/6-${T(0.9)}`), wave(2, `Y/11+X/90-${T(0.6)}`)],
        y: [wave(1.5, `X/25-${T(0.5)}`)],
        bright: `${(0.025 * s).toFixed(4)}*sin(2*PI*${t(0.7)})`, sat: '',
      }
    case 'sky':
      return {
        x: [wave(4, `X/90+${T(0.25)}`)], y: [wave(3, `X/60-${T(0.2)}`)],
        bright: `${(0.03 * s).toFixed(4)}*sin(2*PI*${t(0.3)})`,
        sat: `1+${(0.15 * s).toFixed(4)}*sin(2*PI*${t(0.21)})`,
      }
    case 'pulse':
      return { x: [], y: [], bright: `${(0.05 * s).toFixed(4)}*sin(2*PI*${t(0.25)})`, sat: '' }
  }
}

export interface LivingCompileOpts {
  input: string
  output: string
  allocLabel: () => string
  w: number
  h: number
  fps: number
  duration: number
}

/**
 * The whole frame, moved the living-picture way, in planar RGB (so the three
 * planes move together, as `heat-shimmer` does). The caller keeps it only
 * inside the outline with {@link regionMergeStatements}.
 */
export function compileLivingRegion(doc: LivingRegionOverlay, opts: LivingCompileOpts): string[] {
  const { x, y, bright, sat } = livingTerms(doc)
  const out: string[] = []
  let label = opts.allocLabel()
  out.push(`${opts.input}format=gbrp${label}`)
  if ((x.length || y.length) && doc.strength > 0) {
    // ponytail: maps evaluated at 540 lines then scaled (the mock's own size); full-size geq is 4x the cost for no visible gain.
    const mapW = Math.max(2, Math.round((540 * opts.w) / opts.h / 2) * 2)
    const k = opts.h / 540
    const map = (terms: string[]) => `nullsrc=s=${mapW}x540:r=${opts.fps}:d=${(opts.duration + 1).toFixed(3)},format=gray,`
      + `geq=lum=${escapeFilterArgValue(`128+${k.toFixed(4)}*(${terms.length ? terms.join('+') : '0'})`)},`
      + `scale=${opts.w}:${opts.h}:flags=bicubic,format=gbrp`
    const xm = opts.allocLabel(), ym = opts.allocLabel(), moved = opts.allocLabel()
    out.push(`${map(x)}${xm}`, `${map(y)}${ym}`, `${label}${xm}${ym}displace=edge=smear${moved}`)
    label = moved
  }
  if ((bright || sat) && doc.strength > 0) {
    const lit = opts.allocLabel()
    out.push(`${label}format=yuv444p,eq=${bright ? `brightness=${escapeFilterArgValue(bright)}:` : ''}`
      + `${sat ? `saturation=${escapeFilterArgValue(sat)}:` : ''}eval=frame,format=gbrp${lit}`)
    label = lit
  }
  out.push(`${label}null${opts.output}`)
  return out
}

/**
 * Keep `effect` only inside the outline. `base` and `effect` are yuv420p and
 * `mask` is a moving outline clip (white = inside). The merge runs on the
 * picture's own planes, with the outline at full size for luma and half size
 * for chroma, so a pixel outside the outline is the base pixel BIT FOR BIT — no
 * colour conversion round trip. The near-black and near-white ends of the
 * outline are snapped so encoding noise in the outline clip never leaks.
 */
export function regionMergeStatements(base: string, effect: string, mask: string, output: string, allocLabel: () => string): string[] {
  const grey = allocLabel()
  const snap = escapeFilterArgValue('if(lt(val,8),0,if(gt(val,247),255,val))')
  return [
    // gbrp first: that conversion expands the clip's TV range, so white is 255.
    `${mask}format=gbrp,extractplanes=g,lut=c0=${snap}${grey}`,
    ...greyMaskMergeStatements(base, effect, grey, output, allocLabel),
  ]
}

/** `effect` where the full-range grey `mask` is white, `base` where it is black, on yuv420p planes. */
function greyMaskMergeStatements(base: string, effect: string, grey: string, output: string, allocLabel: () => string): string[] {
  const full = allocLabel(), toHalf = allocLabel(), halfU = allocLabel(), halfV = allocLabel(), planes = allocLabel()
  return [
    `${grey}split=2${full}${toHalf}`,
    `${toHalf}scale=w=ceil(iw/2):h=ceil(ih/2):flags=area,split=2${halfU}${halfV}`,
    `${full}${halfU}${halfV}mergeplanes=map0s=0:map0p=0:map1s=1:map1p=0:map2s=2:map2p=0:format=yuv420p${planes}`,
    `${base}${effect}${planes}maskedmerge${output}`,
  ]
}

// ── Depth moves (E2, 1.4.288) ───────────────────────────────────────────────

/**
 * A scene's depth move, with every number already read from its analysis. Depth is 0..1 with
 * 1 = nearest (Depth Anything's convention).
 */
export interface DepthStageSpec {
  /** 3D photo: shift each pixel by `(d − focus)`, scaled so the nearest moves `pct` of the width. */
  parallax?: { pct: number; direction: 'in' | 'left' | 'right' | 'up'; focus: number; near: number; far: number }
  /** Rack focus: sharp where `|d − f(t)|` is small; `f` eases from `from` to `to` between 15% and 75% of the clip. */
  rack?: { from: number; to: number; sigma_px: number; range: number }
}

export interface DepthCompileOpts {
  input: string
  /** The depth map carried through the camera move (a yuv420p clip of a grey picture, white = near). */
  depth: string
  output: string
  allocLabel: () => string
  w: number
  h: number
  fps: number
  duration: number
}

/** 0..1 smoothstep of `t` between two seconds, as an FFmpeg expression. */
function easeExpression(from: number, to: number): string {
  const s = `clip((t-${from.toFixed(3)})/${Math.max(0.001, to - from).toFixed(3)},0,1)`
  return `(${s}*${s}*(3-2*${s}))`
}

/**
 * The depth moves drawn on a scene clip, outside the camera. A rack focus blends the clip with a
 * blurred copy by how far each pixel's depth is from the moving focus (`eq` + a static `lut`, so no
 * per-pixel expression runs per frame). A 3D photo displaces each pixel by its depth: the shift
 * map is the depth through an `eq` of `t` (and, for "in", times a fixed left-right/up-down ramp by
 * a static `lut2`), then the outer margin the shift can expose is cropped and scaled back.
 * ponytail: the shift is sampled at the output pixel, not solved for its source, and gaps are
 * stretched rather than filled; the depth map is widened round near things first so their edges
 * pull the background instead of tearing. Layered fill only if moves over 1.5% are wanted.
 */
export function compileDepthStage(spec: DepthStageSpec, opts: DepthCompileOpts): string[] {
  const { w, h, fps, duration } = opts
  const a = opts.allocLabel
  const out: string[] = []
  const uses = (spec.rack ? 1 : 0) + (spec.parallax ? 1 : 0)
  const greys = Array.from({ length: uses }, () => a())
  out.push(`${opts.depth}format=gbrp,extractplanes=g${uses > 1 ? `,split=${uses}${greys.join('')}` : greys[0]}`)
  let next = 0
  let label = opts.input
  if (spec.rack) {
    const r = spec.rack
    const f = `(${r.from.toFixed(4)}+${(r.to - r.from).toFixed(4)}*${easeExpression(duration * 0.15, duration * 0.75)})`
    // eq: 256*(v + b) with b = 0.5 − f  →  128 + 256·(d − f); then |·| scaled so half the depth range is fully soft.
    const gain = (2 * 255 / (256 * Math.max(0.1, r.range))).toFixed(4)
    const mask = a(), sharp = a(), soft = a(), blurred = a(), merged = a()
    out.push(
      `${greys[next++]}eq=brightness=${escapeFilterArgValue(`0.5-${f}`)}:eval=frame,`
        + `lut=c0=${escapeFilterArgValue(`clip(${gain}*abs(val-128),0,255)`)}${mask}`,
      `${label}format=yuv420p,split=2${sharp}${soft}`,
      `${soft}gblur=sigma=${(r.sigma_px * h / 1080).toFixed(2)}${blurred}`,
      ...greyMaskMergeStatements(sharp, blurred, mask, merged, a),
    )
    label = merged
  }
  if (spec.parallax) {
    const p = spec.parallax
    const amp = (p.pct / 100) * w
    const scale = amp / Math.max(0.2, p.near - p.focus, p.focus - p.far)
    // o(t): "in" grows 0 → 1 over the clip; sideways sweeps −1 → 1 (left, up) or 1 → −1 (right).
    const e = easeExpression(0, duration)
    const o = p.direction === 'in' ? e : p.direction === 'right' ? `(1-2*${e})` : `(2*${e}-1)`
    const K = `(${(scale / 256).toFixed(6)}*${o})`
    const shift = a(), grey128 = `color=c=gray:s=${w}x${h}:r=${fps}:d=${(duration + 1).toFixed(3)},format=gray`
    out.push(`${greys[next++]}eq=contrast=${escapeFilterArgValue(K)}:brightness=${escapeFilterArgValue(`${K}*${(0.5 - p.focus).toFixed(4)}`)}:eval=frame${shift}`)
    const gbrp = (src: string) => {
      const s1 = a(), s2 = a(), s3 = a(), dst = a()
      out.push(`${src}split=3${s1}${s2}${s3}`, `${s1}${s2}${s3}mergeplanes=map0s=0:map0p=0:map1s=1:map1p=0:map2s=2:map2p=0:format=gbrp${dst}`)
      return dst
    }
    let xm: string, ym: string
    if (p.direction === 'in') {
      // Near things grow away from the middle: sample nearer the middle by shift × (position − middle).
      const sx = a(), sy = a(), gx = a(), gy = a(), mx = a(), my = a()
      const ramp = (axis: 'X' | 'Y') => `nullsrc=s=${w}x${h}:r=${fps}:d=${(1 / fps).toFixed(4)},format=gray,`
        + `geq=lum=${escapeFilterArgValue(`clip(128+127*(2*${axis}/${axis === 'X' ? 'W' : 'H'}-1),1,255)`)},`
        + `loop=loop=-1:size=1,setpts=N/${fps}/TB,trim=end=${(duration + 1).toFixed(3)}`
      out.push(`${shift}split=2${sx}${sy}`, `${ramp('X')}${gx}`, `${ramp('Y')}${gy}`)
      const radial = escapeFilterArgValue('clip(128-(x-128)*(y-128)/127,0,255)')
      out.push(`${sx}${gx}lut2=c0=${radial}${mx}`, `${sy}${gy}lut2=c0=${radial}${my}`)
      xm = gbrp(mx); ym = gbrp(my)
    } else {
      const flat = a()
      out.push(`${grey128}${flat}`)
      const moving = gbrp(shift), still = gbrp(flat)
      ;[xm, ym] = p.direction === 'up' ? [still, moving] : [moving, still]
    }
    const rgb = a(), moved = a()
    const margin = Math.min(0.05, p.pct / 100 + 0.004)
    const cw = Math.round((w * (1 - 2 * margin)) / 2) * 2, ch = Math.round((h * (1 - 2 * margin)) / 2) * 2
    out.push(
      `${label}format=gbrp${rgb}`,
      `${rgb}${xm}${ym}displace=edge=smear,format=yuv420p,crop=${cw}:${ch},scale=${w}:${h}:flags=bicubic,setsar=1${moved}`,
    )
    label = moved
  }
  out.push(`${label}null${opts.output}`)
  return out
}

// ── Fades ───────────────────────────────────────────────────────────────────

/** The live window's end, with an open end bounded by the stream length. */
function windowEnd(doc: SceneOverlayDocument, opts: OverlayCompileOpts): number {
  return doc.timing.end_sec ?? opts.duration
}

/**
 * A 0..1 ramp across the window — up over `fade_in_sec`, down over
 * `fade_out_sec` — as an FFmpeg expression of `t`, or `''` when there is no
 * fade. Used by effects whose strength is already an expression.
 */
export function envelopeExpression(doc: SceneOverlayDocument, opts: OverlayCompileOpts): string {
  const fi = doc.timing.fade_in_sec || 0
  const fo = doc.timing.fade_out_sec || 0
  const parts: string[] = []
  if (fi > 0) parts.push(`min(1,max(0,(t-${doc.timing.start_sec.toFixed(3)})/${fi.toFixed(3)}))`)
  if (fo > 0) parts.push(`min(1,max(0,(${windowEnd(doc, opts).toFixed(3)}-t)/${fo.toFixed(3)}))`)
  return parts.join('*')
}

/** `fade` filters that ramp a stream's ALPHA across the window. */
function alphaFades(doc: SceneOverlayDocument, opts: OverlayCompileOpts): string[] {
  const fi = doc.timing.fade_in_sec || 0
  const fo = doc.timing.fade_out_sec || 0
  const out: string[] = []
  if (fi > 0) out.push(`fade=t=in:st=${doc.timing.start_sec.toFixed(3)}:d=${fi.toFixed(3)}:alpha=1`)
  if (fo > 0) {
    const end = windowEnd(doc, opts)
    out.push(`fade=t=out:st=${Math.max(0, end - fo).toFixed(3)}:d=${fo.toFixed(3)}:alpha=1`)
  }
  return out
}

function compileWithFadeWrapper(doc: SceneOverlayDocument, opts: OverlayCompileOpts): string[] | null {
  const dry = opts.allocLabel(), wetIn = opts.allocLabel(), wetOut = opts.allocLabel(), faded = opts.allocLabel()
  // The copy keeps its hard window, so outside it the filter passes frames
  // through untouched and costs almost nothing.
  const hard = { ...doc, timing: { ...doc.timing, fade_in_sec: 0, fade_out_sec: 0 } } as SceneOverlayDocument
  const inner = compileSceneOverlay(hard, { ...opts, input: wetIn, output: wetOut })
  if (!inner) return null
  const enable = overlayEnableSuffix(doc, opts)
  return [
    `${opts.input}split=2${dry}${wetIn}`,
    ...inner,
    `${wetOut}format=yuva420p,${alphaFades(doc, opts).join(',')}${faded}`,
    `${dry}${faded}overlay=0:0${enable}${opts.output}`,
  ]
}

// ── Atmosphere loops ────────────────────────────────────────────────────────

function compileAtmosphereLoop(doc: AtmosphereLoopOverlay, opts: OverlayCompileOpts): string[] | null {
  if (doc.opacity <= 0 && doc.darken <= 0) return null
  const shapes = overlayLoopShapes(doc)
  const labels = shapes.map(shape => opts.loopInput?.(shape) ?? null)
  // Nothing baked = nothing to draw. The caller reports it.
  if (labels.some(label => !label)) return null
  const fps = opts.fps || 24
  const enable = overlayEnableSuffix(doc, opts)
  const env = envelopeExpression(doc, opts)
  const statements: string[] = []
  let current = opts.input

  if (doc.darken > 0) {
    const next = opts.allocLabel()
    const k = env ? `*${env}` : ''
    const brightness = `-${doc.darken.toFixed(4)}${k}`
    const saturation = `1-${(doc.darken * 1.5).toFixed(4)}${k}`
    statements.push(`${current}eq=brightness=${escapeFilterArgValue(brightness)}:saturation=${escapeFilterArgValue(saturation)}:eval=frame${enable}${next}`)
    current = next
  }

  if (doc.opacity > 0) {
    const colors = shapes.length === 2 ? [doc.color_hex, doc.secondary_color_hex!] : [doc.color_hex]
    const fades = alphaFades(doc, opts)
    shapes.forEach((_shape, i) => {
      const mask = opts.allocLabel(), tint = opts.allocLabel(), layer = opts.allocLabel(), next = opts.allocLabel()
      const scale = `scale=${opts.w}:${opts.h}:flags=bicubic,`
      // A loop baked at a fraction of the frame is scaled up here; a mask at
      // full size passes the scale untouched (FFmpeg skips a no-op scale).
      const gain = doc.opacity < 0.999 ? `,lut=c0=${escapeFilterArgValue(`val*${doc.opacity.toFixed(4)}`)}` : ''
      statements.push(`${labels[i]}format=gray,${scale}setsar=1${gain}${mask}`)
      statements.push(`color=c=${ffColor(colors[i]!)}:s=${opts.w}x${opts.h}:r=${fps}${tint}`)
      statements.push(`${tint}${mask}alphamerge${fades.length ? `,${fades.join(',')}` : ''}${layer}`)
      const out = i === shapes.length - 1 ? opts.output : next
      statements.push(`${current}${layer}overlay=0:0:shortest=1${enable}${out}`)
      current = out
    })
  } else {
    statements.push(`${current}null${opts.output}`)
  }
  return statements
}

// ── Lightning ───────────────────────────────────────────────────────────────

/**
 * `lightningLevel()` from `contracts/effect-loops.ts`, written as an FFmpeg
 * expression. Variables: 0 = slot, 1 = strike hash, 2 = position hash,
 * 3 = seconds since the strike. `max(…,0)` inside `exp` keeps a far-future
 * strike from overflowing to infinity (infinity × 0 is NaN, not 0).
 */
export function lightningExpression(period: number, chance: number, seed: number): string {
  const p = period.toFixed(4)
  const s = (seed * 78.233).toFixed(4)
  const hash = (n: string, v: number) =>
    `st(${v},sin((${n})*12.9898+${s})*43758.5453);st(${v},ld(${v})-floor(ld(${v})))`
  const strike = (d: string) => `gte(${d},0)*exp(-max(${d},0)*9)`
  return `(st(0,floor(t/${p}));${hash('ld(0)', 1)};${hash('ld(0)+0.5', 2)};`
    + `st(3,t-(ld(0)*${p}+${p}*(0.15+0.7*ld(2))));`
    + `lt(ld(1),${chance.toFixed(4)})*min(1,${strike('ld(3)')}+0.6*${strike('ld(3)-0.18')}))`
}

// ── Heat shimmer ────────────────────────────────────────────────────────────

/**
 * Displace the picture by two drifting Perlin fields (one per axis), generated
 * small and scaled up — the maps are soft, so a 320-wide field costs a fraction
 * of a full-size one and looks the same.
 *
 * The picture is displaced in planar RGB so all three planes move together; in
 * YUV the half-size chroma planes would be shifted by the luma map and fringe.
 */
function compileHeatShimmer(
  doc: Extract<SceneOverlayDocument, { kind: 'heat-shimmer' }>,
  opts: OverlayCompileOpts,
): string[] | null {
  if (doc.strength_px <= 0) return null
  const fps = opts.fps || 24
  const enable = overlayEnableSuffix(doc, opts)
  const px = scaleReferencePx(doc.strength_px, opts.h)
  // Perlin output spreads about ±64 around 128; map that onto ±px.
  const gain = (px / 64).toFixed(4)
  const top = doc.region_top.toFixed(3), bottom = doc.region_bottom.toFixed(3)
  const band = `clip((Y/H-${top}+0.08)/0.16,0,1)*clip((${bottom}-Y/H+0.08)/0.16,0,1)`
  const map = (seed: number) => `perlin=s=320x180:r=${fps}:octaves=2:persistence=0.5`
    + `:xscale=${(6 / doc.scale).toFixed(3)}:yscale=${(3 / doc.scale).toFixed(3)}:tscale=${(0.5 * doc.speed).toFixed(3)}`
    + `:random_mode=seed:random_seed=${seed},format=gray,`
    + `geq=lum=${escapeFilterArgValue(`128+(lum(X,Y)-128)*${gain}*${band}`)},`
    + `scale=${opts.w}:${opts.h}:flags=bicubic,format=gbrp`
  const src = opts.allocLabel(), xmap = opts.allocLabel(), ymap = opts.allocLabel(), moved = opts.allocLabel()
  return [
    `${opts.input}format=gbrp${src}`,
    `${map(doc.seed)}${xmap}`,
    `${map(doc.seed + 1)}${ymap}`,
    `${src}${xmap}${ymap}displace=edge=smear${enable}${moved}`,
    `${moved}format=yuv420p${opts.output}`,
  ]
}

// ── Vignette ────────────────────────────────────────────────────────────────

/**
 * FFmpeg's `vignette` grows stronger as its lens angle approaches PI/2. The
 * calibrated band stops well short of that extreme, so darkness starts at the
 * corners and moves inward rather than dimming the centre like an exposure cut.
 */
const VIGNETTE_ANGLE_MIN = 0.45
const VIGNETTE_ANGLE_MAX = 1.25

export function vignetteAngle(intensity: number): number {
  return VIGNETTE_ANGLE_MIN + intensity * (VIGNETTE_ANGLE_MAX - VIGNETTE_ANGLE_MIN)
}

// ── Letterbox ───────────────────────────────────────────────────────────────

const LETTERBOX_RATIO_VALUES: Record<string, number> = { '2.35:1': 2.35, '2.00:1': 2.0, '1.85:1': 1.85 }

function evenDown(value: number): number {
  return Math.max(0, Math.floor(value / 2) * 2)
}

/** Bar height for a named cinematic ratio. 0 when the frame is already wider. */
export function letterboxBarHeight(w: number, h: number, ratioName: string): number {
  const pictureHeight = evenDown(w / (LETTERBOX_RATIO_VALUES[ratioName] || 2.35))
  return evenDown((h - pictureHeight) / 2)
}

/** The two `drawbox` filters, unlabelled, ready to splice into a chain. */
export function letterboxBars(barHeight: number, color: string, enableSuffix = ''): string {
  return `drawbox=x=0:y=0:w=iw:h=${barHeight}:color=${color}:t=fill${enableSuffix},`
    + `drawbox=x=0:y=ih-${barHeight}:w=iw:h=${barHeight}:color=${color}:t=fill${enableSuffix}`
}

/**
 * Letterbox that hides nothing (1.4.282, owner): the whole frame shrinks to the
 * band between the bars, keeping its aspect ratio, and the rest is `color`.
 * Side bars appear where the band is narrower than the frame; the output size
 * never changes. With a time window the shrunk copy is laid over the untouched
 * picture only inside it, because `scale` and `pad` have no `enable` option.
 */
export function letterboxFit(
  input: string, output: string, w: number, h: number, bar: number, color: string,
  enableSuffix: string, allocLabel: () => string,
): string[] {
  const band = h - bar * 2
  const fit = `scale=${evenDown(w * band / h)}:${band},pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1`
  if (!enableSuffix) return [`${input}${fit}${output}`]
  const base = allocLabel()
  const copy = allocLabel()
  const shrunk = allocLabel()
  return [
    `${input}split=2${base}${copy}`,
    `${copy}${fit}${shrunk}`,
    `${base}${shrunk}overlay=0:0${enableSuffix}${output}`,
  ]
}

// ── Gradient scrim ──────────────────────────────────────────────────────────

/**
 * APPROXIMATION. `drawbox` cannot draw a gradient, so the ramp is a stack of
 * flat bands at stepped opacity, strongest at the frame edge. Smooth at the
 * default 24 steps; visibly banded below about 8.
 */
function scrimBands(
  doc: Extract<SceneOverlayDocument, { kind: 'gradient-scrim' }>,
  w: number, h: number, enableSuffix: string,
): string[] {
  const vertical = doc.edge === 'top' || doc.edge === 'bottom'
  const span = Math.round((vertical ? h : w) * doc.coverage)
  if (span <= 0) return []
  const color = ffColor(doc.color_hex)
  const out: string[] = []
  for (let i = 0; i < doc.steps; i++) {
    const near = Math.round(span * i / doc.steps)
    const far = Math.round(span * (i + 1) / doc.steps)
    const thickness = far - near
    if (thickness <= 0) continue
    const alpha = (doc.opacity * (doc.steps - i) / doc.steps).toFixed(3)
    const geometry = doc.edge === 'bottom' ? `x=0:y=${h - far}:w=iw:h=${thickness}`
      : doc.edge === 'top' ? `x=0:y=${near}:w=iw:h=${thickness}`
      : doc.edge === 'left' ? `x=${near}:y=0:w=${thickness}:h=ih`
      : `x=${w - far}:y=0:w=${thickness}:h=ih`
    out.push(`drawbox=${geometry}:color=${color}@${alpha}:t=fill${enableSuffix}`)
  }
  return out
}

// ── Light leak ──────────────────────────────────────────────────────────────

/** Tighter than PI/2 would blow out; looser than this stops reading as a leak. */
const LEAK_ANGLE_MIN = 0.95
const LEAK_ANGLE_MAX = 1.45

/** Fractional position of each anchor, inset from the very edge. */
function anchorFraction(anchor: OverlayAnchor): { x: number; y: number } {
  const [vertical, horizontal] = splitAnchor(anchor)
  const map: Record<string, number> = { top: 0.15, left: 0.15, center: 0.5, bottom: 0.85, right: 0.85 }
  return { x: map[horizontal] ?? 0.5, y: map[vertical] ?? 0.5 }
}

/** `0..1` progress across the overlay's live window, or `''` if it never moves. */
function leakDriftExpr(
  doc: Extract<SceneOverlayDocument, { kind: 'light-leak' }>,
  opts: OverlayCompileOpts,
): string {
  if (doc.from_anchor === doc.to_anchor) return ''
  const start = doc.timing.start_sec
  const end = doc.timing.end_sec ?? opts.duration
  const span = Math.max(0.001, end - start)
  return `min(1,max(0,(t-${start.toFixed(3)})/${span.toFixed(3)}))`
}

function leakAxisExpr(from: number, to: number, drift: string): string {
  if (!drift) return String(Math.round(from))
  const delta = Math.round(to) - Math.round(from)
  if (delta === 0) return String(Math.round(from))
  return `${Math.round(from)}${delta < 0 ? '-' : '+'}${Math.abs(delta)}*${drift}`
}

// ── Anchoring ───────────────────────────────────────────────────────────────

/**
 * Overlay-filter coordinates for one of the nine anchors.
 *
 * `W`/`H` are the frame, `w`/`h` the thing being placed — the `overlay` filter's
 * own variable names. This is the anchor maths the logo overlay has always used.
 */
export function anchorOverlayPosition(anchor: string, margin: number): { x: string; y: string } {
  const [vertical, horizontal] = splitAnchor(anchor)
  const x = horizontal === 'left' ? `${margin}` : horizontal === 'right' ? `W-w-${margin}` : '(W-w)/2'
  const y = vertical === 'top' ? `${margin}` : vertical === 'bottom' ? `H-h-${margin}` : '(H-h)/2'
  return { x, y }
}

/**
 * `bottom-right` → `['bottom', 'right']`. Bare `center` is the one anchor that
 * is not a pair, and it means centred on both axes. Anything unrecognised
 * falls back to bottom-right rather than throwing — an overlay drawn in the
 * wrong corner is recoverable, a failed render is not.
 */
function splitAnchor(anchor: string): [string, string] {
  if (anchor === 'center') return ['center', 'center']
  const parts = anchor.split('-')
  if (parts.length !== 2) return ['bottom', 'right']
  return [parts[0]!, parts[1]!]
}

// ── Lower third ─────────────────────────────────────────────────────────────

/**
 * Two `drawtext` filters, each carrying its own backing box.
 *
 * DELIBERATE, and noted in the registry: `drawbox` cannot size itself to text,
 * so a hand-computed bar would be guessing the width of a string it has not
 * measured. `drawtext`'s own `box=1` is measured by the text renderer, which is
 * the only component that actually knows. The cost is two stacked chips rather
 * than one continuous bar.
 */
function lowerThirdDrawtext(
  doc: Extract<SceneOverlayDocument, { kind: 'lower-third' }>,
  opts: OverlayCompileOpts,
): string[] {
  const title = doc.title.trim()
  const subtitle = doc.subtitle.trim()
  if (!title && !subtitle) return []

  const px = (value: number) => Math.round(scaleReferencePx(value, opts.h))
  const titleSize = px(doc.title_size_px)
  const subtitleSize = px(doc.subtitle_size_px)
  const padding = doc.bar ? px(doc.padding_px) : 0
  const margin = px(doc.margin_px)
  const gap = Math.round(padding * 0.5) + Math.round(titleSize * 0.25)

  const [vertical, horizontal] = splitAnchor(doc.anchor)
  const blockHeight = (title ? titleSize + padding * 2 : 0)
    + (subtitle ? subtitleSize + padding * 2 : 0)
    + (title && subtitle ? gap : 0)
  const blockTop = vertical === 'top' ? `${margin}`
    : vertical === 'bottom' ? `h-${blockHeight + margin}`
    : `(h-${blockHeight})/2`
  const x = horizontal === 'left' ? `${margin}`
    : horizontal === 'right' ? `w-text_w-${margin}`
    : '(w-text_w)/2'

  const alpha = lowerThirdAlphaExpr(doc, opts)
  const out: string[] = []
  let offset = 0
  const line = (text: string, size: number, color: string) => {
    const options = [
      `text=${escapeFilterArgValue(text)}`,
      // Editorial copy is literal, never a strftime or metadata template: a
      // title reading "100% Silk" must render as written.
      'expansion=none',
      `font=${escapeFilterArgValue(doc.font_family)}`,
      `fontcolor=${ffColor(color)}`,
      `fontsize=${size}`,
      ...(doc.bar ? [`box=1:boxcolor=${ffColor(doc.bar_color_hex)}@${doc.bar_opacity.toFixed(3)}:boxborderw=${padding}`] : []),
      `x=${escapeFilterArgValue(x)}`,
      `y=${escapeFilterArgValue(`${blockTop}+${offset + padding}`)}`,
      ...(alpha ? [`alpha=${escapeFilterArgValue(alpha)}`] : []),
      ...(opts.gateExpression || doc.timing.start_sec > 0 || doc.timing.end_sec !== null
        ? [`enable=${escapeFilterArgValue(overlayEnableExpression(doc, opts) || '1')}`]
        : []),
    ]
    out.push(`drawtext=${options.join(':')}`)
    offset += size + padding * 2 + gap
  }

  if (title) line(title, titleSize, doc.title_color_hex)
  if (subtitle) line(subtitle, subtitleSize, doc.subtitle_color_hex || doc.title_color_hex)
  return out
}

/** A linear fade in and out across the overlay's live window, or `''`. */
function lowerThirdAlphaExpr(
  doc: Extract<SceneOverlayDocument, { kind: 'lower-third' }>,
  opts: OverlayCompileOpts,
): string {
  const inSec = doc.fade_in_ms / 1000
  const outSec = doc.fade_out_ms / 1000
  if (inSec <= 0 && outSec <= 0) return ''
  const start = doc.timing.start_sec
  const end = doc.timing.end_sec ?? opts.duration
  const rising = inSec > 0 ? `min(1,(t-${start.toFixed(3)})/${inSec.toFixed(3)})` : '1'
  if (outSec <= 0) return `max(0,${rising})`
  const falling = `min(1,(${end.toFixed(3)}-t)/${outSec.toFixed(3)})`
  return `max(0,min(${rising},${falling}))`
}

// ── Timing ──────────────────────────────────────────────────────────────────

/**
 * The overlay's own window ANDed with any gate the caller supplies.
 *
 * FFmpeg has no boolean `and`, so the conjunction is a product of two 0/1
 * expressions — the same construction the multi-layer overlay path already
 * uses. Returns `''` when the overlay is live for the whole clip and the
 * caller has no gate, which keeps an ungated effect byte-identical to v1.0.
 */
export function overlayEnableExpression(doc: SceneOverlayDocument, opts: OverlayCompileOpts): string {
  const parts: string[] = []
  const { start_sec: start, end_sec: end } = doc.timing
  if (start > 0 && end !== null) parts.push(`between(t,${start.toFixed(2)},${end.toFixed(2)})`)
  else if (start > 0) parts.push(`gt(t,${start.toFixed(2)})`)
  else if (end !== null) parts.push(`lt(t,${end.toFixed(2)})`)
  if (opts.gateExpression) parts.push(opts.gateExpression)
  return parts.join('*')
}

function overlayEnableSuffix(doc: SceneOverlayDocument, opts: OverlayCompileOpts): string {
  const expression = overlayEnableExpression(doc, opts)
  return expression ? `:enable=${escapeFilterArgValue(expression)}` : ''
}

// ── Colour ──────────────────────────────────────────────────────────────────

/**
 * `#RRGGBB` becomes `0xRRGGBB`, which every FFmpeg colour option parses without
 * ambiguity. A bare colour word is passed through as written.
 */
export function ffColor(color: string): string {
  const trimmed = color.trim()
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? `0x${trimmed.slice(1).toUpperCase()}` : trimmed
}
