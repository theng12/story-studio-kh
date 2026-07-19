import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_AUDIO_MODELS, DEFAULT_VOICE_PRESETS } from '../models/defaults.js'
import { normalizeVoicePresets, voiceSupportsProvider } from '../services/voice-presets.js'

test('GenStudio standard voices are an explicit, bounded TTS route', () => {
  assert.deepEqual(DEFAULT_AUDIO_MODELS['genstudio-qwen3-standard'], {
    label: 'Qwen3 Standard Voices [GenStudio KH · staging]',
    cost_per_1k_chars: 0,
    provider: 'genstudio',
    tts_soft_max_chars: 375,
  })
  const voices = normalizeVoicePresets(DEFAULT_VOICE_PRESETS)
  assert.equal(voiceSupportsProvider(voices, 'voice_qwen3_ryan', 'genstudio'), true)
  assert.equal(voiceSupportsProvider(voices, 'voice_qwen3_aiden', 'genstudio'), true)
})

test('GenStudio client cannot bypass its API boundary to contact Studio Hub', () => {
  const source = readFileSync(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8')
  assert.equal(source.includes('studiohub-client'), false)
  assert.equal(source.includes('getHubBackend'), false)
  assert.equal(source.includes('hubSubmitJob'), false)
  assert.match(source, /No direct Studio Hub fallback was attempted/)
})
