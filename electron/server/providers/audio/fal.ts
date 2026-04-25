/**
 * fal.ai audio provider — wraps the existing fal-client.ts logic for ElevenLabs TTS.
 * Self-registers with the provider registry on import.
 */

import { generateTts } from '../../lib/fal-client.js'
import { registry } from '../registry.js'
import type { AudioProvider, AudioGenerationRequest, AudioGenerationResult } from '../types.js'

const falAudioProvider: AudioProvider = {
  meta: {
    id: 'fal',
    name: 'fal.ai (ElevenLabs)',
    apiKeyField: 'fal_api_key',
  },

  async generateAudio(request: AudioGenerationRequest): Promise<AudioGenerationResult> {
    const { text, apiKey, modelId, voiceId, speed, stability, similarity, isCancelled } = request

    if (!apiKey) {
      throw new Error('No fal.ai API key configured. Add one in Settings → API Keys.')
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

// Self-register
registry.registerAudio(falAudioProvider)
