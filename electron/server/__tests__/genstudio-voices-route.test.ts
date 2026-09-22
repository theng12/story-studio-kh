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
    // Scoped by model: GenStudio requires `model_id` on /v1/voices (ADR-0016).
    assert.equal(String(input), 'http://127.0.0.1:8787/v1/voices?model_id=tts-qwen3')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_test_story_catalog')
    return new Response(JSON.stringify([
      {
        id: 'voice_qwen3_ryan', display_name: 'Ryan', language: 'en',
        provider: 'fish', engine_id: 'genstudio-standard-v1', engine_name: 'Qwen3 TTS',
        model_revision_id: 'qwen-r1', model_family: 'qwen3', voice_tier: 'standard',
        tts_model_id: 'tts-qwen3', tts_model_name: 'Qwen3 TTS', is_saved: true,
      },
      { id: 'voice_qwen3_aiden', display_name: 'Aiden', language: 'en' },
      { id: 'voice_disabled', display_name: 'Disabled', generation_enabled: false },
      { id: 'voice_other_model', display_name: 'Wrong model', tts_model_id: 'tts-somewhere-else' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const response = await request(app).get('/api/app-settings/genstudio/voices?model_id=tts-qwen3')
  assert.equal(response.status, 200)
  // A voice GenStudio has disabled is still listed. The customer needs to see
  // why a saved selection stopped working; `generation_enabled` gates the
  // action, not the row.
  assert.deepEqual(response.body.voices.map((voice: any) => voice.id), [
    'voice_qwen3_ryan',
    'voice_qwen3_aiden',
    'voice_disabled',
  ])
  // AGENTS.md → "Provider Transparency": the published provider and engine
  // identity is customer-facing and reaches the picker intact.
  const [voice] = response.body.voices
  assert.equal(voice.engine_id, 'genstudio-standard-v1', 'engine_id is published to the customer')
  assert.equal(voice.engine_name, 'Qwen3 TTS', 'engine_name is published to the customer')
  assert.equal(voice.model_family, 'qwen3', 'model_family is published to the customer')
  assert.equal(voice.model_revision_id, 'qwen-r1', 'model_revision_id is published to the customer')
  assert.equal(voice.provider, 'fish', 'provider is published to the customer')
  assert.equal(voice.tts_model_id, 'tts-qwen3', 'the serving model is published to the customer')
  assert.equal(voice.is_saved, true, "GenStudio's own saved flag reaches the picker")
  assert.equal(voice.voice_tier, 'standard')
  assert.equal(voice.id, 'voice_qwen3_ryan')
})

test('the voice model catalogue is published with its price, minimum and boundary', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_story_catalog' })
    .expect(200)

  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'http://127.0.0.1:8787/v1/tts/models')
    return Response.json([{
      id: 'tts-qwen3', display_name: 'Qwen3 TTS', provider_id: 'fish', provider_name: 'Fish Audio',
      description: 'Multilingual narration', credits_per_1000_characters: 48, minimum_credits: 10,
      maximum_input_characters: 12_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2,
      supports_voice_cloning: false,
      preview_policy: 'catalog', generation_enabled: true, supported_languages: ['en'],
    }])
  }

  const response = await request(app).get('/api/app-settings/genstudio/tts-models').expect(200)
  const [model] = response.body.models
  assert.equal(model.provider_name, 'Fish Audio', 'the serving provider is named for the customer')
  assert.equal(model.credits_per_1000_characters, 48)
  assert.equal(model.minimum_credits, 10)
  assert.equal(model.maximum_input_characters, 12_000)
  assert.equal(model.supports_speed, true)
  assert.equal(model.minimum_speed, 0.5)
  assert.equal(model.maximum_speed, 2)
  assert.deepEqual(model.supported_languages, ['en'])
  assert.equal(JSON.stringify(model).includes('km'), false, 'Story must not restore retired Khmer support')
})

