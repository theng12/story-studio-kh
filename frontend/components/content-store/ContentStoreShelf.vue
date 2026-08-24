<template>
  <section class="content-store-shelf" :aria-labelledby="`shelf-${shelf.id}`">
    <header><h2 :id="`shelf-${shelf.id}`">{{ shelf.title }}</h2><span>{{ products.length }} {{ products.length === 1 ? 'product' : 'products' }}</span></header>
    <div class="shelf-grid">
      <ContentProductCard v-for="product in products" :key="product.productId" :product="product" :ownership="ownershipFor(product.entitlementFamily)" :busy="busyProductId === product.productId || busyReleaseId === product.currentRelease?.releaseId" :network-unavailable="networkUnavailable" :ownership-resolved="ownershipResolved" :selectable="selectable" :selected="selectedProductIds.includes(product.productId)" @quote="$emit('quote', $event)" @install="$emit('install', $event)" @toggle-select="$emit('toggle-select', $event)" />
    </div>
  </section>
</template>

<script setup lang="ts">
import ContentProductCard from './ContentProductCard.vue'
import type { ContentStoreAccount, ContentStoreProduct, ContentStoreShelf } from '~/composables/useContentStore'

const props = withDefaults(
  defineProps<{ shelf: ContentStoreShelf; products: readonly ContentStoreProduct[]; account: ContentStoreAccount | null; busyProductId: string; busyReleaseId: string; networkUnavailable?: boolean; ownershipResolved?: boolean; selectable?: boolean; selectedProductIds?: readonly string[] }>(),
  { ownershipResolved: true, selectable: false, selectedProductIds: () => [] },
)
defineEmits<{ quote: [product: ContentStoreProduct]; install: [releaseId: string]; 'toggle-select': [product: ContentStoreProduct] }>()
function ownershipFor(entitlementFamily: string) { return props.account?.owned.find(item => item.entitlementFamily === entitlementFamily) || null }
</script>

<style scoped>
.content-store-shelf { display: grid; gap: 14px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
h2 { font-size: var(--font-2xl); letter-spacing: -.025em; }
header span { color: var(--text-muted); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }
.shelf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 248px), 1fr)); gap: 16px; }
</style>
