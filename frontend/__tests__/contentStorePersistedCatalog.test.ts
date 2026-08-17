import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  CONTENT_STORE_CATALOG_MAX_AGE_MS,
  CONTENT_STORE_CATALOG_SCHEMA_VERSION,
  contentAccountFingerprint,
  parsePersistedCatalog,
  persistableCatalog,
  restoredCatalogProducts,
  restoredCatalogShelves,
  serializePersistedCatalog,
} from '../content-store/persisted-catalog.js'
import type { ContentStoreProduct, ContentStoreShelf } from '../composables/useContentStore.js'

/**
 * Every account-scoped key GenStudio publishes on or beside a product, and
 * every key name that would betray one. If a key in this list ever appears in
 * a serialized catalogue, something true of a customer has been written to
 * disk and will be redrawn on a later launch as if it were still true.
 */
const ACCOUNT_SCOPED_KEYS = [
  'owned', 'ownedComponentCreditValue', 'ownedByActiveAccount', 'ownedComponents', 'owned_components',
  'account', 'accountId', 'account_id', 'contentAccountId', 'content_account_id',
  'availableCredits', 'contentSpendableCredits', 'creditsCharged', 'credits_charged',
  'balanceBefore', 'balanceAfter', 'balance_before', 'balance_after',
  'installed', 'installState', 'installedVersion', 'install_state', 'downloadAvailable',
  'entitlements', 'grantedAt', 'granted_families', 'purchaseId', 'purchase_id',
  'receiptVerification', 'receipt_verification', 'recalledReleaseVersions', 'missingDependencies',
  'attempts', 'quote_id', 'quoteId', 'quoted_credits', 'shortfall_credits', 'sufficient_credits',
  'refusal', 'capabilities', 'origin',
]

/**
 * Exactly what a saved catalogue may contain, as `path -> key` pairs.
 *
 * This list is the boundary. Adding a field to `PersistedContentCatalog`
 * fails this test until somebody adds it here too, which is the moment the
 * question "is this true of the catalogue or of this customer?" has to be
 * answered out loud instead of by accident.
 */
const ALLOWED_KEYS: Record<string, string[]> = {
  '': ['schemaVersion', 'capturedAt', 'accountFingerprint', 'products', 'shelves'],
  'products[]': [
    'productId', 'entitlementFamily', 'kind', 'title', 'summary', 'description', 'publisherId',
    'creditPrice', 'free', 'retired', 'successorProductId', 'currentRelease', 'bundleComponents',
    'showcaseVideos', 'presentation', 'discount',
  ],
  'products[].currentRelease': [
    'releaseId', 'packId', 'version', 'archiveSha256', 'archiveBytes', 'archiveAvailable',
    'minStoryVersion', 'changelog',
  ],
  'products[].bundleComponents[]': ['productId', 'entitlementFamily', 'title', 'kind', 'componentCreditValue'],
  'products[].showcaseVideos[]': ['url', 'title', 'description'],
  'products[].presentation': ['cover', 'hero', 'licenseLabel', 'licenseText', 'tags'],
  'products[].presentation.cover': ['src', 'alt'],
  'products[].presentation.hero': ['src', 'alt'],
  'products[].discount': [
    'id', 'version', 'percent', 'startsOn', 'endsOn', 'timezone', 'listCreditPrice', 'discountedCreditPrice',
  ],
  'shelves[]': ['id', 'title', 'productIds'],
}

function walkKeys(value: unknown, path: string, seen: Map<string, Set<string>>): void {
  if (Array.isArray(value)) {
    for (const entry of value) walkKeys(entry, `${path}[]`, seen)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const keys = seen.get(path) ?? new Set<string>()
  seen.set(path, keys)
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key)
    walkKeys(child, path ? `${path}.${key}` : key, seen)
  }
}

const SENTINEL = 'SENTINEL-ACCOUNT-FACT'

function overviewProduct(): ContentStoreProduct {
  return {
    productId: 'formula', entitlementFamily: 'formula.family', kind: 'series_formula',
    title: 'Archive Formula', summary: 'A repeatable documentary structure.',
    description: 'Long-form production guidance.', publisherId: 'Story Studio',
    creditPrice: 400, free: false, owned: true, retired: false, successorProductId: null,
    currentRelease: {
      releaseId: 'rel_formula', packId: 'pack_formula', version: '1.0.0',
      archiveSha256: 'a'.repeat(64), archiveBytes: 4_096, archiveAvailable: true,
      minStoryVersion: '1.0.834', changelog: 'First release.',
      componentSummary: { topics: 12, secretAccountNote: SENTINEL },
    },
    compatible: false, compatibilityReason: 'Needs a newer Story Studio.',
    bundleComponents: [{
      productId: 'topics', entitlementFamily: 'topics.family', title: 'Topic Pack',
      kind: 'topic_pack', componentCreditValue: 150, owned: true,
    }],
    ownedComponentCreditValue: 150,
    showcaseVideos: [{ url: 'https://example.test/v', title: 'Example', description: 'A sample.' }],
    presentation: {
      cover: { src: 'https://example.test/cover.webp', alt: 'Cover' },
      hero: { src: 'https://example.test/hero.webp', alt: 'Hero' },
      licenseLabel: 'Story Studio Content Pack License', licenseText: 'Use it in your channel.',
      tags: ['documentary', 'archive'],
    },
    discount: {
      id: 'cdsc_archive', version: 1, percent: 25, startsOn: null, endsOn: '2026-12-31',
      timezone: 'Asia/Phnom_Penh', listCreditPrice: 400, discountedCreditPrice: 300,
    },
  }
}

