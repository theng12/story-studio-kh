/**
 * The relaxed shelf, read from GenStudio and carried to the pickers.
 *
 * `queue_class` and `relaxed_queue_hint` are additive fields on every chat
 * catalogue row. The deployed GenStudio does not serve them yet, which makes
 * the important assertions in this file the ones about their ABSENCE: a
 * catalogue that has never heard of either must read as one undivided,
 * unannotated list, exactly as it did before this branch.
 *
 * Nothing here is defaulted into existence. There is no fallback percentage,
 * no fallback threshold and no fallback sentence anywhere in Story Studio —
 * a hint GenStudio does not send is a hint that is not shown, and a half-stated
 * offer shown to a paying customer is worse than no offer shown.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { clearGenStudioCatalogCache, listChatModels } from '../lib/genstudio-client.js'
import { toWebResearchModelOption } from '../services/research/web-capability.js'
import { router as healthRouter } from '../routes/health.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { useTempDataDir } from './_helpers.js'

const isolatedDataDir = await useTempDataDir()
after(() => isolatedDataDir.cleanup())

/** A hint exactly as GenStudio sends one. Every figure asserted below is read
 *  back out of this object, so no percentage and no threshold is written into
 *  an assertion as a literal. */
const HINT = {
  discount_percent: 42.5,
  unlock_threshold_cents: 7_500,
  message: 'The owner’s own sentence, carrying neither figure.',
}

const CHAT_BASE = {
  available: true,
  qualification_only: false,
  context_window_tokens: 128_000,
  max_output_tokens: 8_192,
  input_credits_per_million_tokens: 30,
  output_credits_per_million_tokens: 60,
  minimum_credits: 0,
  price_version: 'chat-price-v1',
}

async function servedCatalog(rows: unknown[], key: string) {
  const originalFetch = globalThis.fetch
  clearGenStudioCatalogCache()
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/chat\/models$/)
      return Response.json(rows)
    }
    return await listChatModels(key)
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
}

// ── 1. Read exactly what is published ─────────────────────────────────────

test('a relaxed row carries its shelf, its hint, and both undiscounted rates', async () => {
  const [model] = await servedCatalog([{
    ...CHAT_BASE,
    id: 'relaxed-1',
    display_name: 'Relaxed Product',
    queue_class: 'relaxed',
    relaxed_queue_hint: HINT,
    standard_input_credits_per_million_tokens: 60,
    standard_output_credits_per_million_tokens: 120,
  }], 'relaxed-read-key')

  assert.equal(model?.queue_class, 'relaxed')
  assert.deepEqual(model?.relaxed_queue_hint, HINT)
  assert.equal(model?.standard_input_credits_per_million_tokens, 60)
  assert.equal(model?.standard_output_credits_per_million_tokens, 120)
  // The rates the account actually pays are untouched by any of this.
  assert.equal(model?.input_credits_per_million_tokens, 30)
  assert.equal(model?.output_credits_per_million_tokens, 60)
})

// ── 2. GRACEFUL DEGRADATION — today's deployed API serves none of it ──────

test('a catalogue that has never heard of the fields reads as one direct shelf', async () => {
  const models = await servedCatalog([
    { ...CHAT_BASE, id: 'legacy-1', display_name: 'Legacy One' },
    { ...CHAT_BASE, id: 'legacy-2', display_name: 'Legacy Two' },
  ], 'legacy-catalogue-key')

  assert.equal(models.length, 2)
  for (const model of models) {
    assert.equal(model.queue_class, 'direct', 'the truth for a product that predates the field')
    assert.equal(model.relaxed_queue_hint, null, 'no offer is invented for it')
    assert.equal(model.standard_input_credits_per_million_tokens, null, 'and no second price either')
    assert.equal(model.standard_output_credits_per_million_tokens, null)
  }
})

test('an unrecognised queue_class is the undivided catalogue, not a new shelf', async () => {
  // A section heading a customer has never seen, produced for a value nobody
  // here understands, would mean nothing to them.
  for (const queue_class of ['RELAXED', 'batch', '', null, 7, {}]) {
    const [model] = await servedCatalog(
      [{ ...CHAT_BASE, id: 'odd', display_name: 'Odd', queue_class }],
      `odd-queue-key-${JSON.stringify(queue_class)}`,
    )
    assert.equal(model?.queue_class, 'direct', `${JSON.stringify(queue_class)} must not open a section`)
  }
})

test('an incomplete hint is no hint at all', async () => {
  const broken = [
    { ...HINT, message: '   ' },
    { ...HINT, message: undefined },
    { ...HINT, discount_percent: 0 },
    { ...HINT, discount_percent: 'half' },
    { ...HINT, unlock_threshold_cents: 100.5 },
    { ...HINT, unlock_threshold_cents: -1 },
    { ...HINT, unlock_threshold_cents: undefined },
    'a bare sentence',
    [],
  ]
  for (const [index, relaxed_queue_hint] of broken.entries()) {
    const [model] = await servedCatalog(
      [{ ...CHAT_BASE, id: 'partial', display_name: 'Partial', queue_class: 'relaxed', relaxed_queue_hint }],
      `partial-hint-key-${index}`,
    )
    assert.equal(model?.relaxed_queue_hint, null, `hint #${index} is not showable`)
    // The SHELF still stands. The product really is sold on the slower queue;
    // only the offer is unstated, and one does not depend on the other.
    assert.equal(model?.queue_class, 'relaxed')
  }
})

test('a standard rate that is not a real published figure stays absent', async () => {
  const [model] = await servedCatalog([{
    ...CHAT_BASE,
    id: 'odd-rates',
    display_name: 'Odd Rates',
    standard_input_credits_per_million_tokens: '60',
    standard_output_credits_per_million_tokens: -5,
  }], 'odd-rate-key')
  assert.equal(model?.standard_input_credits_per_million_tokens, null)
  assert.equal(model?.standard_output_credits_per_million_tokens, null)
})

