/**
 * Scene prompts are structured, long-form outputs. The input context may be
 * very large, but the safe number of scenes in one response is determined by
 * the model's published output allowance, not its context window.
 *
 * EVERYTHING HERE DERIVES FROM THE SELECTED MODEL.
 * ----------------------------------------------------------------------
 * This module used to carry a fixed option set — 4,096 … 32,768 — and clamp
 * every request with `Math.min(32_768, …)`. That silently capped Scene Plan at
 * 32,768 output tokens even when the chosen GenStudio product published
 * 128,000, so the largest models could not be used at their published size and
 * batches were smaller than they needed to be.
 *
 * The option ladder is now GENERATED from the product's live
 * `max_output_tokens`, and the product's own number is always offered as the
 * top choice. No allowance, context window, or model name is hardcoded.
 */
export type ScenePromptPackSize = number
export type ScenePromptPackSetting = 'auto' | ScenePromptPackSize
/** 'auto' = the selected product's published maximum; a number is an explicit
 *  allowance, always clamped to that same published maximum at resolve time. */
export type ScenePromptTokenSetting = 'auto' | number

export const SCENE_PROMPT_PACK_MIN = 1
export const SCENE_PROMPT_PACK_MAX = 50

/**
 * Used ONLY when the catalogue published no usable allowance for the selected
 * product (a malformed or missing entry). It is a last-resort fallback so a
 * broken catalogue read degrades to a small, safe request instead of throwing
 * — never a cap on what a healthy product may be asked for.
 */
export const SCENE_PROMPT_FALLBACK_OUTPUT_TOKENS = 8192

/** The two ladder seeds. Doubling each of them and merging reproduces the
 *  historical 4,096 / 6,144 / 8,192 / 12,288 / 16,384 / 24,576 / 32,768 steps
 *  and keeps going for as long as the selected product allows. */
const TOKEN_LADDER_SEEDS = [4096, 6144] as const

const TOKENS_PER_FULL_DETAIL_SCENE = 300
const OUTPUT_SAFETY_FRACTION = 0.75

function normalizeMaxOutputTokens(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return SCENE_PROMPT_FALLBACK_OUTPUT_TOKENS
  return parsed
}

/**
 * The selectable output allowances for one product, derived from what it
 * publishes. Always ends with the product's exact maximum, so "everything this
 * model allows" is a one-click choice and never rounds down to a stale step.
 */
export function scenePromptTokenOptions(modelMaxOutputTokens: unknown): number[] {
  const maximum = normalizeMaxOutputTokens(modelMaxOutputTokens)
  const options = new Set<number>()
  for (const seed of TOKEN_LADDER_SEEDS) {
    for (let step = seed; step <= maximum; step *= 2) options.add(step)
  }
  options.add(maximum)
  return [...options].sort((a, b) => a - b)
}

export function parseScenePromptPackSetting(value: unknown): ScenePromptPackSetting {
  if (value === 'auto' || value == null || value === '') return 'auto'
  const size = Number(value)
  return Number.isInteger(size) && size >= SCENE_PROMPT_PACK_MIN && size <= SCENE_PROMPT_PACK_MAX
    ? size : 'auto'
}

/**
 * Accept any positive whole allowance. There is deliberately no membership
 * test against a fixed list: the legal values belong to the SELECTED product,
 * which this function has not been told about, so the clamp happens in
 * `resolveScenePromptTokenBudget` where the live maximum is known.
 */
export function parseScenePromptTokenSetting(value: unknown): ScenePromptTokenSetting {
  if (value === 'auto' || value == null || value === '') return 'auto'
  const budget = Number(value)
  return Number.isInteger(budget) && budget >= 1 ? budget : 'auto'
}

/** The largest structured pack that leaves headroom for JSON and retries. */
export function maxSafeScenePromptPackSize(maxOutputTokens?: unknown): ScenePromptPackSize {
  const maxOutput = normalizeMaxOutputTokens(maxOutputTokens)
  const scenes = Math.floor((maxOutput * OUTPUT_SAFETY_FRACTION) / TOKENS_PER_FULL_DETAIL_SCENE)
  return Math.min(SCENE_PROMPT_PACK_MAX, Math.max(SCENE_PROMPT_PACK_MIN, scenes))
}

export function resolveScenePromptTokenBudget(
  modelMaxOutputTokens: unknown,
  setting: ScenePromptTokenSetting,
): number {
  const modelMaximum = normalizeMaxOutputTokens(modelMaxOutputTokens)
  const requested = setting === 'auto' ? modelMaximum : setting
  return Math.min(requested, modelMaximum)
}

/**
 * Explicit choices remain available, but are clipped to what the selected
 * GenStudio model can actually return as a complete, durable JSON response.
 */
export function resolveScenePromptPackSize(
  outputBudget: unknown,
  setting: ScenePromptPackSetting,
): ScenePromptPackSize {
  const safeMaximum = maxSafeScenePromptPackSize(outputBudget)
  const requested = setting === 'auto' ? safeMaximum : setting
  return Math.min(safeMaximum, Math.max(SCENE_PROMPT_PACK_MIN, requested))
}

/**
 * Available input budget at the current setting, per GenStudio's published
 * arithmetic: `max(0, context_window_tokens - selected_max_output_tokens)`.
 *
 * An ESTIMATE for transparency. It is never converted into a character limit:
 * characters per token vary by language, and Khmer and mixed-script narration
 * would be mis-measured by any such conversion. `0` for the context window
 * means "not published", so no budget can honestly be stated.
 */
export function availableInputTokens(
  contextWindowTokens: unknown,
  selectedMaxOutputTokens: unknown,
): number {
  const contextWindow = Number(contextWindowTokens)
  const output = Number(selectedMaxOutputTokens)
  if (!Number.isInteger(contextWindow) || contextWindow < 1) return 0
  if (!Number.isInteger(output) || output < 0) return contextWindow
  return Math.max(0, contextWindow - output)
}
