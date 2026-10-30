import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component, type Ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { filterCatalogProducts, orderShelfProducts, contentStoreKindLabel } from '../content-store/catalog-presentation.js'
import { _clearContentStoreSessionCacheForTests, contentStoreErrorPresentation, useContentStore } from '../composables/useContentStore.js'
import type { ContentStoreProduct, ContentStoreShelf, ContentStoreUiError } from '../composables/useContentStore.js'

type SfcName = 'ContentProductCard.vue' | 'ContentProductDetail.vue' | 'ContentStoreShelf.vue' | 'ContentInstalledLibraryView.vue' | '[productId].vue' | 'library.vue'

/** Remove single- and multi-line imports; the compiled component gets explicit support values. */
function stripImports(code: string): string {
  return code
    .replace(/^import\b[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^import\s*['"][^'"]+['"];?[ \t]*$/gm, '')
}

;(globalThis as any).__contentStoreErrorPresentation = contentStoreErrorPresentation
;(globalThis as any).__contentStoreKindLabel = contentStoreKindLabel
const sourceByName: Record<SfcName, string> = {
  'ContentProductCard.vue': '../components/content-store/ContentProductCard.vue',
  'ContentProductDetail.vue': '../components/content-store/ContentProductDetail.vue',
  'ContentStoreShelf.vue': '../components/content-store/ContentStoreShelf.vue',
  'ContentInstalledLibraryView.vue': '../components/content-store/ContentInstalledLibraryView.vue',
  '[productId].vue': '../pages/library/[productId].vue',
  'library.vue': '../pages/library.vue',
}

async function loadComponent(name: SfcName): Promise<Component> {
  const relative = sourceByName[name]
  const filename = fileURLToPath(new URL(relative, import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: `content-store-${name}` })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: `content-store-${name}`,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const pageSupport = name === 'library.vue' ? `
    const ContentStoreFilters = { render: () => null }
    const ContentStoreShelf = { render: () => null }
    const ContentLibraryView = { render: () => null }
    const ContentInstalledLibraryView = { render: () => null }
    const ContentPackBrowser = { render: () => null }
    const NuxtPage = { render: () => null }
    const useAppSettingsModal = () => ({ open: () => undefined })
    const useContentInstallQueue = () => ({ statusOf: () => 'idle', enqueue: () => undefined, enqueueAll: () => undefined, clearFinished: () => undefined, running: ref(false), finished: ref(false), batchDone: ref(0), batchTotal: ref(0), batchFailed: ref(0), haltReason: ref(''), activeTitle: ref(''), batchInstalled: ref(0), failures: ref([]) })
    const filterCatalogProducts = (items) => items
    const installedPackCount = (items) => items.length
    const orderShelfProducts = (items) => items
    const CONTENT_PACK_IMPORT_MAX_BYTES = 50 * 1024 * 1024
    const contentPackImportErrorPresentation = (error) => ({ title: error.code, detail: error.detail, recovery: '' })
    const contentPackImportUiError = (cause) => ({ status: cause?.status ?? null, code: cause?.data?.code || 'unknown', detail: cause?.data?.detail || cause?.message || '' })
  ` : ''
  const componentSupport = name === 'library.vue' ? '' : `
    const useContentInstallQueue = () => ({ statusOf: () => 'idle', enqueue: () => undefined, enqueueAll: () => undefined, clearFinished: () => undefined, running: ref(false), finished: ref(false), batchDone: ref(0), batchTotal: ref(0), batchFailed: ref(0), haltReason: ref(''), activeTitle: ref(''), batchInstalled: ref(0), failures: ref([]) })
  `
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onMounted, ref } from ${JSON.stringify(vueUrl)}
    const ContentProductCover = { props: ['product'], render: () => null }
    const ContentProductCard = { props: ['product'], render() { return h('article', { class: 'component-card' }, this.product.title) } }
    const ContentProductDetail = { props: ['product'], render() { return h('article', { class: 'detail-stub' }, this.product.title) } }
    const useRoute = () => globalThis.__contentStoreTestRoute
    const useContentStore = () => globalThis.__contentStoreTestStore
    const useAppTitle = () => undefined
    // The component imports this from ~/content-store/library-organisation; the
    // harness strips imports, so it is provided here exactly as it ships.
    const splitPackUsage = (labels) => {
      const channels = []; const unchecked = []
      for (const label of labels) {
        if (label.startsWith('could not check ')) unchecked.push(label.slice('could not check '.length))
        else channels.push(label)
      }
      return { channels, unchecked }
    }
    const navigateTo = (...args) => globalThis.__contentStoreNavigations.push(args)
    const contentStoreErrorPresentation = globalThis.__contentStoreErrorPresentation
    const contentStoreKindLabel = globalThis.__contentStoreKindLabel
    ${componentSupport}
    ${pageSupport}
  `
  const code = `${support}\n${stripImports(script.content)
    .replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const componentUrl = `data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`
  return (await import(componentUrl)).default
}

const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) },
})
const NuxtPageStub = defineComponent({ setup: () => () => null })
const PlainBackLinkStub = defineComponent({
  props: { label: String, fallback: String },
  setup(props) { return () => h('a', { class: 'plain-back-link', href: props.fallback }, props.label) },
})
const LoadingSpinnerStub = defineComponent({ setup: () => () => h('span', 'loading') })

