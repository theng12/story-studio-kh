<template>
  <Modal
    :visible="visible"
    size="xl"
    labelledby="thumbnail-recipe-library-title"
    dialog-class="recipe-library-dialog"
    @close="emit('close')"
  >
    <div class="rlm-shell">
      <header class="rlm-head">
        <div>
          <p class="rlm-eyebrow">Thumbnail format</p>
          <h2 id="thumbnail-recipe-library-title">Thumbnail Recipe Library</h2>
          <p>Browse reusable composition systems without turning the prompt page into a hundred-card scroll.</p>
        </div>
        <button type="button" class="rlm-close" aria-label="Close thumbnail recipe library" @click="emit('close')">×</button>
      </header>

      <div class="rlm-tools">
        <label class="rlm-search">
          <span aria-hidden="true">⌕</span>
          <input ref="searchInput" v-model="query" type="search" placeholder="Search formats, subjects, layouts, or tags…" aria-label="Search thumbnail recipes" />
        </label>
        <div class="rlm-filter-row" aria-label="Thumbnail recipe filters">
          <button v-for="filter in filters" :key="filter.id" type="button" class="rlm-filter" :class="{ active: activeFilter === filter.id }" @click="activeFilter = filter.id">
            {{ filter.label }} <span>{{ filter.count }}</span>
          </button>
        </div>
      </div>

      <div v-if="loading" class="rlm-status">Loading thumbnail recipes…</div>
      <template v-else>
        <div class="rlm-results-head">
          <strong>{{ filteredRecipes.length }} recipe{{ filteredRecipes.length === 1 ? '' : 's' }}</strong>
          <span v-if="query.trim()">matching “{{ query.trim() }}”</span>
          <span v-else>{{ activeFilterLabel }}</span>
        </div>

        <div v-if="filteredRecipes.length" class="rlm-grid" role="listbox" aria-label="Thumbnail recipes">
          <article
            v-for="recipe in filteredRecipes"
            :key="recipe.id"
            class="rlm-card"
            :class="{ selected: draftId === recipe.id }"
            role="option"
            :aria-selected="draftId === recipe.id"
            tabindex="0"
            @click="draftId = recipe.id"
            @keydown.enter.prevent="draftId = recipe.id"
            @keydown.space.prevent="draftId = recipe.id"
          >
            <div class="rlm-image-wrap">
              <img :src="previewSrc(recipe)" :alt="previewAlt(recipe, previewIndex(recipe.id))" loading="lazy" decoding="async" />
              <div v-if="recipe.previewImages && recipe.previewImages.length > 1" class="rlm-preview-dots" aria-label="Recipe examples">
                <button v-for="(_, index) in recipe.previewImages" :key="index" type="button" :class="{ active: previewIndex(recipe.id) === index }" :aria-label="`Show example ${index + 1}`" @click.stop="setPreview(recipe.id, index)" />
              </div>
              <button type="button" class="rlm-favorite" :class="{ active: favoriteIds.has(recipe.id) }" :aria-label="favoriteIds.has(recipe.id) ? `Remove ${recipe.name} from favorites` : `Add ${recipe.name} to favorites`" :title="favoriteIds.has(recipe.id) ? 'Remove from favorites' : 'Add to favorites'" @click.stop="toggleFavorite(recipe.id)">
                {{ favoriteIds.has(recipe.id) ? '★' : '☆' }}
              </button>
              <span v-if="draftId === recipe.id" class="rlm-selected-mark">Selected</span>
            </div>
            <div class="rlm-card-copy">
              <div class="rlm-card-title">
                <h3>{{ recipe.name }}</h3>
                <span>{{ recipe.category || 'Format' }}</span>
              </div>
              <p>{{ recipe.description }}</p>
              <div class="rlm-tags">
                <span v-for="tag in recipe.tags?.slice(0, 3) || []" :key="tag">{{ tag }}</span>
              </div>
            </div>
          </article>
        </div>
        <div v-else class="rlm-empty">
          <strong>No thumbnail recipes found</strong>
          <span>Try a broader search or choose All recipes.</span>
          <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">Clear Filters</button>
        </div>
      </template>

      <footer class="rlm-footer">
        <div class="rlm-selection">
          <img v-if="selectedRecipe" :src="previewSrc(selectedRecipe)" alt="" />
          <div>
            <span>{{ selectedRecipe ? previewStatus(selectedRecipe, previewIndex(selectedRecipe.id)) : 'Choose a recipe' }}</span>
            <strong>{{ selectedRecipe?.name || 'No recipe selected' }}</strong>
          </div>
        </div>
        <div class="rlm-actions">
          <button type="button" class="btn btn-secondary" @click="emit('close')">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="!selectedRecipe" @click="confirmSelection">Apply Selected Recipe</button>
        </div>
      </footer>
    </div>
  </Modal>
