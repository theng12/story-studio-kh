import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { afterEach, test } from 'node:test'

import { ContentStoreUpstreamRefusal, confirmContentStorePurchase, createContentStoreQuote, loadContentStoreOverview } from '../services/content-store.js'
import { purchaseGenStudioContentProduct, quoteGenStudioContentProduct } from '../lib/genstudio-content-store.js'
import { getContentStoreStatePath, readContentStoreCommerceState } from '../content-store/commerce-state.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const KEY = 'gsk_paid_bundle_account'
const ACCOUNT = 'acct_paid_bundle'
const KIT_FAMILY = 'com.storystudio.kit.archival-ledger'
const SHARED_KIT_FAMILY = 'com.storystudio.kit.history-foundations'
const COMPONENT_FAMILIES = [
  'com.storystudio.formula.archival-ledger', 'com.storystudio.topic.archival-context',
  'com.storystudio.topic.hidden-mechanics-history', 'com.storystudio.topic.archival-narration',
  'com.storystudio.topic.primary-sources', 'com.storystudio.topic.documentary-structure',
  'com.storystudio.style.archival-documentary', 'com.storystudio.recipe.archival-thumbnail',
] as const
const STYLE_FAMILY = COMPONENT_FAMILIES[6]
const OPERATOR_DISCOUNT = {
  discount_id: 'cdsc_archival_launch', version: 1, percent: 90, starts_on: null,
  ends_on: '2026-12-31', timezone: 'Asia/Phnom_Penh',
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
  kind: 'niche_bundle' | 'visual_style' | 'topic_pack' | 'series_formula' | 'thumbnail_recipe'
  price?: number
  operatorDiscount?: typeof OPERATOR_DISCOUNT | null
  bundleComponents?: Array<{ product_id: string; entitlement_family: string; component_credit_value: number }>
}) {
  const price = input.price ?? 0
  return {
    product_id: input.productId, entitlement_family: input.family, kind: input.kind,
    title: input.productId, summary: 'Signed mock catalog fact.', description: 'Signed mock catalog fact.',
    publisher_id: 'com.storystudio', credit_price: price, free: price === 0, owned: false, retired: false,
    successor_product_id: null,
    current_release: {
      release_id: `crel_${input.productId}`, pack_id: `com.storystudio.pack.${input.productId}`,
      version: '1.0.0', archive_sha256: 'a'.repeat(64), archive_bytes: 4096, archive_available: false,
      min_story_version: '1.0.0', changelog: 'First release.', component_summary: {},
    },
    compatible: true, compatibility_reason: null,
    bundle_components: (input.bundleComponents ?? []).map(component => ({ ...component, title: component.product_id, kind: 'topic_pack', owned: false })),
    owned_component_credit_value: 0, showcase_videos: [], cover: null, hero: null, tags: [], license: null, discount: null,
    ...(input.operatorDiscount ? { operator_discount: input.operatorDiscount } : {}),
  }
}

async function setup() {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY, ACCOUNT)
  mock.setContentAccountCredits(ACCOUNT, 2_000)
  const componentIds = COMPONENT_FAMILIES.map((_, index) => `cprod_archival_component_${index + 1}`)
  const archivalComponents = componentIds.map((productId, index) => ({
    product_id: productId, entitlement_family: COMPONENT_FAMILIES[index]!, component_credit_value: index === 6 ? 400 : 0,
  }))
  mock.contentProducts = [
    product({ productId: 'cprod_archival_kit', family: KIT_FAMILY, kind: 'niche_bundle', price: 2_000, operatorDiscount: OPERATOR_DISCOUNT, bundleComponents: archivalComponents }),
    product({ productId: 'cprod_history_foundations', family: SHARED_KIT_FAMILY, kind: 'niche_bundle', bundleComponents: [
      { product_id: componentIds[6]!, entitlement_family: STYLE_FAMILY, component_credit_value: 0 },
      { product_id: 'cprod_history_component', entitlement_family: 'com.storystudio.topic.history-foundations', component_credit_value: 0 },
    ] }),
    product({ productId: componentIds[0]!, family: COMPONENT_FAMILIES[0]!, kind: 'series_formula', price: 300 }),
    product({ productId: componentIds[1]!, family: COMPONENT_FAMILIES[1]!, kind: 'topic_pack' }),
    product({ productId: componentIds[2]!, family: COMPONENT_FAMILIES[2]!, kind: 'topic_pack' }),
    product({ productId: componentIds[3]!, family: COMPONENT_FAMILIES[3]!, kind: 'topic_pack' }),
    product({ productId: componentIds[4]!, family: COMPONENT_FAMILIES[4]!, kind: 'topic_pack' }),
    product({ productId: componentIds[5]!, family: COMPONENT_FAMILIES[5]!, kind: 'topic_pack' }),
    product({ productId: componentIds[6]!, family: COMPONENT_FAMILIES[6]!, kind: 'visual_style' }),
    product({ productId: componentIds[7]!, family: COMPONENT_FAMILIES[7]!, kind: 'thumbnail_recipe' }),
    product({ productId: 'cprod_history_component', family: 'com.storystudio.topic.history-foundations', kind: 'topic_pack' }),
  ]
  mock.configureContentBundle('cprod_archival_kit', componentIds)
  mock.configureContentBundle('cprod_history_foundations', [componentIds[6]!, 'cprod_history_component'])
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', KEY)
  return mock
}

