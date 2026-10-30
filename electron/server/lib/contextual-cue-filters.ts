import type { ContextualCue } from '../models/types.js'
import { escapeFilterArgValue } from './ffmpeg-utils.js'
import { CUE_SAFE_MARGIN_PCT, labelImagePosition, resolveContextualCuePosition } from '../contracts/contextual-cue-position.js'

// Cue text is LLM-drafted and human-approved. `validateContextualCueTimeline`
// caps its length but deliberately does not restrict which characters it may
// contain, so the renderer has to handle everything a reviewer could approve —
// apostrophes above all ("Constantinople's main avenue" is real approved copy).
// `escapeFilterArgValue` is the only thing between that text and the filtergraph
// parser; see its contract for why nothing emitted here is quoted.

// Cue type is sized against the frame's SHORT edge (v1.4.15) — `min(w\,h)`
// below, written as an FFmpeg expression so it resolves against the real canvas
// at draw time. It used to be `h*…`, which is the same number on every
// landscape frame (there `h` IS the short edge, so nothing already delivered
// moves) but the LONG edge in portrait, where a 3% label came out at 58px on a
// 1080-wide frame and ran off both sides. The comma carries one backslash for
// the same reason every other value here does: it is emitted into a filtergraph
// unquoted, where a bare comma would end the filter. See `escapeFilterArgValue`.
//
// The 56px corner insets below are deliberately NOT converted. They are a
// margin rather than a size — 56px reads the same in either orientation — and
// they are pinned byte-for-byte by `contextual-cue-filters.test.ts` so a cue in
// an already-delivered episode cannot move.

const MARGIN_FRACTION = (CUE_SAFE_MARGIN_PCT / 100).toFixed(4)

/**
 * Turn one axis of a precise anchor into a drawtext expression.
 *
 * The label is anchored INWARD at the outer thirds — its leading edge sits on
 * the point near the start of the frame, its trailing edge near the end, and
 * it is centred in between. That is `resolveSubtitlePlacement`'s rule for
 * captions, reused verbatim so both features behave the same way under the
 * hand: a label dragged toward an edge grows away from that edge rather than
 * off the frame.
 *
 * `clip()` then guarantees the result no matter how wide the reviewed text
 * turns out to be at render time, which the thirds rule alone cannot — text_w
 * is not known until FFmpeg has laid the glyphs out.
 */
function customAxis(pct: number, size: 'text_w' | 'text_h', dim: 'w' | 'h', offsetPx = 0): string {
  const at = `${dim}*${(pct / 100).toFixed(4)}`
  const anchored = pct <= 33 ? at : pct >= 67 ? `${at}-${size}` : `${at}-${size}/2`
  const shifted = offsetPx ? `${anchored}${offsetPx > 0 ? '+' : ''}${offsetPx}` : anchored
  return `clip(${shifted},${dim}*${MARGIN_FRACTION},${dim}-${size}-${dim}*${MARGIN_FRACTION})`
}

function cueAlpha(cue: ContextualCue): string {
  const start = cue.start_sec.toFixed(3)
  const end = cue.end_sec.toFixed(3)
  const entrance = cue.entrance === 'dissolve' ? 0.42 : cue.entrance === 'fade' ? 0.20 : 0.12
  const exit = cue.exit === 'dissolve' ? 0.42 : cue.exit === 'fade' ? 0.20 : 0.12
  return `if(lt(t,${(cue.start_sec + entrance).toFixed(3)}),(t-${start})/${entrance.toFixed(3)},if(gt(t,${(cue.end_sec - exit).toFixed(3)}),(${end}-t)/${exit.toFixed(3)},1))`
}

