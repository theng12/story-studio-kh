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
 *
 * WHEN THE PRODUCT PUBLISHES NO CEILING (owner decision #6, 2026-09-20)
 * ---------------------------------------------------------------------
 * Four shipped chat products publish `max_output_tokens: null`. The owner's
 * ruling is that they are USABLE with no stated limit: the request OMITS the
 * field and the provider — the only authority on what it will return — decides.
 * `resolveOutputTokenBudget` therefore answers `null` for them rather than
 * refusing or substituting a number, and every caller must omit the wire field
 * accordingly. GenStudio makes its own reservation in that case, because there
 * is no ceiling for Story Studio to reserve against.
 */

/**
 * The shape of a workflow's output, not a token count.
 *
 * - `short`    a title, a label, a handful of tags, one rewritten sentence.
 *              Resolves to today's 2,048 default — deliberately unchanged.
 * - `standard` a description, a small structured pack, a batch of prompts.
 * - `long`     research, a chapter, an outline, an idea campaign.
 * - `maximum`  output that must not be cut off at any price: a full-episode
 *              scene plan or a whole-narration rewrite. Takes the product's
 *              entire published ceiling.
 * - `workload` the caller counted its own output BEFORE asking, so the number
 *              comes from the work rather than from a fraction of whatever
 *              product happens to be selected. Supply the count in
 *              `minimumTokens`. See the reservation note below for why this
 *              exists: a chapter batch that generates ~8,000 tokens has no
 *              business reserving the whole 128,000-token ceiling. Omitting
 *              `minimumTokens` falls back to the FULL ceiling, never to a
 *              small number — a caller that fails to size its work must not
 *              be able to under-request and get truncated.
 */
export type OutputBudgetTier = 'short' | 'standard' | 'long' | 'maximum' | 'workload'

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

/**
 * The product ceiling, or `null` when the product published none.
 *
 * `null` is a real answer and is the ONE new thing here — owner decision #6,
 * 2026-09-20. Four shipped chat products publish `max_output_tokens: null`
 * (Free Models Router, grok-4.3, grok-4.6, grok-build-0.1), and the owner's
 * ruling is to make them usable by OMITTING the field and letting the provider
 * decide: "no output limit is fine." Nothing is invented; the absence is
 * carried, and the caller sends no ceiling.
 *
 * A value that is present but MALFORMED — a string, a fraction, a negative —
 * still throws. "The product published nothing" and "I could not read what it
 * published" must not produce the same value (AGENTS.md §6), and the catalogue
 * parser already normalises an unpublished figure to `0` before this point.
 *
 * It used to substitute `SHORT_FORM_OUTPUT_TOKENS` for BOTH cases. That is a
 * number Story Studio invented, and it is the most damaging place to invent
 * one: a ceiling of 2,048 silently squeezes a `long` or `workload` request down
 * to short-form size, the provider stops at exactly that many completion tokens
 * with `finish_reason: "length"`, and a truncated chapter is billed and written.
 * Neither a substitute nor a refusal is right; carrying the absence is.
 */
function productCeiling(maxOutputTokens: unknown): number | null {
  if (maxOutputTokens === null || maxOutputTokens === undefined || maxOutputTokens === 0) return null
  if (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) {
    throw new Error(
      'Cannot resolve an output-token budget: the selected Gateway product published a malformed '
      + `max_output_tokens (got ${JSON.stringify(maxOutputTokens)}). `
      + 'Story Studio does not substitute a ceiling of its own.',
    )
  }
  return maxOutputTokens as number
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
 * `null` means "this product publishes no ceiling, so send none" — every tier
 * here is a FRACTION of the published ceiling (or, for `maximum`, the ceiling
 * itself), so with no ceiling there is no honest number to return. Callers must
 * OMIT the wire field rather than substitute one.
 *
 * An absent budget resolves to the historical short-form default, so callers
 * that never opted in behave exactly as they did before. A resolved number is
 * ALWAYS `<= productMaxOutputTokens`, which keeps the pre-network guard in
 * genstudio-client.ts a genuine backstop rather than a load-bearing check.
 */
export function resolveOutputTokenBudget(
  budget: OutputBudget | undefined,
  productMaxOutputTokens: unknown,
): number | null {
  const ceiling = productCeiling(productMaxOutputTokens)
  if (ceiling === null) return null
  const tier: OutputBudgetTier = typeof budget === 'string'
    ? budget
    : budget?.tier ?? 'short'
  const floor = typeof budget === 'object' && Number.isFinite(budget.minimumTokens)
    ? Math.max(1, Math.floor(budget.minimumTokens as number))
    : 0
  // `workload` is the one tier whose number comes ENTIRELY from the caller's
  // own estimate. With no estimate in hand it degrades UPWARDS to the whole
  // ceiling — under-requesting truncates the answer, which is far worse than
  // holding too much of the balance while the job runs.
  const wanted = tier === 'workload'
    ? (floor > 0 ? floor : ceiling)
    : Math.max(tierTokens(tier, ceiling), floor)
  return Math.max(1, Math.min(wanted, ceiling))
}

/** Stable digest fragment so two tiers never share an idempotency key. */
/**
 * The answer length the caller **expects**, which is what the Gateway's Hub lane sizes a
 * job's deadline from.
 *
 * **Not `resolveOutputTokenBudget`, deliberately.** That resolves a *ceiling* — what may be
 * sent — and a ceiling is not an expectation: sizing a deadline from one turns every job into a
 * three-hour one, which is the failure the owner's decision names. What is an expectation is the
 * `workload` tier's own `minimumTokens`, because that number is already computed from the work
 * being asked for: `ideaOutputTokenBudget(count)` and `batchOutputTokenEstimate(words)` both feed
 * it. Every other tier is a fraction of the product's ceiling, so it says nothing about how long
 * the answer will be and this returns `null` for it.
 *
 * `null` means "not stated", and the Hub then uses the p90 of the fleet's own measured answers.
 * It is never a stand-in number.
 */
export function expectedOutputTokensFor(budget: OutputBudget | undefined): number | null {
  if (!budget || typeof budget !== 'object') return null
  if (budget.tier !== 'workload') return null
  const minimum = budget.minimumTokens
  return typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum >= 1
    ? minimum
    : null
}

export function describeOutputBudget(budget: OutputBudget | undefined): string | null {
  if (!budget) return null
  if (typeof budget === 'string') return budget
  return budget.minimumTokens
    ? `${budget.tier}:${Math.floor(budget.minimumTokens)}`
    : budget.tier
}

// ── How long the expected answer takes, for this side's own socket ──────────
//
// **The same arithmetic Studio Hub uses, mirrored here on purpose.** The Gateway forwards the
// expected length to the Hub, which sizes its own deadline from it; Story's socket has to outlast
// that deadline or it cuts a job its own Gateway and Hub would have allowed (a 100-prompt scene
// pack needs ~68 minutes on the fleet's slowest Mac, and the owner's dial defaults to 30). The
// Hub's constants live in `components/hub/backend/chat_deadline.py` — its rate is the *worker's
// measured* one where it has it — and this side cannot read Python, so the numbers are restated
// here ONCE, at their most conservative, with the source named beside each.
//
// Deliberately conservative in every direction: the slowest measured rate, the same `x1.5`, and
// the Hub's own stated load/prefill estimates. A longer Story socket cannot lose work; a shorter
// one loses generation that was paid for.

/** The longest a chat job may take — the Hub's own ceiling (`chat_deadline.CEILING_S`), 4 hours. */
export const CHAT_ALLOWANCE_CEILING_SECONDS = 4 * 3600

/** Decode tokens a second: the fleet's **slowest measured** Mac (`qwen3-5-9b-4bit` 16 GB M1,
 *  12.40–12.48 tok/s in `qualification/model-readings.json`). */
export const CHAT_ALLOWANCE_DECODE_TOKENS_PER_SECOND = 12

/** The Hub's own safety margin (`chat_deadline.SAFETY_MARGIN`). */
export const CHAT_ALLOWANCE_SAFETY_MARGIN = 1.5

/** The Hub's stated cold-load estimate (`chat_deadline.STATED_LOAD_S`). */
export const CHAT_ALLOWANCE_LOAD_SECONDS = 15

/** Prefill runs faster than decode; the Hub states 5x (`STATED_PREFILL_FASTER_THAN_DECODE`),
 *  which makes prefill look slower than it is and so makes this allowance longer. */
export const CHAT_ALLOWANCE_PREFILL_FASTER_THAN_DECODE = 5

/** The Hub's prompt approximation (`chat_deadline.CHARS_PER_TOKEN`). */
export const CHAT_ALLOWANCE_CHARS_PER_TOKEN = 4

/**
 * How long this answer is expected to take, in seconds, on the fleet's slowest measured Mac.
 *
 * `0` when no expectation was stated — there is then nothing to add to the owner's setting, and
 * inventing an allowance from `max_output_tokens` is the "every job is three hours" defect the
 * expectation exists to avoid.
 *
 * This is an allowance, not a cap: the caller takes `max` of it and the owner's dial, and the
 * ceiling bounds both.
 */
export function chatAllowanceSeconds(
  expectedOutputTokens: number | null,
  promptCharacters: number,
): number {
  if (expectedOutputTokens === null || !(expectedOutputTokens > 0)) return 0
  const promptTokens = Math.max(0, Math.ceil(Math.max(0, promptCharacters) / CHAT_ALLOWANCE_CHARS_PER_TOKEN))
  const prefillTokensPerSecond = CHAT_ALLOWANCE_DECODE_TOKENS_PER_SECOND
    * CHAT_ALLOWANCE_PREFILL_FASTER_THAN_DECODE
  const wanted = CHAT_ALLOWANCE_SAFETY_MARGIN * (
    CHAT_ALLOWANCE_LOAD_SECONDS
    + promptTokens / prefillTokensPerSecond
    + expectedOutputTokens / CHAT_ALLOWANCE_DECODE_TOKENS_PER_SECOND
  )
  // **Rounded up to a whole minute.** A socket bound is a wait, and a fraction of a minute is a
  // Truncated assertion away from cutting a job that was about to answer; rounding up can only
  // leave it open a little longer, and the ceiling still bounds it.
  const wholeMinutes = Math.ceil(wanted / 60) * 60
  return Math.min(CHAT_ALLOWANCE_CEILING_SECONDS, wholeMinutes)
}

/**
 * The socket timeout for one chat request: **the owner's setting or the allowance, whichever is
 * longer, never below the setting and never above the ceiling.**
 *
 * The owner's dial is a floor here, not a preference — lowering it because the model is expected
 * to be quick would take away a bound the operator deliberately set. The ceiling is the Hub's, so
 * this side can never hold a socket open on a job the Hub has already stopped.
 */
export function effectiveChatTimeoutMs(ownerTimeoutMs: number, allowanceSeconds: number): number {
  const owner = Number.isFinite(ownerTimeoutMs) && ownerTimeoutMs > 0 ? ownerTimeoutMs : 0
  const allowanceMs = Number.isFinite(allowanceSeconds) && allowanceSeconds > 0
    ? allowanceSeconds * 1000
    : 0
  return Math.min(CHAT_ALLOWANCE_CEILING_SECONDS * 1000, Math.max(owner, allowanceMs))
}
