<template>
  <NuxtPage />
  <div v-if="!viewingDetail" class="content-store-page">
    <header class="store-header"><div><NuxtLink to="/" class="back-link">Back to channels</NuxtLink><h1>Content Store</h1><p>Find published channel building blocks, prove what is included, then own and install them deliberately. Packs are permanently owned by your GenStudio account.</p></div><div class="store-header-actions"><button type="button" class="btn btn-secondary" :disabled="loading || networkActionsDisabled" @click="restoreOwnership">Restore Purchases</button><button type="button" class="btn btn-secondary" :disabled="loading" @click="refreshStore">{{ loading ? 'Refreshing…' : 'Refresh Store' }}</button></div></header>
    <section v-if="account" class="account-strip" aria-label="Content Store account balances"><div><span>Content account</span><strong>{{ account.contentAccountId }}</strong></div><dl><div><dt>Spendable on content</dt><dd>{{ formatCredits(account.contentSpendableCredits) }} credits</dd></div><div><dt>Total available</dt><dd>{{ formatCredits(account.availableCredits) }} credits</dd></div></dl></section>
    <section v-else-if="!ownershipResolved" class="account-strip" aria-label="Content Store account balances"><div><span>Content account</span><strong>Checking with GenStudio…</strong></div><dl><div><dt>Spendable on content</dt><dd>—</dd></div><div><dt>Total available</dt><dd>—</dd></div></dl></section>
    <div v-if="recovery" class="store-notice warning" role="status" aria-live="polite"><div><strong>A local Content Pack recovery needs your attention</strong><p>Use Restore Purchases to reinstall your purchased packs.</p><p>The unreadable index was reset; pack folders were retained. Reinstall any packs still missing.</p><button type="button" class="notice-action" :disabled="recoveryDismissBusy" @click="dismissRecovery">{{ recoveryDismissBusy ? 'Dismissing…' : 'Dismiss Notice' }}</button></div></div>
    <div v-if="recoveryError" class="store-notice warning" role="status" aria-live="polite"><div><strong>{{ recoveryError.action === 'dismiss' ? 'Content Pack recovery notice was not dismissed' : 'Content Pack recovery could not be checked' }}</strong><p>{{ recoveryError.detail }}</p></div></div>
    <div v-if="catalogFreshness === 'restored' && !pageError" class="store-notice neutral" role="status" aria-live="polite"><div><strong>Showing the published catalogue saved on this Mac</strong><p>Checking with GenStudio now. What you own, what is installed here and your credit balance are not known yet, so buying and installing stay off until they are.</p></div></div>
    <div v-if="catalogFreshness === 'cached'" class="store-notice neutral" role="status" aria-live="polite"><div><strong>Showing the last verified catalog</strong><p>GenStudio is unavailable, so purchase and install actions are disabled. Last verified {{ formatVerifiedAt(lastVerifiedAt) }}.</p></div></div>
    <div v-if="pageError" :class="['store-notice', pageError.tone]" role="status" aria-live="polite"><div><strong>{{ pageError.title }}</strong><p>{{ pageError.detail }}</p><p v-if="pageError.recovery">{{ pageError.recovery }}</p><button v-if="pageError.showSettings" type="button" class="notice-action" @click="appSettingsModal.open('connections')">Open Connection Settings</button></div></div>
    <nav class="store-tabs" role="tablist" aria-label="Content Store views" @keydown="moveTab"><button v-for="tab in tabs" :id="`content-store-tab-${tab.id}`" :key="tab.id" :ref="element => setTabRef(tab.id, element)" type="button" role="tab" :aria-selected="activeTab === tab.id" :aria-controls="`content-store-panel-${tab.id}`" :tabindex="activeTab === tab.id ? 0 : -1" @click="activeTab = tab.id">{{ tab.label }}<span>{{ tabCountLabel(tab.id) }}</span></button></nav>
    <main :id="`content-store-panel-${activeTab}`" class="store-content" role="tabpanel" :aria-labelledby="`content-store-tab-${activeTab}`">
      <div v-if="loading && catalogFreshness === 'unavailable'" class="store-state" aria-live="polite"><LoadingSpinner size="sm" /><p>Loading the GenStudio catalog…</p></div>
      <div v-else-if="catalogFreshness === 'unavailable'" class="store-state" role="status" aria-live="polite"><h2>Content Store is unavailable</h2><p>{{ pageError?.detail || 'Refresh the Store to try again.' }}</p><button type="button" class="btn btn-secondary" @click="refreshStore">Retry Content Store</button></div>
      <div v-else-if="catalogFreshness === 'fresh' && products.length === 0 && installed.length === 0" class="store-state" role="status"><h2>The Content Store is ready, but no packs have been published yet.</h2><p>Refresh later to see the catalog GenStudio publishes for this account.</p></div>
      <template v-else-if="activeTab === 'discover'"><ContentStoreFilters :products="tabProducts" :query="query" :price="price" :kind="kind" :tag="tag" :compatible-only="compatibleOnly" @update:query="query = $event" @update:price="price = $event" @update:kind="kind = $event" @update:tag="tag = $event" @update:compatible-only="compatibleOnly = $event" /><div v-if="ownershipResolved && purchasableVisible.length && !allPurchasableSelected" class="selection-tools"><button type="button" class="btn btn-secondary" :disabled="networkActionsDisabled" @click="selectAllPurchasable">Select all {{ purchasableVisible.length }} purchasable</button><span class="hint">Then buy them behind one confirmation.</span></div><div v-if="selectedForPurchase.length" class="selection-bar" role="status" aria-live="polite"><div class="selection-summary"><strong>{{ selectedForPurchase.length }} {{ selectedForPurchase.length === 1 ? 'pack' : 'packs' }} selected</strong><span>{{ selectionTotal === null ? 'Price not published for every pack' : `${formatCredits(selectionTotal)} credits before discount` }}</span></div><div class="selection-actions"><button type="button" class="btn btn-secondary" @click="clearSelection">Clear</button><button type="button" class="btn btn-primary" :disabled="networkActionsDisabled || !!batchQuoteBusy" @click="startBatchPurchase">{{ batchQuoteBusy ? `Quoting ${batchProgressLabel}…` : `See Exact Quotes (${selectedForPurchase.length})` }}</button></div></div>
      <div v-if="visibleShelves.length" class="shelf-list"><ContentStoreShelf v-for="shelf in visibleShelves" :key="shelf.shelf.id" :shelf="shelf.shelf" :products="shelf.products" :account="account" :busy-product-id="quoteBusyProduct" :busy-release-id="''" :network-unavailable="networkActionsDisabled" :ownership-resolved="ownershipResolved" :selectable="true" :selected-product-ids="selectedProductIds" :queue-status="installQueue.statusOf" @quote="openQuote" @install="enqueueInstall" @toggle-select="toggleSelection" /></div><div v-else class="store-state" role="status">
        <template v-if="discoverEmptyReason === 'filters'"><h2>No published products match these filters</h2><p>Clear a filter or try another catalog search.</p><button type="button" class="btn btn-secondary" @click="clearFilters">Clear Filters</button></template>
        <template v-else-if="discoverEmptyReason === 'all-owned'"><h2>You already own every published pack</h2><p>Every pack GenStudio publishes for this account is already permanently owned. Open Owned to install them on this Mac.</p><button type="button" class="btn btn-secondary" @click="showOwnedTab">Go to Owned</button></template>
        <template v-else-if="discoverEmptyReason === 'nothing-published'"><h2>No packs are published yet</h2><p>GenStudio has not published anything for this account to own. Refresh the store later to see the catalog it publishes.</p></template>
        <template v-else><h2>No published products are ready to show</h2><p>GenStudio publishes these packs but has not placed any of them on a shelf yet. Refresh the store later, or open Owned for the packs this account already has.</p></template>
      </div></template>
      <ContentLibraryView v-else-if="activeTab === 'owned'" heading-id="owned-library-heading" title="Owned" description="Packs permanently owned by this GenStudio account, whether or not they are installed on this Mac." :products="ownedProducts" :account="account" empty-title="No permanently owned packs yet" empty-description="Choose Discover to request an exact quote from GenStudio." :busy-product-id="quoteBusyProduct" :busy-release-id="''" :network-unavailable="networkActionsDisabled" :ownership-resolved="ownershipResolved" :show-install-all="true" :queue-status="installQueue.statusOf" @quote="openQuote" @install="enqueueInstall" @install-many="enqueueInstalls" />
      <ContentInstalledLibraryView v-else-if="activeTab === 'installed'" :installed="installed" :ownership-resolved="ownershipResolved" />
      <ContentLibraryView v-else heading-id="updates-library-heading" title="Updates" description="Installed packs with a newer safe release ready for an explicit update." :products="updateProducts" :account="account" empty-title="No updates available" empty-description="Your installed Content Store packs are up to date." :busy-product-id="quoteBusyProduct" :busy-release-id="''" :network-unavailable="networkActionsDisabled" :ownership-resolved="ownershipResolved" :show-install-all="true" :queue-status="installQueue.statusOf" @quote="openQuote" @install="enqueueInstall" @install-many="enqueueInstalls" />
      <section v-if="completedAttempts.length" class="ownership-history" aria-labelledby="ownership-heading"><h2 id="ownership-heading">Recent permanent ownership</h2><ul><li v-for="attempt in completedAttempts" :key="attempt.quote_id"><span>{{ productTitle(attempt.product_id) }}</span><span>Owned in GenStudio · install explicitly from the Owned shelf</span><span>{{ attempt.credits_charged === undefined ? 'Charge not stated by GenStudio' : `${formatCredits(attempt.credits_charged)} credits charged` }}</span></li></ul><p v-if="hasVerifiedOwnership">Ownership receipts are verified locally against GenStudio's published signing key.</p><p v-else>Use Restore purchases to verify this account's ownership receipts on this Mac.</p></section>
    </main>
    <div v-if="installQueue.running.value || installQueue.finished.value" class="install-queue-strip" role="status" aria-live="polite"><span v-if="installQueue.running.value">Installing {{ installQueue.batchDone.value }} of {{ installQueue.batchTotal.value }}<template v-if="installQueue.batchFailed.value"> · {{ installQueue.batchFailed.value }} failed</template><template v-if="installQueue.activeTitle.value"> · now: {{ installQueue.activeTitle.value }}</template>. You can leave this page; installs continue.</span><span v-else>Installs finished — {{ installQueue.batchInstalled.value }} installed<template v-if="installQueue.batchFailed.value">, {{ installQueue.batchFailed.value }} failed. Open the pack and try again.</template></span><button v-if="!installQueue.running.value" type="button" class="notice-action" @click="installQueue.clearFinished()">Dismiss</button><ul v-if="installQueue.failures.value.length" class="install-failures"><li v-for="failure in installQueue.failures.value" :key="failure.releaseId"><strong>{{ failure.title }}</strong> — {{ failure.detail }}</li></ul></div>
    <div v-if="batchInBackground" class="install-queue-strip" role="status" aria-live="polite"><span v-if="batch.busy.value">{{ batch.phase.value === 'quoting' ? 'Quoting' : 'Buying' }} {{ batch.progress.value.done }} of {{ batch.progress.value.total }} in the background.</span><span v-else-if="batchSettledInBackground">Purchase finished — {{ batchBoughtCount }} now owned<template v-if="batchFailedCount">, {{ batchFailedCount }} not bought</template>.</span><span v-else>A purchase review is waiting.</span><button type="button" class="notice-action" @click="batch.show()">Show</button><button v-if="!batch.busy.value" type="button" class="notice-action" @click="closeBatchDialog">Done</button></div>
    <ContentPurchaseDialog :visible="dialogOpen" :attempt="selectedAttempt" :product="selectedProduct" :error="dialogError" :busy="purchaseBusy" @close="closeDialog" @confirm="confirmPurchase" @retry="confirmPurchase" />
    <ContentBatchPurchaseDialog :visible="batch.open.value" :phase="batch.phase.value" :items="batch.items.value" :progress="batch.progress.value" :balance="contentSpendable" :selection-total="selectionTotal" :selected-count="batch.items.value.length" :busy="batch.busy.value" @close="closeBatchDialog" @dismiss="batch.dismiss" @confirm="confirmBatchPurchase" @retry-failed="batch.retryFailed" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, type ComponentPublicInstance } from 'vue'
