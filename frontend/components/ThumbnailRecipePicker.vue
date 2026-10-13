<template>
  <section class="recipe-picker-summary">
    <div class="recipe-picker-heading">
      <div>
        <label>Thumbnail recipe</label>
        <p>One selected format stays visible here. Browse the library when you want to compare or change its composition.</p>
      </div>
      <span>{{ recipeCount }} thumbnail format{{ recipeCount === 1 ? '' : 's' }}</span>
    </div>

    <div class="recipe-picker-current" :class="{ empty: !activeRecipe }">
      <img v-if="activeRecipe" :src="previewSrc(activeRecipe)" :alt="previewAlt(activeRecipe)" />
      <div v-else class="recipe-picker-placeholder" aria-hidden="true">▧</div>
      <div class="recipe-picker-current-copy">
        <span>{{ activeRecipe?.category || 'No recipe selected' }}</span>
        <strong>{{ activeRecipe?.name || 'Choose a thumbnail recipe' }}</strong>
        <p>{{ activeRecipe?.description || 'Browse reusable composition systems, compare generated examples, and choose one without expanding the page.' }}</p>
      </div>
      <button type="button" class="btn btn-primary recipe-picker-browse" @click="libraryOpen = true">
        {{ activeRecipe ? 'Change Recipe' : 'Browse Recipes' }}
      </button>
    </div>

    <div class="recipe-picker-hints">
      <span>⌕ Searchable</span>
      <span>★ Favorites</span>
      <span>↺ Recent recipes</span>
      <span v-if="activeRecipe">{{ previewStatus(activeRecipe) }}</span>
    </div>

    <ThumbnailRecipeLibraryModal
      :visible="libraryOpen"
      :selected-recipe-id="selectedRecipeId"
      @close="libraryOpen = false"
      @select="selectRecipe"
    />
  </section>
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
    defaultTextStyle?: string
    defaultFontStyle?: string
    defaultTextPosition?: 'top' | 'center' | 'bottom' | 'bottom-left'
    conceptGuidance?: string
    headlineMode?: 'episode-title' | 'curiosity-hook'
  }
}

const props = defineProps<{ selectedRecipeId?: string }>()
const emit = defineEmits<{ select: [recipe: ThumbnailRecipe] }>()
const { get } = useApi()
const recipes = ref<ThumbnailRecipe[]>([])
const libraryOpen = ref(false)
const activeRecipe = computed(() => recipes.value.find(recipe => recipe.id === props.selectedRecipeId) || null)
const recipeCount = computed(() => recipes.value.length)

function previewSrc(recipe: ThumbnailRecipe): string {
  return recipe.previewImages?.[0] || `/api/thumbnail-templates/${encodeURIComponent(recipe.id)}/preview.png`
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
function previewStatus(recipe: ThumbnailRecipe): string {
  return hasGeneratedExample(recipe) ? 'Generated examples included' : 'Layout placeholder · no generated examples yet'
}
function selectRecipe(recipe: ThumbnailRecipe): void {
  libraryOpen.value = false
  emit('select', recipe)
}
async function load(): Promise<void> {
  const result = await get<{ templates: ThumbnailRecipe[] }>('/thumbnail-templates')
  recipes.value = (result.templates || []).filter(template => Boolean(template.recipe))
}

onMounted(() => { void load() })
watch(() => props.selectedRecipeId, () => { if (!recipes.value.length) void load() })
</script>

<style scoped>
.recipe-picker-summary { display:grid; gap:10px; padding:14px; border:1px solid var(--border); border-radius:13px; background:linear-gradient(135deg,var(--surface-raised),var(--bg-secondary)); }.recipe-picker-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }.recipe-picker-heading label { display:block; font-size:12px; font-weight:700; }.recipe-picker-heading p { margin:3px 0 0; color:var(--text-muted); font-size:var(--font-xs); line-height:1.45; }.recipe-picker-heading>span { flex:0 0 auto; padding:4px 8px; border:1px solid var(--border); border-radius:999px; color:var(--text-muted); font-size:var(--font-xs); }
.recipe-picker-current { display:grid; grid-template-columns:128px minmax(0,1fr) auto; align-items:center; gap:13px; min-height:92px; overflow:hidden; border:1px solid color-mix(in srgb,var(--accent) 28%,var(--border)); border-radius:11px; background:var(--bg-primary); }.recipe-picker-current.empty { border-style:dashed; }.recipe-picker-current>img,.recipe-picker-placeholder { width:128px; height:100%; min-height:92px; object-fit:cover; background:var(--bg-tertiary); }.recipe-picker-placeholder { display:grid; place-items:center; color:var(--text-muted); font-size:28px; }.recipe-picker-current-copy { display:flex; min-width:0; flex-direction:column; gap:3px; padding:11px 0; }.recipe-picker-current-copy>span { color:var(--accent); font-size:var(--font-xs); font-weight:800; letter-spacing:.1em; text-transform:uppercase; }.recipe-picker-current-copy>strong { font-size:14px; }.recipe-picker-current-copy>p { display:-webkit-box; margin:0; overflow:hidden; color:var(--text-secondary); font-size:var(--font-xs); line-height:1.45; -webkit-box-orient:vertical; -webkit-line-clamp:2; }.recipe-picker-browse { margin-right:13px; white-space:nowrap; }.recipe-picker-hints { display:flex; gap:13px; flex-wrap:wrap; color:var(--text-muted); font-size:var(--font-xs); }
@media (max-width:720px) { .recipe-picker-current { grid-template-columns:92px minmax(0,1fr); }.recipe-picker-current>img,.recipe-picker-placeholder { width:92px; }.recipe-picker-browse { grid-column:1 / -1; margin:0 10px 10px; } }
</style>
