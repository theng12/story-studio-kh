<template>
  <Modal :visible="visible" size="xl" labelledby="pack-detail-title" @close="$emit('close')">
    <article class="pack-detail">
      <header class="pack-detail-head">
        <div class="pack-detail-heading">
          <p class="pack-detail-kind">{{ card.kindLabel }}</p>
          <h2 id="pack-detail-title">{{ card.title }}</h2>
          <p class="pack-detail-state" :data-state="card.installState">{{ stateText }}</p>
        </div>
        <button type="button" class="pack-detail-close" aria-label="Close" @click="$emit('close')">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
        </button>
      </header>

      <div class="pack-detail-media">
        <img v-if="card.cover && !coverBroken" :src="card.cover.src" :alt="card.cover.alt" decoding="async" @error="coverBroken = true" />
        <div v-else class="pack-detail-media-empty">
          <span aria-hidden="true">{{ card.title.slice(0, 1) }}</span>
          <p>No preview yet</p>
          <small>The Gateway does not publish a cover picture for this pack yet.</small>
        </div>
      </div>

      <section v-if="card.product?.summary || card.product?.description" class="pack-detail-section" aria-labelledby="pack-detail-about">
        <h3 id="pack-detail-about">About</h3>
        <p class="pack-detail-lede">{{ card.product?.summary }}</p>
        <p v-if="card.product?.description && card.product.description !== card.product.summary">{{ card.product.description }}</p>
      </section>

      <section class="pack-detail-section" aria-labelledby="pack-detail-contains">
        <h3 id="pack-detail-contains">What it contains</h3>
        <ul v-if="contains.length" class="pack-detail-chips">
          <li v-for="item in contains" :key="item">{{ item }}</li>
        </ul>
        <p v-else>The Gateway does not list this pack's contents before it is installed.</p>
      </section>

      <section class="pack-detail-section" aria-labelledby="pack-detail-works">
        <h3 id="pack-detail-works">What it works with</h3>
        <ul v-if="worksWith.length" class="pack-detail-chips">
          <li v-for="item in worksWith" :key="item.productId">{{ item.title }} <span>{{ item.kindLabel }}</span></li>
        </ul>
        <p v-if="requirement">Requires Story Studio {{ requirement }} or newer.</p>
        <p v-if="!worksWith.length">{{ requirement ? 'The Gateway does not publish which packs this one works with.' : 'The Gateway does not publish which packs this one works with, or which Story Studio version it requires.' }}</p>
      </section>

      <section class="pack-detail-section" aria-labelledby="pack-detail-versions">
        <h3 id="pack-detail-versions">Versions on the Gateway</h3>
        <ul class="pack-detail-versions">
          <li v-for="(row, index) in card.versions" :key="row.version + row.archiveSha256" :data-newest="index === 0 ? 'true' : undefined">
            <div class="pack-detail-version-copy">
              <strong>v{{ row.version }}<span v-if="index === 0" class="pack-detail-tag">newest</span></strong>
              <span>{{ sizeLabel(row.bytes) }} · {{ integrityLabel(row) }}</span>
              <span class="pack-detail-hash" :title="row.archiveSha256">SHA-256 {{ row.archiveSha256.slice(0, 16) }}…</span>
            </div>
            <button
              v-if="row.version !== card.installedVersion && card.installState !== 'unchecked'"
              type="button" class="btn btn-secondary pack-detail-install"
              :disabled="networkUnavailable" @click="$emit('install', row)"
            >Install v{{ row.version }}</button>
            <span v-else-if="row.version === card.installedVersion" class="pack-detail-onmac">On this Mac</span>
          </li>
        </ul>
      </section>

      <section class="pack-detail-section" aria-labelledby="pack-detail-identity">
        <h3 id="pack-detail-identity">Package</h3>
        <dl class="pack-detail-identity">
          <dt>Package ID</dt><dd>{{ card.packId || 'Not published' }}</dd>
          <dt>Kind</dt><dd>{{ card.kindLabel }}</dd>
          <dt>Size</dt><dd>{{ sizeLabel(card.sizeBytes) }}</dd>
          <dt>Checksum</dt><dd class="pack-detail-hash">{{ card.newest.archiveSha256 }}</dd>
        </dl>
      </section>

      <footer class="pack-detail-foot">
        <span v-if="card.installState === 'installed_current'" class="pack-detail-installed">Installed on this Mac as v{{ card.installedVersion }}.</span>
        <button
          v-if="card.installState === 'installed_current' || card.installState === 'update_available' || card.installState === 'incomplete'"
          type="button" class="btn btn-secondary pack-detail-remove" :disabled="removing" @click="$emit('remove', card.packId)"
        >{{ removing ? 'Removing…' : 'Remove from this Mac' }}</button>
        <button type="button" class="btn btn-secondary" @click="$emit('close')">Close</button>
      </footer>
    </article>
  </Modal>