import ContentStoreFilters, { type PriceFilter } from '~/components/content-store/ContentStoreFilters.vue'
import ContentStoreShelf from '~/components/content-store/ContentStoreShelf.vue'
import ContentLibraryView from '~/components/content-store/ContentLibraryView.vue'
import ContentInstalledLibraryView from '~/components/content-store/ContentInstalledLibraryView.vue'
import ContentPurchaseDialog from '~/components/content-store/ContentPurchaseDialog.vue'
import ContentBatchPurchaseDialog from '~/components/content-store/ContentBatchPurchaseDialog.vue'
import { batchSkipReason, sumPublished, useBatchPurchase } from '~/composables/useBatchPurchase'
import { filterCatalogProducts, installedPackCount, orderShelfProducts, type ContentStoreKindFilter } from '~/content-store/catalog-presentation'
import { useContentInstallQueue } from '~/composables/useContentInstallQueue'
import { contentStoreErrorPresentation, type ContentStoreProduct, type ContentStoreUiError } from '~/composables/useContentStore'

useAppTitle('Content Store')
type StoreTab = 'discover' | 'owned' | 'installed' | 'updates'
const tabs: Array<{ id: StoreTab; label: string }> = [{ id: 'discover', label: 'Discover' }, { id: 'owned', label: 'Owned' }, { id: 'installed', label: 'Installed' }, { id: 'updates', label: 'Updates' }]
const store = useContentStore(); const appSettingsModal = useAppSettingsModal(); const { account, products, installed, shelves, attempts, catalogFreshness, ownershipResolved, lastVerifiedAt, loading, error, recovery, recoveryError } = store
const route = useRoute(); const viewingDetail = computed(() => typeof route.params.productId === 'string' && route.params.productId.length > 0)
const activeTab = ref<StoreTab>('discover'); const query = ref(''); const price = ref<PriceFilter>('all'); const kind = ref<ContentStoreKindFilter>('all'); const tag = ref(''); const compatibleOnly = ref(false)
const quoteBusyProduct = ref(''); const purchaseBusy = ref(false); const dialogOpen = ref(false); const selectedQuoteId = ref(''); const selectedProductId = ref(''); const dialogError = ref<ContentStoreUiError | null>(null); const recoveryDismissBusy = ref(false); const tabRefs = new Map<StoreTab, HTMLButtonElement>()
const discoverProducts = computed(() => products.value.filter(product => !product.owned && !product.retired)); const ownedProducts = computed(() => products.value.filter(product => product.owned)); const ownedInstallState = (product: ContentStoreProduct) => account.value?.owned.find(item => item.entitlementFamily === product.entitlementFamily)?.installState; const updateProducts = computed(() => ownedProducts.value.filter(product => product.compatible && product.currentRelease && !account.value?.owned.find(item => item.entitlementFamily === product.entitlementFamily)?.recalledReleaseVersions.includes(product.currentRelease.version) && ownedInstallState(product) === 'update_available')); const tabProducts = computed(() => activeTab.value === 'discover' ? discoverProducts.value : activeTab.value === 'owned' ? ownedProducts.value : updateProducts.value)
const catalogPresentation = computed(() => Object.fromEntries(products.value.map(product => [product.productId, { productId: product.productId, ...product.presentation }])));
const filteredProducts = computed(() => filterCatalogProducts(tabProducts.value, query.value, { price: price.value, kind: kind.value, compatibleOnly: compatibleOnly.value, tag: tag.value || undefined }, catalogPresentation.value))
const visibleShelves = computed(() => { const visibleIds = new Set(filteredProducts.value.map(product => product.productId)); return shelves.value.map(shelf => ({ shelf, products: orderShelfProducts(products.value, shelf).filter(product => visibleIds.has(product.productId)) })).filter(shelf => shelf.products.length) })
const publishedProducts = computed(() => products.value.filter(product => !product.retired))
const filtersActive = computed(() => query.value.trim() !== '' || price.value !== 'all' || kind.value !== 'all' || tag.value !== '' || compatibleOnly.value)
/**
 * Why Discover has nothing to show. Each branch is a different fact about the
 * catalog and only one of them is the customer's filters — offering to clear
 * filters that were never set is the misleading empty state this replaces.
 * Order matters: an empty Discover tab is explained by ownership before
 * filters, because with nothing left to discover there is no filter worth
 * clearing. A failed load is not an empty state at all; it is handled above by
 * the `unavailable` and `cached` branches.
 */
