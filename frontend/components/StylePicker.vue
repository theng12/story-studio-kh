<template>
  <div class="sp-builtins">
    <div class="sp-builtins-head">
      <div>
        <label>Built-in style gallery</label>
        <p class="text-muted text-xs mt-1">
          Pick a look to apply it (sets the Style Bible + negative prompt). Built-in styles now ship with baked sample previews, and the on-demand renderer stays as a fallback if a bundled asset is ever missing.
        </p>
      </div>
      <div class="sp-builtins-controls">
        <ModelMenu
          v-model="previewModel"
          class="sp-preview-model"
          :options="previewModelOptions"
          media-type="image"
          title="Style preview model"
          search-placeholder="Search image models…"
        />
        <select v-model="previewAspect" class="input input-sm">
          <option v-for="opt in ASPECT_OPTIONS" :key="opt" :value="opt">{{ opt }}</option>
        </select>
      </div>
    </div>

    <div class="sp-builtins-grid">
      <article v-for="style in BUILT_IN_STYLES" :key="style.id" class="sp-style-card">
        <div class="sp-style-card-top">
          <div>
            <h4>{{ style.name }}</h4>
            <p class="text-muted text-xs mt-1">{{ style.blurb }}</p>
          </div>
          <span class="sp-style-chip">Built-in</span>
        </div>

        <div class="sp-style-preview">
          <img
            v-if="style.preview_image && !bundledFailed[style.id]"
            :src="style.preview_image"
            :alt="`${style.name} preview`"
            class="sp-style-preview-img"
            @error="onBundledPreviewError(style.id)"
          />
          <img
            v-else-if="previewStates[style.id]?.url"
            :src="previewStates[style.id]?.url || ''"
            :alt="`${style.name} preview`"
            class="sp-style-preview-img"
          />
          <div v-else class="sp-style-preview-empty">
            Preview not generated yet
          </div>
        </div>

        <div class="sp-style-card-actions">
          <button class="btn btn-secondary btn-sm" @click="applyStyle(style)">
            Apply style
          </button>
          <button
            v-if="!style.preview_image || bundledFailed[style.id]"
            class="btn btn-ghost btn-sm"
            :disabled="!previewModel || previewStates[style.id]?.loading"
            :title="!previewModel ? 'Pick a preview model first' : 'Render a cached preview sample for this style'"
            @click="generatePreview(style)"
          >
            {{ previewStates[style.id]?.loading ? 'Rendering…' : (previewStates[style.id]?.url ? 'Re-preview' : 'Generate preview') }}
          </button>
        </div>

        <p class="sp-style-card-copy">{{ style.data.style_bible }}</p>
        <p v-if="previewStates[style.id]?.error" class="sp-style-card-error">
          {{ previewStates[style.id]?.error }}
        </p>
        <p v-else-if="!style.preview_image && previewStates[style.id]?.url" class="sp-style-card-meta">
          {{ previewStates[style.id]?.cached ? 'Cached preview' : 'Fresh preview' }}
          · {{ previewStates[style.id]?.model_id || previewModel }}
          · {{ previewStates[style.id]?.aspect_ratio || previewAspect }}
        </p>
      </article>
    </div>

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
  /** project config image_models, for the preview-model picker. */
  imageModels?: Record<string, any>
  /** Some focused workspaces only need the built-in gallery. */
  showCustomStyles?: boolean
}>()

const emit = defineEmits<{
  (e: 'apply', data: { style_bible: string; negative_prompt: string }, style?: BuiltInStyle): void
}>()

const { post } = useApi()

const ASPECT_OPTIONS = ['16:9', '1:1', '9:16'] as const

interface PreviewState {
  loading: boolean
  url: string | null
  cached: boolean | null
  hash: string | null
  model_id: string | null
  aspect_ratio: string | null
  tier: string | null
  error: string | null
}
function defaultState(): PreviewState {
  return { loading: false, url: null, cached: null, hash: null, model_id: null, aspect_ratio: null, tier: null, error: null }
}

const previewModel = ref('')
const previewAspect = ref<(typeof ASPECT_OPTIONS)[number]>('16:9')
const previewStates = ref<Record<string, PreviewState>>({})
// Tracks bundled previews that 404 (not baked yet) so the card falls back to
// the on-demand "Generate preview" path instead of a broken image.
const bundledFailed = ref<Record<string, boolean>>({})

const modelOptions = computed(() =>
  Object.keys(props.imageModels || {}).map(id => ({ value: id, label: id })),
)
const previewModelOptions = computed(() => modelOptions.value.map(option => ({
  id: option.value,
  label: option.label,
  group: 'Image models',
})))

watch(modelOptions, (opts) => {
  if (!previewModel.value && opts.length) previewModel.value = opts[0]!.value
}, { immediate: true })

function onBundledPreviewError(id: string) {
  bundledFailed.value = { ...bundledFailed.value, [id]: true }
}

function applyStyle(style: BuiltInStyle) {
  emit('apply', { style_bible: style.data.style_bible || '', negative_prompt: style.data.negative_prompt || '' }, style)
}

function applyCustomStyle(data: { style_bible: string; negative_prompt: string }) {
  emit('apply', data)
}

async function generatePreview(style: BuiltInStyle) {
  if (!previewModel.value) return
  previewStates.value[style.id] = { ...defaultState(), ...previewStates.value[style.id], loading: true, error: null }
  try {
    const data = await post<{
      hash: string; url: string; cached: boolean; model_id: string; aspect_ratio: string; tier: string
    }>(`/projects/${props.slug}/style-preview`, {
      style_tag: style.data.style_bible,
      model: previewModel.value,
      aspect_ratio: previewAspect.value,
    })
    previewStates.value[style.id] = {
      loading: false, url: data.url, cached: !!data.cached, hash: data.hash,
      model_id: data.model_id, aspect_ratio: data.aspect_ratio, tier: data.tier || null, error: null,
    }
  } catch (e: any) {
    previewStates.value[style.id] = {
      ...defaultState(), ...previewStates.value[style.id],
      loading: false, error: e?.data?.detail || e?.message || 'Preview failed',
    }
  }
}
</script>

<style scoped>
.sp-builtins {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sp-builtins-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.sp-builtins-controls {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: flex-start;
}
.sp-preview-model { width: min(360px, 72vw); }
.sp-builtins-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}
.sp-style-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background:
    radial-gradient(circle at top right, rgba(240, 198, 116, 0.12), transparent 34%),
    var(--bg-secondary);
}
.sp-style-card-top {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
}
.sp-style-card h4 {
  margin: 0;
  font-size: 14px;
}
.sp-style-chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(108, 143, 255, 0.14);
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.sp-style-preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.sp-style-preview-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sp-style-preview-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
  padding: 12px;
}
.sp-style-card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.sp-style-card-copy {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sp-style-card-meta {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
}
.sp-style-card-error {
  margin: 0;
  color: rgb(220, 38, 38);
  font-size: 11px;
}
</style>
