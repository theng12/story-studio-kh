export type ResearchMode = 'model-knowledge' | 'web-search'

export interface ResearchModelReadiness {
  model: string | null
  reason: '' | 'Choose a research model' | 'Choose a web-research model'
}

/** Resolve only the selector belonging to the active research mode. */
export function resolveResearchModelForRun(
  mode: ResearchMode,
  sourceModel: string,
  webModel: string,
): ResearchModelReadiness {
  const model = (mode === 'web-search' ? webModel : sourceModel).trim()
  if (model) return { model, reason: '' }
  return {
    model: null,
    reason: mode === 'web-search' ? 'Choose a web-research model' : 'Choose a research model',
  }
}
