<template>
  <Modal
    :visible="visible"
    size="xl"
    labelledby="style-library-title"
    dialog-class="style-library-dialog"
    @close="emit('close')"
  >
    <div class="slm-shell">
      <header class="slm-head">
        <div>
          <p class="slm-eyebrow">Visual identity</p>
          <h2 id="style-library-title">Style Library</h2>
          <p>Find a channel look without turning the page into a hundred-card scroll.</p>
        </div>
        <div class="slm-bulk">
          <button
            v-if="!bulkRunning"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="!previewModel || !bulkTargets.length"
            :title="bulkDisabledReason"
            @click="generateAllMissingPreviews"
          >
            Generate previews for all styles without one<span v-if="bulkTargets.length"> ({{ bulkTargets.length }})</span>
          </button>
          <button v-else type="button" class="btn btn-secondary btn-sm" @click="cancelBulkPreviews">Stop</button>
          <p v-if="bulkStatus" class="slm-bulk-status" role="status">{{ bulkStatus }}</p>
        </div>
        <button type="button" class="slm-close" aria-label="Close style library" @click="emit('close')">×</button>
      </header>

      <div class="slm-tools">
        <label class="slm-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref="searchInput"
            v-model="query"
            type="search"
            placeholder="Search styles, media, moods, or techniques…"
            aria-label="Search styles"
          />
        </label>
        <div class="slm-filter-row" aria-label="Style filters">
          <button
            v-for="filter in filters"
            :key="filter.id"
            type="button"
            class="slm-filter"
            :class="{ active: activeFilter === filter.id }"
            @click="activeFilter = filter.id"
          >
            {{ filter.label }} <span>{{ filter.count }}</span>
          </button>
        </div>
      </div>

      <div v-if="hasBrokenPackPreview" class="slm-fallback">
        <span>One or more Content Pack previews could not load.</span>
        <ImageModelPicker
          v-model="previewModel"
          :project-slug="projectSlug"
          class="slm-preview-model"
          default-label="Choose an image model…"
        />
        <select v-if="aspectOptions.length" v-model="previewAspect" class="input input-sm">
          <option v-for="opt in aspectOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
      </div>

      <div v-if="visualStylesLoading && !styles.length" class="slm-empty" aria-live="polite">
        <strong>Loading Content Pack styles…</strong>
      </div>

      <div v-else-if="visualStylesError" class="slm-empty slm-unavailable" role="alert">
        <strong>Content Pack styles are unavailable</strong>
        <span>{{ visualStylesError }}</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="refreshVisualStyles">Retry</button>
      </div>

      <template v-else>
      <div class="slm-results-head">
        <strong>{{ filteredStyles.length }} style{{ filteredStyles.length === 1 ? '' : 's' }}</strong>
        <span v-if="query.trim()">matching “{{ query.trim() }}”</span>
        <span v-else>{{ activeFilterLabel }}</span>
      </div>

      <div class="slm-grid" role="listbox" aria-label="Art styles">
        <article
          v-for="style in filteredStyles"
          :key="style.id"
          class="slm-card"
          :class="{ selected: draftStyleId === style.id }"
          role="option"
          :aria-selected="draftStyleId === style.id"
          tabindex="0"
          @click="draftStyleId = style.id"
          @keydown.enter.prevent="draftStyleId = style.id"
          @keydown.space.prevent="draftStyleId = style.id"
        >
          <div class="slm-image-wrap">
            <img
              v-if="stylePreview(style) && !packPreviewFailed[stylePreview(style)]"
              :src="stylePreview(style)"
              :alt="`${style.name} preview ${previewPage[style.id] ? previewPage[style.id]! + 1 : 1} of ${style.preview_images.length || 1}`"
              loading="lazy"
              decoding="async"
              @error="onPackPreviewError(stylePreview(style))"
            />
            <img
              v-else-if="previewStates[style.id]?.url"
              :src="previewStates[style.id]?.url || ''"
              :alt="`${style.name} preview`"
              loading="lazy"
              decoding="async"
            />
            <div v-else class="slm-image-empty">
              <span>{{ previewStates[style.id]?.progress || 'Preview unavailable' }}</span>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="!previewModel || previewStates[style.id]?.loading"
                @click.stop="generatePreviewFor(style)"
              >
                {{ previewStates[style.id]?.loading ? 'Rendering…' : emptyPreviewActionLabel(style) }}
              </button>
            </div>
            <button
              v-if="style.user_style && style.preview_images.length"
              type="button"
              class="slm-regenerate"
              :disabled="!previewModel || previewStates[style.id]?.loading"
              :aria-label="`Generate new previews for ${style.name}`"
              :title="style.preview_stale ? 'These previews are out of date — generate new ones' : 'Generate new previews'"
              @click.stop="generatePreviewFor(style)"
            >
              ↻
            </button>
            <button
              type="button"
              class="slm-favorite"
              :class="{ active: favoriteIds.has(style.id) }"
              :aria-label="favoriteIds.has(style.id) ? `Remove ${style.name} from favorites` : `Add ${style.name} to favorites`"
              :title="favoriteIds.has(style.id) ? 'Remove from favorites' : 'Add to favorites'"
              @click.stop="toggleFavorite(style.id)"
            >
              {{ favoriteIds.has(style.id) ? '★' : '☆' }}
            </button>
            <span v-if="draftStyleId === style.id" class="slm-selected-mark">Selected</span>
            <span v-if="style.user_style" class="slm-own-mark">Your style</span>
            <span v-if="style.preview_stale" class="slm-stale-mark">Out of date</span>
            <div v-if="style.preview_images.length > 1" class="slm-preview-dots" aria-label="Style previews">
              <button
                v-for="(_, index) in style.preview_images"
                :key="index"
                type="button"
                :class="{ active: (previewPage[style.id] || 0) === index }"
                :aria-label="`Show ${style.name} preview ${index + 1}`"
                @click.stop="previewPage = { ...previewPage, [style.id]: index }"
              />
            </div>
          </div>
          <div class="slm-card-copy">
            <div class="slm-card-title">
              <h3>{{ style.name }}</h3>
              <span>{{ style.category }}</span>
            </div>
            <p>{{ style.blurb }}</p>
            <div class="slm-tags">
              <span v-for="tag in style.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
            </div>
            <p v-if="style.preview_stale" class="slm-stale-note">
              These previews were made before this style was last edited.
            </p>
            <p v-if="previewStates[style.id]?.progress" class="slm-progress" role="status">{{ previewStates[style.id]?.progress }}</p>
            <p v-if="previewStates[style.id]?.error" class="slm-error">{{ previewStates[style.id]?.error }}</p>
          </div>
        </article>

        <div v-if="!styles.length" class="slm-empty">
          <strong>No Content Pack styles installed</strong>
          <span>Install a Visual Style from the Studio Library to add it here.</span>
          <NuxtLink to="/library" class="btn btn-secondary btn-sm">Open Studio Library</NuxtLink>
        </div>

        <div v-else-if="!filteredStyles.length" class="slm-empty">
          <strong>No styles found</strong>
          <span>Try a broader search or choose All styles.</span>
          <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">Clear Filters</button>
        </div>
      </div>
      </template>

      <footer class="slm-footer">
        <div class="slm-selection">
          <img v-if="draftStyle?.preview_image" :src="draftStyle.preview_image" alt="" />
          <div>
            <span>{{ draftStyle ? 'Ready to use' : 'Choose a style' }}</span>
            <strong>{{ draftStyle?.name || 'No style selected' }}</strong>
          </div>
        </div>
        <div class="slm-actions">
          <button type="button" class="btn btn-secondary" @click="emit('close')">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="!draftStyle" @click="confirmSelection">
            {{ actionLabel }}
          </button>
        </div>
      </footer>
    </div>
  </Modal>
