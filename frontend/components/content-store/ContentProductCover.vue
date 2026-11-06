<template>
  <div class="product-cover" :data-has-cover="Boolean(product.presentation.cover)" :data-cover-state="coverState">
    <img v-if="product.presentation.cover && !coverBroken" :src="product.presentation.cover.src" :alt="coverAlt" decoding="async" @error="onCoverError" />
    <div v-else-if="coverBroken" class="product-cover-fallback product-cover-error" role="img" :aria-label="coverAlt || 'Preview could not load'">
      <span class="product-cover-error-icon" aria-hidden="true">!</span>
      <span class="product-cover-error-label">Couldn't load preview</span>
    </div>
    <div v-else class="product-cover-fallback" aria-hidden="true">
      <span>{{ product.title.slice(0, 1) }}</span>
    </div>
    <div class="product-cover-meta">
      <span class="product-kind">{{ kindLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { contentStoreKindLabel } from '~/content-store/catalog-presentation'
import type { ContentStoreProduct } from '~/composables/useContentStore'

const props = defineProps<{ product: ContentStoreProduct }>()

const coverAlt = computed(() => props.product.presentation.cover?.alt || '')
const kindLabel = computed(() => contentStoreKindLabel(props.product.kind))

/**
 * Tracks whether the cover image failed to load. Reset when the product or
 * cover URL changes (e.g. after a catalog refresh or a retry).
 */
const coverBroken = ref(false)
watch(
  () => props.product.presentation.cover?.src,
  () => { coverBroken.value = false },
)

const coverState = computed(() => {
  if (!props.product.presentation.cover) return 'none'
  return coverBroken.value ? 'error' : 'loaded'
})

function onCoverError(): void {
  coverBroken.value = true
}
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
/*
 * A cover that FAILED is not the same as a cover that was never published.
 * The empty state shows the pack's initial; the failure state says so in
 * words and carries the reason for a screen reader, so nobody reads a broken
 * picture as an unpublished one. `place-content: center` + a single column
 * stacks the mark over the label inside the same fixed-ratio box.
 */
.product-cover-error { gap: 4px; align-content: center; justify-items: center; background: color-mix(in srgb, var(--warning) 10%, var(--bg-tertiary)); color: var(--warning); }
.product-cover-error-icon { display: grid; place-items: center; width: 34px; height: 34px; border: 2px solid currentColor; border-radius: 50%; font-size: 18px; font-weight: 800; line-height: 1; }
.product-cover-error-label { max-width: 16ch; color: var(--text-secondary); font-size: var(--font-xs); font-weight: 650; line-height: 1.3; text-align: center; }
.product-cover-meta { position: absolute; right: 10px; bottom: 10px; left: 10px; display: flex; align-items: center; gap: 8px; color: var(--text-primary); font-size: var(--font-xs); font-weight: 700; }
/* The pill stays one line high. "Thumbnail Recipe" is the one kind label long
   enough to wrap at card width, and a wrapped pill is 19px taller than the
   others — which is the second reason this row sat at different heights from
   card to card. It ellipsises if it has to. */
.product-kind { min-width: 0; overflow: hidden; text-overflow: ellipsis; padding: 5px 8px; border-radius: 999px; background: color-mix(in srgb, var(--bg-primary) 84%, transparent); backdrop-filter: blur(8px); white-space: nowrap; color: var(--accent); }
</style>
