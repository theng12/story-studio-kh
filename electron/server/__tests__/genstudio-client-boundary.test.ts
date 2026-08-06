import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  getGenStudioAccountOverview,
  GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS,
  GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
  GENSTUDIO_LONG_JOB_TIMEOUT_MS,
  listImageModels,
  listChatModels,
  listModelCapabilities,
  listTranscriptionModels,
  listVoices,
  listVideoModels,
  operationSignal,
  isGenStudioReleaseGenerationUnavailable,
  parseGenStudioRetryAfterMs,
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

test('Story-owned TTS defaults are empty because GenStudio owns the catalog', () => {
  assert.equal(DEFAULT_AUDIO_MODELS['genstudio-qwen3-standard'], undefined)
  const voices = normalizeVoicePresets(DEFAULT_VOICE_PRESETS)
  assert.equal(voices.length, 0)
})

test('only the authoritative exact-release charging failure opens the global submission breaker', () => {
  assert.equal(
    isGenStudioReleaseGenerationUnavailable(
      503,
      'generation is unavailable until charging is enabled for this exact release',
    ),
    true,
  )
  assert.equal(
    isGenStudioReleaseGenerationUnavailable(503, 'temporary provider capacity unavailable'),
    false,
  )
  assert.equal(
    isGenStudioReleaseGenerationUnavailable(
      402,
      'generation is unavailable until charging is enabled for this exact release',
    ),
    false,
  )
})

// The boundary is whatever the SELECTED model publishes. These fixtures pin a
// figure on purpose — that is what a contract test is for — but the client
// itself owns no constant to pin.
const PUBLISHED_MAX_CHARACTERS = 12_000

test('a request exactly at the published boundary stays one GenStudio request', () => {
  const text = 'a'.repeat(PUBLISHED_MAX_CHARACTERS)
  assert.equal(splitGenStudioApiRequests(text, PUBLISHED_MAX_CHARACTERS).length, 1)
  const submission = buildGenStudioSubmission({
    text,
    voiceId: 'voice_live',
    speed: 0.9,
    maxInputCharacters: PUBLISHED_MAX_CHARACTERS,
  })
  assert.equal(submission.body.text.length, PUBLISHED_MAX_CHARACTERS)
})

test('one character over the published boundary splits, and a submission refuses', () => {
  const text = 'a'.repeat(PUBLISHED_MAX_CHARACTERS + 1)
  const requests = splitGenStudioApiRequests(text, PUBLISHED_MAX_CHARACTERS)
  assert.equal(requests.length, 2)
  assert.equal(requests.join(''), text)
  assert.ok(requests.every(part => part.length <= PUBLISHED_MAX_CHARACTERS))
  assert.throws(
    () => buildGenStudioSubmission({ text, voiceId: 'voice_live', speed: 1, maxInputCharacters: PUBLISHED_MAX_CHARACTERS }),
    /12,000/,
  )
})

test('a different published boundary immediately changes where Story Studio splits', () => {
  const text = 'a'.repeat(9_000)
  assert.equal(splitGenStudioApiRequests(text, PUBLISHED_MAX_CHARACTERS).length, 1)
  assert.ok(splitGenStudioApiRequests(text, 4_000).length > 1)
})

test('an unpublished boundary refuses loudly instead of assuming one', () => {
  assert.throws(() => splitGenStudioApiRequests('narration', 0), /maximum_input_characters/)
  assert.throws(
    () => buildGenStudioSubmission({ text: 'narration', voiceId: 'voice_live', speed: 1 }),
    /maximum_input_characters/,
  )
})

test('text longer than the retired 375-character cap remains one GenStudio request', () => {
  const requests = splitGenStudioApiRequests('Long-form narration. '.repeat(30), PUBLISHED_MAX_CHARACTERS)
  assert.equal(requests.length, 1)
  assert.ok(requests[0]!.length > 375)
})

