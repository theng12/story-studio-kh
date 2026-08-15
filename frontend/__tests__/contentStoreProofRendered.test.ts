import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component, type Ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { filterCatalogProducts, orderShelfProducts } from '../content-store/catalog-presentation.js'
import type { ContentStoreProduct, ContentStoreShelf, ContentStoreUiError } from '../composables/useContentStore.js'

type SfcName = 'ContentProductCard.vue' | 'ContentProductDetail.vue' | 'ContentStoreShelf.vue' | 'ContentInstalledLibraryView.vue' | '[productId].vue'
const sourceByName: Record<SfcName, string> = {
  'ContentProductCard.vue': '../components/content-store/ContentProductCard.vue',
  'ContentProductDetail.vue': '../components/content-store/ContentProductDetail.vue',
  'ContentStoreShelf.vue': '../components/content-store/ContentStoreShelf.vue',
  'ContentInstalledLibraryView.vue': '../components/content-store/ContentInstalledLibraryView.vue',
  '[productId].vue': '../pages/content-store/[productId].vue',
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
  const support = `
    import { h } from ${JSON.stringify(vueUrl)}
    const ContentProductCover = { props: ['product'], render: () => null }
    const ContentProductCard = { props: ['product'], render() { return h('article', { class: 'component-card' }, this.product.title) } }
    const ContentProductDetail = { props: ['product'], render() { return h('article', { class: 'detail-stub' }, this.product.title) } }
    const ContentPurchaseDialog = { render: () => null }
    const useRoute = () => globalThis.__contentStoreTestRoute
    const useContentStore = () => globalThis.__contentStoreTestStore
    const useAppTitle = () => undefined
    const navigateTo = (...args) => globalThis.__contentStoreNavigations.push(args)
  `
  const code = `${support}\n${script.content
    .replace(/import ContentProductCover from '.+?'\n/, '')
    .replace(/import ContentProductCard from '.+?'\n/, '')
    .replace(/import ContentProductDetail from '.+?'\n/, '')
    .replace(/import ContentPurchaseDialog from '.+?'\n/, '')
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
const LoadingSpinnerStub = defineComponent({ setup: () => () => h('span', 'loading') })

async function mount(component: Component, props: Record<string, unknown> = {}) {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(component, props)
  app.component('NuxtLink', NuxtLinkStub)
  app.component('LoadingSpinner', LoadingSpinnerStub)
  app.mount(host)
  await nextTick()
  return { host, unmount: () => app.unmount() }
}

function product(productId: string, title: string, kind: ContentStoreProduct['kind'] = 'series_formula'): ContentStoreProduct {
  return {
    productId, entitlementFamily: `${productId}.family`, kind, title,
    summary: `${title} promise`, description: `${title} transformation`, publisherId: 'Story Studio',
    creditPrice: 400, free: false, owned: false, retired: false, successorProductId: null,
    compatible: true, compatibilityReason: null,
    currentRelease: { releaseId: `rel_${productId}`, packId: `pack_${productId}`, version: '9.9.9', archiveSha256: 'a'.repeat(64), archiveBytes: 10, archiveAvailable: true, minStoryVersion: '1.0.0', changelog: 'Published.', componentSummary: {} },
    bundleComponents: [], ownedComponentCreditValue: 0, showcaseVideos: [],
    presentation: { cover: null, hero: null, licenseLabel: 'Content Pack License', licenseText: null, tags: [] }, discount: null,
  }
}

function testStore(overrides: Partial<{
  products: Ref<ContentStoreProduct[]>
  loading: Ref<boolean>
  error: Ref<ContentStoreUiError | null>
  refresh: () => Promise<void>
}> = {}) {
  return {
    account: ref(null), products: overrides.products || ref([]), installed: ref([]), shelves: ref([]), attempts: ref([]),
    catalogFreshness: ref('fresh'), lastVerifiedAt: ref(null), cachedProof: ref(null),
    loading: overrides.loading || ref(false), error: overrides.error || ref(null),
    refresh: overrides.refresh || (async () => {}), requestQuote: async () => { throw new Error('not used') },
    installRelease: async () => { throw new Error('not used') }, confirmPurchase: async () => { throw new Error('not used') },
  }
}

describe('Content Store rendered catalog and proof regressions', () => {
  test('renders local signed installed packs independently from account ownership', async () => {
    const Installed = await loadComponent('ContentInstalledLibraryView.vue')
    const rendered = await mount(Installed, { installed: [{
      packId: 'com.storystudio.local.withdrawn', version: '1.0.0', productId: 'withdrawn-product',
      title: 'com.storystudio.local.withdrawn', kind: 'unknown', ownedByActiveAccount: false,
      installState: 'installed_current', active: false, missingDependencies: [],
    }] })
    assert.match(rendered.host.textContent || '', /com\.storystudio\.local\.withdrawn/)
    assert.match(rendered.host.textContent || '', /ownership is not verified/i)
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
        grantedAt: '2026-08-14T09:12:44Z', purchaseId: 'cpur_blocked', currentRelease: blocked.currentRelease,
        showcaseVideos: [], recalledReleaseVersions: [], receiptVerification: 'verified' as const,
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

  test('renders signed exact dependency versions and authoritative states without current-version substitution', async () => {
    const Detail = await loadComponent('ContentProductDetail.vue')
    const bundle = product('bundle', 'Bundle')
    bundle.bundleComponents = [
      { productId: 'free-component', entitlementFamily: 'free.family', title: 'Free component', kind: 'topic_pack', componentCreditValue: 0, owned: false },
      { productId: 'owned-component', entitlementFamily: 'owned.family', title: 'Owned component', kind: 'visual_style', componentCreditValue: 400, owned: true },
      { productId: 'recalled-component', entitlementFamily: 'recalled.family', title: 'Recalled component', kind: 'thumbnail_recipe', componentCreditValue: 0, owned: false },
    ]
    const currentCatalogComponent = product('component', 'Component')
    currentCatalogComponent.currentRelease!.version = '9.9.9'
    const rendered = await mount(Detail, { product: bundle, attempt: {
      dependencies: [
        { position: 0, productId: 'free-component', entitlementFamily: 'free.family', releaseId: 'rel_free_123', version: '1.2.3', archiveSha256: 'a'.repeat(64), title: 'Free component', kind: 'topic_pack', states: ['free', 'included'] },
        { position: 1, productId: 'owned-component', entitlementFamily: 'owned.family', releaseId: 'rel_owned_234', version: '2.3.4', archiveSha256: 'b'.repeat(64), title: 'Owned component', kind: 'visual_style', states: ['owned', 'included', 'installed', 'withdrawn'] },
        { position: 2, productId: 'recalled-component', entitlementFamily: 'recalled.family', releaseId: 'rel_recalled_345', version: '3.4.5', archiveSha256: 'c'.repeat(64), title: 'Recalled component', kind: 'thumbnail_recipe', states: ['included', 'unavailable', 'recalled'] },
      ],
    }, catalogProducts: [bundle, currentCatalogComponent] })
    const proof = rendered.host.querySelector('.component-list')?.textContent || ''
    assert.match(proof, /Free component[\s\S]*1\.2\.3[\s\S]*Free[\s\S]*Included/)
    assert.match(proof, /Owned component[\s\S]*2\.3\.4[\s\S]*Owned[\s\S]*Included[\s\S]*Installed[\s\S]*Withdrawn/)
    assert.match(proof, /Recalled component[\s\S]*3\.4\.5[\s\S]*Included[\s\S]*Unavailable[\s\S]*Recalled/)
    assert.doesNotMatch(proof, /9\.9\.9/)
    rendered.unmount()
  })

  test('renders the published hero and complete license text on product detail', async () => {
    const Detail = await loadComponent('ContentProductDetail.vue')
    const item = product('proof', 'Proof product')
    item.presentation.hero = { src: 'https://cdn.example.test/proof-hero.webp', alt: 'Published proof hero' }
    item.presentation.licenseText = 'Use in monetized Story Studio videos; redistribution of the source pack is prohibited.'
    const rendered = await mount(Detail, { product: item, attempt: null })
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
    assert.match(loading.host.textContent || '', /Unknown Content Store product/)
    loading.unmount()

    const error = ref<ContentStoreUiError | null>(null)
    ;(globalThis as any).__contentStoreTestStore = testStore({ error, refresh: async () => {
      error.value = { status: 401, code: 'CONTENT_STORE_SCOPE_REQUIRED', detail: 'content:read scope is required.' }
      throw new Error('scope')
    } })
    const failed = await mount(Route)
    await Promise.resolve(); await nextTick()
    assert.match(failed.host.textContent || '', /Content Store access is needed/)
    assert.match(failed.host.textContent || '', /content:read scope is required/)
    assert.doesNotMatch(failed.host.textContent || '', /Unknown Content Store product/)
    failed.unmount()
  })

  test('keeps direct proof keyboard back navigation inside the Store', async () => {
    const Route = await loadComponent('[productId].vue')
    const products = ref([product('proof', 'Proof product')])
    ;(globalThis as any).__contentStoreTestRoute = { params: { productId: 'proof' } }
    ;(globalThis as any).__contentStoreNavigations = []
    ;(globalThis as any).__contentStoreTestStore = testStore({ products })
    const rendered = await mount(Route)
    await Promise.resolve(); await nextTick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    assert.deepEqual((globalThis as any).__contentStoreNavigations, [['/content-store']])
    assert.equal(rendered.host.querySelector('.back-link')?.getAttribute('href'), '/content-store')
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

  test('searches the published customer-facing product kind label without shelf data', () => {
    const item = product('kit', 'Night archive', 'niche_bundle')
    assert.deepEqual(
      filterCatalogProducts([item], 'channel kit', { price: 'all', kind: 'all', compatibleOnly: false }),
      [item],
    )
  })
})
