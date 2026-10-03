import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, test } from 'node:test'

const completeOverview = {
  phase: 'delivery_ready' as const,
  origin: 'https://catalog.example.test',
  account: {
    accountId: 'acct_a',
    contentAccountId: 'content_acct_a',
    availableCredits: 2_400,
    contentSpendableCredits: 1_650,
    owned: [],
  },
  products: [
    {
      productId: 'formula', entitlementFamily: 'formula.family', kind: 'series_formula' as const,
      title: 'Archive Formula', summary: 'A repeatable documentary structure.',
      description: 'Long-form production guidance.', publisherId: 'Story Studio',
      creditPrice: 400, free: false, owned: false, retired: false,
      successorProductId: null, compatible: true, compatibilityReason: null,
      currentRelease: {
        releaseId: 'rel_formula', packId: 'pack_formula', version: '1.0.0',
        archiveSha256: 'a'.repeat(64), archiveBytes: 4_096,
        archiveAvailable: true,
        minStoryVersion: '1.0.834', changelog: 'First release.', componentSummary: {},
      },
      bundleComponents: [], ownedComponentCreditValue: 0,
      presentation: {
        cover: { src: 'https://catalog.example.test/covers/archive-formula.webp', alt: 'Archive Formula cover' },
        licenseLabel: 'Story Studio Content Pack License',
        tags: ['documentary', 'archive'],
      },
      discount: {
        id: 'cdsc_archive_formula', version: 1, percent: 25,
        startsOn: null, endsOn: '2026-12-31', timezone: 'Asia/Phnom_Penh',
        listCreditPrice: 400, discountedCreditPrice: 300,
      },
    },
  ],
  shelves: [{ id: 'cshf_featured', title: 'Featured', productIds: ['formula'] }],
  attempts: [],
  capabilities: {
    purchase: true, receipt_verification: true, download: true,
    install_after_purchase: true, restore: true,
  },
}

let calls: Array<{ path: string; options: Record<string, unknown> }> = []
let handler: (path: string, options: Record<string, unknown>) => unknown

;(globalThis as any).$fetch = async (path: string, options: Record<string, unknown> = {}) => {
  calls.push({ path, options })
  return handler(path, options)
}

const {
  useContentStore,
  contentStoreErrorPresentation,
  _clearContentStoreSessionCacheForTests,
  _contentStoreCatalogPersistedForTests,
  CONTENT_STORE_CACHE_TTL_MS,
} = await import('../composables/useContentStore.js')
const {
  CONTENT_STORE_CATALOG_MAX_AGE_MS,
  CONTENT_STORE_CATALOG_STORAGE_KEY,
  contentAccountFingerprint,
  persistableCatalog,
  serializePersistedCatalog,
} = await import('../content-store/persisted-catalog.js')

function goOffline(): void {
  handler = () => {
    throw Object.assign(new Error('offline'), { data: { code: 'CONTENT_STORE_UNAVAILABLE', detail: 'Offline.' } })
  }
}

beforeEach(() => {
  _clearContentStoreSessionCacheForTests()
  calls = []
  handler = path => {
    if (path === '/api/content-store') return structuredClone(completeOverview)
    throw new Error(`Unexpected request: ${path}`)
  }
})

