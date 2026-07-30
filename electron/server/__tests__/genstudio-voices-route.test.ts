import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let app: any
let cleanup: () => Promise<void>
let originalFetch: typeof globalThis.fetch

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  originalFetch = globalThis.fetch
})

after(async () => {
  globalThis.fetch = originalFetch
  await cleanup()
})

test('GenStudio voice discovery requires a saved key', async () => {
  const response = await request(app).get('/api/app-settings/genstudio/voices')
  assert.equal(response.status, 400)
  assert.match(response.body.detail, /API key/)
})

test('GenStudio voice discovery forwards the saved bearer key and catalog', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_story_catalog' })
    .expect(200)

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8000/v1/voices')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_test_story_catalog')
    return new Response(JSON.stringify([
      {
        id: 'voice_qwen3_ryan', display_name: 'Ryan', language: 'en',
        engine_id: 'genstudio-standard-v1', engine_name: 'Qwen3 TTS',
        model_revision_id: 'qwen-r1', model_family: 'qwen3', voice_tier: 'standard',
      },
      { id: 'voice_qwen3_aiden', display_name: 'Aiden', language: 'en' },
      { id: 'voice_disabled', display_name: 'Disabled', generation_enabled: false },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const response = await request(app).get('/api/app-settings/genstudio/voices')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.voices.map((voice: any) => voice.id), [
    'voice_qwen3_ryan',
    'voice_qwen3_aiden',
  ])
  // Which upstream engine served a voice is private routing detail. Story Studio
  // presents one GenStudio KH boundary, so these never reach the customer payload.
  const [voice] = response.body.voices
  assert.equal(voice.engine_id, undefined, 'engine_id must not leave the backend')
  assert.equal(voice.engine_name, undefined, 'engine_name must not leave the backend')
  assert.equal(voice.model_family, undefined, 'model_family must not leave the backend')
  assert.equal(voice.model_revision_id, undefined, 'model_revision_id must not leave the backend')
  assert.equal(voice.provider, undefined, 'provider must not leave the backend')
  // Customer-facing selection data still survives the strip.
  assert.equal(voice.voice_tier, 'standard')
  assert.equal(voice.id, 'voice_qwen3_ryan')
})

test('GenStudio media and LLM discovery use provider-owned live catalogs', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_story_catalog' })
    .expect(200)

  globalThis.fetch = async (input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_test_story_catalog')
    const url = String(input)
    if (url.endsWith('/v1/models')) {
      return Response.json([
        {
          id: 'voice-v1', revision: 'r1', display_name: 'Voice V1', modality: 'audio',
          operation: 'voice.tts', availability: 'available', qualification_only: false,
          pricing_unit: 'characters', limits: { max_characters: 15_000 }, controls: {},
        },
        {
          id: 'image-v1', revision: 'r1', display_name: 'Image V1', modality: 'image',
          operation: 'image.generation', availability: 'available', qualification_only: false,
          limits: {}, controls: {},
        },
      ])
    }
    if (url.endsWith('/v1/chat/models')) {
      return Response.json([{
        id: 'chat-v1', display_name: 'Chat V1', available: true, qualification_only: false,
        max_output_tokens: 8_192, controls: ['temperature'], activation_blockers: [],
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

  const capabilities = await request(app).get('/api/app-settings/genstudio/models').expect(200)
  assert.equal(capabilities.body.models.length, 2)

  const voice = await request(app).get('/api/app-settings/genstudio/voice-models').expect(200)
  assert.deepEqual(voice.body.models.map((model: any) => model.id), ['voice-v1'])
  assert.equal(voice.body.models[0].limits.max_characters, 15_000)

  const chat = await request(app).get('/api/app-settings/genstudio/chat-models').expect(200)
  assert.deepEqual(chat.body.models.map((model: any) => model.id), ['chat-v1'])

  const video = await request(app).get('/api/app-settings/genstudio/video-models').expect(200)
  assert.deepEqual(video.body.models.map((model: any) => model.id), ['video-v1'])
  assert.equal(video.body.models[0].available, false)
})

test('GenStudio transcription discovery uses the same scoped boundary key', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_story_catalog' })
    .expect(200)

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8000/v1/transcription/models')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_test_story_catalog')
    return new Response(JSON.stringify([
      {
        id: 'mlx-community/whisper-large-v3-turbo',
        display_name: 'Whisper large-v3 turbo',
        provider: 'Whisper MLX',
        language: 'multilingual',
        available: true,
        available_workers: 10,
        qualification_only: true,
      },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const response = await request(app).get('/api/app-settings/genstudio/transcription-models')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.models.map((model: any) => model.id), [
    'mlx-community/whisper-large-v3-turbo',
  ])
})

test('GenStudio key test proves every Story Studio catalog and generation scope', async () => {
  const visited: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    visited.push(url)
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_all_story_scopes')
    if (url.includes('story-studio-key-probe')) return new Response(null, { status: 404 })
    if (url.endsWith('/v1/account/overview')) return Response.json({ detail: 'missing usage:read' }, { status: 403 })
    return Response.json([])
  }

  const response = await request(app)
    .post('/api/app-settings/api-keys/genstudio/test')
    .send({ apiKey: 'gsk_all_story_scopes' })
    .expect(200)

  assert.equal(response.body.valid, true)
  assert.match(response.body.message, /catalogs and TTS, transcription, image, LLM, and video job access/)
  assert.equal(response.body.usage_available, false)
  assert.match(response.body.warning, /usage:read/)
  assert.deepEqual(visited, [
    'http://127.0.0.1:8000/v1/models',
    'http://127.0.0.1:8000/v1/voices',
    'http://127.0.0.1:8000/v1/transcription/models',
    'http://127.0.0.1:8000/v1/image/models',
    'http://127.0.0.1:8000/v1/videos/models',
    'http://127.0.0.1:8000/v1/jobs/story-studio-key-probe',
    'http://127.0.0.1:8000/v1/chat/responses/story-studio-key-probe',
    'http://127.0.0.1:8000/v1/images/story-studio-key-probe',
    'http://127.0.0.1:8000/v1/transcriptions/story-studio-key-probe',
    'http://127.0.0.1:8000/v1/videos/story-studio-key-probe',
    'http://127.0.0.1:8000/v1/account/overview',
  ])
})

test('GenStudio key test names the first missing scope without submitting work', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/v1/chat/responses/story-studio-key-probe')) {
      return Response.json({ detail: 'missing scope' }, { status: 403 })
    }
    if (url.endsWith('/v1/jobs/story-studio-key-probe')) return new Response(null, { status: 404 })
    return Response.json([])
  }

  const response = await request(app)
    .post('/api/app-settings/api-keys/genstudio/test')
    .send({ apiKey: 'gsk_missing_chat_scope' })
    .expect(200)

  assert.equal(response.body.valid, false)
  assert.equal(response.body.reachable, true)
  assert.match(response.body.message, /chat:generate/)
})