const shelves: ContentStoreShelf[] = [{ id: 'cshf_featured', title: 'Featured', productIds: ['formula'] }]

function catalog(products: ContentStoreProduct[] = [overviewProduct()]) {
  return persistableCatalog({
    products, shelves, accountFingerprint: 'f'.repeat(64), capturedAt: '2026-08-17T10:00:00.000Z',
  })
}

describe('the Content Store catalogue saved on this Mac', () => {
  test('writes exactly the declared catalogue keys and nothing else', () => {
    const seen = new Map<string, Set<string>>()
    walkKeys(JSON.parse(serializePersistedCatalog(catalog())), '', seen)

    for (const [path, keys] of seen) {
      const allowed = ALLOWED_KEYS[path]
      assert.ok(allowed, `unexpected object at "${path}" reached disk — declare it in ALLOWED_KEYS or stop persisting it`)
      for (const key of keys) {
        assert.ok(allowed.includes(key),
          `"${path}.${key}" reached disk without being declared. Decide whether it is a catalogue fact or an account fact before adding it to ALLOWED_KEYS.`)
      }
    }
    assert.deepEqual([...(seen.get('') ?? [])].sort(), [...ALLOWED_KEYS['']!].sort())
    assert.deepEqual([...(seen.get('products[]') ?? [])].sort(), [...ALLOWED_KEYS['products[]']!].sort())
  })

  test('no account-scoped key name appears anywhere in a saved catalogue', () => {
    const seen = new Map<string, Set<string>>()
    walkKeys(JSON.parse(serializePersistedCatalog(catalog())), '', seen)
    const written = new Set<string>()
    for (const keys of seen.values()) for (const key of keys) written.add(key)

    for (const forbidden of ACCOUNT_SCOPED_KEYS) {
      assert.equal(written.has(forbidden), false,
        `"${forbidden}" is true of an account, not of the catalogue, and must never be written to disk`)
    }
  })

  test('a field GenStudio adds upstream cannot ride along into the saved catalogue', () => {
    // Exactly the regression this file exists to catch: somebody widens the
    // product type upstream and a copy-shaped serializer carries the new field
    // to disk. Nothing here is spread, so none of these survive.
    const polluted = {
      ...overviewProduct(),
      ownedSinceLaunch: true,
      thisAccountsBalance: 9_999,
      newAccountScopedFieldNobodyAnticipated: SENTINEL,
      presentation: { ...overviewProduct().presentation, ownerNote: SENTINEL },
    } as unknown as ContentStoreProduct
    const written = serializePersistedCatalog(catalog([polluted]))

    assert.doesNotMatch(written, /SENTINEL-ACCOUNT-FACT/)
    assert.doesNotMatch(written, /ownedSinceLaunch|thisAccountsBalance|newAccountScopedFieldNobodyAnticipated|ownerNote/)
  })

  test('drops the derived compatibility verdict and the open componentSummary bag', () => {
    const written = serializePersistedCatalog(catalog())
    // `compatible` is computed against the running build, not published; it is
    // recomputed live. `componentSummary` is an unbounded Record whose contents
    // no allowlist here can promise, so it is never written at all.
    assert.doesNotMatch(written, /"compatible"|"compatibilityReason"|"componentSummary"/)
    assert.match(written, /"minStoryVersion":"1\.0\.834"/, 'the published compatibility metadata is kept')
  })

  test('keeps the public facts a customer actually came to see', () => {
    const saved = catalog()
    const product = saved.products[0]!
    assert.equal(product.title, 'Archive Formula')
    assert.equal(product.creditPrice, 400)
    assert.equal(product.discount?.discountedCreditPrice, 300)
    assert.equal(product.presentation.cover?.src, 'https://example.test/cover.webp')
    assert.deepEqual(product.presentation.tags, ['documentary', 'archive'])
    assert.equal(product.currentRelease?.version, '1.0.0')
    assert.deepEqual(saved.shelves, [{ id: 'cshf_featured', title: 'Featured', productIds: ['formula'] }])
  })

  test('restores a catalogue whose account-scoped placeholders assert nothing', () => {
    const parsed = parsePersistedCatalog(serializePersistedCatalog(catalog()), { now: Date.parse('2026-08-17T10:05:00Z') })
    assert.ok(parsed)
    const [product] = restoredCatalogProducts(parsed)
    assert.ok(product)
    assert.equal(product.owned, false, 'a placeholder, never displayed as a fact — the Store shows "checking" instead')
    assert.equal(product.ownedComponentCreditValue, 0)
    assert.equal(product.bundleComponents[0]?.owned, false)
    assert.equal(product.compatible, true, 'no incompatibility is claimed on evidence nobody has')
    assert.equal(product.compatibilityReason, null)
    assert.deepEqual(product.currentRelease?.componentSummary, {})
    assert.equal(product.title, 'Archive Formula')
    assert.deepEqual(restoredCatalogShelves(parsed), shelves)
  })
})

