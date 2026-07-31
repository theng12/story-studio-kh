/**
 * Live per-model token budgets, read from the GenStudio catalogue.
 *
 * THE RULE
 * --------
 * Story Studio hard-codes NO model name, NO context window, NO output
 * allowance, and NO character limit. Every number on this screen comes from
 * the selected product's published catalogue entry, and GenStudio remains the
 * final server-side validator.
 *
 * The published fields:
 *   • `context_window_tokens` — total prompt-plus-output budget. The field to
 *     use. `context_limit_tokens` is a BACKWARDS-COMPATIBILITY ALIAS, read only
 *     when the current field is absent (an older GenStudio release).
 *   • `max_output_tokens` — the maximum selectable output allowance.
 *
 * WHAT THIS IS NOT
 * ----------------
 * The available-input figure is an ESTIMATE offered for transparency. It is
 * never converted into a character limit: characters per token differ sharply
 * by language, and Khmer and mixed-script narration would be badly
 * mis-measured by any such conversion.
 */

/** The catalogue fields this module reads. Everything else is irrelevant here. */
export interface ModelTokenLimits {
  id?: string
  /** Current field. Prefer this. */
  context_window_tokens?: number
  /** @deprecated Alias read only when `context_window_tokens` is absent. */
  context_limit_tokens?: number
  max_output_tokens?: number
}

/** `0` means "not published" — never a Story Studio guess, never a zero budget. */
function positiveInt(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

/**
 * The product's total prompt-plus-output budget.
 *
 * `context_window_tokens` wins whenever it is published. The deprecated
 * `context_limit_tokens` alias is consulted ONLY as a fallback, so a newer
 * GenStudio never has its authoritative number overridden by a legacy one.
 */
export function contextWindowTokens(model: ModelTokenLimits | null | undefined): number {
  if (!model) return 0
  const published = positiveInt(model.context_window_tokens)
  return published || positiveInt(model.context_limit_tokens)
}

/** The product's published maximum output allowance, or 0 when unpublished. */
export function maxOutputTokens(model: ModelTokenLimits | null | undefined): number {
  return model ? positiveInt(model.max_output_tokens) : 0
}

/** Ladder seeds; doubling and merging them reproduces the historical
 *  4,096 / 6,144 / 8,192 / 12,288 / 16,384 / 24,576 / 32,768 steps and keeps
 *  going for as long as the SELECTED product allows. */
const TOKEN_LADDER_SEEDS = [4096, 6144]

/**
 * The selectable output allowances for one product, derived from what it
 * publishes. The product's exact maximum is always the final option, so a
 * 128,000-token product offers 128,000 and a 32,768-token one stops at 32,768.
 */
export function outputAllowanceOptions(modelMaxOutputTokens: number): number[] {
  const maximum = positiveInt(modelMaxOutputTokens)
  if (!maximum) return []
  const options = new Set<number>()
  for (const seed of TOKEN_LADDER_SEEDS) {
    for (let step = seed; step <= maximum; step *= 2) options.add(step)
  }
  options.add(maximum)
  return [...options].sort((a, b) => a - b)
}

/**
 * Clamp a selected allowance to the product's published maximum.
 *
 * 'auto' always survives a model switch: it means "this product's maximum",
 * so it is correct for every product by construction. A number too large for
 * the newly selected product is clamped DOWN to that product's maximum rather
 * than silently reset, which keeps the user's intent ("as much as possible")
 * while staying inside what GenStudio will accept.
 */
export function clampOutputAllowance(
  setting: 'auto' | number,
  modelMaxOutputTokens: number,
): 'auto' | number {
  if (setting === 'auto') return 'auto'
  const maximum = positiveInt(modelMaxOutputTokens)
  const requested = positiveInt(setting)
  if (!requested) return 'auto'
  if (!maximum) return requested
  return Math.min(requested, maximum)
}

/**
 * `available_input_tokens = max(0, context_window_tokens - selected_max_output_tokens)`
 *
 * Returns 0 when the context window is unpublished, so the caller can say
 * "not published" instead of printing a number nobody promised.
 */
export function availableInputTokens(
  contextWindow: number,
  selectedMaxOutputTokens: number,
): number {
  const window = positiveInt(contextWindow)
  if (!window) return 0
  const output = Number.isInteger(Number(selectedMaxOutputTokens)) && Number(selectedMaxOutputTokens) > 0
    ? Number(selectedMaxOutputTokens)
    : 0
  return Math.max(0, window - output)
}

/** Published numbers are printed with grouping, absent ones as plain words. */
export function formatTokenCount(value: number): string {
  return positiveInt(value) ? positiveInt(value).toLocaleString() : 'not published'
}

/**
 * Does this server error mean GenStudio rejected the context or output size?
 *
 * GenStudio is the final validator, and its catalogue can change under a page
 * that has been open for a while. When it says the request exceeded a limit,
 * the honest response is to REFRESH the catalogue and clamp the UI to what the
 * model now publishes — never to guess a smaller number locally. Matching is on
 * the shape of the message only; no model name is ever matched.
 */
export function isModelTokenLimitError(message: unknown): boolean {
  const text = typeof message === 'string' ? message : ''
  if (!text) return false
  return /\b(context[_ ]window|context[_ ]limit|max[_ ]output[_ ]tokens|output tokens|context length|token limit)\b/i.test(text)
}
