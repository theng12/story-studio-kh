import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { contentStoreErrorPresentation } from '../composables/useContentStore.js'

/** Remove single- and multi-line imports; the compiled component gets explicit support values. */
function stripImports(code: string): string {
  return code
    .replace(/^import\b[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^import\s*['"][^'"]+['"];?[ \t]*$/gm, '')
}

;(globalThis as any).__contentStoreErrorPresentation = contentStoreErrorPresentation
;(globalThis as any).__contentStoreKindCanCarryPreviews = (kind: string) =>
  ['visual_style', 'thumbnail_recipe', 'font_pack'].includes(kind)
// Default: no previews are readable, so the detail view keeps its cover view.
;(globalThis as any).__contentStoreApiGet = async () => ({ available: false, reason: 'not-installed', pictures: [] })
// Child components the harness strips out of the source; the real ones are
// exercised by their own tests, and the detail view only needs their shape.
;(globalThis as any).__PackPreviewViewer = defineComponent({
  props: ['pictures', 'index', 'title'],
  emits: ['close', 'update:index'],
  setup(props, { emit }) {
    return () => h('div', { 'data-test': 'preview-viewer' }, [
      h('span', { 'data-test': 'viewer-count' }, String(props.pictures.length)),
      h('button', { type: 'button', onClick: () => emit('close') }, 'close'),
    ])
  },
})
;(globalThis as any).__ContentProductCover = defineComponent({
  props: ['product'],
  setup() { return () => h('div', { 'data-test': 'cover-fallback' }) },
})

const detail = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductDetail.vue', import.meta.url)), 'utf8')
const route = readFileSync(fileURLToPath(new URL('../pages/library/[productId].vue', import.meta.url)), 'utf8')
const cover = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductCover.vue', import.meta.url)), 'utf8')
const storePage = readFileSync(fileURLToPath(new URL('../pages/library.vue', import.meta.url)), 'utf8')

async function loadComponent(relative: string): Promise<Component> {
  const filename = fileURLToPath(new URL(relative, import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: `content-store-state-${relative}` })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: `content-store-state-${relative}`, compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, nextTick, ref, watch } from 'vue'
    const contentStoreErrorPresentation = globalThis.__contentStoreErrorPresentation
    const contentStoreKindCanCarryPreviews = globalThis.__contentStoreKindCanCarryPreviews
    const useApi = () => ({ get: globalThis.__contentStoreApiGet })
    const contentStoreKindLabel = (kind: string) => kind
    const PackPreviewViewer = globalThis.__PackPreviewViewer
    const ContentProductCover = globalThis.__ContentProductCover
  `
  const code = `${support}\n${stripImports(script.content).replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

async function loadStorePage(): Promise<Component> {
  const filename = fileURLToPath(new URL('../pages/library.vue', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'content-store-page-state' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'content-store-page-state', compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, h, nextTick, onMounted, ref, defineComponent as _defineComponent } from "vue"
    const ContentStoreFilters = { emits: ['update:query'], setup: (props, { emit }) => () => h('div', { 'data-test': 'catalog-filters' }, [h('button', { 'data-test': 'set-query', onClick: () => emit('update:query', 'zzz') }, 'search')]) }
    const ContentStoreShelf = { props: ['products'], setup: (props) => () => props.products?.[0] ? h('div', { 'data-test': 'catalog-item' }, props.products[0].title) : null }
    const ContentLibraryView = { render: () => null }
    const ContentInstalledLibraryView = { render: () => null }
    const ContentPackBrowser = { render: () => null }
    const filterCatalogProducts = (items, query) => query ? items.filter(item => String(item.title || '').toLowerCase().includes(String(query).toLowerCase())) : items
    // Real implementation, not a simplification: the tab counts are asserted
    // here, and a stub would let them agree with something nothing ships.
    const installedPackCount = (packs) => new Set(packs.filter(pack => pack.active).map(pack => pack.packId)).size
    const orderShelfProducts = (items) => items
    const contentStoreErrorPresentation = (error) => ({ title: error.code, detail: error.detail, recovery: '' })
    const CONTENT_PACK_IMPORT_MAX_BYTES = 50 * 1024 * 1024
    const contentPackImportErrorPresentation = (error) => ({ title: error.code, detail: error.detail, recovery: '' })
    const contentPackImportUiError = (cause) => ({ status: cause?.status ?? null, code: cause?.data?.code || 'unknown', detail: cause?.data?.detail || cause?.message || '' })
    // The real queue lives in ~/composables/useInstallQueue and is covered by
    // its own tests; here it only has to exist and accept work.
    const useContentInstallQueue = () => ({
      enqueue: () => undefined,
      enqueueAll: () => undefined,
      statusOf: () => 'idle',
      isBusy: () => false,
      activeReleaseId: computed(() => ''),
      pendingCount: computed(() => 0),
      failedCount: computed(() => 0),
      running: computed(() => false),
      finished: computed(() => false),
      clearFinished: () => undefined,
      batchTotal: computed(() => 0), batchDone: computed(() => 0), batchInstalled: computed(() => 0),
      batchFailed: computed(() => 0), haltReason: computed(() => ''), activeTitle: computed(() => ''), failures: computed(() => []),
    })
    const useContentStore = () => globalThis.__contentStorePageStore
    const useAppSettingsModal = () => ({ open: () => undefined })
    const useRoute = () => ({ params: {} })
    const useAppTitle = () => undefined
  `
  const code = `${support}\n${stripImports(script.content).replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

async function loadDetailRoute(): Promise<Component> {
  const filename = fileURLToPath(new URL('../pages/library/[productId].vue', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'content-store-detail-route-state' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'content-store-detail-route-state', compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, defineComponent as _defineComponent } from "vue"
    const ContentProductDetail = { props: ['product', 'ownership', 'networkUnavailable', 'queueStatus'], setup: (props) => () => h('div', { 'data-test': 'historical-proof', 'data-owned': String(props.product.owned), 'data-ownership': String(!!props.ownership), 'data-network-unavailable': String(props.networkUnavailable), 'data-queue-status': String(props.queueStatus || '') }, props.product.title) }
    const contentStoreErrorPresentation = (error) => ({ title: error.code, detail: error.detail, recovery: 'Refresh the Library.' })
    const useContentStore = () => globalThis.__contentStoreDetailStore
    const useContentInstallQueue = () => ({ enqueue: () => undefined, isBusy: () => false, statusOf: () => globalThis.__contentStoreDetailQueueStatus || 'idle', failureOf: () => '' })
    const useRoute = () => ({ params: { productId: 'formula' } })
    const useAppTitle = () => undefined
    const navigateTo = () => undefined
  `
  const code = `${support}\n${stripImports(script.content).replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
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

describe('Studio Library proof route contract', () => {
  test('mounts semantic roving tabs and moves focus with ArrowRight, Home, and End', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = {
      account: ref(null), products: ref([]), installed: ref([]), shelves: ref([]),
      catalogFreshness: ref('fresh'), ownershipResolved: ref(true), accountResolved: ref(true), installsResolved: ref(true), unavailableSections: ref([]), lastVerifiedAt: ref('2026-08-14T10:00:00Z'), loading: ref(false), error: ref(null),
      recovery: ref(null), recoveryError: ref(null), refreshRecovery: async () => {}, dismissRecovery: async () => {},
      removals: ref(null), refreshRemovals: async () => {}, removePack: async () => {}, restorePack: async () => {},
      refresh: async () => {},
    }
    const rendered = await mount(Page, {})
    const tabs = [...rendered.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    assert.equal(tabs.length, 4, 'Discover, Gateway archives, Installed and Updates')
    tabs[0]!.focus()
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await nextTick()
    assert.equal(document.activeElement?.id, 'library-tab-archives')
    tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await nextTick()
    assert.equal(document.activeElement?.id, 'library-tab-updates')
    tabs[3]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await nextTick()
    assert.equal(document.activeElement?.id, 'library-tab-discover')
    rendered.unmount()
  })

  test('mounts an unavailable no-cache state without catalog filters or a false empty result', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = {
      account: ref(null), products: ref([]), installed: ref([]), shelves: ref([]),
      catalogFreshness: ref('unavailable'), ownershipResolved: ref(true), accountResolved: ref(true), installsResolved: ref(true), unavailableSections: ref([]), lastVerifiedAt: ref(null), loading: ref(false),
      error: ref({ code: 'CONTENT_STORE_UNAVAILABLE', detail: 'GenStudio could not be reached.' }),
      recovery: ref(null), recoveryError: ref(null), refreshRecovery: async () => {}, dismissRecovery: async () => {},
      removals: ref(null), refreshRemovals: async () => {}, removePack: async () => {}, restorePack: async () => {},
      refresh: async () => { throw new Error('offline') },
    }
    const rendered = await mount(Page, {})
    assert.match(rendered.host.textContent || '', /Studio Library is unavailable/)
    assert.equal(rendered.host.querySelector('[data-test="catalog-filters"]'), null)
    assert.doesNotMatch(rendered.host.textContent || '', /No published products match these filters/)
    rendered.unmount()
  })

  test('keeps cached A proof historical and disables actions when detail refresh fails', async () => {
    const DetailRoute = await loadDetailRoute()
    let actionCalls = 0
    ;(globalThis as any).__contentStoreDetailStore = {
      account: ref({ accountId: 'acct_a', owned: [{ entitlementFamily: 'formula-family' }] }),
      installed: ref([]), removals: ref(null), refreshRemovals: async () => {}, removePack: async () => {}, restorePack: async () => {},
      products: ref([{ productId: 'formula', title: 'Account A Formula', entitlementFamily: 'formula-family', owned: true }]),
      cachedProof: ref({ accountId: 'acct_a', origin: 'https://a.example.test', verifiedAt: '2026-08-14T10:00:00Z' }),
      catalogFreshness: ref('cached'), ownershipResolved: ref(true), loading: ref(false), error: ref({ code: 'CONTENT_STORE_UNAVAILABLE', detail: 'GenStudio is offline.' }),
      refresh: async () => { throw new Error('offline') },
    }
    const rendered = await mount(DetailRoute, {})
    const proof = rendered.host.querySelector<HTMLElement>('[data-test="historical-proof"]')!
    assert.match(rendered.host.textContent || '', /Last checked with the Gateway at https:\/\/a\.example\.test/)
    assert.doesNotMatch(rendered.host.textContent || '', /account acct_a|Gateway account/, 'no account wording on the page')
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
      installed: ref([]), removals: ref(null), refreshRemovals: async () => {}, removePack: async () => {}, restorePack: async () => {},
      products: ref([{ productId: 'formula', title: 'Formula', entitlementFamily: 'formula-family', owned: true, compatible: true, currentRelease: { releaseId: 'release_1' } }]),
      cachedProof: ref(null), catalogFreshness: ref('fresh'), ownershipResolved: ref(true), loading: ref(false), error: ref(null),
      refresh: async () => {},
    }
    const rendered = await mount(DetailRoute, {})
    assert.equal(rendered.host.querySelector<HTMLElement>('[data-test="historical-proof"]')?.dataset.queueStatus, 'installed')
    rendered.unmount()
    delete (globalThis as any).__contentStoreDetailQueueStatus
  })

  function pageStore(overrides: Record<string, unknown> = {}) {
    return {
      account: ref({ contentAccountId: 'content_a', owned: [] }),
      products: ref([]), installed: ref([]), shelves: ref([]),
      catalogFreshness: ref('fresh'), ownershipResolved: ref(true), accountResolved: ref(true), installsResolved: ref(true), unavailableSections: ref([]), lastVerifiedAt: ref('2026-08-17T10:00:00Z'), loading: ref(false), error: ref(null),
      recovery: ref(null), recoveryError: ref(null), refreshRecovery: async () => {}, dismissRecovery: async () => {},
      removals: ref(null), refreshRemovals: async () => {}, removePack: async () => {}, restorePack: async () => {},
      refresh: async () => {},
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
    assert.doesNotMatch(rendered.host.textContent || '', /Loading the Gateway catalog/)
    assert.equal(rendered.host.querySelector('[data-test="catalog-item"]') !== null, true, 'the cached shelf is already on screen')
    rendered.unmount()
  })

  test('a relaunch paints the saved catalogue at once and shows the account as unchecked, not as empty', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = pageStore({
      account: ref(null), ownershipResolved: ref(false), catalogFreshness: ref('restored'),
      // Nothing has answered yet on a restored launch: neither the account nor
      // the install list is known, so their tab counts must stay "—".
      accountResolved: ref(false), installsResolved: ref(false),
      lastVerifiedAt: ref(null), loading: ref(true),
      listGatewayArchives: () => new Promise(() => {}),
      products: ref([catalogProduct({})]), shelves: ref([{ id: 's1', productIds: ['p1'] }]),
    })
    const rendered = await mount(Page, {})
    const text = rendered.host.textContent || ''

    assert.doesNotMatch(text, /Loading the Gateway catalog/, 'there is a catalogue to show, so there is no loading screen')
    assert.equal(rendered.host.querySelector('[data-test="catalog-item"]') !== null, true, 'the saved shelf is already on screen')
    assert.match(text, /Showing the published catalogue saved on this Mac/)
    assert.match(text, /Gateway download stays off until it answers/)
    assert.match(text, /Install Content Pack still works from a local file/)
    assert.doesNotMatch(text, /content_a/, 'no account id before GenStudio answers')

    const tabCounts = [...rendered.host.querySelectorAll('[role="tab"] span')].map(node => node.textContent)
    assert.deepEqual(tabCounts, ['1', '—', '—', '—'], 'the published count is a catalogue fact; the rest are not counted yet')

    const tabLabels = [...rendered.host.querySelectorAll('[role="tab"]')].map(node => (node.textContent || '').replace(/\d|—/g, '').trim())
    assert.deepEqual(tabLabels, ['Discover', 'Gateway archives', 'Installed', 'Updates'])
    rendered.unmount()
  })

  test('a genuine cold start with nothing cached still shows the loading state', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = pageStore({
      catalogFreshness: ref('unavailable'), ownershipResolved: ref(true), accountResolved: ref(true), installsResolved: ref(true), unavailableSections: ref([]), lastVerifiedAt: ref(null), loading: ref(true),
    })
    const rendered = await mount(Page, {})
    assert.match(rendered.host.textContent || '', /Loading the Gateway catalog/)
    rendered.unmount()
  })

  test('each Discover empty state names its own cause instead of blaming filters', async () => {
    const cases = [
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
        [...rendered.host.querySelectorAll('button')].some(button => /Clear Filters/.test(button.textContent || '')),
        false,
        `${scenario.name} must not offer to clear filters nobody set`,
      )
      rendered.unmount()
    }
  })

  test('filters that really do exclude everything keep the original message and its Clear Filters action', async () => {
    const Page = await loadStorePage()
    ;(globalThis as any).__contentStorePageStore = pageStore({
      products: ref([catalogProduct({})]),
      shelves: ref([{ id: 's1', productIds: ['p1'] }]),
    })
    const rendered = await mount(Page, {})
    assert.equal(rendered.host.querySelector('[data-test="catalog-item"]') !== null, true)

    rendered.host.querySelector<HTMLButtonElement>('[data-test="set-query"]')!.click()
    await nextTick(); await nextTick()

    assert.match(rendered.host.textContent || '', /No published products match these filters/)
    assert.equal(
      [...rendered.host.querySelectorAll('button')].some(button => /Clear Filters/.test(button.textContent || '')),
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
    assert.match(detail, /product\.bundleComponents/)
    assert.doesNotMatch(detail, /versionFromSignedSummary/)
    assert.match(route, /Unknown Studio Library product/)
    assert.doesNotMatch(route, /project selection|select a project/i)
  })

  test('leaves the proof route through PlainBackLink, which yields Escape to an open dialog', () => {
    assert.match(route, /<PlainBackLink label="Back to Studio Library" fallback="\/library" \/>/)
    assert.doesNotMatch(route, /event\.key === 'Escape'/, 'no page-level Escape handler to fight the purchase dialog')
  })

  test('keeps the nested proof outlet mounted for direct route resolution', () => {
    assert.match(storePage, /<NuxtPage\s*\/>/)
    assert.doesNotMatch(storePage, /<NuxtPage\s+v-if/)
  })

  test('uses truthful cover text and shows no price on the cover', () => {
    assert.match(cover, /product\.presentation\.cover/)
    assert.match(cover, /:alt="coverAlt"/)
    assert.doesNotMatch(cover, /creditPrice|product\.free/)
  })

  test('uses 44px text-link targets on the library page', () => {
    // One Back wording across every top-level page (owner, 2026-11-01: "Back
    // links say Back on some pages and Back to Channels on others"). The label
    // comes from the component's default, so no page may rename it.
    assert.match(storePage, /<PlainBackLink \/>/)
    assert.doesNotMatch(storePage, /<PlainBackLink[^>]*label=/, 'no page overrides the shared Back wording')
    assert.match(readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductCard.vue', import.meta.url)), 'utf8'), /\.proof-action\s*\{[^}]*min-height:\s*44px/)
  })
})


/**
 * The pack's three preview pictures, and the viewer they open into.
 *
 * The complaint behind this: every card showed alt text in an empty box, and
 * there was no way to look at a pack's pictures. What is pinned here is the
 * detail view's half of that - the wall shows the pack's OWN previews when it
 * has them, a dead picture degrades its own tile instead of emptying the row,
 * and the viewer opens with all three.
 */
describe('Studio Library preview pictures', () => {
  function styleProduct(overrides: Record<string, unknown> = {}) {
    return {
      productId: 'com.storystudio.pack.style.previews',
      entitlementFamily: 'family.previews',
      kind: 'visual_style',
      title: 'Oil Study',
      summary: 'Painterly.',
      description: '',
      publisherId: 'com.storystudio',
      free: true,
      owned: true,
      retired: false,
      successorProductId: null,
      currentRelease: { releaseId: 'rel_1', packId: 'com.storystudio.pack.style.previews', version: '1.0.0' },
      compatible: true,
      compatibilityReason: null,
      bundleComponents: [],
      showcaseVideos: [],
      presentation: {
        cover: { src: '/api/content-store/covers/com.storystudio.pack.style.previews/1.0.0', alt: 'Oil Study' },
        hero: null,
        licenseLabel: null,
        licenseText: null,
        tags: [],
      },
      ...overrides,
    }
  }

  const THREE = [
    { src: '/api/content-packs/p/1.0.0/assets/aaa', alt: 'Oil Study — Hero' },
    { src: '/api/content-packs/p/1.0.0/assets/bbb', alt: 'Oil Study — Quiet wide scene' },
    { src: '/api/content-packs/p/1.0.0/assets/ccc', alt: 'Oil Study — Hardest legal case' },
  ]

  test('an installed style pack shows its three previews, and the viewer opens with all three', async () => {
    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: true, reason: null, pictures: THREE })
    const Detail = await loadComponent('../components/content-store/ContentProductDetail.vue')
    const rendered = await mount(Detail, { product: styleProduct() })
    await nextTick()

    const tiles = rendered.host.querySelectorAll('.preview-tile')
    assert.equal(tiles.length, 3, 'the pack wall shows the pack\'s own three previews')
    // The cover is one of them, so it must not be listed twice.
    const srcs = [...rendered.host.querySelectorAll('.preview-tile img')].map(img => img.getAttribute('src'))
    assert.equal(new Set(srcs).size, 3)

    rendered.host.querySelector<HTMLButtonElement>('.preview-tile')!.click()
    await nextTick()
    assert.match(rendered.host.outerHTML, /data-test="preview-viewer"/, 'a tile opens the viewer')
    assert.equal(rendered.host.querySelector('[data-test="viewer-count"]')!.textContent, '3')
    rendered.unmount()
    delete (globalThis as any).__contentStoreApiGet
    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: false, reason: 'not-installed', pictures: [] })
  })

  test('one picture that fails shows the fallback and leaves the other two standing', async () => {
    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: true, reason: null, pictures: THREE })
    const Detail = await loadComponent('../components/content-store/ContentProductDetail.vue')
    const rendered = await mount(Detail, { product: styleProduct() })
    await nextTick()

    const dead = rendered.host.querySelectorAll<HTMLImageElement>('.preview-tile img')[1]!
    dead.dispatchEvent(new Event('error'))
    await nextTick()

    // Not an empty box: the failed tile says what happened, in words.
    assert.equal(rendered.host.querySelectorAll('.preview-tile-fallback').length, 1)
    assert.match(rendered.host.querySelector('.preview-tile-fallback')!.textContent || '', /Couldn.t load preview/)
    // The other two still show their pictures.
    assert.equal(rendered.host.querySelectorAll('.preview-tile img').length, 2)
    assert.equal(rendered.host.querySelectorAll('.preview-tile').length, 3, 'the row keeps its shape')
    rendered.unmount()
    delete (globalThis as any).__contentStoreApiGet
    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: false, reason: 'not-installed', pictures: [] })
  })

  test('a style pack that is not installed says previews appear after installing', async () => {
    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: false, reason: 'not-installed', pictures: [] })
    const Detail = await loadComponent('../components/content-store/ContentProductDetail.vue')
    const rendered = await mount(Detail, { product: styleProduct() })
    await nextTick()
    assert.match(rendered.host.textContent || '', /Previews appear after installing/)
    // The cover still stands in, so the section is never empty.
    assert.equal(rendered.host.querySelectorAll('.preview-tile').length, 1)
    rendered.unmount()
    delete (globalThis as any).__contentStoreApiGet
    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: false, reason: 'not-installed', pictures: [] })
  })

  test('a pack with no previews of its own keeps the cover view and promises nothing', async () => {
    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: true, reason: null, pictures: [] })
    const Detail = await loadComponent('../components/content-store/ContentProductDetail.vue')
    const rendered = await mount(Detail, { product: styleProduct({ kind: 'topic_pack' }) })
    await nextTick()
    assert.doesNotMatch(rendered.host.textContent || '', /Previews appear after installing/,
      'a pack that carries no previews must not promise some')
    assert.equal(rendered.host.querySelectorAll('.preview-tile').length, 1)
    rendered.unmount()
    delete (globalThis as any).__contentStoreApiGet
    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: false, reason: 'not-installed', pictures: [] })
  })

  /**
   * The pictures are an enhancement, so the page must outlive their reader.
   *
   * Two failures that must not look alike, and neither may look like "no
   * previews published" (AGENTS.md 6): a reader that is NOT THERE AT ALL, and
   * one that THROWS. Both leave the whole product on screen and say the pack's
   * pictures could not be read — they never promise previews installing cannot
   * deliver, and they never blank the page.
   */
  test('a preview reader that is missing or that throws leaves the page standing and says which', async () => {
    const Detail = await loadComponent('../components/content-store/ContentProductDetail.vue')

    ;(globalThis as any).__contentStoreApiGet = undefined
    const missing = await mount(Detail, { product: styleProduct() })
    await nextTick()
    assert.equal(missing.host.querySelector('h1')?.textContent, 'Oil Study', 'a missing reader must not take the page down')
    assert.match(missing.host.textContent || '', /could not read/i, 'and it says it could not read, not that there are none')
    assert.doesNotMatch(missing.host.textContent || '', /Previews appear after installing/)
    assert.equal(missing.host.querySelectorAll('.preview-tile').length, 1, 'the cover still stands in')
    missing.unmount()

    ;(globalThis as any).__contentStoreApiGet = async () => { throw new Error('Gateway did not answer') }
    const threw = await mount(Detail, { product: styleProduct() })
    await nextTick()
    assert.equal(threw.host.querySelector('h1')?.textContent, 'Oil Study', 'a throwing reader must not take the page down either')
    assert.match(threw.host.textContent || '', /could not read/i)
    assert.doesNotMatch(threw.host.textContent || '', /Previews appear after installing/)
    threw.unmount()

    ;(globalThis as any).__contentStoreApiGet = async () => ({ available: false, reason: 'not-installed', pictures: [] })
  })
})
