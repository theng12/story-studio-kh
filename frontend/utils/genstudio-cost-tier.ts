export type GenStudioCostTier = 'economy' | 'balanced' | 'premium'

export const GENSTUDIO_COST_TIERS = [
  { id: 'economy', label: 'Economy', description: 'Routine volume and low credit use' },
  { id: 'balanced', label: 'Balanced', description: 'Moderate cost with greater capability' },
  { id: 'premium', label: 'Premium', description: 'Expensive; choose intentionally' },
] as const

function isGenStudioCostTier(value: string | undefined): value is GenStudioCostTier {
  return GENSTUDIO_COST_TIERS.some(tier => tier.id === value)
}

export function costTierLabel(costTier: GenStudioCostTier): string {
  return GENSTUDIO_COST_TIERS.find(tier => tier.id === costTier)?.label || costTier
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

export function visibleTierOptions<T extends { costTier?: GenStudioCostTier }>(
  options: readonly T[],
  activeTier: GenStudioCostTier,
  searching: boolean,
): T[] {
  if (searching || !isCompleteTierCatalog(options)) return [...options]
  return options.filter(option => option.costTier === activeTier)
}