test('GenStudio usage failures name the supported usage:read scope actionably', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_missing_usage_scope' })
    .expect(200)

  const visited: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    visited.push(url)
    assert.match(url, /^http:\/\/127\.0\.0\.1:8000\/v1\/account\//)
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_missing_usage_scope')
    return Response.json({ detail: 'missing usage:read' }, { status: 403 })
  }

  const response = await request(app)
    .get('/api/app-settings/genstudio/usage')
    .expect(503)

  assert.equal(response.body.code, 'GENSTUDIO_USAGE_SCOPE_UNAVAILABLE')
  assert.match(response.body.detail, /invalid or missing usage:read/i)
  assert.match(response.body.detail, /Issue or update a scoped key in GenStudio/i)
  assert.doesNotMatch(response.body.detail, /after GenStudio exposes/i)
  assert.deepEqual(visited, ['http://127.0.0.1:8000/v1/account/overview'])
})

test('GenStudio usage requests supported account pagination and returns authoritative settlement', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_usage_snapshot' })
    .expect(200)

  const visited: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    visited.push(url)
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_usage_snapshot')
    if (url.endsWith('/v1/account/overview')) {
      return Response.json({
        credit_balance: 900,
        credits_used_30d: 100,
        subscription_plan_name: 'Angkor Pro',
        relaxed_concurrency_limit: 3,
        active_jobs: 1,
        completed_jobs: 12,
      })
    }
    if (url.endsWith('/v1/account/jobs?page=1&page_size=20')) {
      return Response.json({ items: [], page: 1, page_size: 20, total: 0, total_pages: 0 })
    }
    if (url.endsWith('/v1/account/credit-activity?page=1&page_size=20')) {
      return Response.json({ items: [], page: 1, page_size: 20, total: 0, total_pages: 0 })
    }
    throw new Error(`Unexpected GenStudio usage request: ${url}`)
  }

  const response = await request(app)
    .get('/api/app-settings/genstudio/usage')
    .expect(200)

  assert.equal(response.body.overview.credit_balance, 900)
  assert.equal(response.body.jobs.page_size, 20)
  assert.equal(response.body.credit_activity.page_size, 20)
  assert.deepEqual([...visited].sort(), [
    'http://127.0.0.1:8000/v1/account/overview',
    'http://127.0.0.1:8000/v1/account/jobs?page=1&page_size=20',
    'http://127.0.0.1:8000/v1/account/credit-activity?page=1&page_size=20',
  ].sort())
})
