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
    const ContentStoreFilters = { render: () => h('div', { 'data-test': 'catalog-filters' }) }
    const ContentStoreShelf = { props: ['products'], emits: ['quote'], setup: (props, { emit }) => () => props.products?.[0] ? h('button', { 'data-test': 'request-quote', onClick: () => emit('quote', props.products[0]) }, 'See exact quote') : null }
    const ContentLibraryView = { render: () => null }
    const ContentInstalledLibraryView = { render: () => null }
    const ContentPurchaseDialog = { props: ['visible', 'attempt'], emits: ['close', 'confirm'], setup: (props, { emit }) => () => props.visible ? h('div', { role: 'dialog' }, [h('button', { 'data-test': 'confirm-purchase', onClick: () => emit('confirm', props.attempt.quote_id) }, 'Confirm'), h('button', { 'data-test': 'purchase-done', onClick: () => emit('close') }, 'Done')]) : null }
    const filterCatalogProducts = (items) => items
    const orderShelfProducts = (items) => items
    const contentStoreErrorPresentation = (error) => ({ title: error.code, detail: error.detail, recovery: '' })
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
    const ContentProductDetail = { props: ['product', 'ownership', 'networkUnavailable'], setup: (props) => () => h('div', { 'data-test': 'historical-proof', 'data-owned': String(props.product.owned), 'data-ownership': String(!!props.ownership), 'data-network-unavailable': String(props.networkUnavailable) }, props.product.title) }
    const ContentPurchaseDialog = { render: () => null }
    const contentStoreErrorPresentation = (error) => ({ title: error.code, detail: error.detail, recovery: 'Refresh the Store.' })
    const useContentStore = () => globalThis.__contentStoreDetailStore
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
      catalogFreshness: ref('fresh'), lastVerifiedAt: ref('2026-08-14T10:00:00Z'), loading: ref(false), error: ref(null),
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
      catalogFreshness: ref('unavailable'), lastVerifiedAt: ref(null), loading: ref(false),
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
      catalogFreshness: ref('cached'), loading: ref(false), error: ref({ code: 'CONTENT_STORE_UNAVAILABLE', detail: 'GenStudio is offline.' }),
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

  test('moves successful purchase completion to an extant Owned tab, not the removed quote trigger', async () => {
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
      catalogFreshness: ref('fresh'), lastVerifiedAt: ref('2026-08-14T10:00:00Z'), loading: ref(false), error: ref(null),
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
    assert.equal(document.activeElement?.id, 'content-store-tab-owned')
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
    assert.match(detail, /versionFromSignedSummary/)
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
