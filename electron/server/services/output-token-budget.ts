/**
 * Per-workflow output-token budgets, resolved against the SELECTED GenStudio
 * language product's published `max_output_tokens`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `callChatWithGenStudio` used to default every request that did not name a
 * number to `Math.min(2_048, product.max_output_tokens)`. That is a sensible
 * ceiling for a title or a tag list and a silent data-loss bug for anything
 * long: the provider stops at exactly 2,048 completion tokens with
 * `finish_reason: "length"`, GenStudio refuses to settle a truncated answer,
 * and the whole job fails after the customer already waited for it.
 *
 * The fix is NOT a bigger global constant. A short-form call has no business
 * asking for a huge ceiling (see the credit note below), and a hardcoded
 * "long" number goes stale the moment GenStudio publishes a product with a
 * different limit. So a caller declares the SHAPE of its output — a tier —
 * and the number is derived from whatever the chosen product publishes.
 *
 * CREDIT IMPLICATIONS (read before raising a tier)
 * ------------------------------------------------
 * GenStudio settles a language job on the tokens actually generated
 * (`verified_language_credits(prompt_tokens, completion_tokens)`), so a larger
 * ceiling does NOT by itself cost more — a 400-token answer costs the same
 * whether the ceiling was 2,048 or 32,768.
 *
 * What a larger ceiling DOES change is the up-front reservation:
 * `quote_language_reservation` holds credits for `max_output_tokens`, not for
 * the eventual answer. So a generous tier makes each request hold more of the
 * balance while it runs, and an account close to empty can be refused with
 * "insufficient credits" for a request that would have been cheap. It also
 * removes the ceiling as a brake, so a model that wants to ramble now can —
 * and rambling is charged. Tier by what the workflow genuinely needs.
 */

/**
 * The shape of a workflow's output, not a token count.
 *
 * - `short`    a title, a label, a handful of tags, one rewritten sentence.
 *              Resolves to today's 2,048 default — deliberately unchanged.
 * - `standard` a description, a small structured pack, a batch of prompts.
 * - `long`     research, a chapter, an outline, an idea campaign.
 * - `maximum`  output that must not be cut off at any price: a full-episode
 *              scene plan, a whole-narration rewrite, a chunked narration
 *              batch. Takes the product's entire published ceiling.
 */
export type OutputBudgetTier = 'short' | 'standard' | 'long' | 'maximum'

/**
 * A tier plus an optional workload-derived floor.
 *
 * `minimumTokens` exists for the workflows that can actually count their
 * output before asking for it — N ideas, N scenes — so a big batch is not
 * squeezed into a tier that was sized for a typical one. It only ever raises
 * the request, and it is still clamped to the product ceiling, so it can never
 * push a request past what the product publishes.
 */
export interface OutputBudgetRequest {
  tier: OutputBudgetTier
  minimumTokens?: number
}

export type OutputBudget = OutputBudgetTier | OutputBudgetRequest

/** The historical default. Unchanged on purpose: short-form callers keep it. */
export const SHORT_FORM_OUTPUT_TOKENS = 2_048

/** Floors, so a tier stays useful on a product with a small published limit. */
const STANDARD_FLOOR_TOKENS = 4_096
const LONG_FLOOR_TOKENS = 8_192

/** Fractions of the product's published ceiling. */
const STANDARD_FRACTION = 0.25
const LONG_FRACTION = 0.5

/** Requested budgets are rounded down to this step purely for legibility. */
const ROUNDING_STEP = 256

function roundDown(value: number): number {
  return Math.max(ROUNDING_STEP, Math.floor(value / ROUNDING_STEP) * ROUNDING_STEP)
}

/** The product ceiling, defended against a malformed catalogue entry. */
function productCeiling(maxOutputTokens: unknown): number {
  return Number.isInteger(maxOutputTokens) && (maxOutputTokens as number) >= 1
    ? maxOutputTokens as number
    : SHORT_FORM_OUTPUT_TOKENS
}

function tierTokens(tier: OutputBudgetTier, ceiling: number): number {
  switch (tier) {
    case 'maximum':
      return ceiling
    case 'long':
      return Math.max(LONG_FLOOR_TOKENS, roundDown(ceiling * LONG_FRACTION))
    case 'standard':
      return Math.max(STANDARD_FLOOR_TOKENS, roundDown(ceiling * STANDARD_FRACTION))
    case 'short':
    default:
      return SHORT_FORM_OUTPUT_TOKENS
  }
}

/**
 * Resolve one workflow's budget against one product's published ceiling.
 *
 * An absent budget resolves to the historical short-form default, so callers
 * that never opted in behave exactly as they did before. The result is ALWAYS
 * `<= productMaxOutputTokens`, which keeps the pre-network guard in
 * genstudio-client.ts a genuine backstop rather than a load-bearing check.
 */
export function resolveOutputTokenBudget(
  budget: OutputBudget | undefined,
  productMaxOutputTokens: unknown,
): number {
  const ceiling = productCeiling(productMaxOutputTokens)
  const tier: OutputBudgetTier = typeof budget === 'string'
    ? budget
    : budget?.tier ?? 'short'
  const floor = typeof budget === 'object' && Number.isFinite(budget.minimumTokens)
    ? Math.max(1, Math.floor(budget.minimumTokens as number))
    : 0
  const wanted = Math.max(tierTokens(tier, ceiling), floor)
  return Math.max(1, Math.min(wanted, ceiling))
}

/** Stable digest fragment so two tiers never share an idempotency key. */
export function describeOutputBudget(budget: OutputBudget | undefined): string | null {
  if (!budget) return null
  if (typeof budget === 'string') return budget
  return budget.minimumTokens
    ? `${budget.tier}:${Math.floor(budget.minimumTokens)}`
    : budget.tier
}
