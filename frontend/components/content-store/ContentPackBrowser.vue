<template>
  <section class="pack-browser">
    <div class="pack-browser-top">
      <label class="pack-search">
        <span class="pack-search-label">Search packs</span>
        <input v-model="query" type="search" placeholder="Name, kind or subject" autocomplete="off" />
      </label>
      <div class="pack-browser-actions">
        <ViewModeToggle v-model="viewMode" label="Pack view" />
        <button type="button" class="btn btn-secondary" :disabled="busy" @click="$emit('refresh')">{{ busy ? 'Checking…' : 'Refresh archives' }}</button>
      </div>
    </div>

    <div v-if="cards.length" class="pack-filter-group" role="group" aria-label="Filter by kind">
      <button
        v-for="option in kindOptions" :key="option.id" type="button"
        :class="['pack-chip', { active: kind === option.id }]" :aria-pressed="kind === option.id"
        @click="kind = option.id"
      >{{ option.label }}<span>{{ option.count }}</span></button>
    </div>
    <div v-if="cards.length" class="pack-filter-group" role="group" aria-label="Filter by what is installed here">
      <button
        v-for="option in installOptions" :key="option.id" type="button"
        :class="['pack-chip', { active: install === option.id }]" :aria-pressed="install === option.id"
        @click="install = option.id"
      >{{ option.label }}<span>{{ option.count }}</span></button>
    </div>

    <p v-if="cards.length" class="pack-browser-count" role="status" aria-live="polite">{{ countLine }}</p>

    <p v-if="loading && !cards.length" class="pack-browser-state" role="status" aria-live="polite">Checking the Gateway archive bank…</p>
    <div v-else-if="!cards.length" class="pack-browser-empty">
      <h3>No packs are in the Gateway archive bank yet</h3>
      <p>Add a .sspack in the Gateway, then refresh here. A pack installed from a file still works without the Gateway.</p>
    </div>
    <div v-else-if="!visible.length" class="pack-browser-empty">
      <h3>No packs match these filters</h3>
      <p>Clear the search or the filters to see all {{ cards.length }}.</p>
      <button type="button" class="btn btn-secondary" @click="clearFilters">Clear filters</button>
    </div>
    <div v-else :class="viewMode === 'cards' ? 'pack-grid' : 'pack-list'">
      <ContentPackCard
        v-for="card in visible" :key="card.key" :card="card" :mode="viewMode"
        :network-unavailable="networkUnavailable" :busy="busyDigest === card.newest.archiveSha256"
        @install="$emit('install', $event.newest)" @open="openDetail"
      />
    </div>

    <ContentPackDetail
      v-if="selected" :visible="detailOpen" :card="selected" :network-unavailable="networkUnavailable"
      :removing="removing === selected.packId"
      @close="detailOpen = false" @install="$emit('install', $event)" @remove="$emit('remove', $event)"
    />
  </section>
</template>

<script setup lang="ts">
/**
 * The Studio Library's browsable view of the Gateway archive bank.
 *
 * The bank is one row per released VERSION, so this collapses it to one card per
 * pack (newest version), groups it by kind, and shows a picture where one really
 * exists. It lives on its own tab so the archive bank and the published
 * catalogue never stack as two grids of the same packs on one page.
 */
import { computed, ref, watch } from 'vue'
import ViewModeToggle from '~/components/ViewModeToggle.vue'
import ContentPackCard from './ContentPackCard.vue'
import ContentPackDetail from './ContentPackDetail.vue'
import {
  buildLibraryCards,
  filterLibraryCards,
  libraryInstallOptions,
  libraryKindOptions,
  orderLibraryCards,
  type LibraryPackCard,
  type PackInstallFilter,
} from '~/content-store/pack-browsing'
import { useViewMode } from '~/composables/useViewMode'
import type {
  ContentStoreInstalledPack,
  ContentStoreProduct,
  GatewayContentArchive,
} from '~/composables/useContentStore'