</template>

<script setup lang="ts">
import { type VisualStyleCatalogItem, useVisualStyleCatalog } from '~/composables/useVisualStyleCatalog'
import { selectLiveGenStudioModel } from '~/utils/live-genstudio-model-selection'
import {
  runPreviewQueue,
  userStylesNeedingPreviews,
  type PreviewQueueEntry,
} from '~/utils/style-preview-queue'

const props = withDefaults(defineProps<{
  visible: boolean
  projectSlug: string
  selectedStyleId?: string
  actionLabel?: string
}>(), {
  selectedStyleId: '',
  actionLabel: 'Apply selected style',
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', style: VisualStyleCatalogItem): void
}>()

const { post } = useApi()
const {
  styles,
  loading: visualStylesLoading,
  error: visualStylesError,
  refresh: refreshVisualStyles,
} = useVisualStyleCatalog()
const { models: genStudioImageModels, refresh: refreshGenStudioImageModels } = useGenStudioImageModels()
const FAVORITES_KEY = 'story-studio:style-library:favorites'
const RECENTS_KEY = 'story-studio:style-library:recents'
/**
 * The image model the owner last chose for style previews, restored before the
 * picker mounts (never a remembered price tier, never a hardcoded model). A
 * choice that has left the live Gateway falls to a usable one, and that healed
 * choice is written back, so the next open starts from a model that exists.
 */
const PREVIEW_MODEL_KEY = 'story-studio:style-library:preview-model'
const categories = computed(() => Array.from(new Set(styles.value.map(style => style.category))).sort())

/** The three previews every style shows, in the order the pager reads them. */
const PREVIEW_SLOTS = ['hero', 'scene', 'face'] as const
type PreviewSlot = typeof PREVIEW_SLOTS[number]
/**
 * What each image is, in the owner's own words
 * (`content-packs/PREVIEW-BACKFILL-2026-09-08.md`): the shot the style exists
 * for, a quiet wide scene with no figure in it, and the hardest legal case.
 */
const PREVIEW_SLOT_LABELS: Record<PreviewSlot, string> = {
  hero: 'the hero shot',
  scene: 'the empty scene',
  face: 'the hardest case',
}

interface PreviewState {
  loading: boolean
  url: string | null
  error: string | null
  /** What is rendering now, e.g. "Rendering the empty scene — 2 of 3". */
  progress: string
  /** Every image the last run could not make, named with its own reason (§8). */
  failures: Array<{ slot: string; error: string }>
}

const EMPTY_PREVIEW_STATE: PreviewState = {
  loading: false, url: null, error: null, progress: '', failures: [],
}

const query = ref('')
const activeFilter = ref('all')
const draftStyleId = ref('')
const favoriteIds = ref(new Set<string>())
const recentIds = ref<string[]>([])
/** Keyed by preview URL: one broken image never hides a style's other previews. */
const packPreviewFailed = ref<Record<string, boolean>>({})
/** Which preview each card shows; the hero (0) until the customer pages. */
const previewPage = ref<Record<string, number>>({})
const previewStates = ref<Record<string, PreviewState>>({})
const previewModel = ref('')
const previewAspect = ref('16:9')
const searchInput = ref<HTMLInputElement | null>(null)
/** The bulk action runs ONE style at a time; a stop is honoured between styles. */
const bulkRunning = ref(false)
const bulkCancelled = ref(false)
const bulkStatus = ref('')

const selectedImageModel = computed(() =>
  genStudioImageModels.value.find(model => model.id === previewModel.value),
)
// Published ratios only. A model that publishes none gets NO ratio control
// rather than an invented '16:9' the customer would take for the model's own.
const aspectOptions = computed<string[]>(() => selectedImageModel.value?.aspect_ratios?.filter(Boolean) || [])
const hasBrokenPackPreview = computed(() => Object.keys(packPreviewFailed.value).length > 0)
const draftStyle = computed(() => styles.value.find(style => style.id === draftStyleId.value) || null)
/** The owner's own styles with no current previews — what the bulk action is for. */
const bulkTargets = computed(() => userStylesNeedingPreviews(styles.value))
const bulkDisabledReason = computed(() => {
  if (!previewModel.value) return 'Choose an image model first'
  if (!bulkTargets.value.length) return 'Every one of your own styles already has previews'
  return `Render the missing previews for ${bulkTargets.value.length} of your own styles, one at a time`
})
const filters = computed(() => [
  { id: 'all', label: 'All styles', count: styles.value.length },
  { id: 'favorites', label: 'Favorites', count: styles.value.filter(style => favoriteIds.value.has(style.id)).length },
  { id: 'recent', label: 'Recent', count: styles.value.filter(style => recentIds.value.includes(style.id)).length },
  ...categories.value.map(category => ({
    id: `category:${category}`,
    label: category,
    count: styles.value.filter(style => style.category === category).length,
  })),
])
const activeFilterLabel = computed(() => filters.value.find(filter => filter.id === activeFilter.value)?.label || 'All styles')
const filteredStyles = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  let matchingStyles = styles.value.filter((style) => {
    if (activeFilter.value === 'favorites' && !favoriteIds.value.has(style.id)) return false
    if (activeFilter.value === 'recent' && !recentIds.value.includes(style.id)) return false
    if (activeFilter.value.startsWith('category:') && style.category !== activeFilter.value.slice(9)) return false
    if (!terms.length) return true
    const haystack = [style.name, style.blurb, style.category, ...style.tags, style.data.style_bible]
      .join(' ')
      .toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
  if (activeFilter.value === 'recent') {
    const order = new Map(recentIds.value.map((id, index) => [id, index]))
    matchingStyles = matchingStyles.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
  }
  return matchingStyles
})

watch(() => props.visible, async (visible) => {
  if (!visible) return
  draftStyleId.value = props.selectedStyleId || recentIds.value[0] || ''
  query.value = ''
  activeFilter.value = 'all'
  await nextTick()
  searchInput.value?.focus({ preventScroll: true })
})
watch(genStudioImageModels, (models) => {
  previewModel.value = selectLiveGenStudioModel(previewModel.value, models)?.id || ''
}, { immediate: true, deep: true })
watch([selectedImageModel, aspectOptions], ([model, aspects]) => {
  if (!model || !aspects.length || aspects.includes(previewAspect.value)) return
  // The model's OWN published default, never a hardcoded '16:9'.
  previewAspect.value = aspects.includes(model.default_aspect_ratio)
    ? model.default_aspect_ratio
    : aspects[0]!
}, { immediate: true })

watch(previewModel, (modelId) => {
  // Every change is written — the owner's own pick, and the healed one when a
  // remembered model has left the live Gateway.
  if (!modelId) return
  try {
    localStorage.setItem(PREVIEW_MODEL_KEY, JSON.stringify(modelId))
  } catch { /* a locked-down profile keeps the choice for this session only */ }
})

onMounted(() => {
  favoriteIds.value = new Set(readStoredIds(FAVORITES_KEY))
  recentIds.value = readStoredIds(RECENTS_KEY).slice(0, 8)
  // Before the picker is used, and before the catalogue arrives: the last
  // explicit choice is what the customer sees first, not a model this app
  // picked for them.
  previewModel.value = readStoredPreviewModel()
  void refreshGenStudioImageModels()
  void refreshVisualStyles()
})

function readStoredIds(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
  } catch {
    return []
  }
}

