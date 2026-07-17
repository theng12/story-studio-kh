<template>
  <div class="style-picker">
    <section class="style-picker-summary">
      <div class="style-picker-heading">
        <div>
          <label>Channel art style</label>
          <p>One selected look stays visible here. Open the library only when you want to browse or change it.</p>
        </div>
        <span>{{ BUILT_IN_STYLES.length }} built-in looks</span>
      </div>

      <div class="style-picker-current" :class="{ empty: !activeStyle && !activeStyleBible?.trim() }">
        <img
          v-if="activeStyle?.preview_image"
          :src="activeStyle.preview_image"
          :alt="`${activeStyle.name} preview`"
        />
        <div v-else class="style-picker-placeholder" aria-hidden="true">◫</div>
        <div class="style-picker-current-copy">
          <span>{{ activeStyle ? activeStyle.category : (activeStyleBible?.trim() ? 'Custom look' : 'No style selected') }}</span>
          <strong>{{ activeStyle?.name || (activeStyleBible?.trim() ? 'Custom Style Bible' : 'Choose a channel look') }}</strong>
          <p>{{ activeStyle?.blurb || customStyleSummary }}</p>
        </div>
        <button type="button" class="btn btn-primary style-picker-browse" @click="libraryOpen = true">
          {{ activeStyle || activeStyleBible?.trim() ? 'Change style' : 'Browse styles' }}
        </button>
      </div>

      <div class="style-picker-hints">
        <span>⌕ Searchable</span>
        <span>★ Favorites</span>
        <span>↺ Recent styles</span>
        <span>Preview assets included</span>
      </div>
    </section>

    <BuiltInStyleLibraryModal
      :visible="libraryOpen"
      :project-slug="slug"
      :selected-style-id="activeStyle?.id || appliedStyleId"
      :image-models="imageModels"
      @close="libraryOpen = false"
      @select="applyStyle"
    />

    <ProjectStyleLibrary
      v-if="showCustomStyles !== false"
      :project-slug="slug"
      :image-models="imageModels"
      title="Custom styles for this project"
      :show-apply="true"
      @apply="applyCustomStyle"
    />
  </div>
</template>

<script setup lang="ts">
import { BUILT_IN_STYLES, type BuiltInStyle } from '~/composables/useBuiltInStyles'

const props = defineProps<{
  slug: string
  /** Project config image_models, used only if a bundled preview needs repair. */
  imageModels?: Record<string, any>
  /** The active Style Bible lets the compact card identify the current built-in. */
  activeStyleBible?: string
  /** Some focused workspaces only need the shipped style library. */
  showCustomStyles?: boolean
}>()

const emit = defineEmits<{
  (e: 'apply', data: { style_bible: string; negative_prompt: string }, style?: BuiltInStyle): void
}>()

const libraryOpen = ref(false)
const appliedStyleId = ref('')
const activeStyle = computed(() => {
  const bible = props.activeStyleBible?.trim()
  if (bible) return BUILT_IN_STYLES.find(style => style.data.style_bible.trim() === bible) || null
  return BUILT_IN_STYLES.find(style => style.id === appliedStyleId.value) || null
})
const customStyleSummary = computed(() => {
  const text = props.activeStyleBible?.trim()
  if (!text) return 'Browse the visual library, compare real previews, and apply one without expanding the page.'
  return text.length > 180 ? `${text.slice(0, 177)}…` : text
})

function applyStyle(style: BuiltInStyle): void {
  appliedStyleId.value = style.id
  emit('apply', {
    style_bible: style.data.style_bible || '',
    negative_prompt: style.data.negative_prompt || '',
  }, style)
}

function applyCustomStyle(data: { style_bible: string; negative_prompt: string }): void {
  appliedStyleId.value = ''
  emit('apply', data)
}
</script>

<style scoped>
.style-picker { display: flex; flex-direction: column; gap: 14px; }
.style-picker-summary { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 13px; background: linear-gradient(135deg, var(--surface-raised), var(--bg-secondary)); }
.style-picker-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.style-picker-heading label { display: block; font-size: 12px; font-weight: 700; }
.style-picker-heading p { margin: 3px 0 0; color: var(--text-muted); font-size: 10px; line-height: 1.45; }
.style-picker-heading > span { flex: 0 0 auto; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); font-size: 9px; }
.style-picker-current { display: grid; grid-template-columns: 128px minmax(0, 1fr) auto; align-items: center; gap: 13px; min-height: 92px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border)); border-radius: 11px; background: var(--bg-primary); }
.style-picker-current.empty { border-style: dashed; }
.style-picker-current > img, .style-picker-placeholder { width: 128px; height: 100%; min-height: 92px; object-fit: cover; background: var(--bg-tertiary); }
.style-picker-placeholder { display: grid; place-items: center; color: var(--text-muted); font-size: 28px; }
.style-picker-current-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; padding: 11px 0; }
.style-picker-current-copy > span { color: var(--accent); font-size: 8px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.style-picker-current-copy > strong { font-size: 14px; }
.style-picker-current-copy > p { display: -webkit-box; margin: 0; overflow: hidden; color: var(--text-secondary); font-size: 10px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.style-picker-browse { margin-right: 13px; white-space: nowrap; }
.style-picker-hints { display: flex; gap: 13px; flex-wrap: wrap; color: var(--text-muted); font-size: 9px; }
@media (max-width: 720px) {
  .style-picker-current { grid-template-columns: 92px minmax(0, 1fr); }
  .style-picker-current > img, .style-picker-placeholder { width: 92px; }
  .style-picker-browse { grid-column: 1 / -1; margin: 0 10px 10px; }
}
</style>