</template>

<script setup lang="ts">
/**
 * A pack's detail view: the larger picture, what is inside, what it works with,
 * every archived version, and the technical identity (package id, size, hash).
 *
 * Those identifiers are HERE and not on the card, on purpose — the owner asked
 * to browse pictures, and a package id beside a picture is noise.
 */
import { computed, ref, watch } from 'vue'
import Modal from '~/components/Modal.vue'
import type { LibraryPackCard } from '~/content-store/pack-browsing'
import type { GatewayContentArchive } from '~/composables/useContentStore'

const props = withDefaults(defineProps<{
  card: LibraryPackCard
  visible: boolean
  networkUnavailable?: boolean
  removing?: boolean
}>(), { networkUnavailable: false, removing: false })

defineEmits<{ close: []; install: [archive: GatewayContentArchive]; remove: [packId: string] }>()

const coverBroken = ref(false)
watch(() => [props.visible, props.card.cover?.src], () => { if (!props.visible) coverBroken.value = false })

const stateText = computed(() => {
  switch (props.card.installState) {
    case 'unchecked': return 'Checking what is installed on this Mac.'
    case 'installed_current': return `Installed on this Mac as v${props.card.installedVersion}.`
    case 'update_available': return `v${props.card.installedVersion} is on this Mac; v${props.card.newest.version} is newer.`
    case 'incomplete': return 'The installed copy is incomplete. Install the published release to repair it.'
    default: return 'Not installed on this Mac yet.'
  }
})

const requirement = computed(() => props.card.newest.minAppVersion || '')

/** Wire item kinds are hyphenated; a reader needs the product's own words. */
const ITEM_KIND_LABELS: Record<string, string> = {
  'series-formula': 'Series Formula', 'topic-pack': 'Topic Pack', 'visual-style': 'Visual Style',
  'thumbnail-recipe': 'Thumbnail Recipe', 'metadata-formula': 'Metadata Formula',
  'lettering-style': 'Lettering Style', 'font-pack': 'Font Pack', 'niche-bundle': 'Channel Kit',
}
const contains = computed(() => {
  const kinds = props.card.newest.itemKinds.map(kind =>
    ITEM_KIND_LABELS[kind] ?? kind.replace(/[-_]/g, ' ').replace(/^./, character => character.toUpperCase()))
  const components = props.card.product?.bundleComponents.map(component => component.title) ?? []
  return [...new Set([...components, ...kinds])]
})

const worksWith = computed(() => (props.card.product?.bundleComponents ?? []).map(component => ({
  productId: component.productId,
  title: component.title,
  kindLabel: component.kind,
})))

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return 'Size not reported'
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}
function integrityLabel(row: GatewayContentArchive): string {
  if (row.integrity === 'verified') return 'Gateway verified'
  if (row.integrity === 'unavailable') return 'Gateway could not verify this copy'
  return 'Unreadable archive record'
}
</script>

