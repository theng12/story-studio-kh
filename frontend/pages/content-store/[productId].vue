<template>
  <div class="content-store-detail-page">
    <NuxtLink to="/content-store" class="back-link">Back to Content Store</NuxtLink>
    <div v-if="!hasResolvedStore || loading" class="store-state" aria-live="polite"><LoadingSpinner size="sm" /><p>Loading product proof…</p></div>
    <section v-else-if="productLoadError" class="store-state" role="status" aria-live="polite"><h1>{{ productLoadError.title }}</h1><p>{{ productLoadError.detail }}</p><p>{{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" @click="retryStore">Retry Content Store</button><NuxtLink to="/content-store" class="back-link">Back to Content Store</NuxtLink></section>
    <div v-else-if="product" class="detail-content"><p v-if="catalogFreshness === 'cached'" class="cached-status" role="status" aria-live="polite">Showing the last verified product proof. GenStudio is unavailable, so purchase and install actions are disabled.</p><ContentProductDetail :product="product" :ownership="ownership" :busy="quoteBusy || installBusy" :network-unavailable="catalogFreshness !== 'fresh'" @quote="openQuote" @install="installRelease" /></div>
    <section v-else class="store-state" role="status"><h1>Unknown Content Store product</h1><p>This product is not available in the catalog published for this account.</p><NuxtLink to="/content-store" class="btn btn-primary">Return to Content Store</NuxtLink></section>
    <ContentPurchaseDialog :visible="dialogOpen" :attempt="selectedAttempt" :product="product" :error="dialogError" :busy="purchaseBusy" @close="closeDialog" @confirm="confirmPurchase" @retry="confirmPurchase" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ContentProductDetail from '~/components/content-store/ContentProductDetail.vue'
import ContentPurchaseDialog from '~/components/content-store/ContentPurchaseDialog.vue'
import { contentStoreErrorPresentation, type ContentStoreProduct, type ContentStoreUiError } from '~/composables/useContentStore'

useAppTitle('Content Store product')
const route = useRoute(); const store = useContentStore(); const { account, products, attempts, catalogFreshness, loading, error } = store
const productId = computed(() => typeof route.params.productId === 'string' ? route.params.productId : '')
const product = computed(() => products.value.find(item => item.productId === productId.value) || null)
const ownership = computed(() => product.value ? account.value?.owned.find(item => item.entitlementFamily === product.value?.entitlementFamily) || null : null)
const hasResolvedStore = ref(false)
const productLoadError = computed(() => {
  if (!hasResolvedStore.value || !error.value) return null
  return contentStoreErrorPresentation(error.value)
})
const quoteBusy = ref(false); const installBusy = ref(false); const purchaseBusy = ref(false); const dialogOpen = ref(false); const selectedQuoteId = ref(''); const dialogError = ref<ContentStoreUiError | null>(null)
const selectedAttempt = computed(() => attempts.value.find(item => item.quote_id === selectedQuoteId.value) || null)
async function loadStore() { try { await store.refresh() } catch { /* the exact Store error boundary remains rendered in this route */ } finally { hasResolvedStore.value = true } }
function retryStore() { if (loading.value) return; hasResolvedStore.value = false; void loadStore() }
async function openQuote(item: ContentStoreProduct) { if (catalogFreshness.value !== 'fresh' || quoteBusy.value) return; quoteBusy.value = true; dialogError.value = null; try { const attempt = await store.requestQuote(item.productId, item.currentRelease?.releaseId ?? null); selectedQuoteId.value = attempt.quote_id; dialogOpen.value = true } catch { /* quote errors remain at the established commerce boundary */ } finally { quoteBusy.value = false } }
async function installRelease(releaseId: string) { if (catalogFreshness.value !== 'fresh' || installBusy.value) return; installBusy.value = true; try { await store.installRelease(releaseId) } catch { /* error stays in the Store state */ } finally { installBusy.value = false } }
async function confirmPurchase(quoteId: string) { if (catalogFreshness.value !== 'fresh' || purchaseBusy.value) return; purchaseBusy.value = true; dialogError.value = null; try { await store.confirmPurchase(quoteId) } catch { dialogError.value = error.value } finally { purchaseBusy.value = false } }
function closeDialog() { if (purchaseBusy.value) return; dialogOpen.value = false; selectedQuoteId.value = ''; dialogError.value = null }
function leaveProofOnEscape(event: KeyboardEvent) { if (event.key === 'Escape' && !dialogOpen.value) void navigateTo('/content-store') }
onMounted(() => { window.addEventListener('keydown', leaveProofOnEscape); void loadStore() })
onBeforeUnmount(() => window.removeEventListener('keydown', leaveProofOnEscape))
</script>

<style scoped>
.content-store-detail-page { width: min(1120px, calc(100% - 36px)); margin: 0 auto; padding: 30px 0 64px; }.back-link { display: inline-block; margin-bottom: 16px; color: var(--text-secondary); font-size: var(--font-sm); text-decoration: underline; text-underline-offset: 4px; }.store-state { display: grid; justify-items: start; gap: 10px; padding: 28px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-state h1 { font-size: var(--font-2xl); }.store-state p, .cached-status { color: var(--text-secondary); }.detail-content { display: grid; min-width: 0; gap: 12px; }.cached-status { padding: 12px; border-radius: var(--radius-md); background: var(--bg-secondary); line-height: 1.5; } @media (max-width: 420px) { .content-store-detail-page { width: min(100% - 24px, 1120px); padding-top: 20px; } } @media (prefers-reduced-motion: reduce) { .cached-status { transition: none; } }
</style>
