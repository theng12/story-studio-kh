/**
 * The 2026-10-28 report from the installed mini: `GET /api/content-store`
 * answered a generic 500 while the Gateway archive bank answered normally. The
 * backend now answers with what it can and names every part it could not ask
 * (see `content-store-routes.test.ts`). This file pins the RENDERER half:
 *
 *   - "could not ask" is never rendered as "you own nothing" (AGENTS.md 6);
 *   - a partial answer never erases a catalogue this session already verified;
 *   - the packs installed on this Mac are still answered when the Gateway
 *     cannot be asked at all;
 *   - a partial answer is never marked fresh, so no Gateway action is offered
 *     on the strength of it.
 */
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

const baseAccount = {
  accountId: 'acct_a', contentAccountId: 'content_acct_a', owned: [],
}

const baseProduct = {
  productId: 'formula', entitlementFamily: 'formula.family', kind: 'series_formula' as const,
  title: 'Archive Formula', summary: '', description: '', publisherId: 'Story Studio',
  free: false, owned: false, retired: false, successorProductId: null,
  compatible: true, compatibilityReason: null, currentRelease: null, bundleComponents: [],
  presentation: {},
}

const installedPack = {
  packId: 'com.storystudio.pack.local', version: '1.0.0', active: true,
  installState: 'installed_current' as const, missingDependencies: [],
  productId: 'formula', title: 'Archive Formula', kind: 'series_formula' as const,
}

const available = { status: 'available' as const }
const unavailable = (code: string, reason: string) => ({ status: 'unavailable' as const, code, reason })

function completeOverview() {
  return {
    phase: 'delivery_ready',
    origin: 'https://catalog.example.test',
    account: baseAccount,
    installed: [installedPack],
    products: [baseProduct],
    shelves: [{ id: 'cshf_featured', title: 'Featured', productIds: ['formula'] }],
    attempts: [],
    capabilities: {
      purchase: false, receipt_verification: true, download: true,
      install_after_purchase: false, restore: true,
    },
    sections: { account: available, catalog: available, shelves: available, receipts: available, commerce: available },
  }
}

let handler: () => unknown

;(globalThis as any).$fetch = async () => handler()

const { useContentStore, _clearContentStoreSessionCacheForTests } =
  await import('../composables/useContentStore.js')

beforeEach(() => {
  _clearContentStoreSessionCacheForTests()
  handler = () => structuredClone(completeOverview())
})