const discoverEmptyReason = computed<'all-owned' | 'nothing-published' | 'filters' | 'unshelved'>(() => {
  if (discoverProducts.value.length === 0) return publishedProducts.value.length > 0 ? 'all-owned' : 'nothing-published'
  if (filtersActive.value && filteredProducts.value.length === 0) return 'filters'
  return 'unshelved'
})
const selectedAttempt = computed(() => attempts.value.find(row => row.quote_id === selectedQuoteId.value) || null); const selectedProduct = computed(() => products.value.find(row => row.productId === selectedProductId.value) || null); const completedAttempts = computed(() => attempts.value.filter(row => row.status === 'completed')); const hasVerifiedOwnership = computed(() => account.value?.owned.some(row => row.receiptVerification === 'verified') === true)
const networkActionsDisabled = computed(() => catalogFreshness.value !== 'fresh')
const pageError = computed(() => { if (!error.value || dialogOpen.value) return null; const presentation = contentStoreErrorPresentation(error.value); if (error.value.code === 'release_recalled') return { tone: 'warning', title: 'A Content Pack release was recalled', detail: error.value.recallReason ? `GenStudio stopped serving that exact version. Reason: ${error.value.recallReason}` : 'GenStudio stopped serving that exact version. Ownership remains permanent.', recovery: presentation.recovery, showSettings: false }; return { tone: error.value.code === 'signing_unavailable' ? 'neutral' : 'warning', title: presentation.title, detail: presentation.detail, recovery: presentation.recovery, showSettings: presentation.settingsAction } })
async function loadStore(options: { background?: boolean } = {}): Promise<void> { void store.refreshRecovery(); try { await store.refresh(options) } catch { /* state renders the exact boundary */ } }
/** Refresh store / Retry: always a visible, cache-bypassing fetch, never the quiet path. */
function refreshStore(): void { void loadStore() }
async function showOwnedTab(): Promise<void> { activeTab.value = 'owned'; await nextTick(); tabRefs.get('owned')?.focus() }
async function restoreOwnership(): Promise<void> { if (networkActionsDisabled.value) return; try { await store.restoreOwnership(); activeTab.value = 'owned' } catch { /* exact restore boundary is rendered from store.error */ } }
async function dismissRecovery(): Promise<void> { const incidentId = recovery.value?.incidentId; if (!incidentId || recoveryDismissBusy.value) return; recoveryDismissBusy.value = true; try { await store.dismissRecovery(incidentId) } catch { /* recoveryError renders the exact local failure and the notice remains */ } finally { recoveryDismissBusy.value = false } }

