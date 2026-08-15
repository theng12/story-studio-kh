import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  ContentStoreUpstreamRefusal,
  confirmContentStorePurchase,
  createContentStoreQuote,
} from '../services/content-store.js'
import {
  purchaseGenStudioContentProduct,
  quoteGenStudioContentProduct,
} from '../lib/genstudio-content-store.js'
import { readContentStoreCommerceState } from '../content-store/commerce-state.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const KEY = 'gsk_paid_bundle_account'
const ACCOUNT = 'acct_paid_bundle'
const KIT_FAMILY = 'com.storystudio.kit.archival-ledger'
const STYLE_FAMILY = 'com.storystudio.style.archival-documentary'
const TOPIC_FAMILY = 'com.storystudio.topic.hidden-mechanics-history'
const OPERATOR_DISCOUNT = {
  discount_id: 'cdsc_archival_launch',
  version: 1,
  percent: 90,
  starts_on: null,
  ends_on: '2026-12-31',
  timezone: 'Asia/Phnom_Penh',
}

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
  await cleanup?.()
  cleanup = undefined
})

function product(input: {
  productId: string
  family: string
  kind: 'niche_bundle' | 'visual_style' | 'topic_pack'
  price?: number
  bundleComponents?: Array<{ product_id: string; entitlement_family: string; component_credit_value: number }>
}) {
  return {
    product_id: input.productId,
    entitlement_family: input.family,
    kind: input.kind,
    title: input.productId,
    summary: 'Signed mock catalog fact.',
    description: 'Signed mock catalog fact.',
    publisher_id: 'com.storystudio',
    credit_price: input.price ?? 0,
    free: (input.price ?? 0) === 0,
    owned: false,
    retired: false,
    successor_product_id: null,
    current_release: {
      release_id: `crel_${input.productId}`,
      pack_id: `com.storystudio.pack.${input.productId}`,
      version: '1.0.0',
      archive_sha256: 'a'.repeat(64),
      archive_bytes: 4096,
      archive_available: false,
      min_story_version: '1.0.0',
      changelog: 'First release.',
      component_summary: {},
    },
    compatible: true,
    compatibility_reason: null,
    bundle_components: (input.bundleComponents ?? []).map(component => ({
      ...component,
      title: component.product_id,
      kind: component.product_id === 'cprod_archival_style' ? 'visual_style' : 'topic_pack',
      owned: false,
    })),
    owned_component_credit_value: 0,
    showcase_videos: [],
    cover: null,
    hero: null,
    tags: [],
    license: null,
    discount: null,
    ...(input.kind === 'niche_bundle' ? { operator_discount: OPERATOR_DISCOUNT } : {}),
  }
}

async function setup() {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY, ACCOUNT)
  mock.setContentAccountCredits(ACCOUNT, 2_000)
  mock.contentProducts = [
    product({
      productId: 'cprod_archival_kit', family: KIT_FAMILY, kind: 'niche_bundle', price: 2_000,
      bundleComponents: [
        { product_id: 'cprod_archival_style', entitlement_family: STYLE_FAMILY, component_credit_value: 400 },
        { product_id: 'cprod_archival_topic', entitlement_family: TOPIC_FAMILY, component_credit_value: 600 },
      ],
    }),
    product({ productId: 'cprod_archival_style', family: STYLE_FAMILY, kind: 'visual_style' }),
    product({ productId: 'cprod_archival_topic', family: TOPIC_FAMILY, kind: 'topic_pack' }),
  ]
  mock.configureContentBundle('cprod_archival_kit', ['cprod_archival_style', 'cprod_archival_topic'])
  mock.setContentProductOwned('cprod_archival_style')
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', KEY)
  return mock
}

function facts(value: unknown): Record<string, any> {
  return value as Record<string, any>
}

