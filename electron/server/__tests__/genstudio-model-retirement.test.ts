/**
 * GenStudio's retirement schedule is read from the catalogue, never authored here.
 *
 * `GET /v1/chat/models` publishes six lifecycle fields on every row:
 * `deprecation_warning`, `deprecation_warning_at`, `scheduled_retirement_at`,
 * `upstream_shutdown_at`, `retires_at` and `replacement_model_id`. Story Studio
 * mapped none of them, so the only thing the app could ever say about a
 * retirement was said AFTER the fact — "this model is retired or unavailable" —
 * at the moment a saved choice had already stopped working. A countdown running
 * on the server for weeks reached nobody.
 *
 * This is the third time the same shape has bitten: the credit-balance
 * freshness, then `discount_disclaimer` (1.4.70), now this. The failure is
 * always the whitelist in `/api/models` — the client mapper and the route each
 * enumerate fields, and a field GenStudio adds is dropped by BOTH silently.
 * These tests exercise the whole path rather than the mapper alone, because a
 * mapper that parses a field the route then discards is exactly the bug.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let app: any
let clearCache: () => void
let cleanup: () => Promise<void>
let originalFetch: typeof globalThis.fetch

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  clearCache = (await import('../lib/genstudio-client.js')).clearGenStudioCatalogCache
  originalFetch = globalThis.fetch
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_retirement' })
    .expect(200)
})

after(async () => {
  globalThis.fetch = originalFetch
  await cleanup()
})

function chatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalog-row-a',
    display_name: 'Catalog Row A',
    available: true,
    qualification_only: false,
    context_window_tokens: 128_000,
    max_output_tokens: 8_192,
    price_version: 'chat-price-v1',
    ...overrides,
  }
}

function publishing(rows: unknown[]): void {
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input)
    if (url.includes('/v1/chat/models')) return Response.json(rows)
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof globalThis.fetch
}

// Instants, not dates this app believes in. Every one of these arrives from the
// fixture the way GenStudio would send it; nothing here is a constant Story
// Studio would ever reach for on its own.
const WARNED_AT = '2026-07-18T00:00:00Z'
const SCHEDULED = '2026-10-15T00:00:00Z'
const WITHDRAWN = '2026-10-15T00:00:00Z'
const UPSTREAM = '2026-10-16T00:00:00Z'

test('the whole published schedule reaches the picker', async () => {
  clearCache()
  publishing([chatRow({
    deprecation_warning: true,
    deprecation_warning_at: WARNED_AT,
    scheduled_retirement_at: SCHEDULED,
    upstream_shutdown_at: UPSTREAM,
    retires_at: WITHDRAWN,
    replacement_model_id: 'catalog-row-b',
  })])
  const row = (await request(app).get('/api/models').expect(200)).body[0]
  assert.equal(row.deprecation_warning, true, 'the warning window flag survives the whitelist')
  assert.equal(row.deprecation_warning_at, new Date(WARNED_AT).toISOString())
  assert.equal(row.scheduled_retirement_at, new Date(SCHEDULED).toISOString())
  assert.equal(row.retires_at, new Date(WITHDRAWN).toISOString())
})

test('the provider shutdown and the customer withdrawal stay separate facts', async () => {
  clearCache()
  // GenStudio withdraws a day BEFORE the provider shuts down, on purpose, so a
  // customer meets an absence rather than a failure. Collapsing the two into
  // one field would throw away the very margin that decision buys.
  publishing([chatRow({
    deprecation_warning: true,
    retires_at: WITHDRAWN,
    upstream_shutdown_at: UPSTREAM,
  })])
  const row = (await request(app).get('/api/models').expect(200)).body[0]
  assert.equal(row.retires_at, new Date(WITHDRAWN).toISOString())
  assert.equal(row.upstream_shutdown_at, new Date(UPSTREAM).toISOString())
  assert.notEqual(row.retires_at, row.upstream_shutdown_at)
})

test('a product with no retirement carries none, rather than a default', async () => {
  clearCache()
  publishing([chatRow()])
  const row = (await request(app).get('/api/models').expect(200)).body[0]
  assert.equal(row.deprecation_warning, false)
  assert.equal(row.deprecation_warning_at, null)
  assert.equal(row.scheduled_retirement_at, null)
  assert.equal(row.upstream_shutdown_at, null)
  assert.equal(row.retires_at, null)
  assert.equal(row.replacement_model_id, null)
})

test('an unparseable date is absent, never a date this app made up', async () => {
  clearCache()
  // The worst possible response to junk is a plausible substitute: a customer
  // cannot tell an invented withdrawal date from a real one.
  publishing([chatRow({ deprecation_warning: true, retires_at: 'sometime in October' })])
  const row = (await request(app).get('/api/models').expect(200)).body[0]
  assert.equal(row.deprecation_warning, true, 'the flag is still a published fact')
  assert.equal(row.retires_at, null)
})

test('the successor is carried through the transport, and shown by nobody', async () => {
  clearCache()
  // Carried deliberately: dropping a field at the transport layer is a separate
  // decision from not displaying it, and a change of mind should be a UI change
  // rather than a plumbing change. No surface reads it — the picker promises it
  // will not switch products automatically, and naming one successor would
  // quietly steer the choice it promises to leave alone.
  publishing([chatRow({ deprecation_warning: true, replacement_model_id: 'catalog-row-b' })])
  const row = (await request(app).get('/api/models').expect(200)).body[0]
  assert.equal(row.replacement_model_id, 'catalog-row-b')
})

test('the settings catalogue carries the schedule too, so both surfaces agree', async () => {
  clearCache()
  publishing([chatRow({ deprecation_warning: true, retires_at: WITHDRAWN })])
  const response = await request(app).get('/api/app-settings/genstudio/chat-models').expect(200)
  assert.equal(response.body.models[0].deprecation_warning, true)
  assert.equal(response.body.models[0].retires_at, new Date(WITHDRAWN).toISOString())
})

test('the warning window is GenStudio\'s call, never re-derived from the dates', async () => {
  clearCache()
  // A published withdrawal date with the window still CLOSED. How much notice a
  // customer gets is GenStudio's decision; a second policy here would disagree
  // with it the first time GenStudio moved a date. The flag is forwarded as
  // false and the picker stays quiet.
  publishing([chatRow({ deprecation_warning: false, retires_at: WITHDRAWN })])
  const row = (await request(app).get('/api/models').expect(200)).body[0]
  assert.equal(row.deprecation_warning, false)
  assert.equal(row.retires_at, new Date(WITHDRAWN).toISOString())
})

// ── the other two pickers ────────────────────────────────────────────────
//
// `/api/models` is not the only route that reshapes a chat model for a picker.
// Two more do, each with its own field whitelist, and each is a place a
// customer commits to a product. A payload that states the price but not the
// withdrawal date is precisely how this went unseen the first time.

test('the thumbnail-reference vision list carries the retirement', async () => {
  clearCache()
  publishing([chatRow({
    supports_vision: true,
    input_modalities: ['text', 'image'],
    max_input_images: 1,
    accepted_image_mime_types: ['image/png'],
    max_image_bytes: 1_000_000,
    max_image_dimension: 2_000,
    supported_detail_levels: ['auto'],
    supports_structured_output: true,
    structured_output_mode: 'request_json_schema',
    deprecation_warning: true,
    retires_at: WITHDRAWN,
  })])
  const created = await request(app).post('/api/projects').send({ name: 'Retirement Probe' }).expect(201)
  const slug = created.body.slug || created.body.project?.slug
  const response = await request(app)
    .get(`/api/projects/${slug}/thumbnail-reference/vision-models`)
    .expect(200)
  const row = response.body.models.find((model: any) => model.id === 'catalog-row-a')
  assert.ok(row, 'the eligible model is listed')
  assert.equal(row.deprecation_warning, true)
  assert.equal(row.retires_at, new Date(WITHDRAWN).toISOString())
})

test('a vision model is eligible on what IS published, not on limits nobody states', async () => {
  clearCache()
  // The regression this pins: eligibility required `max_input_images >= 1` and a
  // non-empty `supported_detail_levels`, and the gateway publishes **neither** —
  // the parse turns their absence into 0 and []. So every model failed the gate
  // and the thumbnail-reference feature could not run at all, while the one fact
  // that decides it (`supports_vision: true`, published from the provider's own
  // `architecture.input_modalities`) sat unread beside them. WIRE-3, doing real
  // damage rather than merely leaving a field empty.
  publishing([chatRow({
    supports_vision: true,
    input_modalities: ['text', 'image'],
    supports_structured_output: true,
    structured_output_mode: 'request_json_schema',
    // No max_input_images, no supported_detail_levels, no image limits: exactly
    // what a real gateway row carries today.
  })])
  const created = await request(app).post('/api/projects').send({ name: 'Vision Gate Probe' }).expect(201)
  const slug = created.body.slug || created.body.project?.slug
  const response = await request(app)
    .get(`/api/projects/${slug}/thumbnail-reference/vision-models`)
    .expect(200)
  const row = response.body.models.find((model: any) => model.id === 'catalog-row-a')
  assert.ok(row, 'a model that states image input is eligible without per-image limits')
  // And the menu is told whose choices these are, so a level Story picked is
  // never presented as the model's own.
  assert.equal(row.detail_source, 'story')
  assert.equal(row.reference_limits_source, 'story')

  // A model that states its own levels and limits keeps them, labelled as its.
  clearCache()
  publishing([chatRow({
    supports_vision: true,
    input_modalities: ['text', 'image'],
    supports_structured_output: true,
    max_input_images: 2,
    accepted_image_mime_types: ['image/png'],
    max_image_bytes: 1_000_000,
    max_image_dimension: 2_000,
    supported_detail_levels: ['high'],
  })])
  const second = await request(app)
    .get(`/api/projects/${slug}/thumbnail-reference/vision-models`)
    .expect(200)
  const stated = second.body.models.find((model: any) => model.id === 'catalog-row-a')
  assert.ok(stated)
  assert.equal(stated.detail_source, 'model')
  assert.equal(stated.reference_limits_source, 'model')

  // And a model that does NOT state image input stays out.
  clearCache()
  publishing([chatRow({ supports_vision: false })])
  const third = await request(app)
    .get(`/api/projects/${slug}/thumbnail-reference/vision-models`)
    .expect(200)
  assert.equal(third.body.models.length, 0)
})

test('the web-research option carries it too', async () => {
  const { toWebResearchModelOption } = await import('../services/research/web-capability.js')
  const retiring = toWebResearchModelOption({
    id: 'catalog-row-a',
    display_name: 'Catalog Row A',
    deprecation_warning: true,
    retires_at: new Date(WITHDRAWN).toISOString(),
  } as any)
  assert.equal(retiring.deprecation_warning, true)
  assert.equal(retiring.retires_at, new Date(WITHDRAWN).toISOString())
  // And a product with no retirement states none, rather than a default.
  const healthy = toWebResearchModelOption({ id: 'catalog-row-b', display_name: 'Catalog Row B' } as any)
  assert.equal(healthy.deprecation_warning, false)
  assert.equal(healthy.retires_at, null)
})