function cueX(cue: ContextualCue, baseX: string, left: boolean): string {
  if (cue.entrance !== 'slide' && cue.exit !== 'slide') return baseX
  const duration = 0.28
  const start = cue.start_sec.toFixed(3)
  const leaveAt = (cue.end_sec - duration).toFixed(3)
  const outer = left ? '-text_w-40' : 'w+40'
  const inExpr = `${outer}+(${baseX}-(${outer}))*(t-${start})/${duration}`
  const outExpr = `${baseX}+(${outer}-(${baseX}))*(t-${leaveAt})/${duration}`
  if (cue.entrance === 'slide' && cue.exit === 'slide') {
    return `if(lt(t,${(cue.start_sec + duration).toFixed(3)}),${inExpr},if(gt(t,${leaveAt}),${outExpr},${baseX}))`
  }
  if (cue.entrance === 'slide') return `if(lt(t,${(cue.start_sec + duration).toFixed(3)}),${inExpr},${baseX})`
  return `if(gt(t,${leaveAt}),${outExpr},${baseX})`
}

function shared(cue: ContextualCue, x: string, y: string, left: boolean): string {
  const enable = `between(t,${cue.start_sec.toFixed(3)},${cue.end_sec.toFixed(3)})`
  // Every emitted value goes through the same two-level escape and is left
  // unquoted; the timing expressions need it for their commas just as much as
  // the reviewed copy needs it for its apostrophes.
  return [
    `x=${escapeFilterArgValue(cueX(cue, x, left))}`,
    `y=${escapeFilterArgValue(y)}`,
    `alpha=${escapeFilterArgValue(cueAlpha(cue))}`,
    `enable=${escapeFilterArgValue(enable)}`,
  ].join(':')
}

/**
 * `expansion=none` stops drawtext treating `%` / `%{...}` in approved copy as a
 * strftime or metadata template. Cue text is literal editorial copy, never a
 * template, so a rate like "40% mortality" must render as written.
 */
const LITERAL_TEXT = 'expansion=none'

function drawCueText(label: string, options: string): string {
  return `drawtext=text=${escapeFilterArgValue(label)}:${LITERAL_TEXT}:${options}`
}

/**
 * Builds the exact drawtext filters for an already-approved cue. It consumes
 * only the reviewed text, timing, placement, treatment, and transitions—no
 * model call or timing inference happens at video-assembly time.
 *
 * `offsetSec` moves the reviewed window onto the COMPOSED video's clock. A cue
 * is reviewed against Scene Plan time, but the composed video may open with a
 * branded opening (before-intro clips + intro + after-intro clips + title
 * card) that the plan does not carry, which pushes every scene later by
 * exactly the opening's measured length. Video Assembly derives that number
 * from the real opening assets and hands it in here; see
 * `sceneTimelineOffsetSec` in `generators/video.ts`. It is 0 when nothing
 * precedes the scenes, so an intro-less episode renders byte-identically to
 * before. The reviewed window itself is never mutated — only where it lands.
 */