test('GenStudio JSON carries speed and retries reuse the same idempotency key', () => {
  const request = { text: 'A calm long-form sample.', voiceId: 'voice_live', speed: 0.9, maxInputCharacters: PUBLISHED_MAX_CHARACTERS }
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

/**
 * Reconstructs the PRE-v1.0.789 idempotency digest byte-for-byte — the
 * formula as it stood immediately after commit 9842059 ("ask GenStudio for
 * prose instead of prose packed into JSON") shipped, which hashed
 * `output_contract` but never the wire `response_format`. Used below to prove
 * two things about the fix: a stuck v1.0.787-era prose key no longer matches
 * what today's code computes (so a retry escapes the collision), and a
 * JSON-mode key is untouched (so nothing currently in flight is perturbed).
 */
function legacyChatIdempotencyKey(request: {
  modelId: string
  system: string
  userMessage: string
  temperature?: number
  maxOutputTokens?: number
  requestIdentity?: string
  outputContract: { mode: string; name?: string; schema?: unknown }
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    model_id: request.modelId.trim(),
    system: request.system,
    user_message: request.userMessage,
    temperature: request.temperature ?? 0.7,
    top_p: 1,
    max_output_tokens: request.maxOutputTokens ?? 2_048,
    request_identity: request.requestIdentity?.trim() || null,
    input_image: null,
    output_contract: request.outputContract,
  })).digest('hex')
  return `story-chat-${digest.slice(0, 47)}`
}

test('a prose retry after the response_format fix no longer collides with a v1.0.787-era stuck key', () => {
  const proseRequest = {
    modelId: 'genstudio-chat-local-v1',
    system: 'Write the next chapter.',
    userMessage: 'Expand EP0067 batch 1 of 4.',
    temperature: 0.2,
    maxOutputTokens: 4_096,
    requestIdentity: 'boundful:EP0067:expand:1',
    outputContract: { mode: 'prose' as const },
  }

  // What v1.0.787 (and v1.0.788 immediately after it, before this fix) would
  // have computed and sent to GenStudio as the Idempotency-Key. If that batch
  // failed terminally there, GenStudio now holds this exact key against a
  // request_hash built from `{"type":"json_object"}` + the wrapper.
  const stuckLegacyKey = legacyChatIdempotencyKey(proseRequest)

  // What today's code computes for the identical logical request. It now
  // sends `{"type":"text"}` on the wire, and that is reflected in the digest.
  const currentKey = buildGenStudioChatIdempotencyKey(proseRequest)

  assert.notEqual(
    currentKey,
    stuckLegacyKey,
    'a prose retry must get a fresh key, or GenStudio will refuse it as "idempotency key was already used for a different request"',
  )

  // Requirement 3: a genuine retry of the SAME request, on the SAME (current)
  // code, must still land on the SAME key — that is what stops a retry from
  // paying twice. No nonce, no clock: pure function of the request content.
  assert.equal(currentKey, buildGenStudioChatIdempotencyKey(proseRequest))
  assert.equal(currentKey, buildGenStudioChatIdempotencyKey({ ...proseRequest }))
})

