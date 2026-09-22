/**
 * X-06 (owner decision 2026-09-22) — Scene Plan's two guidance boxes.
 *
 * The Scene Plan page holds two pieces of free text that reach the planner:
 *
 *   - `custom_instructions` — written for ONE episode. Its own label says so,
 *     and owner decision #9 keeps it out of every preset so it cannot follow
 *     the customer to another episode.
 *   - `reusable_guidance` — the standing rule the owner chose to store in Scene
 *     Plan PRESETS only. It travels with a preset and is applied deliberately
 *     to one episode; it is never written to project config and never applies
 *     itself.
 *
 * The backend has exactly one guidance input (`custom_instructions`, appended to
 * the planner prompt as `ADDITIONAL INSTRUCTIONS`), so the two boxes are
 * composed here rather than widening the provider contract for a distinction
 * that is about where the TEXT is kept. When only one box has text the payload
 * is exactly what this page sent before the reusable field existed; when both
 * do, the blocks are labelled so the model and the job log can tell which text
 * is which.
 */
export function composeScenePlanGuidance(
  episodeGuidance: string | null | undefined,
  reusableGuidance: string | null | undefined,
): string | undefined {
  const episode = String(episodeGuidance ?? '').trim()
  const reusable = String(reusableGuidance ?? '').trim()
  if (!reusable) return episode || undefined
  if (!episode) return reusable
  return `Episode-specific guidance:\n${episode}\n\nReusable guidance:\n${reusable}`
}
