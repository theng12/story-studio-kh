<template>
  <NuxtPage />
  <div v-if="!viewingDetail" class="library-page">
    <header class="library-header"><div><PlainBackLink label="Back to Channels" fallback="/" /><h1>Studio Library</h1><p>Visual styles, Series Formulas, topic packs and thumbnail recipes in one place. Browse what your Gateway publishes and install it on this Mac, or install a .sspack file already here.</p></div><div class="library-header-actions"><button type="button" class="btn btn-secondary" title="Choose a .sspack file up to 50 MiB" :disabled="importBusy" @click="chooseContentPack">{{ importBusy ? 'Installing…' : 'Install Content Pack' }}</button><input ref="contentPackFileInput" type="file" accept=".sspack" hidden @change="onContentPackPicked" /><button type="button" class="btn btn-secondary" title="Ask the Gateway to confirm again which packs this account owns" :disabled="loading || networkActionsDisabled" @click="checkOwnership">Re-check my packs</button><button type="button" class="btn btn-secondary" :disabled="loading" @click="refreshStore">{{ loading ? 'Refreshing…' : 'Refresh Library' }}</button></div></header>
    <div v-if="recovery" class="store-notice warning" role="status" aria-live="polite"><div><strong>A local Content Pack recovery needs your attention</strong><p>Use Re-check my packs to confirm which packs this account owns, then install them again.</p><p>The unreadable index was reset; pack folders were retained. Reinstall any packs still missing.</p><button type="button" class="notice-action" :disabled="recoveryDismissBusy" @click="dismissRecovery">{{ recoveryDismissBusy ? 'Dismissing…' : 'Dismiss Notice' }}</button></div></div>
    <div v-if="recoveryError" class="store-notice warning" role="status" aria-live="polite"><div><strong>{{ recoveryError.action === 'dismiss' ? 'Content Pack recovery notice was not dismissed' : 'Content Pack recovery could not be checked' }}</strong><p>{{ recoveryError.detail }}</p></div></div>
    <div v-if="importBusy" class="store-notice neutral" role="status" aria-live="polite"><div><strong>Installing Content Pack…</strong><p>Reading the chosen .sspack and installing it on this Mac. This local install needs no Gateway connection.</p></div></div>
    <div v-else-if="importNotice" :class="['store-notice', importNotice.tone]" role="status" aria-live="polite"><div><strong>{{ importNotice.title }}</strong><p>{{ importNotice.detail }}</p><p v-if="importNotice.recovery">{{ importNotice.recovery }}</p></div></div>
    <section class="gateway-archives" aria-labelledby="gateway-archives-heading" :aria-busy="gatewayArchivesBusy">
      <div class="gateway-archives-head"><div><h2 id="gateway-archives-heading">Gateway archives</h2><p>Install the exact .sspack your Gateway keeps in its Archive Bank. Nothing needs to be on a shelf first. Story Studio checks app compatibility, document schemas and the exact SHA-256 during install.</p></div><button type="button" class="btn btn-secondary" :disabled="gatewayArchivesBusy" @click="loadGatewayArchives">{{ gatewayArchivesBusy ? 'Checking…' : 'Refresh archives' }}</button></div>
      <div v-if="gatewayArchivesError" class="store-notice warning" role="status" aria-live="polite"><div><strong>{{ gatewayArchivesError.title }}</strong><p>{{ gatewayArchivesError.detail }}</p><p v-if="gatewayArchivesError.recovery">{{ gatewayArchivesError.recovery }}</p><button type="button" class="notice-action" :disabled="gatewayArchivesBusy" @click="loadGatewayArchives">Retry Gateway archives</button></div></div>
      <div v-if="gatewayArchiveNotice" :class="['store-notice', gatewayArchiveNotice.tone]" role="status" aria-live="polite"><div><strong>{{ gatewayArchiveNotice.title }}</strong><p>{{ gatewayArchiveNotice.detail }}</p><p v-if="gatewayArchiveNotice.recovery">{{ gatewayArchiveNotice.recovery }}</p></div></div>
      <p v-if="!gatewayArchivesLoaded && !gatewayArchivesError" class="gateway-archives-state" role="status" aria-live="polite">Checking the Gateway archive bank…</p>
      <p v-else-if="gatewayArchivesLoaded && gatewayArchives.length === 0" class="gateway-archives-state" role="status">No archives are in the Gateway Archive Bank yet. Add a .sspack in the Gateway, then refresh here.</p>
      <ul v-else-if="gatewayArchives.length" class="gateway-archive-list">
        <li v-for="archive in gatewayArchives" :key="archive.archiveSha256" class="gateway-archive-row">
          <div class="gateway-archive-copy"><strong>{{ gatewayArchiveTitle(archive) }}</strong><span>{{ gatewayArchiveIdentity(archive) }}</span><span>{{ gatewayArchiveMeta(archive) }}</span><span class="gateway-archive-compatibility">{{ gatewayCompatibilityLabel(archive) }}</span></div>
          <button type="button" class="btn btn-secondary" :aria-label="`Install ${gatewayArchiveTitle(archive)}`" :disabled="!!gatewayArchiveBusyDigest" @click="installFromGatewayArchive(archive)">{{ gatewayArchiveBusyDigest === archive.archiveSha256 ? 'Installing…' : 'Install' }}</button>
        </li>
      </ul>
    </section>
    <div v-if="catalogFreshness === 'restored' && !pageError" class="store-notice neutral" role="status" aria-live="polite"><div><strong>Showing the published catalogue saved on this Mac</strong><p>Checking with the Gateway now. Gateway download stays off until it answers. Install Content Pack still works from a local file.</p></div></div>
    <div v-if="catalogFreshness === 'cached'" class="store-notice neutral" role="status" aria-live="polite"><div><strong>Showing the last verified catalog</strong><p>The Gateway is unavailable, so Gateway download is disabled. Install Content Pack still works from a local file. Last verified {{ formatVerifiedAt(lastVerifiedAt) }}.</p></div></div>
    <div v-if="pageError" :class="['store-notice', pageError.tone]" role="status" aria-live="polite"><div><strong>{{ pageError.title }}</strong><p>{{ pageError.detail }}</p><p v-for="entry in otherUnavailable" :key="entry.section">{{ SECTION_LABELS[entry.section] }}: {{ entry.reason }}</p><p v-if="pageError.recovery">{{ pageError.recovery }}</p><button v-if="pageError.showSettings" type="button" class="notice-action" @click="appSettingsModal.open('connections')">Open Connection Settings</button></div></div>
    <nav class="store-tabs" role="tablist" aria-label="Studio Library views" @keydown="moveTab"><button v-for="tab in tabs" :id="`library-tab-${tab.id}`" :key="tab.id" :ref="element => setTabRef(tab.id, element)" type="button" role="tab" :aria-selected="activeTab === tab.id" :aria-controls="`library-panel-${tab.id}`" :tabindex="activeTab === tab.id ? 0 : -1" @click="activeTab = tab.id">{{ tab.label }}<span>{{ tabCountLabel(tab.id) }}</span></button></nav>
    <main :id="`library-panel-${activeTab}`" class="store-content" role="tabpanel" :aria-labelledby="`library-tab-${activeTab}`">
      <div v-if="loading && catalogFreshness === 'unavailable'" class="store-state" aria-live="polite"><LoadingSpinner size="sm" /><p>Loading the Gateway catalog…</p></div>
      <!-- The Installed tab reads this Mac, not the Gateway, so a catalog that
           could not be read never hides what is actually installed here. -->
      <div v-else-if="catalogFreshness === 'unavailable' && activeTab !== 'installed'" class="store-state" role="status" aria-live="polite"><h2>The Studio Library is unavailable</h2><p>{{ pageError?.detail || 'Refresh the Library to try again.' }}</p><p v-if="installed.length">The {{ installed.length }} Content Pack{{ installed.length === 1 ? '' : 's' }} installed on this Mac {{ installed.length === 1 ? 'is' : 'are' }} still listed under Installed.</p><p>Install Content Pack still works from a local file.</p><button type="button" class="btn btn-secondary" @click="refreshStore">Retry Studio Library</button></div>
      <div v-else-if="catalogFreshness === 'fresh' && products.length === 0 && installed.length === 0" class="store-state" role="status"><h2>The Studio Library is ready, but no packs have been published yet.</h2><p>Refresh later to see the catalog the Gateway publishes.</p></div>
      <template v-else-if="activeTab === 'discover'"><ContentStoreFilters :products="tabProducts" :query="query" :kind="kind" :tag="tag" :compatible-only="compatibleOnly" @update:query="query = $event" @update:kind="kind = $event" @update:tag="tag = $event" @update:compatible-only="compatibleOnly = $event" />
      <div v-if="visibleShelves.length" class="shelf-list"><ContentStoreShelf v-for="shelf in visibleShelves" :key="shelf.shelf.id" :shelf="shelf.shelf" :products="shelf.products" :account="account" :busy-product-id="''" :busy-release-id="''" :network-unavailable="networkActionsDisabled" :ownership-resolved="ownershipResolved" :queue-status="installQueue.statusOf" :halt-reason="installQueue.haltReason.value" @install="enqueueInstall" /></div><div v-else class="store-state" role="status">
        <template v-if="discoverEmptyReason === 'filters'"><h2>No published products match these filters</h2><p>Clear a filter or try another catalog search.</p><button type="button" class="btn btn-secondary" @click="clearFilters">Clear Filters</button></template>
        <template v-else-if="discoverEmptyReason === 'all-owned'"><h2>You already own every published pack</h2><p>Every pack the Gateway publishes is already permanently owned. Open Owned to install them on this Mac.</p><button type="button" class="btn btn-secondary" @click="showOwnedTab">Go to Owned</button></template>
        <template v-else-if="discoverEmptyReason === 'nothing-published'"><h2>No packs are published yet</h2><p>The Gateway has not published anything for this account. Refresh the library later to see the catalog it publishes.</p></template>
        <template v-else><h2>No published products are ready to show</h2><p>The Gateway publishes these packs but has not placed any of them on a shelf yet. Refresh the library later, or open Owned for the packs this account already has.</p></template>
      </div></template>
      <ContentLibraryView v-else-if="activeTab === 'owned'" heading-id="owned-library-heading" title="Owned" description="Packs permanently owned by this Gateway, whether or not they are installed on this Mac." :products="ownedProducts" :account="account" empty-title="No permanently owned packs yet" empty-description="Packs the Gateway grants this account appear here." :busy-product-id="''" :busy-release-id="''" :network-unavailable="networkActionsDisabled" :ownership-resolved="ownershipResolved" :show-install-all="true" :queue-status="installQueue.statusOf" :halt-reason="installQueue.haltReason.value" @install="enqueueInstall" @install-many="enqueueInstalls" />
      <ContentInstalledLibraryView v-else-if="activeTab === 'installed'" :installed="installed" :installs-resolved="installsResolved" />
      <ContentLibraryView v-else heading-id="updates-library-heading" title="Updates" description="Installed packs with a newer safe release ready for an explicit update." :products="updateProducts" :account="account" empty-title="No updates available" empty-description="Your installed packs are up to date." :busy-product-id="''" :busy-release-id="''" :network-unavailable="networkActionsDisabled" :ownership-resolved="ownershipResolved" :show-install-all="true" :queue-status="installQueue.statusOf" :halt-reason="installQueue.haltReason.value" @install="enqueueInstall" @install-many="enqueueInstalls" />
    </main>
    <div v-if="installQueue.running.value || installQueue.finished.value" class="install-queue-strip" role="status" aria-live="polite"><span v-if="installQueue.running.value">Installing {{ installQueue.batchDone.value }} of {{ installQueue.batchTotal.value }}<template v-if="installQueue.batchFailed.value"> · {{ installQueue.batchFailed.value }} failed</template><template v-if="installQueue.activeTitle.value"> · now: {{ installQueue.activeTitle.value }}</template>. You can leave this page; installs continue.</span><span v-else>Installs finished — {{ installQueue.batchInstalled.value }} installed<template v-if="installQueue.haltReason.value"> — stopped early. {{ installQueue.haltReason.value }}</template><template v-else-if="installQueue.batchFailed.value">, {{ installQueue.batchFailed.value }} failed. Open the pack and try again.</template></span><button v-if="!installQueue.running.value" type="button" class="notice-action" @click="installQueue.clearFinished()">Dismiss</button><ul v-if="installQueue.failures.value.length && !installQueue.haltReason.value" class="install-failures"><li v-for="failure in installQueue.failures.value" :key="failure.releaseId"><strong>{{ failure.title }}</strong> — {{ failure.detail }}</li></ul></div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, type ComponentPublicInstance } from 'vue'
