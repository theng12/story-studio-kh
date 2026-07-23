import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  mergeDiscoveredVoices,
  normalizeSavedVoice,
  normalizeSavedVoices,
  voiceSupportsProvider,
} from '../utils/voice-providers.ts'
import {
  GENSTUDIO_TTS_TIER_OPTIONS,
  genStudioTtsTierForModel,
  normalizeStoryTtsTierModel,
} from '../utils/genstudio-tts-tiers.ts'

test('frontend preserves legacy voice evidence without granting a removed provider route', () => {
  assert.deepEqual(normalizeSavedVoice({ name: 'Legacy', voice_id: 'legacy' })?.providers,
    [])
  assert.deepEqual(normalizeSavedVoice({ name: 'Fish', voice_id: 'fish', provider: 'fishaudio' })?.providers,
    [])
})

test('frontend strips removed provider labels from duplicate historical IDs', () => {
  assert.deepEqual(normalizeSavedVoices([
    { name: 'Voice', voice_id: 'id', providers: ['elevenlabs'] },
    { name: 'Duplicate', voice_id: 'id', providers: ['fal', 'fishaudio'] },
  ]), [{
    name: 'Voice',
    voice_id: 'id',
    providers: [],
  }])
})

test('provider filter rejects historical voices with no GenStudio mapping', () => {
  const voice = normalizeSavedVoice({ name: 'Fish', voice_id: 'fish', providers: ['fishaudio'] })!
  assert.equal(voiceSupportsProvider(voice, 'fishaudio'), false)
  assert.equal(voiceSupportsProvider(voice, 'genstudio'), false)
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

test('discovered GenStudio voices preserve tier and stored-preview metadata', () => {
  assert.deepEqual(mergeDiscoveredVoices([], [{
    id: 'voice-premium',
    display_name: 'Premium narrator',
    voice_tier: 'premium',
    preview_available: true,
    preview_url: '/v1/voices/voice-premium/preview',
    preview_text: 'A stored sample.',
  }], 'genstudio'), [{
    name: 'Premium narrator',
    voice_id: 'voice-premium',
    providers: ['genstudio'],
    voice_tier: 'premium',
    preview_available: true,
    preview_url: '/v1/voices/voice-premium/preview',
    preview_text: 'A stored sample.',
  }])
})

test('Story Studio exposes only Regular, Premium, and Clone TTS product tiers', () => {
  assert.deepEqual(
    GENSTUDIO_TTS_TIER_OPTIONS.map(option => [option.id, option.label]),
    [
      ['genstudio-tts-regular', 'GenStudio TTS Regular'],
      ['genstudio-tts-premium', 'GenStudio TTS Premium'],
      ['genstudio-tts-clone', 'GenStudio TTS Clone'],
    ],
  )
  assert.equal(genStudioTtsTierForModel('genstudio-tts-premium'), 'premium')
  assert.equal(normalizeStoryTtsTierModel('genstudio-qwen3-standard'), 'genstudio-tts-premium')
  assert.equal(normalizeStoryTtsTierModel('turbo-v2.5'), 'genstudio-tts-regular')
})

test('Audio generation receives the live GenStudio catalog from VoicePicker', () => {
  const picker = readFileSync(new URL('../components/VoicePicker.vue', import.meta.url), 'utf8')
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(picker, /'catalog-updated': \[voices: SavedVoice\[\]\]/)
  assert.match(picker, /emit\('catalog-updated', mergeDiscoveredVoices/)
  assert.match(audioPage, /@catalog-updated="onVoiceCatalogUpdated"/)
  assert.match(audioPage, /\.\.\.discoveredProviderVoices\.value/)
  assert.match(audioPage, /genStudioTtsModelForTier\(selected\.voice_tier\)/)
  assert.doesNotMatch(audioPage, /Qwen3 Standard Voices/)
})

test('Audio Generator shows the GenStudio 15,000-character request boundary', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(audioPage, /Each request supports up to <strong>15,000 characters<\/strong>/)
  assert.match(audioPage, /GenStudio request boundary/)
  assert.doesNotMatch(audioPage, /GenStudio[^\n]{0,120}30[- ]?second/i)
})

test('all Story Studio transcription UI uses the GenStudio model catalog only', () => {
  const subtitles = readFileSync(
    new URL('../pages/projects/[slug]/subtitles.vue', import.meta.url),
    'utf8',
  )
  const broll = readFileSync(
    new URL('../pages/projects/[slug]/broll.vue', import.meta.url),
    'utf8',
  )
  for (const source of [subtitles, broll]) {
    assert.match(source, /useGenStudioTranscriptionModels/)
    assert.match(source, /engine: 'genstudio'/)
    assert.doesNotMatch(source, /OpenAI Whisper/)
    assert.doesNotMatch(source, /voicestudio\/transcribe-availability/)
    assert.doesNotMatch(source, /voicestudio\/download-model/)
  }
})

test('GenStudio catalogs stay provider-owned across voice, image, LLM, and video selectors', () => {
  const mediaModels = readFileSync(new URL('../composables/useGenStudioMediaModels.ts', import.meta.url), 'utf8')
  const imageModels = readFileSync(new URL('../composables/useGenStudioImageModels.ts', import.meta.url), 'utf8')
  const modelSelector = readFileSync(new URL('../components/ModelSelector.vue', import.meta.url), 'utf8')
  const motionReview = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')
  const providerGroups = readFileSync(new URL('../utils/api-provider-groups.ts', import.meta.url), 'utf8')

  assert.match(mediaModels, /\/app-settings\/genstudio\/voice-models/)
  assert.match(mediaModels, /\/app-settings\/genstudio\/video-models/)
  assert.match(mediaModels, /Promise\.allSettled/)
  assert.match(imageModels, /\/app-settings\/genstudio\/image-models/)
  assert.match(modelSelector, /get<LlmModelRow\[]>\(`\/models\?project=\$\{props\.projectSlug\}`\)/)
  assert.match(motionReview, /genstudio-video:\$\{model\.id\}/)
  assert.match(motionReview, /GenStudio owns reservation and settlement/)
  assert.match(motionReview, /no legacy provider fallback will run/)
  assert.match(providerGroups, /category: 'mix'/)
  assert.match(providerGroups, /sole catalog, job, and credit boundary/i)
  assert.doesNotMatch(providerGroups, /openai|anthropic|kie|fal|elevenlabs|studio hub/i)
})