function readStoredPreviewModel(): string {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREVIEW_MODEL_KEY) || '""')
    return typeof parsed === 'string' ? parsed : ''
  } catch {
    return ''
  }
}

function toggleFavorite(id: string): void {
  const next = new Set(favoriteIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  favoriteIds.value = next
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]))
}

function confirmSelection(): void {
  if (!draftStyle.value) return
  const next = [draftStyle.value.id, ...recentIds.value.filter(id => id !== draftStyle.value!.id)].slice(0, 8)
  recentIds.value = next
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  emit('select', draftStyle.value)
  emit('close')
}

function resetFilters(): void {
  query.value = ''
  activeFilter.value = 'all'
}

function onPackPreviewError(url: string): void {
  packPreviewFailed.value = { ...packPreviewFailed.value, [url]: true }
}

function stylePreview(style: VisualStyleCatalogItem): string {
  const images = style.preview_images.length ? style.preview_images : (style.preview_image ? [style.preview_image] : [])
  return images[previewPage.value[style.id] || 0] || images[0] || ''
}

function emptyPreviewActionLabel(style: VisualStyleCatalogItem): string {
  if (!style.user_style) return 'Generate Preview'
  const state = previewStates.value[style.id]
  if (state?.failures?.length) return `Retry ${state.failures.length} missing`
  return 'Generate previews'
}