test('the voice model catalogue keeps direct and relaxed Fish products separate with GenStudio sale metadata', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_story_tts_relaxed_catalog' })
    .expect(200)

  const relaxedQueueHint = {
    discount_percent: 50,
    unlock_threshold_cents: 5_000,
    message: 'GenStudio publishes this availability and discount notice.',
  }
  const base = {
    provider_id: 'fish', provider_name: 'Fish Audio', description: 'Multilingual narration',
    credits_per_1000_characters: 48, minimum_credits: 10, maximum_input_characters: 12_000,
    supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false, preview_policy: 'catalog',
    generation_enabled: true, supported_languages: ['en'],
  }

  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'http://127.0.0.1:8787/v1/tts/models')
    return Response.json([
      { ...base, id: 'fish-s2.1-pro', display_name: 'Fish Audio S2.1 Pro', queue_class: 'direct' },
      {
        ...base,
        id: 'fish-s2.1-pro-relaxed',
        display_name: 'Fish Audio S2.1 Pro (Relaxed Queue)',
        credits_per_1000_characters: 24,
        standard_credits: 48,
        sale_credits: 24,
        sale_ends_at: null,
        sale_disclaimer: 'GenStudio publishes this sale disclaimer.',
        queue_class: 'relaxed',
        relaxed_queue_hint: relaxedQueueHint,
      },
    ])
  }

  const response = await request(app).get('/api/app-settings/genstudio/tts-models').expect(200)
  const [direct, relaxed] = response.body.models
  assert.equal(direct.id, 'fish-s2.1-pro')
  assert.equal(relaxed.id, 'fish-s2.1-pro-relaxed')
  assert.equal(direct.queue_class, 'direct')
  assert.equal(relaxed.queue_class, 'relaxed')
  assert.deepEqual(relaxed.relaxed_queue_hint, relaxedQueueHint)
  assert.equal(relaxed.standard_credits, 48)
  assert.equal(relaxed.sale_credits, 24)
  assert.equal(relaxed.sale_ends_at, null)
  assert.equal(relaxed.sale_disclaimer, 'GenStudio publishes this sale disclaimer.')
})

test('the music model catalogue forwards GenStudio published details without inferring a provider', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_music_catalog' })
    .expect(200)

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8787/v1/music/models')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_music_catalog')
    return Response.json([
      {
        id: 'music-local-v1', display_name: 'Local Music', provider_name: 'Studio Hub',
        description: 'Local instrumental generation', coming_soon: false,
        credits_per_request: 0, minimum_credits: 0, price_version: 'music-price-v1',
        standard_credits: null, sale_credits: null, sale_ends_at: null, sale_disclaimer: null,
        supports_instrumental: true, supports_vocals: false, requires_lyrics: true,
        max_prompt_characters: 2_000, max_prompt_without_lyrics_characters: 1_200,
        min_prompt_characters: 1, max_lyrics_characters: 5_000, min_lyrics_characters: 1,
        max_title_characters: 256, outputs_per_request: 2,
      },
      {
        id: 'music-unannounced-v1', display_name: 'Unannounced Music', description: 'Not launched yet',
        coming_soon: true, credits_per_request: 50, minimum_credits: 10, price_version: 'music-price-v2',
        standard_credits: 60, sale_credits: 50, sale_ends_at: '2026-09-01T00:00:00Z', sale_disclaimer: 'Launch sale',
        supports_instrumental: true, supports_vocals: true, requires_lyrics: false,
        max_prompt_characters: 2_000, max_prompt_without_lyrics_characters: null,
        min_prompt_characters: 1, max_lyrics_characters: 5_000, min_lyrics_characters: 1,
        max_title_characters: 256, outputs_per_request: null,
      },
    ])
  }

  const response = await request(app).get('/api/app-settings/genstudio/music-models').expect(200)
  assert.deepEqual(response.body.models, [
    {
      id: 'music-local-v1', display_name: 'Local Music', provider_name: 'Studio Hub',
      description: 'Local instrumental generation', coming_soon: false,
      credits_per_request: 0, minimum_credits: 0, price_version: 'music-price-v1',
      standard_credits: null, sale_credits: null, sale_ends_at: null, sale_disclaimer: null,
      supports_instrumental: true, supports_vocals: false, requires_lyrics: true,
      max_prompt_characters: 2_000, max_prompt_without_lyrics_characters: 1_200,
      min_prompt_characters: 1, max_lyrics_characters: 5_000, min_lyrics_characters: 1,
      max_title_characters: 256, outputs_per_request: 2,
    },
    {
      id: 'music-unannounced-v1', display_name: 'Unannounced Music', description: 'Not launched yet',
      coming_soon: true, credits_per_request: 50, minimum_credits: 10, price_version: 'music-price-v2',
      standard_credits: 60, sale_credits: 50, sale_ends_at: '2026-09-01T00:00:00Z', sale_disclaimer: 'Launch sale',
      supports_instrumental: true, supports_vocals: true, requires_lyrics: false,
      max_prompt_characters: 2_000, max_prompt_without_lyrics_characters: null,
      min_prompt_characters: 1, max_lyrics_characters: 5_000, min_lyrics_characters: 1,
      max_title_characters: 256, outputs_per_request: null,
    },
  ])
})

