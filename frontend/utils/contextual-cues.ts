/**
 * v1.2.6 — which cues an "Approve all" is allowed to touch.
 *
 * Only `proposed`. An `approved` cue needs nothing, and a `disabled` cue is a
 * decision the customer already made — re-deciding it as a side effect of a
 * bulk action is exactly the defect class AGENTS.md's "Preset Boundaries"
 * section exists to prevent. Extracted from the page so that boundary is
 * covered by a real behavioural test rather than a glance at the template.
 */
export function cuesAwaitingApproval<T extends { status: string }>(cues: readonly T[]): T[] {
  return cues.filter(cue => cue.status === 'proposed')
}
