<template>
  <div class="content-store-page">
    <header class="store-header">
      <div>
        <NuxtLink to="/" class="back-link">Back to channels</NuxtLink>
        <h1>Content Store</h1>
        <p>Expand Story Studio with permanently owned packs, priced and delivered by GenStudio.</p>
      </div>
      <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadStore">
        {{ loading ? 'Refreshing…' : 'Refresh store' }}
      </button>
    </header>

    <section v-if="account" class="account-strip" aria-label="Content Store account balances">
      <div>
        <span>Content account</span>
        <strong>{{ account.contentAccountId }}</strong>
      </div>
      <dl>
        <div><dt>Spendable on content</dt><dd>{{ formatCredits(account.contentSpendableCredits) }} credits</dd></div>
        <div><dt>Total available</dt><dd>{{ formatCredits(account.availableCredits) }} credits</dd></div>
      </dl>
    </section>

    <div v-if="pageError" :class="['store-notice', pageError.tone]" role="status">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 17h.01M12 3l9 17H3z" /></svg>
      <div>
        <strong>{{ pageError.title }}</strong>
        <p>{{ pageError.detail }}</p>
        <button v-if="pageError.showSettings" type="button" class="notice-action" @click="appSettingsModal.open()">
          Open Settings and test scopes
        </button>
      </div>
    </div>

    <nav class="store-tabs" role="tablist" aria-label="Content Store views" @keydown="moveTab">
      <button
        v-for="tab in tabs"
        :id="`content-store-tab-${tab.id}`"
        :key="tab.id"
        :ref="element => setTabRef(tab.id, element)"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :aria-controls="`content-store-panel-${tab.id}`"
        :tabindex="activeTab === tab.id ? 0 : -1"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <span>{{ tab.id === 'discover' ? discoverProducts.length : ownedProducts.length }}</span>
      </button>
    </nav>

    <main
      :id="`content-store-panel-${activeTab}`"
      class="store-content"
      role="tabpanel"
      :aria-labelledby="`content-store-tab-${activeTab}`"
    >
      <div v-if="loading && !account" class="store-state" aria-live="polite">
        <LoadingSpinner size="sm" />
        <p>Loading the GenStudio catalog…</p>
      </div>

      <div v-else-if="!error && products.length === 0" class="store-state">
        <svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M9 15h30v23H9zM15 9h18v6H15zM17 23h14M17 29h9" /></svg>
        <h2>The Content Store is ready, but no packs have been published yet.</h2>
        <p>Refresh later to see the catalog GenStudio publishes for this account.</p>
      </div>

      <div v-else-if="activeTab === 'owned' && ownedProducts.length === 0" class="store-state">
        <h2>No permanently owned packs yet</h2>
        <p>Choose Discover to request an exact quote from GenStudio.</p>
      </div>

      <div v-else class="product-list">
        <ContentProductCard
          v-for="product in visibleProducts"
          :key="product.productId"
          :product="product"
          :busy="quoteBusyProduct === product.productId"
          @quote="openQuote"
        />
      </div>

      <section v-if="completedAttempts.length" class="ownership-history" aria-labelledby="ownership-heading">
        <h2 id="ownership-heading">Recent permanent ownership</h2>
        <ul>
          <li v-for="attempt in completedAttempts" :key="attempt.quote_id">
            <span>{{ productTitle(attempt.product_id) }}</span>
            <span>Owned in GenStudio · not installed on this Mac</span>
            <span>{{ formatCredits(attempt.credits_charged ?? 0) }} credits charged</span>
          </li>
        </ul>
        <p>Receipt cached · verification arrives with Phase 2</p>
      </section>
    </main>

    <ContentPurchaseDialog
      :visible="dialogOpen"
      :attempt="selectedAttempt"
      :product="selectedProduct"
      :error="dialogError"
      :busy="purchaseBusy"
      @close="closeDialog"
      @confirm="confirmPurchase"
      @retry="confirmPurchase"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, type ComponentPublicInstance } from 'vue'
