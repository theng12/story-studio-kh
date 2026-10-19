/**
 * The Gateway publishes `chargeable` on EVERY catalogue row (`catalog._story_row`)
 * and on every voice row (`voices.story_row`). It is the flag production reads to
 * verify a free model is free — a `studio-hub` model on the owner's Macs says
 * `chargeable: false`, and Story Studio's audio gate blocks the run when the
 * field never arrives.
 *
 * It arrived for chat, image and music and was DROPPED by TTS, video,
 * transcription and voices, because each parser hand-listed its own fields.
 * These tests pin the rule at the ROUTE — the boundary the customer actually
 * reads — for every modality that publishes it:
 *
 *   published `false` → `false`   (the Gateway said it cannot cost money)
 *   published `true`  → `true`
 *   absent            → the key is absent, never invented as `false` or `true`
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
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
  clearGenStudioCatalogCache()
  await cleanup()
})

/** Save the Gateway key the routes require, before any catalogue fetch is stubbed. */
async function saveGatewayKey() {
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_test_chargeable' })
    .expect(200)
}

/**
 * Serve one stubbed catalogue for the whole test, and hand back a reader that
 * answers with the rows in order: published-false, published-true, unpublished.
 */
function stubCatalogue(urlSuffix: string, rows: unknown[]) {
  clearGenStudioCatalogCache()
  globalThis.fetch = async (input) => {
    assert.match(String(input), new RegExp(`${urlSuffix}$`), `unexpected catalogue call: ${input}`)
    return Response.json(rows)
  }
}

/** `chargeable` as it reached the route: `false`, `true`, or undefined when the key never crossed. */
function chargeableOf(row: any): boolean | undefined {
  return row?.chargeable
}

function hasChargeableKey(row: any): boolean {
  return Object.hasOwn(row ?? {}, 'chargeable')
}

test('a TTS model row carries the published chargeable flag, and invents none', async () => {
  await saveGatewayKey()
  const ttsRow = (id: string, chargeable?: unknown) => ({
    id,
    display_name: id,
    provider_id: 'studio-hub',
    provider_name: 'Studio Hub',
    description: '',
    credits_per_1000_characters: 0,
    minimum_credits: 0,
    maximum_input_characters: 4_000,
    price_source: 'local',
    ...(chargeable === undefined ? {} : { chargeable }),
  })
  stubCatalogue('/v1/tts/models', [
    ttsRow('tts-free', false),
    ttsRow('tts-paid', true),
    ttsRow('tts-silent'),
  ])

  const response = await request(app).get('/api/app-settings/genstudio/tts-models')
  assert.equal(response.status, 200)
  const byId = (id: string) => response.body.models.find((model: any) => model.id === id)
  assert.equal(chargeableOf(byId('tts-free')), false, 'a free model reaches the page as free')
  assert.equal(chargeableOf(byId('tts-paid')), true)
  assert.equal(hasChargeableKey(byId('tts-silent')), false, 'an unpublished flag stays absent')
})

test('a transcription model row carries the published chargeable flag, and invents none', async () => {
  await saveGatewayKey()
  const transcriptionRow = (id: string, chargeable?: unknown) => ({
    id,
    display_name: id,
    provider: 'studio-hub',
    credits_per_second: 0,
    minimum_credits: 0,
    price_source: 'local',
    ...(chargeable === undefined ? {} : { chargeable }),
  })
  stubCatalogue('/v1/transcription/models', [
    transcriptionRow('whisper-free', false),
    transcriptionRow('whisper-paid', true),
    transcriptionRow('whisper-silent'),
  ])

  const response = await request(app).get('/api/app-settings/genstudio/transcription-models')
  assert.equal(response.status, 200)
  const byId = (id: string) => response.body.models.find((model: any) => model.id === id)
  assert.equal(chargeableOf(byId('whisper-free')), false)
  assert.equal(chargeableOf(byId('whisper-paid')), true)
  assert.equal(hasChargeableKey(byId('whisper-silent')), false)
})

test('a video model row carries the published chargeable flag, and invents none', async () => {
  await saveGatewayKey()
  const videoRow = (id: string, chargeable?: unknown) => ({
    id,
    display_name: id,
    available: true,
    price_source: 'local',
    ...(chargeable === undefined ? {} : { chargeable }),
  })
  stubCatalogue('/v1/videos/models', [
    videoRow('chargeable-video-free', false),
    videoRow('chargeable-video-paid', true),
    videoRow('chargeable-video-silent'),
  ])

  const response = await request(app).get('/api/app-settings/genstudio/video-models')
  assert.equal(response.status, 200)
  const byId = (id: string) => response.body.models.find((model: any) => model.id === id)
  assert.equal(chargeableOf(byId('chargeable-video-free')), false)
  assert.equal(chargeableOf(byId('chargeable-video-paid')), true)
  assert.equal(hasChargeableKey(byId('chargeable-video-silent')), false)
})

test('a voice row carries the published chargeable flag, and invents none', async () => {
  await saveGatewayKey()
  const voiceRow = (id: string, chargeable?: unknown) => ({
    id,
    display_name: id,
    language: 'en',
    credits_per_1000_characters: 0,
    price_source: 'local',
    ...(chargeable === undefined ? {} : { chargeable }),
  })
  stubCatalogue('/v1/voices\\?model_id=tts-chargeable', [
    voiceRow('voice-free', false),
    voiceRow('voice-paid', true),
    voiceRow('voice-silent'),
  ])

  const response = await request(app).get('/api/app-settings/genstudio/voices?model_id=tts-chargeable')
  assert.equal(response.status, 200)
  const byId = (id: string) => response.body.voices.find((voice: any) => voice.id === id)
  assert.equal(chargeableOf(byId('voice-free')), false)
  assert.equal(chargeableOf(byId('voice-paid')), true)
  assert.equal(hasChargeableKey(byId('voice-silent')), false)
})