async function mount(component: Component, props: Record<string, unknown> = {}) {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(component, props)
  app.component('NuxtLink', NuxtLinkStub)
  app.component('NuxtPage', NuxtPageStub)
  app.component('PlainBackLink', PlainBackLinkStub)
  app.component('LoadingSpinner', LoadingSpinnerStub)
  app.component('PageTitle', defineComponent({ setup(_, { slots }) { return () => h('header', [slots.default?.(), slots.actions?.()]) } }))
  app.mount(host)
  await nextTick()
  return { host, unmount: () => app.unmount() }
}

function product(productId: string, title: string, kind: ContentStoreProduct['kind'] = 'series_formula'): ContentStoreProduct {
  return {
    productId, entitlementFamily: `${productId}.family`, kind, title,
    summary: `${title} promise`, description: `${title} transformation`, publisherId: 'Story Studio',
    free: false, owned: false, retired: false, successorProductId: null,
    compatible: true, compatibilityReason: null,
    currentRelease: { releaseId: `rel_${productId}`, packId: `pack_${productId}`, version: '9.9.9', archiveSha256: 'a'.repeat(64), archiveBytes: 10, archiveAvailable: true, minStoryVersion: '1.0.0', changelog: 'Published.', componentSummary: {} },
    bundleComponents: [], showcaseVideos: [],
    presentation: { cover: null, hero: null, licenseLabel: 'Content Pack License', licenseText: null, tags: [] },
  }
}

function testStore(overrides: Partial<{
  products: Ref<ContentStoreProduct[]>
  loading: Ref<boolean>
  error: Ref<ContentStoreUiError | null>
  refresh: () => Promise<void>
  recovery: Ref<{ incidentId: string; kind: 'invalid_state_reset'; detectedAt: string } | null>
  recoveryError: Ref<{ action: 'check' | 'dismiss'; detail: string } | null>
  refreshRecovery: () => Promise<void>
  dismissRecovery: (incidentId: string) => Promise<void>
}> = {}) {
  return {
    account: ref(null), products: overrides.products || ref([]), installed: ref([]), shelves: ref([]),
    catalogFreshness: ref('fresh'), ownershipResolved: ref(true), accountResolved: ref(true), installsResolved: ref(true), unavailableSections: ref([]), lastVerifiedAt: ref(null), cachedProof: ref(null),
    loading: overrides.loading || ref(false), error: overrides.error || ref(null),
    refresh: overrides.refresh || (async () => {}),
    importPack: async () => { throw new Error('not used') },
    recovery: overrides.recovery || ref(null), recoveryError: overrides.recoveryError || ref(null), refreshRecovery: overrides.refreshRecovery || (async () => {}),
    dismissRecovery: overrides.dismissRecovery || (async () => {}),
    removals: ref(null), refreshRemovals: async () => {}, removePack: async () => {}, restorePack: async () => {},
  }
}