/**
 * Generate previews for one style.
 *
 * For the owner's own styles (user style packs), this makes the three images
 * (hero, empty scene, hardest legal case), reports progress per image, saves
 * each on disk, and on partial failure a retry only asks for what is still
 * missing (§8). For a signed style whose preview failed to load, it falls back
 * to the single-proof route the modal previously used.
 */
async function generatePreviewFor(style: VisualStyleCatalogItem): Promise<void> {
  if (!previewModel.value) return
  if (!style.user_style) {
    await generateSignedStyleProof(style)
    return
  }
  await generateUserStylePreviewsFor(style)
}

async function generateSignedStyleProof(style: VisualStyleCatalogItem): Promise<void> {
  previewStates.value[style.id] = {
    loading: true, url: null, error: null, progress: 'Rendering style proof…', failures: [],
  }
  try {
    const data = await post<{ url: string }>(`/projects/${props.projectSlug}/style-preview`, {
      style_tag: style.data.style_bible,
      model: previewModel.value,
      aspect_ratio: previewAspect.value,
      variant_id: 'style-proof',
    })
    previewStates.value[style.id] = {
      loading: false, url: data.url, error: null, progress: '', failures: [],
    }
  } catch (error: any) {
    previewStates.value[style.id] = {
      loading: false,
      url: null,
      error: error?.data?.detail || error?.message || 'Preview failed',
      progress: '',
      failures: [],
    }
  }
}

