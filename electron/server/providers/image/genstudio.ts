/**
 * GenStudio KH image provider.
 *
 * GenStudio owns model inventory, fleet routing, idempotent jobs, polling,
 * validation, and private artifact storage. Story Studio only supplies the
 * creative request and persists the verified PNG returned by that boundary.
 */

import { registry } from '../registry.js'
import type { ImageGenerationRequest, ImageGenerationResult, ImageProvider } from '../types.js'
import { generateImageWithGenStudio } from '../../lib/genstudio-client.js'

const genstudioImageProvider: ImageProvider = {
  meta: {
    id: 'genstudio-image',
    name: 'GenStudio KH',
    apiKeyField: 'genstudio_api_key',
    providerId: 'genstudio',
  },

  supportsModel(modelId: string, providerParams: Record<string, any>): boolean {
    return providerParams?.provider === 'genstudio-image' || modelId.startsWith('genstudio-image-')
  },

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (request.referenceImagePaths?.length) {
      throw new Error('This GenStudio KH image model currently supports Prompt only. Switch Image Mode to Prompt only and retry.')
    }
    const defaultSteps = Number(request.providerParams?.default_steps) || 4
    const result = await generateImageWithGenStudio(request.apiKey, {
      prompt: request.prompt,
      modelId: request.modelId,
      aspectRatio: request.aspectRatio || '16:9',
      steps: Number.isInteger(request.steps) ? request.steps! : defaultSteps,
      seed: request.seed,
      requestIdentity: request.idempotencyIdentity,
      isCancelled: request.isCancelled,
      onJobAccepted: request.onJobAccepted,
    })
    return { urls: [result.url], taskId: result.jobId }
  },
}

registry.registerImage(genstudioImageProvider)