import ContentStoreFilters from '~/components/content-store/ContentStoreFilters.vue'
import ContentStoreShelf from '~/components/content-store/ContentStoreShelf.vue'
import ContentLibraryView from '~/components/content-store/ContentLibraryView.vue'
import ContentInstalledLibraryView from '~/components/content-store/ContentInstalledLibraryView.vue'
import { filterCatalogProducts, installedPackCount, orderShelfProducts, type ContentStoreKindFilter } from '~/content-store/catalog-presentation'
import { useContentInstallQueue } from '~/composables/useContentInstallQueue'
import { contentStoreErrorPresentation, CONTENT_PACK_IMPORT_MAX_BYTES, contentPackImportErrorPresentation, contentPackImportUiError, gatewayArchiveErrorPresentation, type ContentStoreProduct, type GatewayContentArchive } from '~/composables/useContentStore'

useAppTitle('Studio Library')
type StoreTab = 'discover' | 'owned' | 'installed' | 'updates'
const tabs: Array<{ id: StoreTab; label: string }> = [{ id: 'discover', label: 'Discover' }, { id: 'owned', label: 'Owned' }, { id: 'installed', label: 'Installed' }, { id: 'updates', label: 'Updates' }]
const store = useContentStore(); const appSettingsModal = useAppSettingsModal(); const { account, products, installed, shelves, catalogFreshness, ownershipResolved, accountResolved, installsResolved, lastVerifiedAt, loading, error, recovery, recoveryError } = store
const route = useRoute(); const viewingDetail = computed(() => typeof route.params.productId === 'string' && route.params.productId.length > 0)
const activeTab = ref<StoreTab>('discover'); const query = ref(''); const kind = ref<ContentStoreKindFilter>('all'); const tag = ref(''); const compatibleOnly = ref(false)
const recoveryDismissBusy = ref(false); const tabRefs = new Map<StoreTab, HTMLButtonElement>()
/** Local `.sspack` install is independent of Gateway state, so it has its own busy/notice state. */
const contentPackFileInput = ref<HTMLInputElement | null>(null)
const importBusy = ref(false)
const importNotice = ref<{ tone: 'success' | 'warning'; title: string; detail: string; recovery?: string } | null>(null)
/**
 * The Gateway archive bank is a separate, authenticated shelf read. It has no
 * dependency on a shelf assignment or any account commerce state.
 */