import ContentProductCard from '~/components/content-store/ContentProductCard.vue'
import ContentPurchaseDialog from '~/components/content-store/ContentPurchaseDialog.vue'
import type {
  ContentStoreProduct,
  ContentStoreUiError,
  PublicContentPurchaseAttempt,
} from '~/composables/useContentStore'

useAppTitle('Content Store')

type StoreTab = 'discover' | 'owned'
const tabs: Array<{ id: StoreTab; label: string }> = [
  { id: 'discover', label: 'Discover' },
  { id: 'owned', label: 'Owned' },
]

const store = useContentStore()
const appSettingsModal = useAppSettingsModal()
const { account, products, attempts, loading, error } = store
const activeTab = ref<StoreTab>('discover')
const quoteBusyProduct = ref('')
const purchaseBusy = ref(false)
const dialogOpen = ref(false)
const selectedQuoteId = ref('')
const selectedProductId = ref('')
const dialogError = ref<ContentStoreUiError | null>(null)
const tabRefs = new Map<StoreTab, HTMLButtonElement>()

const discoverProducts = computed(() => products.value.filter(product => !product.owned && !product.retired))
const ownedProducts = computed(() => products.value.filter(product => product.owned))
const visibleProducts = computed(() => activeTab.value === 'discover' ? discoverProducts.value : ownedProducts.value)
const selectedAttempt = computed(() => attempts.value.find(row => row.quote_id === selectedQuoteId.value) || null)
const selectedProduct = computed(() => products.value.find(row => row.productId === selectedProductId.value) || null)
const completedAttempts = computed(() => attempts.value.filter(row => row.status === 'completed'))

const pageError = computed(() => {
  if (!error.value || dialogOpen.value) return null
  if (error.value.code === 'signing_unavailable') {
    return {
      tone: 'neutral', title: 'The Content Store is not open yet',
      detail: 'GenStudio cannot sign quotes right now. Nothing was purchased.', showSettings: false,
    }
  }
  if (error.value.status === 401 || error.value.code === 'CONTENT_STORE_SCOPE_REQUIRED') {
    return {
      tone: 'warning', title: 'The active key needs Content Store access',
      detail: error.value.detail, showSettings: true,
    }
  }
  return { tone: 'warning', title: 'The Content Store is unavailable', detail: error.value.detail, showSettings: false }
})

async function loadStore(): Promise<void> {
  try { await store.refresh() } catch { /* state renders the exact boundary */ }
}

async function openQuote(product: ContentStoreProduct): Promise<void> {
  if (quoteBusyProduct.value) return
  quoteBusyProduct.value = product.productId
  dialogError.value = null
  try {
    const attempt = await store.requestQuote(product.productId, product.currentRelease?.releaseId ?? null)
    selectedQuoteId.value = attempt.quote_id
    selectedProductId.value = product.productId
    dialogOpen.value = true
  } catch { /* a failed quote never opens the purchase dialog */ }
  finally { quoteBusyProduct.value = '' }
}

async function confirmPurchase(quoteId: string): Promise<void> {
  if (purchaseBusy.value) return
  purchaseBusy.value = true
  dialogError.value = null
  try {
    await store.confirmPurchase(quoteId)
  } catch {
    dialogError.value = error.value
  } finally {
    purchaseBusy.value = false
  }
}

function closeDialog(): void {
  if (purchaseBusy.value) return
  dialogOpen.value = false
  selectedQuoteId.value = ''
  selectedProductId.value = ''
  dialogError.value = null
}

function setTabRef(id: StoreTab, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLButtonElement) tabRefs.set(id, element)
  else tabRefs.delete(id)
}

function moveTab(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = tabs.findIndex(tab => tab.id === activeTab.value)
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  const target = tabs[next]
  if (!target) return
  activeTab.value = target.id
  tabRefs.get(target.id)?.focus()
}

function productTitle(productId: string): string {
  return products.value.find(product => product.productId === productId)?.title || productId
}

function formatCredits(value: number): string {
  return value.toLocaleString()
}

onMounted(() => { void loadStore() })
</script>

