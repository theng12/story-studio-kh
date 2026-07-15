import type { ImageModelConfig } from './types.js'

/**
 * Build the provider request shape once for previews and full generation.
 * Tier overrides are merged after the model defaults, including a nested
 * `input_params` merge so a tier can change quality without dropping other
 * model-level inputs such as output format or safety checking.
 */
export function resolveImageProviderParams(
  config: ImageModelConfig,
  requestedTier?: string,
): Record<string, any> {
  const base: Record<string, any> = config.provider_params
    ? { ...config.provider_params }
    : {
        endpoint: config.endpoint,
        poll: config.poll,
        type: config.type,
        api_model: config.api_model,
        api_model_i2i: config.api_model_i2i,
        refs_field: config.refs_field,
        refs_upload: config.refs_upload === true,
        aspect_field: config.aspect_field,
        input_params: config.input_params,
        supports_reference_images: config.supports_reference_images === true,
      }

  const tiers = Array.isArray(config.tiers) ? config.tiers : []
  const tier = tiers.find(item => item.id === requestedTier)
    ?? tiers.find(item => item.id === config.default_tier)
  const overrides = tier?.provider_params
  if (!overrides) return base

  const merged = { ...base, ...overrides }
  if (base.input_params || overrides.input_params) {
    merged.input_params = {
      ...(base.input_params || {}),
      ...((overrides.input_params as Record<string, unknown> | undefined) || {}),
    }
  }
  return merged
}
