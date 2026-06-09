/**
 * macOS built-in TTS provider — shells out to the system `say` command.
 *
 * Local, free, offline, no API key. Same shape as the voicestudio provider,
 * but simpler: there's no endpoint pool, no remote modal, no secret — it's the
 * Mac running the app. The registry-facing `generateAudio` is used by the
 * preview-voice path; the main per-chunk render in generators/audio.ts calls
 * `generateTtsToFile` from the client directly.
 *
 * See lib/macos-say-client.ts for the render details + why the Siri voices
 * aren't (and can't be) exposed.
 */

import { generateTtsToTempFile } from '../../lib/macos-say-client.js'
import { registry } from '../registry.js'
import type { AudioProvider, AudioGenerationRequest, AudioGenerationResult } from '../types.js'

const macosAudioProvider: AudioProvider = {
  meta: {
    id: 'macos',
    name: 'macOS say (Local)',
    // No real key — local synthesis. The field is required by ProviderMeta;
    // it's never resolved for this provider (the dispatch + preview paths
    // special-case 'macos' and pass no key).
    apiKeyField: 'macos_local',
    providerId: 'macos',
  },

  /**
   * Render to a temp MP3 and return its file:// URL. The preview-voice route
   * reads the file, inlines it as a data URL, and deletes it (same dance as
   * the voicestudio provider).
   */
  async generateAudio(request: AudioGenerationRequest): Promise<AudioGenerationResult> {
    const { fileUrl } = await generateTtsToTempFile({
      text: request.text,
      voiceId: request.voiceId,
      speed: request.speed,
    })
    // Caller (preview-voice) resolves the path from fileUrl, inlines it, and
    // deletes it.
    return { audioUrl: fileUrl, contentType: 'audio/mpeg' }
  },
}

registry.registerAudio(macosAudioProvider)
