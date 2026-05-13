/**
 * kie.ai image provider — wraps the existing kie-client.ts logic.
 * Supports all kie.ai payload formats: jobs, flux, 4o, gpt-image.
 * Self-registers with the provider registry on import.
 */

import { submitGeneration, pollForImageUrls } from '../../lib/kie-client.js'
import { registry } from '../registry.js'
import type { ImageProvider, ImageGenerationRequest, ImageGenerationResult } from '../types.js'

const kieImageProvider: ImageProvider = {
  meta: {
    id: 'kie',
    name: 'kie.ai',
    apiKeyField: 'kie_api_key',
  },

  supportsModel(_modelId: string, providerParams: Record<string, any>): boolean {
    // Any model with kie-style params (endpoint + poll) is supported
    return !!providerParams?.endpoint
  },

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const { prompt, apiKey, aspectRatio, providerParams, isCancelled, referenceImagePaths } = request

    if (!apiKey) {
      throw new Error('No kie.ai API key configured. Add one in Settings → API Keys.')
    }

    // Map provider_params to the legacy ImageModelConfig shape expected by
    // kie-client. New in v1.0.88: also forward api_model_i2i + refs_field +
    // aspect_field so models that split text-to-image and image-to-image
    // into different slugs (GPT Image 2, original Nano Banana) auto-swap
    // correctly when reference images are attached. Without these, every
    // call hit the t2i slug regardless of whether refs were present.
    const modelConfig = {
      label: '',
      credits_per_image: 0,
      endpoint: providerParams.endpoint as string,
      poll: providerParams.poll as string,
      type: providerParams.type as string,
      api_model: providerParams.api_model as string,
      api_model_i2i: providerParams.api_model_i2i as string | undefined,
      refs_field: providerParams.refs_field as string | undefined,
      aspect_field: providerParams.aspect_field as string | undefined,
      supports_reference_images: providerParams.supports_reference_images === true,
    } as any

    // Phase 8: only forward reference images when the model declares
    // support via providerParams.supports_reference_images. Models that
    // don't (most text-to-image models) get the prompt-only path so we
    // don't waste payload bytes on a field they'd ignore — and so the
    // user sees clearly which models actually consume references.
    const supportsReferences = providerParams?.supports_reference_images === true
    const refsToSend = supportsReferences && referenceImagePaths?.length
      ? referenceImagePaths
      : undefined

    if (isCancelled?.()) throw new Error('Cancelled by user')
    const taskId = await submitGeneration(prompt, apiKey, aspectRatio, modelConfig, {
      referenceImagePaths: refsToSend,
    })
    const urls = await pollForImageUrls(taskId, apiKey, modelConfig, { isCancelled })

    return { urls, taskId }
  },
}

// Self-register
registry.registerImage(kieImageProvider)