/**
 * Installs are queued rather than serialised at the button. Installing writes
 * the Content Pack runtime state under a coordination lock, so one at a time is
 * still correct -- what changes is that the customer no longer waits for one
 * before choosing the next.
 */
// App-wide: installs keep going and keep their counts after this page is left.
const installQueue = useContentInstallQueue()
function enqueueInstall(releaseId: string): void { if (networkActionsDisabled.value) return; installQueue.enqueue(releaseId) }
function enqueueInstalls(releaseIds: string[]): void { if (networkActionsDisabled.value) return; installQueue.enqueueAll(releaseIds) }

// ── Buying several at once ────────────────────────────────────────────────
//
// The orchestration lives in `useBatchPurchase` rather than here: it decides
// what gets charged, and money-handling logic that cannot be unit-tested from
// inside a page's <script setup> is money-handling logic that does not get
// tested. The page keeps only the selection and the wiring.
const selectedProductIds = ref<string[]>([])
const selectedForPurchase = computed(() => discoverProducts.value.filter(product => selectedProductIds.value.includes(product.productId)))
/**
 * The bar's "before discount" figure, and the number the batch dialog explains
 * itself against. `null` when any selected pack carries no published price:
 * counting it as 0 would understate the bar AND make the dialog's reconciliation
 * compare against a total that was never real.
 */