const gatewayArchives = ref<GatewayContentArchive[]>([])
const gatewayArchivesLoaded = ref(false)
const gatewayArchivesBusy = ref(false)
const gatewayArchivesError = ref<{ title: string; detail: string; recovery: string } | null>(null)
const gatewayArchiveBusyDigest = ref('')
const gatewayArchiveNotice = ref<{ tone: 'success' | 'warning'; title: string; detail: string; recovery?: string } | null>(null)
const discoverProducts = computed(() => products.value.filter(product => !product.owned && !product.retired)); const ownedProducts = computed(() => products.value.filter(product => product.owned)); const ownedInstallState = (product: ContentStoreProduct) => account.value?.owned.find(item => item.entitlementFamily === product.entitlementFamily)?.installState; const updateProducts = computed(() => ownedProducts.value.filter(product => product.compatible && product.currentRelease && !account.value?.owned.find(item => item.entitlementFamily === product.entitlementFamily)?.recalledReleaseVersions.includes(product.currentRelease.version) && ownedInstallState(product) === 'update_available')); const tabProducts = computed(() => activeTab.value === 'discover' ? discoverProducts.value : activeTab.value === 'owned' ? ownedProducts.value : updateProducts.value)
const catalogPresentation = computed(() => Object.fromEntries(products.value.map(product => [product.productId, { productId: product.productId, ...product.presentation }])));
const filteredProducts = computed(() => filterCatalogProducts(tabProducts.value, query.value, { kind: kind.value, compatibleOnly: compatibleOnly.value, tag: tag.value || undefined }, catalogPresentation.value))
const visibleShelves = computed(() => { const visibleIds = new Set(filteredProducts.value.map(product => product.productId)); return shelves.value.map(shelf => ({ shelf, products: orderShelfProducts(products.value, shelf).filter(product => visibleIds.has(product.productId)) })).filter(shelf => shelf.products.length) })
const publishedProducts = computed(() => products.value.filter(product => !product.retired))
const filtersActive = computed(() => query.value.trim() !== '' || kind.value !== 'all' || tag.value !== '' || compatibleOnly.value)
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
const networkActionsDisabled = computed(() => catalogFreshness.value !== 'fresh' || !accountResolved.value)
const pageError = computed(() => { if (!error.value) return null; const presentation = contentStoreErrorPresentation(error.value); if (error.value.code === 'release_recalled') return { tone: 'warning', title: 'A Content Pack release was recalled', detail: error.value.recallReason ? `The Gateway stopped serving that exact version. Reason: ${error.value.recallReason}` : 'The Gateway stopped serving that exact version. Ownership remains permanent.', recovery: presentation.recovery, showSettings: false }; return { tone: error.value.code === 'signing_unavailable' ? 'neutral' : 'warning', title: presentation.title, detail: presentation.detail, recovery: presentation.recovery, showSettings: presentation.settingsAction } })
/**
 * Every OTHER part the server could not answer, named. The notice above shows
 * the first one; a partial answer that hides the rest ("the account could not
 * be read" with no word about the catalogue, the shelves or the purchase
 * records) is the silence this whole state exists to remove. Identical reasons
 * are shown once, because four Gateway sections share one cause.
 */
