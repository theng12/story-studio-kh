import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { voiceSourceText } from '../composables/useGenStudioVoices'

// Dreamlands E2E: "Chris" showed "Studio Hub (this Mac) · Qwen3 TTS" while Breeze was selected.
test('a Gateway-library voice is shown as such, with no engine named', () => {
  // As an older Gateway publishes it
  assert.equal(voiceSourceText({ id: 'studio-hub-local::voice-cd07b21a2ccf', provider: 'Studio Hub (this Mac)', engine_name: 'Qwen3 TTS', voice_tier: 'custom' }), 'Gateway voice library')
  // As the current Gateway publishes it
  assert.equal(voiceSourceText({ id: 'studio-hub-local::voice-x', provider: 'Gateway voice library', engine_name: '', voice_tier: 'custom' }), 'Gateway voice library')
})

test('any other voice keeps its published provider and engine', () => {
  assert.equal(voiceSourceText({ id: 'fal-elevenlabs::rachel', provider: 'fal', engine_name: 'ElevenLabs (via fal)', voice_tier: 'library' }), 'fal · ElevenLabs (via fal)')
  assert.equal(voiceSourceText({ id: 'x::y', provider: 'Same', engine_name: 'Same' }), 'Same')
})

test('the picker and the Audio page both use it', () => {
  for (const file of ['../components/VoicePicker.vue', '../pages/projects/[slug]/audio.vue']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /voiceSourceText\(voice\)/, file)
  }
})
