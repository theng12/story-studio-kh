<template>
  <div class="library-detail-page">
    <PlainBackLink label="Back to Studio Library" fallback="/library" />
    <div v-if="(!hasResolvedStore || loading) && !product" class="store-state" aria-live="polite"><LoadingSpinner size="sm" /><p>Loading product proof…</p></div>
    <div v-else-if="product" class="detail-content"><section v-if="catalogFreshness === 'restored'" class="cached-status" role="status" aria-live="polite"><strong>Showing the published proof saved on this Mac</strong><p>Checking with the Gateway now. Availability and install state are not known yet, so installing stays off until they are.</p><p v-if="productLoadError">{{ productLoadError.title }}: {{ productLoadError.detail }} {{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" :disabled="loading" @click="retryStore">Retry Studio Library</button></section><section v-else-if="catalogFreshness === 'cached'" class="cached-status" role="status" aria-live="polite"><strong>Showing historical product proof</strong><p>Last checked with the Gateway at {{ cachedProof?.origin }} on {{ formatVerifiedAt(cachedProof?.verifiedAt) }}. Availability and install state cannot be treated as current while offline.</p><p v-if="productLoadError">{{ productLoadError.title }}: {{ productLoadError.detail }} {{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" :disabled="loading" @click="retryStore">Retry Studio Library</button></section><section v-if="installedPack || removalEntry" class="local-pack" role="status" aria-live="polite"><strong>{{ installedPack ? 'Installed on this Mac' : 'Removed from this Mac' }}</strong><p v-if="installedPack">{{ packLabel }}</p><p v-if="installedPack">{{ usageLabel }}</p><p v-if="removalNote">{{ removalNote }}</p><p v-else-if="!installedPack">Story Studio moved this pack into its Trash. Nothing is deleted, and it can be put back here.</p><p v-if="removalDetail" class="removal-detail">{{ removalDetail }}</p><button type="button" class="btn btn-secondary" :disabled="removalBusy !== ''" @click="toggleInstalled">{{ removalBusy ? (installedPack ? 'Removing…' : 'Restoring…') : (installedPack ? 'Remove from this Mac' : 'Put it back') }}</button></section><ContentProductDetail :product="proofProduct" :ownership="ownership" :queue-status="installQueue.statusOf(releaseId)" :network-unavailable="catalogFreshness !== 'fresh' || !hasResolvedStore" :ownership-resolved="ownershipResolved" @install="installRelease" /><p v-if="installQueueNote" class="cached-status" role="status" aria-live="polite">{{ installQueueNote }}</p></div>
    <section v-else-if="productLoadError" class="store-state" role="status" aria-live="polite"><h1>{{ productLoadError.title }}</h1><p>{{ productLoadError.detail }}</p><p>{{ productLoadError.recovery }}</p><button type="button" class="btn btn-secondary" @click="retryStore">Retry Studio Library</button><PlainBackLink label="Back to Studio Library" fallback="/library" /></section>
    <section v-else class="store-state" role="status"><h1>Unknown Studio Library product</h1><p>This product is not available in the catalog the Gateway publishes.</p><NuxtLink to="/library" class="btn btn-primary">Return to Studio Library</NuxtLink></section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ContentProductDetail from '~/components/content-store/ContentProductDetail.vue'
import { splitPackUsage } from '~/content-store/library-organisation'
import { contentStoreErrorPresentation } from '~/composables/useContentStore'
import { useContentInstallQueue } from '~/composables/useContentInstallQueue'

useAppTitle('Studio Library product')
const route = useRoute(); const store = useContentStore(); const { account, products, installed, cachedProof, catalogFreshness, ownershipResolved, removals, loading, error } = store
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

/**
 * Remove / put back this one pack.
 *
 * Both are local: they need no Gateway answer, they never delete anything, and
 * a refusal names the channels that still use the pack.
 */
const installedPack = computed(() => installed.value.find(pack => pack.productId === productId.value && pack.active) ?? null)
const removalEntry = computed(() => {
  const packId = product.value?.currentRelease?.packId
  const entry = packId ? removals.value?.packs[packId] : undefined
  return entry && entry.outcome === 'removed' && !entry.restored_at ? entry : null
})
const packLabel = computed(() => installedPack.value ? `${installedPack.value.packId} · ${installedPack.value.version}` : '')
const usageLabel = computed(() => {
  if (!installedPack.value) return ''
  if (!removals.value) return 'Checking which channels use it…'
  const { channels, unchecked } = splitPackUsage(removals.value.channels[installedPack.value.packId] ?? [])
  const parts: string[] = []
  if (channels.length) parts.push(`Used by ${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}: ${channels.join(', ')}.`)
  if (unchecked.length) parts.push(`Could not check ${unchecked.join(', ')} — that is not the same as unused.`)
  return parts.length ? parts.join(' ') : 'Not used by any channel.'
})
const removalNote = computed(() => {
  const entry = installedPack.value ? removals.value?.packs[installedPack.value.packId] : undefined
  if (!entry || entry.restored_at || entry.outcome === 'removed') return ''
  if (entry.outcome === 'kept_in_use') {
    const { channels, unchecked } = splitPackUsage(entry.channels)
    if (channels.length) {
      return `The Gateway stopped offering this pack, but ${channels.length === 1 ? 'a channel still uses' : 'channels still use'} it: ${channels.join(', ')}, so it stays installed.`
    }
    return `The Gateway stopped offering this pack, but Story Studio could not check ${unchecked.join(', ')}, so it stays installed.`
  }
  return 'The Gateway stopped offering this pack, but Story Studio could not remove it.'
})
const removalBusy = ref('')
const removalDetail = ref('')
async function toggleInstalled(): Promise<void> {
  const packId = installedPack.value?.packId ?? product.value?.currentRelease?.packId
  if (!packId || removalBusy.value) return
  removalBusy.value = packId
  removalDetail.value = ''
  try {
    if (installedPack.value) await store.removePack(packId)
    else await store.restorePack(packId)
  } catch (cause: any) {
    const data = cause?.data || cause?.response?._data || {}
    const channels: string[] = Array.isArray(data.channels) ? data.channels : []
    removalDetail.value = data.code === 'CONTENT_PACK_IN_USE'
      ? `Not removed. Still needed by${channels.length ? `: ${channels.join(', ')}` : ' a channel'}. Change that selection first.`
      : (typeof data.detail === 'string' && data.detail) || cause?.message || 'This pack could not be changed on this Mac.'
  } finally {
    removalBusy.value = ''
  }
}
// Escape / ⌘[ leave this page through PlainBackLink, which yields to an open dialog.
onMounted(() => {
  void loadStore()
  void store.refreshRemovals().catch(() => { /* the page says it could not read them */ })
})
</script>

<style scoped>
.library-detail-page { width: min(1120px, calc(100% - 36px)); margin: 0 auto; padding: 30px 0 64px; }.store-state { display: grid; justify-items: start; gap: 10px; padding: 28px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.store-state h1 { font-size: var(--font-2xl); }.store-state p, .cached-status { color: var(--text-secondary); }.detail-content { display: grid; min-width: 0; gap: 12px; }.cached-status { display: grid; gap: 6px; padding: 12px; border-radius: var(--radius-md); background: var(--bg-secondary); line-height: 1.5; overflow-wrap: anywhere; }
.local-pack { display: grid; gap: 6px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); color: var(--text-secondary); line-height: 1.5; overflow-wrap: anywhere; }
.local-pack strong { color: var(--text-primary); }
.local-pack .btn { width: fit-content; min-height: var(--control-height-sm); }
.removal-detail { color: var(--warning); } @media (max-width: 420px) { .library-detail-page { width: min(100% - 24px, 1120px); padding-top: 20px; } } @media (prefers-reduced-motion: reduce) { .cached-status { transition: none; } }
</style>