const SECTION_LABELS: Record<'account' | 'catalog' | 'shelves' | 'receipts' | 'commerce', string> = {
  account: 'Your account', catalog: 'The published catalogue', shelves: 'Shelves',
  receipts: 'Recall notices', commerce: 'Purchase records',
}
const otherUnavailable = computed(() => {
  const seen = new Set<string>([pageError.value?.detail ?? ''])
  return store.unavailableSections.value.filter(entry => {
    if (seen.has(entry.reason)) return false
    seen.add(entry.reason)
    return true
  })
})

async function loadStore(options: { background?: boolean } = {}): Promise<void> { void store.refreshRecovery(); try { await store.refresh(options) } catch { /* state renders the exact boundary */ } }
/** Refresh library / Retry: always a visible, cache-bypassing fetch, never the quiet path. */
function refreshStore(): void { void loadStore() }
/**
 * Local file install: independent of Gateway state, so it is not gated on
 * `networkActionsDisabled`.
 */
function chooseContentPack(): void {
  if (importBusy.value) return
  importNotice.value = null
  contentPackFileInput.value?.click()
}
async function onContentPackPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  // Clearing the value lets the same file be chosen again after a failure.
  input.value = ''
  if (!file || importBusy.value) return
  if (file.size === 0) {
    importNotice.value = { tone: 'warning', title: 'This file is empty', detail: 'Choose the .sspack archive you intend to install.' }
    return
  }
  if (file.size > CONTENT_PACK_IMPORT_MAX_BYTES) {
    importNotice.value = {
      tone: 'warning',
      title: 'This archive is larger than the 50 MiB local limit',
      detail: `${file.name || 'The chosen file'} is ${(file.size / (1024 * 1024)).toFixed(1)} MiB. Choose a smaller .sspack archive.`,
    }
    return
  }
  importBusy.value = true
  importNotice.value = null
  try {
    const archive = await file.arrayBuffer()
    const install = await store.importPack(archive)
    importNotice.value = {
      tone: 'success',
      title: 'Content Pack installed',
      detail: `${install.packId} ${install.version} is installed on this Mac and available in the library pickers.`,
    }
  } catch (cause) {
    importNotice.value = { tone: 'warning', ...contentPackImportErrorPresentation(contentPackImportUiError(cause)) }
  } finally {
    importBusy.value = false
  }
}
function gatewayArchiveTitle(archive: GatewayContentArchive): string {
  return archive.title || archive.packId || `Archive ${archive.archiveSha256.slice(0, 12)}…`
}
function gatewayArchiveIdentity(archive: GatewayContentArchive): string {
  const identity = [archive.packId, archive.version].filter(Boolean).join(' ')
  return identity || `SHA-256 ${archive.archiveSha256.slice(0, 16)}…`
}
function gatewayArchiveMeta(archive: GatewayContentArchive): string {
  const size = archive.bytes === null ? 'Size not reported' : formatBytes(archive.bytes)
  const integrity = archive.integrity === 'verified' ? 'Gateway verified'
    : archive.integrity === 'unavailable' ? 'Gateway could not verify this copy'
      : 'Unreadable archive record'
  const kinds = archive.itemKinds.length ? ` · ${archive.itemKinds.join(', ')}` : ''
  return `${size} · ${integrity}${kinds}`
}
function gatewayCompatibilityLabel(archive: GatewayContentArchive): string {
  return archive.minAppVersion
    ? `Compatibility checked during install · requires Story Studio ${archive.minAppVersion} or newer`
    : 'Compatibility and document schemas checked during install'
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const kib = value / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}
async function loadGatewayArchives(): Promise<void> {
  if (gatewayArchivesBusy.value) return
  const listArchives = store.listGatewayArchives
  if (typeof listArchives !== 'function') {
    // An older backend bridge: leave the local install path untouched and do
    // not turn a missing shelf read into a page-level error.
    gatewayArchivesLoaded.value = true
    return
  }
  gatewayArchivesBusy.value = true
  gatewayArchivesError.value = null
  gatewayArchiveNotice.value = null
  try {
    gatewayArchives.value = await listArchives()
    gatewayArchivesLoaded.value = true
  } catch (cause) {
    gatewayArchivesError.value = gatewayArchiveErrorPresentation(
      contentPackImportUiError(cause, 'Story Studio could not read the Gateway archive bank.'),
    )
  } finally {
    gatewayArchivesBusy.value = false
  }
}
async function installFromGatewayArchive(archive: GatewayContentArchive): Promise<void> {
  if (gatewayArchiveBusyDigest.value) return
  gatewayArchiveBusyDigest.value = archive.archiveSha256
  gatewayArchiveNotice.value = null
  try {
    const install = await store.installGatewayArchive(archive.archiveSha256)
    gatewayArchiveNotice.value = {
      tone: 'success',
      title: 'Content Pack installed from the Gateway',
      detail: `${install.packId} ${install.version} is installed on this Mac and available in the library pickers.`,
    }
  } catch (cause) {
    const ui = contentPackImportUiError(cause, 'This Gateway archive could not be installed.')
    const presentation = ui.code.startsWith('CONTENT_PACK_GATEWAY_')
      ? gatewayArchiveErrorPresentation(ui)
      : contentPackImportErrorPresentation(ui)
    gatewayArchiveNotice.value = { tone: 'warning', ...presentation }
  } finally {
    gatewayArchiveBusyDigest.value = ''
  }
}
async function showOwnedTab(): Promise<void> { activeTab.value = 'owned'; await nextTick(); tabRefs.get('owned')?.focus() }
async function checkOwnership(): Promise<void> { if (networkActionsDisabled.value) return; try { await store.restoreOwnership(); activeTab.value = 'owned' } catch { /* exact check boundary is rendered from store.error */ } }
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