describe('useContentStore explicit commerce state machine', () => {
  test('shares only same-account same-origin verified catalog proof with a new route instance offline', async () => {
    const overview = { ...structuredClone(completeOverview), origin: 'https://catalog.example.test' }
    handler = path => {
      if (path !== '/api/content-store') throw new Error(`Unexpected request: ${path}`)
      if (calls.filter(call => call.path === path).length === 1) return overview
      throw Object.assign(new Error('offline'), { data: { code: 'CONTENT_STORE_UNAVAILABLE', detail: 'Offline.' } })
    }
    const shelf = useContentStore()
    await shelf.refresh()
    const proof = useContentStore()

    assert.equal(proof.products.value[0]?.productId, 'formula')
    assert.equal(proof.catalogFreshness.value, 'fresh')
    await assert.rejects(proof.refresh())
    assert.equal(proof.catalogFreshness.value, 'cached')
    assert.deepEqual(proof.cachedProof.value, {
      accountId: 'acct_a', origin: 'https://catalog.example.test', verifiedAt: shelf.lastVerifiedAt.value,
    })
    assert.equal(proof.lastVerifiedAt.value, shelf.lastVerifiedAt.value)
  })

  test('replaces shared proof when GenStudio verifies a different account or origin', async () => {
    const first = { ...structuredClone(completeOverview), origin: 'https://one.example.test' }
    const second = {
      ...structuredClone(completeOverview),
      origin: 'https://two.example.test',
      account: { ...completeOverview.account, accountId: 'acct_b', contentAccountId: 'content_b' },
      products: [{ ...completeOverview.products[0]!, productId: 'formula-b', title: 'Account B Formula' }],
    }
    let reads = 0
    handler = path => {
      if (path !== '/api/content-store') throw new Error(`Unexpected request: ${path}`)
      reads += 1
      return reads === 1 ? first : second
    }
    const accountA = useContentStore()
    await accountA.refresh()
    const accountB = useContentStore()
    await accountB.refresh()
    const offlineAfterAccountSwitch = useContentStore()

    assert.equal(accountB.account.value?.accountId, 'acct_b')
    assert.equal(accountA.account.value?.accountId, 'acct_b')
    assert.equal(offlineAfterAccountSwitch.account.value?.accountId, 'acct_b')
    assert.equal(offlineAfterAccountSwitch.products.value[0]?.productId, 'formula-b')
    assert.equal(offlineAfterAccountSwitch.catalogFreshness.value, 'fresh')
    assert.equal(offlineAfterAccountSwitch.cachedProof.value, null)
  })

  test('shares historical A proof, then updates every mounted Store consumer when detail verifies B', async () => {
    const accountA = { ...structuredClone(completeOverview), origin: 'https://a.example.test' }
    const accountB = {
      ...structuredClone(completeOverview), origin: 'https://b.example.test',
      account: { ...completeOverview.account, accountId: 'acct_b', contentAccountId: 'content_b' },
      products: [{ ...completeOverview.products[0]!, productId: 'formula-b', title: 'Account B Formula' }],
    }
    let reads = 0
    handler = path => {
      if (path !== '/api/content-store') throw new Error(`Unexpected request: ${path}`)
      reads += 1
      if (reads === 1) return accountA
      if (reads === 2) throw Object.assign(new Error('offline'), { data: { code: 'CONTENT_STORE_UNAVAILABLE', detail: 'Offline.' } })
      return accountB
    }
    const shelf = useContentStore()
    const detail = useContentStore()
    await shelf.refresh()
    await assert.rejects(detail.refresh())
    assert.equal(shelf.catalogFreshness.value, 'cached')
    assert.equal(shelf.cachedProof.value?.accountId, 'acct_a')
    assert.equal(detail.products.value[0]?.title, 'Archive Formula')
    await detail.refresh()

    for (const store of [shelf, detail]) {
      assert.equal(store.catalogFreshness.value, 'fresh')
      assert.equal(store.account.value?.accountId, 'acct_b')
      assert.equal(store.products.value[0]?.productId, 'formula-b')
      assert.equal(store.cachedProof.value, null)
    }
  })

  test('does not let a stale A response from one consumer overwrite a newer B proof', async () => {
    const accountA = { ...structuredClone(completeOverview), origin: 'https://a.example.test' }
    const accountB = {
      ...structuredClone(completeOverview), origin: 'https://b.example.test',
      account: { ...completeOverview.account, accountId: 'acct_b', contentAccountId: 'content_b' },
      products: [{ ...completeOverview.products[0]!, productId: 'formula-b', title: 'Account B Formula' }],
    }
    let releaseA: ((overview: typeof accountA) => void) | null = null
    let reads = 0
    handler = path => {
      if (path !== '/api/content-store') throw new Error(`Unexpected request: ${path}`)
      reads += 1
      if (reads === 1) return new Promise<typeof accountA>(resolve => { releaseA = resolve })
      return accountB
    }
    const shelf = useContentStore()
    const detail = useContentStore()
    const staleRefresh = shelf.refresh()
    await detail.refresh()
    releaseA!(accountA)
    await staleRefresh

    for (const store of [shelf, detail]) {
      assert.equal(store.account.value?.accountId, 'acct_b')
      assert.equal(store.products.value[0]?.productId, 'formula-b')
      assert.equal(store.catalogFreshness.value, 'fresh')
    }
  })

  for (const failure of [
    ['CONTENT_STORE_KEY_REQUIRED', 'Content Store access is needed'],
    ['CONTENT_STORE_SCOPE_REQUIRED', 'Content Store access is needed'],
    ['CONTENT_PRODUCT_NOT_AVAILABLE', 'This product is not available'],
    ['CONTENT_PRODUCT_ALREADY_OWNED', 'Already owned in GenStudio'],
    ['CONTENT_PRODUCT_RETIRED', 'This product is retired'],
    ['CONTENT_PRODUCT_INCOMPATIBLE', 'A newer Story Studio version is needed'],
    ['CONTENT_RELEASE_NOT_AVAILABLE', 'This release is not available'],
    ['CONTENT_STORE_QUOTE_NOT_FOUND', 'This quote is no longer available'],
    ['CONTENT_PURCHASE_NOT_SENT', 'This purchase was not sent'],
    ['CONTENT_PACK_TOO_LARGE_FOR_THIS_APP', 'This archive is too large to install safely'],
    ['CONTENT_PACK_REQUIRES_NEWER_APP', 'A newer Story Studio version is needed'],
    ['incompatible_story_version', 'A newer Story Studio version is needed'],
    ['insufficient_credits', 'More credits are needed'],
    ['quote_expired', 'This quote can no longer be used'],
    ['quote_rejected', 'This quote can no longer be used'],
    ['CONTENT_PURCHASE_OUTCOME_UNCERTAIN', 'GenStudio’s answer is uncertain'],
    ['signing_unavailable', 'The Content Store is not open yet'],
    ['CONTENT_STORE_ACCOUNT_MISMATCH', 'Ownership could not be confirmed'],
    ['CONTENT_PURCHASE_ACCOUNT_MISMATCH', 'Ownership could not be confirmed'],
    ['CONTENT_PACK_NOT_OWNED', 'Ownership could not be confirmed'],
    ['CONTENT_STORE_SIGNING_KEY_MISSING', 'Content Store access is needed'],
    ['CONTENT_PACK_OWNED_RELEASE_MISMATCH', 'Ownership could not be confirmed'],
    ['CONTENT_PACK_ARCHIVE_UNAVAILABLE', 'This archive is not available'],
    ['CONTENT_PACK_DEPENDENCY_NOT_OWNED', 'This Content Pack cannot be installed'],
    ['CONTENT_PACK_NESTED_CLOSURE_UNSUPPORTED', 'This Content Pack cannot be installed'],
    ['CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH', 'GenStudio has not attested to the versions this pack requires'],
    ['CONTENT_PACK_RECEIPT_MISSING', 'This Content Pack could not be verified'],
    ['CONTENT_PACK_REMOTE_IDENTITY_MISMATCH', 'This Content Pack could not be verified'],
    ['CONTENT_STORE_REQUEST_INVALID', 'This Content Store request is invalid'],
    ['CONTENT_STORE_REQUEST_TOO_LARGE', 'This Content Store request is invalid'],
    ['CONTENT_STORE_UPSTREAM_REFUSED', 'GenStudio could not complete this request'],
    ['download_grant_expired', 'The download authorization expired'],
    ['archive_limit_exceeded', 'This archive is too large to install safely'],
    ['CONTENT_PACK_SIGNATURE_INVALID', 'This Content Pack could not be verified'],
    ['CONTENT_PACK_ARCHIVE_HASH_MISMATCH', 'This Content Pack could not be verified'],
    ['CONTENT_PACK_SCHEMA_INVALID', 'This Content Pack could not be verified'],
    ['CONTENT_PACK_ASSET_INVALID', 'This Content Pack could not be verified'],
    ['CONTENT_PACK_DEPENDENCY_CYCLE', 'This Content Pack cannot be installed'],
    ['release_recalled', 'A Content Pack release was recalled'],
    ['CONTENT_PACK_DISK_UNAVAILABLE', 'This Mac could not prepare the install'],
    ['CONTENT_PACK_STAGING_FAILED', 'This Mac could not prepare the install'],
    ['CONTENT_PACK_ACTIVATION_FAILED', 'This Mac could not prepare the install'],
  ] as const) {
    test(`turns ${failure[0]} into a distinct recovery state`, () => {
      const presentation = contentStoreErrorPresentation({ status: failure[0] === 'release_recalled' ? 410 : 409, code: failure[0], detail: 'Exact local failure detail.' })
      assert.equal(presentation.title, failure[1])
      assert.match(presentation.detail, /Exact local failure detail/)
    })
  }

  test('offers connection settings only for recoverable Store key and scope refusals', () => {
    assert.equal(contentStoreErrorPresentation({ status: 401, code: 'CONTENT_STORE_KEY_REQUIRED', detail: 'x' }).settingsAction, true)
    assert.equal(contentStoreErrorPresentation({ status: 401, code: 'CONTENT_STORE_SCOPE_REQUIRED', detail: 'x' }).settingsAction, true)
    assert.equal(contentStoreErrorPresentation({ status: 502, code: 'CONTENT_STORE_UPSTREAM_REFUSED', detail: 'x' }).settingsAction, false)
  })

  test('names a payload the installed build cannot read instead of calling the Store unavailable', () => {
    const presentation = contentStoreErrorPresentation({
      status: 502,
      code: 'CONTENT_STORE_PAYLOAD_TOO_LARGE',
      detail: 'Content Store JSON is too large to read: it holds more than 65536 JSON nodes. (GenStudio /v1/content/receipts)',
    })
    assert.notEqual(presentation.title, 'The Content Store is unavailable')
    assert.match(presentation.detail, /\/v1\/content\/receipts/)
    assert.match(presentation.recovery, /Update Story Studio/)
  })

  /**
   * A restore receipt is minted fresh on every call, so a refresh produces a
   * byte-for-byte identical attestation and the identical refusal. Telling the
   * customer to refresh is a remedy that is structurally incapable of working,
   * and it reads as "try again" -- so they do, repeatedly, on a day the pack
   * is not going to install.
   */
  test('never tells a closure mismatch to refresh, because refreshing re-mints the same receipt', () => {
    const presentation = contentStoreErrorPresentation({
      status: 409, code: 'CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH', detail: 'Exact local failure detail.',
    })
    assert.match(presentation.detail, /Exact local failure detail/)
    // The exact false instruction it used to carry, and the reason it was false.
    assert.doesNotMatch(presentation.recovery, /Refresh the owned release/)
    assert.match(presentation.recovery, /will not clear this/i)
    // And it no longer shares its wording with the three unrelated codes it
    // was lumped in with, which do have a refresh worth trying.
    assert.notEqual(
      presentation.recovery,
      contentStoreErrorPresentation({ status: 409, code: 'CONTENT_PACK_DEPENDENCY_NOT_OWNED', detail: 'x' }).recovery,
    )
  })

  test('uses one generic recovery boundary for an unrecognized public code', () => {
    const presentation = contentStoreErrorPresentation({ status: 502, code: 'CONTENT_STORE_FUTURE_REFUSAL', detail: 'Safe exact detail.' })
    assert.equal(presentation.title, 'The Content Store is unavailable')
    assert.match(presentation.detail, /Safe exact detail/)
  })

  test('keeps the last verified catalog and marks it cached when a later refresh is unavailable', async () => {
    let overviewReads = 0
    handler = path => {
      if (path !== '/api/content-store') throw new Error(`Unexpected request: ${path}`)
      overviewReads += 1
      if (overviewReads === 1) return structuredClone(completeOverview)
      const unavailable: any = new Error('offline')
      unavailable.data = { code: 'CONTENT_STORE_UNAVAILABLE', detail: 'The catalog could not be reached.' }
      throw unavailable
    }

    const store = useContentStore()
    await store.refresh()
    const verifiedAt = store.lastVerifiedAt.value
    await assert.rejects(store.refresh())

    assert.equal(store.catalogFreshness.value, 'cached')
    assert.equal(store.lastVerifiedAt.value, verifiedAt)
    assert.equal(store.products.value[0]?.title, 'Archive Formula')
    assert.equal(store.error.value?.code, 'CONTENT_STORE_UNAVAILABLE')
  })

  test('marks an initial unavailable catalog as unavailable instead of presenting an empty authenticated catalog', async () => {
    handler = () => {
      const unavailable: any = new Error('offline')
      unavailable.data = { code: 'CONTENT_STORE_UNAVAILABLE', detail: 'The catalog could not be reached.' }
      throw unavailable
    }
    const store = useContentStore()

    await assert.rejects(store.refresh())

    assert.equal(store.catalogFreshness.value, 'unavailable')
    assert.equal(store.account.value, null)
    assert.deepEqual(store.products.value, [])
  })

  test('retains server-normalized merchandising facts without deriving a price or shelf', async () => {
    const store = useContentStore()
    await store.refresh()

    assert.deepEqual(store.shelves.value, completeOverview.shelves)
    assert.deepEqual(store.products.value[0]?.presentation, completeOverview.products[0]?.presentation)
    assert.deepEqual(store.products.value[0]?.discount, completeOverview.products[0]?.discount)
  })

  test('loads only on explicit refresh and never polls or purchases on its own', async () => {
    const store = useContentStore()
    assert.equal(calls.length, 0)

    await store.refresh()
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.path, '/api/content-store')
    assert.deepEqual(store.account.value, completeOverview.account)
    assert.deepEqual(store.products.value, completeOverview.products)

    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls.length, 1, 'the Store must not poll or retry commerce calls')
  })

  test('does not let an older refresh overwrite a newer explicit install overview', async () => {
    let releaseRefresh: ((value: unknown) => void) | undefined
    const installed = structuredClone(completeOverview)
    installed.account.availableCredits = 2_399
    handler = (path) => {
      if (path === '/api/content-store') return new Promise(resolve => { releaseRefresh = resolve })
      if (path === '/api/content-store/releases/rel_formula/install') {
        return { install: { pack_id: 'pack_formula', version: '1.0.0', activated: true }, overview: installed }
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    const staleRefresh = store.refresh()
    await Promise.resolve()
    await store.installRelease('rel_formula')
    releaseRefresh?.(structuredClone(completeOverview))
    await staleRefresh
    assert.equal(store.account.value?.availableCredits, 2_399)
  })

  test('does not let an older refresh overwrite completed purchase reconciliation', async () => {
    let releaseRefresh: ((value: unknown) => void) | undefined
    const completed = {
      quote_id: 'cq_purchase', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'completed' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 2_400, balance_after: 2_000, owned_components: [], sufficient_credits: true,
      insufficient_reason: null, shortfall_credits: 0, ownership: 'owned_not_installed' as const,
      credits_charged: 400, replayed: false, receipt_verification: 'unverified_phase1' as const,
    }
    const reconciled = structuredClone(completeOverview)
    reconciled.account.availableCredits = 2_000
    reconciled.attempts = [completed]
    let overviewReads = 0
    handler = path => {
      if (path === '/api/content-store') {
        overviewReads += 1
        return overviewReads === 1 ? new Promise(resolve => { releaseRefresh = resolve }) : reconciled
      }
      if (path.endsWith('/purchase')) return completed
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    const staleRefresh = store.refresh()
    await Promise.resolve()
    await store.confirmPurchase('cq_purchase')
    releaseRefresh?.(structuredClone(completeOverview))
    await staleRefresh
    assert.equal(store.account.value?.availableCredits, 2_000)
    assert.equal(store.attempts.value[0]?.status, 'completed')
  })

  test('requests one exact quote only after the customer asks', async () => {
    const quoted = {
      quote_id: 'cq_1', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 1_650, balance_after: 1_250, owned_components: [],
      sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
    }
    handler = (path, options) => {
      if (path === '/api/content-store/quotes') {
        assert.equal(options.method, 'POST')
        assert.deepEqual(options.body, { product_id: 'formula', release_id: 'rel_formula' })
        return quoted
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    const result = await store.requestQuote('formula', 'rel_formula')
    assert.deepEqual(result, quoted)
    assert.deepEqual(store.attempts.value, [quoted])
    assert.equal(calls.length, 1)
  })

  test('restores ownership and installs only after explicit customer actions', async () => {
    const owned = {
      ...structuredClone(completeOverview),
      account: {
        ...structuredClone(completeOverview.account),
        owned: [{
          entitlementFamily: 'formula.family', productId: 'formula', title: 'Archive Formula',
          kind: 'series_formula' as const, grantedAt: '2026-08-14T09:12:44Z', purchaseId: 'cpur_1',
          currentRelease: structuredClone(completeOverview.products[0].currentRelease),
          receiptVerification: 'verified' as const, downloadAvailable: true,
          installState: 'not_installed' as const, installedVersion: null,
        }],
      },
      products: [{ ...structuredClone(completeOverview.products[0]), owned: true }],
    }
    handler = (path, options) => {
      if (path === '/api/content-store/restore') {
        assert.equal(options.method, 'POST')
        return owned
      }
      if (path === '/api/content-store/releases/rel_formula/install') {
        assert.equal(options.method, 'POST')
        const installedOverview = structuredClone(owned)
        installedOverview.account.owned[0]!.installState = 'installed_current'
        installedOverview.account.owned[0]!.installedVersion = '1.0.0'
        return { install: { pack_id: 'pack_formula', version: '1.0.0', activated: true }, overview: installedOverview }
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    assert.equal(calls.length, 0)
    await store.restoreOwnership()
    assert.equal(store.account.value?.owned[0]?.receiptVerification, 'verified')
    assert.equal(calls.length, 1)
    await store.installRelease('rel_formula')
    assert.equal(store.account.value?.owned[0]?.installState, 'installed_current')
    assert.equal(calls.length, 2)
  })

  test('replays an uncertain purchase only after explicit Retry and keeps the same attempt', async () => {
    const quoted = {
      quote_id: 'cq_1', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 1_650, balance_after: 1_250, owned_components: [],
      sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
    }
    let purchaseCalls = 0
    handler = (path) => {
      if (path === '/api/content-store') return { ...structuredClone(completeOverview), attempts: [quoted] }
      if (path.endsWith('/purchase')) {
        purchaseCalls += 1
        if (purchaseCalls === 1) {
          const error: any = new Error('uncertain')
          error.data = {
            code: 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN', status: 'uncertain',
            detail: 'Story Studio did not receive GenStudio\'s answer. No replacement purchase was sent. Retry this exact purchase to replay its saved idempotency key.',
          }
          throw error
        }
        return {
          ...quoted, status: 'completed', ownership: 'owned_not_installed',
          credits_charged: 380, replayed: true, receipt_verification: 'unverified_phase1',
        }
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    await store.refresh()
    await assert.rejects(store.confirmPurchase('cq_1'))
    assert.equal(store.attempts.value[0]?.status, 'uncertain')
    assert.equal(purchaseCalls, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(purchaseCalls, 1, 'an uncertain outcome must never retry automatically')

    const completed = await store.confirmPurchase('cq_1')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.replayed, true)
    assert.equal(purchaseCalls, 2)
  })

  test('shows final purchase balance and reconciles the account strip without another purchase POST', async () => {
    const quoted = {
      quote_id: 'cq_discount', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 1_650, balance_after: 1_250, owned_components: [],
      sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
    }
    const completed = {
      ...quoted, status: 'completed' as const, balance_after: 1_350,
      ownership: 'owned_not_installed' as const, credits_charged: 300,
      replayed: false, receipt_verification: 'unverified_phase1' as const,
    }
    let purchaseCalls = 0
    let overviewCalls = 0
    handler = path => {
      if (path === '/api/content-store') {
        overviewCalls += 1
        if (overviewCalls === 1) return { ...structuredClone(completeOverview), attempts: [quoted] }
        return {
          ...structuredClone(completeOverview),
          account: { ...structuredClone(completeOverview.account), contentSpendableCredits: 1_350 },
          attempts: [completed],
        }
      }
      if (path.endsWith('/purchase')) {
        purchaseCalls += 1
        return completed
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    await store.refresh()
    const result = await store.confirmPurchase('cq_discount')
    assert.equal(result.balance_after, 1_350)
    assert.equal(store.attempts.value[0]?.balance_after, 1_350)
    assert.equal(store.account.value?.contentSpendableCredits, 1_350)
    assert.equal(purchaseCalls, 1)
    assert.equal(overviewCalls, 2)
  })

  test('keeps completed ownership visible when the post-purchase account refresh fails', async () => {
    const quoted = {
      quote_id: 'cq_refresh_failure', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 1_650, balance_after: 1_250, owned_components: [],
      sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
    }
    const completed = {
      ...quoted, status: 'completed' as const, balance_after: 1_350,
      ownership: 'owned_not_installed' as const, credits_charged: 300,
      replayed: false, receipt_verification: 'unverified_phase1' as const,
    }
    let overviewCalls = 0
    handler = path => {
      if (path === '/api/content-store') {
        overviewCalls += 1
        if (overviewCalls === 1) return { ...structuredClone(completeOverview), attempts: [quoted] }
        throw new Error('post-purchase account refresh unavailable')
      }
      if (path.endsWith('/purchase')) return completed
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    await store.refresh()
    const result = await store.confirmPurchase('cq_refresh_failure')
    assert.equal(result.status, 'completed')
    assert.equal(store.attempts.value[0]?.status, 'completed')
    assert.equal(store.error.value, null)
  })

  for (const refusal of [
    { status: 402, code: 'insufficient_credits' },
    { status: 503, code: 'signing_unavailable' },
  ]) {
    test(`retries refused ${refusal.status} ${refusal.code} only after an explicit click`, async () => {
      const quoted = {
        quote_id: `cq_${refusal.status}`, account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
        entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
        base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
        balance_before: 1_650, balance_after: 1_250, owned_components: [],
        sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
      }
      let purchaseCalls = 0
      handler = path => {
        if (path === '/api/content-store') return { ...structuredClone(completeOverview), attempts: [quoted] }
        if (path.endsWith('/purchase')) {
          purchaseCalls += 1
          if (purchaseCalls === 1) {
            const error: any = new Error(refusal.code)
            error.status = refusal.status
            error.data = { code: refusal.code, detail: `${refusal.code} detail`, status: 'refused' }
            throw error
          }
          return {
            ...quoted, status: 'completed', ownership: 'owned_not_installed', credits_charged: 400,
            replayed: false, receipt_verification: 'unverified_phase1',
          }
        }
        throw new Error(`Unexpected request: ${path}`)
      }

      const store = useContentStore()
      await store.refresh()
      await assert.rejects(store.confirmPurchase(quoted.quote_id))
      assert.equal(store.attempts.value[0]?.status, 'refused')
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(purchaseCalls, 1)
      await store.confirmPurchase(quoted.quote_id)
      assert.equal(purchaseCalls, 2)
    })
  }

  test('preserves exact refusal and scope details for the page', async () => {
    handler = () => {
      const error: any = new Error('scope')
      error.status = 401
      error.data = {
        code: 'CONTENT_STORE_SCOPE_REQUIRED',
        detail: 'The active GenStudio key was not accepted for required content:purchase access.',
      }
      throw error
    }
    const store = useContentStore()
    await assert.rejects(store.confirmPurchase('cq_1'))
    assert.equal(store.error.value?.status, 401)
    assert.equal(store.error.value?.code, 'CONTENT_STORE_SCOPE_REQUIRED')
    assert.match(store.error.value?.detail || '', /content:purchase/)
  })

  test('treats a recalled install as terminal, refreshes to the safe owned fallback, and never retries it', async () => {
    const recalledOverview = structuredClone(completeOverview) as any
    recalledOverview.account.owned = [{
      entitlementFamily: 'formula.family', productId: 'formula', title: 'Archive Formula',
      kind: 'series_formula', grantedAt: '2026-08-14T09:12:44Z', purchaseId: 'cpur_1',
      currentRelease: structuredClone(completeOverview.products[0]!.currentRelease),
      recalledReleaseVersions: [], receiptVerification: 'verified', downloadAvailable: true,
      installState: 'not_installed', installedVersion: null, showcaseVideos: [],
    }]
    recalledOverview.products[0].owned = true

    const safeOverview = structuredClone(recalledOverview)
    safeOverview.account.owned[0].recalledReleaseVersions = ['1.0.0']
    safeOverview.account.owned[0].currentRelease = {
      ...safeOverview.account.owned[0].currentRelease,
      releaseId: 'rel_safe', version: '0.9.0',
    }
    safeOverview.products[0].currentRelease = {
      ...safeOverview.products[0].currentRelease,
      releaseId: 'rel_safe', version: '0.9.0',
    }

    let overviewCalls = 0
    let installCalls = 0
    handler = path => {
      if (path === '/api/content-store') {
        overviewCalls += 1
        return overviewCalls === 1 ? recalledOverview : safeOverview
      }
      if (path === '/api/content-store/releases/rel_formula/install') {
        installCalls += 1
        const error: any = new Error('release recalled')
        error.status = 410
        error.data = {
          code: 'release_recalled',
          detail: 'Unsafe bundled reference image detected.',
          recall_reason: 'Unsafe bundled reference image detected.',
          recalled_at: '2026-08-14T10:30:00Z',
          terminal: true,
        }
        throw error
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    await store.refresh()
    await assert.rejects(store.installRelease('rel_formula'))
    assert.equal(installCalls, 1)
    assert.equal(overviewCalls, 2)
    assert.equal(store.account.value?.owned[0]?.currentRelease?.releaseId, 'rel_safe')
    assert.deepEqual(store.account.value?.owned[0]?.recalledReleaseVersions, ['1.0.0'])
    assert.equal(store.error.value?.code, 'release_recalled')
    assert.equal(store.error.value?.terminal, true)
    assert.equal(store.error.value?.recallReason, 'Unsafe bundled reference image detected.')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(installCalls, 1, 'a recalled exact version must never retry automatically')
  })

  test('keeps an initial catalog scope refusal on the Content Store page', async () => {
    handler = () => {
      const error: any = new Error('scope')
      error.status = 401
      error.data = {
        code: 'CONTENT_STORE_SCOPE_REQUIRED',
        detail: 'The active GenStudio key was not accepted for required content:read access.',
      }
      throw error
    }

    const store = useContentStore()
    await assert.rejects(store.refresh())
    assert.equal(store.error.value?.status, 401)
    assert.equal(store.error.value?.code, 'CONTENT_STORE_SCOPE_REQUIRED')
    assert.match(store.error.value?.detail || '', /content:read/)
    assert.deepEqual(store.products.value, [])
  })

  test('keeps the browser on /content-store while the mounted load reports its scope refusal', async () => {
    window.location.href = 'http://127.0.0.1/content-store'
    handler = () => {
      const error: any = new Error('scope')
      error.status = 401
      error.data = {
        code: 'CONTENT_STORE_SCOPE_REQUIRED',
        detail: 'The active GenStudio key was not accepted for required content:read access.',
      }
      throw error
    }

    const store = useContentStore()
    await assert.rejects(store.refresh())
    assert.equal(window.location.pathname, '/content-store')
    assert.equal(store.error.value?.code, 'CONTENT_STORE_SCOPE_REQUIRED')
    assert.match(store.error.value?.detail || '', /content:read/)
  })
})

describe('Content Store stale-while-revalidate', () => {
  test('a cold start with nothing cached loads in the open even when asked to stay quiet', async () => {
    const store = useContentStore()
    const pending = store.refresh({ background: true })
    assert.equal(store.loading.value, true, 'nothing is on screen yet, so the load must be visible')
    await pending
    assert.equal(store.catalogFreshness.value, 'fresh')
    assert.equal(store.products.value[0]?.productId, 'formula')
  })

  test('a revisit inside the TTL keeps the verified catalog on screen and updates it in place', async () => {
    const store = useContentStore()
    await store.refresh()

    let served = 0
    handler = path => {
      if (path !== '/api/content-store') throw new Error(`Unexpected request: ${path}`)
      served += 1
      const next = structuredClone(completeOverview)
      next.products[0]!.title = 'Renamed Formula'
      return next
    }

    const revisit = useContentStore()
    const pending = revisit.refresh({ background: true })
    assert.equal(revisit.loading.value, false, 'a warm catalog revalidates without a loading state')
    assert.equal(revisit.products.value[0]?.title, 'Archive Formula', 'the cached catalog renders immediately')
    await pending

    assert.equal(served, 1, 'the cache is what is displayed, never what is served instead of a fetch')
    assert.equal(revisit.products.value[0]?.title, 'Renamed Formula', 'the revalidation replaces changed data in place')
    assert.equal(revisit.catalogFreshness.value, 'fresh')
    assert.equal(revisit.lastVerifiedAt.value, store.lastVerifiedAt.value, 'one verified-at stamp is shared by every mount')
  })

  test('a cache older than the TTL stops being quiet, because nobody should be told it is current', async () => {
    const store = useContentStore()
    await store.refresh()
    const realNow = Date.now
    Date.now = () => realNow() + CONTENT_STORE_CACHE_TTL_MS + 1_000
    try {
      const pending = store.refresh({ background: true })
      assert.equal(store.loading.value, true, 'an expired cache must show that it is being re-checked')
      await pending
    } finally {
      Date.now = realNow
    }
    assert.equal(store.catalogFreshness.value, 'fresh')
  })

  test('a failed quiet revalidation marks the catalog stale instead of raising an error box', async () => {
    const store = useContentStore()
    await store.refresh()
    goOffline()
    await assert.rejects(store.refresh({ background: true }))

    assert.equal(store.catalogFreshness.value, 'cached', 'stale ownership is never presented as fresh')
    assert.equal(store.error.value, null, 'good data already on screen is not replaced by an alert')
    assert.equal(store.products.value[0]?.productId, 'formula')
    assert.equal(store.account.value?.accountId, 'acct_a')
  })

  test('the explicit refresh always fetches, bypasses the read cache, and reports its own failure', async () => {
    const store = useContentStore()
    await store.refresh()
    const before = calls.length
    goOffline()

    await assert.rejects(store.refresh())
    assert.equal(calls.length, before + 1, 'Refresh Store is a real request, never a cache read')
    assert.equal(calls.at(-1)?.options.cache, 'no-store')
    assert.equal(store.error.value?.code, 'CONTENT_STORE_UNAVAILABLE')
    assert.equal(store.catalogFreshness.value, 'cached')
  })

  test('a quiet revalidation that succeeds clears an error the visible refresh left behind', async () => {
    const store = useContentStore()
    await store.refresh()
    goOffline()
    await assert.rejects(store.refresh())
    assert.equal(store.error.value?.code, 'CONTENT_STORE_UNAVAILABLE')

    handler = path => {
      if (path !== '/api/content-store') throw new Error(`Unexpected request: ${path}`)
      return structuredClone(completeOverview)
    }
    // Freshness is 'cached', so this cannot be quiet — recovering from a
    // failure is exactly the transition a customer should see.
    await store.refresh({ background: true })
    assert.equal(store.error.value, null)
    assert.equal(store.catalogFreshness.value, 'fresh')
  })

  test('purchase, install and restore keep forcing their own verified refetch', async () => {
    const owned = structuredClone(completeOverview)
    owned.products[0]!.owned = true
    const quote = {
      quote_id: 'quote_1', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-12-31T00:00:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400, balance_before: 2_400,
      balance_after: 2_000, owned_components: [], sufficient_credits: true,
      insufficient_reason: null, shortfall_credits: 0,
    }
    handler = (path, options) => {
      if (path === '/api/content-store') return structuredClone(owned)
      if (path === '/api/content-store/quotes') return structuredClone(quote)
      if (path.endsWith('/purchase')) return { ...structuredClone(quote), status: 'completed', credits_charged: 400 }
      if (path === '/api/content-store/restore') return structuredClone(owned)
      if (path.endsWith('/install')) return { install: { pack_id: 'pack_formula', version: '1.0.0', activated: true }, overview: structuredClone(owned) }
      throw new Error(`Unexpected request: ${path} ${JSON.stringify(options)}`)
    }

    const store = useContentStore()
    await store.refresh()
    await store.requestQuote('formula', 'rel_formula')
    await store.confirmPurchase('quote_1')
    const overviewReads = calls.filter(call => call.path === '/api/content-store')
    assert.equal(overviewReads.length, 2, 'a completed purchase re-reads the overview')
    assert.equal(overviewReads.every(call => call.options.cache === 'no-store'), true)

    await store.restoreOwnership()
    await store.installRelease('rel_formula')
    assert.equal(calls.some(call => call.path === '/api/content-store/restore'), true)
    assert.equal(calls.some(call => call.path.endsWith('/install')), true)
    assert.equal(store.catalogFreshness.value, 'fresh')
    assert.equal(store.products.value[0]?.owned, true)
  })

  test('reports a completed purchase before its read-only overview refresh finishes', async () => {
    const owned = structuredClone(completeOverview)
    owned.products[0]!.owned = true
    const quote = {
      quote_id: 'quote_fast_feedback', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-12-31T00:00:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400, balance_before: 2_400,
      balance_after: 2_000, owned_components: [], sufficient_credits: true,
      insufficient_reason: null, shortfall_credits: 0,
    }
    let overviewReads = 0
    let releaseOverview: ((value: typeof owned) => void) | null = null
    handler = path => {
      if (path === '/api/content-store') {
        overviewReads += 1
        if (overviewReads === 1) return structuredClone(completeOverview)
        return new Promise<typeof owned>(resolve => { releaseOverview = resolve })
      }
      if (path === '/api/content-store/quotes') return structuredClone(quote)
      if (path.endsWith('/purchase')) return { ...structuredClone(quote), status: 'completed', credits_charged: 400 }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    await store.refresh()
    await store.requestQuote('formula', 'rel_formula')
    let completed = false
    const purchase = store.confirmPurchase(quote.quote_id).then(() => { completed = true })
    for (let tick = 0; tick < 10 && !releaseOverview; tick += 1) await Promise.resolve()

    assert.ok(releaseOverview, 'the completed purchase starts its verified background refresh')
    assert.equal(completed, true, 'purchase feedback does not wait for the read-only overview')
    releaseOverview!(owned)
    await purchase
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve()
  })
})

describe('the Content Store catalogue that survives a relaunch', () => {
  /** The save is deliberately fire-and-forget, so wait on it rather than on a clock. */
  const settled = () => _contentStoreCatalogPersistedForTests()
  const stored = () => localStorage.getItem(CONTENT_STORE_CATALOG_STORAGE_KEY)

  async function saveCatalogueOnThisMac(overrides: {
    accountId?: string; contentAccountId?: string; origin?: string; capturedAt?: string; title?: string
  } = {}): Promise<void> {
    const overview = structuredClone(completeOverview)
    if (overrides.title) overview.products[0]!.title = overrides.title
    const fingerprint = await contentAccountFingerprint({
      accountId: overrides.accountId ?? overview.account.accountId,
      contentAccountId: overrides.contentAccountId ?? overview.account.contentAccountId,
      origin: overrides.origin ?? overview.origin,
    })
    localStorage.setItem(CONTENT_STORE_CATALOG_STORAGE_KEY, serializePersistedCatalog(persistableCatalog({
      products: overview.products as any, shelves: overview.shelves,
      accountFingerprint: fingerprint!, capturedAt: overrides.capturedAt ?? new Date().toISOString(),
    })))
  }

  test('a launch paints the saved catalogue before anything is fetched, and claims nothing about the account', async () => {
    await saveCatalogueOnThisMac({ title: 'Saved Formula' })
    let fetches = 0
    handler = path => { fetches += 1; if (path === '/api/content-store') return structuredClone(completeOverview); throw new Error(path) }

    const store = useContentStore()
    assert.equal(fetches, 0, 'the catalogue is on screen before a single request is made')
    assert.equal(store.catalogFreshness.value, 'restored')
    assert.equal(store.products.value[0]?.title, 'Saved Formula')
    assert.equal(store.shelves.value[0]?.id, 'cshf_featured')

    assert.equal(store.ownershipResolved.value, false, 'ownership is unresolved, which is not the same fact as not owned')
    assert.equal(store.account.value, null, 'no balance and no content-account id exist until GenStudio answers')
    assert.deepEqual(store.installed.value, [], 'install state is never restored from disk')
    assert.deepEqual(store.attempts.value, [], 'purchases, quotes and receipts are never restored from disk')
    assert.equal(store.lastVerifiedAt.value, null, 'nothing here was verified in this session')
    assert.equal(store.cachedProof.value, null)
  })

  test('the live answer replaces the saved catalogue and resolves ownership', async () => {
    await saveCatalogueOnThisMac({ title: 'Saved Formula' })
    const owned = structuredClone(completeOverview)
    owned.products[0]!.owned = true
    handler = path => { if (path === '/api/content-store') return structuredClone(owned); throw new Error(path) }

    const store = useContentStore()
    assert.equal(store.catalogFreshness.value, 'restored')
    await store.refresh({ background: true })

    assert.equal(store.catalogFreshness.value, 'fresh')
    assert.equal(store.ownershipResolved.value, true)
    assert.equal(store.products.value[0]?.title, 'Archive Formula')
    assert.equal(store.products.value[0]?.owned, true)
    assert.equal(store.account.value?.contentAccountId, 'content_acct_a')
  })

  test('a launch with a saved catalogue loads in the open, because ownership is genuinely still unknown', async () => {
    await saveCatalogueOnThisMac()
    const store = useContentStore()
    const pending = store.refresh({ background: true })
    assert.equal(store.loading.value, true, 'a restored catalogue is never treated as a warm verified one')
    await pending
    assert.equal(store.catalogFreshness.value, 'fresh')
  })

  test('a launch with no network keeps the saved catalogue instead of emptying the Store', async () => {
    await saveCatalogueOnThisMac({ title: 'Saved Formula' })
    goOffline()
    const store = useContentStore()
    await assert.rejects(store.refresh({ background: true }))

    assert.equal(store.catalogFreshness.value, 'restored', 'never "cached", which would promise a catalogue verified this session')
    assert.equal(store.products.value[0]?.title, 'Saved Formula')
    assert.equal(store.ownershipResolved.value, false)
    assert.equal(store.account.value, null)
    assert.equal(store.error.value?.code, 'CONTENT_STORE_UNAVAILABLE', 'the failure is still reported')
    assert.notEqual(stored(), null, 'a failed fetch is not a reason to throw the catalogue away')
  })

  test('a verified overview saves the catalogue, and nothing that belongs to the account', async () => {
    const owned = structuredClone(completeOverview)
    owned.products[0]!.owned = true
    ;(owned.account as any).owned = [{
      entitlementFamily: 'formula.family', productId: 'formula', title: 'Archive Formula',
      kind: 'series_formula', grantedAt: '2026-08-01T00:00:00Z', purchaseId: 'purchase_secret',
      currentRelease: null, showcaseVideos: [], recalledReleaseVersions: [],
      receiptVerification: 'verified', downloadAvailable: true,
      installState: 'installed_current', installedVersion: '1.0.0', missingDependencies: [],
    }]
    handler = path => { if (path === '/api/content-store') return structuredClone(owned); throw new Error(path) }

    await useContentStore().refresh()
    await settled()

    const written = stored()
    assert.ok(written, 'the published catalogue is saved for the next launch')
    assert.match(written, /"Archive Formula"/)
    assert.doesNotMatch(written, /"owned"/)
    assert.doesNotMatch(written, /purchase_secret|content_acct_a|acct_a/)
    assert.doesNotMatch(written, /installState|installed_current|availableCredits|contentSpendableCredits|receiptVerification/)
    assert.doesNotMatch(written, /2400|1650/, 'no balance figure reaches disk')
  })

  test('a catalogue written under another account is deleted the moment GenStudio names a different one', async () => {
    await saveCatalogueOnThisMac({ accountId: 'acct_other', contentAccountId: 'content_other', title: 'Account B Formula' })
    assert.match(stored()!, /Account B Formula/)

    const store = useContentStore()
    assert.equal(store.products.value[0]?.title, 'Account B Formula')
    await store.refresh()
    await settled()

    assert.doesNotMatch(stored()!, /Account B Formula/, 'the other account’s catalogue is gone, not merged with')
    assert.equal(store.products.value[0]?.title, 'Archive Formula')
    assert.equal(store.account.value?.accountId, 'acct_a')
  })

  test('a catalogue saved at another origin is discarded the same way', async () => {
    await saveCatalogueOnThisMac({ origin: 'https://other.example.test', title: 'Other Origin Formula' })
    const store = useContentStore()
    await store.refresh()
    await settled()
    assert.doesNotMatch(stored()!, /Other Origin Formula/)
  })

  test('an overview with no origin is not a verified catalogue and is never saved', async () => {
    handler = path => {
      if (path !== '/api/content-store') throw new Error(path)
      return { ...structuredClone(completeOverview), origin: '' }
    }
    await useContentStore().refresh()
    await settled()
    assert.equal(stored(), null)
  })

  test('a saved catalogue past its age bound is ignored and the Store cold-loads as before', async () => {
    await saveCatalogueOnThisMac({
      capturedAt: new Date(Date.now() - CONTENT_STORE_CATALOG_MAX_AGE_MS - 60_000).toISOString(),
    })
    const store = useContentStore()
    assert.equal(store.catalogFreshness.value, 'unavailable')
    assert.deepEqual(store.products.value, [])
  })
})

describe('Content Store renderer contract', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/content-store.vue', import.meta.url)), 'utf8')
  const card = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductCard.vue', import.meta.url)), 'utf8')
  const installedView = readFileSync(fileURLToPath(new URL('../components/content-store/ContentInstalledLibraryView.vue', import.meta.url)), 'utf8')
  const shelf = readFileSync(fileURLToPath(new URL('../components/content-store/ContentStoreShelf.vue', import.meta.url)), 'utf8')
  const dialog = readFileSync(fileURLToPath(new URL('../components/content-store/ContentPurchaseDialog.vue', import.meta.url)), 'utf8')
  const home = readFileSync(fileURLToPath(new URL('../pages/index.vue', import.meta.url)), 'utf8')
  const dashboard = readFileSync(fileURLToPath(new URL('../layouts/dashboard.vue', import.meta.url)), 'utf8')

  const libraryView = readFileSync(fileURLToPath(new URL('../components/content-store/ContentLibraryView.vue', import.meta.url)), 'utf8')
  const detail = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductDetail.vue', import.meta.url)), 'utf8')

  test('an unresolved account renders as unresolved, never as a negative fact', () => {
    // Every surface that would otherwise state ownership, install state or a
    // balance has to say it is still checking while `ownershipResolved` is
    // false. Nothing here may say "not owned", "0 packs" or "no installed
    // packs" on evidence nobody has yet.
    assert.match(card, /v-if="!ownershipResolved" class="ownership-status">Checking with GenStudio/)
    assert.match(card, /if \(!props\.ownershipResolved\) return 'Checking…'/)
    assert.match(card, /v-if="ownershipResolved && !product\.owned && !product\.retired/, 'no purchase action against unverified ownership')
    assert.match(card, /:data-owned="ownershipResolved \? product\.owned : undefined"/)

    for (const source of [libraryView, installedView]) {
      assert.match(source, /v-if="!ownershipResolved"[^>]*role="status"/)
      assert.match(source, /Not checked yet/)
    }
    assert.match(libraryView, /ownershipResolved \? `\$\{products\.length\}/, 'a pack count is only shown once it has been counted')
    assert.match(detail, /v-if="!ownershipResolved" class="detail-pending"/)
    assert.match(detail, /v-if="ownershipResolved && !product\.owned/)

    assert.match(page, /catalogFreshness === 'restored'/)
    assert.match(page, /Showing the published catalogue saved on this Mac/)
    assert.match(page, /function tabCountLabel\(tab: StoreTab\): string \{ return !ownershipResolved\.value && tab !== 'discover' \? '—'/)
    assert.match(page, /:ownership-resolved="ownershipResolved"/)
    assert.match(page, /const networkActionsDisabled = computed\(\(\) => catalogFreshness\.value !== 'fresh'\)/,
      'restored reuses the existing disabled-actions machinery rather than a second flag')
  })

  test('separates Discover, Owned, Installed, and Updates with truthful counts and empty states', () => {
    assert.match(page, /role="tablist"/)
    assert.match(page, /label: 'Discover'/)
    assert.match(page, /label: 'Owned'/)
    assert.match(page, /label: 'Installed'/)
    assert.match(page, /label: 'Updates'/)
    assert.match(page, /ContentInstalledLibraryView/)
    assert.match(page, /products\.length === 0 && installed\.length === 0/)
    assert.match(page, /updateProducts/)
    assert.match(installedView, /No installed packs yet/)
    assert.match(page, /No updates available/)
    assert.match(page, /The Content Store is ready, but no packs have been published yet\./)
    assert.doesNotMatch(page + card, /starter entries|preview gallery|license terms|portal URL/i)
    assert.match(page, /Restore Purchases/)
    assert.match(card, /Install on this Mac/)
    assert.match(card, /ContentProductCover/)
    assert.match(card, /View proof/)
    assert.doesNotMatch(card, /iframe|v-html/)
  })

  test('describes account ownership and local install truth separately', () => {
    assert.match(page, /permanently owned by your GenStudio account/)
    assert.match(card, /receiptVerification !== 'verified'/)
    assert.match(card, /restore purchases to verify on this Mac/i)
    assert.match(card, /Verified ownership · installed on this Mac/)
    assert.match(card, /ready to install on this Mac/)
    assert.match(page, /hasVerifiedOwnership/)
  })

  test('labels recalled ownership without claiming entitlement loss or offering an exact-version retry', () => {
    assert.match(card, /recalledReleaseVersions/)
    assert.match(card, /Ownership remains permanent/i)
    assert.match(card, /newest safe owned release/i)
    assert.match(page, /A Content Pack release was recalled/i)
    assert.match(page, /GenStudio stopped serving that exact version/i)
    assert.doesNotMatch(page + card, /ownership (?:was|is) revoked|entitlement (?:was|is) lost/i)
    assert.doesNotMatch(page + card, /retry recalled/i)
  })

  test('presents total and content-spendable balances as distinct account facts', () => {
    assert.match(page, /contentSpendableCredits/)
    assert.match(page, /availableCredits/)
    assert.match(page, /Spendable on content/)
    assert.match(page, /Total available/)
  })

  test('covers every product kind and blocks incompatible checkout', () => {
    assert.match(card, /compatibilityReason/)
    assert.match(card, /See Exact Quote/)
    assert.match(card, /Get Free/)
    assert.doesNotMatch(card, /@click="[^\"]*purchase/i)
  })

  test('shows exact quote ceiling, discount, balances, expiry, and safe insufficient-credit action', () => {
    assert.match(dialog, /Yours to keep on this account/)
    assert.match(dialog, /Base price/)
    assert.match(dialog, /Discount for content you already own/)
    assert.match(dialog, /The most it can cost/)
    assert.match(dialog, /Credits you can spend/)
    assert.match(dialog, /After purchase/)
    assert.match(dialog, /final charge may be lower/i)
    assert.match(dialog, /shortfall_credits|shortfallCredits/)
    assert.match(dialog, /to="\/usage"/)
    assert.match(dialog, /View credits/)
  })

  test('uses shared Modal with a non-spending initial focus target and truthful purchase outcomes', () => {
    assert.match(dialog, /<Modal/)
    assert.match(dialog, /ref="cancelButton"/)
    assert.match(dialog, /cancelButton\.value\?\.focus/)
    assert.match(dialog, /Bought — not installed on this Mac yet/)
    assert.match(page, /Ownership receipts are verified locally/)
    assert.match(dialog, /never charged twice/)
    assert.match(dialog, /Retry This Purchase/)
    assert.match(dialog, /store is not open yet/i)
    assert.match(dialog, /credits_charged|creditsCharged/)
    assert.match(dialog, /props\.attempt\?\.status !== 'refused'/)
    assert.match(dialog, /quote_expired.*quote_rejected.*already_owned/)
    assert.doesNotMatch(dialog, /No purchase was sent/)
    assert.match(dialog, /Nothing was charged and nothing changed/)
  })

  test('keeps the quote trigger focusable while its request is in flight so Modal can restore focus', () => {
    assert.match(card, /:aria-busy="busy \? 'true' : undefined"/)
    assert.doesNotMatch(card, /:disabled="busy"/)
  })

  test('adds global and project navigation without disturbing the existing mobile trap', () => {
    assert.match(home, /to="\/content-store"[^>]*>Content Store</)
    assert.match(dashboard, /to="\/content-store"[^>]*>Content Store</)
    assert.match(dashboard, /closeMobileNav/)
    assert.match(dashboard, /focusableSidebarItems/)
  })

  test('mounts the Content Store page directly and loads errors in place', () => {
    assert.match(page, /useAppTitle\('Content Store'\)/)
    assert.match(page, /onMounted\(\(\) => \{ void loadStore\(\{ background: true \}\) \}\)/)
    assert.match(page, /function refreshStore\(\): void \{ void loadStore\(\) \}/)
    assert.match(page, /@click="refreshStore"/)
    assert.match(page, /v-if="pageError"/)
    assert.doesNotMatch(page, /navigateTo\(['"]\/login['"]\)/)
  })

  test('renders shelves in server order and routes cards to proof', () => {
    assert.match(page, /v-for="shelf in visibleShelves"/)
    assert.match(card, /:to="`\/content-store\/\$\{product\.productId\}`"/)
    assert.doesNotMatch(card, /included components<\/strong>/i)
  })

  test('passes current catalog tags into live filters', () => {
    assert.match(page, /catalogPresentation/)
    assert.match(page, /catalogPresentation\.value/)
  })
})