const selectionTotal = computed(() => sumPublished(selectedForPurchase.value, product => product.creditPrice))
/**
 * The published content-spendable balance, or `null` while GenStudio has not
 * stated one. NOT `?? 0`: a zero here would tell him he cannot afford a batch
 * when the truth is that the app does not yet know what he has, and the batch
 * dialog says exactly that instead of refusing him on an invented figure.
 */
const contentSpendable = computed<number | null>(() => account.value?.contentSpendableCredits ?? null)
const batch = useBatchPurchase({
  quote: (productId, releaseId) => store.requestQuote(productId, releaseId),
  // One overview read after the whole batch, not one per pack (each read is
  // several GenStudio round trips).
  confirm: quoteId => store.confirmPurchase(quoteId, { refreshOverview: false }),
  lookup: productId => products.value.find(row => row.productId === productId),
  lastError: () => error.value,
})
const batchQuoteBusy = computed(() => batch.busy.value && batch.phase.value === 'quoting')
const batchProgressLabel = computed(() => batch.progress.value.total ? `${batch.progress.value.done} of ${batch.progress.value.total}` : '')
/** Every visible pack GenStudio would actually sell: not owned, not retired, compatible, with a release. */
const purchasableVisible = computed(() => filteredProducts.value.filter(product => batchSkipReason(product) === null))
const allPurchasableSelected = computed(() => purchasableVisible.value.length > 0 && purchasableVisible.value.every(product => selectedProductIds.value.includes(product.productId)))
function selectAllPurchasable(): void {
  const ids = new Set(selectedProductIds.value)
  for (const product of purchasableVisible.value) ids.add(product.productId)
  selectedProductIds.value = [...ids]
}
function toggleSelection(product: ContentStoreProduct): void {
  selectedProductIds.value = selectedProductIds.value.includes(product.productId)
    ? selectedProductIds.value.filter(id => id !== product.productId)
    : [...selectedProductIds.value, product.productId]
}
function clearSelection(): void { selectedProductIds.value = [] }
function startBatchPurchase(): void {
  if (networkActionsDisabled.value || batch.busy.value) return
  void batch.start([...selectedForPurchase.value])
}
/** A pack that is now owned must not sit selected offering to be bought again. */
async function confirmBatchPurchase(): Promise<void> {
  const bought = await batch.confirmAll()
  if (bought.length) selectedProductIds.value = selectedProductIds.value.filter(id => !bought.includes(id))
  // Ownership is durable server-side; this read shows it on the Owned tab.
  if (bought.length) await loadStore({ background: true })
}
async function closeBatchDialog(): Promise<void> {
  // Still quoting or buying: hide it and keep going. The page strip carries
  // the count and brings it back.
  if (batch.busy.value) { batch.dismiss(); return }
  batch.close()
  await loadStore({ background: true })
}
/** The batch finished while hidden; its result is one click away, or gone. */
const batchInBackground = computed(() => !batch.open.value && batch.items.value.length > 0)
const batchSettledInBackground = computed(() => batchInBackground.value && !batch.busy.value && batch.phase.value === 'result')
const batchBoughtCount = computed(() => batch.items.value.filter(item => item.outcome === 'owned').length)
const batchFailedCount = computed(() => batch.items.value.filter(item => item.outcome === 'failed').length)

