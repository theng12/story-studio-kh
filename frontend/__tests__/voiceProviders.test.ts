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

test('the boundary shown is the one planning enforces, with the published one beside it', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  // The enforced figure is the backend's planning budget, so that is what the
  // reading is; the published figure is stated next to it so the gap is
  // explicable rather than looking like a bug (AGENTS.md: show what you enforce).
  assert.match(audioPage, /planned_request_characters \?\? resolvedChunkCap\.value/)
  assert.match(audioPage, /\{\{ plannedRequestCap\.toLocaleString\(\) \}\} chars/)
  assert.match(audioPage, /publishes[\s\S]{0,120}Story Studio plans at/)
  assert.match(audioPage, /head-room/)
  // The margin itself is never written here — the page only renders the two
  // figures the backend sent and the percentage between them.
  assert.doesNotMatch(audioPage, /0\.9\s*\*|\*\s*0\.9|SAFETY_MARGIN\s*=/)
})

test('cost is the model rate before there is text, and a sum of GenStudio quotes after', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(audioPage, /describeVoiceRate\(selectedTtsModel\.value\)/)
  // A narration is submitted as N jobs, so it is quoted as N quotes and the
  // total is labelled as their sum — not as an estimate, and not as one quote.
  assert.match(audioPage, /describeQuotedTotal\(quotedParts\.value/)
  assert.doesNotMatch(audioPage, /describeImageBatchEstimate|basis: 'estimate'/)
  // The quote is asked for per episode, so the backend can split it exactly
  // where generation splits it. The page never joins the script itself.
  assert.match(audioPage, /quoteNarration\(slug\.value, form\.episode_id/)
  assert.doesNotMatch(audioPage, /\.join\('\\n\\n'\)/)
  // Every part is shown, because each one is a separately billed job.
  assert.match(audioPage, /v-for="\(part, index\) in quotedParts"/)
  assert.match(audioPage, /part\.part_count > 1/)
  assert.match(audioPage, /part\.billable_characters/)
  // A quote belongs to one exact request set; any change voids the WHOLE quote.
  assert.match(audioPage, /narrationQuote\.value = null/)
  assert.match(audioPage, /chargeable/)
  // The quote-endpoint mismatch is surfaced, not papered over, and the model's
  // published rate still stands. No endpoint limit is written into the page.
  assert.match(audioPage, /generation_unit_rejected/)
  assert.match(audioPage, /not sub-split to force a quote/)
  assert.doesNotMatch(audioPage, /40[_,]?000/)
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

test('the cloned view asks GenStudio for the collection instead of guessing which voices are clones', () => {
  const picker = readFileSync(new URL('../components/VoicePicker.vue', import.meta.url), 'utf8')
  const composable = readFileSync(new URL('../composables/useGenStudioVoices.ts', import.meta.url), 'utf8')

  // The collection is GenStudio's vocabulary, forwarded verbatim to the server.
  assert.match(composable, /query\.set\('collection', collection\.trim\(\)\)/)
  assert.match(picker, /voiceFilter\.value === 'cloned' \? 'cloned' : ''/)

  // Crossing the cloned boundary refetches; all <-> saved must not.
  assert.match(picker, /watch\(voiceFilter/)
  assert.match(picker, /\(next === 'cloned'\) === \(previous === 'cloned'\)/)

  // `saved` reads a field GenStudio publishes per voice — no round trip needed.
  assert.match(picker, /voiceFilter\.value === 'saved'[\s\S]{0,120}voice\.is_saved === true/)

  // Clone-ness is never reconstructed locally. Assert on READS of the field
  // rather than the bare token, so the comment explaining this rule does not
  // trip the guard that enforces it.
  assert.doesNotMatch(picker, /\.custom_voice_id/)
  assert.doesNotMatch(picker, /custom_voice_id\s*[!=]==?/)
  assert.doesNotMatch(picker, /\.public_voice_id[\s\S]{0,40}clone/i)

  // An empty clone list is normal, and must say where cloning actually happens
  // rather than reading as a failure to load.
  assert.match(picker, /Voices are cloned in GenStudio KH/)

  // explore/my are published but undocumented to us — surfacing a label we
  // invented for someone else's vocabulary is what this asserts against.
  assert.doesNotMatch(picker, /id: 'explore'|id: 'my'/)
})
