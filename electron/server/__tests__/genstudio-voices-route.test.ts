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
      { id: 'voice_qwen3_ryan', display_name: 'Ryan', language: 'en' },
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
})