</template>

<script setup lang="ts">
interface ThumbnailRecipe {
  id: string
  name: string
  description: string
  category?: string
  tags?: string[]
  previewImages?: string[]
  recipe?: {
    layout?: string
    titleMode?: 'ai'
    headlineMode?: 'episode-title' | 'curiosity-hook'
    defaultTextStyle?: string
    defaultFontStyle?: string
    defaultTextPosition?: 'top' | 'center' | 'bottom' | 'bottom-left'
    headlineFormats?: string[]
    conceptGuidance?: string
  }
}

const props = defineProps<{ visible: boolean; selectedRecipeId?: string }>()
const emit = defineEmits<{ select: [recipe: ThumbnailRecipe]; close: [] }>()
const { get } = useApi()
const FAVORITES_KEY = 'story-studio:thumbnail-recipe-library:favorites'
const RECENTS_KEY = 'story-studio:thumbnail-recipe-library:recents'

const recipes = ref<ThumbnailRecipe[]>([])
const loading = ref(false)
const query = ref('')
const activeFilter = ref('all')
const draftId = ref('')
const previews = ref<Record<string, number>>({})
const favoriteIds = ref(new Set<string>())
const recentIds = ref<string[]>([])
const searchInput = ref<HTMLInputElement | null>(null)

const categories = computed(() => [...new Set(recipes.value.map(recipe => recipe.category).filter(Boolean) as string[])].sort())
const filters = computed(() => [
  { id: 'all', label: 'All recipes', count: recipes.value.length },
  { id: 'favorites', label: 'Favorites', count: favoriteIds.value.size },
  { id: 'recent', label: 'Recent', count: recentIds.value.length },
  ...categories.value.map(category => ({ id: `category:${category}`, label: category, count: recipes.value.filter(recipe => recipe.category === category).length })),
])
const activeFilterLabel = computed(() => filters.value.find(filter => filter.id === activeFilter.value)?.label || 'All recipes')
const filteredRecipes = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  let results = recipes.value.filter(recipe => {
    if (activeFilter.value === 'favorites' && !favoriteIds.value.has(recipe.id)) return false
    if (activeFilter.value === 'recent' && !recentIds.value.includes(recipe.id)) return false
    if (activeFilter.value.startsWith('category:') && recipe.category !== activeFilter.value.slice(9)) return false
    if (!terms.length) return true
    const haystack = [recipe.name, recipe.description, recipe.category, ...(recipe.tags || []), recipe.recipe?.layout, recipe.recipe?.conceptGuidance].filter(Boolean).join(' ').toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
  if (activeFilter.value === 'recent') {
    const order = new Map(recentIds.value.map((id, index) => [id, index]))
    results = results.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
  }
  return results
})
const selectedRecipe = computed(() => recipes.value.find(recipe => recipe.id === draftId.value) || null)