test('the published voice libraries are named after their providers', async () => {
  const response = await request(app).get('/api/app-settings/genstudio/voice-libraries').expect(200)
  assert.deepEqual(response.body.libraries, [
    { id: 'elevenlabs', label: 'ElevenLabs', provider_id: 'elevenlabs-direct' },
    { id: 'fish', label: 'Fish Audio', provider_id: 'fish-audio' },
  ])
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
        variants: [{ operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 12, minimum_credits: 12, price_version: 'video-v1' }],
      }])
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const capabilities = await request(app).get('/api/app-settings/genstudio/models').expect(200)
  assert.equal(capabilities.body.models.length, 2)

  const chat = await request(app).get('/api/app-settings/genstudio/chat-models').expect(200)
  assert.deepEqual(chat.body.models.map((model: any) => model.id), ['chat-v1'])

  const video = await request(app).get('/api/app-settings/genstudio/video-models').expect(200)
  assert.deepEqual(video.body.models.map((model: any) => model.id), ['video-v1'])
  assert.equal(video.body.models[0].available, false)
})

test('GenStudio cost tiers pass through every Story catalog response without replacing catalog facts', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_cost_tier_catalog' })
    .expect(200)

  globalThis.fetch = async (input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_cost_tier_catalog')
    const url = String(input)
    if (url.endsWith('/v1/tts/models')) return Response.json([{
      id: 'tts-tier-v1', display_name: 'Tier TTS', provider_id: 'tts-provider', provider_name: 'Published TTS provider',
      description: 'Narration', credits_per_1000_characters: 48, minimum_credits: 10,
      maximum_input_characters: 12_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
      preview_policy: 'catalog', generation_enabled: true, cost_tier: 'economy',
    }])
    if (url.endsWith('/v1/chat/models')) return Response.json([{
      id: 'chat-tier-v1', display_name: 'Tier Chat', provider_name: 'Published chat provider',
      available: true, qualification_only: false, context_window_tokens: 32_768, max_output_tokens: 8_192,
      controls: [], activation_blockers: [], input_credits_per_million_tokens: 12,
      output_credits_per_million_tokens: 24, minimum_credits: 3, price_version: 'chat-tier-price-v1',
      supports_vision: true, max_input_images: 1, accepted_image_mime_types: ['image/png'],
      max_image_bytes: 4_000_000, max_image_dimension: 2_048, supported_detail_levels: ['high'],
      supports_structured_output: true, supports_web_search: true, returns_citations: true,
      citation_format: 'structured', supports_domain_filters: true, research_qualified: true,
      cost_tier: 'economy',
    }])
    if (url.endsWith('/v1/videos/models')) return Response.json([{
      id: 'video-tier-v1', display_name: 'Tier Video', available: true, cost_tier: 'premium',
      modes: ['image-to-video'], aspect_ratios: ['16:9'],
      variants: [{ operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 12, minimum_credits: 12, price_version: 'video-tier-price-v1' }],
    }])
    if (url.endsWith('/v1/transcription/models')) return Response.json([{
      id: 'transcription-tier-v1', display_name: 'Tier Transcription', provider: 'Published transcription provider',
      language: 'multilingual', available: true, available_workers: 2, qualification_only: false,
      credits_per_second: 1, minimum_credits: 3, price_version: 'transcription-tier-price-v1', cost_tier: 'balanced',
    }])
    if (url.endsWith('/v1/image/models')) return Response.json([{
      id: 'image-tier-v1', display_name: 'Tier Image', provider_name: 'Published image provider',
      available: true, qualification_only: false, credits_per_image: 4, minimum_credits: 4,
      price_version: 'image-tier-price-v1', base_credits_per_image: 6, chargeable: true,
      aspect_ratios: ['16:9'], default_aspect_ratio: '16:9', supports_reference_images: true,
      max_reference_images: 1, reference_strength_mode: 'none', supported_reference_strengths: [], cost_tier: 'balanced',
    }])
    if (url.endsWith('/v1/music/models')) return Response.json([{
      id: 'music-tier-v1', display_name: 'Tier Music', provider_name: 'Published music provider', description: 'Music',
      coming_soon: false, credits_per_request: 20, minimum_credits: 8, price_version: 'music-tier-price-v1',
      standard_credits: 24, sale_credits: 20, sale_ends_at: null, sale_disclaimer: null,
      supports_instrumental: true, supports_vocals: true, requires_lyrics: false,
      max_prompt_characters: 2_000, max_prompt_without_lyrics_characters: null,
      min_prompt_characters: 1, max_lyrics_characters: 5_000, min_lyrics_characters: 1,
      max_title_characters: 256, outputs_per_request: 1, cost_tier: 'premium',
    }])
    throw new Error(`Unexpected request: ${url}`)
  }

  const [tts, chat, video, transcription, image, music] = await Promise.all([
    request(app).get('/api/app-settings/genstudio/tts-models').expect(200),
    request(app).get('/api/app-settings/genstudio/chat-models').expect(200),
    request(app).get('/api/app-settings/genstudio/video-models').expect(200),
    request(app).get('/api/app-settings/genstudio/transcription-models').expect(200),
    request(app).get('/api/app-settings/genstudio/image-models').expect(200),
    request(app).get('/api/app-settings/genstudio/music-models').expect(200),
  ])
  assert.equal(tts.body.models[0].cost_tier, 'economy')
  assert.equal(chat.body.models[0].cost_tier, 'economy')
  assert.equal(video.body.models[0].cost_tier, 'premium')
  assert.equal(transcription.body.models[0].cost_tier, 'balanced')
  assert.equal(image.body.models[0].cost_tier, 'balanced')
  assert.equal(music.body.models[0].cost_tier, 'premium')
  assert.equal(chat.body.models[0].provider_name, 'Published chat provider')
  assert.equal(chat.body.models[0].price_version, 'chat-tier-price-v1')
  assert.equal(image.body.models[0].credits_per_image, 4)

  const models = await request(app).get('/api/models').expect(200)
  assert.equal(models.body[0].cost_tier, 'economy')
  assert.equal(models.body[0].input_credits_per_million_tokens, 12)
  assert.equal(models.body[0].output_credits_per_million_tokens, 24)
  assert.equal(models.body[0].minimum_credits, 3)
  assert.equal(models.body[0].price_version, 'chat-tier-price-v1')

  const webModels = await request(app).get('/api/research/web-models').expect(200)
  assert.equal(webModels.body.models[0].cost_tier, 'economy')

  const project = await request(app).post('/api/projects').send({ name: 'Cost tier picker' }).expect(201)
  const visionModels = await request(app)
    .get(`/api/projects/${project.body.slug}/thumbnail-reference/vision-models`)
    .expect(200)
  assert.equal(visionModels.body.models[0].cost_tier, 'economy')
  assert.equal(visionModels.body.models[0].input_credits_per_million_tokens, 12)
  assert.equal(visionModels.body.models[0].output_credits_per_million_tokens, 24)
  assert.equal(visionModels.body.models[0].minimum_credits, 3)
  assert.equal(visionModels.body.models[0].price_version, 'chat-tier-price-v1')
})

