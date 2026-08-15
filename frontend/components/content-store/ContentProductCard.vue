<template>
  <article class="content-product-card" :data-owned="product.owned" :data-compatible="product.compatible">
    <NuxtLink :to="`/content-store/${product.productId}`" class="product-proof-link" :aria-label="`View proof for ${product.title}`">
      <ContentProductCover :product="product" />
      <div class="product-copy">
        <div class="product-title-row"><h3>{{ product.title }}</h3><span class="status-tag">{{ status }}</span></div>
        <p class="product-promise">{{ product.summary }}</p>
        <p v-if="product.description && product.description !== product.summary" class="product-transformation">{{ product.description }}</p>
      </div>
    </NuxtLink>

    <p v-if="!product.compatible" class="compatibility-message" role="status"><strong>Not compatible with this Story Studio version.</strong>{{ product.compatibilityReason }}</p>
    <p v-else-if="product.owned" class="ownership-status">{{ ownedStatus }}</p>
    <p v-else-if="product.retired" class="ownership-status">No longer available for new ownership.</p>
    <p v-else class="ownership-status">GenStudio supplies the exact quote before any purchase.</p>
    <section v-if="ownership?.recalledReleaseVersions.length" class="recall-message" role="status"><strong>Recalled {{ ownership.recalledReleaseVersions.join(', ') }}</strong><p>GenStudio stopped serving those versions. Ownership remains permanent.</p><p v-if="ownership.currentRelease">The newest safe owned release is {{ ownership.currentRelease.version }}.</p></section>
    <section v-if="ownership?.installState === 'incomplete'" class="closure-message" role="status"><strong>Installed files are incomplete</strong><p v-if="ownership.missingDependencies.length">{{ closureSummary }}</p><p v-else>Story Studio could not verify the installed pack. Install the published release explicitly to repair it.</p></section>

    <div class="product-action">
      <NuxtLink :to="`/content-store/${product.productId}`" class="proof-action">View proof</NuxtLink>
      <button v-if="!product.owned && !product.retired && product.compatible && product.currentRelease" type="button" class="btn btn-primary" :disabled="networkUnavailable" :aria-busy="busy ? 'true' : undefined" @click="$emit('quote', product)">{{ busy ? 'Requesting quote…' : product.free ? 'Get free' : 'See exact quote' }}</button>
      <button v-else-if="canInstall" type="button" class="btn btn-primary" :disabled="!!busy || networkUnavailable" :aria-busy="busy ? 'true' : undefined" @click="$emit('install', product.currentRelease!.releaseId)">{{ busy ? 'Installing…' : ownership!.installState === 'update_available' ? 'Install update' : 'Install on this Mac' }}</button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ContentProductCover from './ContentProductCover.vue'
import type { ContentStoreAccount, ContentStoreProduct } from '~/composables/useContentStore'

type OwnedContent = ContentStoreAccount['owned'][number]
const props = defineProps<{ product: ContentStoreProduct; ownership?: OwnedContent | null; busy?: boolean; networkUnavailable?: boolean }>()
defineEmits<{ quote: [product: ContentStoreProduct]; install: [releaseId: string] }>()

const status = computed(() => {
  if (props.product.retired) return 'Retired'
  if (!props.product.compatible) return 'Not compatible'
  if (!props.product.owned) return props.product.free ? 'Free to claim' : 'Available'
  if (props.ownership?.installState === 'installed_current') return 'Installed'
  if (props.ownership?.installState === 'update_available') return 'Update available'
  if (props.ownership?.installState === 'incomplete') return 'Incomplete'
  return 'Owned'
})
const ownedStatus = computed(() => {
  if (!props.ownership) return 'Owned in GenStudio.'
  if (props.ownership.receiptVerification !== 'verified') return 'Owned in GenStudio · restore purchases to verify on this Mac.'
  if (props.ownership.installState === 'installed_current') return 'Verified ownership · installed on this Mac.'
  if (props.ownership.installState === 'update_available') return `Installed ${props.ownership.installedVersion || 'version'} · newer owned release available.`
  if (props.ownership.installState === 'installed_other_version') return `Verified ownership · ${props.ownership.installedVersion || 'another version'} is active.`
  if (props.ownership.installState === 'incomplete') return 'Verified ownership · installed files need repair on this Mac.'
  if (!props.ownership.downloadAvailable) return 'Verified ownership · no downloadable release is available right now.'
  return 'Verified ownership · ready to install on this Mac.'
})
const closureSummary = computed(() => props.ownership?.missingDependencies.map(dependency => `${dependency.packId} ${dependency.version} (${dependency.reason})`).join(', ') || '')
const canInstall = computed(() => {
  const ownership = props.ownership
  const release = props.product.currentRelease
  return !!(props.product.owned && props.product.compatible && ownership?.downloadAvailable && release
    && !ownership.recalledReleaseVersions.includes(release.version)
    && ['not_installed', 'installed_other_version', 'update_available', 'incomplete'].includes(ownership.installState))
})
</script>

<style scoped>
.content-product-card { display: grid; min-width: 0; gap: 13px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.content-product-card[data-owned='true'] { border-color: color-mix(in srgb, var(--success) 44%, var(--border)); }
.product-proof-link { display: grid; min-width: 0; gap: 12px; color: inherit; text-decoration: none; }
.product-proof-link:hover h3 { color: var(--accent); }
.product-copy { display: grid; min-width: 0; gap: 6px; }
.product-title-row { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
h3 { min-width: 0; overflow-wrap: anywhere; font-size: var(--font-xl); letter-spacing: -.02em; line-height: 1.2; }
.status-tag { flex: 0 0 auto; max-width: 48%; padding: 3px 7px; border: 1px solid var(--border-light); border-radius: 999px; color: var(--text-secondary); font-size: 11px; line-height: 1.25; text-align: right; }
.product-promise { color: var(--text-primary); font-size: var(--font-sm); font-weight: 650; line-height: 1.45; overflow-wrap: anywhere; }
.product-transformation, .ownership-status { color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; overflow-wrap: anywhere; }
.compatibility-message { display: grid; gap: 3px; padding: 10px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; overflow-wrap: anywhere; }
.compatibility-message strong { color: var(--warning); }
.recall-message { display: grid; gap: 3px; padding: 10px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; }.recall-message strong { color: var(--warning); }
.closure-message { display: grid; gap: 3px; padding: 10px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; }.closure-message strong { color: var(--warning); }
.product-action { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--border); }
.proof-action { display: inline-flex; align-items: center; min-height: 44px; color: var(--accent); font-size: var(--font-sm); font-weight: 650; text-decoration: underline; text-underline-offset: 3px; }
.product-action .btn { margin-left: auto; min-height: var(--control-height-sm); padding: 7px 11px; font-size: var(--font-sm); }
@media (max-width: 560px) { .product-action .btn { min-height: 44px; } }
@media (max-width: 340px) { .product-title-row, .product-action { align-items: stretch; flex-direction: column; } .status-tag { align-self: flex-start; max-width: 100%; text-align: left; } .product-action .btn { width: 100%; margin-left: 0; justify-content: center; } }
</style>