function previewIndex(id: string): number { return previews.value[id] || 0 }
function setPreview(id: string, index: number): void { previews.value = { ...previews.value, [id]: index } }
function previewSrc(recipe: ThumbnailRecipe): string {
  const images = recipe.previewImages || []
  return images[previewIndex(recipe.id)] || `/api/thumbnail-templates/${encodeURIComponent(recipe.id)}/preview.png`
}
function hasGeneratedExample(recipe: ThumbnailRecipe, index = 0): boolean {
  return Boolean(recipe.previewImages?.[index])
}
function previewAlt(recipe: ThumbnailRecipe, index = 0): string {
  if (!hasGeneratedExample(recipe, index)) return `${recipe.name} layout placeholder; no generated example available`
  const count = recipe.previewImages?.length || 0
  return count > 1
    ? `${recipe.name} generated thumbnail example ${index + 1} of ${count}`
    : `${recipe.name} generated thumbnail example`
}
function previewStatus(recipe: ThumbnailRecipe, index = 0): string {
  return hasGeneratedExample(recipe, index) ? 'Generated examples included' : 'Layout placeholder · no generated examples yet'
}
function readStoredIds(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []
  } catch { return [] }
}
function toggleFavorite(id: string): void {
  const next = new Set(favoriteIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  favoriteIds.value = next
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]))
}
function confirmSelection(): void {
  if (!selectedRecipe.value) return
  recentIds.value = [selectedRecipe.value.id, ...recentIds.value.filter(id => id !== selectedRecipe.value!.id)].slice(0, 8)
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recentIds.value))
  emit('select', selectedRecipe.value)
}
function resetFilters(): void { query.value = ''; activeFilter.value = 'all' }
async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await get<{ templates: ThumbnailRecipe[] }>('/thumbnail-templates')
    recipes.value = (result.templates || []).filter(template => Boolean(template.recipe))
    favoriteIds.value = new Set([...favoriteIds.value].filter(id => recipes.value.some(recipe => recipe.id === id)))
    recentIds.value = recentIds.value.filter(id => recipes.value.some(recipe => recipe.id === id))
    draftId.value = props.selectedRecipeId && recipes.value.some(recipe => recipe.id === props.selectedRecipeId)
      ? props.selectedRecipeId : recentIds.value[0] || recipes.value[0]?.id || ''
  } finally { loading.value = false }
}

onMounted(() => {
  favoriteIds.value = new Set(readStoredIds(FAVORITES_KEY))
  recentIds.value = readStoredIds(RECENTS_KEY).slice(0, 8)
})
watch(() => props.visible, async visible => {
  if (!visible) return
  query.value = ''
  activeFilter.value = 'all'
  await load()
  await nextTick()
  searchInput.value?.focus({ preventScroll: true })
})
watch(() => props.selectedRecipeId, id => { if (id && recipes.value.some(recipe => recipe.id === id)) draftId.value = id })
</script>