test('GenStudio transcription discovery uses the same scoped boundary key', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_story_catalog' })
    .expect(200)

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8787/v1/transcription/models')
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
    // The account's own published voice models. The voice probe is scoped by
    // the first id here — never by a name written in this test or the route.
    if (url.endsWith('/v1/tts/models')) return Response.json([{ id: 'tts-probe' }])
    return Response.json([])
  }

  const response = await request(app)
    .post('/api/app-settings/api-keys/genstudio/test')
    .send({ apiKey: 'gsk_all_story_scopes' })
    .expect(200)

  assert.equal(response.body.valid, true)
  assert.match(response.body.message, /catalogs and TTS, transcription, image, LLM, music, and video job access/)
  assert.equal(response.body.usage_available, false)
  assert.match(response.body.warning, /usage:read/)
  assert.deepEqual(response.body.content_store, {
    read_scope: 'verified',
    purchase_scope: 'required_unverified',
  })
  assert.deepEqual(visited, [
    // Resolved first, so the voice probe below can be scoped by a real model id.
    'http://127.0.0.1:8787/v1/tts/models',
    'http://127.0.0.1:8787/v1/models',
    'http://127.0.0.1:8787/v1/transcription/models',
    'http://127.0.0.1:8787/v1/image/models',
    'http://127.0.0.1:8787/v1/videos/models',
    'http://127.0.0.1:8787/v1/music/models',
    'http://127.0.0.1:8787/v1/jobs/story-studio-key-probe',
    'http://127.0.0.1:8787/v1/chat/responses/story-studio-key-probe',
    'http://127.0.0.1:8787/v1/images/story-studio-key-probe',
    'http://127.0.0.1:8787/v1/transcriptions/story-studio-key-probe',
    'http://127.0.0.1:8787/v1/videos/story-studio-key-probe',
    'http://127.0.0.1:8787/v1/content/account',
    'http://127.0.0.1:8787/v1/voices?model_id=tts-probe',
    'http://127.0.0.1:8787/v1/account/overview',
  ])
})