function facts(value: unknown): Record<string, any> { return value as Record<string, any> }

async function acquireSharedFamily() {
  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_history_foundations', release_id: null }))
  const completed = facts(await confirmContentStorePurchase(quoted.quote_id))
  assert.deepEqual(completed.granted_families, [SHARED_KIT_FAMILY, STYLE_FAMILY, 'com.storystudio.topic.history-foundations'])
  return completed
}

test('qualifies the Archival nine-family atomic grant through a genuine shared-family cross-kit acquisition', async () => {
  const service = await setup()
  await acquireSharedFamily()
  assert.equal(service.contentPurchasePostCount, 1)
  assert.equal(service.familyGrantCount(STYLE_FAMILY), 1, 'the shared style was obtained from the other kit')
  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  assert.equal(quoted.base_credit_price, 2_000)
  assert.equal(quoted.discount_credits, 400)
  assert.equal(quoted.operator_discount_credits, 1_440)
  assert.equal(quoted.quoted_credits, 160)
  assert.deepEqual(quoted.operator_discount, OPERATOR_DISCOUNT)
  assert.deepEqual(quoted.owned_components, [STYLE_FAMILY])
  assert.deepEqual(quoted.entitlement_families, [KIT_FAMILY, ...COMPONENT_FAMILIES])
  assert.equal(quoted.bundle_closure.length, 8)
  assert.deepEqual(quoted.bundle_closure.map((entry: Record<string, unknown>) => entry.position), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(quoted.bundle_closure.map((entry: Record<string, unknown>) => entry.entitlement_family), COMPONENT_FAMILIES)
  const saved = (await readContentStoreCommerceState()).attempts[quoted.quote_id]!
  assert.match(saved.quote_canonical_json, /"operator_discount_credits":1440/)
  assert.match(saved.quote_canonical_json, /"discount_credits":400/)
  const completed = facts(await confirmContentStorePurchase(quoted.quote_id))
  assert.equal(service.contentPurchasePostCount, 2, 'one explicit Archival confirmation sends one POST')
  assert.deepEqual(service.contentPurchaseCharges, [0, 160])
  assert.equal(service.totalCreditsCharged, 160)
  assert.deepEqual(completed.granted_families, [KIT_FAMILY, ...COMPONENT_FAMILIES.filter(family => family !== STYLE_FAMILY)])
  assert.deepEqual(completed.previously_owned_families, [STYLE_FAMILY])
  assert.equal((await readContentStoreCommerceState()).attempts[quoted.quote_id]?.completed_purchase?.entitlement_ids.length, completed.granted_families.length)
  assert.deepEqual([...completed.granted_families, ...completed.previously_owned_families].sort(), [...quoted.entitlement_families].sort())
  assert.equal(service.familyGrantCount(STYLE_FAMILY), 1, 'the shared family is never granted twice')
  assert.deepEqual(await confirmContentStorePurchase(quoted.quote_id), completed)
  assert.equal(service.contentPurchasePostCount, 2, 'a completed confirmation remains local')
})

test('normalizes exact signed bundle dependencies and authoritative release states for the renderer', async () => {
  const service = await setup()
  await acquireSharedFamily()
  service.setContentOwnedReleaseState('crel_cprod_archival_component_7', { state: 'withdrawn' })

  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  const style = quoted.dependencies.find((dependency: Record<string, unknown>) => dependency.entitlementFamily === STYLE_FAMILY)
  assert.deepEqual(style, {
    position: 6,
    productId: 'cprod_archival_component_7',
    entitlementFamily: STYLE_FAMILY,
    releaseId: 'crel_cprod_archival_component_7',
    version: '1.0.0',
    archiveSha256: 'a'.repeat(64),
    title: 'cprod_archival_component_7',
    kind: 'visual_style',
    states: ['free', 'owned', 'included', 'unavailable', 'withdrawn'],
  })
  assert.equal(quoted.dependencies[0].version, '1.0.0')
  assert.equal(JSON.stringify(quoted).includes('canonical_json'), false)
  assert.equal(JSON.stringify(quoted).includes('signature'), false)
})

test('does not mark an exact signed dependency unavailable only because catalog current advanced', async () => {
  const service = await setup()
  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  const first = service.contentProducts.find(product => product.product_id === 'cprod_archival_component_1')!
  first.current_release = {
    ...(first.current_release as Record<string, unknown>),
    release_id: 'crel_cprod_archival_component_1_v2',
    version: '2.0.0',
    archive_sha256: 'b'.repeat(64),
  }

  const overview = facts(await loadContentStoreOverview())
  const attempt = overview.attempts.find((candidate: Record<string, unknown>) => candidate.quote_id === quoted.quote_id)
  const dependency = attempt.dependencies.find((candidate: Record<string, unknown>) => candidate.productId === 'cprod_archival_component_1')
  assert.equal(dependency.version, '1.0.0')
  assert.deepEqual(dependency.states, ['included'])
})

test('normalizes owned-history 403 and 404 as unavailable without failing overview or leaking refusal detail', async () => {
  const service = await setup()
  await acquireSharedFamily()
  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))

  for (const status of [403, 404] as const) {
    service.setContentOwnedReleaseRefusal(STYLE_FAMILY, status)
    const overview = facts(await loadContentStoreOverview())
    const attempt = overview.attempts.find((candidate: Record<string, unknown>) => candidate.quote_id === quoted.quote_id)
    const dependency = attempt.dependencies.find((candidate: Record<string, unknown>) => candidate.entitlementFamily === STYLE_FAMILY)
    assert.deepEqual(dependency.states, ['free', 'owned', 'included', 'unavailable'])
    assert.doesNotMatch(JSON.stringify(dependency), /history_forbidden|not_entitled|Sensitive|internal_path/)
  }
})

