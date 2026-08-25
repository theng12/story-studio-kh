/**
 * Selecting several packs must BUY several packs.
 *
 * The defect these cover: "i also select all 18 and click see quote, it only
 * quoted one and then i clicked purchase -- i'm only buying 1 at a time
 * though." The multi-select promised a batch and delivered a single, so every
 * test here asserts on the whole set rather than on the first item.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  batchSkipReason,
  useBatchPurchase,
  type BatchPurchaseDeps,
} from '../composables/useBatchPurchase.js'
import type {
  ContentStoreProduct,
  ContentStoreUiError,
  PublicContentPurchaseAttempt,
} from '../composables/useContentStore.js'

function product(overrides: Partial<ContentStoreProduct> & { productId: string }): ContentStoreProduct {
  return {
    entitlementFamily: `${overrides.productId}.family`,
    kind: 'font_pack',
    title: `Pack ${overrides.productId}`,
    summary: '', description: '', publisherId: 'Story Studio',
    creditPrice: 30, free: false, owned: false, retired: false,
    successorProductId: null, compatible: true, compatibilityReason: null,
    currentRelease: {
      releaseId: `rel_${overrides.productId}`, packId: `pack_${overrides.productId}`, version: '1.0.0',
      archiveSha256: 'a'.repeat(64), archiveBytes: 1_024, archiveAvailable: true,
      minStoryVersion: '1.0.0', changelog: '', componentSummary: {},
    },
    bundleComponents: [], ownedComponentCreditValue: 0,
    presentation: { cover: { src: '', alt: '' }, licenseLabel: '', tags: [] },
    discount: null,
    ...overrides,
  } as ContentStoreProduct
}

function attempt(productId: string, credits: number): PublicContentPurchaseAttempt {
  return {
    quote_id: `cq_${productId}`, account_id: 'acct_a', product_id: productId,
    release_id: `rel_${productId}`, entitlement_family: `${productId}.family`,
    expires_at: '2026-08-25T09:00:00.000Z', status: 'quoted',
    base_credit_price: 40, discount_credits: 0, quoted_credits: credits,
    balance_before: 1_632_777, balance_after: 1_632_777 - credits,
    owned_components: [], sufficient_credits: true, insufficient_reason: null,
    shortfall_credits: 0,
  } as PublicContentPurchaseAttempt
}

interface Harness {
  deps: BatchPurchaseDeps
  quoted: string[]
  confirmed: string[]
}

function harness(options: {
  catalog: ContentStoreProduct[]
  failQuote?: Set<string>
  failConfirm?: Map<string, ContentStoreUiError>
  charged?: number
} = { catalog: [] }): Harness {
  const quoted: string[] = []
  const confirmed: string[] = []
  let lastError: ContentStoreUiError | null = null
  const byId = new Map(options.catalog.map(row => [row.productId, row]))
  return {
    quoted,
    confirmed,
    deps: {
      quote: async productId => {
        if (options.failQuote?.has(productId)) {
          lastError = { code: 'CONTENT_PRODUCT_RETIRED', detail: 'Retired.' } as ContentStoreUiError
          throw new Error('quote refused')
        }
        quoted.push(productId)
        return attempt(productId, byId.get(productId)?.creditPrice ?? 30)
      },
      confirm: async quoteId => {
        const productId = quoteId.replace(/^cq_/, '')
        const failure = options.failConfirm?.get(productId)
        if (failure) { lastError = failure; throw new Error('confirm refused') }
        confirmed.push(productId)
        return { ...attempt(productId, 30), status: 'completed', credits_charged: options.charged ?? 30 }
      },
      lookup: productId => byId.get(productId),
      lastError: () => lastError,
    },
  }
}

describe('buying a multi-pack selection', () => {
  test('quotes EVERY selected pack, not just the first', async () => {
    const catalog = ['a', 'b', 'c', 'd'].map(id => product({ productId: id }))
    const { deps, quoted } = harness({ catalog })
    const batch = useBatchPurchase(deps)

    await batch.start(catalog)

    // The defect: this used to be ['a'] and the dialog showed one pack.
    assert.deepEqual(quoted, ['a', 'b', 'c', 'd'])
    assert.equal(batch.items.value.length, 4)
    assert.equal(batch.quoted.value.length, 4)
    assert.equal(batch.phase.value, 'review')
  })

  test('shows ONE combined ceiling for the whole selection', async () => {
    const catalog = [
      product({ productId: 'a', creditPrice: 30 }),
      product({ productId: 'b', creditPrice: 45 }),
      product({ productId: 'c', creditPrice: 25 }),
    ]
    const { deps } = harness({ catalog })
    const batch = useBatchPurchase(deps)

    await batch.start(catalog)

    assert.equal(batch.quotedTotal.value, 100)
  })

  test('settles EVERY quoted pack on one confirmation', async () => {
    const catalog = ['a', 'b', 'c'].map(id => product({ productId: id }))
    const { deps, confirmed } = harness({ catalog })
    const batch = useBatchPurchase(deps)

    await batch.start(catalog)
    const bought = await batch.confirmAll()

    assert.deepEqual(confirmed, ['a', 'b', 'c'])
    assert.deepEqual(bought, ['a', 'b', 'c'])
    assert.equal(batch.phase.value, 'result')
    assert.equal(batch.items.value.every(item => item.outcome === 'owned'), true)
  })

  test('one failing pack does not abort the rest, and is reported with its reason', async () => {
    const catalog = ['a', 'b', 'c', 'd'].map(id => product({ productId: id }))
    const { deps, confirmed } = harness({
      catalog,
      failConfirm: new Map([['c', { code: 'CONTENT_PRODUCT_RETIRED', detail: 'GenStudio retired this pack.' } as ContentStoreUiError]]),
    })
    const batch = useBatchPurchase(deps)

    await batch.start(catalog)
    const bought = await batch.confirmAll()

    // The other three are bought. Rolling them back would be the worse outcome.
    assert.deepEqual(confirmed, ['a', 'b', 'd'])
    assert.deepEqual(bought, ['a', 'b', 'd'])
    const failed = batch.items.value.filter(item => item.outcome === 'failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0]?.productId, 'c')
    assert.equal(failed[0]?.reason, 'GenStudio retired this pack.')
    // A partial result is never presented as a complete one.
    assert.notEqual(batch.items.value.filter(item => item.outcome === 'owned').length, catalog.length)
  })

  test('an already-owned pack is skipped, never quoted and never charged', async () => {
    const catalog = [
      product({ productId: 'a' }),
      product({ productId: 'owned', owned: true }),
      product({ productId: 'b' }),
    ]
    const { deps, quoted, confirmed } = harness({ catalog })
    const batch = useBatchPurchase(deps)

    await batch.start(catalog)

    assert.equal(quoted.includes('owned'), false)
    const skipped = batch.items.value.find(item => item.productId === 'owned')
    assert.equal(skipped?.reason, 'Already owned')
    // Skipped packs are outside the ceiling he confirms.
    assert.equal(batch.quotedTotal.value, 60)

    await batch.confirmAll()
    assert.equal(confirmed.includes('owned'), false)
    assert.deepEqual(confirmed, ['a', 'b'])
  })

  test('a retired or incompatible pack is skipped with a reason rather than quoted', () => {
    assert.equal(batchSkipReason(product({ productId: 'a', retired: true })), 'Retired by GenStudio')
    assert.equal(
      batchSkipReason(product({ productId: 'a', compatible: false, compatibilityReason: 'Needs Story Studio 2.0' })),
      'Needs Story Studio 2.0',
    )
    assert.equal(batchSkipReason(product({ productId: 'a', currentRelease: null } as never)), 'No published release')
    assert.equal(batchSkipReason(undefined), 'No longer in the catalog')
    assert.equal(batchSkipReason(product({ productId: 'a' })), null)
  })

  test('retrying failures never re-submits a pack that already succeeded', async () => {
    const catalog = ['a', 'b'].map(id => product({ productId: id }))
    const { deps, confirmed } = harness({
      catalog,
      failConfirm: new Map([['b', { code: 'CONTENT_STORE_UNAVAILABLE', detail: 'Temporary.' } as ContentStoreUiError]]),
    })
    const batch = useBatchPurchase(deps)

    await batch.start(catalog)
    await batch.confirmAll()
    assert.deepEqual(confirmed, ['a'])

    await batch.retryFailed()

    // Only the failure is re-quoted; 'a' keeps its outcome and is not re-listed.
    assert.equal(batch.phase.value, 'review')
    assert.equal(batch.quoted.value.length, 1)
    assert.equal(batch.quoted.value[0]?.productId, 'b')
    assert.equal(batch.items.value.find(item => item.productId === 'a')?.outcome, 'owned')
  })

  test('a terminal refusal is not offered as retryable', async () => {
    const catalog = [product({ productId: 'a' })]
    const { deps } = harness({
      catalog,
      failConfirm: new Map([['a', { code: 'release_recalled', detail: 'Recalled.', terminal: true } as ContentStoreUiError]]),
    })
    const batch = useBatchPurchase(deps)

    await batch.start(catalog)
    await batch.confirmAll()

    assert.equal(batch.items.value[0]?.outcome, 'failed')
    assert.equal(batch.items.value[0]?.retryable, false)
  })

  test('a pack GenStudio will not quote is reported, and the rest still quote', async () => {
    const catalog = ['a', 'b', 'c'].map(id => product({ productId: id }))
    const { deps, confirmed } = harness({ catalog, failQuote: new Set(['b']) })
    const batch = useBatchPurchase(deps)

    await batch.start(catalog)
    // Two quotes reached the review screen; the refused one is a skip line.
    assert.equal(batch.quoted.value.length, 2)
    assert.equal(batch.items.value.find(item => item.productId === 'b')?.reason, 'Retired.')

    await batch.confirmAll()
    assert.deepEqual(confirmed, ['a', 'c'])
  })
})
