/**
 * The Sketch Draw line weight, as Motion Review edits it. The server owns the rule
 * (`electron/server/lib/sketch-line-weight.ts` names the three weights and decides which one a
 * clip is drawn with; freshness compares against the same choice); this only turns what the
 * customer picked into a value, or a plain sentence saying what to fix, before anything is sent.
 *
 * The weight is THIS EPISODE's, stored beside its pen, hold and reveal; the channel value is only
 * the starting default for an episode that has none.
 */
export const LINE_WEIGHTS = ['thin', 'normal', 'bold'] as const
export type SketchLineWeight = (typeof LINE_WEIGHTS)[number]

/** `''` is not a weight: it means the episode has never chosen, so it follows the channel. */
export type LineWeightChoice = '' | 'channel' | SketchLineWeight

export const LINE_WEIGHT_LABELS: Record<SketchLineWeight, string> = {
  thin: 'Thin', normal: 'Normal', bold: 'Bold',
}

/** What to send for a choice: null for "follow the channel", a weight, or the sentence to show. */
export function lineWeightFromDraft(choice: LineWeightChoice): { ok: true; weight: SketchLineWeight | null } | { ok: false; error: string } {
  if (choice === 'channel') return { ok: true, weight: null }
  if (choice === '') return { ok: false, error: 'Choose a line weight.' }
  return { ok: true, weight: choice }
}

/** The words for a weight, used in the select's "Channel default (...)" row and the help line. */
export function lineWeightLabel(weight: SketchLineWeight): string {
  return LINE_WEIGHT_LABELS[weight]
}
