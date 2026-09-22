import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  GenStudioContentStoreApiError,
  GenStudioContentStoreTransportError,
  canonicalizeContentStoreObject,
  getGenStudioContentAccount,
  listGenStudioContentProducts,
  parseContentStoreAccount,
  parseContentStoreCatalog,
  parseContentStoreShelves,
  parseContentStorePurchase,
  parseContentStoreQuote,
  purchaseGenStudioContentProduct,
  quoteGenStudioContentProduct,
  resolveStoryStudioVersion,
} from '../lib/genstudio-content-store.js'
import { useTempDataDir } from './_helpers.js'

const SIGNATURE = Buffer.alloc(64, 7).toString('base64')
const HASH = 'a'.repeat(64)
const PACKAGE_VERSION = JSON.parse(await fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8')).version
const MERCHANDISING_FIXTURE = new URL('./fixtures/content-store-merchandising-contract.json', import.meta.url)

function release(overrides: Record<string, unknown> = {}) {
  return {
    release_id: 'crel_a',
    pack_id: 'com.storystudio.test',
    version: '1.0.0',
    archive_sha256: HASH,
    archive_bytes: 4096,
    min_story_version: '1.0.834',
    changelog: 'First release.',
    component_summary: { count: 3, future_component_fact: { nested: true } },
    future_release_fact: 'kept',
    ...overrides,
  }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    product_id: 'cprod_a',
    entitlement_family: 'com.storystudio.test',
    kind: 'series_formula',
    title: 'Test Formula',
    summary: 'A test formula.',
    description: 'A longer description.',
    publisher_id: 'com.storystudio',
    credit_price: 300,
    free: false,
    owned: false,
    retired: false,
    successor_product_id: null,
    current_release: release(),
    compatible: true,
    compatibility_reason: null,
    bundle_components: [{
      product_id: 'cprod_style',
      entitlement_family: 'com.storystudio.style.archival',
      title: 'Archival',
      kind: 'visual_style',
      component_credit_value: 100,
      owned: true,
      future_component_fact: 'kept',
    }],
    owned_component_credit_value: 100,
    cover: null,
    hero: null,
    tags: [],
    license: null,
    discount: null,
    future_product_fact: ['kept'],
    ...overrides,
  }
}

const SHOWCASE_VIDEOS = [
  { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Full example', description: 'A complete walkthrough.' },
  { url: 'https://www.youtube.com/shorts=dQw4w9WgXcQ', title: 'Invalid', description: '' },
] as const

function signedQuote(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'genstudio.content.quote.v1',
    key_id: 'key-1',
    quote_id: 'cq_test',
    account_id: 'acct_a',
    product_id: 'cprod_a',
    entitlement_family: 'com.storystudio.test',
    release_id: 'crel_a',
    release_version: '1.0.0',
    archive_sha256: HASH,
    base_credit_price: 400,
    discount_credits: 100,
    entitlement_families: ['com.storystudio.test'],
    bundle_closure: [],
    operator_discount: null,
    operator_discount_credits: 0,
    quoted_credits: 300,
    owned_components: ['com.storystudio.style.archival'],
    issued_at: '2026-08-14T10:00:00Z',
    expires_at: '2026-08-14T10:15:00Z',
    future_signed_fact: { z: 3, a: 1 },
    ...overrides,
  }
}

function quote(overrides: Record<string, unknown> = {}) {
  return {
    quote: signedQuote(),
    quote_signature: SIGNATURE,
    quote_id: 'cq_test',
    key_id: 'key-1',
    expires_at: '2026-08-14T10:15:00Z',
    account_id: 'acct_a',
    product_id: 'cprod_a',
    entitlement_family: 'com.storystudio.test',
    release_id: 'crel_a',
    base_credit_price: 400,
    discount_credits: 100,
    entitlement_families: ['com.storystudio.test'],
    bundle_closure: [],
    operator_discount: null,
    operator_discount_credits: 0,
    quoted_credits: 300,
    balance_before: 5000,
    balance_after: 4700,
    owned_components: ['com.storystudio.style.archival'],
    sufficient_credits: true,
    insufficient_reason: null,
    shortfall_credits: 0,
    ...overrides,
  }
}