test('GenStudio key test names content:read and never probes the debit endpoint', async () => {
  const visited: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    visited.push(url)
    if (url.endsWith('/v1/content/account')) {
      return Response.json({ detail: 'missing scope' }, { status: 401 })
    }
    if (url.includes('story-studio-key-probe')) return new Response(null, { status: 404 })
    if (url.endsWith('/v1/tts/models')) return Response.json([])
    return Response.json([])
  }

  const response = await request(app)
    .post('/api/app-settings/api-keys/genstudio/test')
    .send({ apiKey: 'gsk_missing_content_read' })
    .expect(200)

  assert.equal(response.body.valid, false)
  assert.equal(response.body.reachable, true)
  assert.match(response.body.message, /content:read/)
  assert.ok(visited.some(url => url.endsWith('/v1/content/account')))
  assert.ok(!visited.some(url => url.includes('/v1/content/purchases')), 'a key test must never exercise the debit endpoint')
  assert.ok(!visited.some(url => url.includes('/v1/content/quotes')), 'a key test does not need to create a quote')
})

test('GenStudio key test names music:generate when the music catalog is not authorized', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/v1/music/models')) {
      return Response.json({ detail: 'authentication required' }, { status: 401 })
    }
    if (url.includes('story-studio-key-probe')) return new Response(null, { status: 404 })
    if (url.endsWith('/v1/tts/models')) return Response.json([])
    return Response.json([])
  }

  const response = await request(app)
    .post('/api/app-settings/api-keys/genstudio/test')
    .send({ apiKey: 'gsk_missing_music_scope' })
    .expect(200)

  assert.equal(response.body.valid, false)
  assert.equal(response.body.reachable, true)
  assert.match(response.body.message, /music:generate/)
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
    assert.match(url, /^http:\/\/127\.0\.0\.1:8787\/v1\/account\//)
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gsk_missing_usage_scope')
    return Response.json({ detail: 'missing usage:read' }, { status: 403 })
  }

  const response = await request(app)
    .get('/api/app-settings/genstudio/usage')
    .expect(503)

  assert.equal(response.body.code, 'GENSTUDIO_USAGE_SCOPE_UNAVAILABLE')
  assert.match(response.body.detail, /invalid or missing usage:read/i)
  assert.match(response.body.detail, /GenStudio key with usage:read/i)
  assert.match(response.body.detail, /all-access keys already include it/i)
  assert.doesNotMatch(response.body.detail, /after GenStudio exposes/i)
  assert.deepEqual(visited, ['http://127.0.0.1:8787/v1/account/overview'])
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
    'http://127.0.0.1:8787/v1/account/overview',
    'http://127.0.0.1:8787/v1/account/jobs?page=1&page_size=20',
    'http://127.0.0.1:8787/v1/account/credit-activity?page=1&page_size=20',
  ].sort())
})

