/** GenStudio-only image-to-video provider. */

import { registry } from '../registry.js'
import type { VideoGenerationRequest, VideoGenerationResult, VideoProvider } from '../types.js'
import { generateVideoWithGenStudio } from '../../lib/genstudio-client.js'

const PREFIX = 'genstudio-video:'

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
    const duration = request.providerParams?.duration_seconds === 10 ? 10 : 5
    const resolution = request.providerParams?.resolution === '1080p' ? '1080p' : '720p'
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
