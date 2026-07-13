export interface IdeaModelHistoryRow {
  model_used?: unknown
  batch_id?: unknown
}

const NON_GENERATION_MODELS = new Set([
  'imported',
  'manual',
  'manual-add',
  'paste-import',
])

// Older Ideas builds wrote this paid default before the user made a choice.
const POLLUTED_LEGACY_DEFAULTS = new Set(['gpt-4o'])

function cleanModel(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function latestGeneratedIdeaModel(ideas: IdeaModelHistoryRow[]): string {
  for (let i = ideas.length - 1; i >= 0; i--) {
    const idea = ideas[i]
    if (!idea || idea.batch_id === 'imported') continue
    const model = cleanModel(idea.model_used)
    if (model && !NON_GENERATION_MODELS.has(model)) return model
  }
  return ''
}

export function resolveInitialIdeaModel(options: {
  rememberedModel?: unknown
  ideas?: IdeaModelHistoryRow[]
  legacyProjectModel?: unknown
}): string {
  const remembered = cleanModel(options.rememberedModel)
  if (remembered) return remembered

  const historical = latestGeneratedIdeaModel(options.ideas || [])
  if (historical) return historical

  const legacy = cleanModel(options.legacyProjectModel)
  if (legacy && !POLLUTED_LEGACY_DEFAULTS.has(legacy)) return legacy
  return ''
}
