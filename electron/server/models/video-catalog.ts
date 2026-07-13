import type { VideoModelConfig } from './types.js'

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
