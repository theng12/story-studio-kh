<template>
  <Teleport to="body">
    <div v-if="visible" class="recipe-backdrop" @click.self="close">
      <section class="recipe-modal" role="dialog" aria-modal="true" aria-label="Thumbnail recipe catalog">
        <header class="recipe-header">
          <div>
            <p class="recipe-eyebrow">Thumbnail Catalog</p>
            <h2>Choose a reusable thumbnail format</h2>
            <p>Each card shows real generated examples. The recipe directs the composition; Story Studio composites the headline afterward for reliable text.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" @click="close">Close</button>
        </header>

        <div class="recipe-toolbar">
          <input v-model="query" class="input" type="search" placeholder="Search recipes, formats, tags…" />
          <select v-model="category" class="select">
            <option value="">All categories</option>
            <option v-for="item in categories" :key="item" :value="item">{{ item }}</option>
          </select>
        </div>

        <div v-if="loading" class="recipe-status">Loading thumbnail recipes…</div>
        <div v-else-if="!filteredRecipes.length" class="recipe-status">No matching thumbnail recipes.</div>
        <div v-else class="recipe-grid">
          <article
            v-for="recipe in filteredRecipes"
            :key="recipe.id"
            class="recipe-card"
            :class="{ 'is-selected': recipe.id === draftId }"
            @click="draftId = recipe.id"
          >
            <div class="recipe-preview">
              <img :src="previewSrc(recipe)" :alt="`${recipe.name} generated example`" loading="lazy" />
              <div v-if="recipe.previewImages && recipe.previewImages.length > 1" class="recipe-dots" aria-label="Preview examples">
                <button
                  v-for="(_, index) in recipe.previewImages"
                  :key="index"
                  type="button"
                  :class="{ active: previewIndex(recipe.id) === index }"
                  :aria-label="`Show example ${index + 1}`"
                  @click.stop="setPreview(recipe.id, index)"
                />
              </div>
              <span v-if="recipe.recipe?.titleMode === 'composite'" class="recipe-safe">Safe text overlay</span>
            </div>
            <div class="recipe-content">
              <div class="recipe-title-row">
                <h3>{{ recipe.name }}</h3>
                <span v-if="recipe.category" class="recipe-category">{{ recipe.category }}</span>
              </div>
              <p>{{ recipe.description }}</p>
              <div v-if="recipe.recipe?.headlineFormats?.length" class="recipe-headlines">
                <strong>Headline formats</strong>
                <span v-for="format in recipe.recipe.headlineFormats" :key="format">{{ format }}</span>
              </div>
              <div v-if="recipe.tags?.length" class="recipe-tags">
                <span v-for="tag in recipe.tags" :key="tag">{{ tag }}</span>
              </div>
              <div class="recipe-select-line">
                <span>{{ recipe.id === draftId ? 'Selected' : 'Choose this recipe' }}</span>
                <span v-if="recipe.recipe?.layout">{{ recipe.recipe.layout.replace('-', ' ') }}</span>
              </div>
            </div>
          </article>
        </div>

        <footer class="recipe-footer">
          <p v-if="selectedRecipe">{{ selectedRecipe.name }} will set the composition and title-overlay defaults. Your visual art style remains independent.</p>
          <p v-else>Choose a recipe to continue.</p>
          <button type="button" class="btn btn-primary" :disabled="!selectedRecipe" @click="confirm">Use selected recipe</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'

interface ThumbnailRecipe {
  id: string
  name: string
  description: string
  category?: string
  tags?: string[]
  previewImages?: string[]
  recipe?: {
    layout?: string
    titleMode?: 'ai' | 'composite'
    defaultTextStyle?: string
    defaultFontStyle?: string
    defaultTextPosition?: 'top' | 'center' | 'bottom'
    headlineFormats?: string[]
    conceptGuidance?: string
  }
}

const props = defineProps<{ visible: boolean; selectedRecipeId?: string }>()
const emit = defineEmits<{ select: [recipe: ThumbnailRecipe]; close: [] }>()
const { get } = useApi()

const recipes = ref<ThumbnailRecipe[]>([])
const loading = ref(false)
const query = ref('')
const category = ref('')
const draftId = ref('')
const previews = ref<Record<string, number>>({})

const categories = computed(() => [...new Set(recipes.value.map(recipe => recipe.category).filter(Boolean) as string[])].sort())
const filteredRecipes = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return recipes.value.filter(recipe => {
    if (category.value && recipe.category !== category.value) return false
    if (!needle) return true
    return [recipe.name, recipe.description, recipe.category, ...(recipe.tags || []), recipe.recipe?.conceptGuidance]
      .filter(Boolean).join(' ').toLowerCase().includes(needle)
  })
})
const selectedRecipe = computed(() => recipes.value.find(recipe => recipe.id === draftId.value) || null)

function previewIndex(id: string): number { return previews.value[id] || 0 }
function setPreview(id: string, index: number): void { previews.value = { ...previews.value, [id]: index } }
function previewSrc(recipe: ThumbnailRecipe): string {
  const images = recipe.previewImages || []
  return images[previewIndex(recipe.id)] || `/api/thumbnail-templates/${encodeURIComponent(recipe.id)}/preview.png`
}
function close(): void { emit('close') }
function confirm(): void { if (selectedRecipe.value) emit('select', selectedRecipe.value) }

