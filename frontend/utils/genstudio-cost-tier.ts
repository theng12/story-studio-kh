export type GenStudioCostTier = 'economy' | 'balanced' | 'premium'
export type GenStudioLlmCostTier = 'promotional' | 'value' | 'economy' | 'premium'

export const GENSTUDIO_COST_TIERS = [
  { id: 'economy', label: 'Economy', description: 'Routine volume and low credit use' },
  { id: 'balanced', label: 'Balanced', description: 'Moderate cost with greater capability' },
  { id: 'premium', label: 'Premium', description: 'Expensive; choose intentionally' },
] as const

export const GENSTUDIO_LLM_COST_TIERS = [
  { id: 'promotional', label: 'Promotional', description: 'Models offered on promotional terms' },
  { id: 'value', label: 'Value', description: 'Lower combined input and output credit use' },
  { id: 'economy', label: 'Economy', description: 'Moderate combined input and output credit use' },
  { id: 'premium', label: 'Premium', description: 'Highest combined input and output credit use' },
] as const

function isGenStudioCostTier(value: string | undefined): value is GenStudioCostTier {
  return GENSTUDIO_COST_TIERS.some(tier => tier.id === value)
}

function isGenStudioLlmCostTier(value: string | undefined): value is GenStudioLlmCostTier {
  return GENSTUDIO_LLM_COST_TIERS.some(tier => tier.id === value)
}

export function costTierLabel(costTier: GenStudioCostTier): string {
  return GENSTUDIO_COST_TIERS.find(tier => tier.id === costTier)?.label || costTier
}

export function isCompleteTierCatalog(options: readonly { costTier?: string }[]): boolean {
  return options.length > 0 && options.every(option => isGenStudioCostTier(option.costTier))
}

export function tierForOpening(
  selectedId: string,
  options: readonly { id: string; costTier?: string }[],
): GenStudioCostTier {
  const selected = options.find(option => option.id === selectedId)
  return selected && isGenStudioCostTier(selected.costTier) ? selected.costTier : 'economy'
}

export function tierForKeyboard(
  activeTier: GenStudioCostTier,
  key: string,
): GenStudioCostTier | null {
  const current = GENSTUDIO_COST_TIERS.findIndex(tier => tier.id === activeTier)
  if (key === 'ArrowRight') return GENSTUDIO_COST_TIERS[(current + 1) % GENSTUDIO_COST_TIERS.length].id
  if (key === 'ArrowLeft') return GENSTUDIO_COST_TIERS[(current - 1 + GENSTUDIO_COST_TIERS.length) % GENSTUDIO_COST_TIERS.length].id
  if (key === 'Home') return 'economy'
  if (key === 'End') return 'premium'
  return null
}

export function visibleTierOptions<T extends { costTier?: string }>(
  options: readonly T[],
  activeTier: GenStudioCostTier,
  searching: boolean,
): T[] {
  if (searching || !isCompleteTierCatalog(options)) return [...options]
  return options.filter(option => option.costTier === activeTier)
}

export function isCompleteLlmTierCatalog(options: readonly { costTier?: string }[]): boolean {
  return options.length > 0 && options.every(option => isGenStudioLlmCostTier(option.costTier))
}

export function llmCostTierLabel(costTier: GenStudioLlmCostTier): string {
  return GENSTUDIO_LLM_COST_TIERS.find(tier => tier.id === costTier)?.label || costTier
}

export function llmTierForOpening(
  selectedId: string,
  options: readonly { id: string; costTier?: string }[],
): GenStudioLlmCostTier {
  const selected = options.find(option => option.id === selectedId)
  return selected && isGenStudioLlmCostTier(selected.costTier) ? selected.costTier : 'promotional'
}

export function llmTierForKeyboard(
  activeTier: GenStudioLlmCostTier,
  key: string,
): GenStudioLlmCostTier | null {
  const current = GENSTUDIO_LLM_COST_TIERS.findIndex(tier => tier.id === activeTier)
  if (key === 'ArrowRight') return GENSTUDIO_LLM_COST_TIERS[(current + 1) % GENSTUDIO_LLM_COST_TIERS.length].id
  if (key === 'ArrowLeft') return GENSTUDIO_LLM_COST_TIERS[(current - 1 + GENSTUDIO_LLM_COST_TIERS.length) % GENSTUDIO_LLM_COST_TIERS.length].id
  if (key === 'Home') return 'promotional'
  if (key === 'End') return 'premium'
  return null
}

export function visibleLlmTierOptions<T extends { costTier?: string }>(
  options: readonly T[],
  activeTier: GenStudioLlmCostTier,
  searching: boolean,
): T[] {
  if (searching || !isCompleteLlmTierCatalog(options)) return [...options]
  return options.filter(option => option.costTier === activeTier)
}