/**
 * Render the missing previews for one of the owner's own styles.
 *
 * It queues the missing slots one at a time, shows which image is rendering
 * right now, and reports every failure BY NAME (§8). When a slot fails, retry
 * asks only for that slot.
 */
async function generateUserStylePreviewsFor(style: VisualStyleCatalogItem, force = false): Promise<void> {
  const currentImages = style.preview_images || []
  // Which slots are missing. An edited style whose previews are stale re-renders
  // all three; an unstale style only renders what has never succeeded.
  const targetSlots: PreviewSlot[] = style.preview_stale || force
    ? [...PREVIEW_SLOTS]
    : PREVIEW_SLOTS.filter((_, index) => !currentImages[index])
  if (!targetSlots.length) return

  previewStates.value[style.id] = {
    loading: true,
    url: null,
    error: null,
    progress: `Starting ${targetSlots.length} preview${targetSlots.length === 1 ? '' : 's'}…`,
    failures: [],
  }

  const failures: Array<{ slot: string; error: string }> = []
  for (const [position, slot] of targetSlots.entries()) {
    const slotNumber = position + 1
    const slotLabel = PREVIEW_SLOT_LABELS[slot]
    previewStates.value[style.id] = {
      loading: true,
      url: null,
      error: null,
      progress: `Rendering ${slotLabel} (${slotNumber} of ${targetSlots.length})…`,
      failures,
    }
    try {
      const response = await post<{
        images: string[]
        generated: string[]
        skipped: string[]
        failed: Array<{ slot: string; error: string }>
        stale: boolean
      }>(`/user-style-previews/${encodeURIComponent(style.id)}/generate`, {
        model: previewModel.value,
        aspect_ratio: previewAspect.value,
        slots: [slot],
        force,
      })
      if (response.failed?.length) {
        failures.push(...response.failed)
      }
    } catch (error: any) {
      failures.push({
        slot,
        error: error?.data?.detail || error?.message || `Could not render ${slotLabel}`,
      })
    }
  }

  // Refresh the catalog so the new previews become reactive throughout the app.
  await refreshVisualStyles()

  if (failures.length) {
    const list = failures.map(f => `${PREVIEW_SLOT_LABELS[f.slot as PreviewSlot] || f.slot}: ${f.error}`).join('; ')
    previewStates.value[style.id] = {
      loading: false,
      url: null,
      error: `${failures.length} of ${targetSlots.length} image${failures.length === 1 ? '' : 's'} failed (${list}). Click Retry to render only the missing ones.`,
      progress: '',
      failures,
    }
  } else {
    previewStates.value[style.id] = {
      loading: false, url: null, error: null, progress: '', failures: [],
    }
  }
}

/**
 * Bulk action: generate previews for every one of the owner's styles that lacks
 * them, queueing one style at a time, cancellable.
 */