<style scoped>
.content-store-page { width: min(1180px, calc(100% - 36px)); margin: 0 auto; padding: 30px 0 64px; color: var(--text-primary); }
.store-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.back-link { display: inline-block; margin-bottom: 8px; color: var(--text-secondary); font-size: var(--font-sm); text-decoration: underline; text-underline-offset: 4px; }
.store-header h1 { font-size: clamp(32px, 4vw, 48px); letter-spacing: -.035em; line-height: 1.05; }
.store-header p { max-width: 690px; margin-top: 10px; color: var(--text-secondary); font-size: var(--font-lg); line-height: 1.55; }
.account-strip { display: grid; grid-template-columns: minmax(180px, 1fr) auto; align-items: center; gap: 24px; margin-top: 24px; padding: 15px 18px; border-radius: var(--radius-lg); background: var(--bg-secondary); }
.account-strip > div { min-width: 0; }
.account-strip span,
.account-strip dt { display: block; color: var(--text-muted); font-size: var(--font-xs); }
.account-strip strong { display: block; overflow: hidden; color: var(--text-secondary); font-size: var(--font-sm); text-overflow: ellipsis; white-space: nowrap; }
.account-strip dl { display: flex; gap: 30px; }
.account-strip dd { font-weight: 750; font-variant-numeric: tabular-nums; }
.store-notice { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; margin-top: 18px; padding: 14px 16px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--warning); }
.store-notice.neutral { background: var(--bg-secondary); color: var(--text-secondary); }
.store-notice svg { width: 22px; height: 22px; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.store-notice strong { display: block; color: var(--text-primary); }
.store-notice p { color: var(--text-secondary); }
.notice-action { display: inline-block; margin-top: 4px; padding: 0; border: 0; background: transparent; color: var(--accent); font: 650 var(--font-sm)/1.4 inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.notice-action:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.store-tabs { display: flex; gap: 4px; margin-top: 26px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.store-tabs button { display: inline-flex; min-height: 40px; align-items: center; gap: 8px; padding: 8px 14px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text-secondary); font: 650 var(--font-md)/1 inherit; cursor: pointer; }
.store-tabs button:hover { background: var(--bg-hover); color: var(--text-primary); }
.store-tabs button[aria-selected='true'] { background: var(--accent-dim); color: var(--text-primary); }
.store-tabs button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.store-tabs span { min-width: 22px; padding: 3px 6px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-xs); text-align: center; }
.store-content { min-width: 0; margin-top: 18px; }
.product-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.store-state { display: flex; min-height: 300px; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 30px; border-radius: var(--radius-lg); background: var(--bg-secondary); text-align: center; }
.store-state svg { width: 48px; height: 48px; margin-bottom: 5px; stroke: var(--accent); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.store-state h2 { max-width: 620px; font-size: var(--font-2xl); }
.store-state p { max-width: 560px; color: var(--text-secondary); }
.ownership-history { margin-top: 26px; padding-top: 20px; border-top: 1px solid var(--border); }
.ownership-history h2 { font-size: var(--font-lg); }
.ownership-history ul { display: grid; gap: 7px; margin-top: 10px; padding: 0; list-style: none; }
.ownership-history li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(230px, auto) auto; gap: 16px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--bg-secondary); font-size: var(--font-sm); }
.ownership-history li span { min-width: 0; overflow-wrap: anywhere; }
.ownership-history li span:nth-child(2) { color: var(--success); }
.ownership-history li span:last-child { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.ownership-history > p { margin-top: 8px; color: var(--text-muted); font-size: var(--font-xs); }
@media (max-width: 760px) {
  .content-store-page { width: min(100% - 24px, 1180px); padding-top: 22px; }
  .store-header { align-items: stretch; flex-direction: column; }
  .store-header .btn { align-self: flex-start; }
  .account-strip { grid-template-columns: 1fr; gap: 12px; }
  .account-strip dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .account-strip dd { overflow-wrap: anywhere; }
  .product-list { grid-template-columns: 1fr; }
  .ownership-history li { grid-template-columns: 1fr; gap: 2px; }
}
@media (max-width: 420px) {
  .store-header .btn { width: 100%; justify-content: center; }
  .account-strip dl { grid-template-columns: 1fr; }
  .store-tabs button { flex: 1; justify-content: center; }
}
</style>
