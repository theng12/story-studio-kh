import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const detail = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductDetail.vue', import.meta.url)), 'utf8')
const route = readFileSync(fileURLToPath(new URL('../pages/content-store/[productId].vue', import.meta.url)), 'utf8')
const cover = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductCover.vue', import.meta.url)), 'utf8')
const storePage = readFileSync(fileURLToPath(new URL('../pages/content-store.vue', import.meta.url)), 'utf8')
const purchaseDialog = readFileSync(fileURLToPath(new URL('../components/content-store/ContentPurchaseDialog.vue', import.meta.url)), 'utf8')

async function loadComponent(relative: string): Promise<Component> {
  const filename = fileURLToPath(new URL(relative, import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: `content-store-state-${relative}` })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: `content-store-state-${relative}`, compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = await import.meta.resolve('vue')
  const code = `${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

async function loadStorePage(): Promise<Component> {
  const filename = fileURLToPath(new URL('../pages/content-store.vue', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'content-store-page-state' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'content-store-page-state', compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, h, nextTick, onMounted, ref, defineComponent as _defineComponent } from "vue"
    const ContentStoreFilters = { emits: ['update:query'], setup: (props, { emit }) => () => h('div', { 'data-test': 'catalog-filters' }, [h('button', { 'data-test': 'set-query', onClick: () => emit('update:query', 'zzz') }, 'search')]) }
    const ContentStoreShelf = { props: ['products'], emits: ['quote'], setup: (props, { emit }) => () => props.products?.[0] ? h('button', { 'data-test': 'request-quote', onClick: () => emit('quote', props.products[0]) }, 'See exact quote') : null }
    const ContentLibraryView = { render: () => null }
    const ContentInstalledLibraryView = { render: () => null }
    const ContentPurchaseDialog = { props: ['visible', 'attempt'], emits: ['close', 'confirm'], setup: (props, { emit }) => () => props.visible ? h('div', { role: 'dialog' }, [h('button', { 'data-test': 'confirm-purchase', onClick: () => emit('confirm', props.attempt.quote_id) }, 'Confirm'), h('button', { 'data-test': 'purchase-done', onClick: () => emit('close') }, 'Done')]) : null }
    const filterCatalogProducts = (items, query) => query ? items.filter(item => String(item.title || '').toLowerCase().includes(String(query).toLowerCase())) : items
    // Real implementation, not a simplification: the tab counts are asserted
    // here, and a stub would let them agree with something nothing ships.
    const installedPackCount = (packs) => new Set(packs.filter(pack => pack.active).map(pack => pack.packId)).size
    const orderShelfProducts = (items) => items
    const contentStoreErrorPresentation = (error) => ({ title: error.code, detail: error.detail, recovery: '' })
    // The real queue lives in ~/composables/useInstallQueue and is covered by
    // its own tests; here it only has to exist and install straight away.
    const useInstallQueue = (install) => ({
      enqueue: (id) => { void install(id) },
      enqueueAll: (ids) => { for (const id of ids) void install(id) },
      statusOf: () => 'idle',
      isBusy: () => false,
      activeReleaseId: computed(() => ''),
      pendingCount: computed(() => 0),
      failedCount: computed(() => 0),
      running: computed(() => false),
      clearFinished: () => undefined,
    })
    // The shared, app-wide queue (v1.4.152) wraps useInstallQueue; its own
    // tests are contentInstallQueueShared. Here it installs straight away.
    const useContentInstallQueue = () => ({
      ...useInstallQueue((id) => globalThis.__contentStorePageStore.installRelease(id, { refreshOverview: false })),
      batchTotal: computed(() => 0), batchDone: computed(() => 0), batchInstalled: computed(() => 0),
      batchFailed: computed(() => 0), activeTitle: computed(() => ''), finished: computed(() => false),
    })
    // Real rule, not a stub: Select all counts on it.
    const batchSkipReason = (product) => !product ? 'No longer in the catalog' : product.owned ? 'Already owned' : product.retired ? 'Retired by GenStudio' : !product.compatible ? (product.compatibilityReason || 'Not compatible') : !product.currentRelease ? 'No published release' : null
    // Buying a whole selection lives in ~/composables/useBatchPurchase and has
    // its own tests (contentStoreBatchPurchase). Here it only has to exist, so
    // that mounting the page exercises the single-pack paths these tests are
    // actually about.
    const useBatchPurchase = () => ({
      items: ref([]), phase: ref('idle'), open: ref(false), busy: ref(false),
      progress: ref({ done: 0, total: 0 }),
      quoted: computed(() => []), quotedTotal: computed(() => 0),
      start: async () => undefined, confirmAll: async () => [],
      retryFailed: async () => undefined, close: () => undefined, dismiss: () => undefined, show: () => undefined,
    })
    const ContentBatchPurchaseDialog = { props: ['visible'], render: () => null }
    // The real one lives beside useBatchPurchase and is covered there. It has to
    // behave correctly here too: the page's selection total depends on it, and a
    // stub that summed blindly would hide the very defect it exists to prevent.
    const sumPublished = (rows, read) => {
      let total = 0
      for (const row of rows) {
        const value = read(row)
        if (typeof value !== 'number' || !Number.isFinite(value)) return null
        total += value
      }
      return total
    }
    const useContentStore = () => globalThis.__contentStorePageStore
    const useAppSettingsModal = () => ({ open: () => undefined })
    const useRoute = () => ({ params: {} })
    const useAppTitle = () => undefined
  `
  const code = `${support}\n${script.content.replace(/^import .*$/gm, '').replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

async function loadDetailRoute(): Promise<Component> {
  const filename = fileURLToPath(new URL('../pages/content-store/[productId].vue', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'content-store-detail-route-state' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'content-store-detail-route-state', compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, defineComponent as _defineComponent } from "vue"
    const ContentProductDetail = { props: ['product', 'ownership', 'networkUnavailable', 'queueStatus'], setup: (props) => () => h('div', { 'data-test': 'historical-proof', 'data-owned': String(props.product.owned), 'data-ownership': String(!!props.ownership), 'data-network-unavailable': String(props.networkUnavailable), 'data-queue-status': String(props.queueStatus || '') }, props.product.title) }
    const ContentPurchaseDialog = { render: () => null }
    const contentStoreErrorPresentation = (error) => ({ title: error.code, detail: error.detail, recovery: 'Refresh the Store.' })
    const useContentStore = () => globalThis.__contentStoreDetailStore
    const useContentInstallQueue = () => ({ enqueue: () => undefined, isBusy: () => false, statusOf: () => globalThis.__contentStoreDetailQueueStatus || 'idle', failureOf: () => '' })
    const useRoute = () => ({ params: { productId: 'formula' } })
    const useAppTitle = () => undefined
    const navigateTo = () => undefined
  `
  const code = `${support}\n${script.content.replace(/^import .*$/gm, '').replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

async function mount(component: Component, props: Record<string, unknown>) {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(component, props)
  app.component('Modal', defineComponent({ props: { visible: Boolean }, setup(props, { slots }) { return () => props.visible ? h('section', { role: 'dialog' }, slots.default?.()) : null } }))
  app.component('NuxtLink', defineComponent({ props: { to: String }, setup(_props, { slots }) { return () => h('a', slots.default?.()) } }))
  app.component('NuxtPage', defineComponent({ setup: () => () => null }))
  app.component('LoadingSpinner', defineComponent({ setup: () => () => h('span', 'loading') }))
  app.mount(host)
  await nextTick(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0))
  return { host, unmount: () => app.unmount() }
}

describe('Content Store proof route contract', () => {
  test('mounts semantic roving tabs and moves focus with ArrowRight, Home, and End', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = {
      account: ref(null), products: ref([]), installed: ref([]), shelves: ref([]), attempts: ref([]),
      catalogFreshness: ref('fresh'), ownershipResolved: ref(true), lastVerifiedAt: ref('2026-08-14T10:00:00Z'), loading: ref(false), error: ref(null),
      refresh: async () => {}, restoreOwnership: async () => {}, requestQuote: async () => { throw new Error('not used') },
      confirmPurchase: async () => { throw new Error('not used') }, installRelease: async () => { throw new Error('not used') },
    }
    const rendered = await mount(Page, {})
    const tabs = [...rendered.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    assert.equal(tabs.length, 4)
    tabs[0]!.focus()
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await nextTick()
    assert.equal(document.activeElement?.id, 'content-store-tab-owned')
    tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await nextTick()
    assert.equal(document.activeElement?.id, 'content-store-tab-updates')
    tabs[3]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await nextTick()
    assert.equal(document.activeElement?.id, 'content-store-tab-discover')
    rendered.unmount()
  })

  test('mounts an unavailable no-cache state without catalog filters or a false empty result', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = {
      account: ref(null), products: ref([]), installed: ref([]), shelves: ref([]), attempts: ref([]),
      catalogFreshness: ref('unavailable'), ownershipResolved: ref(true), lastVerifiedAt: ref(null), loading: ref(false),
      error: ref({ code: 'CONTENT_STORE_UNAVAILABLE', detail: 'GenStudio could not be reached.' }),
      refresh: async () => { throw new Error('offline') }, restoreOwnership: async () => {}, requestQuote: async () => { throw new Error('not used') },
      confirmPurchase: async () => { throw new Error('not used') }, installRelease: async () => { throw new Error('not used') },
    }
    const rendered = await mount(Page, {})
    assert.match(rendered.host.textContent || '', /Content Store is unavailable/)
    assert.equal(rendered.host.querySelector('[data-test="catalog-filters"]'), null)
    assert.doesNotMatch(rendered.host.textContent || '', /No published products match these filters/)
    rendered.unmount()
  })

  test('keeps cached A proof historical and disables actions when detail refresh fails', async () => {
    const DetailRoute = await loadDetailRoute()
    let actionCalls = 0
    ;(globalThis as any).__contentStoreDetailStore = {
      account: ref({ accountId: 'acct_a', owned: [{ entitlementFamily: 'formula-family' }] }),
      products: ref([{ productId: 'formula', title: 'Account A Formula', entitlementFamily: 'formula-family', owned: true }]), attempts: ref([]),
      cachedProof: ref({ accountId: 'acct_a', origin: 'https://a.example.test', verifiedAt: '2026-08-14T10:00:00Z' }),
      catalogFreshness: ref('cached'), ownershipResolved: ref(true), loading: ref(false), error: ref({ code: 'CONTENT_STORE_UNAVAILABLE', detail: 'GenStudio is offline.' }),
      refresh: async () => { throw new Error('offline') }, requestQuote: async () => { actionCalls++; throw new Error('not allowed') },
      confirmPurchase: async () => { actionCalls++; throw new Error('not allowed') }, installRelease: async () => { actionCalls++; throw new Error('not allowed') },
    }
    const rendered = await mount(DetailRoute, {})
    const proof = rendered.host.querySelector<HTMLElement>('[data-test="historical-proof"]')!
    assert.match(rendered.host.textContent || '', /Last verified for GenStudio account acct_a at https:\/\/a\.example\.test/)
    assert.match(rendered.host.textContent || '', /CONTENT_STORE_UNAVAILABLE: GenStudio is offline/)
    assert.equal(proof.textContent, 'Account A Formula')
    assert.equal(proof.dataset.owned, 'false', 'historical product proof must not assert active ownership')
    assert.equal(proof.dataset.ownership, 'false')
    assert.equal(proof.dataset.networkUnavailable, 'true')
    assert.equal(actionCalls, 0)
    rendered.unmount()
  })

  test('passes the completed shared install state into the product detail before the overview refresh lands', async () => {
    const DetailRoute = await loadDetailRoute()
    ;(globalThis as any).__contentStoreDetailQueueStatus = 'installed'
    ;(globalThis as any).__contentStoreDetailStore = {
      account: ref({ accountId: 'acct_a', owned: [{ entitlementFamily: 'formula-family', downloadAvailable: true, installState: 'not_installed', recalledReleaseVersions: [] }] }),
      products: ref([{ productId: 'formula', title: 'Formula', entitlementFamily: 'formula-family', owned: true, compatible: true, currentRelease: { releaseId: 'release_1' } }]), attempts: ref([]),
      cachedProof: ref(null), catalogFreshness: ref('fresh'), ownershipResolved: ref(true), loading: ref(false), error: ref(null),
      refresh: async () => {}, requestQuote: async () => { throw new Error('not used') }, confirmPurchase: async () => { throw new Error('not used') }, installRelease: async () => { throw new Error('not used') },
    }
    const rendered = await mount(DetailRoute, {})
    assert.equal(rendered.host.querySelector<HTMLElement>('[data-test="historical-proof"]')?.dataset.queueStatus, 'installed')
    rendered.unmount()
    delete (globalThis as any).__contentStoreDetailQueueStatus
  })

  /**
   * REVERSED ON PURPOSE, 2026-08-24. This used to assert that a completed
   * purchase moved the customer to the Owned tab. The owner, buying several
   * packs in a row from a sixty-five pack catalogue, asked for the opposite:
   * "when i purchased it, don't let it take me to the install page." Being
   * thrown out of the grid after every purchase is what made buying six packs
   * six separate journeys. What a purchase must still do is leave the dialog
   * closed and the tab the customer chose still selected.
   */
  test('a completed purchase leaves the customer exactly where they were', async () => {
    const Page = await loadStorePage()
    const attempt = {
      quote_id: 'quote_1', status: 'quoted', product_id: 'formula', credits_charged: 400,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400, balance_before: 500, balance_after: 100,
      expires_at: '2026-08-14T10:15:00Z', sufficient_credits: true, shortfall_credits: 0,
    }
    const attempts = ref<any[]>([])
    const product = { productId: 'formula', entitlementFamily: 'formula-family', owned: false, retired: false, compatible: true, free: false, currentRelease: { releaseId: 'release_1' }, presentation: { tags: [] } }
    ;(globalThis as any).__contentStorePageStore = {
      account: ref({ contentAccountId: 'content_a', availableCredits: 500, contentSpendableCredits: 500, owned: [] }), products: ref([product]), installed: ref([]), shelves: ref([{ id: 'featured', productIds: ['formula'] }]), attempts,
      catalogFreshness: ref('fresh'), ownershipResolved: ref(true), lastVerifiedAt: ref('2026-08-14T10:00:00Z'), loading: ref(false), error: ref(null),
      refresh: async () => {}, restoreOwnership: async () => {}, requestQuote: async () => { attempts.value = [attempt]; return attempt },
      confirmPurchase: async () => { attempts.value = [{ ...attempt, status: 'completed' }]; return attempts.value[0] }, installRelease: async () => ({ activated: false }),
    }
    const rendered = await mount(Page, {})
    rendered.host.querySelector<HTMLButtonElement>('[data-test="request-quote"]')!.click()
    await nextTick(); await nextTick()
    rendered.host.querySelector<HTMLButtonElement>('[data-test="confirm-purchase"]')!.click()
    await nextTick(); await nextTick()
    rendered.host.querySelector<HTMLButtonElement>('[data-test="purchase-done"]')!.click()
    await nextTick(); await nextTick()
    assert.equal(rendered.host.querySelector('[role="dialog"]'), null, 'the dialog closes on completion')
    const discoverTab = rendered.host.querySelector<HTMLButtonElement>('#content-store-tab-discover')!
    assert.equal(discoverTab.getAttribute('aria-selected'), 'true', 'the Discover tab the customer was on stays selected')
    assert.notEqual(document.activeElement?.id, 'content-store-tab-owned', 'nothing steals focus to another tab')
    rendered.unmount()
  })

  test('mounts the purchase refusal as text, announces it, and focuses the non-spending close control', async () => {
    const Dialog = await loadComponent('../components/content-store/ContentPurchaseDialog.vue')
    const visible = ref(false)
    const rendered = await mount(defineComponent({ setup: () => () => h(Dialog, {
      visible: visible.value,
      busy: false,
      product: { title: 'Archive Formula', free: false },
      attempt: {
        quote_id: 'quote_1', status: 'refused', base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
        balance_before: 500, balance_after: 100, expires_at: '2026-08-14T10:15:00Z', sufficient_credits: true, shortfall_credits: 0,
        refusal: { status: 409, code: 'quote_rejected', detail: '<strong>Quote expired</strong>' },
      },
      error: null,
    }) }), {})
    visible.value = true
    await nextTick(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Close purchase dialog')
    assert.match(rendered.host.textContent || '', /Quote expired/)
    assert.equal(rendered.host.querySelector('strong strong'), null, 'server detail is rendered as text, not HTML')
    assert.equal(rendered.host.querySelector('[role="status"]')?.textContent?.includes('quote can no longer be used'), true)
    rendered.unmount()
  })

  test('renders final signed operator and component discount facts without exposing signing material', async () => {
    const Dialog = await loadComponent('../components/content-store/ContentPurchaseDialog.vue')
    const rendered = await mount(Dialog, {
      visible: true,
      busy: false,
      product: { title: 'Archive Formula', free: false },
      attempt: {
        quote_id: 'quote_1', status: 'completed', base_credit_price: 2_000, discount_credits: 400,
        component_discount_credits: 400, operator_discount_credits: 1_440, quoted_credits: 160,
        credits_charged: 160, balance_before: 2_000, balance_after: 1_840,
        expires_at: '2026-08-14T10:15:00Z', sufficient_credits: true, shortfall_credits: 0,
        operator_discount: { discount_id: 'cdsc_archival_launch', version: 1, percent: 90, starts_on: null, ends_on: '2026-12-31', timezone: 'Asia/Phnom_Penh' },
        quote_signature: 'must-not-render', receipt_signature: 'must-not-render', canonical_json: 'must-not-render',
      },
      error: null,
    })
    const proof = rendered.host.textContent || ''
    assert.match(proof, /Base price[\s\S]*2,000/)
    assert.match(proof, /Owned-component discount[\s\S]*400/)
    assert.match(proof, /Operator discount[\s\S]*90%[\s\S]*cdsc_archival_launch/)
    assert.match(proof, /Operator discount credits[\s\S]*1,440/)
    assert.match(proof, /Credits charged[\s\S]*160/)
    assert.match(proof, /Balance before[\s\S]*2,000[\s\S]*Balance after[\s\S]*1,840/)
    assert.match(proof, /Ends 2026-12-31/)
    assert.doesNotMatch(proof, /must-not-render|signature|canonical/i)
    rendered.unmount()
  })

  test('does not offer exact-attempt retry for terminal or refetch-required refusals', async () => {
    const Dialog = await loadComponent('../components/content-store/ContentPurchaseDialog.vue')
    for (const [code, recovery] of [
      ['quote_expired', /request a new exact quote/i],
      ['quote_rejected', /request a new exact quote/i],
      ['already_owned', /refresh the Content Store/i],
    ] as const) {
      const rendered = await mount(Dialog, {
        visible: true,
        busy: false,
        product: { title: 'Archive Formula', free: false },
        attempt: {
          quote_id: `quote_${code}`, status: 'refused', base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
          balance_before: 500, balance_after: 100, expires_at: '2026-08-14T10:15:00Z', sufficient_credits: true, shortfall_credits: 0,
          refusal: { status: 409, code, detail: 'GenStudio refused this saved attempt.' },
        },
        error: null,
      })
      assert.match(rendered.host.textContent || '', recovery, code)
      assert.equal([...rendered.host.querySelectorAll('button')].some(button => /Retry this purchase/.test(button.textContent || '')), false, code)
      assert.equal([...rendered.host.querySelectorAll('button')].some(button => /Confirm/.test(button.textContent || '')), false, code)
      rendered.unmount()
    }
  })

  function pageStore(overrides: Record<string, unknown> = {}) {
    return {
      account: ref({ contentAccountId: 'content_a', availableCredits: 500, contentSpendableCredits: 500, owned: [] }),
      products: ref([]), installed: ref([]), shelves: ref([]), attempts: ref([]),
      catalogFreshness: ref('fresh'), ownershipResolved: ref(true), lastVerifiedAt: ref('2026-08-17T10:00:00Z'), loading: ref(false), error: ref(null),
      refresh: async () => {}, restoreOwnership: async () => {}, requestQuote: async () => { throw new Error('not used') },
      confirmPurchase: async () => { throw new Error('not used') }, installRelease: async () => { throw new Error('not used') },
      ...overrides,
    }
  }
  const catalogProduct = (fields: Record<string, unknown>) => ({
    productId: 'p1', title: 'Archive Formula', entitlementFamily: 'f1', owned: false, retired: false,
    compatible: true, free: false, currentRelease: null, presentation: { tags: [] }, ...fields,
  })

  test('re-opening the Store renders the cached catalog and revalidates without a loading state', async () => {
    const Page = await loadStorePage()
    const refreshCalls: unknown[] = []
    ;(globalThis as any).__contentStorePageStore = pageStore({
      products: ref([catalogProduct({})]),
      shelves: ref([{ id: 's1', productIds: ['p1'] }]),
      refresh: async (options: unknown) => { refreshCalls.push(options) },
    })
    const rendered = await mount(Page, {})
    assert.deepEqual(refreshCalls, [{ background: true }], 'mount asks to revalidate quietly')
    assert.doesNotMatch(rendered.host.textContent || '', /Loading the GenStudio catalog/)
    assert.equal(rendered.host.querySelector('[data-test="request-quote"]') !== null, true, 'the cached shelf is already on screen')
    rendered.unmount()
  })

  test('a relaunch paints the saved catalogue at once and shows the account as unchecked, not as empty', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = pageStore({
      account: ref(null), ownershipResolved: ref(false), catalogFreshness: ref('restored'),
      lastVerifiedAt: ref(null), loading: ref(true),
      products: ref([catalogProduct({})]), shelves: ref([{ id: 's1', productIds: ['p1'] }]),
    })
    const rendered = await mount(Page, {})
    const text = rendered.host.textContent || ''

    assert.doesNotMatch(text, /Loading the GenStudio catalog/, 'there is a catalogue to show, so there is no loading screen')
    assert.equal(rendered.host.querySelector('[data-test="request-quote"]') !== null, true, 'the saved shelf is already on screen')
    assert.match(text, /Showing the published catalogue saved on this Mac/)
    assert.match(text, /buying and installing stay off until they are/)
    assert.match(text, /Checking with GenStudio…/, 'the account strip holds its place without inventing a balance')
    assert.doesNotMatch(text, /content_a|500 credits/, 'no account id and no balance before GenStudio answers')

    const tabCounts = [...rendered.host.querySelectorAll('[role="tab"] span')].map(node => node.textContent)
    assert.deepEqual(tabCounts, ['1', '—', '—', '—'], 'the published count is a catalogue fact; the rest are not counted yet')

    const restore = [...rendered.host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Restore purchases')
    assert.equal(restore?.disabled, true, 'commerce stays off until ownership is verified')
    rendered.unmount()
  })

  test('a genuine cold start with nothing cached still shows the loading state', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = pageStore({
      catalogFreshness: ref('unavailable'), ownershipResolved: ref(true), lastVerifiedAt: ref(null), loading: ref(true),
    })
    const rendered = await mount(Page, {})
    assert.match(rendered.host.textContent || '', /Loading the GenStudio catalog/)
    rendered.unmount()
  })

  test('each Discover empty state names its own cause instead of blaming filters', async () => {
    const cases = [
      {
        name: 'every published pack is owned',
        store: { products: ref([catalogProduct({ owned: true })]), shelves: ref([{ id: 's1', productIds: ['p1'] }]) },
        expect: /You already own every published pack/,
        absent: /No published products match these filters/,
      },
      {
        name: 'the catalogue publishes nothing',
        store: { products: ref([catalogProduct({ retired: true })]), installed: ref([{ packId: 'pack_old' }]) },
        expect: /No packs are published yet/,
        absent: /match these filters|already own every published pack/,
      },
      {
        name: 'nothing is shelved',
        store: { products: ref([catalogProduct({})]), shelves: ref([]) },
        expect: /No published products are ready to show/,
        absent: /match these filters|already own every published pack/,
      },
    ]

    for (const scenario of cases) {
      const Page = await loadStorePage()
      ;(globalThis as any).__contentStorePageStore = pageStore(scenario.store)
      const rendered = await mount(Page, {})
      const text = rendered.host.textContent || ''
      assert.match(text, scenario.expect, scenario.name)
      assert.doesNotMatch(text, scenario.absent, scenario.name)
      assert.equal(
        [...rendered.host.querySelectorAll('button')].some(button => /Clear filters/.test(button.textContent || '')),
        false,
        `${scenario.name} must not offer to clear filters nobody set`,
      )
      rendered.unmount()
    }
  })

  test('filters that really do exclude everything keep the original message and its Clear filters action', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = pageStore({
      products: ref([catalogProduct({})]),
      shelves: ref([{ id: 's1', productIds: ['p1'] }]),
    })
    const rendered = await mount(Page, {})
    assert.equal(rendered.host.querySelector('[data-test="request-quote"]') !== null, true)

    rendered.host.querySelector<HTMLButtonElement>('[data-test="set-query"]')!.click()
    await nextTick(); await nextTick()

    assert.match(rendered.host.textContent || '', /No published products match these filters/)
    assert.equal(
      [...rendered.host.querySelectorAll('button')].some(button => /Clear filters/.test(button.textContent || '')),
      true,
    )
    rendered.unmount()
  })

  test('renders proof and opens showcase links externally', () => {
    assert.match(detail, /Watch example videos/)
    assert.match(detail, /openExternalShowcase/)
    assert.match(detail, /Opens YouTube in your default browser/)
    assert.doesNotMatch(detail, /iframe|autoplay|v-html/)
  })

  test('keeps proof facts and unknown products inside Content Store', () => {
    assert.match(detail, /Minimum Story Studio version/)
    assert.match(detail, /Included components/)
    assert.match(detail, /Publisher/)
    assert.match(detail, /Changelog/)
    assert.match(detail, /License/)
    assert.match(detail, /componentSummary/)
    assert.match(detail, /attempt\?\.dependencies/)
    assert.doesNotMatch(detail, /versionFromSignedSummary/)
    assert.match(route, /Unknown Content Store product/)
    assert.doesNotMatch(route, /project selection|select a project/i)
  })

  test('returns to the Store when Escape leaves the proof route', () => {
    assert.match(route, /event\.key === 'Escape'/)
    assert.match(route, /navigateTo\('\/content-store'\)/)
  })

  test('keeps the nested proof outlet mounted for direct route resolution', () => {
    assert.match(storePage, /<NuxtPage\s*\/>/)
    assert.doesNotMatch(storePage, /<NuxtPage\s+v-if/)
  })

  test('uses truthful cover text and server-published price/status', () => {
    assert.match(cover, /product\.presentation\.cover/)
    assert.match(cover, /:alt="coverAlt"/)
    assert.match(cover, /product\.free \? 'Free'/)
    assert.match(cover, /product\.creditPrice/)
  })

  test('uses a solid 3px focus outline for the dialog close control and 44px text-link targets', () => {
    assert.match(purchaseDialog, /\.dialog-close:focus-visible\s*\{\s*outline:\s*3px solid var\(--accent\);\s*outline-offset:\s*2px;\s*box-shadow:\s*none;/)
    assert.match(storePage, /\.back-link\s*\{[^}]*min-height:\s*44px/)
    assert.match(route, /\.back-link\s*\{[^}]*min-height:\s*44px/)
    assert.match(readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductCard.vue', import.meta.url)), 'utf8'), /\.proof-action\s*\{[^}]*min-height:\s*44px/)
  })
})
