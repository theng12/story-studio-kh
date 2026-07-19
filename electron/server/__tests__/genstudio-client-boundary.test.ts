import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_AUDIO_MODELS, DEFAULT_VOICE_PRESETS } from '../models/defaults.js'
import { normalizeVoicePresets, voiceSupportsProvider } from '../services/voice-presets.js'
import {
  buildGenStudioTranscriptionIdempotencyKey,
  buildGenStudioSubmission,
  catalogHasVoice,
  GENSTUDIO_LONG_JOB_TIMEOUT_MS,
  GENSTUDIO_MAX_TTS_CHARACTERS,
  splitGenStudioApiRequests,
  transcribeWithGenStudio,
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
  assert.match(source, /No OpenAI, Studio Hub, or direct Voice Studio fallback was attempted/)
})

test('GenStudio transcription retries keep one identity while manual jobs stay distinct', () => {
  const input = {
    storyJobId: 'story-job-1',
    fileSha256: 'a'.repeat(64),
    modelId: 'mlx-community/whisper-large-v3-turbo',
    language: 'en',
    wordTimestamps: false,
  }
  const first = buildGenStudioTranscriptionIdempotencyKey(input)
  assert.equal(first, buildGenStudioTranscriptionIdempotencyKey(input))
  assert.notEqual(first, buildGenStudioTranscriptionIdempotencyKey({
    ...input,
    storyJobId: 'story-job-2',
  }))
  assert.match(first, /^story-stt-[a-f0-9]{48}$/)
})

test('Story transcription has no direct OpenAI, Studio Hub, or Voice Studio route', () => {
  const generator = readFileSync(new URL('../generators/subtitles.ts', import.meta.url), 'utf8')
  const audioRoutes = readFileSync(new URL('../routes/audio.ts', import.meta.url), 'utf8')
  const pipeline = readFileSync(new URL('../routes/pipeline.ts', import.meta.url), 'utf8')
  const voiceStudioClient = readFileSync(new URL('../lib/voicestudio-client.ts', import.meta.url), 'utf8')
  assert.match(generator, /transcribeWithGenStudio/)
  assert.doesNotMatch(generator, /transcribeToSrt/)
  assert.doesNotMatch(generator, /transcribeViaConfiguredBackend/)
  assert.doesNotMatch(audioRoutes, /router\.get\('\/voicestudio\/transcribe-availability'/)
  assert.doesNotMatch(audioRoutes, /router\.post\('\/voicestudio\/download-model'/)
  assert.doesNotMatch(voiceStudioClient, /\/api\/transcribe/)
  assert.match(pipeline, /engine: 'genstudio'/)
})

test('GenStudio transcription uploads the selected model and verifies private SRT output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-genstudio-stt-'))
  const audioPath = path.join(dir, 'chapter.wav')
  await fs.writeFile(audioPath, Buffer.from('RIFF-story-audio'))
  const originalFetch = globalThis.fetch
  let submittedModel = ''
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/audio/transcriptions')) {
        const body = init?.body as FormData
        submittedModel = String(body.get('model'))
        assert.equal(init?.method, 'POST')
        assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer scoped-key')
        assert.match((init?.headers as Record<string, string>)?.['Idempotency-Key'] || '', /^story-stt-/)
        return Response.json({
          id: 'job_transcription_ok',
          state: 'succeeded',
          model_id: submittedModel,
          srt_url: '/v1/transcriptions/job_transcription_ok/srt',
        }, { status: 202 })
      }
      if (url.endsWith('/v1/transcriptions/job_transcription_ok/srt')) {
        assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer scoped-key')
        return new Response('1\n00:00:00,000 --> 00:00:01,000\nHello.\n')
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const result = await transcribeWithGenStudio('scoped-key', {
      audioPath,
      modelId: 'mlx-community/whisper-large-v3-turbo',
      storyJobId: 'story-job-success',
      language: 'en',
    })
    assert.equal(submittedModel, 'mlx-community/whisper-large-v3-turbo')
    assert.equal(result.jobId, 'job_transcription_ok')
    assert.match(result.srt, /Hello\./)
  } finally {
    globalThis.fetch = originalFetch
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('terminal GenStudio failure never falls back and empty artifacts never count as complete', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-genstudio-stt-failure-'))
  const audioPath = path.join(dir, 'chapter.wav')
  await fs.writeFile(audioPath, Buffer.from('RIFF-story-audio'))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/audio/transcriptions')) {
        return Response.json({
          id: 'job_transcription_failed',
          state: 'failed',
          model_id: 'mlx-community/whisper-large-v3-turbo',
          failure_code: 'worker_failed',
        }, { status: 202 })
      }
      throw new Error(`Unexpected fallback request: ${url}`)
    }
    await assert.rejects(
      transcribeWithGenStudio('scoped-key', {
        audioPath,
        modelId: 'mlx-community/whisper-large-v3-turbo',
        storyJobId: 'story-job-failure',
      }),
      /No OpenAI, Studio Hub, or direct Voice Studio fallback was attempted/,
    )

    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/audio/transcriptions')) {
        return Response.json({
          id: 'job_transcription_empty',
          state: 'succeeded',
          model_id: 'mlx-community/whisper-large-v3-turbo',
          srt_url: '/v1/transcriptions/job_transcription_empty/srt',
        }, { status: 202 })
      }
      if (url.endsWith('/v1/transcriptions/job_transcription_empty/srt')) return new Response('   ')
      throw new Error(`Unexpected request: ${url}`)
    }
    await assert.rejects(
      transcribeWithGenStudio('scoped-key', {
        audioPath,
        modelId: 'mlx-community/whisper-large-v3-turbo',
        storyJobId: 'story-job-empty',
      }),
      /empty SRT artifact/,
    )
  } finally {
    globalThis.fetch = originalFetch
    await fs.rm(dir, { recursive: true, force: true })
  }
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