function receiptPayload(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'genstudio.content.receipt.v1',
    key_id: 'key-1',
    receipt_id: 'crc_a',
    purchase_id: 'cpur_a',
    quote_id: 'cq_test',
    account_id: 'acct_a',
    entitlement_families: ['com.storystudio.test'],
    granted_families: ['com.storystudio.test'],
    previously_owned_families: [],
    bundle_closure: [],
    base_credit_price: 400,
    component_discount_credits: 100,
    operator_discount: null,
    operator_discount_credits: 0,
    product: {
      product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', kind: 'series_formula',
      title: 'Test Formula', summary: 'A test formula.', publisher_id: 'com.storystudio', credit_price: 300,
      future_product_receipt_fact: true,
    },
    release: release(),
    credits_charged: 300,
    issued_at: '2026-08-14T10:01:00Z',
    future_receipt_fact: { preserved: true },
    ...overrides,
  }
}

function purchase(overrides: Record<string, unknown> = {}) {
  const receipt = receiptPayload()
  return {
    purchase_id: 'cpur_a',
    account_id: 'acct_a',
    credits_charged: 300,
    discount_credits: 100,
    base_credit_price: 400,
    component_discount_credits: 100,
    operator_discount: null,
    operator_discount_credits: 0,
    balance_before: 5000,
    balance_after: 4700,
    entitlement_ids: ['cent_a'],
    entitlement_families: ['com.storystudio.test'],
    granted_families: ['com.storystudio.test'],
    previously_owned_families: [],
    bundle_closure: [],
    product: receipt.product,
    release: receipt.release,
    ledger_event_key: 'content-purchase:cpur_a',
    receipt: { receipt, receipt_signature: SIGNATURE, key_id: 'key-1' },
    replayed: false,
    ...overrides,
  }
}

