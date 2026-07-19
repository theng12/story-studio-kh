import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeDiscoveredVoices,
  normalizeSavedVoice,
  normalizeSavedVoices,
  voiceSupportsProvider,
} from '../utils/voice-providers.ts'

test('frontend migrates unlabeled and Fish legacy voices consistently', () => {
  assert.deepEqual(normalizeSavedVoice({ name: 'Legacy', voice_id: 'legacy' })?.providers,
    ['elevenlabs', 'fal', 'genaipro', 'kie'])
  assert.deepEqual(normalizeSavedVoice({ name: 'Fish', voice_id: 'fish', provider: 'fishaudio' })?.providers,
    ['fishaudio'])
})

test('frontend merges provider labels for duplicate IDs', () => {
  assert.deepEqual(normalizeSavedVoices([
    { name: 'Voice', voice_id: 'id', providers: ['elevenlabs'] },
    { name: 'Duplicate', voice_id: 'id', providers: ['fal', 'fishaudio'] },
  ]), [{
    name: 'Voice',
    voice_id: 'id',
    providers: ['elevenlabs', 'fal', 'fishaudio'],
  }])
})

test('provider filter rejects a saved voice with the wrong label', () => {
  const voice = normalizeSavedVoice({ name: 'Fish', voice_id: 'fish', providers: ['fishaudio'] })!
  assert.equal(voiceSupportsProvider(voice, 'fishaudio'), true)
  assert.equal(voiceSupportsProvider(voice, 'genaipro'), false)
})

test('frontend retains the dedicated GenStudio voice label', () => {
  const voice = normalizeSavedVoice({
    name: 'Ryan', voice_id: 'voice_qwen3_ryan', providers: ['genstudio'],
  })!
  assert.equal(voiceSupportsProvider(voice, 'genstudio'), true)
  assert.equal(voiceSupportsProvider(voice, 'elevenlabs'), false)
})

test('discovered GenStudio voices merge without replacing saved names', () => {
  assert.deepEqual(mergeDiscoveredVoices([
    { name: 'My Ryan', voice_id: 'voice_qwen3_ryan', providers: ['genstudio'] },
  ], [
    { id: 'voice_qwen3_ryan', display_name: 'Ryan' },
    { id: 'voice_qwen3_aiden', display_name: 'Aiden' },
    { id: '', display_name: 'Invalid' },
  ], 'genstudio'), [
    { name: 'My Ryan', voice_id: 'voice_qwen3_ryan', providers: ['genstudio'] },
    { name: 'Aiden', voice_id: 'voice_qwen3_aiden', providers: ['genstudio'] },
  ])
})