test('retains only GenStudio signed paid-bundle quote and purchase facts without local price logic', async () => {
  const service = await setup()
  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))

  assert.equal(quoted.base_credit_price, 2_000)
  assert.equal(quoted.discount_credits, 400)
  assert.equal(quoted.operator_discount_credits, 1_440)
  assert.equal(quoted.quoted_credits, 160)
  assert.deepEqual(quoted.operator_discount, OPERATOR_DISCOUNT)
  assert.deepEqual(quoted.owned_components, [STYLE_FAMILY])
  assert.deepEqual(quoted.entitlement_families, [KIT_FAMILY, STYLE_FAMILY, TOPIC_FAMILY])
  assert.deepEqual(quoted.bundle_closure.map((entry: Record<string, unknown>) => entry.entitlement_family), [STYLE_FAMILY, TOPIC_FAMILY])

  const saved = (await readContentStoreCommerceState()).attempts[quoted.quote_id]!
  assert.match(saved.quote_canonical_json, /"operator_discount_credits":1440/)
  assert.match(saved.quote_canonical_json, /"discount_credits":400/)
  const completed = facts(await confirmContentStorePurchase(quoted.quote_id))
  assert.equal(service.contentPurchasePostCount, 1)
  assert.equal(service.totalCreditsCharged, 160)
  assert.deepEqual(service.contentPurchaseCharges, [160])
  assert.equal(service.familyGrantCount(KIT_FAMILY), 1)
  assert.equal(service.familyGrantCount(STYLE_FAMILY), 0, 'an already-owned component is not granted again')
  assert.equal(service.familyGrantCount(TOPIC_FAMILY), 1)
  assert.equal(completed.component_discount_credits, 400)
  assert.equal(completed.operator_discount_credits, 1_440)
  assert.equal(completed.credits_charged, 160)
  assert.deepEqual(completed.granted_families, [KIT_FAMILY, TOPIC_FAMILY])
  assert.deepEqual(completed.previously_owned_families, [STYLE_FAMILY])
  assert.deepEqual(completed.bundle_closure, quoted.bundle_closure)
  assert.deepEqual(await confirmContentStorePurchase(quoted.quote_id), completed)
  assert.equal(service.contentPurchasePostCount, 1, 'a completed confirmation does not send another purchase POST')
})

test('keeps bundle refusals non-mutating and replays one uncertain explicit retry without duplicate debit or grant', async () => {
  const service = await setup()
  const refusedQuote = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  service.queueContentPurchaseOutcome({
    status: 409,
    body: { code: 'bundle_component_unavailable', detail: 'Pinned component release is unavailable.' },
  })
  await assert.rejects(
    confirmContentStorePurchase(refusedQuote.quote_id),
    (error: unknown) => error instanceof ContentStoreUpstreamRefusal
      && error.status === 409 && error.refusal.code === 'bundle_component_unavailable',
  )
  assert.equal(service.contentPurchasePostCount, 1)
  assert.equal(service.totalCreditsCharged, 0)
  assert.deepEqual(service.grantedFamilies, [])

  const revokedQuote = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  service.queueContentPurchaseOutcome({
    status: 403,
    body: { code: 'entitlement_revoked', detail: 'A pinned component entitlement is revoked.' },
  })
  await assert.rejects(
    confirmContentStorePurchase(revokedQuote.quote_id),
    (error: unknown) => error instanceof ContentStoreUpstreamRefusal
      && error.status === 403 && error.refusal.code === 'entitlement_revoked',
  )
  assert.equal(service.contentPurchasePostCount, 2)
  assert.equal(service.totalCreditsCharged, 0)
  assert.deepEqual(service.grantedFamilies, [])

  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  service.queueContentPurchaseOutcome({ dropResponse: true })
  await assert.rejects(confirmContentStorePurchase(quoted.quote_id), /did not receive GenStudio's answer/i)
  assert.equal(service.contentPurchasePostCount, 3)
  assert.equal(service.totalCreditsCharged, 160)
  const replayed = facts(await confirmContentStorePurchase(quoted.quote_id))
  assert.equal(service.contentPurchasePostCount, 4, 'only an explicit retry sends the replay POST')
  assert.equal(replayed.replayed, true)
  assert.equal(service.totalCreditsCharged, 160)
  assert.equal(service.familyGrantCount(KIT_FAMILY), 1)
  assert.equal(service.familyGrantCount(TOPIC_FAMILY), 1)
})

test('replays byte-equivalent signed receipt evidence for an explicit same-key retry', async () => {
  const service = await setup()
  const quote = await quoteGenStudioContentProduct(KEY, { product_id: 'cprod_archival_kit', release_id: null })
  const request = {
    quoteCanonicalJson: quote.signedQuote.canonicalJson,
    quoteSignature: quote.quoteSignature,
    idempotencyKey: 'paid-bundle-replay-key',
  }
  const first = await purchaseGenStudioContentProduct(KEY, request)
  const replay = await purchaseGenStudioContentProduct(KEY, request)

  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.receipt.signedReceipt.canonicalJson, first.receipt.signedReceipt.canonicalJson)
  assert.deepEqual(service.contentPurchaseCharges, [160])
  assert.equal(service.familyGrantCount(KIT_FAMILY), 1)
  assert.equal(service.familyGrantCount(TOPIC_FAMILY), 1)
})