export function buildContextualCueDrawtextFilters(cue: ContextualCue, offsetSec = 0): string[] {
  if (offsetSec) {
    cue = { ...cue, start_sec: cue.start_sec + offsetSec, end_sec: cue.end_sec + offsetSec }
  }
  const label = cue.subtitle ? `${cue.title}\n${cue.subtitle}` : cue.title
  const pos = resolveContextualCuePosition(cue)
  const top = cue.placement.startsWith('top')
  // Slide direction follows where the cue actually sits, not the corner it
  // used to have — a precisely placed label left of centre still enters from
  // the left. For a corner cue this is identical to `placement.endsWith`.
  const left = pos.xPct < 50
  // A corner cue emits the exact strings it always has, so every episode
  // already rendered stays byte-identical. Precise anchors are the only new
  // shape here.
  const cornerX = pos.custom ? customAxis(pos.xPct, 'text_w', 'w') : (left ? '56' : 'w-text_w-56')
  const cornerY = pos.custom ? customAxis(pos.yPct, 'text_h', 'h') : (top ? '56' : 'h-text_h-56')
  const common = (x = cornerX, y = cornerY) => shared(cue, x, y, left)

  if (cue.template.startsWith('label:')) {
    throw new Error(`Label design ${cue.template} is drawn as an image overlay, not as drawtext.`)
  }
  switch (cue.template) {
    case 'map-pin': {
      // A compact geographic marker, intentionally not a fabricated map.
      // It works over the reviewed scene image and preserves the cue's exact
      // timing while reserving a clear visual hierarchy for place names.
      // The pin sits on the anchor and the label steps 34/36px clear of it —
      // the same gap the corner insets have always produced.
      const pinX = pos.custom ? customAxis(pos.xPct, 'text_w', 'w') : (left ? '56' : 'w-text_w-56')
      const labelX = pos.custom
        ? customAxis(pos.xPct, 'text_w', 'w', left ? 34 : -36)
        : (left ? '90' : 'w-text_w-92')
      return [
        drawCueText('●', `fontcolor=0xf4c75d:fontsize=min(w\\,h)*0.030:borderw=1:bordercolor=0x111827@0.85:${common(pinX, cornerY)}`),
        drawCueText(label, `fontcolor=white:fontsize=min(w\\,h)*0.030:line_spacing=10:box=1:boxcolor=0x111827@0.88:boxborderw=16:${common(labelX, cornerY)}`),
      ]
    }
    case 'archival-caption':
      return [
        drawCueText(label, `fontcolor=0xf4ead1:fontsize=min(w\\,h)*0.028:line_spacing=10:borderw=1:bordercolor=0x080808@0.85:box=1:boxcolor=0x2c211b@0.82:boxborderw=18:${common()}`),
      ]
    case 'chapter-plate':
      // A chapter plate is a centred title card by convention, so it keeps
      // ignoring the corner preset — honouring it now would move every plate
      // in every episode already delivered. A PRECISE anchor is honoured,
      // because that is a position the customer set on this cue deliberately
      // and it cannot be mistaken for an inherited default.
      return [
        drawCueText(label, `fontcolor=white:fontsize=min(w\\,h)*0.052:line_spacing=16:borderw=2:bordercolor=0x111827@0.9:box=1:boxcolor=0x111827@0.82:boxborderw=30:${pos.custom ? common() : common('(w-text_w)/2', 'h*0.18')}`),
      ]
    case 'documentary-label':
    default:
      return [
        drawCueText(label, `fontcolor=white:fontsize=min(w\\,h)*0.032:line_spacing=12:box=1:boxcolor=0x111827@0.88:boxborderw=22:${common()}`),
      ]
  }
}

/**
 * Where an image-backed label is drawn, in output pixels.
 *
 * The cue's own anchor is the point the design's pointer sits on, so a pin's
 * tip lands exactly where the customer placed the cue — not the bounding box's
 * top-left corner. Works in pixels of the real canvas, which is why the preview
 * and the render agree across aspect ratios.
 */
export interface LabelOverlayGeometry {
  x: number
  y: number
  enable: string
  /** The design anchor's pixel position — the leader line starts here. */
  anchor: { x: number; y: number }
  /** FFmpeg expressions for motion (scale, x_offset, y_offset). */
  motion_exprs?: { scale?: string; x_offset?: string; y_offset?: string }
}

/**
 * Motion expressions for image-backed labels.
 * Returns FFmpeg expressions for scale or positional offsets over time.
 *
 * `wipe` (geq alpha manipulation is prohibitively slow for HD/4K) and
 * `line-draw` (leader-line growth needs brittle runtime mask filters) were
 * prototyped and dropped, so neither — and no name nobody ever declared —
 * may quietly become a still: a customer who picked a motion and got none
 * has no way to tell. A name the renderer cannot perform fails here, by name.
 */
function labelMotionExprs(
  motion: string | undefined,
  start: number,
  end: number,
  w: number,
  h: number,
  labelW: number,
  labelH: number,
): { scale?: string; x_offset?: string; y_offset?: string } | undefined {
  if (!motion) return undefined
  const dur = 0.3 // entrance duration
  const tStart = start.toFixed(3)
  const tEnd = (start + dur).toFixed(3)

  switch (motion) {
    case 'pop':
      // Scale from 0.8 to 1.0 with slight overshoot then settle
      return { scale: `if(lt(t,${tEnd}),0.8+0.25*sin((t-${tStart})/${dur}*3.14159),1)` }
    case 'slide':
      // Slide in from left (negative x_offset resolving to 0)
      return { x_offset: `if(lt(t,${tEnd}),-${labelW}*(1-(t-${tStart})/${dur}),0)` }
    case 'float':
      // Gentle vertical float (±3px)
      return { y_offset: `sin((t-${tStart})*2)*3` }
    case 'pulse':
      // Gentle scale pulse during hold
      return { scale: `1+0.05*sin((t-${tStart})*6.28)` }
    default:
      throw new Error(
        `Label motion "${motion}" is not supported. Pick pop, slide, pulse or float — or clear the motion — and save this label again.`,
      )
  }
}

