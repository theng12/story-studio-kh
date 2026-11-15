import { resolveOutputTokenBudget } from './output-token-budget.js'
import { normalizeContentLanguage } from '../lib/content-language.js'

/** Floor for a small request: one or two ideas never ask for less than the historical default. */
const MIN_IDEA_OUTPUT_TOKENS = 4_096
/**
 * The workload one idea is expected to occupy in the answer, in tokens. A WORKLOAD ESTIMATE — see
 * `ideaOutputTokenBudget` — used to derive a batch count from a published ceiling and to carry that
 * batch's own floor on the wire.
 */
const IDEA_OUTPUT_TOKENS_PER_ITEM = 640
/** One rounding step: the granularity the schema headroom below is expressed in. */
const TOKEN_ROUNDING_STEP = 1_024

/**
 * How many ideas ONE request may ask for: the owner's per-batch cap (2026-10-18), NOT a model limit.
 *
 * `generateIdeaCampaign` already clamps the campaign's `wanted` to this figure, so `remaining` is
 * never above it; the sizing helper re-applies the cap as well, so no future caller can size a
 * request past it.
 */
export const IDEA_BATCH_CAP = 100

/**
 * Room one answer needs BEYOND its idea objects: the array brackets, each object's keys, the output
 * contract's shape and any code fence. Our own allowance rather than a published figure — no
 * product publishes an envelope size — and deliberately one rounding step.
 *
 * The same figure is subtracted from the ceiling when the count is chosen and added to the batch's
 * workload floor when the request is submitted, so the allowance a batch is sized from is the one
 * it is actually asked with.
 */
export const IDEA_BATCH_SCHEMA_HEADROOM_TOKENS = TOKEN_ROUNDING_STEP

/**
 * How many ideas one request may ask for. A typed answer, so "nothing is left to make", "the
 * catalogue stated no ceiling" and "the ceiling cannot hold even one idea" never collapse into the
 * same number (AGENTS.md §6).
 *
 * `budget` is the number the request will actually carry on the wire (the wire field is omitted
 * entirely when the product publishes no ceiling), resolved from the product's published ceiling
 * through the same `resolveOutputTokenBudget` call, tier and workload floor the request itself
 * uses — so the figure reported here is the figure the batch is asked with.
 */
/**
 * How the per-idea allowance was chosen. `measured` is true only when a real measurement was
 * supplied; otherwise the English workload estimate stands and the note says so — this build has no
 * measured Khmer answer cost, and inventing a multiplier for it is exactly what the owner refused.
 */
export interface IdeaSizingLanguageBasis {
  code: 'en' | 'km' | null
  tokens_per_idea: number
  measured: boolean
  note: string
}

export type IdeaBatchSizing = (
  | { source: 'published_ceiling'; batch: number; budget: number }
  | { source: 'no_published_ceiling'; batch: number; budget: null }
  | { source: 'cannot_fit_one_idea'; batch: null; budget: number; ceiling: number }
  | { source: 'no_work_remaining'; batch: 0; budget: null }
) & { language_basis: IdeaSizingLanguageBasis }

/**
 * Size one idea request against what the selected product actually publishes for output.
 *
 * The owner's rule (2026-10-18): when the published ceiling permits, ONE request takes every idea
 * the campaign still needs, up to the per-batch cap — the fixed ten-call sequence is gone. When the
 * ceiling is smaller, the request takes exactly what that ceiling holds and the campaign comes back
 * for the rest.
 *
 * Asking for more ideas than the ceiling can hold is not a slow request, it is a broken one: the
 * provider stops at the ceiling with `finish_reason: "length"`, GenStudio refuses to settle a
 * truncated answer, and the whole campaign fails after the customer has already waited.
 *
 * The `IDEA_OUTPUT_TOKENS_PER_ITEM` figure this divides by is a WORKLOAD ESTIMATE for how much
 * answer one idea needs — not a promise about output quality and not a claim about what any model
 * can do. Nothing here guesses a capability, and nothing here replaces the provider's own limit: a
 * product that publishes a ceiling is used up to that ceiling, and an answer the provider still
 * truncates or refuses keeps its real completion failure.
 *
 * Three states the caller depends on, kept distinct:
 *  - an absent ceiling (the catalogue normalises an unpublished limit to 0, and `null`/`undefined`
 *    mean the same) attempts every remaining idea, up to the cap, with the wire field omitted so
 *    the provider decides — never a fixed fallback batch;
 *  - a present-but-malformed figure is not read as absence: the shared resolver THROWS on it and
 *    that failure is allowed to travel;
 *  - a ceiling too small to hold one complete object is reported as such rather than clamped into a
 *    budget that cannot fit it.
 *
 * A zero remaining is answered with zero: nothing is invented to send.
 */
