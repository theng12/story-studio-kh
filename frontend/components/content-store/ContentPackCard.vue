<template>
  <article class="pack-card" :data-mode="mode" :data-state="card.installState">
    <button type="button" class="pack-open" :aria-label="`Open ${card.title}`" @click="$emit('open', card)">
      <span class="pack-media">
        <img
          v-if="card.cover && !coverBroken" :src="card.cover.src" :alt="card.cover.alt"
          loading="lazy" decoding="async" @error="coverBroken = true"
        />
        <!-- No cover is published for this pack. The tile says so in words rather
             than showing a picture that would not be the pack. -->
        <span v-else class="pack-media-empty">
          <span class="pack-initial" aria-hidden="true">{{ card.title.slice(0, 1) }}</span>
          <span class="pack-media-note">No preview yet</span>
        </span>
        <span class="pack-kind">{{ card.kindLabel }}</span>
      </span>
      <span class="pack-copy">
        <span class="pack-title-row">
          <h3>{{ card.title }}</h3>
          <span class="pack-state">{{ stateLabel }}</span>
        </span>
        <span class="pack-summary">{{ summary }}</span>
        <span class="pack-version-line">{{ versionLine }}</span>
      </span>
    </button>
    <div class="pack-actions">
      <button type="button" class="pack-details" @click="$emit('open', card)">Details</button>
      <button
        v-if="installable" type="button" class="btn btn-primary pack-install"
        :disabled="networkUnavailable || busy" :aria-busy="busy ? 'true' : undefined"
        :title="installTitle" @click="$emit('install', card)"
      >{{ installLabel }}</button>
    </div>
  </article>
</template>

<script setup lang="ts">
/**
 * One pack, one card — newest version only, older versions live in the detail
 * dialog. The picture is whatever the catalogue really publishes; when it
 * publishes nothing the card says "No preview yet" instead of inventing one.
 */
import { computed, ref, watch } from 'vue'
import type { LibraryPackCard } from '~/content-store/pack-browsing'

const props = withDefaults(defineProps<{
  card: LibraryPackCard
  mode?: 'cards' | 'list'
  networkUnavailable?: boolean
  busy?: boolean
}>(), { mode: 'cards' })

defineEmits<{ install: [card: LibraryPackCard]; open: [card: LibraryPackCard] }>()

/** A cover that 404s (or the Gateway restarted without one) falls back in place. */
const coverBroken = ref(false)
watch(() => props.card.cover?.src, () => { coverBroken.value = false })

const stateLabel = computed(() => {
  switch (props.card.installState) {
    case 'unchecked': return 'Checking…'
    case 'installed_current': return 'Installed'
    case 'update_available': return 'Update available'
    case 'incomplete': return 'Needs repair'
    default: return 'Not installed'
  }
})

const versionLine = computed(() => {
  const parts = [`v${props.card.newest.version}`]
  if (props.card.installState === 'update_available' && props.card.installedVersion) {
    parts.push(`this Mac has v${props.card.installedVersion}`)
  }
  if (props.card.versions.length > 1) parts.push(`${props.card.versions.length} versions archived`)
  return parts.join(' · ')
})

const summary = computed(() => props.card.product?.summary || props.card.newest.itemKinds.join(', '))

const installable = computed(() => props.card.installState !== 'unchecked' && props.card.installState !== 'installed_current')
const busy = computed(() => props.busy === true)
const installLabel = computed(() => (props.card.installState === 'update_available' ? 'Install update' : 'Install'))
const installTitle = computed(() => {
  if (props.networkUnavailable) return 'The Gateway is not reachable right now'
  if (props.card.installState === 'update_available') return `Replace v${props.card.installedVersion} with v${props.card.newest.version} on this Mac`
  return `Install v${props.card.newest.version} on this Mac`
})
</script>

