export type ScenePromptCostTier = 'local' | 'free' | 'paid'
/** An explicit pack size is deliberately flexible for cloud providers. */
export type ScenePromptPackSize = number
export type ScenePromptPackSetting = 'auto' | ScenePromptPackSize
export type ScenePromptTokenSetting = 'auto' | 4096 | 6144 | 8192

export const SCENE_PROMPT_PACK_MIN = 1
export const SCENE_PROMPT_PACK_MAX = 50
const TOKEN_BUDGETS = new Set<number>([4096, 6144, 8192])

/** The model id is authoritative where it exposes locality. Cloud models
 * proxied by Chat Studio need the catalog tier supplied by the caller; an
 * absent tier falls back to free-cloud limits rather than risking a large
 * request against an unknown provider. */
export function resolveScenePromptCostTier(
  model: string,
  supplied?: unknown,
): ScenePromptCostTier {
  if (model.startsWith('chatstudio:provider:')) {
    return supplied === 'paid' ? 'paid' : 'free'
  }
  if (model.startsWith('chatstudio:')) return 'local'
  return 'paid'
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

export function resolveScenePromptPackSize(
  tier: ScenePromptCostTier,
  setting: ScenePromptPackSetting,
): ScenePromptPackSize {
  const requested = setting === 'auto' ? (tier === 'paid' ? 20 : 10) : setting
  // Local and free-cloud workers keep the established 10-scene ceiling. Paid
  // cloud packs may use a saved custom value up to the validated 50-scene max.
  return Math.min(requested, tier === 'paid' ? SCENE_PROMPT_PACK_MAX : 10)
}

export function resolveScenePromptTokenBudget(
  tier: ScenePromptCostTier,
  setting: ScenePromptTokenSetting,
  packSize: ScenePromptPackSize,
): 4096 | 6144 | 8192 {
  if (setting === 'auto') return tier === 'paid' ? 8192 : 4096
  // Larger full-detail packs cannot reliably fit in 4K/6K output.
  return packSize > 10 ? 8192 : setting
}
