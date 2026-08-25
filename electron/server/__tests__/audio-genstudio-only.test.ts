import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { UpdateConfigSchema } from '../contracts/index.js'
import { isTerminalGenStudioTaskFailure, resolveAudioProvider } from '../generators/audio.js'
import { genStudioOnlyAudioModels } from '../services/project-manager.js'

test('arbitrary project audio_models cannot select a direct TTS provider', () => {
  const malicious = {
    'genstudio-standard-v1': {
      label: 'Forged route',
      provider: 'elevenlabs' as const,
    },
  }
  assert.equal(resolveAudioProvider('genstudio-standard-v1', malicious), 'genstudio')
  assert.equal(resolveAudioProvider('fishaudio-s2.1-pro', malicious), 'genstudio')
  assert.equal(resolveAudioProvider('voicestudio-qwen3-tts', malicious), 'genstudio')
})

test('a terminal GenStudio task failure starts a new manual recovery request', () => {
  assert.equal(isTerminalGenStudioTaskFailure({ task_id: 'job_failed', last_state: 'failed' }), true)
  assert.equal(isTerminalGenStudioTaskFailure({ task_id: 'job_running', last_state: 'running' }), false)
  assert.equal(isTerminalGenStudioTaskFailure({ task_id: '', last_state: 'failed' }), false)
})

test('Story Studio keeps no local TTS product catalogue', () => {
  // The customer picks a model from GenStudio's live /v1/tts/models and is
  // charged by it, so there is nothing for Story Studio to synthesise. Saved
  // rows stay on disk as evidence and never become executable configuration.
  const healed = genStudioOnlyAudioModels({
    'genstudio-standard-v1': {
      label: 'Tampered canonical model',
      provider: 'fal',
      // A per-engine chunk size a former release persisted. `AudioModelConfig`
      // no longer declares the field — Story Studio holds no engine chunk
      // sizes at all — but a stale config.json on disk can still carry one,
      // and it must be discarded with everything else.
      tts_soft_max_chars: 25,
    } as any,
    'fishaudio-s2.1-pro': {
      label: 'Historical Fish model',
      provider: 'fishaudio',
    },
  })
  assert.deepEqual(healed, {})
})

test('the TTS request boundary and price come from the live model catalogue', () => {
  const generator = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../routes/audio.ts', import.meta.url), 'utf8')

  // Both the queueing route and the generator resolve the selected model
  // against /v1/tts/models rather than mapping it through a Story-owned tier.
  assert.match(route, /listGenStudioTtsModels\(apiKey\)/)
  assert.doesNotMatch(route, /storyTtsTierForModelId|resolveStoryTtsModelId/)
  assert.match(generator, /listGenStudioTtsModels\(apiKey\)/)
  assert.match(generator, /ttsModel\.maximum_input_characters/)
  assert.doesNotMatch(generator, /storyTtsTierForModelId|resolveStoryTtsModelId/)
  // The split boundary is derived from the live row, never taken from a
  // constant. The split itself lives in the shared planner, which the quote
  // route reuses so a quote prices the requests this generator actually
  // submits — from the same budget, resolved the same way.
  assert.match(generator, /resolveTtsRequestBudget\(ttsModel\)/)
  assert.match(generator, /planGenStudioTtsRequests\(sections, requestBudget\.effective\)/)
  assert.doesNotMatch(generator, /splitGenStudioApiRequests/)
})

test('legacy audio_models payloads are accepted but stripped before persistence', () => {
  const parsed = UpdateConfigSchema.parse({
    audio_models: {
      'genstudio-standard-v1': { provider: 'elevenlabs' },
    },
    audio_concurrency: 2,
    video_concurrency: 4,
    image_concurrency: 8,
    subtitle_concurrency: 'auto',
    image_launch_stagger_ms: 2_000,
    audio_launch_stagger_ms: 2_000,
    video_launch_stagger_ms: 2_000,
    generation_timeouts: { tts_minutes: 5 },
  })
  assert.equal('audio_models' in parsed, false)
  for (const key of [
    'audio_concurrency',
    'video_concurrency',
    'image_concurrency',
    'subtitle_concurrency',
    'image_launch_stagger_ms',
    'audio_launch_stagger_ms',
    'video_launch_stagger_ms',
    'generation_timeouts',
  ]) {
    assert.equal(key in parsed, false)
  }
})

test('generation, preview, and recovery source contain no direct TTS clients', () => {
  const generator = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../routes/audio.ts', import.meta.url), 'utf8')
  const reconciler = readFileSync(new URL('../services/audio-reconciler.ts', import.meta.url), 'utf8')
  const preview = route.slice(
    route.indexOf("router.post('/projects/:slug/preview-voice'"),
    route.indexOf('// ── Fish S2 expression markup'),
  )

  for (const source of [generator, preview, reconciler]) {
    assert.doesNotMatch(source, /elevenlabs-client|fishaudio-client|kie-tts-client|fal-client|genaipro-client/)
  }
  assert.doesNotMatch(generator, /studiohub-client|voicestudio-client|macos-say-client/)
  assert.match(generator, /manifestEntry\?\.provider === 'genstudio'/)
  assert.match(reconciler, /entry\.provider !== 'genstudio'/)
  assert.doesNotMatch(preview, /registry\.getAudioProvider|resolveApiKeyForProviderId/)
  assert.doesNotMatch(preview, /generateTtsToFile|\/v1\/audio\/jobs/)
  assert.match(preview, /downloadVoicePreview/)
  assert.doesNotMatch(reconciler, /resolveApiKeyForProviderId|listAllLabsTasks|pollExistingFalAudio/)
  // The legacy branch still reports the evidence as read-only, but no longer
  // interpolates the manifest's provider into it — `result.logs` goes straight
  // to the customer, and a pre-migration entry names an upstream route.
  assert.match(reconciler, /Legacy evidence is read-only/)
  assert.doesNotMatch(reconciler, /Legacy \$\{entry\.provider/)
  assert.match(preview, /getApiKey\('genstudio'\)/)
  // The direct Voice Studio control surface (base-url/test/voices/models,
  // /macos/voices) was removed entirely — routes/index.ts's GenStudio-only
  // 410 guard is the sole thing left at these paths (see routes.test.ts).
  assert.doesNotMatch(route, /router\.get\('\/voicestudio\//)
  assert.doesNotMatch(route, /router\.get\('\/macos\/voices'/)
})