async function generateAllMissingPreviews(): Promise<void> {
  if (bulkRunning.value || !previewModel.value) return
  const targets = [...bulkTargets.value]
  if (!targets.length) return

  bulkRunning.value = true
  bulkCancelled.value = false
  bulkStatus.value = `Starting previews for ${targets.length} style${targets.length === 1 ? '' : 's'}…`

  const entries: PreviewQueueEntry[] = targets.map(style => ({
    key: style.id,
    label: style.name,
  }))

  const outcome = await runPreviewQueue({
    entries,
    isCancelled: () => bulkCancelled.value,
    async generate(entry) {
      const target = styles.value.find(s => s.id === entry.key)
      if (!target) return
      await generateUserStylePreviewsFor(target)
      const failed = previewStates.value[target.id]?.failures?.length
      if (failed) {
        throw new Error(`${failed} image${failed === 1 ? '' : 's'} could not render`)
      }
    },
    onProgress(progress) {
      bulkStatus.value = `Rendering ${progress.entry.label} (${progress.index} of ${progress.total})…`
    },
  })

  bulkRunning.value = false
  if (outcome.cancelled) {
    bulkStatus.value = `Stopped. ${outcome.completed.length} completed, ${outcome.notStarted.length} skipped.`
  } else if (outcome.failed.length) {
    bulkStatus.value = `Finished with ${outcome.failed.length} failure${outcome.failed.length === 1 ? '' : 's'} (${outcome.completed.length} succeeded).`
  } else {
    bulkStatus.value = `All ${outcome.completed.length} style${outcome.completed.length === 1 ? '' : 's'} now have previews.`
  }
}

function cancelBulkPreviews(): void {
  if (!bulkRunning.value) return
  bulkCancelled.value = true
  bulkStatus.value = 'Stopping after the current image finishes…'
}
</script>

