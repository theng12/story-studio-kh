/**
 * GenAIPro audio provider — ElevenLabs TTS via GenAIPro gateway.
 * Self-registers with the provider registry on import.
 */

import { generateTts } from '../../lib/genaipro-client.js'
import { registry } from '../registry.js'
import type { AudioProvider, AudioGenerationRequest, AudioGenerationResult } from '../types.js'

const genaiproAudioProvider: AudioProvider = {
  meta: {
    id: 'genaipro',
    name: 'GenAIPro (ElevenLabs)',
    apiKeyField: 'genaipro_api_key',
  },

  async generateAudio(request: AudioGenerationRequest): Promise<AudioGenerationResult> {
    const { text, apiKey, modelId, voiceId, speed, stability, similarity, isCancelled } = request

    if (!apiKey) {
      throw new Error('No GenAIPro API key configured. Add one in Settings → API Keys.')
    }

    const audioUrl = await generateTts(text, apiKey, {
      model: modelId,
      voiceId,
      speed,
      stability,
      similarity,
      isCancelled,
    })

    return { audioUrl }
  },
}

registry.registerAudio(genaiproAudioProvider)
