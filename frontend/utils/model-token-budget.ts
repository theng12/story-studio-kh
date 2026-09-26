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

/**
 * Whose figure a published limit is — the gateway's own label, relayed verbatim.
 *
 * `provider`/`model` mean the model's artefact or API stated the number; `curated`,
 * `gateway` and `worker_default` mean somebody *chose* it; `unknown` means nothing was
 * stated. Absent is a different answer from any of them and is kept as `null`, because
 * "we were not told" must never render as "the model said so".
 */
export type PublishedLimitSource =
  | 'provider' | 'model' | 'curated' | 'gateway' | 'worker_default' | 'unknown'

/** The catalogue fields this module reads. Everything else is irrelevant here. */
export interface ModelTokenLimits {
  id?: string
  /** Current field. Prefer this. */
  context_window_tokens?: number
  /** @deprecated Alias read only when `context_window_tokens` is absent. */
  context_limit_tokens?: number
  max_output_tokens?: number
  /** Where `max_output_tokens` came from. Absent/null means unlabelled. */
  max_output_tokens_source?: PublishedLimitSource | null
}

const PUBLISHED_LIMIT_SOURCES: readonly PublishedLimitSource[] = [
  'provider', 'model', 'curated', 'gateway', 'worker_default', 'unknown',
]

/** The label the gateway published for this model's output ceiling, or null. */
export function maxOutputTokensSource(
  model: ModelTokenLimits | null | undefined,
): PublishedLimitSource | null {
  const value = model?.max_output_tokens_source
  if (typeof value !== 'string') return null
  const token = value.trim().toLowerCase() as PublishedLimitSource
  return PUBLISHED_LIMIT_SOURCES.includes(token) ? token : null
}

/**
 * Story Studio's own sentence for a limit that is **not** the model's statement, or
 * null when it is (or when nobody labelled it).
 *
 * The owner's rule, and HUB-20's whole point: a worker's fallback is a different fact
 * from the model's limit, and a UI that shows the number without the difference
 * presents one as the other. The wording names the producer, never a number.
 */
export function describeUnstatedLimitSource(
  model: ModelTokenLimits | null | undefined,
): string | null {
  switch (maxOutputTokensSource(model)) {
    case 'curated':
      return 'a curated default, not the model’s own figure'
    case 'gateway':
      return 'the gateway’s own default, not the model’s own figure'
    case 'worker_default':
      return 'the worker’s fallback, not the model’s own figure'
    case 'unknown':
      return 'unstated by the model'
    default:
      return null
  }
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
  selectedMaxOutputTokens: number | null | undefined,
): number {
  const window = positiveInt(contextWindow)
  if (selectedMaxOutputTokens == null || selectedMaxOutputTokens === 0) return 0
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

/**
 * Will this batch finish before the request is cut off?
 *
 * Token maths says what the model can RETURN. It says nothing about whether
 * the answer arrives before the request times out — and a request cut off
 * part-way is charged for and lost. That is the EP0067 failure (nine packs,
 * 333 scenes, 131 credits, all generated and none retrievable), and a batch
 * far larger than the ones that caused it is now a normal choice.
 *
 * COMPUTED AGAINST THE FLOOR, DESCRIBED WITH THE PREFERENCE. The owner keeps
 * two speeds: a hard floor (25 tok/s by default) below which a provider is not
 * eligible at all, and a preferred speed (50+) that most of them actually hit.
 * The arithmetic has to use the FLOOR, because a provider running at the floor
 * is a provider he may genuinely be routed to, and a batch that cannot finish
 * at that speed is a batch that can genuinely be lost. At the shipped defaults
 * that means the default 250-scene batch DOES warn: 75,000 tokens at 25 tok/s
 * is 50 minutes against a 30-minute timeout. That is correct and intended, so
 * the sentence is careful to say it is the worst eligible case rather than a
 * prediction — a preferred-speed provider finishes the same batch in 25.
 *
 * WHY `tokensPerScene` ALONE, and not the safety fraction as well. 300 is
 * already the pessimistic figure — it sits between the measured p95 (260) and
 * p99 (330) of a real emitted scene — so it is the right multiplier for how
 * many tokens actually come back. The safety fraction guards the model's
 * published ALLOWANCE, a different question, and folding it in here would
 * double-count the pessimism on top of an already worst-case speed.
 *
 * NON-BLOCKING, ALWAYS. It returns a sentence, never a refusal. Nothing here
 * returns a boolean a caller could disable a button with.
 */
export function batchTimeoutWarning(input: {
  /** Scenes in one request, as the panel has resolved it. */
  packSize: number
  /** The channel's `scene_prompt_tokens_per_scene`. */
  tokensPerScene: number
  /** The owner's `genstudio_language_timeout_minutes`. */
  timeoutMinutes: number
  /** His hard floor, `language_floor_tokens_per_second`. The sum uses this. */
  floorTokensPerSecond: number
  /** His preferred speed, `language_preferred_tokens_per_second`. Mentioned
   *  only, and only when it is genuinely faster than the floor. */
  preferredTokensPerSecond?: number
}): string {
  const packSize = positiveInt(input.packSize)
  const tokensPerScene = positiveInt(input.tokensPerScene)
  const floor = Number(input.floorTokensPerSecond)
  const minutes = Number(input.timeoutMinutes)
  // A missing or nonsensical input means the question cannot be answered, and
  // an unanswerable question must be silent rather than alarming. A zero speed
  // or zero timeout would otherwise warn on every batch forever.
  if (!packSize || !tokensPerScene) return ''
  if (!Number.isFinite(floor) || floor <= 0) return ''
  if (!Number.isFinite(minutes) || minutes <= 0) return ''

  const tokens = packSize * tokensPerScene
  const seconds = tokens / floor
  if (seconds <= minutes * 60) return ''

  const preferred = Number(input.preferredTokensPerSecond)
  const hasPreference = Number.isFinite(preferred) && preferred > floor
  const atPreferred = hasPreference ? Math.ceil(tokens / preferred / 60) : 0
  return `At the slowest acceptable provider speed (${floor} tok/s), a batch this size may not finish `
    + `within your ${minutes}-minute timeout — ${packSize} scenes is about ${tokens.toLocaleString()} `
    + `tokens, roughly ${Math.ceil(seconds / 60)} minutes. `
    + (hasPreference
      ? `Faster providers (${preferred}+ preferred) will typically complete it, in about `
        + `${atPreferred} minutes. `
      : '')
    + `Reduce the batch or raise the timeout if you see timeouts.`
}
