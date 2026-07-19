import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_AUDIO_MODELS, DEFAULT_VOICE_PRESETS } from '../models/defaults.js'
import { normalizeVoicePresets, voiceSupportsProvider } from '../services/voice-presets.js'
import {
  buildGenStudioSubmission,
  catalogHasVoice,
  GENSTUDIO_LONG_JOB_TIMEOUT_MS,
  GENSTUDIO_MAX_TTS_CHARACTERS,
  splitGenStudioApiRequests,
} from '../lib/genstudio-client.js'

test('GenStudio standard voices are an explicit, bounded TTS route', () => {
  assert.deepEqual(DEFAULT_AUDIO_MODELS['genstudio-qwen3-standard'], {
    label: 'Qwen3 Standard Voices [GenStudio KH · staging]',
    cost_per_1k_chars: 0,
    provider: 'genstudio',
    tts_soft_max_chars: 15000,
  })
  const voices = normalizeVoicePresets(DEFAULT_VOICE_PRESETS)
  assert.equal(voiceSupportsProvider(voices, 'voice_qwen3_ryan', 'genstudio'), true)
  assert.equal(voiceSupportsProvider(voices, 'voice_qwen3_aiden', 'genstudio'), true)
})

test('GenStudio accepts exactly 15,000 characters as one public API request', () => {
  const text = 'a'.repeat(GENSTUDIO_MAX_TTS_CHARACTERS)
  assert.equal(splitGenStudioApiRequests(text).length, 1)
  const submission = buildGenStudioSubmission({
    text,
    voiceId: 'voice_live',
    speed: 0.9,
  })
  assert.equal(submission.body.text.length, 15_000)
})

test('GenStudio splits 15,001 characters only at the outer API boundary', () => {
  const text = 'a'.repeat(GENSTUDIO_MAX_TTS_CHARACTERS + 1)
  const requests = splitGenStudioApiRequests(text)
  assert.equal(requests.length, 2)
  assert.equal(requests.join(''), text)
  assert.ok(requests.every(part => part.length <= GENSTUDIO_MAX_TTS_CHARACTERS))
  assert.throws(() => buildGenStudioSubmission({ text, voiceId: 'voice_live', speed: 1 }), /15,000/)
})

test('text longer than the retired 375-character cap remains one GenStudio request', () => {
  const requests = splitGenStudioApiRequests('Long-form narration. '.repeat(30))
  assert.equal(requests.length, 1)
  assert.ok(requests[0]!.length > 375)
})

test('GenStudio JSON carries speed and retries reuse the same idempotency key', () => {
  const request = { text: 'A calm long-form sample.', voiceId: 'voice_live', speed: 0.9 }
  const first = buildGenStudioSubmission(request)
  const retry = buildGenStudioSubmission(request)
  assert.deepEqual(first.body, {
    voice_id: 'voice_live',
    text: request.text,
    speed: 0.9,
  })
  assert.equal(first.idempotencyKey, retry.idempotencyKey)
  assert.notEqual(
    first.idempotencyKey,
    buildGenStudioSubmission({ ...request, speed: 1 }).idempotencyKey,
  )
})

test('GenStudio long jobs are not constrained by a short client timeout', () => {
  assert.equal(GENSTUDIO_LONG_JOB_TIMEOUT_MS, 4 * 60 * 60_000)
})

test('GenStudio result handling converts format without applying speed twice', () => {
  const source = readFileSync(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /atempo|rubberband|setpts/)
  assert.match(source, /runFfmpeg\(\['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-b:a', '192k', outPath\]\)/)
})

test('the existing direct VoiceStudio and Studio Hub route remains separate', () => {
  const source = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
  assert.match(source, /else if \(providerId === 'voicestudio'\)/)
  assert.match(source, /await generateTtsVoiceStudio\(ep, task\.outputPath/)
  assert.match(source, /const isHubAudioProvider = isVoiceStudioProvider && hubBackend\?\.mode === 'hub'/)
})

test('GenStudio client cannot bypass its API boundary to contact Studio Hub', () => {
  const source = readFileSync(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8')
  assert.equal(source.includes('studiohub-client'), false)
  assert.equal(source.includes('getHubBackend'), false)
  assert.equal(source.includes('hubSubmitJob'), false)
  assert.match(source, /No direct Studio Hub fallback was attempted/)
})

test('GenStudio catalog membership accepts only enabled live voice IDs', () => {
  const voices = [
    { id: 'voice_live', display_name: 'Live', generation_enabled: true },
    { id: 'voice_disabled', display_name: 'Disabled', generation_enabled: false },
  ]
  assert.equal(catalogHasVoice(voices, 'voice_live'), true)
  assert.equal(catalogHasVoice(voices, ' voice_live '), true)
  assert.equal(catalogHasVoice(voices, 'voice_disabled'), false)
  assert.equal(catalogHasVoice(voices, 'voice_missing'), false)
})
