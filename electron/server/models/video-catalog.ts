import type { UnifiedModel, VideoModelConfig } from './types.js'

const RETIRED_MODEL_PATTERN = /(?:sora[-_ ]?2|runway[^a-z0-9]*gen[-_ ]?3|kie-runway-(?:720p|1080p))/i

/** Keep the Story Studio compatibility catalog strictly image-to-video. */
export function sanitizeVideoCatalog(
  catalog: Record<string, VideoModelConfig> | null | undefined,
): Record<string, VideoModelConfig> {
  const clean: Record<string, VideoModelConfig> = {}
  for (const [id, model] of Object.entries(catalog || {})) {
    if (!model || !Array.isArray(model.modes) || !model.modes.includes('frames')) continue
    const searchable = `${id} ${model.label || ''} ${JSON.stringify((model as any).provider_params || {})}`
    if (RETIRED_MODEL_PATTERN.test(searchable)) continue
    clean[id] = { ...model, modes: ['frames'] }
  }
  return clean
}

/** Remove retired/non-I2V video entries from the unified custom-model list. */
export function sanitizeUnifiedVideoModels(models: UnifiedModel[]): UnifiedModel[] {
  const clean: UnifiedModel[] = []
  for (const model of models) {
    if (model.type !== 'video') {
      clean.push(model)
      continue
    }
    const entry = sanitizeVideoCatalog({
      [model.id]: {
        label: model.label,
        provider: model.provider,
        ...(model.is_custom ? { is_custom: true } : {}),
        ...(model.params || {}),
      } as VideoModelConfig,
    })[model.id]
    if (!entry) continue
    const { label, provider, is_custom, ...params } = entry as VideoModelConfig & { is_custom?: boolean }
    clean.push({
      ...model,
      label,
      provider,
      ...(is_custom ? { is_custom: true } : {}),
      params,
    })
  }
  return clean
}
