import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_AUDIO_MODELS, DEFAULT_VOICE_PRESETS } from '../models/defaults.js'
import { normalizeVoicePresets, voiceSupportsProvider } from '../services/voice-presets.js'
import {
  buildGenStudioChatIdempotencyKey,
  buildGenStudioTranscriptionIdempotencyKey,
  buildGenStudioImageIdempotencyKey,
  buildGenStudioSubmission,
  callChatWithGenStudio,
  catalogHasVoice,
  downloadVoicePreview,
  generateTtsToFile,
  generateImageWithGenStudio,
  GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS,
  GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
  GENSTUDIO_LONG_JOB_TIMEOUT_MS,
  GENSTUDIO_MAX_TTS_CHARACTERS,
  listImageModels,
  listChatModels,
  listModelCapabilities,
  listVoices,
  listVideoModels,
  operationSignal,
  recoverImageWithGenStudio,
  recoverTranscriptionWithGenStudio,
  recoverTtsToFile,
  splitGenStudioApiRequests,
  transcribeWithGenStudio,
} from '../lib/genstudio-client.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('legacy Qwen engine labels are absent from the Story-owned TTS defaults', () => {
  assert.equal(DEFAULT_AUDIO_MODELS['genstudio-qwen3-standard'], undefined)
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

test('GenStudio chat retries keep one logical request identity', () => {
  const request = {
    modelId: 'genstudio-chat-local-v1',
    system: 'Return verified JSON.',
    userMessage: 'Create one metadata record.',
    temperature: 0.2,
    maxOutputTokens: 4_096,
    requestIdentity: 'boundful:EP0001:metadata',
  }
  const first = buildGenStudioChatIdempotencyKey(request)
  assert.equal(first, buildGenStudioChatIdempotencyKey(request))
  assert.notEqual(first, buildGenStudioChatIdempotencyKey({
    ...request,
    requestIdentity: 'boundful:EP0002:metadata',
  }))
  assert.match(first, /^story-chat-[a-f0-9]{47}$/)
})

