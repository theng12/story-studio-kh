import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  mergeDiscoveredVoices,
  normalizeSavedVoice,
  normalizeSavedVoices,
  voiceSupportsProvider,
} from '../utils/voice-providers.ts'

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

test('Story Studio holds no local TTS product list — the model catalogue is the selector', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  // The picker's options are built from the live /v1/tts/models rows.
  assert.match(audioPage, /ttsModels\.value\.map\(/)
  assert.match(audioPage, /loadTtsModels\(\)/)
  // No Story-owned tier vocabulary survives anywhere on the page.
  assert.doesNotMatch(audioPage, /genstudio-tts-regular|genstudio-tts-premium|genstudio-tts-clone/)
  assert.doesNotMatch(audioPage, /genstudio-tts-tiers|GENSTUDIO_TTS_TIER_OPTIONS/)
})

test('Audio generation receives the live GenStudio voice catalog from VoicePicker', () => {
  const picker = readFileSync(new URL('../components/VoicePicker.vue', import.meta.url), 'utf8')
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(picker, /'catalog-updated': \[voices: GenStudioVoice\[\]\]/)
  assert.match(picker, /await loadVoices\(/)
  assert.match(audioPage, /@catalog-updated="onVoiceCatalogUpdated"/)
  assert.doesNotMatch(audioPage, /Qwen3 Standard Voices/)
})

test('the voice picker shows the published provider identity and GenStudio-owned saved state', () => {
  const picker = readFileSync(new URL('../components/VoicePicker.vue', import.meta.url), 'utf8')
  // Provider transparency: the published identity is rendered, not stripped.
  assert.match(picker, /voice\.provider, voice\.engine_name/)
  // Saved state belongs to GenStudio; there is no local favourites list.
  assert.match(picker, /setSaved\(voice\.id, voice\.is_saved !== true\)/)
  assert.doesNotMatch(picker, /voices\/favourites/)
  // Published gates are respected rather than reimplemented.
  assert.match(picker, /voiceIsGenerable/)
})

test('Audio Generator shows the boundary it enforces, read from the selected model', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(audioPage, /selectedTtsModel\.value\?\.maximum_input_characters/)
  assert.match(audioPage, /Request boundary/)
  assert.match(audioPage, /not a project setting/)
  // No copy of the retired 15,000-character constant survives.
  assert.doesNotMatch(audioPage, /15,000 characters|15_000/)
  assert.doesNotMatch(audioPage, /Configure in Settings/)
  assert.doesNotMatch(audioPage, /settings#audio-models/)
})

test('cost is the model rate before there is text, and a GenStudio quote after', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(audioPage, /describeVoiceRate\(selectedTtsModel\.value\)/)
  assert.match(audioPage, /describeQuotedCost\(quote\.value\.credits/)
  assert.match(audioPage, /requestTtsQuote\(\{/)
  // A quote belongs to one exact request; any change to it voids the quote.
  assert.match(audioPage, /quote\.value = null/)
  assert.match(audioPage, /chargeable/)
})

test('speed is offered only when the selected model publishes supports_speed', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(audioPage, /selectedTtsModel\.value\?\.supports_speed === true/)
  assert.match(audioPage, /v-if="supportsSpeed"/)
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

  // Speech diagnostics read the same /v1/tts/models catalogue the picker uses.
  assert.match(mediaModels, /\/app-settings\/genstudio\/tts-models/)
  assert.match(mediaModels, /\/app-settings\/genstudio\/video-models/)
  assert.match(mediaModels, /Promise\.allSettled/)
  assert.match(imageModels, /\/app-settings\/genstudio\/image-models/)
  assert.match(modelSelector, /get<LlmModelRow\[]>\(`\/models\?project=\$\{props\.projectSlug\}`\)/)
  assert.match(motionReview, /genstudio-video:\$\{model\.id\}/)
  assert.match(motionReview, /Image-to-video generation through GenStudio KH/)
  assert.doesNotMatch(motionReview, /local fleet|cloud fleet|execution_label/i)
  assert.doesNotMatch(motionReview, /Unavailable saved selection|migration required|Historical/)
  assert.match(providerGroups, /category: 'mix'/)
  assert.match(providerGroups, /sole catalog, job, and credit boundary/i)
  assert.doesNotMatch(providerGroups, /openai|anthropic|kie|fal|elevenlabs|studio hub/i)
})