describe('when a saved Content Store catalogue is thrown away', () => {
  const now = Date.parse('2026-08-17T10:00:00Z')
  const savedAt = (iso: string) => serializePersistedCatalog(persistableCatalog({
    products: [overviewProduct()], shelves, accountFingerprint: 'f'.repeat(64), capturedAt: iso,
  }))

  test('a different schema version is discarded, never guessed at', () => {
    const future = JSON.parse(savedAt('2026-08-17T09:00:00Z'))
    future.schemaVersion = CONTENT_STORE_CATALOG_SCHEMA_VERSION + 1
    assert.equal(parsePersistedCatalog(JSON.stringify(future), { now }), null)
    const retired = JSON.parse(savedAt('2026-08-17T09:00:00Z'))
    retired.schemaVersion = 0
    assert.equal(parsePersistedCatalog(JSON.stringify(retired), { now }), null)
  })

  test('unreadable, empty and non-object blobs are discarded', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '"a string"', 'null']) {
      assert.equal(parsePersistedCatalog(raw, { now }), null)
    }
  })

  test('a catalogue older than the age bound is discarded rather than drawn', () => {
    const inside = new Date(now - CONTENT_STORE_CATALOG_MAX_AGE_MS + 60_000).toISOString()
    const outside = new Date(now - CONTENT_STORE_CATALOG_MAX_AGE_MS - 60_000).toISOString()
    assert.ok(parsePersistedCatalog(savedAt(inside), { now }))
    assert.equal(parsePersistedCatalog(savedAt(outside), { now }), null)
  })

  test('a stamp from the future is no evidence of freshness', () => {
    // Same rule the in-session cache applies: a skewed clock must not be able
    // to extend a cache's life.
    assert.equal(parsePersistedCatalog(savedAt('2026-09-01T00:00:00Z'), { now }), null)
    const unparseable = JSON.parse(savedAt('2026-08-17T09:00:00Z'))
    unparseable.capturedAt = 'whenever'
    assert.equal(parsePersistedCatalog(JSON.stringify(unparseable), { now }), null)
  })

  test('a blob missing its account fingerprint is discarded, because it cannot be matched to an account', () => {
    const orphan = JSON.parse(savedAt('2026-08-17T09:00:00Z'))
    delete orphan.accountFingerprint
    assert.equal(parsePersistedCatalog(JSON.stringify(orphan), { now }), null)
  })

  test('one malformed product discards the whole document rather than half of it', () => {
    const damaged = JSON.parse(savedAt('2026-08-17T09:00:00Z'))
    damaged.products.push({ productId: 'broken' })
    assert.equal(parsePersistedCatalog(JSON.stringify(damaged), { now }), null)

    const badKind = JSON.parse(savedAt('2026-08-17T09:00:00Z'))
    badKind.products[0].kind = 'something_new'
    assert.equal(parsePersistedCatalog(JSON.stringify(badKind), { now }), null)

    const badShelf = JSON.parse(savedAt('2026-08-17T09:00:00Z'))
    badShelf.shelves[0].productIds = [7]
    assert.equal(parsePersistedCatalog(JSON.stringify(badShelf), { now }), null)
  })

  test('a hand-added key is not read back into the running app', () => {
    const enriched = JSON.parse(savedAt('2026-08-17T09:00:00Z'))
    enriched.products[0].owned = true
    enriched.products[0].installState = 'installed_current'
    const parsed = parsePersistedCatalog(JSON.stringify(enriched), { now })
    assert.ok(parsed)
    assert.equal(Object.hasOwn(parsed.products[0]!, 'owned'), false)
    assert.equal(Object.hasOwn(parsed.products[0]!, 'installState'), false)
    assert.equal(restoredCatalogProducts(parsed)[0]?.owned, false)
  })
})

describe('the account fingerprint', () => {
  const account = { accountId: 'acct_a', contentAccountId: 'content_acct_a', origin: 'https://catalog.example.test' }

  test('is stable for the same account at the same origin', async () => {
    assert.equal(await contentAccountFingerprint(account), await contentAccountFingerprint({ ...account }))
  })

  test('changes when the account, the content account, or the origin changes', async () => {
    const base = await contentAccountFingerprint(account)
    assert.notEqual(base, await contentAccountFingerprint({ ...account, accountId: 'acct_b' }))
    assert.notEqual(base, await contentAccountFingerprint({ ...account, contentAccountId: 'content_acct_b' }))
    assert.notEqual(base, await contentAccountFingerprint({ ...account, origin: 'https://other.example.test' }))
  })

  test('is irreversible, so no account identifier is what actually reaches disk', async () => {
    const fingerprint = await contentAccountFingerprint(account)
    assert.ok(fingerprint)
    assert.match(fingerprint, /^[0-9a-f]{64}$/)
    for (const value of Object.values(account)) assert.equal(fingerprint.includes(value), false)
  })
})
