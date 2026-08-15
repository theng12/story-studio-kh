<template>
  <div class="product-cover" :data-has-cover="Boolean(product.presentation.cover)">
    <img v-if="product.presentation.cover" :src="product.presentation.cover.src" :alt="coverAlt" />
    <div v-else class="product-cover-fallback" aria-hidden="true">
      <span>{{ product.title.slice(0, 1) }}</span>
    </div>
    <div class="product-cover-meta">
      <span class="product-kind">{{ kindLabel }}</span>
      <span class="product-price">{{ product.free ? 'Free' : `${formatCredits(product.creditPrice)} credits` }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { contentStoreKindLabel } from '~/content-store/catalog-presentation'
import type { ContentStoreProduct } from '~/composables/useContentStore'

const props = defineProps<{ product: ContentStoreProduct }>()

const coverAlt = computed(() => props.product.presentation.cover?.alt || '')
const kindLabel = computed(() => contentStoreKindLabel(props.product.kind))

function formatCredits(value: number): string {
  return value.toLocaleString()
}
</script>

<style scoped>
.product-cover { position: relative; min-height: 168px; overflow: hidden; border-radius: var(--radius-lg); background: var(--surface-accent); }
.product-cover img { display: block; width: 100%; height: 100%; min-height: 168px; object-fit: cover; }
.product-cover-fallback { display: grid; min-height: 168px; place-items: center; background: color-mix(in srgb, var(--accent-dim) 68%, var(--bg-tertiary)); color: var(--accent); font-size: clamp(48px, 8vw, 84px); font-weight: 750; letter-spacing: -.04em; }
.product-cover-meta { position: absolute; right: 10px; bottom: 10px; left: 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-primary); font-size: var(--font-xs); font-weight: 700; }
.product-kind, .product-price { padding: 5px 8px; border-radius: 999px; background: color-mix(in srgb, var(--bg-primary) 84%, transparent); backdrop-filter: blur(8px); }
.product-price { color: var(--accent); font-variant-numeric: tabular-nums; }
</style>
