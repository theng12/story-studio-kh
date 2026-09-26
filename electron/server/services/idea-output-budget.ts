const MIN_IDEA_OUTPUT_TOKENS = 4_096
// Named FLOOR, not cap: this bounds the workload floor we ASK for, and the
// request is still clamped to the product's published figure in both
// directions. Renamed 2026-09-26 so no reader mistakes it for a ceiling.
const MAX_IDEA_FLOOR_TOKENS = 16_384
const IDEA_OUTPUT_TOKENS_PER_ITEM = 640
const TOKEN_ROUNDING_STEP = 1_024

/**
 * Size structured idea output from the number of JSON objects requested.
 *
 * GenStudio's 2,048-token default is intentionally conservative for ordinary
 * chat, but it can truncate an otherwise valid multi-idea JSON array. Keep
 * idea generation bounded while allowing enough room for complete objects.
 *
 * This is a WORKLOAD FLOOR, not a ceiling. It is passed as
 * `outputBudget: { tier: 'long', minimumTokens: … }` so the request is sized
 * from the selected product's published `max_output_tokens` and is clamped to
 * it. The 16,384 cap here therefore no longer decides the request on its own:
 * a product publishing more can be used in full, and a product publishing less
 * clamps down instead of tripping the pre-network limit guard.
 */
export function ideaOutputTokenBudget(expectedIdeas: number): number {
  const count = Number.isFinite(expectedIdeas)
    ? Math.max(1, Math.min(100, Math.ceil(expectedIdeas)))
    : 1
  const requested = Math.ceil(
    (count * IDEA_OUTPUT_TOKENS_PER_ITEM) / TOKEN_ROUNDING_STEP,
  ) * TOKEN_ROUNDING_STEP
  return Math.max(
    MIN_IDEA_OUTPUT_TOKENS,
    Math.min(MAX_IDEA_FLOOR_TOKENS, requested),
  )
}
