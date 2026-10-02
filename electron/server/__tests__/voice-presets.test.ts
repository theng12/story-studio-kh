import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  normalizeVoicePreset,
  normalizeVoicePresets,
  voiceSupportsProvider,
} from '../services/voice-presets.js'

test('legacy unlabeled voices remain available to ElevenLabs-compatible gateways', () => {
  const voice = normalizeVoicePreset({ name: 'Vincent', voice_id: 'voice-1' })
  assert.deepEqual(voice, {
    name: 'Vincent',
    voice_id: 'voice-1',
    providers: ['elevenlabs', 'fal', 'genaipro', 'kie'],
  })
})

test('legacy Fish voices migrate to Fish Audio only', () => {
  const voice = normalizeVoicePreset({ name: 'Sleep clone', voice_id: 'fish-1', provider: 'fishaudio' })
  assert.deepEqual(voice?.providers, ['fishaudio'])
})

test('Gateway standard voices preserve their dedicated provider label', () => {
  const voice = normalizeVoicePreset({
    name: 'Ryan', voice_id: 'voice_qwen3_ryan', providers: ['genstudio'],
  })
  assert.deepEqual(voice?.providers, ['genstudio'])
})

test('explicit providers are canonicalized and unknown providers are dropped', () => {
  const voice = normalizeVoicePreset({
    name: 'Narrator',
    voice_id: 'voice-2',
    providers: ['fishaudio', 'unknown', 'fal', 'fal'],
  })
  assert.deepEqual(voice?.providers, ['fal', 'fishaudio'])
})

test('duplicate voice IDs merge provider labels while preserving the first name', () => {
  const voices = normalizeVoicePresets([
    { name: 'Preferred name', voice_id: 'same-id', providers: ['fal'] },
    { name: 'Later name', voice_id: 'same-id', providers: ['fishaudio', 'kie'] },
  ])
  assert.deepEqual(voices, [{
    name: 'Preferred name',
    voice_id: 'same-id',
    providers: ['fal', 'kie', 'fishaudio'],
  }])
})

test('provider compatibility requires a matching saved label', () => {
  const voices = [{ name: 'Fish clone', voice_id: 'fish-1', providers: ['fishaudio'] }]
  assert.equal(voiceSupportsProvider(voices, 'fish-1', 'fishaudio'), true)
  assert.equal(voiceSupportsProvider(voices, 'fish-1', 'elevenlabs'), false)
  assert.equal(voiceSupportsProvider(voices, 'missing', 'fishaudio'), false)
})

test('invalid and unfinished rows are removed', () => {
  assert.deepEqual(normalizeVoicePresets([
    null,
    { name: '', voice_id: 'id' },
    { name: 'Name', voice_id: '' },
    { name: 'Valid', voice_id: 'valid-id', providers: ['elevenlabs'] },
  ]), [{ name: 'Valid', voice_id: 'valid-id', providers: ['elevenlabs'] }])
})

test('connectivity checks never call the retired ElevenLabs voice catalog', () => {
  const healthRoute = readFileSync(new URL('../routes/health.ts', import.meta.url), 'utf8')
  const voicesRoute = readFileSync(new URL('../routes/voices.ts', import.meta.url), 'utf8')
  assert.equal(healthRoute.includes('api.elevenlabs.io/v1/voices'), false)
  assert.equal(voicesRoute.includes('api.elevenlabs.io/v1/voices'), false)
})
