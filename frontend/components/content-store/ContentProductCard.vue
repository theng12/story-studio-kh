<template>
  <article class="content-product-card" :data-owned="ownershipResolved ? product.owned : undefined" :data-compatible="product.compatible" :data-selected="selected || undefined">
    <label v-if="selectable" class="select-row"><input type="checkbox" :checked="selected" @change="$emit('toggle-select', product)" /><span>{{ selected ? 'Selected' : 'Select' }}</span></label>
    <NuxtLink :to="`/content-store/${product.productId}`" class="product-proof-link" :aria-label="`View proof for ${product.title}`">
      <ContentProductCover :product="product" />
      <div class="product-copy">
        <div class="product-title-row"><h3>{{ product.title }}</h3><span class="status-tag">{{ status }}</span></div>
        <p class="product-promise">{{ product.summary }}</p>
        <p v-if="product.description && product.description !== product.summary" class="product-transformation">{{ product.description }}</p>
      </div>
    </NuxtLink>

    <p v-if="!ownershipResolved" class="ownership-status">Checking with GenStudio what this account owns, what is installed here, and whether this works with this version.</p>
    <p v-else-if="!product.compatible" class="compatibility-message" role="status"><strong>Not compatible with this Story Studio version.</strong>{{ product.compatibilityReason }}</p>
    <p v-else-if="product.owned" class="ownership-status">{{ ownedStatus }}</p>
    <p v-else-if="product.retired" class="ownership-status">No longer available for new ownership.</p>
    <p v-else class="ownership-status">GenStudio supplies the exact quote before any purchase.</p>
    <section v-if="ownership?.recalledReleaseVersions.length" class="recall-message" role="status"><strong>Recalled {{ ownership.recalledReleaseVersions.join(', ') }}</strong><p>GenStudio stopped serving those versions. Ownership remains permanent.</p><p v-if="ownership.currentRelease">The newest safe owned release is {{ ownership.currentRelease.version }}.</p></section>
    <section v-if="ownership?.installState === 'incomplete'" class="closure-message" role="status"><strong>Installed files are incomplete</strong><p v-if="ownership.missingDependencies.length">{{ closureSummary }}</p><p v-else>Story Studio could not verify the installed pack. Install the published release explicitly to repair it.</p></section>

    <div class="product-action">
      <NuxtLink :to="`/content-store/${product.productId}`" class="proof-action">View proof</NuxtLink>
      <button v-if="ownershipResolved && !product.owned && !product.retired && product.compatible && product.currentRelease" type="button" class="btn btn-primary" :disabled="networkUnavailable" :aria-busy="busy ? 'true' : undefined" @click="$emit('quote', product)">{{ busy ? 'Requesting quote…' : product.free ? 'Get free' : 'See exact quote' }}</button>
      <button v-else-if="canInstall" type="button" class="btn btn-primary" :disabled="installDisabled" :aria-busy="installBusy ? 'true' : undefined" @click="$emit('install', product.currentRelease!.releaseId)">{{ installLabel }}</button>
      <span v-else-if="queueStatus === 'installed'" class="queue-note">Installed just now</span>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ContentProductCover from './ContentProductCover.vue'
import type { ContentStoreAccount, ContentStoreProduct } from '~/composables/useContentStore'
import type { InstallQueueStatus } from '~/composables/useInstallQueue'

type OwnedContent = ContentStoreAccount['owned'][number]
/**
 * `ownershipResolved: false` means the catalogue came off this Mac and
 * GenStudio has not answered yet. Everything the card would say about this
 * account — owned, installed, compatible, buyable — is unknown, not false, so
 * the card says it is checking and offers no action. Defaults to true because
 * every other caller renders a verified overview.
 */
const props = withDefaults(
  defineProps<{ product: ContentStoreProduct; ownership?: OwnedContent | null; busy?: boolean; networkUnavailable?: boolean; ownershipResolved?: boolean; queueStatus?: InstallQueueStatus; selectable?: boolean; selected?: boolean }>(),
  { ownershipResolved: true, queueStatus: 'idle', selectable: false, selected: false },
)
defineEmits<{ quote: [product: ContentStoreProduct]; install: [releaseId: string]; 'toggle-select': [product: ContentStoreProduct] }>()

/**
 * A queued install is ACCEPTED, not refused. Before the queue existed a second
 * Install click was simply disabled until the first returned, which with
 * sixty-five packs meant sixty-five deliberate waits. The button now says where
 * in the queue this one is.
 */