describe('Studio Library rendered catalog and proof regressions', () => {
  test('keeps local recovery failures visible, ignores an old GET after dismissal, and surfaces a new incident', async () => {
    const originalFetch = (globalThis as any).$fetch
    const requests: Array<{ path: string; method?: string }> = []
    let current = { incidentId: 'incident-one', kind: 'invalid_state_reset' as const, detectedAt: '2026-09-20T01:00:00Z' }
    let failRecoveryRead = false
    let resolveOldRead!: (response: { recovery: typeof current }) => void
    let delayNextRead = false
    ;(globalThis as any).$fetch = async (path: string, options: { method?: string } = {}) => {
      requests.push({ path, method: options.method })
      if (path === '/api/content-packs/recovery') {
        if (failRecoveryRead) throw Object.assign(new Error('recovery marker cannot be read'), { status: 500 })
        if (delayNextRead) {
          delayNextRead = false
          return await new Promise<{ recovery: typeof current }>(resolve => { resolveOldRead = resolve })
        }
        return { recovery: current }
      }
      if (path === '/api/content-packs/recovery/incident-one') throw Object.assign(new Error('stale incident'), { status: 409 })
      if (path === '/api/content-packs/recovery/incident-two') return { ok: true }
      throw new Error(`Unexpected request: ${path}`)
    }
    try {
      _clearContentStoreSessionCacheForTests()
      const store = useContentStore()
      await store.refreshRecovery()
      assert.equal(store.recovery.value?.incidentId, 'incident-one')
      await assert.rejects(store.dismissRecovery('incident-one'))
      assert.equal(store.recovery.value?.incidentId, 'incident-one')
      assert.equal(store.recoveryError.value?.action, 'dismiss')

      current = { incidentId: 'incident-two', kind: 'invalid_state_reset', detectedAt: '2026-09-20T02:00:00Z' }
      await store.refreshRecovery()
      assert.equal(store.recovery.value?.incidentId, 'incident-two')
      assert.equal(store.recoveryError.value, null)
      delayNextRead = true
      const oldRead = store.refreshRecovery()
      await store.dismissRecovery('incident-two')
      resolveOldRead({ recovery: current })
      await oldRead
      assert.equal(store.recovery.value, null)
      failRecoveryRead = true
      await store.refreshRecovery()
      assert.equal(store.recoveryError.value?.action, 'check')
      assert.equal(store.recovery.value, null)
      failRecoveryRead = false
      current = { incidentId: 'incident-three', kind: 'invalid_state_reset', detectedAt: '2026-09-20T03:00:00Z' }
      await store.refreshRecovery()
      assert.equal(store.recovery.value?.incidentId, 'incident-three')
      assert.equal(store.recoveryError.value, null)
      assert.deepEqual(requests.filter(request => request.method === 'DELETE').map(request => request.path), [
        '/api/content-packs/recovery/incident-one',
        '/api/content-packs/recovery/incident-two',
      ])
    } finally {
      ;(globalThis as any).$fetch = originalFetch
      _clearContentStoreSessionCacheForTests()
    }
  })

  test('renders local recovery errors independently of an unavailable Store overview and retains the incident through restore or failed dismissal', async () => {
    const Store = await loadComponent('library.vue')
    const recovery = ref({ incidentId: 'incident-one', kind: 'invalid_state_reset' as const, detectedAt: '2026-09-20T01:00:00Z' })
    const recoveryError = ref<{ action: 'check' | 'dismiss'; detail: string } | null>(null)
    let recoveryReads = 0
    ;(globalThis as any).__contentStoreTestRoute = { params: {} }
    ;(globalThis as any).__contentStoreNavigations = []
    ;(globalThis as any).__contentStoreTestStore = testStore({
      recovery,
      refresh: async () => { throw new Error('no key or offline') },
      refreshRecovery: async () => { recoveryReads += 1; recoveryError.value = { action: 'check', detail: 'Your Content Pack recovery notice could not be read.' } },
      dismissRecovery: async () => { recoveryError.value = { action: 'dismiss', detail: 'This recovery notice changed before it could be dismissed.' }; throw Object.assign(new Error('stale incident'), { status: 409 }) },
      recoveryError,
    })
    const rendered = await mount(Store)
    await Promise.resolve(); await nextTick()
    const notice = rendered.host.querySelector('.store-notice.warning')
    assert.match(notice?.textContent || '', /Refresh Library to see what is installed here, then install any packs still missing\./)
    assert.doesNotMatch(notice?.textContent || '', /Re-check my packs|account owns/)
    assert.match(notice?.textContent || '', /The unreadable index was reset; pack folders were retained\. Reinstall any packs still missing\./)
    assert.match(rendered.host.textContent || '', /Your Content Pack recovery notice could not be read\./)
    assert.equal(recoveryReads, 1)
    ;([...rendered.host.querySelectorAll('button')].find(button => button.textContent === 'Refresh Library') as HTMLButtonElement).click()
    await Promise.resolve(); await nextTick()
    assert.equal(recoveryReads, 2)
    assert.equal(
      [...rendered.host.querySelectorAll('button')].some(button => /Re-check my packs/.test(button.textContent || '')),
      false,
      'the shop\'s ownership re-check is gone',
    )
    assert.equal(recovery.value?.incidentId, 'incident-one')
    ;([...rendered.host.querySelectorAll('button')].find(button => button.textContent === 'Dismiss Notice') as HTMLButtonElement).click()
    await Promise.resolve(); await nextTick()
    assert.equal(recovery.value?.incidentId, 'incident-one')
    assert.match(rendered.host.textContent || '', /This recovery notice changed before it could be dismissed\./)
    rendered.unmount()
  })

  test('renders local signed installed packs without saying who owns them', async () => {
    const Installed = await loadComponent('ContentInstalledLibraryView.vue')
    const rendered = await mount(Installed, { installed: [{
      packId: 'com.storystudio.local.withdrawn', version: '1.0.0', productId: 'withdrawn-product',
      title: 'com.storystudio.local.withdrawn', kind: 'unknown',
      installState: 'installed_current', active: false, missingDependencies: [],
    }] })
    const text = rendered.host.textContent || ''
    assert.match(text, /com\.storystudio\.local\.withdrawn/)
    assert.match(text, /Retained/, 'a superseded version kept on this Mac is named as retained')
    assert.doesNotMatch(text, /ownership/i, 'an installed pack needs no ownership statement')
    rendered.unmount()
  })

  test('withholds mounted install actions when each release guard blocks independently', async () => {
    const Card = await loadComponent('ContentProductCard.vue')
    const Detail = await loadComponent('ContentProductDetail.vue')
    for (const fixture of [
      { label: 'incompatible', product: { compatible: false, compatibilityReason: 'Requires a newer Story Studio.' }, ownership: {} },
      { label: 'recalled', product: {}, ownership: { recalledReleaseVersions: ['9.9.9'] } },
      { label: 'unavailable', product: { currentRelease: null }, ownership: { currentRelease: null } },
      { label: 'no download', product: {}, ownership: { downloadAvailable: false } },
    ]) {
      const blocked = { ...product(`blocked-${fixture.label}`, 'Blocked pack'), owned: true, ...fixture.product }
      const ownership = {
        entitlementFamily: blocked.entitlementFamily, productId: blocked.productId, title: blocked.title, kind: 'series_formula' as const,
        currentRelease: blocked.currentRelease,
        showcaseVideos: [], recalledReleaseVersions: [],
        downloadAvailable: true, installState: 'not_installed' as const, installedVersion: null, missingDependencies: [], ...fixture.ownership,
      }
      const card = await mount(Card, { product: blocked, ownership })
      const detail = await mount(Detail, { product: blocked, ownership })
      assert.equal(card.host.querySelector('button.btn-primary'), null, fixture.label)
      assert.equal(detail.host.querySelector('button.btn-primary'), null, fixture.label)
      card.unmount(); detail.unmount()
    }
  })

  test('keeps server and final fallback shelf product order when the shelf is mounted', async () => {
    const Shelf = await loadComponent('ContentStoreShelf.vue')
    const alpha = product('alpha', 'Server first')
    const beta = product('beta', 'Server second')
    const gamma = product('gamma', 'Final fallback')
    const overviewProducts = [gamma, beta, alpha]
    const serverShelf: ContentStoreShelf = { id: 'featured', title: 'Server shelf', productIds: ['alpha', 'beta'] }
    const fallbackShelf: ContentStoreShelf = { id: 'all', title: 'Everything else', productIds: ['gamma'] }
    const wrapper = defineComponent({
      setup: () => () => h('div', [
        h(Shelf, { shelf: serverShelf, products: orderShelfProducts(overviewProducts, serverShelf), account: null, busyProductId: '', busyReleaseId: '' }),
        h(Shelf, { shelf: fallbackShelf, products: orderShelfProducts(overviewProducts, fallbackShelf), account: null, busyProductId: '', busyReleaseId: '' }),
      ]),
    })
    const rendered = await mount(wrapper)
    assert.deepEqual([...rendered.host.querySelectorAll('.component-card')].map(node => node.textContent), ['Server first', 'Server second', 'Final fallback'])
    rendered.unmount()
  })

  test('renders the published bundle components, each plainly included', async () => {
    const Detail = await loadComponent('ContentProductDetail.vue')
    const bundle = product('bundle', 'Bundle')
    bundle.bundleComponents = [
      { productId: 'first-component', entitlementFamily: 'first.family', title: 'First component', kind: 'topic_pack' },
      { productId: 'second-component', entitlementFamily: 'second.family', title: 'Second component', kind: 'visual_style' },
    ]
    const rendered = await mount(Detail, { product: bundle })
    const proof = rendered.host.querySelector('.component-list')?.textContent || ''
    assert.match(proof, /First component[\s\S]*topic_pack[\s\S]*Included/)
    assert.match(proof, /Second component[\s\S]*visual_style[\s\S]*Included/)
    assert.doesNotMatch(proof, /Owned|exact quote/i)
    rendered.unmount()
  })

  test('renders the published hero and complete license text on product detail', async () => {
    const Detail = await loadComponent('ContentProductDetail.vue')
    const item = product('proof', 'Proof product')
    item.presentation.hero = { src: 'https://cdn.example.test/proof-hero.webp', alt: 'Published proof hero' }
    item.presentation.licenseText = 'Use in monetized Story Studio videos; redistribution of the source pack is prohibited.'
    const rendered = await mount(Detail, { product: item })
    const hero = rendered.host.querySelector<HTMLImageElement>('img.detail-hero-media')
    assert.equal(hero?.src, 'https://cdn.example.test/proof-hero.webp')
    assert.equal(hero?.alt, 'Published proof hero')
    assert.match(rendered.host.textContent || '', /redistribution of the source pack is prohibited/)
    rendered.unmount()
  })

  test('renders direct proof route loading, request failure, and only then unknown product states', async () => {
    const Route = await loadComponent('[productId].vue')
    ;(globalThis as any).__contentStoreTestRoute = { params: { productId: 'missing' } }
    ;(globalThis as any).__contentStoreNavigations = []

    let resolveLoad!: () => void
    const delayed = new Promise<void>(resolve => { resolveLoad = resolve })
    ;(globalThis as any).__contentStoreTestStore = testStore({ refresh: () => delayed })
    const loading = await mount(Route)
    assert.match(loading.host.textContent || '', /Loading product proof…/)
    resolveLoad()
    await Promise.resolve(); await nextTick()
    assert.match(loading.host.textContent || '', /Unknown Studio Library product/)
    loading.unmount()

    const error = ref<ContentStoreUiError | null>(null)
    ;(globalThis as any).__contentStoreTestStore = testStore({ error, refresh: async () => {
      error.value = { status: 401, code: 'CONTENT_STORE_SCOPE_REQUIRED', detail: 'content:read scope is required.' }
      throw new Error('scope')
    } })
    const failed = await mount(Route)
    await Promise.resolve(); await nextTick()
    assert.match(failed.host.textContent || '', /Studio Library access is needed/)
    assert.match(failed.host.textContent || '', /content:read scope is required/)
    assert.doesNotMatch(failed.host.textContent || '', /Unknown Studio Library product/)
    failed.unmount()
  })

  test('leaves keyboard back navigation to PlainBackLink, falling back to the Library', async () => {
    const Route = await loadComponent('[productId].vue')
    const products = ref([product('proof', 'Proof product')])
    ;(globalThis as any).__contentStoreTestRoute = { params: { productId: 'proof' } }
    ;(globalThis as any).__contentStoreNavigations = []
    ;(globalThis as any).__contentStoreTestStore = testStore({ products })
    const rendered = await mount(Route)
    await Promise.resolve(); await nextTick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    assert.deepEqual((globalThis as any).__contentStoreNavigations, [], 'the page no longer handles Escape itself')
    assert.equal(rendered.host.querySelector('.plain-back-link')?.getAttribute('href'), '/library')
    rendered.unmount()
  })

  test('renders showcase controls but rejects non-YouTube URLs when clicked', async () => {
    const Detail = await loadComponent('ContentProductDetail.vue')
    const item = product('proof', 'Proof product')
    item.showcaseVideos = [{ url: 'https://example.test/not-youtube', title: 'Rejected showcase', description: '' }]
    const opened: unknown[][] = []
    const originalOpen = window.open
    window.open = (...args: any[]) => { opened.push(args); return null }
    try {
      const rendered = await mount(Detail, { product: item, catalogProducts: [item] })
      ;(rendered.host.querySelector('.showcase-link') as HTMLButtonElement).click()
      assert.deepEqual(opened, [])
      rendered.unmount()
    } finally {
      window.open = originalOpen
    }
  })

  test('shows which channels use each installed pack and removes it only on request', async () => {
    const Installed = await loadComponent('ContentInstalledLibraryView.vue')
    const removed: string[] = []
    const wrapper = defineComponent({
      setup: () => () => h(Installed, {
        installed: [{
          packId: 'com.storystudio.style', version: '1.0.0', productId: 'p1', title: 'Archive Style',
          kind: 'visual_style', installState: 'installed_current', active: true, missingDependencies: [],
        }],
        installsResolved: true,
        removals: { channels: { 'com.storystudio.style': ['quiet-documentary', 'sleep-history'] }, packs: {}, unreadable: false },
        onRemove: (packId: string) => { removed.push(packId) },
      }),
    })
    const rendered = await mount(wrapper)
    assert.match(rendered.host.textContent || '', /Used by 2 channels: quiet-documentary, sleep-history\./)
    assert.deepEqual(removed, [], 'nothing is removed until the button is pressed')
    const button = [...rendered.host.querySelectorAll<HTMLButtonElement>('button')]
      .find(candidate => candidate.textContent === 'Remove from this Mac')!
    button.click()
    await nextTick()
    assert.deepEqual(removed, ['com.storystudio.style'])
    rendered.unmount()
  })

  test('says plainly when a pack is used by no channel, and never guesses', async () => {
    const Installed = await loadComponent('ContentInstalledLibraryView.vue')
    const pack = {
      packId: 'com.storystudio.pack', version: '1.0.0', productId: 'p2', title: 'Unused Pack',
      kind: 'topic_pack' as const, installState: 'installed_current' as const, active: true, missingDependencies: [],
    }
    const unused = await mount(Installed, { installed: [pack], installsResolved: true, removals: { channels: {}, packs: {}, unreadable: false } })
    assert.match(unused.host.textContent || '', /Not used by any channel\./)
    unused.unmount()

    const unreadable = await mount(Installed, { installed: [pack], installsResolved: true, removals: { channels: {}, packs: {}, unreadable: true } })
    assert.match(unreadable.host.textContent || '', /could not read its Content Pack removal records/)
    unreadable.unmount()

    const notRead = await mount(Installed, { installed: [pack], installsResolved: true, removals: null })
    assert.match(notRead.host.textContent || '', /Checking which channels use it/)
    notRead.unmount()

    const unchecked = await mount(Installed, {
      installed: [pack], installsResolved: true,
      removals: { channels: { 'com.storystudio.pack': ['could not check mystery-channel'] }, packs: {}, unreadable: false },
    })
    assert.match(unchecked.host.textContent || '', /Could not check mystery-channel — that is not the same as unused\./)
    unchecked.unmount()
  })

  test('a Gateway removal that was kept for a channel names the channel, and a removed pack can be put back', async () => {
    const Installed = await loadComponent('ContentInstalledLibraryView.vue')
    const restored: string[] = []
    const kept = await mount(Installed, {
      installed: [{
        packId: 'com.storystudio.kept', version: '1.0.0', productId: 'p3', title: 'Kept Pack',
        kind: 'topic_pack', installState: 'installed_current', active: true, missingDependencies: [],
      }],
      installsResolved: true,
      removals: {
        channels: { 'com.storystudio.kept': ['quiet-documentary'] },
        unreadable: false,
        packs: {
          'com.storystudio.kept': {
            pack_id: 'com.storystudio.kept', removed_at: '2026-10-29T08:00:00Z', outcome: 'kept_in_use',
            channels: ['quiet-documentary'], detail: 'in use', gateway_remove_at: '2026-10-29T08:00:00Z',
            versions: [], restored_at: null, reported_at: null,
          },
        },
      },
      onRestore: (packId: string) => { restored.push(packId) },
    })
    assert.match(kept.host.textContent || '', /The Gateway stopped offering this pack, but a channel still uses it: quiet-documentary, so it stays installed\./)
    kept.unmount()

    const removed = await mount(Installed, {
      installed: [], installsResolved: true,
      removals: {
        channels: {}, unreadable: false,
        packs: {
          'com.storystudio.gone': {
            pack_id: 'com.storystudio.gone', removed_at: '2026-10-29T08:00:00Z', outcome: 'removed',
            channels: [], detail: null, gateway_remove_at: null,
            versions: [{ version: '1.0.0', install_path: '/tmp/x', trash_path: '/tmp/trash/x', active: true }],
            restored_at: null, reported_at: null,
          },
        },
      },
      onRestore: (packId: string) => { restored.push(packId) },
    })
    assert.match(removed.host.textContent || '', /Removed from this Mac/)
    assert.match(removed.host.textContent || '', /Story Studio never deletes a pack/)
    const button = [...removed.host.querySelectorAll<HTMLButtonElement>('button')]
      .find(candidate => candidate.textContent === 'Put it back')!
    button.click()
    await nextTick()
    assert.deepEqual(restored, ['com.storystudio.gone'])
    removed.unmount()
  })

  test('searches the published customer-facing product kind label without shelf data', () => {
    const item = product('kit', 'Night archive', 'niche_bundle')
    assert.deepEqual(
      filterCatalogProducts([item], 'channel kit', { kind: 'all', compatibleOnly: false }),
      [item],
    )
  })
})
