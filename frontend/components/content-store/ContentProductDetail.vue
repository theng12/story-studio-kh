<template>
  <article class="content-product-detail">
    <header class="detail-hero">
      <img v-if="product.presentation.hero" class="detail-hero-media" :src="product.presentation.hero.src" :alt="product.presentation.hero.alt">
      <ContentProductCover v-else :product="product" />
      <div class="detail-copy"><p class="detail-kind">{{ kindLabel }}</p><h1>{{ product.title }}</h1><p class="detail-promise">{{ product.summary }}</p><p v-if="product.description" class="detail-description">{{ product.description }}</p><div class="detail-status" role="status">{{ status }}</div></div>
    </header>

    <p v-if="!ownershipResolved" class="detail-pending" role="status" aria-live="polite">Checking with the Gateway what can be installed on this Mac and whether this release works with this Story Studio version.</p>
    <p v-else-if="!product.compatible" class="detail-warning" role="status"><strong>Not compatible with this Story Studio version.</strong>{{ product.compatibilityReason }}</p>

    <section v-if="showcaseVideos.length" class="detail-section" aria-labelledby="showcase-heading">
      <h2 id="showcase-heading">Watch example videos</h2>
      <p>Examples are published catalog links. Opens YouTube in your default browser.</p>
      <ul class="showcase-list"><li v-for="video in showcaseVideos" :key="video.url"><button type="button" class="showcase-link" @click="openExternalShowcase(video.url)">{{ video.title }}</button><p v-if="video.description">{{ video.description }}</p></li></ul>
    </section>

    <!-- The pack's own pictures, at a size you can judge the style by. A pack
         the catalogue publishes no picture for says so here rather than
         showing an empty grid. -->
    <section class="detail-section" aria-labelledby="pictures-heading">
      <h2 id="pictures-heading">Preview pictures</h2>
      <p v-if="!pictures.length">The Gateway publishes no preview picture for this pack yet.</p>
      <div v-else class="preview-grid">
        <button
          v-for="(picture, position) in pictures" :key="picture.src" type="button"
          class="preview-tile" :aria-label="`Enlarge preview ${position + 1} of ${pictures.length}`"
          @click="openPreview(position)"
        >
          <img :src="picture.src" :alt="picture.alt" loading="lazy" decoding="async" />
        </button>
      </div>
    </section>

    <PackPreviewViewer
      v-if="previewOpen" :pictures="pictures" :index="previewIndex"
      :title="product.title" @close="previewOpen = false" @update:index="previewIndex = $event"
    />

    <section class="detail-section" aria-labelledby="release-heading"><h2 id="release-heading">Release proof</h2><dl class="proof-grid"><div><dt>Publisher</dt><dd>{{ product.publisherId }}</dd></div><div><dt>Current release</dt><dd>{{ release?.version || 'Unavailable' }}</dd></div><div><dt>Minimum Story Studio version</dt><dd>{{ release?.minStoryVersion || 'Not published' }}</dd></div><div><dt>License</dt><dd>{{ product.presentation.licenseLabel || 'Not published' }}</dd></div></dl><p v-if="product.presentation.licenseText" class="license-text">{{ product.presentation.licenseText }}</p><div v-if="release?.changelog" class="changelog"><h3>Changelog</h3><p>{{ release.changelog }}</p></div></section>

    <section v-if="product.bundleComponents.length || componentSummary.length" class="detail-section" aria-labelledby="components-heading"><h2 id="components-heading">Included components</h2><ul v-if="product.bundleComponents.length" class="component-list"><li v-for="component in product.bundleComponents" :key="component.productId"><span><strong>{{ component.title }}</strong><small>{{ component.kind }}</small></span><span>Included</span></li></ul><dl v-if="componentSummary.length" class="summary-grid"><div v-for="fact in componentSummary" :key="fact.label"><dt>{{ fact.label }}</dt><dd>{{ fact.value }}</dd></div></dl></section>

    <section v-if="ownership?.recalledReleaseVersions.length" class="detail-warning" role="status"><strong>Recalled {{ ownership.recalledReleaseVersions.join(', ') }}</strong><span>The Gateway stopped serving these exact versions.</span></section>

    <footer class="detail-actions"><NuxtLink to="/library" class="back-to-store">Back to Studio Library</NuxtLink><button v-if="canInstall" type="button" class="btn btn-primary" :disabled="installBusy || networkUnavailable" :aria-busy="installBusy ? 'true' : undefined" @click="$emit('install', release!.releaseId)">{{ installLabel }}</button><span v-else-if="queueStatus === 'installed'" class="detail-pending" role="status">Installed just now</span></footer>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ContentProductCover from './ContentProductCover.vue'
