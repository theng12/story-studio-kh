const MIN_IDEA_OUTPUT_TOKENS = 4_096
const MAX_IDEA_OUTPUT_TOKENS = 16_384
const IDEA_OUTPUT_TOKENS_PER_ITEM = 640
const TOKEN_ROUNDING_STEP = 1_024

/**
 * Size structured idea output from the number of JSON objects requested.
 *
 * GenStudio's 2,048-token default is intentionally conservative for ordinary
 * chat, but it can truncate an otherwise valid multi-idea JSON array. Keep
 * idea generation bounded while allowing enough room for complete objects.
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
    Math.min(MAX_IDEA_OUTPUT_TOKENS, requested),
  )
}
