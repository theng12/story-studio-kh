import type { ImageModelConfig, ProjectConfig } from '../models/types.js'
import { resolveGenStudioModelId } from './genstudio-model-migration.js'

/**
 * Resolve configured models plus live studio-owned model ids. Dynamic models
 * intentionally are not written into project config; their source app owns
 * availability and capabilities.
 */
export function resolveImageModelConfig(
  config: Pick<ProjectConfig, 'image_models'>,
  modelId: string,
): ImageModelConfig | undefined {
  const resolvedModelId = resolveGenStudioModelId('image', modelId)
  if (resolvedModelId) {
    return {
      label: config.image_models?.[modelId]?.label || resolvedModelId,
      credits_per_image: 0,
      endpoint: '/v1/images/generations',
      poll: '/v1/images/{id}',
      type: 'jobs',
      api_model: resolvedModelId,
      provider: 'genstudio-image',
      prompt_char_cap: 4_000,
      supports_reference_images: false,
      provider_params: { provider: 'genstudio-image', default_steps: 4 },
    }
  }
  return undefined
}