const installBusy = computed(() => props.busy || props.queueStatus === 'installing' || props.queueStatus === 'queued')
const installDisabled = computed(() => installBusy.value || props.networkUnavailable === true)
const installLabel = computed(() => {
  if (props.queueStatus === 'queued') return 'Queued'
  if (props.queueStatus === 'installing' || props.busy) return 'Installing…'
  if (props.queueStatus === 'failed') return 'Install failed — try again'
  return props.ownership?.installState === 'update_available' ? 'Install update' : 'Install on this Mac'
})

const status = computed(() => {
  if (props.product.retired) return 'Retired'
  if (!props.ownershipResolved) return 'Checking…'
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
/*
 * Column, not grid — this is what makes a row of cards read as a grid.
 *
 * The shelf stretches every card in a row to the tallest one. A `display: grid`
 * card then spread that extra height evenly across its own auto rows, so the
 * cover, the badge row and the title each started at a different offset on
 * every card — measured drift of 51px across four cards in one row. A flex
 * column packs the blocks from the top at one fixed gap and lets
 * `.product-action`'s `margin-top: auto` do what it was always written to do:
 * absorb the leftover height in one place, at the bottom.
 */
.content-product-card { display: flex; flex-direction: column; min-width: 0; gap: 13px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.content-product-card[data-owned='true'] { border-color: color-mix(in srgb, var(--success) 44%, var(--border)); }
.content-product-card[data-selected] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.select-row { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; color: var(--text-secondary); cursor: pointer; font-size: var(--font-sm); font-weight: 650; }
.select-row input { width: 17px; height: 17px; accent-color: var(--accent); cursor: pointer; }
.queue-note { margin-left: auto; color: var(--success); font-size: var(--font-sm); font-weight: 650; }
/* Same reason as the card itself: as a grid this stretched the cover to
   whatever height the copy left over, which is why no two covers were the
   same size. */
.product-proof-link { display: flex; flex-direction: column; min-width: 0; gap: 12px; color: inherit; text-decoration: none; }
.product-proof-link:hover h3 { color: var(--accent); }
.product-copy { display: grid; min-width: 0; gap: 6px; }
.product-title-row { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
/* Two lines maximum keeps the title row — and so the "Available" tag beside
   it — the same height on every card. Longer titles do exist. */
h3 { display: -webkit-box; min-width: 0; overflow: hidden; overflow-wrap: anywhere; font-size: var(--font-xl); letter-spacing: -.02em; line-height: 1.2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.status-tag { flex: 0 0 auto; max-width: 48%; padding: 3px 7px; border: 1px solid var(--border-light); border-radius: 999px; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.25; text-align: right; }
/* Catalogue copy is written to no fixed length — these run from 3 to 20 lines,
   which is what made the row ragged. The card shows a consistent opening and
   "View proof" carries the reader to the full text; it is clamped, never
   rewritten. */
.product-promise { display: -webkit-box; overflow: hidden; color: var(--text-primary); font-size: var(--font-sm); font-weight: 650; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.product-transformation { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 5; }
.product-transformation, .ownership-status { color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; overflow-wrap: anywhere; }
.compatibility-message { display: grid; gap: 3px; padding: 10px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; overflow-wrap: anywhere; }
.compatibility-message strong { color: var(--warning); }
.recall-message { display: grid; gap: 3px; padding: 10px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; }.recall-message strong { color: var(--warning); }
.closure-message { display: grid; gap: 3px; padding: 10px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; }.closure-message strong { color: var(--warning); }
/*
 * The slack goes ABOVE the status line, not below it. Titles run to one or two
 * lines and promises to two or three, so without this the last line of the card
 * ("GenStudio supplies the exact quote…") sat at three different heights across
 * a row. Taking the auto margin here instead of on `.product-action` pins the
 * status line and the action row together at the bottom, and puts the variation
 * in one deliberate gap after the description. The status branch in the
 * template is exhaustive — one of them always renders — so this always applies.
 */
.ownership-status, .compatibility-message { margin-top: auto; }
.product-action { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--border); }
.proof-action { display: inline-flex; align-items: center; min-height: 44px; color: var(--accent); font-size: var(--font-sm); font-weight: 650; text-decoration: underline; text-underline-offset: 3px; }
.product-action .btn { margin-left: auto; min-height: var(--control-height-sm); padding: 7px 11px; font-size: var(--font-sm); }
@media (max-width: 560px) { .product-action .btn { min-height: 44px; } }
@media (max-width: 340px) { .product-title-row, .product-action { align-items: stretch; flex-direction: column; } .status-tag { align-self: flex-start; max-width: 100%; text-align: left; } .product-action .btn { width: 100%; margin-left: 0; justify-content: center; } }
</style>
