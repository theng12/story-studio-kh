<template>
  <div class="library-detail-page">
    <PlainBackLink label="Back to Studio Library" fallback="/library" />
    <div v-if="(!hasResolvedStore || loading) && !product" class="store-state" aria-live="polite"><LoadingSpinner size="sm" /><p>Loading product proof…</p></div>
    <div v-else-if="product" class="detail-content"><section v-if="catalogFreshness === 'restored'" class="cached-status" role="status" aria-live="polite"><strong>Showing the published proof saved on this Mac</strong><p>Checking with the Gateway now. Ownership and install state are not known yet, so installing stays off until they are.</p><p v-if="productLoadError">{{ productLoadError.title }}: {{ productLoadError.detail }} {{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" :disabled="loading" @click="retryStore">Retry Studio Library</button></section><section v-else-if="catalogFreshness === 'cached'" class="cached-status" role="status" aria-live="polite"><strong>Showing historical product proof</strong><p>Last verified for Gateway account {{ cachedProof?.accountId }} at {{ cachedProof?.origin }} on {{ formatVerifiedAt(cachedProof?.verifiedAt) }}. Account, ownership and install state cannot be treated as current while offline.</p><p v-if="productLoadError">{{ productLoadError.title }}: {{ productLoadError.detail }} {{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" :disabled="loading" @click="retryStore">Retry Studio Library</button></section><ContentProductDetail :product="proofProduct" :ownership="ownership" :queue-status="installQueue.statusOf(releaseId)" :network-unavailable="catalogFreshness !== 'fresh' || !hasResolvedStore" :ownership-resolved="ownershipResolved" @install="installRelease" /><p v-if="installQueueNote" class="cached-status" role="status" aria-live="polite">{{ installQueueNote }}</p></div>
    <section v-else-if="productLoadError" class="store-state" role="status" aria-live="polite"><h1>{{ productLoadError.title }}</h1><p>{{ productLoadError.detail }}</p><p>{{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" @click="retryStore">Retry Studio Library</button><PlainBackLink label="Back to Studio Library" fallback="/library" /></section>
    <section v-else class="store-state" role="status"><h1>Unknown Studio Library product</h1><p>This product is not available in the catalog published for this account.</p><NuxtLink to="/library" class="btn btn-primary">Return to Studio Library</NuxtLink></section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ContentProductDetail from '~/components/content-store/ContentProductDetail.vue'
import { contentStoreErrorPresentation } from '~/composables/useContentStore'
import { useContentInstallQueue } from '~/composables/useContentInstallQueue'

useAppTitle('Studio Library product')
const route = useRoute(); const store = useContentStore(); const { account, products, cachedProof, catalogFreshness, ownershipResolved, loading, error } = store
const productId = computed(() => typeof route.params.productId === 'string' ? route.params.productId : '')
const product = computed(() => products.value.find(item => item.productId === productId.value) || null)
const proofProduct = computed(() => product.value && catalogFreshness.value === 'cached' ? { ...product.value, owned: false } : product.value)
const ownership = computed(() => catalogFreshness.value === 'fresh' && product.value ? account.value?.owned.find(item => item.entitlementFamily === product.value?.entitlementFamily) || null : null)
const hasResolvedStore = ref(false)
const productLoadError = computed(() => {
  if (!hasResolvedStore.value || !error.value) return null
  return contentStoreErrorPresentation(error.value)
})
// Installs go through the one app-wide queue: a pack the Library page is already
// installing must not be installed a second time from here, and this page's
// state survives leaving it. Same coordination lock, one worker.
const installQueue = useContentInstallQueue()
const releaseId = computed(() => product.value?.currentRelease?.releaseId ?? '')
const installBusy = computed(() => !!releaseId.value && installQueue.isBusy(releaseId.value))
const installQueueNote = computed(() => {
  if (!releaseId.value) return ''
  const status = installQueue.statusOf(releaseId.value)
  if (status === 'queued') return 'Queued to install. You can leave this page; installs continue in the background.'
  if (status === 'installing') return 'Installing now. You can leave this page; installs continue in the background.'
  if (status === 'failed') return `Install failed: ${installQueue.failureOf(releaseId.value)}`
  if (status === 'installed') return 'Installed just now. Refreshing the Studio Library state.'
  return ''
})
async function loadStore() { try { await store.refresh() } catch { /* the exact Library error boundary remains rendered in this route */ } finally { hasResolvedStore.value = true } }
function retryStore() { if (loading.value) return; hasResolvedStore.value = false; void loadStore() }
function installRelease(id: string) { if (!hasResolvedStore.value || catalogFreshness.value !== 'fresh' || installBusy.value) return; installQueue.enqueue(id) }
function formatVerifiedAt(value: string | undefined): string { if (!value) return 'an earlier session'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString() }
// Escape / ⌘[ leave this page through PlainBackLink, which yields to an open dialog.
onMounted(() => { void loadStore() })
</script>

<style scoped>
.library-detail-page { width: min(1120px, calc(100% - 36px)); margin: 0 auto; padding: 30px 0 64px; }.store-state { display: grid; justify-items: start; gap: 10px; padding: 28px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-state h1 { font-size: var(--font-2xl); }.store-state p, .cached-status { color: var(--text-secondary); }.detail-content { display: grid; min-width: 0; gap: 12px; }.cached-status { display: grid; gap: 6px; padding: 12px; border-radius: var(--radius-md); background: var(--bg-secondary); line-height: 1.5; overflow-wrap: anywhere; } @media (max-width: 420px) { .library-detail-page { width: min(100% - 24px, 1120px); padding-top: 20px; } } @media (prefers-reduced-motion: reduce) { .cached-status { transition: none; } }
</style>