test('a JSON Object chat key is untouched by the response_format fix — nothing in flight is perturbed', () => {
  const jsonRequest = {
    modelId: 'genstudio-chat-local-v1',
    system: 'Return verified JSON.',
    userMessage: 'Plan the next scene.',
    temperature: 0.2,
    maxOutputTokens: 4_096,
    requestIdentity: 'boundful:EP0067:scene-plan',
    outputContract: { mode: 'json_object' as const },
  }
  assert.equal(
    buildGenStudioChatIdempotencyKey(jsonRequest),
    legacyChatIdempotencyKey(jsonRequest),
    'json_object wire format has not changed, so its digest must stay byte-identical to avoid double-submitting any job still in flight when this fix ships',
  )
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
          unlimited_relaxed: true, input_credits_per_million_tokens: 10_000,
          output_credits_per_million_tokens: 20_000, minimum_credits: 3, price_version: 'chat-price-v1',
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
    assert.equal(chat[0]?.max_output_tokens, 65_536)
    assert.equal(chat[0]?.available, true)
    assert.equal(chat[0]?.unlimited_relaxed, true)
    assert.equal(chat[0]?.input_credits_per_million_tokens, 10_000)
    assert.equal(chat[0]?.price_version, 'chat-price-v1')
    assert.deepEqual(video[0]?.modes, ['image-to-video'])
    assert.equal(video[0]?.variants[0]?.price_version, 'video-v1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generation confirmation stays local and does not request estimates or quotes', () => {
  const route = readFileSync(new URL('../routes/jobs.ts', import.meta.url), 'utf8')
  const dialog = readFileSync(new URL('../../../frontend/components/GenerationConfirmationDialog.vue', import.meta.url), 'utf8')
  const confirmation = readFileSync(new URL('../../../frontend/composables/useConfirmation.ts', import.meta.url), 'utf8')
  const dashboard = readFileSync(new URL('../../../frontend/pages/projects/[slug]/index.vue', import.meta.url), 'utf8')
  const health = readFileSync(new URL('../routes/health.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(route, /estimate-cost|quoteTts|getModelPricing|getKieCredits|getFalBalance/)
  assert.doesNotMatch(confirmation, /estimate-cost|estimated_credits|quote_status/)
  assert.doesNotMatch(dialog, /Estimated GenStudio credits|price version|pricing basis/i)
  assert.doesNotMatch(dashboard, /Tracked API spend|total_api_cost|allTimeCost/)
  assert.doesNotMatch(health, /usage-tracker\.js/)
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
        // The boundary a live /v1/tts/models row would supply.
        maxInputCharacters: 12_000,
        speed: 1,
      }),
      /did not accept this API key.*valid account key/i,
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
  assert.match(source, /No fallback route was attempted/)
  assert.doesNotMatch(source, /No OpenAI, Studio Hub, or direct Voice Studio fallback/)
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

test('removing the steps field left every image idempotency key byte-identical', () => {
  // Recorded from the build that still sent `steps` on the wire. Every image
  // request this app ever made carried steps=4 (the catalogue mapper's
  // fallback, because GenStudio publishes no step contract), so freezing that
  // component keeps a retry that crosses the upgrade boundary on the SAME key
  // — it replays the in-flight job instead of submitting and billing a second.
  assert.equal(
    buildGenStudioImageIdempotencyKey({
      prompt: 'A calm river at dusk.',
      modelId: 'genstudio-image-fast-v1',
      aspectRatio: '16:9',
      requestIdentity: 'story-job-1:scene-0001',
    }),
    'story-image-6d52f9d2ec67a232ddab66fa26ca5d00197811081474',
  )
})

test('adding the resolution field left every pre-existing image idempotency key byte-identical', () => {
  // Recorded from the build immediately BEFORE `resolution` reached the image
  // request. `resolution` joins the digest only when a caller actually chose
  // one — the same rule `output_budget` follows in the chat digest — so a
  // retry that crosses this upgrade replays the in-flight job on the key it
  // already used instead of submitting, and billing, a second one.
  const base = {
    prompt: 'A calm river at dusk.',
    modelId: 'genstudio-image-fast-v1',
    aspectRatio: '16:9',
    requestIdentity: 'story-job-1:scene-0001',
  }
  assert.equal(
    buildGenStudioImageIdempotencyKey(base),
    'story-image-6d52f9d2ec67a232ddab66fa26ca5d00197811081474',
  )
  assert.equal(
    buildGenStudioImageIdempotencyKey({ ...base, width: 1920, height: 1080 }),
    'story-image-4d390d98460185543fb6d80cae8009a044689feeacb2',
  )
  assert.equal(
    buildGenStudioImageIdempotencyKey({ ...base, seed: 42, referenceAssetIds: ['asset-1'] }),
    'story-image-5bfe0a512abf204188f5f569ce59185f7a59ffb70a35',
  )
  // An empty/whitespace resolution is "the customer chose none", not a new
  // request — it must not fork the key either.
  assert.equal(buildGenStudioImageIdempotencyKey({ ...base, resolution: '  ' }), buildGenStudioImageIdempotencyKey(base))
  // Two resolutions of the same ratio are different work at different prices
  // and must never share a replay key.
  const oneK = buildGenStudioImageIdempotencyKey({ ...base, resolution: '1K' })
  const twoK = buildGenStudioImageIdempotencyKey({ ...base, resolution: '2K' })
  assert.notEqual(oneK, twoK)
  assert.notEqual(oneK, buildGenStudioImageIdempotencyKey(base))
})

test('GenStudio image catalog carries every published capability and invents none', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/image\/models$/)
      return Response.json([{
          id: 'genstudio-image-fast-v1',
          display_name: 'GenStudio Image Fast',
          aspect_ratios: ['16:9', '4:3'],
          default_aspect_ratio: '16:9',
          default_resolution: '1K',
          execution_label: 'Local fleet',
          availability_note: 'Fleet capacity is limited tonight.',
          base_credits_per_image: 6,
          credits_per_image: 4,
          promotion_name: 'Launch week',
          promotion_discount_percent: 33.3,
          supports_seed: false,
          supports_image_to_image: true,
          min_reference_images: 1,
          max_reference_images: 3,
          reference_image_max_dimension: 2048,
          reference_generation_credits: 9,
          reference_generation_price_version: '2026-07-01',
          max_prompt_characters: 4800,
          prompt_token_allowance: 1200,
          operations: ['image.generation', 'image.edit', 7],
          output_options: [
            { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true, credits_per_image: 4 },
            { resolution: '2K', aspect_ratio: '16:9', width: 2688, height: 1536, is_default: false },
            { resolution: '4K', aspect_ratio: '16:9', width: 0, height: 1536, is_default: false },
          ],
        }])
    }
    const [model] = await listImageModels('scoped-key')
    assert.equal(model?.default_resolution, '1K')
    assert.equal(model?.availability_note, 'Fleet capacity is limited tonight.')
    assert.equal(model?.base_credits_per_image, 6)
    assert.equal(model?.promotion_name, 'Launch week')
    assert.equal(model?.promotion_discount_percent, 33.3)
    assert.equal(model?.supports_seed, false)
    assert.equal(model?.supports_image_to_image, true)
    assert.equal(model?.min_reference_images, 1)
    assert.equal(model?.reference_image_max_dimension, 2048)
    assert.equal(model?.reference_generation_credits, 9)
    assert.equal(model?.reference_generation_price_version, '2026-07-01')
    assert.equal(model?.max_prompt_characters, 4800)
    assert.equal(model?.prompt_token_allowance, 1200)
    assert.deepEqual(model?.operations, ['image.generation', 'image.edit'])
    // A half-published option row is dropped, never patched into validity.
    assert.deepEqual(model?.output_options, [
      {
        resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true,
        credits_per_image: 4, base_credits_per_image: undefined, price_version: undefined,
        reference_generation_credits: undefined, reference_generation_price_version: undefined,
      },
      {
        resolution: '2K', aspect_ratio: '16:9', width: 2688, height: 1536, is_default: false,
        credits_per_image: undefined, base_credits_per_image: undefined, price_version: undefined,
        reference_generation_credits: undefined, reference_generation_price_version: undefined,
      },
    ])
    assert.equal(model?.execution_label, 'Local fleet')
    assert.equal(model?.unlimited_relaxed, true)
    // Story Studio publishes no step contract of its own.
    assert.equal((model as any)?.default_steps, undefined)
    assert.equal((model as any)?.min_steps, undefined)
    assert.equal((model as any)?.max_steps, undefined)
    assert.equal((model as any)?.sizes, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an image model that publishes nothing optional reports nothing optional', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json([{
      id: 'genstudio-image-bare-v1',
      display_name: 'GenStudio Image Bare',
      aspect_ratios: ['16:9'],
      default_aspect_ratio: '16:9',
    }])
    const [model] = await listImageModels('bare-catalog-key')
    for (const field of [
      'availability_note', 'base_credits_per_image', 'promotion_name', 'promotion_discount_percent',
      'default_resolution', 'output_options', 'supports_seed', 'supports_image_to_image',
      'min_reference_images', 'reference_image_max_dimension', 'reference_generation_credits',
      'reference_generation_price_version', 'max_prompt_characters', 'prompt_token_allowance',
      'operations',
    ] as const) {
      assert.equal(
        (model as any)?.[field] ?? undefined, undefined,
        `${field} must stay absent when GenStudio publishes nothing`,
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GenStudio preserves published Unlimited Relaxed account and transcription status', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/account/overview')) {
        return Response.json({
          credit_balance: 0,
          credits_used_30d: 50,
          subscription_plan_name: 'Mekong Studio',
          api_concurrency_limit: 5,
          paid_concurrency_limit: 5,
          paid_active_jobs: 1,
          paid_queued_jobs: 2,
          max_queued_jobs: 250,
          generation_submissions_per_minute: 240,
          relaxed_concurrency_limit: 10,
          total_jobs: 4,
          active_jobs: 1,
          completed_jobs: 3,
          failed_jobs: 0,
          available_assets: 2,
          next_asset_expiration: null,
        })
      }
      if (url.endsWith('/v1/transcription/models')) {
        return Response.json([{
          id: 'genstudio-transcribe-tiny-v1',
          display_name: 'Whisper Tiny',
          provider: 'GenStudio KH',
          language: 'multilingual',
          available: true,
          available_workers: 3,
          qualification_only: false,
          unlimited_relaxed: true,
        }])
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const [overview, models] = await Promise.all([
      getGenStudioAccountOverview('scoped-key'),
      listTranscriptionModels('scoped-key'),
    ])
    assert.equal(overview.subscription_plan_name, 'Mekong Studio')
    assert.equal(overview.paid_concurrency_limit, 5)
    assert.equal(overview.max_queued_jobs, 250)
    assert.equal(overview.relaxed_concurrency_limit, 10)
    assert.equal(models[0]?.unlimited_relaxed, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('concurrent transcription catalog reads share bounded automatic reconnects', async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/transcription\/models$/)
      requests++
      if (requests < 3) throw new TypeError('fetch failed')
      return Response.json([{
        id: 'genstudio-transcribe-fast-v1',
        display_name: 'Whisper Fast',
        provider: 'GenStudio KH',
        language: 'multilingual',
        available: true,
      }])
    }
    const catalogs = await Promise.all(Array.from(
      { length: 12 },
      () => listTranscriptionModels('catalog-reconnect-test-key'),
    ))
    assert.equal(requests, 3)
    assert.ok(catalogs.every(models => models[0]?.id === 'genstudio-transcribe-fast-v1'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GenStudio Retry-After supports seconds and HTTP dates', () => {
  assert.equal(parseGenStudioRetryAfterMs('2.5', 0), 2_500)
  assert.equal(
    parseGenStudioRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', Date.parse('2026-01-01T00:00:00Z')),
    5_000,
  )
  assert.equal(parseGenStudioRetryAfterMs('invalid', 0), null)
  assert.equal(parseGenStudioRetryAfterMs(null, 0), null)
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
        // `steps` is deliberately absent: ImageGenerationRequest does not
        // declare it, so Story Studio never puts one on the wire.
        assert.deepEqual(body, {
          prompt: 'A textured paper collage of hope and renewal.',
          model_id: 'genstudio-image-fast-v1',
          aspect_ratio: '4:3',
          width: 1152,
          height: 864,
          seed: 77,
        })
        assert.match((init?.headers as Record<string, string>)?.['Idempotency-Key'] || '', /^story-image-/)
        return Response.json({
          id: 'image_job_ok', state: 'succeeded', model_id: body.model_id,
          prompt: body.prompt, width: 1024, height: 768, aspect_ratio: body.aspect_ratio,
          steps: 4, seed: body.seed, image_url: '/v1/images/image_job_ok/file',
        }, { status: 202 })
      }
      if (url.endsWith('/v1/images/image_job_ok/file')) return new Response(ONE_PIXEL_PNG)
      throw new Error(`Unexpected request: ${url}`)
    }
    const result = await generateImageWithGenStudio('scoped-key', {
      prompt: 'A textured paper collage of hope and renewal.',
      modelId: 'genstudio-image-fast-v1',
      aspectRatio: '4:3',
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

test('image generation automatically reconnects an accepted task after polling interruption', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  let polls = 0
  let reconnects = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/account/overview')) {
        return Response.json({
          paid_concurrency_limit: 2,
          paid_active_jobs: 0,
          paid_queued_jobs: 0,
          max_queued_jobs: 25,
          generation_submissions_per_minute: 30,
          relaxed_concurrency_limit: 0,
        })
      }
      if (url.endsWith('/v1/images/generations')) {
        posts++
        return Response.json({
          id: 'image_auto_reconnect',
          state: 'running',
          model_id: 'genstudio-image-fast-v1',
          prompt: 'A resilient image request.',
          width: 1024,
          height: 576,
          aspect_ratio: '16:9',
          steps: 4,
        }, { status: 202 })
      }
      if (url.endsWith('/v1/images/image_auto_reconnect')) {
        polls++
        if (polls <= 4) {
          return Response.json({ detail: 'temporary gateway loss' }, {
            status: 503,
            headers: { 'Retry-After': '0' },
          })
        }
        return Response.json({
          id: 'image_auto_reconnect',
          state: 'succeeded',
          model_id: 'genstudio-image-fast-v1',
          prompt: 'A resilient image request.',
          width: 1024,
          height: 576,
          aspect_ratio: '16:9',
          steps: 4,
          image_url: '/v1/images/image_auto_reconnect/file',
        })
      }
      if (url.endsWith('/v1/images/image_auto_reconnect/file')) return new Response(ONE_PIXEL_PNG)
      throw new Error(`Unexpected request: ${url}`)
    }
    const result = await generateImageWithGenStudio('image-auto-reconnect-key', {
      prompt: 'A resilient image request.',
      modelId: 'genstudio-image-fast-v1',
      aspectRatio: '16:9',
      requestIdentity: 'project:EP0001:scene:0001',
      onReconnect: () => { reconnects++ },
    })
    assert.equal(posts, 1)
    assert.equal(reconnects, 1)
    assert.equal(result.jobId, 'image_auto_reconnect')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Story transcription has no direct OpenAI, Studio Hub, or Voice Studio route', () => {
  const generator = readFileSync(new URL('../generators/subtitles.ts', import.meta.url), 'utf8')
  const audioRoutes = readFileSync(new URL('../routes/audio.ts', import.meta.url), 'utf8')
  const pipeline = readFileSync(new URL('../routes/pipeline.ts', import.meta.url), 'utf8')
  assert.match(generator, /transcribeWithGenStudio/)
  assert.doesNotMatch(generator, /transcribeToSrt/)
  assert.doesNotMatch(generator, /transcribeViaConfiguredBackend/)
  assert.doesNotMatch(audioRoutes, /router\.get\('\/voicestudio\/transcribe-availability'/)
  assert.doesNotMatch(audioRoutes, /router\.post\('\/voicestudio\/download-model'/)
  // lib/voicestudio-client.ts is gone entirely — it can no longer offer a
  // '/api/transcribe' route for anything to reach.
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
      if (url.endsWith('/v1/audio/transcriptions/quotes')) {
        const body = init?.body as FormData
        submittedModel = String(body.get('model'))
        assert.equal(init?.method, 'POST')
        assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer scoped-key')
        assert.match((init?.headers as Record<string, string>)?.['Idempotency-Key'] || '', /^story-stt-/)
        return Response.json({ id: 'quote_transcription_ok' }, { status: 201 })
      }
      if (url.endsWith('/v1/audio/transcriptions/quotes/quote_transcription_ok/confirm')) {
        assert.equal(init?.method, 'POST')
        assert.match((init?.headers as Record<string, string>)?.['Idempotency-Key'] || '', /^story-stt-.+-confirm$/)
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

test('transcription automatically reconnects an accepted task after polling interruption', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-genstudio-stt-auto-reconnect-'))
  const audioPath = path.join(dir, 'chapter.wav')
  await fs.writeFile(audioPath, Buffer.from('RIFF-story-audio'))
  const originalFetch = globalThis.fetch
  let posts = 0
  let polls = 0
  let reconnects = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/account/overview')) {
        return Response.json({
          paid_concurrency_limit: 2,
          paid_active_jobs: 0,
          paid_queued_jobs: 0,
          max_queued_jobs: 25,
          generation_submissions_per_minute: 30,
          relaxed_concurrency_limit: 0,
        })
      }
      if (url.endsWith('/v1/audio/transcriptions/quotes')) {
        posts++
        return Response.json({ id: 'quote_stt_auto_reconnect' }, { status: 201 })
      }
      if (url.endsWith('/v1/audio/transcriptions/quotes/quote_stt_auto_reconnect/confirm')) {
        posts++
        return Response.json({
          id: 'stt_auto_reconnect',
          state: 'running',
          model_id: 'mlx-community/whisper-large-v3-turbo',
        }, { status: 202 })
      }
      if (url.endsWith('/v1/transcriptions/stt_auto_reconnect')) {
        polls++
        if (polls <= 4) {
          return Response.json({ detail: 'temporary gateway loss' }, {
            status: 503,
            headers: { 'Retry-After': '0' },
          })
        }
        return Response.json({
          id: 'stt_auto_reconnect',
          state: 'succeeded',
          model_id: 'mlx-community/whisper-large-v3-turbo',
          srt_url: '/v1/transcriptions/stt_auto_reconnect/srt',
        })
      }
      if (url.endsWith('/v1/transcriptions/stt_auto_reconnect/srt')) {
        return new Response('1\n00:00:00,000 --> 00:00:01,000\nRecovered automatically.\n')
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const result = await transcribeWithGenStudio('stt-auto-reconnect-key', {
      audioPath,
      modelId: 'mlx-community/whisper-large-v3-turbo',
      requestIdentity: 'project:EP0001:transcription:chapter-auto-reconnect.srt',
      onReconnect: () => { reconnects++ },
    })
    assert.equal(posts, 2)
    assert.equal(reconnects, 1)
    assert.match(result.srt, /Recovered automatically/)
  } finally {
    globalThis.fetch = originalFetch
    await fs.rm(dir, { recursive: true, force: true })
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
      if (url.endsWith('/v1/audio/transcriptions/quotes')) {
        posts++
        return Response.json({ id: 'quote_download_recovery' }, { status: 201 })
      }
      if (url.endsWith('/v1/audio/transcriptions/quotes/quote_download_recovery/confirm')) {
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
    assert.equal(posts, 2)
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
        // The boundary a live /v1/tts/models row would supply.
        maxInputCharacters: 12_000,
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
      if (url.endsWith('/v1/audio/transcriptions/quotes')) {
        return Response.json({ id: 'quote_transcription_failed' }, { status: 201 })
      }
      if (url.endsWith('/v1/audio/transcriptions/quotes/quote_transcription_failed/confirm')) {
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
      /No fallback route was attempted/,
    )

    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/audio/transcriptions/quotes')) {
        return Response.json({ id: 'quote_transcription_empty' }, { status: 201 })
      }
      if (url.endsWith('/v1/audio/transcriptions/quotes/quote_transcription_empty/confirm')) {
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
