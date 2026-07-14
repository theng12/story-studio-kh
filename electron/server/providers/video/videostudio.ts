import { generateViaVideoStudio } from '../../lib/videostudio-client.js'
import { registry } from '../registry.js'
import type { VideoProvider } from '../types.js'

const provider: VideoProvider = {
  meta: {
    id: 'videostudio',
    name: 'Video Studio KH',
    apiKeyField: 'videostudio_local',
    requiresApiKey: false,
  },
  supportsModel(modelId: string): boolean {
    return modelId.startsWith('videostudio:')
  },
  generateVideo: generateViaVideoStudio,
}

registry.registerVideo(provider)
