/**
 * GenAIPro Veo V2 video provider.
 * Supports text-to-video and frames-to-video (image-to-video).
 * Self-registers with the provider registry on import.
 */

import { textToVideo, framesToVideo, ingredientsToVideo } from '../../lib/genaipro-veo-client.js'
import { registry } from '../registry.js'
import type { VideoProvider, VideoGenerationRequest, VideoGenerationResult } from '../types.js'

const veoProvider: VideoProvider = {
  meta: {
    id: 'genaipro-veo',
    name: 'GenAIPro Veo',
    apiKeyField: 'genaipro_api_key',
  },

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('veo-') || modelId.startsWith('genaipro-veo')
  },

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const { mode, prompt, apiKey, aspectRatio, numberOfVideos, startImagePath, endImagePath, referenceImagePaths, isCancelled } = request
    if (!apiKey) throw new Error('No GenAIPro API key configured. Add one in Settings → API Keys.')

    if (mode === 'text') {
      const r = await textToVideo({ apiKey, prompt, aspectRatio, numberOfVideos, isCancelled })
      return { videoUrls: r.urls, taskIds: r.taskIds }
    }
    if (mode === 'frames') {
      if (!startImagePath) throw new Error('Image-to-video requires a start image.')
      const r = await framesToVideo({ apiKey, prompt, aspectRatio, numberOfVideos, startImagePath, endImagePath, isCancelled })
      return { videoUrls: r.urls, taskIds: r.taskIds }
    }
    if (mode === 'ingredients') {
      if (!referenceImagePaths?.length) throw new Error('Ingredients mode requires 1-3 reference images.')
      const r = await ingredientsToVideo({ apiKey, prompt, aspectRatio, numberOfVideos, referenceImagePaths, isCancelled })
      return { videoUrls: r.urls, taskIds: r.taskIds }
    }
    throw new Error(`Unsupported video mode: ${mode}`)
  },
}

registry.registerVideo(veoProvider)