test('keeps nine-family bundle refusals non-mutating and retries uncertainty once without duplicate debit or grant', async () => {
  const service = await setup()
  const refusedQuote = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  service.queueContentPurchaseOutcome({ status: 409, body: { code: 'bundle_component_unavailable', detail: 'Pinned component release is unavailable.' } })
  await assert.rejects(confirmContentStorePurchase(refusedQuote.quote_id), (error: unknown) => error instanceof ContentStoreUpstreamRefusal && error.status === 409)
  const revokedQuote = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  service.queueContentPurchaseOutcome({ status: 403, body: { code: 'entitlement_revoked', detail: 'A pinned component entitlement is revoked.' } })
  await assert.rejects(confirmContentStorePurchase(revokedQuote.quote_id), (error: unknown) => error instanceof ContentStoreUpstreamRefusal && error.status === 403)
  assert.equal(service.contentPurchasePostCount, 2)
  assert.equal(service.totalCreditsCharged, 0)
  assert.deepEqual(service.grantedFamilies, [])
  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  service.queueContentPurchaseOutcome({ dropResponse: true })
  await assert.rejects(confirmContentStorePurchase(quoted.quote_id), /did not receive GenStudio's answer/i)
  assert.equal(service.contentPurchasePostCount, 3)
  assert.equal(service.totalCreditsCharged, 200)
  const replayed = facts(await confirmContentStorePurchase(quoted.quote_id))
  assert.equal(service.contentPurchasePostCount, 4, 'only explicit retry sends the replay POST')
  assert.equal(replayed.replayed, true)
  assert.equal(service.totalCreditsCharged, 200)
  assert.equal(service.familyGrantCount(KIT_FAMILY), 1)
  assert.equal(service.familyGrantCount(STYLE_FAMILY), 1)
})

test('replays byte-equivalent nine-family signed receipt evidence for an explicit same-key retry', async () => {
  const service = await setup()
  const quote = await quoteGenStudioContentProduct(KEY, { product_id: 'cprod_archival_kit', release_id: null })
  const request = { quoteCanonicalJson: quote.signedQuote.canonicalJson, quoteSignature: quote.quoteSignature, idempotencyKey: 'paid-bundle-replay-key' }
  const first = await purchaseGenStudioContentProduct(KEY, request)
  const replay = await purchaseGenStudioContentProduct(KEY, request)
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.receipt.signedReceipt.canonicalJson, first.receipt.signedReceipt.canonicalJson)
  assert.deepEqual(service.contentPurchaseCharges, [200])
  assert.equal(service.familyGrantCount(KIT_FAMILY), 1)
  assert.equal(service.familyGrantCount(STYLE_FAMILY), 1)
})

