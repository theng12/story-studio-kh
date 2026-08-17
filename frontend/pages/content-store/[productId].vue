<template>
  <div class="content-store-detail-page">
    <NuxtLink to="/content-store" class="back-link">Back to Content Store</NuxtLink>
    <div v-if="(!hasResolvedStore || loading) && !product" class="store-state" aria-live="polite"><LoadingSpinner size="sm" /><p>Loading product proof…</p></div>
    <div v-else-if="product" class="detail-content"><section v-if="catalogFreshness === 'restored'" class="cached-status" role="status" aria-live="polite"><strong>Showing the published proof saved on this Mac</strong><p>Checking with GenStudio now. Ownership, install state and your credit balance are not known yet, so buying and installing stay off until they are.</p><p v-if="productLoadError">{{ productLoadError.title }}: {{ productLoadError.detail }} {{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" :disabled="loading" @click="retryStore">Retry Content Store</button></section><section v-else-if="catalogFreshness === 'cached'" class="cached-status" role="status" aria-live="polite"><strong>Showing historical product proof</strong><p>Last verified for GenStudio account {{ cachedProof?.accountId }} at {{ cachedProof?.origin }} on {{ formatVerifiedAt(cachedProof?.verifiedAt) }}. Account, ownership, balance, purchase, and install state cannot be treated as current while offline.</p><p v-if="productLoadError">{{ productLoadError.title }}: {{ productLoadError.detail }} {{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" :disabled="loading" @click="retryStore">Retry Content Store</button></section><ContentProductDetail :product="proofProduct" :ownership="ownership" :attempt="productAttempt" :busy="quoteBusy || installBusy" :network-unavailable="catalogFreshness !== 'fresh' || !hasResolvedStore" :ownership-resolved="ownershipResolved" @quote="openQuote" @install="installRelease" /></div>
    <section v-else-if="productLoadError" class="store-state" role="status" aria-live="polite"><h1>{{ productLoadError.title }}</h1><p>{{ productLoadError.detail }}</p><p>{{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" @click="retryStore">Retry Content Store</button><NuxtLink to="/content-store" class="back-link">Back to Content Store</NuxtLink></section>
    <section v-else class="store-state" role="status"><h1>Unknown Content Store product</h1><p>This product is not available in the catalog published for this account.</p><NuxtLink to="/content-store" class="btn btn-primary">Return to Content Store</NuxtLink></section>
    <ContentPurchaseDialog :visible="dialogOpen" :attempt="selectedAttempt" :product="product" :error="dialogError" :busy="purchaseBusy" @close="closeDialog" @confirm="confirmPurchase" @retry="confirmPurchase" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ContentProductDetail from '~/components/content-store/ContentProductDetail.vue'
import ContentPurchaseDialog from '~/components/content-store/ContentPurchaseDialog.vue'
import { contentStoreErrorPresentation, type ContentStoreProduct, type ContentStoreUiError } from '~/composables/useContentStore'

useAppTitle('Content Store product')
const route = useRoute(); const store = useContentStore(); const { account, products, attempts, cachedProof, catalogFreshness, ownershipResolved, loading, error } = store
const productId = computed(() => typeof route.params.productId === 'string' ? route.params.productId : '')
const product = computed(() => products.value.find(item => item.productId === productId.value) || null)
const proofProduct = computed(() => product.value && catalogFreshness.value === 'cached' ? { ...product.value, owned: false } : product.value)
const ownership = computed(() => catalogFreshness.value === 'fresh' && product.value ? account.value?.owned.find(item => item.entitlementFamily === product.value?.entitlementFamily) || null : null)
const productAttempt = computed(() => product.value ? attempts.value.find(item => item.product_id === product.value?.productId) || null : null)
const hasResolvedStore = ref(false)
const productLoadError = computed(() => {
  if (!hasResolvedStore.value || !error.value) return null
  return contentStoreErrorPresentation(error.value)
})
const quoteBusy = ref(false); const installBusy = ref(false); const purchaseBusy = ref(false); const dialogOpen = ref(false); const selectedQuoteId = ref(''); const dialogError = ref<ContentStoreUiError | null>(null)
const selectedAttempt = computed(() => attempts.value.find(item => item.quote_id === selectedQuoteId.value) || null)
async function loadStore() { try { await store.refresh() } catch { /* the exact Store error boundary remains rendered in this route */ } finally { hasResolvedStore.value = true } }
function retryStore() { if (loading.value) return; hasResolvedStore.value = false; void loadStore() }
async function openQuote(item: ContentStoreProduct) { if (!hasResolvedStore.value || catalogFreshness.value !== 'fresh' || quoteBusy.value) return; quoteBusy.value = true; dialogError.value = null; try { const attempt = await store.requestQuote(item.productId, item.currentRelease?.releaseId ?? null); selectedQuoteId.value = attempt.quote_id; dialogOpen.value = true } catch { /* quote errors remain at the established commerce boundary */ } finally { quoteBusy.value = false } }
async function installRelease(releaseId: string) { if (!hasResolvedStore.value || catalogFreshness.value !== 'fresh' || installBusy.value) return; installBusy.value = true; try { await store.installRelease(releaseId) } catch { /* error stays in the Store state */ } finally { installBusy.value = false } }
async function confirmPurchase(quoteId: string) { if (!hasResolvedStore.value || catalogFreshness.value !== 'fresh' || purchaseBusy.value) return; purchaseBusy.value = true; dialogError.value = null; try { await store.confirmPurchase(quoteId) } catch { dialogError.value = error.value } finally { purchaseBusy.value = false } }
async function closeDialog() { if (purchaseBusy.value) return; const completed = selectedAttempt.value?.status === 'completed'; dialogOpen.value = false; selectedQuoteId.value = ''; dialogError.value = null; if (completed) { await nextTick(); (document.querySelector('.content-store-detail-page .back-link') as HTMLElement | null)?.focus() } }
function leaveProofOnEscape(event: KeyboardEvent) { if (event.key === 'Escape' && !dialogOpen.value) void navigateTo('/content-store') }
function formatVerifiedAt(value: string | undefined): string { if (!value) return 'an earlier session'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString() }
onMounted(() => { window.addEventListener('keydown', leaveProofOnEscape); void loadStore() })
onBeforeUnmount(() => window.removeEventListener('keydown', leaveProofOnEscape))
</script>

<style scoped>
.content-store-detail-page { width: min(1120px, calc(100% - 36px)); margin: 0 auto; padding: 30px 0 64px; }.back-link { display: inline-flex; align-items: center; min-height: 44px; margin-bottom: 16px; color: var(--text-secondary); font-size: var(--font-sm); text-decoration: underline; text-underline-offset: 4px; }.store-state { display: grid; justify-items: start; gap: 10px; padding: 28px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-state h1 { font-size: var(--font-2xl); }.store-state p, .cached-status { color: var(--text-secondary); }.detail-content { display: grid; min-width: 0; gap: 12px; }.cached-status { display: grid; gap: 6px; padding: 12px; border-radius: var(--radius-md); background: var(--bg-secondary); line-height: 1.5; overflow-wrap: anywhere; } @media (max-width: 420px) { .content-store-detail-page { width: min(100% - 24px, 1120px); padding-top: 20px; } } @media (prefers-reduced-motion: reduce) { .cached-status { transition: none; } }
</style>