<style scoped>
.slm-shell { display: flex; min-height: min(760px, calc(100vh - 96px)); flex-direction: column; gap: 16px; }
.slm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.slm-bulk { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.slm-bulk-status { margin: 0; color: var(--text-muted); font-size: var(--font-xs); }
.slm-own-mark { position: absolute; left: 7px; top: 7px; padding: 3px 7px; border-radius: 999px; background: rgba(10, 12, 18, .76); color: var(--accent); border: 1px solid var(--accent); font-size: var(--font-xs); font-weight: 800; letter-spacing: .06em; text-transform: uppercase; backdrop-filter: blur(8px); }
.slm-stale-mark { position: absolute; left: 7px; bottom: 7px; padding: 3px 7px; border-radius: 999px; background: rgba(220, 110, 20, .9); color: #fff; font-size: var(--font-xs); font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.slm-regenerate { position: absolute; top: 7px; right: 42px; width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.24); border-radius: 50%; background: rgba(10,12,18,.72); color: white; cursor: pointer; font-size: 15px; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(8px); }
.slm-regenerate:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.slm-regenerate:disabled { opacity: .4; cursor: not-allowed; }
.slm-progress { color: var(--accent) !important; font-size: var(--font-xs); }
.slm-stale-note { color: var(--warning, #e6a23c) !important; font-size: var(--font-xs); }
.slm-head h2 { margin: 2px 0 5px; font-size: clamp(24px, 3vw, 34px); letter-spacing: -.035em; }
.slm-head p { margin: 0; color: var(--text-secondary); font-size: 13px; }
.slm-eyebrow { color: var(--accent) !important; font-size: var(--font-xs) !important; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.slm-close { width: 36px; height: 36px; border: 1px solid var(--border); border-radius: 50%; background: var(--bg-tertiary); color: var(--text-secondary); cursor: pointer; font-size: 22px; line-height: 1; }
.slm-close:hover { border-color: var(--accent); color: var(--text-primary); }
.slm-tools { display: grid; gap: 10px; }
.slm-search { display: flex; min-height: 44px; align-items: center; gap: 10px; padding: 0 13px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-primary); color: var(--text-muted); }
.slm-search:focus-within { border-color: var(--accent); box-shadow: var(--focus-ring); }
.slm-search input { width: 100%; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: inherit; }
.slm-filter-row { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }
.slm-filter { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 6px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; font: inherit; font-size: var(--font-xs); }
.slm-filter span { color: var(--text-muted); font-size: var(--font-xs); }
.slm-filter:hover, .slm-filter.active { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); color: var(--text-primary); }
.slm-filter.active { background: var(--accent-dim); color: var(--accent); }
.slm-fallback { display: grid; grid-template-columns: auto minmax(220px, 1fr) 86px; align-items: center; gap: 10px; padding: 10px; border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--warning) 7%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-xs); }
.slm-preview-model { min-width: 0; }
.slm-results-head { display: flex; align-items: baseline; gap: 6px; color: var(--text-muted); font-size: var(--font-xs); }
.slm-results-head strong { color: var(--text-primary); font-size: 12px; }
.slm-grid { display: grid; flex: 1; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; align-content: start; max-height: min(510px, calc(100vh - 330px)); overflow-y: auto; padding: 2px 5px 8px 2px; scrollbar-width: thin; }
.slm-card { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-primary); cursor: pointer; transition: border-color .16s ease, transform .16s ease, box-shadow .16s ease; }
.slm-card:hover { transform: translateY(-2px); border-color: var(--border-light); box-shadow: 0 12px 30px rgba(0,0,0,.16); }
.slm-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.slm-card.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent), 0 10px 28px var(--accent-dim); }
.slm-image-wrap { position: relative; aspect-ratio: 16 / 9; overflow: hidden; background: var(--bg-tertiary); }
.slm-image-wrap > img { width: 100%; height: 100%; display: block; object-fit: cover; transition: transform .2s ease; }
.slm-card:hover .slm-image-wrap > img { transform: scale(1.025); }
.slm-preview-dots { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 6px; padding: 4px 6px; border-radius: 999px; background: rgba(10, 12, 18, .55); }
.slm-preview-dots button { width: 8px; height: 8px; padding: 0; border: 0; border-radius: 50%; background: rgba(255, 255, 255, .55); cursor: pointer; }
.slm-preview-dots button.active { background: #fff; transform: scale(1.2); }
.slm-image-empty { display: flex; height: 100%; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--text-muted); font-size: var(--font-xs); }
.slm-favorite { position: absolute; top: 7px; right: 7px; width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.24); border-radius: 50%; background: rgba(10,12,18,.72); color: white; cursor: pointer; font-size: 16px; backdrop-filter: blur(8px); }
.slm-favorite.active { color: var(--accent); }
.slm-selected-mark { position: absolute; left: 7px; bottom: 7px; padding: 4px 7px; border-radius: 999px; background: var(--accent); color: var(--accent-on); font-size: var(--font-xs); font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.slm-card-copy { display: grid; gap: 7px; padding: 11px; }
.slm-card-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.slm-card-title h3 { margin: 0; font-size: 13px; line-height: 1.35; }
.slm-card-title > span { flex: 0 0 auto; color: var(--accent); font-size: var(--font-xs); font-weight: 750; letter-spacing: .04em; text-transform: uppercase; }
.slm-card-copy > p { display: -webkit-box; min-height: 34px; margin: 0; overflow: hidden; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.slm-tags { display: flex; gap: 5px; overflow: hidden; }
.slm-tags span { flex: 0 0 auto; padding: 3px 6px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-muted); font-size: var(--font-xs); }
.slm-error { color: var(--error) !important; }
.slm-empty { grid-column: 1 / -1; display: flex; min-height: 220px; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--text-muted); text-align: center; }
.slm-empty strong { color: var(--text-primary); }
.slm-footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.slm-selection { display: flex; min-width: 0; align-items: center; gap: 10px; }
.slm-selection img { width: 64px; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid var(--border); border-radius: 7px; }
.slm-selection div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.slm-selection span { color: var(--text-muted); font-size: var(--font-xs); letter-spacing: .07em; text-transform: uppercase; }
.slm-selection strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.slm-actions { display: flex; flex: 0 0 auto; gap: 8px; }
@media (max-width: 720px) {
  .slm-shell { min-height: calc(100vh - 72px); }
  .slm-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: calc(100vh - 350px); }
  .slm-fallback { grid-template-columns: 1fr; }
  .slm-footer { align-items: stretch; flex-direction: column; }
  .slm-actions .btn { flex: 1; }
}
@media (max-width: 480px) {
  .slm-grid { grid-template-columns: 1fr; }
}
</style>
