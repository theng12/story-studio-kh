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
    owned: [],
  },
  products: [
    {
      productId: 'formula', entitlementFamily: 'formula.family', kind: 'series_formula' as const,
      title: 'Archive Formula', summary: 'A repeatable documentary structure.',
      description: 'Long-form production guidance.', publisherId: 'Story Studio',
      free: false, owned: false, retired: false,
      successorProductId: null, compatible: true, compatibilityReason: null,
      currentRelease: {
        releaseId: 'rel_formula', packId: 'pack_formula', version: '1.0.0',
        archiveSha256: 'a'.repeat(64), archiveBytes: 4_096,
        archiveAvailable: true,
        minStoryVersion: '1.0.834', changelog: 'First release.', componentSummary: {},
      },
      bundleComponents: [],
      presentation: {
        cover: { src: 'https://catalog.example.test/covers/archive-formula.webp', alt: 'Archive Formula cover' },
        licenseLabel: 'Story Studio Content Pack License',
        tags: ['documentary', 'archive'],
      },
    },
  ],
  shelves: [{ id: 'cshf_featured', title: 'Featured', productIds: ['formula'] }],
  installed: [],
  capabilities: {
    purchase: false, receipt_verification: true, download: true,
    install_after_purchase: false, restore: true,
  },
  sections: {
    account: { status: 'available' as const }, catalog: { status: 'available' as const },
    shelves: { status: 'available' as const }, receipts: { status: 'available' as const },
    commerce: { status: 'available' as const },
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
    ['CONTENT_STORE_KEY_REQUIRED', 'Studio Library access is needed'],
    ['CONTENT_STORE_SCOPE_REQUIRED', 'Studio Library access is needed'],
    ['CONTENT_PRODUCT_NOT_AVAILABLE', 'This product is not available'],
    ['CONTENT_PRODUCT_ALREADY_OWNED', 'This is already available to this Mac'],
    ['CONTENT_PRODUCT_RETIRED', 'This product is retired'],
    ['CONTENT_PRODUCT_INCOMPATIBLE', 'A newer Story Studio version is needed'],
    ['CONTENT_RELEASE_NOT_AVAILABLE', 'This release is not available'],
    ['CONTENT_STORE_QUOTE_NOT_FOUND', 'This quote is no longer available'],
    ['CONTENT_PURCHASE_NOT_SENT', 'This request was not sent'],
    ['CONTENT_PACK_TOO_LARGE_FOR_THIS_APP', 'This archive is too large to install safely'],
    ['CONTENT_PACK_REQUIRES_NEWER_APP', 'A newer Story Studio version is needed'],
    ['incompatible_story_version', 'A newer Story Studio version is needed'],
    ['insufficient_credits', 'Not enough balance for this request'],
    ['quote_expired', 'This quote can no longer be used'],
    ['quote_rejected', 'This quote can no longer be used'],
    ['CONTENT_PURCHASE_OUTCOME_UNCERTAIN', 'GenStudio’s answer is uncertain'],
    ['signing_unavailable', 'The Studio Library is not open yet'],
    ['CONTENT_STORE_ACCOUNT_MISMATCH', 'This Mac could not confirm availability'],
    ['CONTENT_PURCHASE_ACCOUNT_MISMATCH', 'This Mac could not confirm availability'],
    ['CONTENT_PACK_NOT_OWNED', 'This Mac could not confirm availability'],
    ['CONTENT_STORE_SIGNING_KEY_MISSING', 'Studio Library access is needed'],
    ['CONTENT_PACK_OWNED_RELEASE_MISMATCH', 'This Mac could not confirm availability'],
    ['CONTENT_PACK_ARCHIVE_UNAVAILABLE', 'This archive is not available'],
    ['CONTENT_PACK_DOWNLOAD_WITHDRAWN', 'This Content Pack can no longer be downloaded'],
    ['CONTENT_PACK_DEPENDENCY_NOT_OWNED', 'This Content Pack cannot be installed'],
    ['CONTENT_PACK_NESTED_CLOSURE_UNSUPPORTED', 'This Content Pack cannot be installed'],
    ['CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH', 'GenStudio has not attested to the versions this pack requires'],
    ['CONTENT_PACK_RECEIPT_MISSING', 'This Content Pack could not be verified'],
    ['CONTENT_PACK_REMOTE_IDENTITY_MISMATCH', 'This Content Pack could not be verified'],
    ['CONTENT_STORE_REQUEST_INVALID', 'This Studio Library request is invalid'],
    ['CONTENT_STORE_REQUEST_TOO_LARGE', 'This Studio Library request is invalid'],
    ['CONTENT_STORE_UPSTREAM_REFUSED', 'GenStudio could not complete this request'],
    // An unclassified failure was NOT a refusal, and must not read as one.
    ['CONTENT_STORE_INSTALL_FAILED', 'This Content Pack could not be installed'],
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
    assert.notEqual(presentation.title, 'The Studio Library is unavailable')
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
    assert.equal(presentation.title, 'The Studio Library is unavailable')
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

  test('retains server-normalized catalogue facts without deriving a shelf', async () => {
    const store = useContentStore()
    await store.refresh()

    assert.deepEqual(store.shelves.value, completeOverview.shelves)
    assert.deepEqual(store.products.value[0]?.presentation, completeOverview.products[0]?.presentation)
    assert.equal(store.products.value[0]?.title, 'Archive Formula')
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
    installed.account.contentAccountId = 'content_acct_after_install'
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
    assert.equal(store.account.value?.contentAccountId, 'content_acct_after_install',
      'the newer install overview is the one left on screen')
  })

  test('installs only after an explicit customer action, and never on its own', async () => {
    const available = {
      ...structuredClone(completeOverview),
      account: {
        ...structuredClone(completeOverview.account),
        owned: [{
          entitlementFamily: 'formula.family', productId: 'formula', title: 'Archive Formula',
          kind: 'series_formula' as const,
          currentRelease: structuredClone(completeOverview.products[0].currentRelease),
          showcaseVideos: [], recalledReleaseVersions: [], downloadAvailable: true,
          installState: 'not_installed' as const, installedVersion: null, missingDependencies: [],
        }],
      },
      products: [{ ...structuredClone(completeOverview.products[0]), owned: true }],
    }
    handler = (path, options) => {
      if (path === '/api/content-store') return available
      if (path === '/api/content-store/releases/rel_formula/install') {
        assert.equal(options.method, 'POST')
        const installedOverview = structuredClone(available)
        installedOverview.account.owned[0]!.installState = 'installed_current'
        installedOverview.account.owned[0]!.installedVersion = '1.0.0'
        return { install: { pack_id: 'pack_formula', version: '1.0.0', activated: true }, overview: installedOverview }
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    assert.equal(calls.length, 0, 'opening the Library installs nothing')
    await store.refresh()
    assert.equal(calls.length, 1)
    assert.equal(store.account.value?.owned[0]?.installState, 'not_installed')
    await store.installRelease('rel_formula')
    assert.equal(store.account.value?.owned[0]?.installState, 'installed_current')
    assert.equal(calls.length, 2)
  })

  test('treats a recalled install as terminal, refreshes to the safe owned fallback, and never retries it', async () => {
    const recalledOverview = structuredClone(completeOverview) as any
    recalledOverview.account.owned = [{
      entitlementFamily: 'formula.family', productId: 'formula', title: 'Archive Formula',
      kind: 'series_formula',
      currentRelease: structuredClone(completeOverview.products[0]!.currentRelease),
      recalledReleaseVersions: [], downloadAvailable: true,
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

  test('keeps an initial catalog scope refusal on the Studio Library page', async () => {
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

describe('Studio Library stale-while-revalidate', () => {
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

  test('install keeps forcing its own verified refetch', async () => {
    const available = structuredClone(completeOverview)
    available.products[0]!.owned = true
    handler = (path, options) => {
      if (path === '/api/content-store') return structuredClone(available)
      if (path.endsWith('/install')) return { install: { pack_id: 'pack_formula', version: '1.0.0', activated: true }, overview: structuredClone(available) }
      throw new Error(`Unexpected request: ${path} ${JSON.stringify(options)}`)
    }

    const store = useContentStore()
    await store.refresh()
    const overviewReads = calls.filter(call => call.path === '/api/content-store')
    assert.equal(overviewReads.length, 1)
    assert.equal(overviewReads.every(call => call.options.cache === 'no-store'), true)

    await store.installRelease('rel_formula')
    assert.equal(calls.some(call => call.path.endsWith('/install')), true)
    assert.equal(calls.some(call => call.path === '/api/content-store/restore'), false,
      'the shop restore route is no longer in the install path')
    assert.equal(store.catalogFreshness.value, 'fresh')
    assert.equal(store.products.value[0]?.owned, true)
  })
})

describe('the Studio Library catalogue that survives a relaunch', () => {
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
      kind: 'series_formula',
      currentRelease: null, showcaseVideos: [], recalledReleaseVersions: [],
      downloadAvailable: true,
      installState: 'installed_current', installedVersion: '1.0.0', missingDependencies: [],
    }]
    handler = path => { if (path === '/api/content-store') return structuredClone(owned); throw new Error(path) }

    await useContentStore().refresh()
    await settled()

    const written = stored()
    assert.ok(written, 'the published catalogue is saved for the next launch')
    assert.match(written, /"Archive Formula"/)
    assert.doesNotMatch(written, /"owned"/)
    assert.doesNotMatch(written, /content_acct_a|acct_a/)
    assert.doesNotMatch(written, /installState|installed_current/)
    assert.doesNotMatch(written, /creditPrice|discount|listCreditPrice/, 'no price or discount reaches disk')
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

describe('Studio Library renderer contract', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/library.vue', import.meta.url)), 'utf8')
  const card = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductCard.vue', import.meta.url)), 'utf8')
  const installedView = readFileSync(fileURLToPath(new URL('../components/content-store/ContentInstalledLibraryView.vue', import.meta.url)), 'utf8')
  const shelf = readFileSync(fileURLToPath(new URL('../components/content-store/ContentStoreShelf.vue', import.meta.url)), 'utf8')
  const home = readFileSync(fileURLToPath(new URL('../pages/index.vue', import.meta.url)), 'utf8')
  const dashboard = readFileSync(fileURLToPath(new URL('../layouts/dashboard.vue', import.meta.url)), 'utf8')
  const appHeader = readFileSync(fileURLToPath(new URL('../components/AppHeader.vue', import.meta.url)), 'utf8')

  const libraryView = readFileSync(fileURLToPath(new URL('../components/content-store/ContentLibraryView.vue', import.meta.url)), 'utf8')
  const detail = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductDetail.vue', import.meta.url)), 'utf8')

  test('an unresolved account renders as unresolved, never as a negative fact', () => {
    // Every surface that would otherwise state ownership, install state or a
    // balance has to say it is still checking while `ownershipResolved` is
    // false. Nothing here may say "not owned", "0 packs" or "no installed
    // packs" on evidence nobody has yet.
    assert.match(card, /v-if="!ownershipResolved" class="ownership-status">Checking with the Gateway/)
    assert.match(card, /if \(!props\.ownershipResolved\) return 'Checking…'/)
    assert.doesNotMatch(card, /See Exact Quote|Get Free|Requesting Quote/, 'the library has no purchase action at all')
    assert.match(card, /:data-owned="ownershipResolved \? product\.owned : undefined"/)

    for (const source of [libraryView, installedView]) {
      assert.match(source, /Not checked yet/)
    }
    assert.match(libraryView, /v-if="!ownershipResolved"[^>]*role="status"/,
      'a catalog list that needs the account says it is still checking')
    // The Installed list is read from this Mac, so it is answered by the same
    // response that names an account it could not reach — gating it on
    // ownership would turn a known local fact into "not checked yet".
    assert.match(installedView, /v-if="!installsResolved"[^>]*role="status"/)
    assert.doesNotMatch(installedView, /v-if="!ownershipResolved"/)
    assert.match(libraryView, /ownershipResolved \? `\$\{products\.length\}/, 'a pack count is only shown once it has been counted')
    assert.match(detail, /v-if="!ownershipResolved" class="detail-pending"/)
    assert.doesNotMatch(detail, /See Exact Quote|Get Free|Requesting Quote/)

    assert.match(page, /catalogFreshness === 'restored'/)
    assert.match(page, /Showing the published catalogue saved on this Mac/)
    assert.match(page, /function tabCountLabel\(tab: StoreTab\): string \{/)
    assert.match(page, /return !ownershipResolved\.value && tab !== 'discover' \? '—' : String\(tabProductCount\(tab\)\)/)
    assert.match(page, /:ownership-resolved="ownershipResolved"/)
    assert.match(page, /const networkActionsDisabled = computed\(\(\) => catalogFreshness\.value !== 'fresh' \|\| !accountResolved\.value\)/,
      'restored reuses the existing disabled-actions machinery rather than a second flag; a catalogue without an account is not actionable either')
  })

  test('separates Discover, Installed and Updates with truthful counts and empty states', () => {
    assert.match(page, /role="tablist"/)
    assert.match(page, /label: 'Discover'/)
    assert.match(page, /label: 'Installed'/)
    assert.match(page, /label: 'Updates'/)
    // The Owner tab went with the shop: one list of what the Gateway publishes.
    assert.doesNotMatch(page, /label: 'Owned'/)
    assert.doesNotMatch(page, /activeTab === 'owned'|store-tab-owned/)
    assert.match(page, /ContentInstalledLibraryView/)
    assert.match(page, /products\.length === 0 && installed\.length === 0/)
    assert.match(page, /updateProducts/)
    assert.match(installedView, /No installed packs yet/)
    assert.match(page, /No updates available/)
    assert.match(page, /The Studio Library is ready, but no packs have been published yet\./)
    assert.doesNotMatch(page + card, /starter entries|preview gallery|license terms|portal URL/i)
    // The retired shop's affordances must not come back, and neither may its
    // ownership machinery: there is nothing to re-check and nothing to own.
    assert.doesNotMatch(page, /Restore Purchases/i)
    assert.doesNotMatch(page, /Re-check my packs|re-check my packs/i)
    assert.doesNotMatch(page, /<(?:button|a)\b[^>]*>[^<]*purchase/i, 'no control offers a purchase')
    assert.doesNotMatch(page, /\bbuy\b|checkout|purchase now/i, 'no checkout wording')
    assert.match(card, /Install on this Mac/)
    assert.match(card, /ContentProductCover/)
    assert.match(card, /View proof/)
    assert.doesNotMatch(card, /iframe|v-html/)
  })

  test('describes availability and local install truth without ownership wording', () => {
    assert.match(page, /Visual styles, Series Formulas, topic packs and thumbnail recipes in one place/)
    assert.match(page, /Browse what your Gateway publishes and install it on this Mac/)
    assert.doesNotMatch(page, /Packs are permanently owned by your Gateway/i,
      'the header must not turn Gateway possession into the whole install story')
    assert.match(card, /Installed on this Mac\./)
    assert.match(card, /Ready to install on this Mac\./)
    assert.match(card, /Not available to this Mac\./)
    // An entitlement is an install grant, so it is never described as owning.
    assert.doesNotMatch(card, /Verified ownership|Owned in GenStudio|ownership remains permanent/i)
    assert.doesNotMatch(card, /receiptVerification/)
  })

  test('keeps a recall notice as a plain safety warning and never offers an exact-version retry', () => {
    assert.match(card, /recalledReleaseVersions/)
    assert.match(card, /The Gateway stopped serving those versions\./)
    assert.match(card, /The newest release it still serves is/)
    assert.match(page, /A Content Pack release was recalled/i)
    assert.match(page, /The Gateway stopped serving that exact version/i)
    assert.doesNotMatch(page + card, /ownership (?:was|is) revoked|entitlement (?:was|is) lost/i)
    assert.doesNotMatch(page + card, /retry recalled/i)
    assert.doesNotMatch(card, /Ownership remains permanent/i, 'a recall is a safety notice, not an ownership statement')
  })

  test('shows no balance, price, ownership or purchase wording on the page, cards or detail view', () => {
    // A comment may explain the policy without showing it, and `product.owned`,
    // `data-owned` and the `receipts` section key are data names: this forbids
    // what a person reads, so comments are stripped and identifiers skipped.
    const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    for (const source of [page, card, detail, libraryView, installedView]) {
      assert.doesNotMatch(source, /contentSpendableCredits|availableCredits|Spendable on content|Total available/)
      assert.doesNotMatch(source, /creditPrice|quoted_credits|\bcredits\b/i)
      assert.doesNotMatch(withoutComments(source),
        /(?<![.\w'"\-\[])\bOwned\b|Not owned|permanently owned|Ownership remains|Purchase records|checkout|\breceipt\b/i)
    }
  })

  test('states compatibility and a plain availability fact instead of a checkout', () => {
    assert.match(card, /compatibilityReason/)
    assert.match(card, /Not available to this Mac\./)
    assert.match(card, /if \(!props\.product\.owned\) return 'Not available'/)
    assert.doesNotMatch(card, /@click="[^\"]*(purchase|quote)/i)
  })

  test('adds global and project navigation without disturbing the existing mobile trap', () => {
    // v1.4.371 — the link lives in the one shared header for non-channel pages,
    // and in the channel sidebar as an ordinary row.
    assert.match(appHeader, /to="\/library"[\s\S]{0,60}Studio Library/)
    assert.doesNotMatch(home, /home-actions/, 'All Channels has no header of its own')
    assert.match(dashboard, /to="\/library"[\s\S]{0,80}Studio Library/)
    assert.match(dashboard, /closeMobileNav/)
    assert.match(dashboard, /focusableSidebarItems/)
  })

  test('mounts the Studio Library page directly and loads errors in place', () => {
    assert.match(page, /useAppTitle\('Studio Library'\)/)
    assert.match(page, /void loadStore\(\{ background: true \}\)\n  void loadGatewayArchives\(\)/)
    assert.match(page, /void store\.refreshRemovals\(\)/)
    assert.match(page, /function refreshStore\(\): void \{ void loadStore\(\) \}/)
    assert.match(page, /@click="refreshStore"/)
    assert.match(page, /v-if="pageError"/)
    assert.doesNotMatch(page, /navigateTo\(['"]\/login['"]\)/)
  })

  test('offers Remove from this Mac and Restore from Trash, and never a delete', () => {
    assert.match(installedView, /Remove from this Mac/)
    assert.match(installedView, /Put it back/)
    assert.match(installedView, /Story Studio never deletes a pack/)
    assert.match(installedView, /Used by \$\{channels\.length\}/)
    assert.doesNotMatch(page + installedView, /Delete permanently|permanently delete/i)
    // Removing is a local action: it is not hidden behind the Gateway's answer.
    assert.match(page, /await store\.removePack\(packId\)/)
  })

  test('renders shelves in server order and routes cards to proof', () => {
    assert.match(page, /v-for="shelf in visibleShelves"/)
    assert.match(card, /:to="`\/library\/\$\{product\.productId\}`"/)
    assert.doesNotMatch(card, /included components<\/strong>/i)
  })

  test('passes current catalog tags into live filters', () => {
    assert.match(page, /catalogPresentation/)
    assert.match(page, /catalogPresentation\.value/)
  })
})
