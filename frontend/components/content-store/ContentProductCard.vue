<template>
  <article class="content-product-card" :data-owned="product.owned" :data-compatible="product.compatible">
    <div class="product-heading">
      <span class="product-kind-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M4.5 7.5h15v11h-15zM7.5 4.5h9v3h-9z" />
          <path d="M8 11h8M8 14.5h5" />
        </svg>
      </span>
      <div>
        <span class="product-kind">{{ kindLabel }}</span>
        <h2>{{ product.title }}</h2>
      </div>
      <span v-if="product.owned" class="status-tag owned">Owned</span>
      <span v-else-if="product.retired" class="status-tag">Retired</span>
    </div>

    <p class="product-summary">{{ product.summary }}</p>

    <section v-if="showcaseVideos.length" class="showcase-videos" aria-label="Example videos">
      <strong>Watch example videos</strong>
      <ul>
        <li v-for="video in showcaseVideos" :key="video.url">
          <a :href="video.url" target="_blank" rel="noopener noreferrer">{{ video.title }}</a>
          <p v-if="video.description">{{ video.description }}</p>
        </li>
      </ul>
    </section>

    <dl class="product-facts">
      <div><dt>Publisher</dt><dd>{{ product.publisherId }}</dd></div>
      <div><dt>Published price</dt><dd>{{ product.free ? 'Free' : `${formatCredits(product.creditPrice)} credits` }}</dd></div>
      <div><dt>Current release</dt><dd>{{ product.currentRelease?.version || 'Unavailable' }}</dd></div>
    </dl>

    <div v-if="product.bundleComponents.length" class="bundle-summary">
      <strong>{{ product.bundleComponents.length }} included components</strong>
      <ul>
        <li v-for="component in product.bundleComponents" :key="component.productId">
          <span>{{ component.title }}</span>
          <span>{{ component.owned ? 'Already owned' : `${formatCredits(component.componentCreditValue)} credits of value` }}</span>
        </li>
      </ul>
      <p v-if="product.ownedComponentCreditValue > 0">
        Already-owned component discount: {{ formatCredits(product.ownedComponentCreditValue) }} credits.
      </p>
    </div>

    <p v-if="!product.compatible" class="compatibility-message" role="status">
      <strong>Not compatible with this Story Studio version.</strong>
      {{ product.compatibilityReason }}
    </p>

    <div class="product-action">
      <p v-if="product.owned">{{ ownedStatus }}</p>
      <p v-else-if="product.retired">This product is no longer available for new ownership.</p>
      <p v-else-if="product.compatible">GenStudio supplies the exact quote before any purchase.</p>
      <button
        v-if="!product.owned && !product.retired && product.compatible && product.currentRelease"
        type="button"
        class="btn btn-primary"
        :aria-busy="busy ? 'true' : undefined"
        @click="$emit('quote', product)"
      >
        {{ busy ? 'Requesting quote…' : product.free ? 'Get permanently' : 'See exact quote' }}
      </button>
      <button
        v-else-if="product.owned && ownership?.downloadAvailable && ownership.installState !== 'installed_current' && product.currentRelease"
        type="button"
        class="btn btn-primary"
        :disabled="!!busy"
        :aria-busy="busy ? 'true' : undefined"
        @click="$emit('install', product.currentRelease.releaseId)"
      >
        {{ busy ? 'Installing…' : ownership.installState === 'update_available' ? 'Install update' : 'Install on this Mac' }}
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ContentStoreAccount, ContentStoreProduct } from '~/composables/useContentStore'

type OwnedContent = ContentStoreAccount['owned'][number]
const props = defineProps<{ product: ContentStoreProduct; ownership?: OwnedContent | null; busy?: boolean }>()
defineEmits<{ quote: [product: ContentStoreProduct]; install: [releaseId: string] }>()

const kindLabel = computed(() => ({
  series_formula: 'Series Formula',
  topic_pack: 'Topic Pack',
  visual_style: 'Visual Style',
  thumbnail_recipe: 'Thumbnail Recipe',
  niche_bundle: 'Niche Bundle',
})[props.product.kind])