/**
 * ── S2 + S3: every voice read is scoped to a model ─────────────────────────
 *
 * `GET /v1/voices` on GenStudio REQUIRES `model_id` (ADR-0016: TTS is
 * model-first, and voices are not portable across engines). An unscoped ask is
 * a 422 by design. Story Studio used to make one in two places: the API-key
 * health check, which then reported a perfectly healthy key as broken, and the
 * voice picker, which surfaced the 422 as a broken catalogue instead of a
 * missing selection.
 */

test('the voice picker asks for a model instead of making a call GenStudio must refuse', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_unscoped_voice_ask' })
    .expect(200)

  globalThis.fetch = async (input) => {
    throw new Error(`No unscoped voice request may be made: ${String(input)}`)
  }

  const response = await request(app).get('/api/app-settings/genstudio/voices')
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'GENSTUDIO_TTS_MODEL_REQUIRED')
  assert.match(response.body.detail, /Choose a voice model first/)
  // Not paraphrased as a catalogue outage — it is a selection that has not been
  // made yet, and the message says so.
  assert.doesNotMatch(response.body.detail, /unavailable|broken|failed/i)
})

test('the key test scopes its voice probe, and skips it when no voice model is published', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_no_voice_models' })
    .expect(200)

  const visited: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    visited.push(url)
    if (url.includes('story-studio-key-probe')) return new Response(null, { status: 404 })
    if (url.endsWith('/v1/account/overview')) return Response.json({ credit_balance: 10 })
    return Response.json([])
  }

  const response = await request(app)
    .post('/api/app-settings/api-keys/genstudio/test')
    .send({ apiKey: 'gsk_no_voice_models' })
    .expect(200)

  // An account with no published voice model has nothing to scope a voice probe
  // by. Skipping it is honest; failing it blamed the key for a question that
  // could not be asked.
  assert.equal(response.body.valid, true)
  assert.ok(!visited.some(url => url.includes('/v1/voices')), 'no unscoped voice probe may be made')
})

test('a disconnected Content Store is reported as not connected, never as a bad key or URL', async () => {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_store_not_connected' })
    .expect(200)

  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('story-studio-key-probe')) return new Response(null, { status: 404 })
    if (url.endsWith('/v1/content/account')) {
      return Response.json({
        detail: 'Content Store is not connected. The private Pack Library preserves archives, but Story Studio requires verified account ownership, receipts and trusted signing keys before installation.',
        code: 'CONTENT_STORE_NOT_CONNECTED',
      }, { status: 503 })
    }
    if (url.endsWith('/v1/account/overview')) return Response.json({ credit_balance: 10 })
    return Response.json([])
  }

  const response = await request(app)
    .post('/api/app-settings/api-keys/genstudio/test')
    .send({ apiKey: 'gsk_store_not_connected' })
    .expect(200)

  // The gateway's deliberate CONTENT_STORE_NOT_CONNECTED stub is a fact about
  // the gateway's Store, not evidence the key or URL is wrong.
  assert.equal(response.body.valid, true, 'a disconnected Store must not invalidate a working key')
  assert.equal(response.body.content_store.read_scope, 'not_connected')
  assert.doesNotMatch(String(response.body.message), /Check the API URL and key/i)
})