<style scoped>
.pack-detail { display: grid; gap: 18px; }
.pack-detail-head { display: flex; align-items: start; justify-content: space-between; gap: 14px; }
.pack-detail-heading { display: grid; gap: 4px; min-width: 0; }
.pack-detail-kind { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.pack-detail-heading h2 { font-size: var(--font-2xl); letter-spacing: -.025em; line-height: 1.15; overflow-wrap: anywhere; }
.pack-detail-state { color: var(--text-secondary); font-size: var(--font-sm); }
.pack-detail-state[data-state='installed_current'] { color: var(--success); }
.pack-detail-state[data-state='update_available'] { color: var(--accent); }
.pack-detail-state[data-state='incomplete'] { color: var(--warning); }
.pack-detail-close { flex: 0 0 auto; display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer; }
.pack-detail-close:hover { color: var(--text-primary); border-color: var(--border-light); }
.pack-detail-close svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.pack-detail-close:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

.pack-detail-media { max-height: 340px; aspect-ratio: 16 / 9; overflow: hidden; border-radius: var(--radius-lg); background: var(--surface-accent); }
.pack-detail-media img { display: block; width: 100%; height: 100%; object-fit: cover; }
.pack-detail-media-empty { display: grid; height: 100%; min-height: 200px; place-content: center; justify-items: center; gap: 4px; padding: 20px; color: var(--accent); text-align: center; }
.pack-detail-media-empty span { font-size: clamp(48px, 9vw, 84px); font-weight: 750; letter-spacing: -.04em; line-height: 1; }
.pack-detail-media-empty p { color: var(--text-primary); font-weight: 650; }
.pack-detail-media-empty small { max-width: 42ch; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; }

.pack-detail-section { display: grid; gap: 8px; }
.pack-detail-section h3 { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.pack-detail-section p { color: var(--text-secondary); line-height: 1.55; }
.pack-detail-lede { color: var(--text-primary) !important; font-weight: 600; }
.pack-detail-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pack-detail-chips li { padding: 4px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-secondary); color: var(--text-secondary); font-size: var(--font-sm); }
.pack-detail-chips li span { color: var(--text-muted); font-size: var(--font-xs); }

.pack-detail-versions { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pack-detail-versions li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary); }
.pack-detail-versions li[data-newest='true'] { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.pack-detail-version-copy { display: grid; gap: 2px; min-width: 0; color: var(--text-secondary); font-size: var(--font-sm); }
.pack-detail-version-copy strong { display: flex; align-items: center; gap: 7px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.pack-detail-tag { padding: 1px 6px; border-radius: 999px; background: var(--accent-dim); color: var(--accent); font-size: var(--font-xs); font-weight: 700; }
.pack-detail-hash { overflow-wrap: anywhere; color: var(--text-muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
.pack-detail-install { flex: 0 0 auto; min-height: var(--control-height-sm); padding: 5px 10px; font-size: var(--font-sm); }
.pack-detail-onmac { flex: 0 0 auto; color: var(--success); font-size: var(--font-sm); font-weight: 650; }

.pack-detail-identity { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 14px; margin: 0; }
.pack-detail-identity dt { color: var(--text-muted); font-size: var(--font-sm); }
.pack-detail-identity dd { margin: 0; color: var(--text-secondary); font-size: var(--font-sm); overflow-wrap: anywhere; }

.pack-detail-foot { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding-top: 14px; border-top: 1px solid var(--border); }
.pack-detail-installed { margin-right: auto; color: var(--text-secondary); font-size: var(--font-sm); }
.pack-detail-remove { color: var(--warning); }

@media (max-width: 560px) {
  .pack-detail-heading h2 { font-size: var(--font-xl); }
  .pack-detail-versions li { align-items: stretch; flex-direction: column; }
  .pack-detail-install { min-height: 44px; }
  .pack-detail-foot { justify-content: stretch; }
  .pack-detail-foot .btn { flex: 1 1 140px; }
  .pack-detail-installed { flex-basis: 100%; }
}
</style>
