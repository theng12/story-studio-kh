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
    const { prompt, apiKey, aspectRatio, providerParams, isCancelled } = request

    if (!apiKey) {
      throw new Error('No kie.ai API key configured. Add one in Settings → API Keys.')
    }

    // Map provider_params to the legacy ImageModelConfig shape expected by kie-client
    const modelConfig = {
      label: '',
      credits_per_image: 0,
      endpoint: providerParams.endpoint as string,
      poll: providerParams.poll as string,
      type: providerParams.type as string,
      api_model: providerParams.api_model as string,
    }

    if (isCancelled?.()) throw new Error('Cancelled by user')
    const taskId = await submitGeneration(prompt, apiKey, aspectRatio, modelConfig)
    const urls = await pollForImageUrls(taskId, apiKey, modelConfig, { isCancelled })

    return { urls, taskId }
  },
}

// Self-register
registry.registerImage(kieImageProvider)