import PackPreviewViewer, { type PackPicture } from './PackPreviewViewer.vue'
import { contentStoreKindLabel } from '~/content-store/catalog-presentation'
import type { ContentStoreAccount, ContentStoreProduct, ContentStoreShowcaseVideo } from '~/composables/useContentStore'
import type { InstallQueueStatus } from '~/composables/useInstallQueue'

type AvailabilityRow = ContentStoreAccount['owned'][number]
const props = withDefaults(
  defineProps<{ product: ContentStoreProduct; ownership?: AvailabilityRow | null; busy?: boolean; queueStatus?: InstallQueueStatus; networkUnavailable?: boolean; ownershipResolved?: boolean }>(),
  { ownershipResolved: true, queueStatus: 'idle' },
)
defineEmits<{ install: [releaseId: string] }>()

/**
 * Every picture this pack publishes, hero first, each once.
 *
 * A hero and a cover can be the same file; showing it twice would make the
 * strip lie about how many pictures there are. An empty list is the honest
 * "no preview picture" state and the section says so in words.
 */
const pictures = computed<PackPicture[]>(() => {
  const seen = new Set<string>()
  const rows: PackPicture[] = []
  for (const media of [props.product.presentation.hero, props.product.presentation.cover]) {
    if (!media?.src || seen.has(media.src)) continue
    seen.add(media.src)
    rows.push({ src: media.src, alt: media.alt || '' })
  }
  return rows
})

const previewOpen = ref(false)
const previewIndex = ref(0)
function openPreview(position: number): void {
  previewIndex.value = position
  previewOpen.value = true
}
const kindLabel = computed(() => contentStoreKindLabel(props.product.kind))
const release = computed(() => props.product.currentRelease)
const showcaseVideos = computed<readonly ContentStoreShowcaseVideo[]>(() => props.ownership?.showcaseVideos.length ? props.ownership.showcaseVideos : props.product.showcaseVideos)
const status = computed(() => {
  if (props.queueStatus === 'queued') return 'Queued to install'
  if (props.queueStatus === 'installing') return 'Installing…'
  if (props.queueStatus === 'installed') return 'Installed just now'
  if (props.queueStatus === 'failed') return 'Install failed'
  if (!props.product.compatible) return 'Not compatible with this Story Studio version'
  if (props.product.retired) return 'Retired'
  // Availability is not known yet and must not be implied either way.
  if (!props.ownershipResolved) return 'Checking availability'
  if (!props.product.owned) return 'Not available to this Mac'
  if (props.ownership?.installState === 'installed_current') return 'Installed'
  if (props.ownership?.installState === 'update_available') return 'Update available'
  return 'Available'
})
const installBusy = computed(() => props.busy || props.queueStatus === 'queued' || props.queueStatus === 'installing')
const installLabel = computed(() => {
  if (props.queueStatus === 'queued') return 'Queued'
  if (props.queueStatus === 'installing' || props.busy) return 'Installing…'
  if (props.queueStatus === 'failed') return 'Install failed — try again'
  return props.ownership?.installState === 'update_available' ? 'Update' : 'Install'
})
const canInstall = computed(() => !!(props.queueStatus !== 'installed' && props.product.owned && props.product.compatible && props.ownership?.downloadAvailable && release.value
  && !props.ownership.recalledReleaseVersions.includes(release.value.version)
  && ['not_installed', 'installed_other_version', 'update_available', 'incomplete'].includes(props.ownership.installState)))
const componentSummary = computed(() => Object.entries(release.value?.componentSummary || {}).flatMap(([key, value]) => {
  if (typeof value === 'number') return [{ label: factLabel(key), value: value.toLocaleString() }]
  if (Array.isArray(value)) return [{ label: factLabel(key), value: `${value.length.toLocaleString()} items` }]
  return []
}))
function factLabel(key: string): string { return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }
function openExternalShowcase(url: string): void {
  let parsed: URL
  try { parsed = new URL(url) } catch { return }
  if (parsed.protocol !== 'https:' || !/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(parsed.hostname)) return
  if (typeof window !== 'undefined' && (window as any).require) {
    try { (window as any).require('electron').shell.openExternal(parsed.toString()); return } catch { /* browser fallback */ }
  }
  window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
}
</script>