describe('a partial Studio Library overview', () => {
  test('a complete answer marks ownership resolved and stays fresh', async () => {
    const store = useContentStore()
    await store.refresh()
    assert.equal(store.catalogFreshness.value, 'fresh')
    assert.equal(store.ownershipResolved.value, true)
    assert.equal(store.accountResolved.value, true)
    assert.equal(store.installsResolved.value, true)
    assert.equal(store.error.value, null)
    assert.deepEqual(store.unavailableSections.value, [])
  })

  test('"the Gateway could not be asked" is not "you own nothing"', async () => {
    handler = () => ({
      ...completeOverview(),
      phase: 'partial',
      account: null,
      products: [],
      shelves: [],
      sections: {
        account: unavailable('GATEWAY_UNREACHABLE', 'Could not reach the Gateway — is the Gateway app running?'),
        catalog: unavailable('GATEWAY_UNREACHABLE', 'Could not reach the Gateway — is the Gateway app running?'),
        shelves: unavailable('GATEWAY_UNREACHABLE', 'Could not reach the Gateway — is the Gateway app running?'),
        receipts: unavailable('GATEWAY_UNREACHABLE', 'Could not reach the Gateway — is the Gateway app running?'),
        removals: unavailable('GATEWAY_UNREACHABLE', 'Could not reach the Gateway — is the Gateway app running?'),
        commerce: unavailable('GATEWAY_UNREACHABLE', 'Could not reach the Gateway — is the Gateway app running?'),
      },
    })
    const store = useContentStore()
    await store.refresh()

    assert.equal(store.account.value, null, 'a refused question never becomes an empty ownership list')
    assert.equal(store.accountResolved.value, false)
    // Every surface that would show ownership, install state or a balance must
    // say "still checking" rather than a zero.
    assert.equal(store.ownershipResolved.value, false)
    assert.equal(store.catalogFreshness.value, 'unavailable')
    // The Gateway is named, not a generic message.
    assert.equal(store.error.value?.code, 'GATEWAY_UNREACHABLE')
    assert.match(store.error.value?.detail ?? '', /Could not reach the Gateway/)
    // The name of every part that could not be asked is available to the page.
    // `commerce` is not reported: nothing on a download page reads the old
    // purchase journal, so its failure is not this page's problem.
    assert.deepEqual(store.unavailableSections.value.map(section => section.section), [
      'account', 'catalog', 'shelves', 'receipts', 'removals',
    ])
  })

  test('the packs installed on this Mac still answer when the Gateway cannot be asked', async () => {
    handler = () => ({
      ...completeOverview(),
      phase: 'partial',
      account: null,
      products: [],
      shelves: [],
      installed: [installedPack],
      sections: {
        account: unavailable('CONTENT_STORE_KEY_REQUIRED', 'Save your Gateway API Key in Settings → This Mac.'),
        catalog: unavailable('CONTENT_STORE_KEY_REQUIRED', 'Save your Gateway API Key in Settings → This Mac.'),
        shelves: available,
        receipts: available,
        commerce: unavailable('CONTENT_STORE_KEY_REQUIRED', 'Save your Gateway API Key in Settings → This Mac.'),
      },
    })
    const store = useContentStore()
    await store.refresh()

    assert.equal(store.installed.value.length, 1, 'the local answer is a real answer')
    assert.equal(store.installsResolved.value, true, 'the Installed tab is not "not checked yet"')
    assert.equal(store.ownershipResolved.value, false)
    assert.equal(store.error.value?.code, 'CONTENT_STORE_KEY_REQUIRED')
  })

  test('a partial answer never erases the catalogue this session already verified', async () => {
    const store = useContentStore()
    await store.refresh()
    assert.equal(store.products.value.length, 1)

    handler = () => ({
      ...completeOverview(),
      phase: 'partial',
      account: null,
      products: [],
      shelves: [],
      installed: [],
      sections: {
        ...completeOverview().sections,
        account: unavailable('CONTENT_STORE_NOT_SERVED', 'This Gateway does not serve the Studio Library.'),
        catalog: unavailable('CONTENT_STORE_NOT_SERVED', 'This Gateway does not serve the Studio Library.'),
      },
    })
    await store.refresh()

    assert.equal(store.products.value.length, 1, 'a good catalogue on screen is not replaced by an empty one')
    assert.equal(store.shelves.value.length, 1)
    assert.equal(store.catalogFreshness.value, 'cached', 'and it is labelled stale, not fresh')
    assert.equal(store.account.value, null)
    assert.equal(store.ownershipResolved.value, false)
    assert.equal(store.error.value?.code, 'CONTENT_STORE_NOT_SERVED')
  })

  test('one part that could not be asked is named without failing the parts that answered', async () => {
    handler = () => ({
      ...completeOverview(),
      phase: 'partial',
      sections: {
        ...completeOverview().sections,
        receipts: unavailable('CONTENT_STORE_GATEWAY_FAILED', 'The Gateway could not serve the Studio Library (HTTP 500).'),
      },
    })
    const store = useContentStore()
    await store.refresh()
    // The catalogue itself answered, so it is fresh — and the page separately
    // disables ownership actions through `accountResolved` (pinned in
    // contentStoreLibraryPage below).
    assert.equal(store.catalogFreshness.value, 'fresh')
    assert.equal(store.error.value?.code, 'CONTENT_STORE_GATEWAY_FAILED')
    assert.deepEqual(store.unavailableSections.value.map(section => section.section), ['receipts'])
  })
})

describe('the Studio Library page renders the partial state plainly', () => {
  test('the Installed tab reads this Mac even when the catalogue could not be read', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile(new URL('../pages/library.vue', import.meta.url), 'utf8')
    // The "unavailable" state must not swallow the one tab that needs no Gateway.
    assert.match(source, /catalogFreshness === 'unavailable' && activeTab !== 'installed'/)
    assert.match(source, /still listed under Installed/)
    assert.match(source, /:installs-resolved="installsResolved"/)
    // Ownership actions require BOTH the catalogue and the account.
    assert.match(source, /catalogFreshness\.value !== 'fresh' \|\| !accountResolved\.value/)
    // Every part that could not be asked is named, not only the first.
    assert.match(source, /otherUnavailable/)
    assert.match(source, /SECTION_LABELS\[entry\.section\]/)
  })

  test('the Installed list counts packs once an answer arrived, not once ownership was confirmed', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile(new URL('../components/content-store/ContentInstalledLibraryView.vue', import.meta.url), 'utf8')
    assert.match(source, /installsResolved/)
    assert.doesNotMatch(source, /v-if="!ownershipResolved"/)
  })
})
