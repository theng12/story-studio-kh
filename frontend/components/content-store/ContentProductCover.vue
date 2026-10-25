<template>
  <div class="product-cover" :data-has-cover="Boolean(product.presentation.cover)">
    <img v-if="product.presentation.cover" :src="product.presentation.cover.src" :alt="coverAlt" />
    <div v-else class="product-cover-fallback" aria-hidden="true">
      <span>{{ product.title.slice(0, 1) }}</span>
    </div>
    <div class="product-cover-meta">
      <span class="product-kind">{{ kindLabel }}</span>
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
</script>

<style scoped>
/*
 * One aspect ratio for every cover, whatever the artwork is.
 *
 * `min-height` alone let this box be stretched by its parent, so a 16:9 cover,
 * a square cover and the letter fallback all came out different heights — and
 * because the kind row is positioned against the bottom of this box, that
 * row then landed at a different height on every card. A fixed ratio makes the
 * badges line up because the thing they hang off lines up. `object-fit: cover`
 * crops the artwork rather than letterboxing it, and `flex: none` keeps the box
 * off the flex-shrink path in the card's column.
 */
.product-cover { position: relative; flex: none; aspect-ratio: 16 / 10; overflow: hidden; border-radius: var(--radius-lg); background: var(--surface-accent); }
.product-cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
.product-cover-fallback { display: grid; height: 100%; place-items: center; background: color-mix(in srgb, var(--accent-dim) 68%, var(--bg-tertiary)); color: var(--accent); font-size: clamp(48px, 8vw, 84px); font-weight: 750; letter-spacing: -.04em; }
.product-cover-meta { position: absolute; right: 10px; bottom: 10px; left: 10px; display: flex; align-items: center; gap: 8px; color: var(--text-primary); font-size: var(--font-xs); font-weight: 700; }
/* The pill stays one line high. "Thumbnail Recipe" is the one kind label long
   enough to wrap at card width, and a wrapped pill is 19px taller than the
   others — which is the second reason this row sat at different heights from
   card to card. It ellipsises if it has to. */
.product-kind { min-width: 0; overflow: hidden; text-overflow: ellipsis; padding: 5px 8px; border-radius: 999px; background: color-mix(in srgb, var(--bg-primary) 84%, transparent); backdrop-filter: blur(8px); white-space: nowrap; color: var(--accent); }
</style>
