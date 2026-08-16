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
  type OverlayAnchor,
  type SceneMotionDocument,
  type SceneOverlayDocument,
} from '../contracts/scene-effects.js'
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

    return [
      ...prelude,
      `zoompan=z=${zoomTerm}`
        + `:x='floor(iw/2-(iw/zoom/2)${signedTerm(panX, renderRate)})'`
        + `:y='floor(ih/2-(ih/zoom/2)${signedTerm(panY, renderRate)})'`
        + `:d=${frames}:s=${sw}x${sh}:fps=${fps}`,
      `scale=${w}:${h}:flags=lanczos`,
      'setsar=1',
    ]
  }

  // 3. No camera at all: fit, pad, then whatever post-processing is declared.
  return [...prelude, 'setsar=1', ...focusTokens(doc, duration), ...fadeTokens(doc, duration)]
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
}

/**
 * Compile one overlay into filtergraph STATEMENTS.
 *
 * Returns `null` when the overlay draws nothing at all — an unset logo path, a
 * bar height that rounds to zero. That is not an error; it is an overlay with
 * nothing to say, and the caller simply keeps its current label.
 */
export function compileSceneOverlay(doc: SceneOverlayDocument, opts: OverlayCompileOpts): string[] | null {
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
      return [`${input}${letterboxBars(bar, doc.color, enable)}${output}`]
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
  }
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