async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await get<{ templates: ThumbnailRecipe[] }>('/thumbnail-templates')
    recipes.value = (result.templates || []).filter(template => Boolean(template.recipe))
    draftId.value = props.selectedRecipeId && recipes.value.some(recipe => recipe.id === props.selectedRecipeId)
      ? props.selectedRecipeId : recipes.value[0]?.id || ''
  } finally { loading.value = false }
}

watch(() => props.visible, visible => { if (visible) void load() }, { immediate: true })
watch(() => props.selectedRecipeId, id => { if (id) draftId.value = id })
</script>

<style scoped>
.recipe-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; background: rgba(0,0,0,.72); }
.recipe-modal { width: min(1200px, 100%); max-height: min(880px, calc(100vh - 48px)); overflow: auto; border: 1px solid var(--border, #40404a); border-radius: 16px; background: var(--surface, #1d1d23); color: var(--text, #f4f4f5); box-shadow: 0 20px 70px rgba(0,0,0,.5); }
.recipe-header { display:flex; justify-content:space-between; gap:24px; padding:24px 26px 18px; border-bottom:1px solid var(--border, #40404a); }
.recipe-header h2 { margin: 2px 0 7px; font-size: 22px; }.recipe-header p { margin:0; color:var(--text-muted,#a1a1aa); max-width:760px; }.recipe-eyebrow { color:var(--accent,#6ea8fe)!important; font-size:var(--font-xs); font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
.recipe-toolbar { display:flex; gap:10px; padding:16px 26px; }.recipe-toolbar .input { flex:1; }.recipe-toolbar .select { width:190px; }
.recipe-status { padding:45px 26px; text-align:center; color:var(--text-muted,#a1a1aa); }.recipe-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(290px,1fr)); gap:16px; padding:0 26px 24px; }
.recipe-card { overflow:hidden; border:2px solid var(--border,#40404a); border-radius:12px; background:var(--surface-elevated,#26262e); cursor:pointer; transition:border-color .15s,transform .15s; }.recipe-card:hover { transform:translateY(-2px); border-color:rgba(110,168,254,.65); }.recipe-card.is-selected { border-color:var(--accent,#6ea8fe); box-shadow:0 0 0 1px var(--accent,#6ea8fe) inset; }
.recipe-preview { position:relative; aspect-ratio:16/9; background:#121212; }.recipe-preview img { width:100%; height:100%; object-fit:cover; display:block; }.recipe-safe { position:absolute; top:9px; left:9px; border-radius:99px; padding:4px 7px; background:rgba(11,85,55,.9); color:#d6ffe7; font-size:var(--font-xs); font-weight:700; }.recipe-dots { position:absolute; bottom:9px; left:50%; transform:translateX(-50%); display:flex; gap:5px; }.recipe-dots button { width:7px; height:7px; border:0; border-radius:50%; background:rgba(255,255,255,.5); padding:0; cursor:pointer; }.recipe-dots button.active { background:#fff; transform:scale(1.25); }
.recipe-content { padding:14px; }.recipe-title-row { display:flex; gap:8px; align-items:start; justify-content:space-between; }.recipe-content h3 { margin:0; font-size:16px; }.recipe-content p { margin:8px 0 11px; min-height:52px; color:var(--text-muted,#a1a1aa); font-size:12px; line-height:1.4; }.recipe-headlines { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 10px; }.recipe-headlines strong { width:100%; color:var(--text-muted,#a1a1aa); font-size:var(--font-xs); text-transform:uppercase; letter-spacing:.05em; }.recipe-headlines span { border-left:2px solid #ef3f35; padding-left:5px; color:var(--text,#f4f4f5); font-size:var(--font-xs); font-weight:700; }.recipe-category,.recipe-tags span { border-radius:99px; background:rgba(255,255,255,.08); padding:3px 6px; font-size:var(--font-xs); white-space:nowrap; }.recipe-tags { display:flex; flex-wrap:wrap; gap:5px; }.recipe-select-line { display:flex; justify-content:space-between; margin-top:13px; color:var(--accent,#6ea8fe); font-size:var(--font-xs); font-weight:700; text-transform:capitalize; }
.recipe-footer { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:16px 26px; border-top:1px solid var(--border,#40404a); }.recipe-footer p { margin:0; color:var(--text-muted,#a1a1aa); font-size:12px; }
@media (max-width:640px) { .recipe-backdrop { padding:0; }.recipe-modal { max-height:100vh; border-radius:0; }.recipe-header,.recipe-footer { padding:18px; }.recipe-toolbar,.recipe-grid { padding-left:18px; padding-right:18px; }.recipe-toolbar { flex-direction:column; }.recipe-toolbar .select { width:100%; }.recipe-footer { align-items:flex-start; flex-direction:column; }.recipe-footer .btn { width:100%; } }
</style>