describe('GenStudio Content Store 0.21 canonical parser', () => {
  test('preserves published shelves, media, tags, license, and discount display facts', async () => {
    const wire = JSON.parse(await fs.readFile(MERCHANDISING_FIXTURE, 'utf8'))
    const catalog = parseContentStoreCatalog(wire.products_response)
    const shelves = parseContentStoreShelves(
      wire.shelves_response,
      catalog.products.map(product => product.productId),
    )

    assert.deepEqual(
      [...shelves.shelves.map(shelf => shelf.productIds), shelves.fallbackProductIds],
      wire.expected_story_order,
    )
    assert.equal(catalog.products[0]?.cover?.url, wire.expected_cover_url)
    assert.equal(catalog.products[0]?.hero?.url, 'https://catalog.example.test/media/archival-ledger-hero.webp')
    assert.equal(catalog.products[0]?.license?.label, wire.expected_license_label)
    assert.deepEqual(catalog.products[0]?.tags, ['documentary', 'archive'])
    assert.equal(catalog.products[0]?.discount?.discountedCreditPrice, 200)
    assert.deepEqual(catalog.products[0]?.showcaseVideos, wire.products_response.products[0].showcase_videos)
  })

  test('refuses malformed merchandising facts before a catalog can hide or misrepresent a product', async () => {
    const wire = JSON.parse(await fs.readFile(MERCHANDISING_FIXTURE, 'utf8'))
    const product = wire.products_response.products[0]

    assert.throws(() => parseContentStoreCatalog({ products: [{ ...product, cover: { ...product.cover, url: 'http://catalog.example.test/cover.webp' } }] }), /cover|https/i)
    assert.throws(() => parseContentStoreCatalog({ products: [{ ...product, cover: { ...product.cover, url: 'https://catalog.example.test/v1%2Fcontent%2Farchives%2Fsecret' } }] }), /cover|archive/i)
    assert.throws(() => parseContentStoreCatalog({ products: [{ ...product, cover: null, hero: product.hero }] }), /hero|cover/i)
    assert.throws(() => parseContentStoreCatalog({ products: [{ ...product, tags: Array.from({ length: 13 }, () => 'tag') }] }), /tags|12/i)
    assert.throws(() => parseContentStoreCatalog({ products: [{ ...product, tags: ['Archive', 'archive'] }] }), /tags|unique/i)
    assert.throws(() => parseContentStoreCatalog({ products: [{ ...product, license: { ...product.license, label: 'a'.repeat(121) } }] }), /license|120/i)
    assert.throws(() => parseContentStoreCatalog({ products: [{ ...product, license: { ...product.license, text: 'a'.repeat(8001) } }] }), /license|8000/i)
    const withoutTags = { ...product }
    delete withoutTags.tags
    assert.throws(() => parseContentStoreCatalog({ products: [withoutTags] }), /tags/i)

    const productIds = wire.products_response.products.map((entry: { product_id: string }) => entry.product_id)
    assert.throws(() => parseContentStoreShelves({ shelves: [{ ...wire.shelves_response.shelves[0], product_ids: ['unknown'] }], fallback_product_ids: productIds.slice(1) }, productIds), /unknown/i)
    assert.throws(() => parseContentStoreShelves({ shelves: wire.shelves_response.shelves, fallback_product_ids: ['cprod_archival_ledger', 'cprod_production_look'] }, productIds), /duplicate/i)
    assert.throws(() => parseContentStoreShelves({ shelves: wire.shelves_response.shelves, fallback_product_ids: [] }, productIds), /missing/i)
  })

  test('the wire accepts every published kind, and one unknown kind still collapses the catalogue', () => {
    // The 2026-09-22 wire-kind parity letter: the Gateway may only publish a
    // kind this parse accepts, because one unknown kind is not a degraded
    // catalogue — it is no catalogue (the 1.4.62 font_pack incident). These
    // assertions are the contract the Gateway's SUPPORTED_KINDS mirrors on the
    // wire side, so both halves can be checked against the same spelling.
    for (const kind of [
      'series_formula', 'topic_pack', 'visual_style', 'thumbnail_recipe', 'font_pack', 'metadata_formula', 'niche_bundle',
    ]) {
      const catalog = parseContentStoreCatalog({ products: [{ ...product(), kind }] })
      assert.equal(catalog.products[0]?.kind, kind,
        `a delivered ${kind} product must parse and keep its wire spelling`)
    }

    assert.throws(
      () => parseContentStoreCatalog({ products: [{ ...product(), kind: 'unknown_kind_probe' }] }),
      /published Content Store product kind/i,
      'an unrecognised kind must still fail the whole parse rather than be skipped',
    )
  })

  test('preserves the complete signed quote while canonicalising recursively', () => {
    const parsed = parseContentStoreQuote(quote())
    const exact = parseContentStoreQuote(quote({ quote: signedQuote({
      z: 3,
      nested: { beta: 'é', alpha: [2, { y: false, x: null }] },
      a: 1,
    }) }))
    assert.equal(
      exact.signedQuote.canonicalJson,
      `{"a":1,"account_id":"acct_a","archive_sha256":"${HASH}","base_credit_price":400,"bundle_closure":[],"discount_credits":100,"entitlement_families":["com.storystudio.test"],"entitlement_family":"com.storystudio.test","expires_at":"2026-08-14T10:15:00Z","future_signed_fact":{"a":1,"z":3},"issued_at":"2026-08-14T10:00:00Z","key_id":"key-1","nested":{"alpha":[2,{"x":null,"y":false}],"beta":"é"},"operator_discount":null,"operator_discount_credits":0,"owned_components":["com.storystudio.style.archival"],"product_id":"cprod_a","quote_id":"cq_test","quoted_credits":300,"release_id":"crel_a","release_version":"1.0.0","typ":"genstudio.content.quote.v1","z":3}`,
    )
    assert.deepEqual(JSON.parse(exact.signedQuote.canonicalJson), exact.signedQuote.value)
    assert.equal(parsed.quoteId, 'cq_test')
  })

  test('accepts every product kind, nullable releases, retirement, free products, and an empty catalog', () => {
    const kinds = ['series_formula', 'topic_pack', 'visual_style', 'thumbnail_recipe', 'niche_bundle']
    const catalog = parseContentStoreCatalog({
      products: kinds.map((kind, index) => product({
        product_id: `cprod_${index}`,
        kind,
        current_release: index === 1 ? null : release({ release_id: `crel_${index}` }),
        free: index === 2,
        credit_price: index === 2 ? 0 : 300,
        owned: index === 3,
        retired: index === 3,
        compatible: index !== 4,
        compatibility_reason: index === 4 ? 'Requires Story Studio 2.0.0' : null,
      })),
    })
    assert.deepEqual(catalog.products.map(row => row.kind), kinds)
    assert.equal(catalog.products[1].currentRelease, null)
    assert.equal(catalog.products[2].free, true)
    assert.equal(catalog.products[3].retired, true)
    assert.equal(catalog.products[4].compatibilityReason, 'Requires Story Studio 2.0.0')
    assert.deepEqual(parseContentStoreCatalog({ products: [] }).products, [])
  })

  test('preserves unknown product, release, component-summary, and bundle-component fields', () => {
    const [parsed] = parseContentStoreCatalog({ products: [product()] }).products
    assert.deepEqual(parsed.raw.value.future_product_fact, ['kept'])
    assert.equal(parsed.currentRelease?.raw.value.future_release_fact, 'kept')
    assert.deepEqual(parsed.currentRelease?.componentSummary.value.future_component_fact, { nested: true })
    assert.equal(parsed.bundleComponents[0].raw.value.future_component_fact, 'kept')
  })

  test('parses canonical showcase videos in order and defaults a pre-1.7 product or owned row to none', () => {
    const videos = [SHOWCASE_VIDEOS[0], {
      url: 'https://youtu.be/9bZkp7q19f0', title: 'Short example', description: '',
    }]
    const parsed = parseContentStoreCatalog({ products: [product({ showcase_videos: videos }), product({ product_id: 'cprod_old' })] })
    assert.deepEqual(parsed.products[0].showcaseVideos, videos)
    assert.deepEqual(parsed.products[1].showcaseVideos, [])

    const account = parseContentStoreAccount({
      account_id: 'acct_a', content_account_id: 'acct_a', available_credits: 5300,
      content_spendable_credits: 5000,
      owned: [{
        entitlement_family: 'com.storystudio.test', product_id: 'cprod_a', title: 'Test Formula',
        kind: 'series_formula', granted_at: '2026-08-13T21:04:11Z', purchase_id: null,
        current_release: null, showcase_videos: videos,
      }],
    })
    assert.deepEqual(account.owned[0].showcaseVideos, videos)
  })

  test('rejects non-canonical or unsafe showcase video metadata and more than 12 entries', () => {
    assert.throws(() => parseContentStoreCatalog({ products: [product({ showcase_videos: [SHOWCASE_VIDEOS[1]] })] }), /showcase|url/i)
    assert.throws(() => parseContentStoreCatalog({ products: [product({ showcase_videos: [{
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '<b>markup</b>', description: '',
    }] })] }), /showcase|title|plain/i)
    assert.throws(() => parseContentStoreCatalog({ products: [product({ showcase_videos: [{
      url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Not  canonical', description: '',
    }] })] }), /showcase|title|canonical|plain/i)
    assert.throws(() => parseContentStoreCatalog({ products: [product({ showcase_videos: [{
      url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Example', description: '', unexpected: true,
    }] })] }), /showcase|exactly|unexpected/i)
    assert.throws(() => parseContentStoreCatalog({ products: [product({
      showcase_videos: Array.from({ length: 13 }, () => SHOWCASE_VIDEOS[0]),
    })] }), /showcase|12/i)
  })

  test('reads account ownership and uses the published content-spendable balance independently', () => {
    const parsed = parseContentStoreAccount({
      account_id: 'acct_a', content_account_id: 'acct_a', available_credits: 5300,
      content_spendable_credits: 5000,
      owned: [{
        entitlement_family: 'com.storystudio.test', product_id: 'cprod_a', title: 'Test Formula',
        kind: 'series_formula', granted_at: '2026-08-13T21:04:11Z', purchase_id: null,
        current_release: null,
      }],
    })
    assert.equal(parsed.availableCredits, 5300)
    assert.equal(parsed.contentSpendableCredits, 5000)
    assert.equal(parsed.owned[0].purchaseId, null)
    assert.equal(parsed.owned[0].currentRelease, null)
  })

  test('accepts unaffordable quotes while retaining the shortfall and signed bytes', () => {
    const parsed = parseContentStoreQuote(quote({
      balance_before: 50, balance_after: 50, sufficient_credits: false,
      insufficient_reason: 'insufficient_credits', shortfall_credits: 250,
    }))
    assert.equal(parsed.sufficientCredits, false)
    assert.equal(parsed.shortfallCredits, 250)
    assert.equal(parsed.insufficientReason, 'insufficient_credits')
  })

  test('accepts paid, free, and replayed purchases and preserves canonical receipt and snapshots', () => {
    const paid = parseContentStorePurchase(purchase())
    assert.equal(paid.creditsCharged, 300)
    assert.equal(paid.quoteId, 'cq_test')
    assert.equal(paid.ledgerEventKey, 'content-purchase:cpur_a')
    assert.equal(paid.replayed, false)
    assert.deepEqual(paid.receipt.signedReceipt.value.future_receipt_fact, { preserved: true })
    assert.equal(paid.product.value.future_product_receipt_fact, true)
    assert.equal(paid.release.value.future_release_fact, 'kept')

    const free = parseContentStorePurchase(purchase({
      credits_charged: 0,
      balance_after: 5000,
      ledger_event_key: null,
      receipt: { receipt: receiptPayload({ credits_charged: 0 }), receipt_signature: SIGNATURE, key_id: 'key-1' },
    }))
    assert.equal(free.creditsCharged, 0)
    assert.equal(free.ledgerEventKey, null)
    assert.equal(parseContentStorePurchase(purchase({ replayed: true })).replayed, true)
  })

  test('requires the exact 1.14 entitlement grant partition and one entitlement row per new family', () => {
    const bundledPurchase = () => {
      const value = purchase()
      const closure = [{
        position: 0, product_id: 'cprod_component', entitlement_family: 'com.storystudio.component',
        release_id: 'crel_component', version: '1.0.0', archive_sha256: HASH,
      }]
      const apply = (target: Record<string, unknown>) => {
        target.entitlement_families = ['com.storystudio.test', 'com.storystudio.component']
        target.granted_families = ['com.storystudio.test']
        target.previously_owned_families = ['com.storystudio.component']
        target.bundle_closure = closure
      }
      apply(value)
      apply(value.receipt.receipt as Record<string, unknown>)
      return value
    }

    assert.doesNotThrow(() => parseContentStorePurchase(bundledPurchase()))
    for (const mutate of [
      (value: Record<string, unknown>) => { value.previously_owned_families = ['com.storystudio.component', 'com.storystudio.test'] },
      (value: Record<string, unknown>) => { value.previously_owned_families = [] },
      (value: Record<string, unknown>) => { value.granted_families = ['com.storystudio.test', 'com.storystudio.other'] },
    ]) {
      const malformed = bundledPurchase()
      mutate(malformed)
      mutate(malformed.receipt.receipt as Record<string, unknown>)
      assert.throws(() => parseContentStorePurchase(malformed), /partition|subset|disjoint/i)
    }
    const duplicateEntitlements = bundledPurchase()
    duplicateEntitlements.entitlement_ids = ['cent_a', 'cent_b']
    assert.throws(() => parseContentStorePurchase(duplicateEntitlements), /entitlement_ids|one-for-one/i)
  })

  test('rejects signed payload type, key, and envelope mismatches', () => {
    const cases = [
      quote({ quote: signedQuote({ typ: 'genstudio.content.receipt.v1' }) }),
      quote({ quote: signedQuote({ key_id: 'other-key' }) }),
      quote({ quote: signedQuote({ quote_id: 'cq_other' }) }),
      quote({ quote: signedQuote({ account_id: 'acct_other' }) }),
      quote({ quote: signedQuote({ product_id: 'cprod_other' }) }),
      quote({ quote: signedQuote({ entitlement_family: 'com.other' }) }),
      quote({ quote: signedQuote({ release_id: 'crel_other' }) }),
      quote({ quote: signedQuote({ expires_at: '2026-08-14T10:16:00Z' }) }),
      quote({ quote: signedQuote({ base_credit_price: 401 }) }),
      quote({ quote: signedQuote({ discount_credits: 99 }) }),
      quote({ quote: signedQuote({ quoted_credits: 301 }) }),
      quote({ quote: signedQuote({ owned_components: [] }) }),
    ]
    for (const value of cases) assert.throws(() => parseContentStoreQuote(value), /signed quote|does not match/i)

    assert.throws(
      () => parseContentStorePurchase(purchase({ receipt: {
        receipt: receiptPayload({ typ: 'genstudio.content.quote.v1' }), receipt_signature: SIGNATURE, key_id: 'key-1',
      } })),
      /signed receipt/i,
    )
    assert.throws(
      () => parseContentStorePurchase(purchase({ receipt: {
        receipt: receiptPayload({ key_id: 'other-key' }), receipt_signature: SIGNATURE, key_id: 'key-1',
      } })),
      /key/i,
    )
    assert.throws(
      () => parseContentStorePurchase(purchase({ receipt: {
        receipt: receiptPayload({ credits_charged: 299 }), receipt_signature: SIGNATURE, key_id: 'key-1',
      } })),
      /receipt|does not match/i,
    )
  })

  test('fails closed on malformed, oversized, too-deep, dangerous, and non-JSON values', () => {
    assert.throws(() => canonicalizeContentStoreObject([]), /object/i)
    assert.throws(() => canonicalizeContentStoreObject(Object.assign(Object.create({ inherited: true }), { okay: true })), /prototype/i)
    assert.throws(() => canonicalizeContentStoreObject(JSON.parse('{"__proto__":1}')), /dangerous/i)
    assert.throws(() => canonicalizeContentStoreObject({ value: Number.POSITIVE_INFINITY }), /finite|JSON/i)
    assert.throws(() => canonicalizeContentStoreObject({ value: undefined }), /JSON/i)
    assert.throws(() => canonicalizeContentStoreObject({ value: 'x'.repeat(256 * 1024 + 1) }), /string/i)
    let deep: Record<string, unknown> = {}
    for (let index = 0; index < 34; index += 1) deep = { child: deep }
    assert.throws(() => canonicalizeContentStoreObject(deep), /depth/i)
    assert.throws(() => canonicalizeContentStoreObject({ values: Array.from({ length: 65_536 }, () => null) }), /nodes/i)
    assert.throws(() => canonicalizeContentStoreObject({ value: 'x'.repeat(1024 * 1024) }), /payload|string/i)
    assert.throws(() => parseContentStoreCatalog({ products: [product({ credit_price: -1 })] }), /credit_price/i)
    assert.throws(() => parseContentStoreCatalog({ products: [product({ credit_price: 1.5 })] }), /credit_price/i)
    assert.throws(() => parseContentStoreCatalog({ products: 'not-an-array' }), /products/i)
  })

  // Measured against the live catalogue on 2026-08-25: 82 products, every one
  // carrying a 390-931 character description, canonicalising to 3,873 JSON
  // nodes in 180 KB. That was 94.6% of the 4,096-node cap in force that day --
  // the shop was five products from going dark on its own, and the receipts
  // payload got there first. A catalogue this size must simply parse.
  test('parses the whole 82-product catalogue with real descriptions', () => {
    const products = Array.from({ length: 82 }, (_unused, index) => product({
      product_id: `cprod_${String(index).padStart(3, '0')}`,
      entitlement_family: `com.storystudio.pack.${String(index).padStart(3, '0')}`,
      title: `Catalogue Product ${index}`,
      summary: 'A one-line summary of the pack.',
      // The real descriptions run 390-931 characters; take the middle of that.
      description: `Product ${index}. `.padEnd(660, 'Descriptive prose about what this pack contains and who it is for. '),
      current_release: release({ release_id: `crel_${String(index).padStart(3, '0')}` }),
      cover: { url: `https://catalog.example.test/media/pack-${index}-cover.webp`, alt: `Cover art for pack ${index}` },
      hero: { url: `https://catalog.example.test/media/pack-${index}-hero.webp`, alt: `Hero art for pack ${index}` },
      tags: ['documentary', 'archive'],
      license: {
        label: 'Story Studio Content Pack License',
        text: 'Use this pack in Story Studio projects.\nDo not redistribute the archive.',
      },
    }))
    const catalog = parseContentStoreCatalog({ products })
    assert.equal(catalog.products.length, 82)
    assert.ok(catalog.products.every(row => row.description.length >= 390 && row.description.length <= 931))
    // Descriptions are worth bytes, not nodes -- `description` is a required
    // key that was already there when it was empty, which is why filling 82 of
    // them in could not have been what tripped a NODE cap. The byte bound is
    // the one they move, and this states how much room is left under it.
    const bytes = canonicalizeContentStoreObject({ products }).canonicalBytes.byteLength
    assert.ok(bytes > 150_000 && bytes < 1024 * 1024, `catalogue canonical bytes drifted: ${bytes}`)
  })

})

