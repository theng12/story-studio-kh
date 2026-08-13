import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { readContentStoreCommerceState } from '../content-store/commerce-state.js'
import { router as contentStoreRouter } from '../routes/content-store.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { useTempDataDir } from './_helpers.js'
import {
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

const KEY_A = 'gsk_content_account_a'
const KEY_A_ROTATED = 'gsk_content_account_a_rotated'
const KEY_B = 'gsk_content_account_b'
const HASH = 'a'.repeat(64)

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService

function release() {
  return {
    release_id: 'crel_a', pack_id: 'com.storystudio.test', version: '1.0.0',
    archive_sha256: HASH, archive_bytes: 4096, min_story_version: '1.0.834',
    changelog: 'First release.', component_summary: { count: 1 },
  }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', kind: 'series_formula',
    title: 'Test Formula', summary: 'A formula.', description: 'Long description.',
    publisher_id: 'com.storystudio', credit_price: 300, free: false, owned: false,
    retired: false, successor_product_id: null, current_release: release(), compatible: true,
    compatibility_reason: null, bundle_components: [], owned_component_credit_value: 0,
    ...overrides,
  }
}

function app() {
  const instance = express()
  instance.use(express.json({ limit: '10mb' }))
  instance.use('/api', contentStoreRouter)
  return instance
}

async function setup(options: { products?: Array<Record<string, unknown>>; key?: string } = {}) {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY_A, 'acct_a')
  mock.registerContentStoreKey(KEY_A_ROTATED, 'acct_a')
  mock.registerContentStoreKey(KEY_B, 'acct_b')
  mock.contentProducts = options.products ?? [product()]
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', options.key ?? KEY_A)
  return { app: app(), tempDir: temp.dir }
}

function quote(localApp: express.Express) {
  return request(localApp).post('/api/content-store/quotes').send({ product_id: 'cprod_a', release_id: null })
}

afterEach(async () => {
  await mock?.close()
  await cleanup?.()
  cleanup = undefined
})