// Buying exactly one pack, straight from its card, is unchanged: quote it, show
// that pack's dialog, confirm it. The batch above is the several-at-once path,
// and the two do not share a dialog.
async function openQuote(product: ContentStoreProduct): Promise<void> { if (networkActionsDisabled.value || quoteBusyProduct.value) return; quoteBusyProduct.value = product.productId; dialogError.value = null; try { const attempt = await store.requestQuote(product.productId, product.currentRelease?.releaseId ?? null); selectedQuoteId.value = attempt.quote_id; selectedProductId.value = product.productId; dialogOpen.value = true } catch { /* a failed quote never opens the purchase dialog */ } finally { quoteBusyProduct.value = '' } }
async function confirmPurchase(quoteId: string): Promise<void> { if (networkActionsDisabled.value || purchaseBusy.value) return; purchaseBusy.value = true; dialogError.value = null; try { await store.confirmPurchase(quoteId) } catch { dialogError.value = error.value } finally { purchaseBusy.value = false } }

/**
 * Closing the single-pack dialog leaves the customer exactly where they were.
 *
 * It used to jump to Owned after every purchase -- "when i purchased it, don't
 * let it take me to the install page". Buying six packs meant being thrown out
 * of the grid six times. What a completed purchase does now is clear that
 * product from the selection and stay put. Buying a whole selection is the
 * batch dialog's job and no longer queues more of these.
 */
