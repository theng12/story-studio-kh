<template>
  <span v-if="cost && (cost.url || cost.variants?.length)" class="price-details">
    <a v-if="cost.url" :href="cost.url" target="_blank" rel="noopener noreferrer">pricing page</a>
    <span v-if="cost.variants?.length" class="price-variants">Varies:
      <span v-for="line in cost.variants" :key="line">{{ line }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import type { CreditDisplay } from '../utils/genstudio-credit-cost.js'

defineProps<{ cost: CreditDisplay | null | undefined }>()
</script>

<style scoped>
.price-details { margin-left: 6px; font-size: var(--font-xs); }
.price-details a { color: var(--accent); }
.price-variants > span::before { content: ' · '; }
.price-variants > span:first-of-type::before { content: ' '; }
</style>