<style scoped>
.pack-card { display: flex; flex-direction: column; min-width: 0; gap: 10px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.pack-card[data-state='installed_current'] { border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
.pack-card[data-state='incomplete'] { border-color: color-mix(in srgb, var(--warning) 46%, var(--border)); }

.pack-open { display: flex; flex-direction: column; min-width: 0; gap: 10px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; font: inherit; text-align: left; }
.pack-open:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; border-radius: var(--radius-md); }

.pack-media { position: relative; flex: none; aspect-ratio: 16 / 10; overflow: hidden; border-radius: var(--radius-md); background: var(--surface-accent); }
.pack-media img { display: block; width: 100%; height: 100%; object-fit: cover; }
.pack-media-empty { display: grid; height: 100%; place-content: center; justify-items: center; gap: 2px; background: color-mix(in srgb, var(--accent-dim) 62%, var(--bg-tertiary)); color: var(--accent); }
.pack-initial { font-size: clamp(34px, 6vw, 56px); font-weight: 750; letter-spacing: -.04em; line-height: 1; }
.pack-media-note { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 650; }
.pack-kind { position: absolute; right: 8px; bottom: 8px; left: 8px; display: flex; }
.pack-kind { overflow: hidden; width: fit-content; padding: 4px 8px; border-radius: 999px; background: color-mix(in srgb, var(--bg-primary) 84%, transparent); backdrop-filter: blur(8px); color: var(--accent); font-size: var(--font-xs); font-weight: 700; white-space: nowrap; text-overflow: ellipsis; }

.pack-copy { display: grid; min-width: 0; gap: 5px; }
.pack-title-row { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
h3 { display: -webkit-box; min-width: 0; overflow: hidden; overflow-wrap: anywhere; font-size: var(--font-lg); letter-spacing: -.02em; line-height: 1.25; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.pack-state { flex: 0 0 auto; max-width: 52%; padding: 3px 7px; border: 1px solid var(--border-light); border-radius: 999px; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.25; text-align: right; }
.pack-card[data-state='installed_current'] .pack-state { border-color: color-mix(in srgb, var(--success) 44%, var(--border)); color: var(--success); }
.pack-card[data-state='update_available'] .pack-state { border-color: color-mix(in srgb, var(--accent) 52%, var(--border)); color: var(--accent); }
.pack-card[data-state='incomplete'] .pack-state { border-color: color-mix(in srgb, var(--warning) 50%, var(--border)); color: var(--warning); }
.pack-summary { display: -webkit-box; overflow: hidden; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.pack-version-line { color: var(--text-muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

.pack-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); }
.pack-details { min-height: 36px; padding: 0 2px; border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; font-size: var(--font-sm); font-weight: 650; text-decoration: underline; text-underline-offset: 3px; }
.pack-details:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: var(--radius-sm); }
.pack-install { min-height: var(--control-height-sm); padding: 6px 11px; font-size: var(--font-sm); }

/* List mode: one row per pack. The same markup, so the picture, the status and
   the action cannot drift between the two views. */
.pack-card[data-mode='list'] { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 8px 10px; }
.pack-card[data-mode='list'] .pack-open { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: center; gap: 12px; }
.pack-card[data-mode='list'] .pack-media { aspect-ratio: 16 / 10; width: 96px; }
.pack-card[data-mode='list'] .pack-kind { right: 4px; bottom: 4px; left: 4px; padding: 2px 6px; font-size: var(--font-xs); }
.pack-card[data-mode='list'] .pack-initial { font-size: 24px; }
.pack-card[data-mode='list'] .pack-media-note { display: none; }
.pack-card[data-mode='list'] .pack-title-row { align-items: center; }
.pack-card[data-mode='list'] h3 { font-size: var(--font-md); -webkit-line-clamp: 1; }
.pack-card[data-mode='list'] .pack-actions { border-top: 0; padding-top: 0; margin-top: 0; gap: 6px; }

@media (max-width: 560px) {
  .pack-card[data-mode='list'] { grid-template-columns: minmax(0, 1fr); }
  .pack-card[data-mode='list'] .pack-actions { justify-content: flex-end; }
  .pack-details, .pack-install { min-height: 44px; }
}
@media (max-width: 380px) {
  .pack-title-row, .pack-actions { align-items: stretch; flex-direction: column; }
  .pack-state { align-self: flex-start; max-width: 100%; text-align: left; }
  .pack-install { width: 100%; justify-content: center; }
}
</style>