const showcaseVideos = computed(() => props.ownership?.showcaseVideos?.length
  ? props.ownership.showcaseVideos
  : props.product.showcaseVideos)

const ownedStatus = computed(() => {
  if (!props.ownership) return 'Owned in GenStudio.'
  if (props.ownership.receiptVerification !== 'verified') {
    return 'Owned in GenStudio · restore purchases to verify on this Mac.'
  }
  if (props.ownership.installState === 'installed_current') return 'Verified ownership · installed on this Mac.'
  if (props.ownership.installState === 'update_available') return `Installed ${props.ownership.installedVersion || 'version'} · newer owned release available.`
  if (props.ownership.installState === 'installed_other_version') return `Verified ownership · ${props.ownership.installedVersion || 'another version'} is active.`
  if (!props.ownership.downloadAvailable) return 'Verified ownership · no downloadable release is available right now.'
  return 'Verified ownership · ready to install on this Mac.'
})

function formatCredits(value: number): string {
  return value.toLocaleString()
}
</script>

<style scoped>
.content-product-card {
  display: grid;
  min-width: 0;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  overflow: hidden;
}
.content-product-card[data-owned='true'] { border-color: color-mix(in srgb, var(--success) 38%, var(--border)); }
.product-heading { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 12px; }
.product-heading > div { min-width: 0; }
.product-kind-icon { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 12px; background: var(--accent-dim); color: var(--accent); }
.product-kind-icon svg { width: 24px; height: 24px; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.product-kind { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; letter-spacing: .04em; }
h2 { max-width: 100%; margin-top: 2px; overflow-wrap: anywhere; word-break: break-word; font-size: var(--font-xl); line-height: 1.25; }
.status-tag { align-self: start; padding: 3px 8px; border: 1px solid var(--border-light); border-radius: 999px; color: var(--text-secondary); font-size: var(--font-xs); }
.status-tag.owned { border-color: color-mix(in srgb, var(--success) 40%, var(--border)); color: var(--success); }
.product-summary { min-width: 0; max-width: 100%; overflow-wrap: anywhere; color: var(--text-secondary); line-height: 1.55; }
.product-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.product-facts div { min-width: 0; }
.product-facts dt { color: var(--text-muted); font-size: var(--font-xs); }
.product-facts dd { overflow-wrap: anywhere; color: var(--text-primary); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }
.bundle-summary { padding: 12px; border-radius: var(--radius-md); background: var(--bg-tertiary); font-size: var(--font-sm); }
.bundle-summary ul { display: grid; gap: 5px; margin: 8px 0 0; padding: 0; list-style: none; }
.bundle-summary li { display: flex; justify-content: space-between; gap: 12px; color: var(--text-secondary); }
.bundle-summary li span:last-child { flex: 0 0 auto; font-size: var(--font-xs); }
.bundle-summary p { margin-top: 8px; color: var(--accent); }
.showcase-videos { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius-md); background: var(--bg-tertiary); }
.showcase-videos ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.showcase-videos a { color: var(--accent); overflow-wrap: anywhere; }
.showcase-videos p { margin: 2px 0 0; color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.compatibility-message { padding: 12px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-sm); }
.compatibility-message strong { display: block; color: var(--warning); }
.product-action { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 14px; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--border); }
.product-action p { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.product-action .btn { flex: 0 0 auto; }
@media (max-width: 620px) {
  .content-product-card { padding: 16px; }
  .product-heading { grid-template-columns: auto minmax(0, 1fr); }
  .status-tag { grid-column: 2; }
  .product-facts { grid-template-columns: 1fr 1fr; }
  .product-facts div:first-child { grid-column: 1 / -1; }
  .product-action { align-items: stretch; flex-direction: column; }
  .product-action .btn { width: 100%; justify-content: center; }
  .bundle-summary li { flex-direction: column; gap: 1px; }
}
</style>