function clearFilters(): void { query.value = ''; kind.value = 'all'; tag.value = ''; compatibleOnly.value = false }
// Every tab counts PACKS. Installed counted version records, so it could read
// higher than Owned -- see installedPackCount for why that number was wrong.
function tabProductCount(tab: StoreTab): number { return tab === 'discover' ? discoverProducts.value.length : tab === 'owned' ? ownedProducts.value.length : tab === 'installed' ? installedPackCount(installed.value) : updateProducts.value.length }
/**
 * Discover counts the published catalogue, which is a catalogue fact and true
 * whether or not ownership has been checked. Owned, Installed and Updates each
 * count something only the Gateway can confirm, so before it answers they show
 * an em dash rather than a zero somebody would read as "you own nothing".
 */
function tabCountLabel(tab: StoreTab): string {
  // Installed counts what this Mac itself reports, so it is answered even when
  // the Gateway cannot be asked. The other three need the account.
  if (tab === 'installed') return installsResolved.value ? String(tabProductCount(tab)) : '—'
  return !ownershipResolved.value && tab !== 'discover' ? '—' : String(tabProductCount(tab))
}
function setTabRef(id: StoreTab, element: Element | ComponentPublicInstance | null): void { if (element instanceof HTMLButtonElement) tabRefs.set(id, element); else tabRefs.delete(id) }
function moveTab(event: KeyboardEvent): void { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const current = tabs.findIndex(tab => tab.id === activeTab.value); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; const target = tabs[next]; if (!target) return; activeTab.value = target.id; tabRefs.get(target.id)?.focus() }
function formatVerifiedAt(value: string | null): string { if (!value) return 'before this session'; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return date.toLocaleString() }
// Stale-while-revalidate: a verified catalog already in memory renders at once
// and the revalidation runs unseen. `refresh` decides whether staying quiet is
// honest; a cold start or an expired cache loads visibly instead.
onMounted(() => { void loadStore({ background: true }); void loadGatewayArchives() })
</script>