describe('Content Store commerce routes', () => {
  test('requires a saved key locally and sends no remote request', async () => {
    const { app: localApp } = await setup({ key: '' })
    const response = await request(localApp).get('/api/content-store').expect(400)
    assert.equal(response.body.code, 'CONTENT_STORE_KEY_REQUIRED')
    assert.equal(mock.requests.length, 0)
  })

  test('loads exact account and products with the current Story version and accepts an empty catalog', async () => {
    const { app: localApp } = await setup({ products: [] })
    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(response.body.phase, 'commerce_core')
    assert.equal(response.body.account.accountId, 'acct_a')
    assert.deepEqual(response.body.products, [])
    assert.doesNotMatch(JSON.stringify(response.body), /canonicalJson|canonicalBytes|\"raw\"/)
    assert.deepEqual(response.body.capabilities, {
      purchase: true, receipt_verification: false, download: false,
      install_after_purchase: false, restore: false,
    })
    assert.equal(mock.requests.filter(row => row.path === '/v1/content/account').length, 1)
    assert.match(mock.requests.find(row => row.path === '/v1/content/products')!.path, /^\/v1\/content\/products$/)
  })

  test('does not use stale ownership after a content scope failure', async () => {
    const { app: localApp } = await setup()
    await request(localApp).get('/api/content-store').expect(200)
    mock.registerKey('gsk_without_content_scope', [])
    await setApiKey('genstudio', 'gsk_without_content_scope')
    const response = await request(localApp).get('/api/content-store').expect(401)
    assert.match(response.body.detail, /content:read/i)
    assert.equal(response.body.account, undefined)
  })

  test('strictly quotes a catalog product, saves canonical evidence, and never debits', async () => {
    const { app: localApp } = await setup()
    await request(localApp).post('/api/content-store/quotes').send({ product_id: 'cprod_a', release_id: null, extra: true }).expect(400)
    const response = await quote(localApp).expect(201)
    assert.equal(response.body.product_id, 'cprod_a')
    assert.equal(response.body.status, 'quoted')
    assert.equal(response.body.quote_signature, undefined)
    assert.equal(response.body.quote_canonical_json, undefined)
    assert.equal(mock.contentPurchasePostCount, 0)
    const state = await readContentStoreCommerceState()
    assert.equal(state.attempts[response.body.quote_id].quote_canonical_json.includes('future_'), false)
  })

  test('blocks account switching but permits same-account key rotation', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    await setApiKey('genstudio', KEY_B)
    const mismatch = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(409)
    assert.equal(mismatch.body.code, 'CONTENT_PURCHASE_ACCOUNT_MISMATCH')
    assert.equal(mock.contentPurchasePostCount, 0)

    await setApiKey('genstudio', KEY_A_ROTATED)
    const purchased = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(purchased.body.status, 'completed')
    assert.equal(purchased.body.ownership, 'owned_not_installed')
    assert.equal(mock.contentPurchasePostCount, 1)
  })

  test('checks account ownership even for completed cache and hides other-account attempts from overview', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    await request(localApp).post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    await setApiKey('genstudio', KEY_B)
    const overview = await request(localApp).get('/api/content-store').expect(200)
    assert.deepEqual(overview.body.attempts, [])
    await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({})
      .expect(409)
    assert.equal(mock.contentPurchasePostCount, 1)
  })

  test('returns a durable already-submitting claim without a second purchase POST', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    const { beginPurchaseAttempt } = await import('../content-store/commerce-state.js')
    await beginPurchaseAttempt(quoted.body.quote_id, 'acct_a')
    const response = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(response.body.status, 'submitting')
    assert.equal(mock.contentPurchasePostCount, 0)
  })

  test('coalesces concurrent double-clicks into one purchase POST', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.queueContentPurchaseOutcome({ delayMs: 150 })
    const [first, second] = await Promise.all([
      request(localApp).post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}),
      request(localApp).post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}),
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(first.body.status, 'completed')
    assert.equal(second.body.status, 'completed')
    assert.equal(mock.contentPurchasePostCount, 1)
    assert.equal(first.body.idempotency_key, undefined)
  })

  test('classifies a dropped purchase response uncertain and replays only on explicit retry', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.queueContentPurchaseOutcome({ dropResponse: true })
    const uncertain = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(502)
    assert.deepEqual(uncertain.body, {
      code: 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN',
      detail: "Story Studio did not receive GenStudio's answer. No replacement purchase was sent. Retry this exact purchase to replay its saved idempotency key.",
      status: 'uncertain',
    })
    assert.equal(mock.contentPurchasePostCount, 1)
    const before = await readContentStoreCommerceState()
    const key = before.attempts[quoted.body.quote_id].idempotency_key

    const completed = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    const after = await readContentStoreCommerceState()
    assert.equal(after.attempts[quoted.body.quote_id].idempotency_key, key)
    assert.equal(completed.body.status, 'completed')
    assert.equal(mock.contentPurchasePostCount, 2)
  })

  test('preserves a quote after a definitive purchase-scope rejection and allows the same key to retry', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.registerContentStoreKey('gsk_content_read_only', 'acct_a', ['content:read'])
    await setApiKey('genstudio', 'gsk_content_read_only')
    const denied = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(401)
    assert.match(denied.body.detail, /content:purchase/i)
    const preserved = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id]
    assert.equal(preserved.status, 'quoted')
    const idempotencyKey = preserved.idempotency_key

    await setApiKey('genstudio', KEY_A_ROTATED)
    const completed = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(completed.body.status, 'completed')
    assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].idempotency_key, idempotencyKey)
  })

  test('names content:read when purchase account preflight rejects a purchase-only key', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.registerContentStoreKey('gsk_content_purchase_only', 'acct_a', ['content:purchase'])
    await setApiKey('genstudio', 'gsk_content_purchase_only')
    const denied = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(401)
    assert.match(denied.body.detail, /content:read/i)
    assert.doesNotMatch(denied.body.detail, /content:purchase/i)
    assert.equal(mock.contentPurchasePostCount, 0)
    assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].status, 'quoted')
  })

  test('never leaves submitting after a synchronous not-sent purchase and preserves the key', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    const before = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id]
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input, init) => {
      if (String(input).endsWith('/v1/content/purchases')) throw new Error('synchronous fetch refusal')
      return originalFetch(input, init)
    }) as typeof fetch
    try {
      await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(502)
    } finally {
      globalThis.fetch = originalFetch
    }
    const after = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id]
    assert.equal(after.status, 'quoted')
    assert.equal(after.idempotency_key, before.idempotency_key)
  })

  test('marks malformed and unknown purchase refusals uncertain instead of retaining submitting', async () => {
    for (const outcome of [
      { status: 503 as const, rawBody: '{not json' },
      { status: 418 as any, body: { code: 'unexpected', detail: 'unknown response' } },
    ]) {
      const { app: localApp } = await setup()
      const quoted = await quote(localApp).expect(201)
      mock.queueContentPurchaseOutcome(outcome)
      const response = await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(502)
      assert.equal(response.body.status, 'uncertain')
      assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].status, 'uncertain')
      await mock.close()
      await cleanup?.()
      cleanup = undefined
    }
  })

  test('projects only bounded published refusal fields to the renderer', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.queueContentPurchaseOutcome({
      status: 401 as any,
      body: {
        detail: 'authentication required',
        quote_signature: 'must-not-leak',
        canonical_json: '{secret}',
        path: '/Users/private',
      },
    })
    const response = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(401)
    assert.match(response.body.detail, /content:purchase/)
    assert.doesNotMatch(JSON.stringify(response.body), /signature|canonical|\/Users/)
  })

  for (const [status, code, fields] of [
    [402, 'insufficient_credits', { required_credits: 300, available_credits: 100, shortfall_credits: 200 }],
    [404, 'product_unavailable', {}],
    [409, 'quote_rejected', {}],
    [409, 'already_owned', {}],
    [503, 'signing_unavailable', {}],
  ] as const) {
    test(`preserves exact upstream ${status} ${code} refusal`, async () => {
      const { app: localApp } = await setup()
      const quoted = await quote(localApp).expect(201)
      mock.queueContentPurchaseOutcome({ status, body: { code, detail: `${code} detail`, ...fields } })
      const response = await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(status)
      assert.equal(response.body.code, code)
      assert.equal(response.body.detail, `${code} detail`)
      assert.deepEqual({
        required_credits: response.body.required_credits,
        available_credits: response.body.available_credits,
        shortfall_credits: response.body.shortfall_credits,
      }, {
        required_credits: (fields as any).required_credits,
        available_credits: (fields as any).available_credits,
        shortfall_credits: (fields as any).shortfall_credits,
      })
      assert.equal(response.body.status, 'refused')
      assert.equal(mock.contentPurchasePostCount, 1)
      assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].status, 'refused')
    })
  }

  test('returns completed cache without another POST and exposes no receipt/signature/path/secret', async () => {
    const { app: localApp, tempDir } = await setup()
    const quoted = await quote(localApp).expect(201)
    const pathName = `/api/content-store/quotes/${quoted.body.quote_id}/purchase`
    const completed = await request(localApp).post(pathName).send({}).expect(200)
    const cached = await request(localApp).post(pathName).send({}).expect(200)
    assert.deepEqual(cached.body, completed.body)
    assert.equal(mock.contentPurchasePostCount, 1)
    assert.equal(completed.body.credits_charged, 300)
    assert.equal(completed.body.receipt_verification, 'unverified_phase1')
    assert.doesNotMatch(JSON.stringify(completed.body), /signature|canonical|idempotency|gsk_|commerce-state|\/Users\//i)
    assert.deepEqual(await fs.readdir(path.join(tempDir, 'jobs')).catch(() => []), [])
  })

  test('projects GenStudio final purchase balances when the charge settles below the quote ceiling', async () => {
    const { app: localApp } = await setup({ products: [product({ credit_price: 400 })] })
    const quoted = await quote(localApp).expect(201)
    assert.equal(quoted.body.balance_after, 3_600)
    mock.queueContentPurchaseOutcome({
      status: 200,
      body: { credits_charged: 300, balance_before: 4_000, balance_after: 3_700 },
    })

    const completed = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(completed.body.credits_charged, 300)
    assert.equal(completed.body.balance_before, 4_000)
    assert.equal(completed.body.balance_after, 3_700)
  })

  for (const refusal of [
    { status: 402 as const, code: 'insufficient_credits', fields: { required_credits: 400, available_credits: 100, shortfall_credits: 300 } },
    { status: 503 as const, code: 'signing_unavailable', fields: {} },
  ]) {
    test(`explicitly retries ${refusal.status} ${refusal.code} with the saved idempotency key`, async () => {
      const { app: localApp } = await setup({ products: [product({ credit_price: 400 })] })
      const quoted = await quote(localApp).expect(201)
      const savedKey = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id].idempotency_key
      mock.queueContentPurchaseOutcome({
        status: refusal.status,
        body: { code: refusal.code, detail: `${refusal.code} detail`, ...refusal.fields },
      })

      await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(refusal.status)
      const refused = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id]
      assert.equal(refused.status, 'refused')
      assert.equal(refused.idempotency_key, savedKey)
      assert.equal(mock.contentPurchasePostCount, 1)

      const completed = await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
      assert.equal(completed.body.status, 'completed')
      assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].idempotency_key, savedKey)
      assert.equal(mock.contentPurchasePostCount, 2)
    })
  }

  test('bounds quote IDs and local bodies', async () => {
    const { app: localApp } = await setup()
    await request(localApp).post('/api/content-store/quotes').send({ product_id: 'x'.repeat(257), release_id: null }).expect(400)
    await request(localApp).post(`/api/content-store/quotes/${'x'.repeat(257)}/purchase`).send({}).expect(400)
    await request(localApp).post('/api/content-store/quotes').send({
      product_id: 'cprod_a', release_id: null, padding: 'x'.repeat(20_000),
    }).expect(413)
  })

  test('keeps the financial service independent from installer, lifecycle, queue, and admission modules', async () => {
    const serviceSource = await fs.readFile(new URL('../services/content-store.ts', import.meta.url), 'utf8')
    const routeSource = await fs.readFile(new URL('../routes/content-store.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(serviceSource + routeSource, /content-packs\/(?:installer|lifecycle)|job-queue|admission|generation/i)
  })
})
