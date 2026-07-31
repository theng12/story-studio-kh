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

/**
 * Older Ideas builds wrote a single hardcoded external product id
 * ('gpt-4o') into project config before per-idea model choice existed.
 * Blindly restoring that value would silently make it execution authority
 * again — but whether ANY saved id is still safe to restore is really a
 * question for GenStudio's live catalogue, not a literal deny-list.
 *
 * Callers that can reach the catalogue should pass `isModelStillLive` to
 * `resolveInitialIdeaModel` so staleness is decided by "is this id present
 * in the live catalogue right now." This set is only the fallback used
 * when no live predicate is supplied (e.g. before the catalog has loaded)
 * and must never grow to cover newly-retired ids — that decision belongs
 * to the live catalogue via `isModelStillLive`, not to this file.
 */
// model-drift-allow: a retired id recognised so a polluted saved preference is
// not restored. It must never grow — new retirements are the live catalogue's
// answer via `isModelStillLive`, never this file's.
const KNOWN_STALE_DEFAULTS_WITHOUT_LIVE_CHECK = new Set(['gpt-4o'])

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
  /** Live-catalogue membership check, e.g. `(id) => liveCatalogIds.has(id)`.
   *  When supplied, this is the ONLY authority used to decide whether a
   *  saved legacy model id may be restored — the hardcoded fallback list
   *  below is skipped entirely. Pass this whenever the caller has (or can
   *  fetch) GenStudio's live model catalogue. */
  isModelStillLive?: (modelId: string) => boolean
}): string {
  const remembered = cleanModel(options.rememberedModel)
  if (remembered) return remembered

  const historical = latestGeneratedIdeaModel(options.ideas || [])
  if (historical) return historical

  const legacy = cleanModel(options.legacyProjectModel)
  if (!legacy) return ''
  if (options.isModelStillLive) return options.isModelStillLive(legacy) ? legacy : ''
  return KNOWN_STALE_DEFAULTS_WITHOUT_LIVE_CHECK.has(legacy) ? '' : legacy
}
