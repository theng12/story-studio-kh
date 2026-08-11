/** GenStudio-only image-to-video provider. */

import { registry } from '../registry.js'
import type { VideoGenerationRequest, VideoGenerationResult, VideoProvider } from '../types.js'
import {
  cheapestGenStudioVideoVariant,
  describeGenStudioVideoVariant,
  findGenStudioVideoVariant,
  generateVideoWithGenStudio,
  listVideoModels,
  supportsGenStudioVideoMode,
  type GenStudioVideoVariant,
} from '../../lib/genstudio-client.js'

const PREFIX = 'genstudio-video:'

/**
 * Choose the variant this request will be billed at, from what the model
 * PUBLISHES.
 *
 * This used to be two ternaries that coerced anything unrecognised down to
 * `5s / 720p`. That is the worst of both worlds: a caller asking for a
 * combination the model genuinely cannot do got a different clip than it
 * asked for, silently, and a caller asking for a combination the model DOES
 * publish (say 8s, or 4k) was downgraded for no reason. Now:
 *
 *   - nothing requested        → the model's cheapest published variant;
 *   - a published combination  → exactly that variant;
 *   - anything else            → a loud error naming what IS published.
 */
async function resolveRequestedVariant(
  apiKey: string,
  modelId: string,
  providerParams: Record<string, any> | undefined,
): Promise<GenStudioVideoVariant> {
  const catalog = await listVideoModels(apiKey)
  const model = catalog.find(entry => entry.id === modelId)
  if (!model || !model.available || !supportsGenStudioVideoMode(model)) {
    throw new Error(
      `GenStudio does not currently publish an available image-to-video model with id "${modelId}".`,
    )
  }
  const published = model.variants
  if (!published.length) {
    throw new Error(
      `GenStudio publishes no priced duration/resolution variant for "${model.display_name}", `
      + 'so Story Studio cannot submit a clip for it.',
    )
  }

  const requestedDuration = providerParams?.duration_seconds
  const requestedResolution = providerParams?.resolution
  const askedForDuration = requestedDuration !== undefined && requestedDuration !== null && requestedDuration !== ''
  const askedForResolution = typeof requestedResolution === 'string' && requestedResolution.trim().length > 0

  if (!askedForDuration && !askedForResolution) return cheapestGenStudioVideoVariant(published)!

  const cheapest = cheapestGenStudioVideoVariant(published)!
  const duration = askedForDuration ? Number(requestedDuration) : cheapest.duration_seconds
  const resolution = askedForResolution ? String(requestedResolution).trim() : cheapest.resolution
  const match = findGenStudioVideoVariant(published, duration, resolution)
  if (match) return match

  throw new Error(
    `"${model.display_name}" does not publish a ${duration}s at ${resolution} option. `
    + `GenStudio publishes: ${published.map(describeGenStudioVideoVariant).join(', ')}. `
    + 'Story Studio will not substitute a different length or resolution for the one requested.',
  )
}

const genstudioVideoProvider: VideoProvider = {
  meta: {
    id: 'genstudio-video',
    name: 'GenStudio KH',
    apiKeyField: 'genstudio_api_key',
    providerId: 'genstudio',
  },

  supportsModel(modelId: string, providerParams?: Record<string, any>): boolean {
    return modelId.startsWith(PREFIX) || providerParams?.provider === 'genstudio-video'
  },

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    if (request.mode !== 'frames' || !request.startImagePath) {
      throw new Error('GenStudio video generation requires an approved source image.')
    }
    const modelId = request.modelId.startsWith(PREFIX)
      ? request.modelId.slice(PREFIX.length)
      : request.modelId
    const variant = await resolveRequestedVariant(request.apiKey, modelId, request.providerParams)
    const duration = variant.duration_seconds
    const resolution = variant.resolution
    const aspectRatio = request.aspectRatio === 'portrait' ? '9:16' : '16:9'
    const results = []
    for (let index = 0; index < Math.max(1, request.numberOfVideos); index++) {
      results.push(await generateVideoWithGenStudio(request.apiKey, {
        prompt: request.prompt,
        modelId,
        sourceImagePath: request.startImagePath,
        aspectRatio,
        durationSeconds: duration,
        resolution,
        requestIdentity: `${request.idempotencyIdentity || request.startImagePath}:variant:${index + 1}`,
        isCancelled: request.isCancelled,
        onJobAccepted: (taskId, idempotencyKey) => request.onJobAccepted?.(taskId, idempotencyKey, index),
      }))
    }
    return {
      videoUrls: results.map(result => result.videoUrl),
      taskIds: results.map(result => result.jobId),
      downloadHeaders: results[0]?.downloadHeaders,
    }
  },
}

registry.registerVideo(genstudioVideoProvider)
