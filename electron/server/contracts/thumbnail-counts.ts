/**
 * How many thumbnail prompts — and therefore how many candidate thumbnail
 * images — a run makes when nothing else says.
 *
 * A plain-value contract with no dependencies of its own, so the Thumbnail
 * Prompts page's copy and the backend's generators read the SAME number rather
 * than two copies that drift (`@shared/thumbnail-counts`).
 *
 * Owner requirement, 2026-10-25: *"from now on all thumbnail prompts and
 * generation is required to have 3 each, so I have something to choose from."*
 * Scope correction the same day: **3 is the DEFAULT, not a hard rule** — a
 * channel or preset that states another count keeps it, and the owner can still
 * change it. It supersedes "one good thumbnail is enough" for NEW thumbnail
 * work only.
 *
 * Three consequences, one rule each:
 *
 *  1. **A run given no count makes three.** `thumbnailCount()` is the ONE
 *     default, and every surface that used to invent its own number — the
 *     thumbnail-prompt generator's 5, a music episode's 1 — takes it from here.
 *     A count the caller *did* give is returned unchanged: 2 stays 2, 6 stays
 *     6. Nothing is capped: Story Studio does not invent a limit the model
 *     catalogue never published (AGENTS §1).
 *
 *  2. **Done means the episode's own count, observed on disk** — not this
 *     default, and nothing remembered here. The count a run is given is
 *     recorded beside the prompts it wrote (the completion manifest,
 *     `services/prompt-completion.ts`), and Generator, Job Queue, Pipeline step
 *     completion, Production Board cell and the pending filters all read
 *     completion back from that record. An episode that was complete under a
 *     count of 1 is therefore not reopened by today's default of 3.
 *
 *  3. **NO BACKFILL.** Nothing here visits an existing channel, preset, prompt
 *     file, manifest or rendered artwork. The default applies where a default
 *     is *taken* — a new channel's seeded preset, a run that named no count —
 *     and nowhere else.
 */

/**
 * The count of thumbnail prompts, and of candidate thumbnail images, that new
 * thumbnail work makes when no channel, preset or request has stated one.
 */
export const DEFAULT_THUMBNAIL_COUNT = 3

/**
 * The lowest count that is still a choice to make. Below this there is nothing
 * to choose from, which is the thing the owner asked to stop.
 */
export const THUMBNAIL_COUNT_MIN = 1

/**
 * The count a run should make.
 *
 * An explicit, whole, positive count is returned as given. Anything else —
 * absent, blank, `0`, negative, `NaN`, a non-number — is a request that named
 * no count, and naming no count is what the default is for.
 */
export function thumbnailCount(value: unknown, fallback: number = DEFAULT_THUMBNAIL_COUNT): number {
  const count = Math.round(Number(value))
  return Number.isFinite(count) && count >= THUMBNAIL_COUNT_MIN ? count : fallback
}

/**
 * Plain words for a count the customer reads — "3 options", "1 option". Never
 * "variants": what the owner is given is candidates to choose from.
 *
 * The caller passes a count it actually has (rows on screen, prompts on disk);
 * this formats it and never invents one.
 */
export function thumbnailOptionsLabel(count: number): string {
  return `${count} option${count === 1 ? '' : 's'}`
}