describe('GenStudio Content Store one-attempt HTTP client', () => {
  let restoreDataDir: (() => Promise<void>) | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const temp = await useTempDataDir()
    restoreDataDir = temp.cleanup
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await restoreDataDir?.()
  })

  test('sends exact account/catalog paths, bearer header, and story version', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      if (String(input).includes('/account')) return Response.json({
        account_id: 'acct_a', content_account_id: 'acct_a', available_credits: 5300,
        content_spendable_credits: 5000, owned: [],
      })
      return Response.json({ products: [] })
    }
    assert.equal((await getGenStudioContentAccount('gsk_test')).contentSpendableCredits, 5000)
    assert.deepEqual((await listGenStudioContentProducts('gsk_test', '1.0.834')).products, [])
    assert.deepEqual(calls.map(call => call.url), [
      'http://127.0.0.1:8787/v1/content/account',
      'http://127.0.0.1:8787/v1/content/products?story_version=1.0.834',
    ])
    for (const call of calls) {
      assert.equal(call.init?.method, 'GET')
      assert.equal((call.init?.headers as Record<string, string>).Authorization, 'Bearer gsk_test')
    }
  })

  test('sends an exact quote body once even after a 503 refusal', async () => {
    let attempts = 0
    globalThis.fetch = async (input, init) => {
      attempts += 1
      assert.equal(String(input), 'http://127.0.0.1:8787/v1/content/quotes')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.body, JSON.stringify({ product_id: 'cprod_a', release_id: null }))
      return Response.json({ code: 'signing_unavailable', detail: 'signer offline' }, { status: 503 })
    }
    await assert.rejects(
      quoteGenStudioContentProduct('gsk_test', { product_id: 'cprod_a', release_id: null }),
      (error: unknown) => error instanceof GenStudioContentStoreApiError
        && error.status === 503 && error.code === 'signing_unavailable'
        && error.detail === 'signer offline',
    )
    assert.equal(attempts, 1)
  })

  test('preserves Python numeric lexemes from signed response bytes', async () => {
    const response = quote()
    const raw = JSON.stringify(response).replace(
      '"future_signed_fact":{"z":3,"a":1}',
      '"future_signed_fact":{"integral_float":1.0,"negative_zero":-0.0,"small":1e-07,"large":1e+20}',
    )
    globalThis.fetch = async () => new Response(raw, { status: 200 })
    const parsed = await quoteGenStudioContentProduct('gsk_test', { product_id: 'cprod_a', release_id: null })
    assert.match(parsed.signedQuote.canonicalJson, /"future_signed_fact":\{"integral_float":1\.0,"large":1e\+20,"negative_zero":-0\.0,"small":1e-07\}/)
  })

  test('reconstructs the purchase body only from canonical quote bytes and sends one idempotent attempt', async () => {
    let attempts = 0
    const canonical = canonicalizeContentStoreObject(signedQuote())
    globalThis.fetch = async (input, init) => {
      attempts += 1
      assert.equal(String(input), 'http://127.0.0.1:8787/v1/content/purchases')
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>)['Idempotency-Key'], 'store-attempt-123')
      assert.equal(init?.body, JSON.stringify({ quote: JSON.parse(canonical.canonicalJson), quote_signature: SIGNATURE }))
      return Response.json(purchase())
    }
    const parsed = await purchaseGenStudioContentProduct('gsk_test', {
      quoteCanonicalJson: canonical.canonicalJson,
      quoteSignature: SIGNATURE,
      idempotencyKey: 'store-attempt-123',
    })
    assert.equal(parsed.purchaseId, 'cpur_a')
    assert.equal(attempts, 1)
  })

  test('sends signed quote numeric lexemes without a JavaScript reserialization', async () => {
    const canonical = canonicalizeContentStoreObject(signedQuote()).canonicalJson.replace(
      '"future_signed_fact":{"a":1,"z":3}',
      '"future_signed_fact":{"integral_float":1.0,"large":1e+20,"negative_zero":-0.0,"small":1e-07}',
    )
    globalThis.fetch = async (_input, init) => {
      assert.equal(
        init?.body,
        `{"quote":${canonical},"quote_signature":${JSON.stringify(SIGNATURE)}}`,
      )
      return Response.json(purchase())
    }
    await purchaseGenStudioContentProduct('gsk_test', {
      quoteCanonicalJson: canonical,
      quoteSignature: SIGNATURE,
      idempotencyKey: 'store-attempt-123',
    })
  })

  test('preserves exact 402/404/409/503 refusal facts without classifying a response as uncertain', async () => {
    const cases = [
      { status: 402, code: 'insufficient_credits', extra: { required_credits: 300, available_credits: 50, shortfall_credits: 250 } },
      { status: 404, code: 'product_unavailable', extra: {} },
      { status: 404, code: 'release_unavailable', extra: {} },
      { status: 409, code: 'already_owned', extra: {} },
      { status: 409, code: 'quote_rejected', extra: {} },
      { status: 503, code: 'signing_unavailable', extra: {} },
    ]
    for (const row of cases) {
      let calls = 0
      globalThis.fetch = async () => {
        calls += 1
        return Response.json({ code: row.code, detail: `detail-${row.code}`, ...row.extra }, { status: row.status })
      }
      await assert.rejects(
        purchaseGenStudioContentProduct('gsk_test', {
          quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
          quoteSignature: SIGNATURE,
          idempotencyKey: 'store-attempt-123',
        }),
        (error: unknown) => {
          assert.ok(error instanceof GenStudioContentStoreApiError)
          assert.equal(error.status, row.status)
          assert.equal(error.code, row.code)
          assert.equal(error.refusal.code, row.code)
          if (row.status === 402) {
            assert.equal(error.refusal.required_credits, 300)
            assert.equal(error.refusal.available_credits, 50)
            assert.equal(error.refusal.shortfall_credits, 250)
          }
          return true
        },
      )
      assert.equal(calls, 1)
    }
  })

  test('classifies purchase network uncertainty separately from a synchronous not-sent failure', async () => {
    let calls = 0
    globalThis.fetch = () => {
      calls += 1
      return Promise.reject(new Error('socket closed'))
    }
    await assert.rejects(
      purchaseGenStudioContentProduct('gsk_test', {
        quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
        quoteSignature: SIGNATURE,
        idempotencyKey: 'store-attempt-123',
      }),
      (error: unknown) => error instanceof GenStudioContentStoreTransportError && error.outcome === 'uncertain',
    )
    assert.equal(calls, 1)

    globalThis.fetch = (() => { throw new TypeError('invalid URL') }) as typeof fetch
    await assert.rejects(
      purchaseGenStudioContentProduct('gsk_test', {
        quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
        quoteSignature: SIGNATURE,
        idempotencyKey: 'store-attempt-123',
      }),
      (error: unknown) => error instanceof GenStudioContentStoreTransportError && error.outcome === 'not-sent',
    )
  })

  test('rejects an oversized refusal body before retaining it', async () => {
    globalThis.fetch = async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 503 })
    await assert.rejects(
      purchaseGenStudioContentProduct('gsk_test', {
        quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
        quoteSignature: SIGNATURE,
        idempotencyKey: 'store-attempt-123',
      }),
      /response|large|limit/i,
    )
  })

  test('stops reading an oversized streamed response and treats purchase body failure as uncertain', async () => {
    let pulls = 0
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(128 * 1024))
      },
    }), { status: 503 })
    await assert.rejects(
      purchaseGenStudioContentProduct('gsk_test', {
        quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
        quoteSignature: SIGNATURE,
        idempotencyKey: 'store-attempt-123',
      }),
      /response|large|limit/i,
    )
    assert.ok(pulls <= 10, `bounded reader pulled ${pulls} chunks before stopping`)

    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"purchase_id":'))
        controller.error(new Error('connection reset during body'))
      },
    }), { status: 200 })
    await assert.rejects(
      purchaseGenStudioContentProduct('gsk_test', {
        quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
        quoteSignature: SIGNATURE,
        idempotencyKey: 'store-attempt-123',
      }),
      (error: unknown) => error instanceof GenStudioContentStoreTransportError && error.outcome === 'uncertain',
    )

    globalThis.fetch = async () => new Response('{"purchase_id":', { status: 200 })
    await assert.rejects(
      purchaseGenStudioContentProduct('gsk_test', {
        quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
        quoteSignature: SIGNATURE,
        idempotencyKey: 'store-attempt-123',
      }),
      (error: unknown) => error instanceof GenStudioContentStoreTransportError && error.outcome === 'uncertain',
    )

    globalThis.fetch = async () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 })
    await assert.rejects(
      purchaseGenStudioContentProduct('gsk_test', {
        quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
        quoteSignature: SIGNATURE,
        idempotencyKey: 'store-attempt-123',
      }),
      (error: unknown) => error instanceof GenStudioContentStoreTransportError && error.outcome === 'uncertain',
    )

    globalThis.fetch = async () => Response.json({})
    await assert.rejects(
      purchaseGenStudioContentProduct('gsk_test', {
        quoteCanonicalJson: canonicalizeContentStoreObject(signedQuote()).canonicalJson,
        quoteSignature: SIGNATURE,
        idempotencyKey: 'store-attempt-123',
      }),
      (error: unknown) => error instanceof GenStudioContentStoreTransportError && error.outcome === 'uncertain',
    )
  })

  test('does not retry a quote after a socket failure', async () => {
    let calls = 0
    globalThis.fetch = () => {
      calls += 1
      return Promise.reject(new Error('socket closed'))
    }
    await assert.rejects(quoteGenStudioContentProduct('gsk_test', { product_id: 'cprod_a', release_id: null }))
    assert.equal(calls, 1)
  })

  test('resolves the current source version through the generic resolver', async () => {
    assert.equal(await resolveStoryStudioVersion({ packaged: false }), PACKAGE_VERSION)
    assert.equal(await resolveStoryStudioVersion({ packaged: true, electronVersion: '8.2.1' }), '8.2.1')
  })
})