/**
 * The filter chain for ONE image-backed label, plus any demuxer flags its own
 * input needs.
 *
 * Split out of `generators/video.ts` so a test can drive the exact string the
 * composition writes instead of a second copy of it that could drift — AGENTS.md
 * §3's "dev wiring that points somewhere plausible but wrong".
 *
 * A scale motion needs three things a plain overlay does not give it, and each
 * one fails in a way nothing else reports (verified against the real binary in
 * `__tests__/label-motion.test.ts`):
 *
 *   - `scale` resolves its output size at init time by default, and FFmpeg
 *     REFUSES frame variables there (`Expressions with frame variables 'n', 't',
 *     'pos' are not valid in init eval mode`), so the whole graph fails to
 *     start. `eval=frame` moves it onto per-frame evaluation.
 *   - A PNG input yields exactly one frame, which `eof_action=repeat` then holds
 *     for the rest of the video — one evaluation, one frozen size, no motion.
 *     `-loop 1` at the OUTPUT's frame rate gives the expression a frame per tick
 *     on the same clock the cue window and the overlay offsets already use.
 *   - A looped input never reaches EOF, so the overlay would wait for it
 *     forever. `shortest=1` ends this overlay with the video instead.
 *
 * Offset-only motions need none of that: `overlay`'s own `x`/`y` are evaluated
 * per frame against the PRIMARY input's timestamp, so a single repeated still
 * already slides and floats correctly. And a cue with no motion takes none of
 * these branches, so it emits byte-for-byte the filter it always has.
 */
export function buildLabelOverlayFilters(
  geometry: LabelOverlayGeometry,
  opts: { base: string; labelInputIdx: number; fps: number; allocLabel: () => string },
): { input_args: string[]; filters: string[]; output: string } {
  const filters: string[] = []
  const input_args: string[] = []
  let labelInput = `[${opts.labelInputIdx}:v]`

  const scale = geometry.motion_exprs?.scale
  if (scale) {
    input_args.push('-loop', '1', '-framerate', String(opts.fps))
    const nextScale = opts.allocLabel()
    const escaped = escapeFilterArgValue(scale)
    filters.push(`${labelInput}scale=iw*(${escaped}):ih*(${escaped}):eval=frame${nextScale}`)
    labelInput = nextScale
  }

  const x = geometry.motion_exprs?.x_offset
    ? `${geometry.x}+(${escapeFilterArgValue(geometry.motion_exprs.x_offset)})`
    : `${geometry.x}`
  const y = geometry.motion_exprs?.y_offset
    ? `${geometry.y}+(${escapeFilterArgValue(geometry.motion_exprs.y_offset)})`
    : `${geometry.y}`

  const output = opts.allocLabel()
  const shortest = scale ? ':shortest=1' : ''
  filters.push(
    `${opts.base}${labelInput}overlay=x=${x}:y=${y}${shortest}:eof_action=repeat:enable=${escapeFilterArgValue(geometry.enable)}${output}`,
  )
  return { input_args, filters, output }
}

export function labelOverlayGeometry(
  cue: ContextualCue,
  label: { width: number; height: number; anchor: { x: number; y: number } },
  frameW: number,
  frameH: number,
  offsetSec = 0,
): LabelOverlayGeometry {
  const position = labelImagePosition(cue, label, frameW, frameH)
  const start = cue.start_sec + offsetSec
  const end = cue.end_sec + offsetSec
  const motionExprs = labelMotionExprs(cue.motion, start, end, frameW, frameH, label.width, label.height)
  return { ...position, enable: `between(t,${start.toFixed(3)},${end.toFixed(3)})`, motion_exprs: motionExprs }
}