<style scoped>
.library-page { width: min(1180px, calc(100% - 36px)); margin: 0 auto; padding: 30px 0 64px; color: var(--text-primary); }.library-header { display: flex; align-items: end; justify-content: space-between; gap: 24px; }.library-header h1 { font-size: clamp(32px, 4vw, 48px); letter-spacing: -.04em; line-height: 1.05; }.library-header p { max-width: 660px; margin-top: 10px; color: var(--text-secondary); font-size: var(--font-lg); line-height: 1.55; }.library-header-actions { display: flex; flex: 0 0 auto; gap: 8px; }.store-notice { margin-top: 18px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-notice.warning { border-color: color-mix(in srgb, var(--warning) 38%, var(--border)); }.store-notice.success { border-color: color-mix(in srgb, var(--success) 38%, var(--border)); }.store-notice.success strong { color: var(--success); }.store-notice strong { color: var(--warning); }
/* A `neutral` notice is information, not a problem — "showing the saved
   catalogue" is not a warning. It shares the panel but not the warning colour,
   which `.store-notice strong` would otherwise give every tone. */
.store-notice.neutral strong { color: var(--text-primary); }.store-notice p { margin-top: 3px; color: var(--text-secondary); }.notice-action { margin-top: 8px; border: 0; background: transparent; color: var(--accent); cursor: pointer; font: inherit; font-weight: 650; text-decoration: underline; text-underline-offset: 3px; }
.gateway-archives { display: grid; gap: 12px; margin-top: 18px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.gateway-archives-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.gateway-archives-head h2 { font-size: var(--font-xl); letter-spacing: -.02em; }
.gateway-archives-head p { max-width: 720px; margin-top: 5px; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.5; }
.gateway-archives-head .btn { flex: 0 0 auto; }
.gateway-archives .store-notice { margin-top: 0; }
.gateway-archives-state { color: var(--text-secondary); font-size: var(--font-sm); }
.gateway-archive-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.gateway-archive-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-primary); }
.gateway-archive-row .btn { flex: 0 0 auto; }
.gateway-archive-copy { display: grid; gap: 2px; min-width: 0; }
.gateway-archive-copy strong { overflow-wrap: anywhere; }
.gateway-archive-copy span { color: var(--text-secondary); font-size: var(--font-sm); overflow-wrap: anywhere; }
.gateway-archive-copy .gateway-archive-compatibility { color: var(--text-muted); font-size: var(--font-xs); }
.store-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 24px; padding: 5px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-tabs button { display: inline-flex; min-width: 0; min-height: var(--control-height-sm); align-items: center; gap: 7px; padding: 7px 10px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; font-weight: 650; overflow-wrap: anywhere; }.store-tabs button:focus-visible, .notice-action:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; box-shadow: none; }.store-tabs button[aria-selected='true'] { background: var(--accent-dim); color: var(--text-primary); }.store-tabs span { color: var(--accent); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }.store-content { display: grid; gap: 20px; margin-top: 18px; }.install-failures { grid-column: 1 / -1; display: grid; gap: 4px; margin: 6px 0 0; padding-left: 18px; color: var(--text-secondary); font-size: var(--font-sm); }.shelf-list { display: grid; gap: 28px; }
.install-queue-strip { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 18px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); color: var(--text-secondary); font-size: var(--font-sm); }
.install-queue-strip .notice-action { margin-top: 0; }.store-state { display: grid; justify-items: start; gap: 9px; padding: 26px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-state h2 { font-size: var(--font-2xl); letter-spacing: -.02em; }.store-state p { color: var(--text-secondary); }
@media (max-width: 720px) { .library-header { align-items: stretch; flex-direction: column; }.library-header-actions { flex-wrap: wrap; }.gateway-archives-head { flex-direction: column; }.gateway-archive-row { align-items: stretch; flex-direction: column; } } @media (max-width: 560px) { .store-tabs button, .library-header-actions .btn, .store-state .btn { min-height: 44px; } } @media (max-width: 420px) { .library-page { width: min(100% - 24px, 1180px); padding-top: 20px; }.library-header-actions .btn { flex: 1 1 130px; justify-content: center; }.store-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }.store-tabs button { justify-content: center; } } @media (prefers-reduced-motion: reduce) { .store-tabs button { transition: none; } }
</style>
