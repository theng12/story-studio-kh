/** Reusable selections only. Prices, availability and capabilities stay live. */
export interface LlmLineup {
  enabled: boolean
  models: string[]
  prefer_savings: boolean
}

export function normalizeLlmLineup(value: unknown): LlmLineup {
  if (value === undefined || value === null) return { enabled: false, models: [], prefer_savings: true }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('LLM lineup must be an object')
  const row = value as Record<string, unknown>
  if (typeof row.enabled !== 'boolean' || !Array.isArray(row.models)
    || row.models.length > 100
    || (row.prefer_savings !== undefined && typeof row.prefer_savings !== 'boolean')) {
    throw new Error('LLM lineup requires an enabled switch and a list of up to 100 model selections')
  }
  const models: string[] = []
  for (const item of row.models) {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > 128) throw new Error('LLM lineup contains an invalid model selection')
    const id = item.trim().replace(/^genstudio-chat:/, '')
    if (!id) throw new Error('LLM lineup contains an empty model selection')
    if (!models.includes(id)) models.push(id)
  }
  if (row.enabled && !models.length) throw new Error('Choose at least one model before enabling the LLM lineup')
  return { enabled: row.enabled, models, prefer_savings: row.prefer_savings !== false }
}
