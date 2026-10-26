/**
 * The cost tier GenStudio publishes on a catalogue row.
 *
 * Types only, plus the completeness test the default-selection policy uses.
 * There is deliberately no tier list, label or tab policy here any more: the
 * owner removed the Promotional / Value / Economy / Premium tabs (2026-10-26)
 * and every picker is now one searchable list. A published `cost_tier` is still
 * carried as catalogue data; nothing groups, filters or labels by it.
 */
export type GenStudioCostTier = 'economy' | 'balanced' | 'premium'
export type GenStudioLlmCostTier = 'promotional' | 'value' | 'economy' | 'premium'

function isGenStudioCostTier(value: string | undefined): value is GenStudioCostTier {
  return value === 'economy' || value === 'balanced' || value === 'premium'
}

/** True when GenStudio has classified every row of a non-empty catalogue. */
export function isCompleteTierCatalog(options: readonly { costTier?: string }[]): boolean {
  return options.length > 0 && options.every(option => isGenStudioCostTier(option.costTier))
}
