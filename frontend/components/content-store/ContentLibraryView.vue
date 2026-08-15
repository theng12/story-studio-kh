<template>
  <section class="content-library" :aria-labelledby="headingId">
    <header><h2 :id="headingId">{{ title }}</h2><span>{{ products.length }} {{ products.length === 1 ? 'pack' : 'packs' }}</span></header>
    <p v-if="description" class="library-description">{{ description }}</p>
    <div v-if="products.length" class="library-grid">
      <ContentProductCard
        v-for="product in products"
        :key="product.productId"
        :product="product"
        :ownership="ownershipFor(product.entitlementFamily)"
        :busy="busyProductId === product.productId || busyReleaseId === product.currentRelease?.releaseId"
        :network-unavailable="networkUnavailable"
        @quote="$emit('quote', $event)"
        @install="$emit('install', $event)"
      />
    </div>
    <div v-else class="library-empty" role="status"><h3>{{ emptyTitle }}</h3><p>{{ emptyDescription }}</p></div>
  </section>
</template>

<script setup lang="ts">
import ContentProductCard from './ContentProductCard.vue'
import type { ContentStoreAccount, ContentStoreProduct } from '~/composables/useContentStore'

const props = defineProps<{
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
}>()
defineEmits<{ quote: [product: ContentStoreProduct]; install: [releaseId: string] }>()
function ownershipFor(entitlementFamily: string) { return props.account?.owned.find(item => item.entitlementFamily === entitlementFamily) || null }
</script>

<style scoped>
.content-library { display: grid; gap: 12px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
h2 { font-size: var(--font-2xl); letter-spacing: -.025em; }
header span { color: var(--text-muted); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }
.library-description, .library-empty p { color: var(--text-secondary); line-height: 1.5; }
.library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 248px), 1fr)); gap: 16px; }
.library-empty { display: grid; justify-items: start; gap: 7px; padding: 26px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.library-empty h3 { font-size: var(--font-xl); letter-spacing: -.02em; }
</style>
