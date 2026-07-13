export type ScenePromptCostTier = 'local' | 'free' | 'paid'
export type ScenePromptPackSize = 5 | 10 | 20 | 30
export type ScenePromptPackSetting = 'auto' | ScenePromptPackSize
export type ScenePromptTokenSetting = 'auto' | 4096 | 6144 | 8192

const PACK_SIZES = new Set<number>([5, 10, 20, 30])
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
  return PACK_SIZES.has(size) ? size as ScenePromptPackSize : 'auto'
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
  return Math.min(requested, tier === 'paid' ? 30 : 10) as ScenePromptPackSize
}

export function resolveScenePromptTokenBudget(
  tier: ScenePromptCostTier,
  setting: ScenePromptTokenSetting,
  packSize: ScenePromptPackSize,
): 4096 | 6144 | 8192 {
  if (setting === 'auto') return tier === 'paid' ? 8192 : 4096
  // Twenty or thirty full-detail prompts cannot reliably fit in 4K/6K output.
  return packSize > 10 ? 8192 : setting
}
