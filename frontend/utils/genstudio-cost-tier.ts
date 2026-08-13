export type GenStudioCostTier = 'economy' | 'balanced' | 'premium'

export const GENSTUDIO_COST_TIERS = [
  { id: 'economy', label: 'Economy', description: 'Routine volume and low credit use' },
  { id: 'balanced', label: 'Balanced', description: 'Moderate cost with greater capability' },
  { id: 'premium', label: 'Premium', description: 'Expensive; choose intentionally' },
] as const

function isGenStudioCostTier(value: string | undefined): value is GenStudioCostTier {
  return GENSTUDIO_COST_TIERS.some(tier => tier.id === value)
}

export function isCompleteTierCatalog(options: readonly { costTier?: string }[]): boolean {
  return options.length > 0 && options.every(option => isGenStudioCostTier(option.costTier))
}

export function tierForOpening(
  selectedId: string,
  options: readonly { id: string; costTier?: GenStudioCostTier }[],
): GenStudioCostTier {
  const selected = options.find(option => option.id === selectedId)
  return selected && isGenStudioCostTier(selected.costTier) ? selected.costTier : 'economy'
}

export function visibleTierOptions<T extends { costTier?: GenStudioCostTier }>(
  options: readonly T[],
  activeTier: GenStudioCostTier,
  searching: boolean,
): T[] {
  if (searching || !isCompleteTierCatalog(options)) return [...options]
  return options.filter(option => option.costTier === activeTier)
}