export function ideaBatchForPublishedCeiling(
  publishedMaxOutputTokens: unknown,
  remaining: number,
  language: { code?: unknown; measuredTokensPerIdea?: unknown } = {},
): IdeaBatchSizing {
  const basis = languageBasis(language.code, language.measuredTokensPerIdea)
  const wanted = Number.isFinite(remaining)
    ? Math.min(IDEA_BATCH_CAP, Math.max(0, Math.floor(remaining)))
    : 0
  if (wanted === 0) return { source: 'no_work_remaining', batch: 0, budget: null, language_basis: basis }
  // The request's own resolver is the single reader of the published figure: it answers `null` when
  // the product publishes none and throws on a present-but-malformed value (AGENTS.md §6). Neither
  // state is invented here, and malformed is never folded into absence. `maximum` is the tier that
  // returns the whole published ceiling rather than a fraction of it — sizing from a fraction was
  // what left half of a large ceiling unused.
  const ceiling = resolveOutputTokenBudget('maximum', publishedMaxOutputTokens)
  if (ceiling === null) return { source: 'no_published_ceiling', batch: wanted, budget: null, language_basis: basis }
  const usable = ceiling - IDEA_BATCH_SCHEMA_HEADROOM_TOKENS
  if (usable < basis.tokens_per_idea) {
    return { source: 'cannot_fit_one_idea', batch: null, budget: ceiling, ceiling, language_basis: basis }
  }
  const batch = Math.min(wanted, Math.floor(usable / basis.tokens_per_idea))
  // The number the request will carry: this batch's own workload floor through the same resolver,
  // tier and floor the call sites pass, clamped to the published ceiling by the resolver itself.
  const budget = resolveOutputTokenBudget(
    { tier: 'workload', minimumTokens: ideaOutputTokenBudgetFor(batch, basis.tokens_per_idea) },
    publishedMaxOutputTokens,
  ) ?? ceiling
  return { source: 'published_ceiling', batch, budget, language_basis: basis }
}

/**
 * The allowance one idea is sized with. English (and an unset language) keep the historical
 * workload estimate byte-for-byte. Khmer has NO measured answer cost in this build and the
 * catalogue publishes none, so it keeps the same estimate and says so in `note`; a real
 * measurement, when one exists, is passed in and only ever SHRINKS the batch.
 */
function languageBasis(code: unknown, measuredTokensPerIdea: unknown): IdeaSizingLanguageBasis {
  const language = normalizeContentLanguage(code)
  const measured = Number.isFinite(measuredTokensPerIdea) && (measuredTokensPerIdea as number) > 0
  if (measured) {
    const tokens = Math.ceil(measuredTokensPerIdea as number)
    return {
      code: language, tokens_per_idea: tokens, measured: true,
      note: `Sized from a measured ${tokens}-token answer per idea.`,
    }
  }
  if (language === 'km') {
    return {
      code: language, tokens_per_idea: IDEA_OUTPUT_TOKENS_PER_ITEM, measured: false,
      note: 'Khmer has no measured answer cost yet, so this batch keeps the English estimate; a truncated answer means the model\'s output limit, not a Khmer sizing figure.',
    }
  }
  if (code != null && String(code).trim() && !language) {
    return {
      code: null, tokens_per_idea: IDEA_OUTPUT_TOKENS_PER_ITEM, measured: false,
      note: `Unknown content language "${String(code)}" — the English estimate stands.`,
    }
  }
  return { code: language, tokens_per_idea: IDEA_OUTPUT_TOKENS_PER_ITEM, measured: false, note: '' }
}

/**
 * The workload FLOOR for one request: the actual count's own need plus the answer's schema headroom.
 *
 * `ideaBatchForPublishedCeiling` subtracts the same headroom from the published ceiling when it
 * chooses the count, so for a count chosen that way this floor is never above that ceiling. It is
 * passed as `outputBudget: { tier: 'workload', minimumTokens: … }`, so the request is sized from the
 * count the caller actually asks for and is clamped to the selected product's published
 * `max_output_tokens` by the resolver — the only limit that bounds it. There is no cap of its own:
 * the old 16,384 ceiling on this floor cut down every batch above 25 ideas, which is exactly the
 * under-use the one-call sizing removes.
 *
 * `MIN_IDEA_OUTPUT_TOKENS` still raises a tiny request to the historical default; it only raises,
 * never lowers. This is a WORKLOAD FLOOR, not a model-capability figure, and not a ceiling: the
 * published `max_output_tokens` (or its absence) is what the request actually travels with.
 */
export function ideaOutputTokenBudget(expectedIdeas: number): number {
  return ideaOutputTokenBudgetFor(expectedIdeas, IDEA_OUTPUT_TOKENS_PER_ITEM)
}

/** The same floor with the per-idea allowance the sizing chose (a measurement, when one exists). */
export function ideaOutputTokenBudgetFor(expectedIdeas: number, tokensPerIdea: number): number {
  const count = Number.isFinite(expectedIdeas)
    ? Math.max(1, Math.min(IDEA_BATCH_CAP, Math.ceil(expectedIdeas)))
    : 1
  const perIdea = Number.isFinite(tokensPerIdea) && tokensPerIdea > 0 ? tokensPerIdea : IDEA_OUTPUT_TOKENS_PER_ITEM
  return Math.max(
    MIN_IDEA_OUTPUT_TOKENS,
    count * perIdea + IDEA_BATCH_SCHEMA_HEADROOM_TOKENS,
  )
}