<style scoped>
.rlm-shell { display:flex; min-height:min(760px,calc(100vh - 96px)); flex-direction:column; gap:16px; }
.rlm-head { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }.rlm-head h2 { margin:2px 0 5px; font-size:clamp(24px,3vw,34px); letter-spacing:-.035em; }.rlm-head p { margin:0; color:var(--text-secondary); font-size:13px; }.rlm-eyebrow { color:var(--accent)!important; font-size:var(--font-xs)!important; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
.rlm-close { width:36px; height:36px; border:1px solid var(--border); border-radius:50%; background:var(--bg-tertiary); color:var(--text-secondary); cursor:pointer; font-size:22px; line-height:1; }.rlm-close:hover { border-color:var(--accent); color:var(--text-primary); }
.rlm-tools { display:grid; gap:10px; }.rlm-search { display:flex; min-height:44px; align-items:center; gap:10px; padding:0 13px; border:1px solid var(--border); border-radius:11px; background:var(--bg-primary); color:var(--text-muted); }.rlm-search:focus-within { border-color:var(--accent); box-shadow:var(--focus-ring); }.rlm-search input { width:100%; border:0; outline:0; background:transparent; color:var(--text-primary); font:inherit; }
.rlm-filter-row { display:flex; gap:7px; overflow-x:auto; padding-bottom:2px; scrollbar-width:thin; }.rlm-filter { display:inline-flex; flex:0 0 auto; align-items:center; gap:6px; padding:7px 10px; border:1px solid var(--border); border-radius:999px; background:var(--bg-primary); color:var(--text-secondary); cursor:pointer; font:inherit; font-size:var(--font-xs); }.rlm-filter span { color:var(--text-muted); font-size:var(--font-xs); }.rlm-filter:hover,.rlm-filter.active { border-color:color-mix(in srgb,var(--accent) 60%,var(--border)); color:var(--text-primary); }.rlm-filter.active { background:var(--accent-dim); color:var(--accent); }
.rlm-status,.rlm-empty { display:flex; min-height:220px; align-items:center; justify-content:center; flex-direction:column; gap:8px; color:var(--text-muted); text-align:center; }.rlm-empty strong { color:var(--text-primary); }.rlm-results-head { display:flex; align-items:baseline; gap:6px; color:var(--text-muted); font-size:var(--font-xs); }.rlm-results-head strong { color:var(--text-primary); font-size:12px; }
.rlm-grid { display:grid; flex:1; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px; align-content:start; max-height:min(510px,calc(100vh - 330px)); overflow-y:auto; padding:2px 5px 8px 2px; scrollbar-width:thin; }.rlm-card { min-width:0; overflow:hidden; border:1px solid var(--border); border-radius:12px; background:var(--bg-primary); cursor:pointer; transition:border-color .16s ease,transform .16s ease,box-shadow .16s ease; }.rlm-card:hover { transform:translateY(-2px); border-color:var(--border-light); box-shadow:0 12px 30px rgba(0,0,0,.16); }.rlm-card:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }.rlm-card.selected { border-color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent),0 10px 28px var(--accent-dim); }
.rlm-image-wrap { position:relative; aspect-ratio:16/9; overflow:hidden; background:var(--bg-tertiary); }.rlm-image-wrap>img { width:100%; height:100%; display:block; object-fit:cover; transition:transform .2s ease; }.rlm-card:hover .rlm-image-wrap>img { transform:scale(1.025); }.rlm-favorite { position:absolute; top:7px; right:7px; width:30px; height:30px; border:1px solid rgba(255,255,255,.24); border-radius:50%; background:rgba(10,12,18,.72); color:#fff; cursor:pointer; font-size:16px; backdrop-filter:blur(8px); }.rlm-favorite.active { color:var(--accent); }.rlm-selected-mark { position:absolute; left:7px; bottom:7px; padding:4px 7px; border-radius:999px; background:var(--accent); color:var(--accent-on); font-size:var(--font-xs); font-weight:800; letter-spacing:.06em; text-transform:uppercase; }.rlm-preview-dots { position:absolute; right:8px; bottom:8px; display:flex; gap:4px; }.rlm-preview-dots button { width:7px; height:7px; padding:0; border:0; border-radius:50%; background:rgba(255,255,255,.55); cursor:pointer; }.rlm-preview-dots button.active { background:#fff; transform:scale(1.25); }
.rlm-card-copy { display:grid; gap:7px; padding:11px; }.rlm-card-title { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }.rlm-card-title h3 { margin:0; font-size:13px; line-height:1.35; }.rlm-card-title>span { flex:0 0 auto; color:var(--accent); font-size:var(--font-xs); font-weight:750; letter-spacing:.04em; text-transform:uppercase; }.rlm-card-copy>p { display:-webkit-box; min-height:34px; margin:0; overflow:hidden; color:var(--text-secondary); font-size:var(--font-xs); line-height:1.45; -webkit-box-orient:vertical; -webkit-line-clamp:2; }.rlm-tags { display:flex; gap:5px; overflow:hidden; }.rlm-tags span { flex:0 0 auto; padding:3px 6px; border-radius:999px; background:var(--bg-tertiary); color:var(--text-muted); font-size:var(--font-xs); }
.rlm-footer { display:flex; align-items:center; justify-content:space-between; gap:14px; padding-top:14px; border-top:1px solid var(--border); }.rlm-selection { display:flex; min-width:0; align-items:center; gap:10px; }.rlm-selection img { width:64px; aspect-ratio:16/9; object-fit:cover; border:1px solid var(--border); border-radius:7px; }.rlm-selection div { display:flex; min-width:0; flex-direction:column; gap:2px; }.rlm-selection span { color:var(--text-muted); font-size:var(--font-xs); letter-spacing:.07em; text-transform:uppercase; }.rlm-selection strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }.rlm-actions { display:flex; flex:0 0 auto; gap:8px; }
@media (max-width:720px) { .rlm-shell { min-height:calc(100vh - 72px); }.rlm-grid { grid-template-columns:repeat(2,minmax(0,1fr)); max-height:calc(100vh - 350px); }.rlm-footer { align-items:stretch; flex-direction:column; }.rlm-actions .btn { flex:1; } } @media (max-width:480px) { .rlm-grid { grid-template-columns:1fr; } }
</style>