test('GenStudio chat submits and completes through only the durable public job API', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      assert.equal(url, 'http://127.0.0.1:8000/v1/chat/responses')
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer scoped-key')
      assert.match((init?.headers as Record<string, string>)['Idempotency-Key'] || '', /^story-chat-/)
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model_id: 'genstudio-chat-local-v1',
        input: [
          { role: 'system', content: 'Write concise prose.' },
          { role: 'user', content: 'Describe a quiet forest.' },
        ],
        temperature: 0.4,
        top_p: 1,
        max_output_tokens: 2_048,
      })
      posts++
      return Response.json({
        id: 'chat_story_1',
        state: 'succeeded',
        model_id: 'genstudio-chat-local-v1',
        output_text: 'A quiet forest rests beneath silver rain.',
      }, { status: 202 })
    }
    const accepted: string[] = []
    const result = await callChatWithGenStudio('scoped-key', {
      modelId: 'genstudio-chat-local-v1',
      system: 'Write concise prose.',
      userMessage: 'Describe a quiet forest.',
      temperature: 0.4,
      requestIdentity: 'dozing-knight:DK0001:scene-0001',
      onJobAccepted: jobId => { accepted.push(jobId) },
    })
    assert.equal(posts, 1)
    assert.deepEqual(accepted, ['chat_story_1'])
    assert.deepEqual(result, {
      text: 'A quiet forest rests beneath silver rain.',
      jobId: 'chat_story_1',
      modelId: 'genstudio-chat-local-v1',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GenStudio chat terminal failure never falls back to a direct provider', async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  try {
    globalThis.fetch = async (input) => {
      requests++
      assert.match(String(input), /\/v1\/chat\/responses$/)
      return Response.json({
        id: 'chat_failed',
        state: 'failed',
        model_id: 'genstudio-chat-local-v1',
        failure_code: 'provider_unavailable',
      }, { status: 202 })
    }
    await assert.rejects(
      callChatWithGenStudio('scoped-key', {
        modelId: 'genstudio-chat-local-v1',
        system: '',
        userMessage: 'Do not fall back.',
      }),
      /No direct provider or Studio Hub fallback was attempted/,
    )
    assert.equal(requests, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GenStudio publishes normalized capability, chat, and video catalogs', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer scoped-key')
      const url = String(input)
      if (url.endsWith('/v1/models')) {
        return Response.json([
          {
            id: 'voice-v1', revision: 'voice-r1', display_name: 'Voice V1', modality: 'audio',
            operation: 'voice.tts', availability: 'available', qualification_only: false,
            pricing_unit: 'characters', limits: { max_characters: 15_000 }, controls: { speed: true },
          },
          { id: 'invalid', display_name: 'Invalid', modality: 'other', operation: 'unknown' },
        ])
      }
      if (url.endsWith('/v1/chat/models')) {
        return Response.json([{
          id: 'chat-v1', display_name: 'Chat V1', available: true, qualification_only: false,
          max_output_tokens: 65_536, controls: ['temperature'], activation_blockers: [],
        }])
      }
      if (url.endsWith('/v1/videos/models')) {
        return Response.json([{
          id: 'video-v1', display_name: 'Video V1', available: false,
          modes: ['image-to-video'], aspect_ratios: ['16:9'],
          variants: [{ duration_seconds: 5, resolution: '720p', credits_per_video: 12, minimum_credits: 12, price_version: 'video-v1' }],
        }])
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const [capabilities, chat, video] = await Promise.all([
      listModelCapabilities('scoped-key'),
      listChatModels('scoped-key'),
      listVideoModels('scoped-key'),
    ])
    assert.equal(capabilities.length, 1)
    assert.equal(capabilities[0]?.operation, 'voice.tts')
    assert.equal(chat[0]?.max_output_tokens, 32_768)
    assert.equal(chat[0]?.available, true)
    assert.deepEqual(video[0]?.modes, ['image-to-video'])
    assert.equal(video[0]?.variants[0]?.price_version, 'video-v1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GenStudio voice catalog preserves tiers and stored previews without generating audio', async () => {
  const originalFetch = globalThis.fetch
  let previewDownloads = 0
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer scoped-key')
      const url = String(input)
      if (url.endsWith('/v1/voices')) {
        return Response.json([{
          id: 'voice-premium',
          display_name: 'Premium narrator',
          voice_tier: 'premium',
          generation_enabled: true,
          preview_available: true,
          preview_url: '/v1/voices/voice-premium/preview',
          preview_text: 'A stored listening sample.',
        }])
      }
      if (url.endsWith('/v1/voices/voice-premium/preview')) {
        previewDownloads++
        return new Response(Buffer.from('preview-audio'), {
          headers: { 'Content-Type': 'audio/mpeg' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const voices = await listVoices('scoped-key')
    assert.equal(voices[0]?.voice_tier, 'premium')
    assert.equal(voices[0]?.preview_available, true)
    assert.equal(voices[0]?.preview_url, '/v1/voices/voice-premium/preview')
    const preview = await downloadVoicePreview('scoped-key', voices[0]!.preview_url!)
    assert.equal(preview.mediaType, 'audio/mpeg')
    assert.equal(preview.bytes.toString(), 'preview-audio')
    assert.equal(previewDownloads, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GenStudio long jobs are not constrained by a short client timeout', () => {
  assert.equal(GENSTUDIO_LONG_JOB_TIMEOUT_MS, 4 * 60 * 60_000)
  assert.equal(GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, 30_000)
  assert.equal(GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS, 5 * 60_000)
})

test('individual GenStudio requests time out before the durable job deadline', async () => {
  const signal = operationSignal(undefined, Date.now() + 60_000, 5)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(signal.aborted, true)
})

test('GenStudio authentication failures are immediate and actionable', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  try {
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /\/v1\/audio\/jobs$/)
      assert.match((init?.headers as Record<string, string>)?.['Idempotency-Key'] || '', /^story-tts-/)
      attempts++
      return Response.json({ detail: 'authentication required' }, { status: 401 })
    }
    await assert.rejects(
      generateTtsToFile('scoped-key', path.join(os.tmpdir(), 'unused-auth-retry.mp3'), {
        text: 'A safe idempotent retry.',
        voiceId: 'voice_live',
        speed: 1,
      }),
      /rejected the scoped API key.*includes the scope required by this operation/i,
    )
    assert.equal(attempts, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GenStudio result handling converts format without applying speed twice', () => {
  const source = readFileSync(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /atempo|rubberband|setpts/)
  assert.match(source, /runFfmpeg\(\['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-b:a', '192k', outPath\]\)/)
})

test('Story TTS generation has no direct VoiceStudio or Studio Hub execution route', () => {
  const source = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /generateTtsVoiceStudio|studiohub-client|voicestudio-client/)
  assert.match(source, /return 'genstudio'/)
  assert.match(source, /Persisted audio_models is historical evidence only/)
})

test('GenStudio client cannot bypass its API boundary to contact Studio Hub', () => {
  const source = readFileSync(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8')
  assert.equal(source.includes('studiohub-client'), false)
  assert.equal(source.includes('getHubBackend'), false)
  assert.equal(source.includes('hubSubmitJob'), false)
  assert.match(source, /No direct Studio Hub fallback was attempted/)
  assert.match(source, /No OpenAI, Studio Hub, or direct Voice Studio fallback was attempted/)
})

test('GenStudio credentials remain in the app secret store and never enter recovery diagnostics', () => {
  const secrets = readFileSync(new URL('../services/app-secrets-store.ts', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('../routes/app-settings.ts', import.meta.url), 'utf8')
  const recovery = readFileSync(new URL('../services/genstudio-recovery.ts', import.meta.url), 'utf8')
  assert.match(secrets, /'genstudio'/)
  assert.match(secrets, /mode 0600/)
  assert.match(settings, /getApiKey\('genstudio'\)/)
  assert.doesNotMatch(recovery, /apiKey|api_key|Authorization|Bearer|hub_url|hub_token|worker_address/)
})

test('GenStudio transcription retries and new Story queue jobs keep one logical asset identity', () => {
  const input = {
    requestIdentity: 'project:EP0001:transcription:EP0001_Chapter_01.srt',
    fileSha256: 'a'.repeat(64),
    modelId: 'mlx-community/whisper-large-v3-turbo',
    language: 'en',
    wordTimestamps: false,
  }
  const first = buildGenStudioTranscriptionIdempotencyKey(input)
  assert.equal(first, buildGenStudioTranscriptionIdempotencyKey(input))
  assert.notEqual(first, buildGenStudioTranscriptionIdempotencyKey({
    ...input,
    requestIdentity: 'project:EP0001:transcription:EP0001_Chapter_02.srt',
  }))
  assert.match(first, /^story-stt-[a-f0-9]{48}$/)
})

test('GenStudio image idempotency keeps network retries stable but separates deliberate renders', () => {
  const input = {
    prompt: 'A moonlit Cambodian temple reflected in still water.',
    modelId: 'genstudio-image-fast-v1',
    aspectRatio: '16:9',
    steps: 4,
    seed: 42,
    requestIdentity: 'story-job-1:scene-0001',
  }
  const first = buildGenStudioImageIdempotencyKey(input)
  assert.equal(first, buildGenStudioImageIdempotencyKey(input))
  assert.notEqual(first, buildGenStudioImageIdempotencyKey({
    ...input,
    requestIdentity: 'story-job-2:scene-0001',
  }))
  assert.notEqual(first, buildGenStudioImageIdempotencyKey({
    ...input,
    width: 1152,
    height: 864,
  }))
  assert.equal(first, buildGenStudioImageIdempotencyKey({
    ...input,
    width: 1152,
  }))
  assert.match(first, /^story-image-[a-f0-9]{44}$/)
})

test('GenStudio image catalog preserves only valid provider-published pixel sizes', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/image\/models$/)
      return Response.json([{
          id: 'genstudio-image-fast-v1',
          display_name: 'GenStudio Image Fast',
          aspect_ratios: ['16:9', '4:3'],
          default_aspect_ratio: '16:9',
          default_steps: 4,
          min_steps: 2,
          max_steps: 8,
          sizes: [
            { aspect_ratio: '16:9', width: 1344, height: 768, label: 'Full', default: true },
            { aspect_ratio: '4:3', width: 1024, height: 768 },
            { aspect_ratio: '16:9', width: 0, height: 768 },
          ],
        }])
    }
    const models = await listImageModels('scoped-key')
    assert.deepEqual(models[0]?.sizes, [
      { aspect_ratio: '16:9', width: 1344, height: 768, label: 'Full', default: true },
      { aspect_ratio: '4:3', width: 1024, height: 768, label: undefined, default: false },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GenStudio image generation sends catalog controls and returns a verified private PNG', async () => {
  const originalFetch = globalThis.fetch
  let accepted = ''
  let posts = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/images/generations')) {
        posts++
        const body = JSON.parse(String(init?.body || '{}'))
        assert.deepEqual(body, {
          prompt: 'A textured paper collage of hope and renewal.',
          model_id: 'genstudio-image-fast-v1',
          aspect_ratio: '4:3',
          steps: 6,
          width: 1152,
          height: 864,
          seed: 77,
        })
        assert.match((init?.headers as Record<string, string>)?.['Idempotency-Key'] || '', /^story-image-/)
        return Response.json({
          id: 'image_job_ok', state: 'succeeded', model_id: body.model_id,
          prompt: body.prompt, width: 1024, height: 768, aspect_ratio: body.aspect_ratio,
          steps: body.steps, seed: body.seed, image_url: '/v1/images/image_job_ok/file',
        }, { status: 202 })
      }
      if (url.endsWith('/v1/images/image_job_ok/file')) return new Response(ONE_PIXEL_PNG)
      throw new Error(`Unexpected request: ${url}`)
    }
    const result = await generateImageWithGenStudio('scoped-key', {
      prompt: 'A textured paper collage of hope and renewal.',
      modelId: 'genstudio-image-fast-v1',
      aspectRatio: '4:3',
      steps: 6,
      width: 1152,
      height: 864,
      seed: 77,
      requestIdentity: 'story-job:thumb-1',
      onJobAccepted: jobId => { accepted = jobId },
    })
    assert.equal(posts, 1)
    assert.equal(accepted, 'image_job_ok')
    assert.equal(result.jobId, 'image_job_ok')
    assert.match(result.url, /^data:image\/png;base64,/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('accepted GenStudio image jobs can be reclaimed without a second submit', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST') posts++
      if (url.endsWith('/v1/images/image_existing')) {
        return Response.json({
          id: 'image_existing', state: 'succeeded', model_id: 'genstudio-image-fast-v1',
          prompt: 'Recovered', width: 1024, height: 1024, aspect_ratio: '1:1', steps: 4,
          image_url: '/v1/images/image_existing/file',
        })
      }
      if (url.endsWith('/v1/images/image_existing/file')) return new Response(ONE_PIXEL_PNG)
      throw new Error(`Unexpected request: ${url}`)
    }
    const result = await recoverImageWithGenStudio('scoped-key', 'image_existing')
    assert.equal(posts, 0)
    assert.equal(result.jobId, 'image_existing')
    assert.match(result.url, /^data:image\/png;base64,/)
  } finally {
    globalThis.fetch = originalFetch
  }
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
      requestIdentity: 'project:EP0001:transcription:chapter-success.srt',
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

test('accepted transcription IDs can be reclaimed without a second submit', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST') posts++
      if (url.endsWith('/v1/transcriptions/stt_existing')) {
        return Response.json({
          id: 'stt_existing',
          state: 'succeeded',
          model_id: 'mlx-community/whisper-large-v3-turbo',
          srt_url: '/v1/transcriptions/stt_existing/srt',
        })
      }
      if (url.endsWith('/v1/transcriptions/stt_existing/srt')) {
        return new Response('1\n00:00:00,000 --> 00:00:01,000\nRecovered.\n')
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const result = await recoverTranscriptionWithGenStudio('scoped-key', 'stt_existing', {})
    assert.equal(posts, 0)
    assert.equal(result.jobId, 'stt_existing')
    assert.match(result.srt, /Recovered\./)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an accepted transcription survives artifact download failure without a second request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-genstudio-stt-download-'))
  const audioPath = path.join(dir, 'chapter.wav')
  await fs.writeFile(audioPath, Buffer.from('RIFF-story-audio'))
  const originalFetch = globalThis.fetch
  let posts = 0
  let artifactReady = false
  let acceptedJobId = ''
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/audio/transcriptions')) {
        posts++
        return Response.json({
          id: 'stt_download_recovery',
          state: 'succeeded',
          model_id: 'mlx-community/whisper-large-v3-turbo',
          srt_url: '/v1/transcriptions/stt_download_recovery/srt',
        }, { status: 202 })
      }
      if (url.endsWith('/v1/transcriptions/stt_download_recovery')) {
        return Response.json({
          id: 'stt_download_recovery',
          state: 'succeeded',
          model_id: 'mlx-community/whisper-large-v3-turbo',
          srt_url: '/v1/transcriptions/stt_download_recovery/srt',
        })
      }
      if (url.endsWith('/v1/transcriptions/stt_download_recovery/srt')) {
        if (!artifactReady) return new Response('expired', { status: 404 })
        return new Response('1\n00:00:00,000 --> 00:00:01,000\nRecovered.\n')
      }
      throw new Error(`Unexpected request: ${url}`)
    }

    await assert.rejects(
      transcribeWithGenStudio('scoped-key', {
        audioPath,
        modelId: 'mlx-community/whisper-large-v3-turbo',
        requestIdentity: 'project:EP0001:transcription:chapter-download.srt',
        onJobAccepted: jobId => { acceptedJobId = jobId },
      }),
      /SRT download failed/,
    )
    artifactReady = true
    const recovered = await recoverTranscriptionWithGenStudio('scoped-key', acceptedJobId, {})
    assert.equal(posts, 1)
    assert.equal(recovered.jobId, acceptedJobId)
    assert.match(recovered.srt, /Recovered/)
  } finally {
    globalThis.fetch = originalFetch
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('accepted TTS IDs are polled directly without submitting replacement work', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  try {
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST') posts++
      const url = String(input)
      if (url.endsWith('/v1/jobs/tts_existing')) {
        return Response.json({ id: 'tts_existing', state: 'failed', failure_code: 'test-stop' })
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    await assert.rejects(
      recoverTtsToFile('scoped-key', path.join(os.tmpdir(), 'unused-existing.mp3'), 'tts_existing', {
        text: 'Existing accepted task.',
        voiceId: 'voice_live',
        speed: 1,
        requestIdentity: 'project:EP0001:audio:chapter.mp3',
      }),
      /test-stop/,
    )
    assert.equal(posts, 0)
  } finally {
    globalThis.fetch = originalFetch
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
        requestIdentity: 'project:EP0001:transcription:chapter-failure.srt',
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
        requestIdentity: 'project:EP0001:transcription:chapter-empty.srt',
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
