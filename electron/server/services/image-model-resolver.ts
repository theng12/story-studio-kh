import type { ImageModelConfig, ProjectConfig } from '../models/types.js'

/**
 * Resolve configured models plus live studio-owned model ids. Dynamic models
 * intentionally are not written into project config; their source app owns
 * availability and capabilities.
 */
export function resolveImageModelConfig(
  config: Pick<ProjectConfig, 'image_models'>,
  modelId: string,
): ImageModelConfig | undefined {
  const configured = config.image_models?.[modelId]
  if (configured) return configured
  if (modelId.startsWith('imagestudio:')) {
    const repo = modelId.slice('imagestudio:'.length)
    return {
      label: repo || modelId,
      credits_per_image: 0,
      endpoint: '', poll: '', type: 'local', api_model: repo,
      provider: 'imagestudio',
      supports_reference_images: true,
      provider_params: { provider: 'imagestudio', repo },
    }
  }
  if (modelId.startsWith('genstudio-image-')) {
    return {
      label: modelId,
      credits_per_image: 0,
      endpoint: '/v1/images/generations',
      poll: '/v1/images/{id}',
      type: 'jobs',
      api_model: modelId,
      provider: 'genstudio-image',
      prompt_char_cap: 4_000,
      supports_reference_images: false,
      provider_params: { provider: 'genstudio-image', default_steps: 4 },
    }
  }
  return undefined
}