function closeDialog(): void {
  if (purchaseBusy.value) return
  const completed = selectedAttempt.value?.status === 'completed'
  const purchasedId = selectedProductId.value
  dialogOpen.value = false; selectedQuoteId.value = ''; selectedProductId.value = ''; dialogError.value = null
  if (completed && purchasedId) selectedProductIds.value = selectedProductIds.value.filter(id => id !== purchasedId)
}
function clearFilters(): void { query.value = ''; price.value = 'all'; kind.value = 'all'; tag.value = ''; compatibleOnly.value = false }
// Every tab counts PACKS. Installed counted version records, so it could read
// higher than Owned -- see installedPackCount for why that number was wrong.
function tabProductCount(tab: StoreTab): number { return tab === 'discover' ? discoverProducts.value.length : tab === 'owned' ? ownedProducts.value.length : tab === 'installed' ? installedPackCount(installed.value) : updateProducts.value.length }
/**
 * Discover counts the published catalogue, which is a catalogue fact and true
 * whether or not ownership has been checked. Owned, Installed and Updates each
 * count something only GenStudio can confirm, so before it answers they show
 * an em dash rather than a zero somebody would read as "you own nothing".
 */
function tabCountLabel(tab: StoreTab): string { return !ownershipResolved.value && tab !== 'discover' ? '—' : String(tabProductCount(tab)) }
function setTabRef(id: StoreTab, element: Element | ComponentPublicInstance | null): void { if (element instanceof HTMLButtonElement) tabRefs.set(id, element); else tabRefs.delete(id) }
function moveTab(event: KeyboardEvent): void { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const current = tabs.findIndex(tab => tab.id === activeTab.value); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; const target = tabs[next]; if (!target) return; activeTab.value = target.id; tabRefs.get(target.id)?.focus() }
function productTitle(productId: string): string { return products.value.find(product => product.productId === productId)?.title || productId }
/**
 * A published credits figure, or an em dash. Never a substituted 0, which a
 * customer cannot tell apart from a real zero -- on a receipt it reads as
 * "this was free", and in a total it reads as a smaller bill.
 */
function formatCredits(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—'
}
function formatVerifiedAt(value: string | null): string { if (!value) return 'before this session'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString() }
// Stale-while-revalidate: a verified catalog already in memory renders at once
// and the revalidation runs unseen. `refresh` decides whether staying quiet is
// honest; a cold start or an expired cache loads visibly instead.
onMounted(() => { void loadStore({ background: true }) })
</script>