test('settles a legacy non-bundle journal attempt once without changing its quote bytes or idempotency key', async () => {
  const service = await setup()
  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_component_1', release_id: null }))
  const saved = (await readContentStoreCommerceState()).attempts[quoted.quote_id]!
  const rawState = JSON.parse(await fs.readFile(getContentStoreStatePath(), 'utf8')) as {
    attempts: Record<string, Record<string, unknown>>
  }
  delete rawState.attempts[quoted.quote_id]!.entitlement_families
  delete rawState.attempts[quoted.quote_id]!.bundle_closure
  const legacySignedQuote = JSON.parse(rawState.attempts[quoted.quote_id]!.quote_canonical_json as string) as Record<string, unknown>
  delete legacySignedQuote.entitlement_families
  delete legacySignedQuote.bundle_closure
  const legacyCanonicalQuote = JSON.stringify(legacySignedQuote)
  rawState.attempts[quoted.quote_id]!.quote_canonical_json = legacyCanonicalQuote
  await fs.writeFile(getContentStoreStatePath(), `${JSON.stringify(rawState)}\n`, { mode: 0o600 })
  const legacy = (await readContentStoreCommerceState()).attempts[quoted.quote_id]!
  assert.notEqual(legacy.quote_canonical_json, saved.quote_canonical_json)
  assert.equal(legacy.quote_canonical_json, legacyCanonicalQuote)
  assert.equal(legacy.idempotency_key, saved.idempotency_key)
  assert.equal(legacy.entitlement_families, undefined)
  assert.equal(legacy.bundle_closure, undefined)

  const completed = facts(await confirmContentStorePurchase(quoted.quote_id))
  assert.equal(completed.status, 'completed')
  assert.equal(service.contentPurchasePostCount, 1)
  assert.deepEqual(service.contentPurchaseCharges, [300])
  assert.equal(service.totalCreditsCharged, 300)
  assert.equal(service.familyGrantCount(COMPONENT_FAMILIES[0]), 1)
  assert.equal((await readContentStoreCommerceState()).attempts[quoted.quote_id]?.quote_canonical_json, legacyCanonicalQuote)
  assert.deepEqual(await confirmContentStorePurchase(quoted.quote_id), completed)
  assert.equal(service.contentPurchasePostCount, 1, 'completed legacy settlement sends no duplicate POST')
  assert.deepEqual(service.contentPurchaseCharges, [300])
  assert.equal(service.familyGrantCount(COMPONENT_FAMILIES[0]), 1, 'completed legacy settlement grants once')
})

test('refuses missing modern quote projections before any purchase POST, debit, or grant', async () => {
  const service = await setup()
  const quoted = facts(await createContentStoreQuote({ product_id: 'cprod_archival_kit', release_id: null }))
  const rawState = JSON.parse(await fs.readFile(getContentStoreStatePath(), 'utf8')) as {
    attempts: Record<string, Record<string, unknown>>
  }
  delete rawState.attempts[quoted.quote_id]!.entitlement_families
  delete rawState.attempts[quoted.quote_id]!.bundle_closure
  await fs.writeFile(getContentStoreStatePath(), `${JSON.stringify(rawState)}\n`, { mode: 0o600 })

  await assert.rejects(confirmContentStorePurchase(quoted.quote_id), /bundle projections drifted/i)
  await assert.rejects(confirmContentStorePurchase(quoted.quote_id), /bundle projections drifted/i)
  assert.equal(service.contentPurchasePostCount, 0)
  assert.equal(service.totalCreditsCharged, 0)
  assert.deepEqual(service.grantedFamilies, [])
  assert.equal((await readContentStoreCommerceState()).attempts[quoted.quote_id]?.status, 'quoted')
})
