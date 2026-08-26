/**
 * GenStudio's data disclosure is read from the catalogue, never authored here.
 *
 * `GET /v1/chat/models` publishes `discount` (boolean) and
 * `discount_disclaimer` (string | null). Story Studio mapped `provider_name`,
 * `display_name`, `context_window_tokens` and the price fields, and dropped
 * this one on the floor — so a notice that exists only on the server reached
 * nobody, because language models are offered only inside this app.
 *
 * `sale_disclaimer` is NOT this. That is a price-promotion notice on a
 * different catalogue and means something else; the two must never share a
 * slot.
 *
 * The wording lives on the GenStudio side, in one constant shared between its
 * picker and its terms page. A copy here would be a second source of truth,
 * and softening a word — dropping "by us", or "training" becoming "improving" —
 * changes what a customer was told they agreed to.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let app: any
let clearCache: () => void
let cleanup: () => Promise<void>
let originalFetch: typeof globalThis.fetch

// Supplied the way GenStudio supplies it. This app never contains this string.
const PUBLISHED = 'We offer some models at a reduced price. Data sent to these models may be '
  + 'retained, and may be used for training, by us or by our providers. Capacity is provided by '
  + "the model's host and is not guaranteed — a request may be refused, and you can pick another "
  + 'model and try again. Do not use these models if you do not consent to your data being used this way.'

function chatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gemma-3-27b',
    display_name: 'Gemma 3 27B',
    available: true,
    qualification_only: false,
    context_window_tokens: 128_000,
    max_output_tokens: 8_192,
    price_version: 'chat-price-v1',
    ...overrides,
  }
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  clearCache = (await import('../lib/genstudio-client.js')).clearGenStudioCatalogCache
  originalFetch = globalThis.fetch
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_disclosure' })
    .expect(200)
})

after(async () => {
  globalThis.fetch = originalFetch
  await cleanup()
})

function publishing(rows: unknown[]): void {
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input)
    if (url.includes('/v1/chat/models')) return Response.json(rows)
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof globalThis.fetch
}

test('the disclosure reaches the picker verbatim, exactly as published', async () => {
  clearCache()
  publishing([chatRow({ discount: true, discount_disclaimer: PUBLISHED })])
  const response = await request(app).get('/api/models').expect(200)
  assert.equal(response.body[0].discount, true)
  assert.equal(
    response.body[0].discount_disclaimer,
    PUBLISHED,
    'not paraphrased, not truncated, not re-worded — the same sentence',
  )
})

test('a product publishing no notice carries none, rather than a default', async () => {
  clearCache()
  publishing([chatRow()])
  const response = await request(app).get('/api/models').expect(200)
  assert.equal(response.body[0].discount, false)
  assert.equal(response.body[0].discount_disclaimer, null)
})

test('the flag alone never invents a sentence', async () => {
  clearCache()
  // A flagged product whose sentence GenStudio has not (yet) published. The
  // badge is honest; the words are not Story Studio's to supply.
  publishing([chatRow({ discount: true, discount_disclaimer: null })])
  const response = await request(app).get('/api/models').expect(200)
  assert.equal(response.body[0].discount, true)
  assert.equal(response.body[0].discount_disclaimer, null)
})

test('the settings catalogue carries it too, so both surfaces agree', async () => {
  clearCache()
  publishing([chatRow({ discount: true, discount_disclaimer: PUBLISHED })])
  const response = await request(app).get('/api/app-settings/genstudio/chat-models').expect(200)
  assert.equal(response.body.models[0].discount_disclaimer, PUBLISHED)
})

test('the price promotion field is left strictly alone', async () => {
  clearCache()
  // `sale_disclaimer` means a price promotion, not a data arrangement. A row
  // carrying one and not the other must not acquire the other.
  publishing([chatRow({ sale_disclaimer: 'Half price until Friday.' })])
  const response = await request(app).get('/api/models').expect(200)
  assert.equal(response.body[0].discount, false)
  assert.equal(response.body[0].discount_disclaimer, null)
})
