import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { UpdateConfigSchema } from '../contracts/index.js'
import { resolveAudioProvider } from '../generators/audio.js'
import { genStudioOnlyAudioModels } from '../services/project-manager.js'

test('arbitrary project audio_models cannot select a direct TTS provider', () => {
  const malicious = {
    'genstudio-standard-v1': {
      label: 'Forged route',
      cost_per_1k_chars: 0,
      provider: 'elevenlabs' as const,
    },
  }
  assert.equal(resolveAudioProvider('genstudio-standard-v1', malicious), 'genstudio')
  assert.equal(resolveAudioProvider('fishaudio-s2.1-pro', malicious), 'genstudio')
  assert.equal(resolveAudioProvider('voicestudio-qwen3-tts', malicious), 'genstudio')
})

test('project config healing exposes only canonical GenStudio TTS entries', () => {
  const healed = genStudioOnlyAudioModels({
    'genstudio-standard-v1': {
      label: 'Tampered canonical model',
      cost_per_1k_chars: 99,
      provider: 'fal',
      tts_soft_max_chars: 25,
    },
    'fishaudio-s2.1-pro': {
      label: 'Historical Fish model',
      cost_per_1k_chars: 0,
      provider: 'fishaudio',
    },
  })
  assert.ok(healed['genstudio-standard-v1'])
  assert.equal(healed['genstudio-standard-v1']?.provider, 'genstudio')
  assert.equal(healed['genstudio-standard-v1']?.tts_soft_max_chars, 15_000)
  assert.equal(healed['fishaudio-s2.1-pro'], undefined)
  assert.ok(Object.values(healed).every(model => model.provider === 'genstudio'))
})

test('legacy audio_models payloads are accepted but stripped before persistence', () => {
  const parsed = UpdateConfigSchema.parse({
    audio_models: {
      'genstudio-standard-v1': { provider: 'elevenlabs' },
    },
    audio_concurrency: 2,
  })
  assert.equal('audio_models' in parsed, false)
  assert.equal(parsed.audio_concurrency, 2)
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
  assert.doesNotMatch(reconciler, /resolveApiKeyForProviderId|listAllLabsTasks|pollExistingFalAudio/)
  assert.match(reconciler, /Legacy .* evidence is read-only/)
  assert.match(preview, /getApiKey\('genstudio'\)/)
  assert.match(route, /req\.path\.startsWith\('\/voicestudio\/'\)/)
  assert.match(route, /req\.path\.startsWith\('\/macos\/voices'\)/)
  assert.ok(
    route.indexOf("router.use((req, res, next)") < route.indexOf("router.get('/voicestudio/base-url'"),
    'retired local diagnostics must remain behind the GenStudio-only 410 guard',
  )
})
