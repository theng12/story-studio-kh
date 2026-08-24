<template>
  <section class="content-library" :aria-labelledby="headingId">
    <header>
      <div><h2 :id="headingId">{{ title }}</h2><p v-if="description" class="library-description">{{ description }}</p></div>
      <span>{{ ownershipResolved ? `${products.length} ${products.length === 1 ? 'pack' : 'packs'}` : 'Not checked yet' }}</span>
    </header>

    <!-- Sixty-five packs need sorting and a way to act on the whole set. Both
         controls are hidden until GenStudio has answered, because both are
         about facts it has not supplied yet. -->
    <div v-if="ownershipResolved && products.length" class="library-controls">
      <div class="library-filter" role="group" :aria-label="`Filter ${title} by install state`">
        <button
          v-for="option in installFilters" :key="option.id" type="button"
          :class="['filter-chip', { active: installFilter === option.id }]"
          :aria-pressed="installFilter === option.id"
          @click="installFilter = option.id"
        >{{ option.label }}<span>{{ countFor(option.id) }}</span></button>
      </div>
      <button
        v-if="showInstallAll && missingReleaseIds.length" type="button" class="btn btn-primary install-all"
        :disabled="networkUnavailable"
        @click="$emit('install-many', missingReleaseIds)"
      >Install all missing ({{ missingReleaseIds.length }})</button>
    </div>

    <div v-if="!ownershipResolved" class="library-empty" role="status" aria-live="polite"><h3>Not checked yet</h3><p>Story Studio is asking GenStudio what this account owns and what is installed on this Mac. This list appears as soon as it answers.</p></div>
    <template v-else-if="visibleGroups.length">
      <section v-for="group in visibleGroups" :key="group.kind" class="library-group" :aria-label="group.label">
        <h3 class="group-heading">{{ group.label }}<span>{{ group.products.length }}</span></h3>
        <div class="library-grid">
          <ContentProductCard
            v-for="product in group.products"
            :key="product.productId"
            :product="product"
            :ownership="ownershipFor(product.entitlementFamily)"
            :busy="busyProductId === product.productId || busyReleaseId === product.currentRelease?.releaseId"
            :queue-status="queueStatusFor(product)"
            :selected="selectedProductIds.includes(product.productId)"
            :selectable="selectable"
            :network-unavailable="networkUnavailable"
            :ownership-resolved="ownershipResolved"
            @quote="$emit('quote', $event)"
            @install="$emit('install', $event)"
            @toggle-select="$emit('toggle-select', $event)"
          />
        </div>
      </section>
    </template>
    <div v-else-if="products.length" class="library-empty" role="status">
      <h3>Nothing here matches that filter</h3>
      <p>{{ installFilter === 'installed' ? 'None of these packs is installed on this Mac yet.' : 'Every one of these packs is already installed on this Mac.' }}</p>
      <button type="button" class="btn btn-secondary" @click="installFilter = 'all'">Show all {{ products.length }}</button>
    </div>
    <div v-else class="library-empty" role="status"><h3>{{ emptyTitle }}</h3><p>{{ emptyDescription }}</p></div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ContentProductCard from './ContentProductCard.vue'
import {
  filterByInstallState, groupProductsByKind, missingInstallReleaseIds,
  type InstallStateFilter, type OwnershipLookup,
} from '~/content-store/library-organisation'
import type { ContentStoreAccount, ContentStoreProduct } from '~/composables/useContentStore'
import type { InstallQueueStatus } from '~/composables/useInstallQueue'

const props = withDefaults(defineProps<{
  headingId: string
  title: string
  description?: string
  products: readonly ContentStoreProduct[]
  account: ContentStoreAccount | null
  emptyTitle: string
  emptyDescription: string
  busyProductId: string
  busyReleaseId: string
  networkUnavailable?: boolean
  ownershipResolved?: boolean
  showInstallAll?: boolean
  selectable?: boolean
  selectedProductIds?: readonly string[]
  queueStatus?: (releaseId: string) => InstallQueueStatus
}>(), { ownershipResolved: true, showInstallAll: false, selectable: false, selectedProductIds: () => [] })

defineEmits<{
  quote: [product: ContentStoreProduct]
  install: [releaseId: string]
  'install-many': [releaseIds: string[]]
  'toggle-select': [product: ContentStoreProduct]
}>()

const installFilter = ref<InstallStateFilter>('all')
const installFilters: Array<{ id: InstallStateFilter; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'not_installed', label: 'Not installed' }, { id: 'installed', label: 'Installed' },
]

function ownershipFor(entitlementFamily: string) {
  return props.account?.owned.find(item => item.entitlementFamily === entitlementFamily) || null
}
const lookup: OwnershipLookup = product => {
  const row = ownershipFor(product.entitlementFamily)
  return row ? { installState: row.installState, currentReleaseId: row.currentRelease?.releaseId ?? null } : null
}
const filtered = computed(() => filterByInstallState(props.products, lookup, installFilter.value))
const visibleGroups = computed(() => groupProductsByKind(filtered.value))
const missingReleaseIds = computed(() => missingInstallReleaseIds(props.products, lookup))
function countFor(filter: InstallStateFilter): number { return filterByInstallState(props.products, lookup, filter).length }
function queueStatusFor(product: ContentStoreProduct): InstallQueueStatus {
  const releaseId = product.currentRelease?.releaseId
  return releaseId && props.queueStatus ? props.queueStatus(releaseId) : 'idle'
}
</script>

<style scoped>
.content-library { display: grid; gap: 14px; }
header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
h2 { font-size: var(--font-2xl); letter-spacing: -.025em; }
header > span { flex: 0 0 auto; color: var(--text-muted); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }
.library-description, .library-empty p { color: var(--text-secondary); line-height: 1.5; }
.library-description { margin-top: 4px; }
.library-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.library-filter { display: flex; flex-wrap: wrap; gap: 6px; }
.filter-chip { display: inline-flex; min-height: var(--control-height-sm); align-items: center; gap: 6px; padding: 6px 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer; font: inherit; font-size: var(--font-sm); font-weight: 650; }
.filter-chip:hover { border-color: var(--border-light); color: var(--text-primary); }
.filter-chip.active { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: var(--accent-dim); color: var(--accent); }
.filter-chip span { color: var(--text-muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
.filter-chip.active span { color: inherit; }
.filter-chip:focus-visible, .install-all:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.library-group { display: grid; gap: 10px; }
.group-heading { display: flex; align-items: baseline; gap: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border); color: var(--text-secondary); font-size: var(--font-xs); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.group-heading span { color: var(--text-muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; letter-spacing: 0; }
.library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 248px), 1fr)); gap: 16px; }
.library-empty { display: grid; justify-items: start; gap: 7px; padding: 26px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.library-empty h3 { font-size: var(--font-xl); letter-spacing: -.02em; }
@media (max-width: 560px) { header { align-items: stretch; flex-direction: column; } .filter-chip, .install-all { min-height: 44px; } }
</style>
