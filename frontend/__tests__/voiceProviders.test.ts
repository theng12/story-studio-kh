import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Story Studio holds no local TTS product list — the model catalogue is the selector', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  // The picker's options are built from the live /v1/tts/models rows.
  assert.match(audioPage, /ttsModels\.value\.map\(/)
  assert.match(audioPage, /loadTtsModels\(\)/)
  // No Story-owned tier vocabulary survives anywhere on the page.
  assert.doesNotMatch(audioPage, /genstudio-tts-regular|genstudio-tts-premium|genstudio-tts-clone/)
  assert.doesNotMatch(audioPage, /genstudio-tts-tiers|GENSTUDIO_TTS_TIER_OPTIONS/)
  assert.match(audioPage, /model\.supported_languages/)
  assert.doesNotMatch(audioPage, /genstudio-multilingual-v3|Khmer/i)
})

test('Audio generation receives the live Gateway voice catalog from VoicePicker', () => {
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
  assert.match(picker, /voiceSourceText\(voice\)/)
  // Saved state belongs to GenStudio; there is no local favourites list.
  assert.match(picker, /setSaved\(voice\.id, voice\.is_saved !== true\)/)
  assert.doesNotMatch(picker, /voices\/favourites/)
  // Published gates are respected rather than reimplemented.
  assert.match(picker, /voiceIsGenerable/)
})

test('TTS pricing comes from the selected model and final quote, never a voice row', () => {
  const picker = readFileSync(new URL('../components/VoicePicker.vue', import.meta.url), 'utf8')
  const row = readFileSync(new URL('../components/VoicePickerRow.vue', import.meta.url), 'utf8')
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')

  // /v1/voices is a compatibility/selection catalogue, not a pricing authority.
  assert.doesNotMatch(picker, /credits_per_1000_characters/)
  assert.doesNotMatch(picker, /modelCreditsPer1000Characters/)
  assert.doesNotMatch(row, /rateText/)
  assert.doesNotMatch(audioPage, /voiceRateDiffers/)
  assert.doesNotMatch(audioPage, /selectedVoice\.credits_per_1000_characters/)
  assert.doesNotMatch(audioPage, /different from the model's rate/)

  // The selected /v1/tts/models row remains the pre-quote price source.
  assert.match(audioPage, /describeVoiceRate\(selectedTtsModel\.value\)/)
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

test('the quote renders an unpublished character ceiling instead of crashing on it', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  // Break caught: `maximum_input_characters` is nullable on the wire, and the
  // page called `.toLocaleString()` on it unconditionally. A published `null`
  // therefore crashed the narration page rather than degrading it — which is
  // exactly why gateway-kh kept publishing an invented 40,000 instead of null.
  // The renderer handling absence is what lets the gateway stop inventing one.
  assert.match(audioPage, /narrationQuote\.maximum_input_characters != null/)
  assert.match(audioPage, /did not report a per-request character ceiling/)
  // `??` and not `||`: a planning boundary of 0 is a real value, and only an
  // actually-absent one may fall back to the published maximum.
  assert.match(audioPage, /planned_request_characters \?\? narrationQuote\.maximum_input_characters/)
})

test('cost is the model rate before there is text, and a sum of the Gateway quotes after', () => {
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
  assert.match(audioPage, /model\?\.supports_speed !== true/)
  assert.match(audioPage, /v-if="supportsSpeed"/)
})

test('speed bounds come from the selected Gateway model catalogue row', () => {
  const audioPage = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(audioPage, /publishedSpeedBounds\?\.minimum/)
  assert.match(audioPage, /publishedSpeedBounds\?\.maximum/)
  assert.match(audioPage, /Published range/)
  assert.doesNotMatch(audioPage, /:min="0\.5"/)
  assert.doesNotMatch(audioPage, /:max="2"/)
})

test('all Story Studio transcription UI uses the Gateway model catalog only', () => {
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

test('Gateway catalogs stay provider-owned across voice, image, LLM, and video selectors', () => {
  const mediaModels = readFileSync(new URL('../composables/useGenStudioMediaModels.ts', import.meta.url), 'utf8')
  const imageModels = readFileSync(new URL('../composables/useGenStudioImageModels.ts', import.meta.url), 'utf8')
  const modelSelector = readFileSync(new URL('../components/ModelSelector.vue', import.meta.url), 'utf8')
  const motionReview = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')

  // Speech diagnostics read the same /v1/tts/models catalogue the picker uses.
  assert.match(mediaModels, /\/app-settings\/genstudio\/tts-models/)
  assert.match(mediaModels, /\/app-settings\/genstudio\/video-models/)
  assert.match(mediaModels, /Promise\.allSettled/)
  assert.match(imageModels, /\/app-settings\/genstudio\/image-models/)
  assert.match(modelSelector, /get<LlmModelRow\[]>\(`\/models\?project=\$\{props\.projectSlug\}`\)/)
  assert.match(motionReview, /genstudio-video:\$\{model\.id\}/)
  // The controls describe what the CLIP will be. Resolution and manual timing
  // are separate, but both still come only from the selected model's current
  // priced image-to-video rows; the page never copies a duration/provider list.
  assert.match(motionReview, /aria-label="Resolution"/)
  assert.match(motionReview, /aria-label="Manual clip length slider"/)
  assert.match(motionReview, /variantsForVideoOperation\(selectedVideoModel\.value\?\.variants, STORY_STUDIO_VIDEO_OPERATION\)/)
  assert.match(motionReview, /variant\.credits_per_video/)
  assert.doesNotMatch(motionReview, /capability\.durations|provider.*duration/i)
  assert.doesNotMatch(motionReview, /the cheapest option the Gateway publishes for this model/)
  assert.doesNotMatch(motionReview, /Image-to-video generation through (GenStudio|the Gateway)/i)
  assert.doesNotMatch(motionReview, /local fleet|cloud fleet|execution_label/i)
  assert.doesNotMatch(motionReview, /Unavailable saved selection|migration required|Historical/)
})

test('the cloned view asks the Gateway for the collection instead of guessing which voices are clones', () => {
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
  assert.match(picker, /Voices are cloned in the Gateway/)

  // explore/my are published but undocumented to us — surfacing a label we
  // invented for someone else's vocabulary is what this asserts against.
  assert.doesNotMatch(picker, /id: 'explore'|id: 'my'/)
})
