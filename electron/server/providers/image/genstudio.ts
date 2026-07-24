/**
 * GenStudio KH image provider.
 *
 * GenStudio owns model inventory, fleet routing, idempotent jobs, polling,
 * validation, and private artifact storage. Story Studio only supplies the
 * creative request and persists the verified PNG returned by that boundary.
 */

import { registry } from '../registry.js'
import type { ImageGenerationRequest, ImageGenerationResult, ImageProvider } from '../types.js'
import { generateImageWithGenStudio, listImageModels } from '../../lib/genstudio-client.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../../services/genstudio-model-migration.js'

async function automaticGenStudioSteps(apiKey: string, modelId: string): Promise<number> {
  const models = await listImageModels(apiKey)
  const steps = models.find(model => model.id === modelId)?.default_steps
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1) {
    throw new Error('The selected GenStudio image model is no longer available. Refresh the model picker and choose a current model.')
  }
  return steps
}

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
    const modelId = resolveGenStudioModelId('image', request.modelId)
    if (!modelId) throw new Error(unavailableLegacyModelMessage('image', request.modelId))
    // GenStudio owns every model's inference contract. Story Studio never
    // forwards a saved/manual step count: fetch the current model default so
    // old presets and Pipeline runs cannot submit an invalid value.
    const steps = await automaticGenStudioSteps(request.apiKey, modelId)
    const result = await generateImageWithGenStudio(request.apiKey, {
      prompt: request.prompt,
      modelId,
      aspectRatio: request.aspectRatio || '16:9',
      steps,
      width: request.width,
      height: request.height,
      seed: request.seed,
      requestIdentity: request.idempotencyIdentity,
      isCancelled: request.isCancelled,
      onJobAccepted: request.onJobAccepted,
      onReconnect: request.onReconnect,
    })
    return { urls: [result.url], taskId: result.jobId }
  },
}

registry.registerImage(genstudioImageProvider)