test('the gateway\'s activation blockers reach the row, and no absence is invented', async () => {
  // This used to allowlist `availability_reason` / `available_again_at` — two
  // fields no catalogue has published since the old GenStudio, which meant the
  // cooldown they fed could never fire. What the gateway does state is
  // `activation_blockers`: the reason a row cannot be used. It is carried
  // through untouched, and a row that states none carries an empty list rather
  // than a sentence nobody wrote.
  const models = await servedCatalog([
    {
      ...CHAT_BASE,
      id: 'locked-by-gateway',
      display_name: 'Locked by the gateway',
      activation_blockers: ['No Studio Hub location offering this model is answering.'],
    },
    { ...CHAT_BASE, id: 'quiet', display_name: 'Nothing stated' },
  ], 'activation-blockers-key')

  assert.deepEqual(models[0]?.activation_blockers,
    ['No Studio Hub location offering this model is answering.'])
  assert.deepEqual(models[1]?.activation_blockers, [])
})

// ── 3. The whitelist that feeds the language picker ───────────────────────

test('GET /models forwards the shelf, the hint and the undiscounted rates', async () => {
  const originalFetch = globalThis.fetch
  clearGenStudioCatalogCache()
  await setApiKey('genstudio', 'relaxed-route-key')
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/chat\/models$/)
      return Response.json([
        { ...CHAT_BASE, id: 'direct-1', display_name: 'Direct Product' },
        {
          ...CHAT_BASE,
          id: 'relaxed-1',
          display_name: 'Relaxed Product',
          queue_class: 'relaxed',
          relaxed_queue_hint: HINT,
          standard_input_credits_per_million_tokens: 60,
          standard_output_credits_per_million_tokens: 120,
        },
      ])
    }
    const app = express()
    app.use(express.json())
    app.use(healthRouter)
    const response = await request(app).get('/models').expect(200)

    const [direct, relaxed] = response.body
    // This whitelist is why the retirement schedule never reached the picker
    // for weeks: the fields arrived on every row and were dropped here.
    assert.equal(relaxed.queue_class, 'relaxed')
    assert.deepEqual(relaxed.relaxed_queue_hint, HINT)
    assert.equal(relaxed.standard_input_credits_per_million_tokens, 60)
    assert.equal(relaxed.standard_output_credits_per_million_tokens, 120)
    // The temporary-availability pair used to be asserted here, and no catalogue
    // publishes either field — so this pins that they are gone from the
    // forwarded row rather than quietly defaulted to null.
    assert.equal((relaxed as Record<string, unknown>).availability_reason, undefined)
    assert.equal((relaxed as Record<string, unknown>).available_again_at, undefined)

    assert.equal(direct.queue_class, 'direct')
    assert.equal(direct.relaxed_queue_hint, null)
    assert.equal(direct.standard_input_credits_per_million_tokens, null)
    assert.equal((direct as Record<string, unknown>).availability_reason, undefined)
    assert.equal((direct as Record<string, unknown>).available_again_at, undefined)
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
    await setApiKey('genstudio', '')
  }
})

test('the vision whitelist forwards the same four fields', () => {
  // Read from the route rather than exercised through it: this endpoint needs a
  // real project on disk, and what is at stake here is only whether the four
  // names survive the whitelist — the parsing they come from is covered above.
  const vision = readFileSync(new URL('../routes/vision.ts', import.meta.url), 'utf8')
  for (const field of [
    'queue_class: model.queue_class',
    'relaxed_queue_hint: model.relaxed_queue_hint',
    'standard_input_credits_per_million_tokens: model.standard_input_credits_per_million_tokens',
    'standard_output_credits_per_million_tokens: model.standard_output_credits_per_million_tokens',
  ]) {
    assert.ok(vision.includes(field), `the vision menu is a second place a customer pays; it needs ${field}`)
  }
})

// ── 4. The web-research picker ────────────────────────────────────────────

test('a web-research option carries the shelf and the hint, and no invented price', () => {
  const relaxed = toWebResearchModelOption({
    id: 'gs-research-1',
    display_name: 'Research Product',
    queue_class: 'relaxed',
    relaxed_queue_hint: HINT,
  } as any)
  assert.equal(relaxed.queue_class, 'relaxed')
  assert.deepEqual(relaxed.relaxed_queue_hint, HINT)
  // Web research is charged per search and per request, and GenStudio publishes
  // no undiscounted counterpart for either. There is no "was" price to show, so
  // none is carried — least of all one built from the per-token rates this page
  // does not charge.
  assert.equal('standard_input_credits_per_million_tokens' in relaxed, false)
  assert.equal('standard_output_credits_per_million_tokens' in relaxed, false)

  const legacy = toWebResearchModelOption({ id: 'gs-research-2', display_name: 'Older Product' } as any)
  assert.equal(legacy.queue_class, 'direct')
  assert.equal(legacy.relaxed_queue_hint, null)
})

// ── 5. Nothing here is Story Studio's to write ────────────────────────────

test('no percentage, threshold or offer copy is authored in the server', () => {
  for (const file of ['../lib/genstudio-client.ts', '../routes/health.ts', '../services/research/web-capability.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*(\/\/|\*).*$/gm, '')
    assert.doesNotMatch(source, /discount_percent\s*[:=]\s*\d/, `${file} must not state a discount`)
    assert.doesNotMatch(source, /unlock_threshold_cents\s*[:=]\s*\d/, `${file} must not state a threshold`)
    assert.doesNotMatch(source, /slower queue|never expires/i, `${file} must not restate the offer`)
  }
})