const props = withDefaults(defineProps<{
  archives: readonly GatewayContentArchive[]
  products: readonly ContentStoreProduct[]
  installed: readonly ContentStoreInstalledPack[]
  installsResolved?: boolean
  networkUnavailable?: boolean
  busyDigest?: string
  removing?: string
  /** The archive read is still in flight; an unread bank is not an empty one. */
  loading?: boolean
  busy?: boolean
}>(), { installsResolved: true, networkUnavailable: false, busyDigest: '', removing: '', loading: false, busy: false })

defineEmits<{ install: [archive: GatewayContentArchive]; remove: [packId: string]; refresh: [] }>()

const viewMode = useViewMode('story-studio:studio-library:view')
const query = ref('')
const kind = ref<LibraryPackCard['kind'] | 'all'>('all')
const install = ref<PackInstallFilter>('all')

const cards = computed(() => orderLibraryCards(buildLibraryCards({
  archives: props.archives,
  products: props.products,
  installed: props.installed,
  installsResolved: props.installsResolved,
})))
const visible = computed(() => filterLibraryCards(cards.value, { query: query.value, kind: kind.value, install: install.value }))
const kindOptions = computed(() => libraryKindOptions(cards.value))
const installOptions = computed(() => libraryInstallOptions(cards.value))
const filtered = computed(() => query.value.trim() !== '' || kind.value !== 'all' || install.value !== 'all')
const countLine = computed(() => {
  if (!cards.value.length) return ''
  const total = `${cards.value.length} ${cards.value.length === 1 ? 'pack' : 'packs'}`
  return filtered.value ? `Showing ${visible.value.length} of ${total}` : total
})

function clearFilters(): void { query.value = ''; kind.value = 'all'; install.value = 'all' }

const detailOpen = ref(false)
const selectedKey = ref('')
const selected = computed(() => cards.value.find(card => card.key === selectedKey.value) ?? null)
// A refresh that withdraws the open pack closes the dialog instead of leaving a
// stale card on screen.
watch(cards, list => { if (detailOpen.value && !list.some(card => card.key === selectedKey.value)) detailOpen.value = false })
function openDetail(card: LibraryPackCard): void { selectedKey.value = card.key; detailOpen.value = true }
</script>

<style scoped>
.pack-browser { display: grid; gap: 12px; }
.pack-browser-top { display: flex; align-items: end; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.pack-search { display: grid; flex: 1 1 260px; gap: 5px; min-width: 0; }
.pack-search-label { color: var(--text-secondary); font-size: var(--font-sm); font-weight: 650; }
.pack-search input { width: 100%; min-height: var(--control-height-md); padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-primary); color: var(--text-primary); font: inherit; }
.pack-search input::placeholder { color: var(--text-muted); }
.pack-search input:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
.pack-browser-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.pack-filter-group { display: flex; flex-wrap: wrap; gap: 6px; }
.pack-chip { display: inline-flex; min-height: var(--control-height-sm); align-items: center; gap: 6px; padding: 5px 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer; font: inherit; font-size: var(--font-sm); font-weight: 650; }
.pack-chip:hover { border-color: var(--border-light); color: var(--text-primary); }
.pack-chip.active { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: var(--accent-dim); color: var(--accent); }
.pack-chip span { color: var(--text-muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
.pack-chip.active span { color: inherit; }
.pack-chip:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

.pack-browser-count, .pack-browser-state { color: var(--text-muted); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }
.pack-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 236px), 1fr)); gap: 14px; }
.pack-list { display: grid; gap: 6px; }
.pack-browser-empty { display: grid; justify-items: start; gap: 7px; padding: 22px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.pack-browser-empty h3 { font-size: var(--font-xl); letter-spacing: -.02em; }
.pack-browser-empty p { color: var(--text-secondary); }

@media (max-width: 620px) { .pack-browser-top { align-items: stretch; flex-direction: column; } /* In a column, a flex-basis of 260px is a HEIGHT — the search box grew 260px tall. */ .pack-search { flex: 0 0 auto; } .pack-browser-actions { justify-content: space-between; } }
@media (max-width: 560px) { .pack-chip { min-height: 44px; } }
</style>
