/**
 * Where a contextual cue sits on the frame (v1.3.0+).
 *
 * The single source of truth for two questions that used to be answered
 * independently all over the codebase:
 *
 *   1. Which corner values are legal?
 *   2. Given a cue, where does it actually land?
 *
 * Question 1 had SIX answers before this file existed. `ContextualCuePlacement`
 * declared four corners; the timeline validator accepted four; the PUT route
 * accepted four — but the proposal-settings normaliser collapsed anything that
 * was not `'top-left'` to `'top-right'`, the Pipeline step builder did the same
 * thing separately, and the review page offered exactly two options in two
 * different `<select>`s plus a narrowed form type and a preset-apply guard. The
 * result was a feature that was fully implemented, fully validated, fully
 * rendered — and impossible to select. A customer whose channel logo sits in a
 * top corner had his labels drawn over it for four months with no way to move
 * them, because half of a working feature was unreachable.
 *
 * Question 2 is new, and is deliberately answered HERE rather than in the
 * renderer, so the review screen can draw a cue exactly where FFmpeg will draw
 * it. A preview that disagrees with the render is worse than no preview.
 *
 * Deliberately dependency-free — no zod, no `models/types.js` — so the
 * renderer bundle can import it directly, the same reason `pacing.ts` is its
 * own file beside `contracts/index.ts`.
 */

/**
 * The four corner presets. Quick, one-click, and still what most cues carry —
 * a precise anchor is an override, never a replacement.
 */
export type ContextualCueCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const CONTEXTUAL_CUE_CORNERS: readonly ContextualCueCorner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const

/** Human labels for the corner menu, so the four spellings live in one place. */
export const CONTEXTUAL_CUE_CORNER_LABELS: Record<ContextualCueCorner, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
}

export function isContextualCueCorner(value: unknown): value is ContextualCueCorner {
  return CONTEXTUAL_CUE_CORNERS.includes(value as ContextualCueCorner)
}

/**
 * Protected band at every frame edge that a precise cue anchor may not cross,
 * as a percentage of the frame.
 *
 * Corner cues have always been inset a flat 56px, which on a 1080p frame is
 * ~2.9% horizontally and ~5.2% vertically. 6% states that same protection once,
 * on both axes, at any resolution — so a label dragged hard against an edge
 * still clears a player's chrome and a broadcaster's crop.
 *
 * Deliberately NOT a per-cue control. The ask was to move labels, not to
 * configure safe areas, and captions — the thing that genuinely needs a
 * tunable one — already have `VideoSubtitleStyle.safe_margin_pct`.
 */
export const CUE_SAFE_MARGIN_PCT = 6

/** Anything a cue-shaped object must carry to be placed. */
export interface CuePositionInput {
  placement: ContextualCueCorner
  position_x_pct?: number | null
  position_y_pct?: number | null
}

export interface ResolvedCuePosition {
  /** 0–100, measured from the left edge. */
  xPct: number
  /** 0–100, measured from the TOP edge — the subtitle convention. */
  yPct: number
  /** true when the cue carries its own anchor rather than a corner preset. */
  custom: boolean
}

export function clampCuePct(value: number): number {
  return Math.min(100 - CUE_SAFE_MARGIN_PCT, Math.max(CUE_SAFE_MARGIN_PCT, value))
}

/**
 * A real number, and nothing that merely converts to one.
 *
 * `Number(null)` is 0, not NaN — so a `Number.isFinite(Number(v))` test reads
 * a CLEARED anchor as a deliberate placement at the very top-left of the
 * frame. "Use the corner instead" writes exactly that null, which would have
 * pinned the label to the top edge rather than releasing it. Same trap for
 * `''` and `false`.
 */
function isRealNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Both axes or neither — the same both-or-neither rule
 * `hasPreciseSubtitlePlacement` applies to captions. A half-written anchor is
 * not a position: honouring one axis would slide a label along it while
 * leaving the other wherever it happened to be.
 */
export function hasPreciseCuePosition(cue: CuePositionInput): boolean {
  return isRealNumber(cue.position_x_pct) && isRealNumber(cue.position_y_pct)
}

/**
 * Where a cue actually lands.
 *
 * A precise anchor wins when both axes are set. Otherwise the corner preset
 * answers, and callers that render pixels use the exact insets they always
 * have — which is why every cue saved before v1.3.0 renders byte-identically.
 */
export function resolveContextualCuePosition(cue: CuePositionInput): ResolvedCuePosition {
  if (hasPreciseCuePosition(cue)) {
    return {
      xPct: clampCuePct(Number(cue.position_x_pct)),
      yPct: clampCuePct(Number(cue.position_y_pct)),
      custom: true,
    }
  }
  return {
    xPct: cue.placement.endsWith('left') ? CUE_SAFE_MARGIN_PCT : 100 - CUE_SAFE_MARGIN_PCT,
    yPct: cue.placement.startsWith('top') ? CUE_SAFE_MARGIN_PCT : 100 - CUE_SAFE_MARGIN_PCT,
    custom: false,
  }
}

/**
 * The corner a precise anchor most nearly corresponds to.
 *
 * Used only to keep a cue's stored `placement` honest as it is dragged, so a
 * cue that later loses its precise anchor falls back to the nearest corner
 * rather than to whatever corner it was proposed with. Mirrors the
 * `horizontalAnchor`/`verticalAnchor` thirds split in `SubtitleStylePicker`.
 */
export function labelImagePosition(cue: CuePositionInput, label: { width: number; height: number; anchor: { x: number; y: number } }, frameW: number, frameH: number) {
  const pos = resolveContextualCuePosition(cue)
  const anchorX = pos.xPct / 100 * frameW
  const anchorY = pos.yPct / 100 * frameH
  const minX = frameW * CUE_SAFE_MARGIN_PCT / 100
  const minY = frameH * CUE_SAFE_MARGIN_PCT / 100
  return {
    x: Math.round(Math.min(frameW - label.width - minX, Math.max(minX, anchorX - label.anchor.x * label.width))),
    y: Math.round(Math.min(frameH - label.height - minY, Math.max(minY, anchorY - label.anchor.y * label.height))),
    anchor: { x: anchorX, y: anchorY },
  }
}

export function nearestCueCorner(xPct: number, yPct: number): ContextualCueCorner {
  return `${yPct < 50 ? 'top' : 'bottom'}-${xPct < 50 ? 'left' : 'right'}` as ContextualCueCorner
}
