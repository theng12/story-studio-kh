/**
 * Scene prompts are structured, long-form outputs. The input context may be
 * very large, but the safe number of scenes in one response is determined by
 * the model's published output allowance, not its context window.
 */
export type ScenePromptPackSize = number
export type ScenePromptPackSetting = 'auto' | ScenePromptPackSize
export type ScenePromptTokenSetting = 'auto' | 4096 | 6144 | 8192 | 12288 | 16384 | 24576 | 32768

export const SCENE_PROMPT_PACK_MIN = 1
export const SCENE_PROMPT_PACK_MAX = 50
export const DEFAULT_SCENE_PROMPT_MAX_OUTPUT_TOKENS = 8192

const TOKEN_BUDGETS = new Set<number>([4096, 6144, 8192, 12288, 16384, 24576, 32768])
const TOKENS_PER_FULL_DETAIL_SCENE = 300
const OUTPUT_SAFETY_FRACTION = 0.75

function normalizeMaxOutputTokens(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_SCENE_PROMPT_MAX_OUTPUT_TOKENS
  return Math.min(32_768, parsed)
}

export function parseScenePromptPackSetting(value: unknown): ScenePromptPackSetting {
  if (value === 'auto' || value == null || value === '') return 'auto'
  const size = Number(value)
  return Number.isInteger(size) && size >= SCENE_PROMPT_PACK_MIN && size <= SCENE_PROMPT_PACK_MAX
    ? size : 'auto'
}

export function parseScenePromptTokenSetting(value: unknown): ScenePromptTokenSetting {
  if (value === 'auto' || value == null || value === '') return 'auto'
  const budget = Number(value)
  return TOKEN_BUDGETS.has(budget) ? budget as Exclude<ScenePromptTokenSetting, 'auto'> : 'auto'
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
