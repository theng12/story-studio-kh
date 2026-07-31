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

      <div v-if="hasBrokenBundledPreview" class="slm-fallback">
        <span>One or more bundled previews could not load.</span>
        <ImageModelPicker
          v-model="previewModel"
          :project-slug="projectSlug"
          class="slm-preview-model"
          default-label="Choose a GenStudio image model…"
        />
        <select v-model="previewAspect" class="input input-sm">
          <option v-for="opt in aspectOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
      </div>

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
              v-if="style.preview_image && !bundledFailed[style.id]"
              :src="style.preview_image"
              :alt="`${style.name} preview`"
              loading="lazy"
              decoding="async"
              @error="onBundledPreviewError(style.id)"
            />
            <img
              v-else-if="previewStates[style.id]?.url"
              :src="previewStates[style.id]?.url || ''"
              :alt="`${style.name} preview`"
              loading="lazy"
              decoding="async"
            />
            <div v-else class="slm-image-empty">
              <span>Preview unavailable</span>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="!previewModel || previewStates[style.id]?.loading"
                @click.stop="generatePreview(style)"
              >
                {{ previewStates[style.id]?.loading ? 'Rendering…' : 'Generate preview' }}
              </button>
            </div>
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
            <p v-if="previewStates[style.id]?.error" class="slm-error">{{ previewStates[style.id]?.error }}</p>
          </div>
        </article>

        <div v-if="!filteredStyles.length" class="slm-empty">
          <strong>No styles found</strong>
          <span>Try a broader search or choose All styles.</span>
          <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">Clear filters</button>
        </div>
      </div>

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
import { BUILT_IN_STYLES, type BuiltInStyle } from '~/composables/useBuiltInStyles'

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
  (e: 'select', style: BuiltInStyle): void
}>()

const { post } = useApi()
const { models: genStudioImageModels, refresh: refreshGenStudioImageModels } = useGenStudioImageModels()
const FAVORITES_KEY = 'story-studio:style-library:favorites'
const RECENTS_KEY = 'story-studio:style-library:recents'
const categories = Array.from(new Set(BUILT_IN_STYLES.map(style => style.category))).sort()

interface PreviewState {
  loading: boolean
  url: string | null
  error: string | null
}

const query = ref('')
const activeFilter = ref('all')
const draftStyleId = ref('')
const favoriteIds = ref(new Set<string>())
const recentIds = ref<string[]>([])
const bundledFailed = ref<Record<string, boolean>>({})
const previewStates = ref<Record<string, PreviewState>>({})
const previewModel = ref('')
const previewAspect = ref('16:9')
const searchInput = ref<HTMLInputElement | null>(null)

const selectedImageModel = computed(() =>
  genStudioImageModels.value.find(model => model.id === previewModel.value),
)
const aspectOptions = computed(() => {
  const supported = selectedImageModel.value?.aspect_ratios?.filter(Boolean) || []
  return supported.length ? supported : ['16:9']
})
const hasBrokenBundledPreview = computed(() => Object.keys(bundledFailed.value).length > 0)
const draftStyle = computed(() => BUILT_IN_STYLES.find(style => style.id === draftStyleId.value) || null)
const filters = computed(() => [
  { id: 'all', label: 'All styles', count: BUILT_IN_STYLES.length },
  { id: 'favorites', label: 'Favorites', count: favoriteIds.value.size },
  { id: 'recent', label: 'Recent', count: recentIds.value.length },
  ...categories.map(category => ({
    id: `category:${category}`,
    label: category,
    count: BUILT_IN_STYLES.filter(style => style.category === category).length,
  })),
])
const activeFilterLabel = computed(() => filters.value.find(filter => filter.id === activeFilter.value)?.label || 'All styles')
const filteredStyles = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  let styles = BUILT_IN_STYLES.filter((style) => {
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
    styles = styles.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
  }
  return styles
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
  if (models.some(model => model.id === previewModel.value && model.available)) return
  previewModel.value = models.find(model => model.available)?.id || ''
}, { immediate: true, deep: true })
watch([selectedImageModel, aspectOptions], ([model, aspects]) => {
  if (!model || aspects.includes(previewAspect.value)) return
  previewAspect.value = aspects.includes(model.default_aspect_ratio)
    ? model.default_aspect_ratio
    : aspects[0] || '16:9'
}, { immediate: true })

onMounted(() => {
  favoriteIds.value = new Set(readStoredIds(FAVORITES_KEY))
  recentIds.value = readStoredIds(RECENTS_KEY).slice(0, 8)
  void refreshGenStudioImageModels()
})

function readStoredIds(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(parsed) ? parsed.filter(id => BUILT_IN_STYLES.some(style => style.id === id)) : []
  } catch {
    return []
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

function onBundledPreviewError(id: string): void {
  bundledFailed.value = { ...bundledFailed.value, [id]: true }
}

async function generatePreview(style: BuiltInStyle): Promise<void> {
  if (!previewModel.value) return
  previewStates.value[style.id] = { loading: true, url: null, error: null }
  try {
    const data = await post<{ url: string }>(`/projects/${props.projectSlug}/style-preview`, {
      style_tag: style.data.style_bible,
      model: previewModel.value,
      aspect_ratio: previewAspect.value,
      variant_id: 'style-proof',
    })
    previewStates.value[style.id] = { loading: false, url: data.url, error: null }
  } catch (error: any) {
    previewStates.value[style.id] = {
      loading: false,
      url: null,
      error: error?.data?.detail || error?.message || 'Preview failed',
    }
  }
}
</script>

<style scoped>
.slm-shell { display: flex; min-height: min(760px, calc(100vh - 96px)); flex-direction: column; gap: 16px; }
.slm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
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