<style scoped>
.content-store-page { width: min(1180px, calc(100% - 36px)); margin: 0 auto; padding: 30px 0 64px; color: var(--text-primary); }.store-header { display: flex; align-items: end; justify-content: space-between; gap: 24px; }.store-header h1 { font-size: clamp(32px, 4vw, 48px); letter-spacing: -.04em; line-height: 1.05; }.store-header p { max-width: 660px; margin-top: 10px; color: var(--text-secondary); font-size: var(--font-lg); line-height: 1.55; }.store-header-actions { display: flex; flex: 0 0 auto; gap: 8px; }.back-link { display: inline-flex; align-items: center; min-height: 44px; margin-bottom: 8px; color: var(--text-secondary); font-size: var(--font-sm); text-decoration: underline; text-underline-offset: 4px; }
.account-strip { display: grid; grid-template-columns: minmax(180px, 1fr) auto; align-items: center; gap: 24px; margin-top: 24px; padding: 15px 18px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.account-strip span, .account-strip dt { display: block; color: var(--text-muted); font-size: var(--font-xs); }.account-strip strong, .account-strip dd { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }.account-strip dl { display: flex; gap: 20px; }.store-notice { margin-top: 18px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-notice.warning { border-color: color-mix(in srgb, var(--warning) 38%, var(--border)); }.store-notice strong { color: var(--warning); }
/* A `neutral` notice is information, not a problem — "showing the saved
   catalogue" is not a warning. It shares the panel but not the warning colour,
   which `.store-notice strong` would otherwise give every tone. */
.store-notice.neutral strong { color: var(--text-primary); }.store-notice p { margin-top: 3px; color: var(--text-secondary); }.notice-action { margin-top: 8px; border: 0; background: transparent; color: var(--accent); cursor: pointer; font: inherit; font-weight: 650; text-decoration: underline; text-underline-offset: 3px; }
.store-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 24px; padding: 5px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-tabs button { display: inline-flex; min-width: 0; min-height: var(--control-height-sm); align-items: center; gap: 7px; padding: 7px 10px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; font-weight: 650; overflow-wrap: anywhere; }.store-tabs button:focus-visible, .notice-action:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; box-shadow: none; }.store-tabs button[aria-selected='true'] { background: var(--accent-dim); color: var(--text-primary); }.store-tabs span { color: var(--accent); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }.store-content { display: grid; gap: 20px; margin-top: 18px; }.selection-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }.selection-tools .hint { color: var(--text-muted); font-size: var(--font-sm); }.install-failures { grid-column: 1 / -1; display: grid; gap: 4px; margin: 6px 0 0; padding-left: 18px; color: var(--text-secondary); font-size: var(--font-sm); }.shelf-list { display: grid; gap: 28px; }
/* The selection bar and the install-queue strip are panels like `.store-notice`
   and `.account-strip`, and were being rendered with no rule at all: two bare
   inline runs with nothing between them, which is why the count and the credit
   total read as one word. The gap is the separator — nothing here relies on
   whitespace surviving in the markup. */
.selection-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px; border: 1px solid color-mix(in srgb, var(--accent) 48%, var(--border)); border-radius: var(--radius-lg); background: var(--surface-accent); }
.selection-summary { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 10px; min-width: 0; }
.selection-summary strong { font-size: var(--font-md); font-variant-numeric: tabular-nums; }
.selection-summary span { color: var(--text-secondary); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }
.selection-summary span::before { margin-right: 10px; color: var(--text-muted); content: '·'; }
.selection-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 8px; }
.install-queue-strip { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 18px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); color: var(--text-secondary); font-size: var(--font-sm); }
.install-queue-strip .notice-action { margin-top: 0; }.store-state { display: grid; justify-items: start; gap: 9px; padding: 26px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-state h2 { font-size: var(--font-2xl); letter-spacing: -.02em; }.store-state p { color: var(--text-secondary); }.ownership-history { display: grid; gap: 12px; padding-top: 20px; border-top: 1px solid var(--border); }.ownership-history h2 { font-size: var(--font-xl); }.ownership-history ul { display: grid; gap: 8px; padding: 0; list-style: none; }.ownership-history li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) auto; gap: 12px; padding: 10px; border-radius: var(--radius-md); background: var(--bg-secondary); color: var(--text-secondary); font-size: var(--font-sm); }.ownership-history li span:last-child { font-variant-numeric: tabular-nums; text-align: right; }.ownership-history > p { color: var(--text-muted); font-size: var(--font-sm); }
@media (max-width: 720px) { .store-header { align-items: stretch; flex-direction: column; }.store-header-actions { flex-wrap: wrap; }.account-strip { grid-template-columns: 1fr; gap: 12px; }.account-strip dl { flex-wrap: wrap; }.ownership-history li { grid-template-columns: 1fr; gap: 3px; }.ownership-history li span:last-child { text-align: left; } } @media (max-width: 560px) { .store-tabs button, .store-header-actions .btn, .store-state .btn { min-height: 44px; } } @media (max-width: 420px) { .content-store-page { width: min(100% - 24px, 1180px); padding-top: 20px; }.store-header-actions .btn { flex: 1 1 130px; justify-content: center; }.store-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }.store-tabs button { justify-content: center; } } @media (prefers-reduced-motion: reduce) { .store-tabs button { transition: none; } }
</style>