<style scoped>
.content-product-detail { display: grid; min-width: 0; gap: 20px; }
.detail-hero { display: grid; grid-template-columns: minmax(220px, .75fr) minmax(0, 1.25fr); gap: clamp(18px, 3vw, 34px); padding: clamp(16px, 2.3vw, 28px); border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--bg-secondary); }
.detail-hero :deep(.product-cover) { min-height: 240px; }.detail-hero :deep(.product-cover img), .detail-hero :deep(.product-cover-fallback), .detail-hero-media { min-height: 240px; }.detail-hero-media { width: 100%; height: 100%; max-height: 480px; border-radius: var(--radius-lg); object-fit: cover; }
.detail-copy { display: grid; align-content: center; gap: 11px; min-width: 0; }.detail-kind { color: var(--accent); font-size: var(--font-sm); font-weight: 700; }.detail-copy h1, .detail-promise, .detail-description { overflow-wrap: anywhere; }.detail-copy h1 { font-size: clamp(30px, 4vw, 48px); letter-spacing: -.04em; line-height: 1.05; }.detail-promise { font-size: var(--font-xl); font-weight: 650; line-height: 1.45; }.detail-description { max-width: 70ch; color: var(--text-secondary); line-height: 1.55; }.detail-status { justify-self: start; max-width: 100%; overflow-wrap: anywhere; padding: 5px 9px; border: 1px solid var(--border-light); border-radius: 999px; color: var(--text-secondary); font-size: var(--font-sm); }
.detail-section { display: grid; min-width: 0; gap: 12px; padding: clamp(16px, 2vw, 24px); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.detail-section h2 { overflow-wrap: anywhere; font-size: var(--font-2xl); letter-spacing: -.02em; }.detail-section > p { color: var(--text-secondary); font-size: var(--font-sm); overflow-wrap: anywhere; }.license-text { white-space: pre-wrap; line-height: 1.55; }.proof-grid, .summary-grid { display: grid; min-width: 0; grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr)); gap: 12px; }.proof-grid div, .summary-grid div { min-width: 0; }.proof-grid dt, .summary-grid dt { color: var(--text-muted); font-size: var(--font-xs); }.proof-grid dd, .summary-grid dd { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }.changelog { display: grid; min-width: 0; gap: 4px; padding-top: 12px; border-top: 1px solid var(--border); }.changelog h3 { font-size: var(--font-md); }.changelog p { overflow-wrap: anywhere; color: var(--text-secondary); white-space: pre-wrap; }
.showcase-list, .component-list { display: grid; min-width: 0; gap: 9px; padding: 0; list-style: none; }.showcase-list li, .component-list li { display: grid; gap: 3px; min-width: 0; padding: 10px; border-radius: var(--radius-md); background: var(--bg-tertiary); }.showcase-link { width: fit-content; max-width: 100%; border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; font-weight: 700; text-align: left; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }.showcase-list p { color: var(--text-secondary); font-size: var(--font-sm); overflow-wrap: anywhere; }.component-list li { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; }.component-list li span { display: grid; min-width: 0; gap: 3px; overflow-wrap: anywhere; }.component-list li small { color: var(--text-secondary); }.component-list li span:last-child { color: var(--text-secondary); font-size: var(--font-sm); text-align: right; }
/*
 * Every tile is a real button, so Enter and Space open the viewer and the
 * focus ring is the browser's. A fixed 16/9 ratio keeps a row of covers at one
 * height whatever the artwork's own shape — the same reason the card cover
 * uses one. Hover lifts the ring rather than the picture: scaling a grid item
 * shifts its neighbours, and a preview wall that jitters as you pass over it
 * is worse than one that does not move.
 */
.preview-grid { display: grid; min-width: 0; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap: 12px; }
.preview-tile { position: relative; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-accent); cursor: zoom-in; }
.preview-tile::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 2px transparent; transition: box-shadow 140ms ease; pointer-events: none; }
.preview-tile:hover::after { box-shadow: inset 0 0 0 2px var(--accent); }
.preview-tile:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.preview-tile img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
.detail-warning { display: grid; min-width: 0; gap: 4px; padding: 13px; border-radius: var(--radius-lg); background: color-mix(in srgb, var(--warning) 9%, var(--bg-secondary)); color: var(--text-secondary); overflow-wrap: anywhere; }.detail-warning strong { color: var(--warning); }.detail-pending { min-width: 0; padding: 13px; border-radius: var(--radius-lg); background: var(--bg-secondary); color: var(--text-secondary); line-height: 1.5; overflow-wrap: anywhere; }.detail-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.back-to-store { color: var(--accent); font-weight: 650; text-decoration: underline; text-underline-offset: 4px; }
@media (max-width: 680px) { .detail-hero { grid-template-columns: 1fr; }.detail-hero :deep(.product-cover), .detail-hero :deep(.product-cover img), .detail-hero :deep(.product-cover-fallback) { min-height: 190px; }.detail-actions { align-items: stretch; flex-direction: column; }.detail-actions .btn { width: 100%; min-height: 44px; justify-content: center; } }.component-list li { align-items: start; } @media (max-width: 360px) { .component-list li { grid-template-columns: 1fr; }.component-list li span:last-child { text-align: left; } }
</style>
