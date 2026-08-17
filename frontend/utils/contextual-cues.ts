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

/**
 * v1.3.3 — what a Contextual Cues preset actually SAYS about auto-approval:
 * `true`, `false`, or `null` when it says nothing at all.
 *
 * `auto_approve` stays in these presets — the owner's decision of 2026-08-18,
 * taken with removal on the table and declined (AGENTS.md, Preset Boundaries).
 * It is a trust decision whose own label reads "Off by default. Use only after
 * you trust this preset", so a preset chosen for its model and density can
 * change it. The page therefore announces it in both directions, and this
 * function is what makes the third case expressible.
 *
 * The third case is not decoration. `data?.auto_approve === true` — what the
 * apply handler used to do — collapses "this preset stores nothing" into
 * `false` and silently switches auto-approval OFF for anyone whose preset
 * predates the field. That is `useContinuityConfig.ts`'s `storedPresetPacing`
 * trap exactly, in the opposite direction: a preset with no opinion about a
 * setting must leave the live setting alone, never supply a default for it.
 */
export function storedPresetAutoApprove(data: unknown): boolean | null {
  const value = (data as { auto_approve?: unknown } | null | undefined)?.auto_approve
  return typeof value === 'boolean' ? value : null
}
