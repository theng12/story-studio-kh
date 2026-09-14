export interface LlmLineup {
  enabled: boolean
  models: string[]
  prefer_savings: boolean
}

/** Matches the project-config input boundary; this is a shape limit, not a spending cap. */
export const MAX_LLM_LINEUP_MODELS = 100

export const DEFAULT_LLM_LINEUP: LlmLineup = {
  enabled: false,
  models: [],
  prefer_savings: true,
}

/** GenStudio's chat catalogue may expose the gateway namespace on an id while
 * project config stores the same product without that transport prefix. */
export function normalizeLlmModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^genstudio-chat:/, '') : ''
}

export function sameLlmModelId(left: unknown, right: unknown): boolean {
  const a = normalizeLlmModelId(left)
  const b = normalizeLlmModelId(right)
  return Boolean(a && b && a === b)
}

export function normalizeLlmLineup(value: unknown): LlmLineup {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const models = Array.isArray(row.models)
    ? [...new Set(row.models
      .filter((model): model is string => typeof model === 'string' && !!model.trim())
      .map(normalizeLlmModelId)
      .filter(Boolean))]
    : []
  return {
    enabled: row.enabled === true,
    models,
    prefer_savings: row.prefer_savings !== false,
  }
}

export function cloneLlmLineup(value: LlmLineup): LlmLineup {
  return { enabled: value.enabled, models: [...value.models], prefer_savings: value.prefer_savings }
}

export function lineupModeForModels(models: string[]): 'single' | 'backup' {
  return models.length >= 2 ? 'backup' : 'single'
}
