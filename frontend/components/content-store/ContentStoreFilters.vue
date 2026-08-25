<template>
  <form class="store-filters" aria-label="Filter Content Store catalog" @submit.prevent>
    <label>
      <span>Search</span>
      <input :value="query" type="search" placeholder="Search titles, promises, and tags" @input="$emit('update:query', ($event.target as HTMLInputElement).value)" />
    </label>
    <label>
      <span>Price</span>
      <select :value="price" @change="$emit('update:price', ($event.target as HTMLSelectElement).value as PriceFilter)">
        <option value="all">All prices</option><option value="free">Free</option><option value="paid">Credits</option>
      </select>
    </label>
    <label>
      <span>Type</span>
      <select :value="kind" @change="$emit('update:kind', ($event.target as HTMLSelectElement).value as ContentStoreKindFilter)">
        <option value="all">All types</option>
        <option v-for="option in kinds" :key="option.id" :value="option.id">{{ option.label }}</option>
      </select>
    </label>
    <label v-if="tags.length">
      <span>Tag</span>
      <select :value="tag" @change="$emit('update:tag', ($event.target as HTMLSelectElement).value)">
        <option value="">All tags</option><option v-for="item in tags" :key="item" :value="item">{{ item }}</option>
      </select>
    </label>
    <label class="compatible-filter"><input :checked="compatibleOnly" type="checkbox" @change="$emit('update:compatibleOnly', ($event.target as HTMLInputElement).checked)" /><span>Compatible with this app</span></label>
  </form>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ContentStoreProduct, ContentStoreProductKind } from '~/composables/useContentStore'
import type { ContentStoreKindFilter } from '~/content-store/catalog-presentation'

export type PriceFilter = 'all' | 'free' | 'paid'
const props = defineProps<{ products: readonly ContentStoreProduct[]; query: string; price: PriceFilter; kind: ContentStoreKindFilter; tag: string; compatibleOnly: boolean }>()
defineEmits<{ 'update:query': [value: string]; 'update:price': [value: PriceFilter]; 'update:kind': [value: ContentStoreKindFilter]; 'update:tag': [value: string]; 'update:compatibleOnly': [value: boolean] }>()
const labels: Record<ContentStoreProductKind, string> = { series_formula: 'Series Formula', topic_pack: 'Topic Pack', visual_style: 'Visual Style', thumbnail_recipe: 'Thumbnail Recipe', font_pack: 'Font Pack', niche_bundle: 'Channel Kit' }
const kinds = computed(() => [...new Set(props.products.map(product => product.kind))].map(id => ({ id, label: labels[id] })))
const tags = computed(() => [...new Set(props.products.flatMap(product => product.presentation.tags))].sort((a, b) => a.localeCompare(b)))
</script>

<style scoped>
.store-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
label { display: grid; min-width: 124px; gap: 5px; color: var(--text-secondary); font-size: var(--font-xs); font-weight: 650; }
label:first-child { flex: 1 1 240px; }
input[type='search'], select { width: 100%; min-height: var(--control-height-sm); padding: 6px 9px; border: 1px solid var(--border-light); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font: inherit; }
.compatible-filter { display: inline-flex; grid-template-columns: auto 1fr; align-items: center; min-height: var(--control-height-sm); gap: 7px; padding: 0 2px; }
.compatible-filter input { width: 16px; height: 16px; accent-color: var(--accent); }
@media (max-width: 560px) { .store-filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } label, label:first-child { min-width: 0; } input[type='search'], select, .compatible-filter { min-height: 44px; } .compatible-filter { grid-column: 1 / -1; padding: 0 8px; } .compatible-filter input { width: 22px; height: 22px; } }
</style>
