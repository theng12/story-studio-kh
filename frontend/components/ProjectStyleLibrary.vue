<template>
  <div class="psl">
    <div v-if="showBuiltInStarters" class="psl-builtins card">
      <div class="psl-saved-head">
        <label>Start from a built-in style</label>
        <span class="text-muted text-xs">{{ BUILT_IN_STYLES.length }} built-in looks</span>
      </div>
      <div class="psl-builtins-grid">
        <article v-for="style in BUILT_IN_STYLES" :key="style.id" class="psl-builtin-card">
          <div class="psl-builtin-top">
            <div>
              <h4>{{ style.name }}</h4>
              <p class="text-muted text-xs mt-1">{{ style.blurb }}</p>
            </div>
            <span class="psl-sample-chip">Built-in</span>
          </div>
          <button
            v-if="style.preview_image"
            type="button"
            class="psl-image-button"
            title="Open large preview"
            @click="openLightbox([{ url: style.preview_image, label: style.name }], 0)"
          >
            <img :src="style.preview_image" :alt="style.name" class="psl-builtin-img" />
            <span class="psl-zoom-hint">View larger</span>
          </button>
          <div class="psl-preset-actions">
            <button class="btn btn-ghost btn-sm" @click="loadBuiltInStyle(style)">Load into editor</button>
            <button v-if="showApply" class="btn btn-ghost btn-sm" @click="applyBuiltInStyle(style)">Apply</button>
          </div>
        </article>
      </div>
    </div>

    <div class="psl-head">
      <div>
        <label>{{ title }}</label>
        <p class="text-muted text-xs mt-1">
          Build your own style pack for this project, render five real samples with your chosen image model, then save it so every machine sees the same style text and preview gallery.
        </p>
      </div>
      <div class="psl-controls">
        <ModelMenu
          v-model="previewModel"
          class="psl-preview-model"
          :options="previewModelOptions"
          media-type="image"
          title="Style sample model"
          search-placeholder="Search image models…"
        />
        <select v-model="previewAspect" class="input input-sm">
          <option v-for="opt in ASPECT_OPTIONS" :key="opt" :value="opt">{{ opt }}</option>
        </select>
      </div>
    </div>

    <div class="psl-editor card">
      <div class="psl-editor-grid">
        <div>
          <label class="psl-field-label">Style name</label>
          <input v-model="draftName" class="input" placeholder="e.g. Prehistoric Stick Cartoon" />
        </div>
        <div>
          <label class="psl-field-label">Style prompt</label>
          <textarea
            v-model="draftDescription"
            class="textarea"
            rows="5"
            placeholder="Describe the art direction, line work, colours, character design, mood, framing, texture, and what the model should avoid."
          />
        </div>
      </div>
      <div class="psl-editor-state">
        <span v-if="editingPresetId" class="psl-state-pill">Editing saved style</span>
        <span v-else-if="editorOriginLabel" class="psl-state-pill">{{ editorOriginLabel }}</span>
        <button
          v-if="editingPresetId || draftName || draftDescription || liveSamples.some(sample => sample.url)"
          class="btn btn-ghost btn-sm"
          @click="resetEditor()"
        >
          New blank style
        </button>
      </div>
      <div class="psl-actions">
        <button
          class="btn btn-secondary btn-sm"
          :disabled="renderingAll || anySampleLoading || !draftDescription.trim() || !previewModel"
          :title="!previewModel ? 'Pick a preview model first' : 'Render five fixed sample scenes with this style'"
          @click="generateAllSamples"
        >
          {{ renderingAll ? 'Rendering 5 samples…' : 'Generate 5 live samples' }}
        </button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="saving || !draftName.trim() || !draftDescription.trim()"
          :title="editingPresetId
            ? 'Update this saved style. If you rendered new samples, they replace the old preview gallery.'
            : 'Save this style into the project library. If live samples exist, they are saved too.'"
          @click="saveStyle"
        >
          {{ saving ? 'Saving…' : (editingPresetId ? 'Update saved style' : 'Save style to project') }}
        </button>
        <button
          v-if="editingPresetId"
          class="btn btn-ghost btn-sm"
          :disabled="saving || !draftName.trim() || !draftDescription.trim()"
          :title="'Fork this into a new saved style instead of overwriting the current one.'"
          @click="saveAsNewStyle"
        >
          {{ saving ? 'Saving…' : 'Save as new style' }}
        </button>
        <button
          v-if="showApply"
          class="btn btn-ghost btn-sm"
          :disabled="!draftDescription.trim()"
          @click="emitApply()"
        >
          Apply to Style Bible
        </button>
        <span v-if="galleryCount" class="psl-gallery-count">{{ galleryCount }} sample{{ galleryCount === 1 ? '' : 's' }} selected for gallery</span>
        <span class="text-muted text-xs">Uses your current model selection, so `gpt-image-2` works here.</span>
      </div>
      <p v-if="renderError" class="psl-error">{{ renderError }}</p>

      <div class="psl-samples-grid">
        <article
          v-for="sample in liveSamples"
          :key="sample.variant_id"
          class="psl-sample-card"
          :class="{ 'is-included': sample.included }"
        >
          <div class="psl-sample-head">
            <strong>{{ sample.label }}</strong>
            <div class="psl-sample-badges">
              <span v-if="sample.url" class="psl-sample-chip">{{ sample.sourceFile ? 'saved' : (sample.cached ? 'cached' : 'fresh') }}</span>
              <span v-if="sample.included" class="psl-sample-chip psl-sample-chip-gallery">gallery</span>
            </div>
          </div>
          <div class="psl-sample-preview">
            <button
              v-if="sample.url"
              type="button"
              class="psl-image-button"
              title="Open large preview"
              @click="openLiveSample(sample.variant_id)"
            >
              <img :src="sample.url" :alt="sample.label" class="psl-sample-img" />
              <span class="psl-zoom-hint">View larger</span>
            </button>
            <div v-else class="psl-sample-empty">
              {{ sample.loading ? 'Rendering…' : 'Not generated yet' }}
            </div>
          </div>
          <div class="psl-sample-actions">
            <button
              class="btn btn-secondary btn-sm"
              :disabled="renderingAll || sample.loading || !draftDescription.trim() || !previewModel"
              :title="sample.url ? 'Spend one image credit to create a new version of this sample' : 'Generate only this sample'"
              @click="generateSample(sample.variant_id, !!sample.url)"
            >
              {{ sample.loading ? 'Rendering…' : (sample.url ? 'Regenerate this sample' : 'Generate this sample') }}
            </button>
            <button
              v-if="sample.url"
              class="btn btn-ghost btn-sm"
              :class="{ 'psl-gallery-toggle-active': sample.included }"
              @click="toggleSampleIncluded(sample.variant_id)"
            >
              {{ sample.included ? 'Included in gallery' : 'Add to gallery' }}
            </button>
          </div>
          <p class="psl-sample-copy">{{ sample.scene_hint }}</p>
          <p v-if="sample.error" class="psl-error">{{ sample.error }}</p>
        </article>
      </div>
    </div>

    <div class="psl-saved">
      <div class="psl-saved-head">
        <label>Saved custom styles</label>
        <span class="text-muted text-xs">{{ presets.length }} in this project</span>
      </div>
      <div v-if="!presets.length" class="psl-empty card">
        No custom styles saved yet.
      </div>
      <div v-else class="psl-preset-grid">
        <article v-for="preset in presets" :key="preset.id" class="psl-preset-card">
          <div class="psl-preset-top">
            <div>
              <h4>{{ preset.name }}</h4>
              <p class="text-muted text-xs mt-1">
                {{ preset.preview_model || 'No preview model saved' }}{{ preset.preview_aspect_ratio ? ` · ${preset.preview_aspect_ratio}` : '' }}{{ preset.preview_tier ? ` · ${preset.preview_tier}` : '' }}
              </p>
            </div>
            <div class="psl-preset-actions">
              <button class="btn btn-ghost btn-sm" @click="loadPreset(preset)">Edit</button>
              <button v-if="showApply" class="btn btn-ghost btn-sm" @click="applyPreset(preset)">Apply</button>
              <button class="btn btn-ghost btn-sm psl-delete" @click="deletePreset(preset)">Delete</button>
            </div>
          </div>
          <div v-if="presetPreviewFiles(preset).length" class="psl-preset-previews">
            <button
              v-for="file in presetPreviewFiles(preset)"
              :key="file"
              type="button"
              class="psl-image-button"
              title="Open large preview"
              @click="openPresetPreview(preset, file)"
            >
              <img
                :src="previewUrlForPreset(preset, file)"
                :alt="`${preset.name} preview`"
                class="psl-preset-img"
              />
              <span class="psl-zoom-hint">View larger</span>
            </button>
          </div>
          <p class="psl-preset-copy">{{ preset.description }}</p>
        </article>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="lightboxImages.length"
        class="psl-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="lightboxCurrent?.label || 'Style preview'"
        @click.self="closeLightbox"
      >
        <header class="psl-lightbox-head">
          <div>
            <strong>{{ lightboxCurrent?.label }}</strong>
            <span v-if="lightboxImages.length > 1">{{ lightboxIndex + 1 }} / {{ lightboxImages.length }}</span>
          </div>
          <button type="button" class="psl-lightbox-close" aria-label="Close preview" @click="closeLightbox">×</button>
        </header>
        <div class="psl-lightbox-stage">
          <button
            v-if="lightboxImages.length > 1"
            type="button"
            class="psl-lightbox-arrow psl-lightbox-prev"
            :disabled="lightboxIndex === 0"
            aria-label="Previous image"
            @click="lightboxIndex--"
          >‹</button>
          <img v-if="lightboxCurrent" :src="lightboxCurrent.url" :alt="lightboxCurrent.label" />
          <button
            v-if="lightboxImages.length > 1"
            type="button"
            class="psl-lightbox-arrow psl-lightbox-next"
            :disabled="lightboxIndex === lightboxImages.length - 1"
            aria-label="Next image"
            @click="lightboxIndex++"
          >›</button>
        </div>
        <p class="psl-lightbox-help">Esc to close · Arrow keys to browse</p>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { BUILT_IN_STYLES, type BuiltInStyle } from '~/composables/useBuiltInStyles'

interface PresetEntry {
  id: string
  name: string
  description: string
  preview_filename?: string
  preview_files?: string[]
  preview_model?: string
  preview_aspect_ratio?: string
  preview_tier?: string
  preview_saved_at?: string
}

interface LiveSampleState {
  variant_id: string
  label: string
  scene_hint: string
  loading: boolean
  url: string | null
  hash: string | null
  sourceFile: string | null
  included: boolean
  cached: boolean | null
  error: string | null
}

interface LightboxImage {
  url: string
  label: string
}

const props = withDefaults(defineProps<{
  projectSlug: string
  imageModels?: Record<string, any>
  title?: string
  showApply?: boolean
  showBuiltInStarters?: boolean
}>(), {
  title: 'Project style library',
  showApply: false,
  showBuiltInStarters: false,
})

const emit = defineEmits<{
  (e: 'apply', data: { style_bible: string; negative_prompt: string }): void
}>()

const { get, post, put, del } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()

const ASPECT_OPTIONS = ['16:9', '1:1', '9:16'] as const
const SAMPLE_VARIANTS = [
  { id: 'landscape', label: 'Landscape', scene_hint: 'Outdoor wide shot to test overall environment handling.' },
  { id: 'character', label: 'Character', scene_hint: 'Readable subject silhouette and simple front-facing character staging.' },
  { id: 'interior', label: 'Interior', scene_hint: 'Indoor lighting, props, and cozy environmental texture.' },
  { id: 'action', label: 'Action', scene_hint: 'Movement, depth separation, and multi-subject clarity.' },
  { id: 'closeup', label: 'Close-up', scene_hint: 'Face design, line confidence, and emotional readability.' },
] as const

const presets = ref<PresetEntry[]>([])
const draftName = ref('')
const draftDescription = ref('')
const previewModel = ref('')
const previewAspect = ref<(typeof ASPECT_OPTIONS)[number]>('16:9')
const saving = ref(false)
const renderingAll = ref(false)
const renderError = ref<string | null>(null)
const liveSamples = ref<LiveSampleState[]>(SAMPLE_VARIANTS.map(defaultSampleState))
const editingPresetId = ref<string | null>(null)
const editorOriginLabel = ref<string | null>(null)
const lightboxImages = ref<LightboxImage[]>([])
const lightboxIndex = ref(0)

const modelOptions = computed(() =>
  Object.keys(props.imageModels || {}).map(id => ({ value: id, label: id })),
)
const previewModelOptions = computed(() => modelOptions.value.map(option => ({
  id: option.value,
  label: option.label,
  group: 'Image models',
})))
const anySampleLoading = computed(() => liveSamples.value.some(sample => sample.loading))
const galleryCount = computed(() => liveSamples.value.filter(sample => sample.url && sample.included).length)
const lightboxCurrent = computed(() => lightboxImages.value[lightboxIndex.value] || null)

watch(modelOptions, (opts) => {
  if (!previewModel.value && opts.length) previewModel.value = opts[0]!.value
}, { immediate: true })

watch(() => props.projectSlug, () => {
  resetEditor()
  void loadPresets()
})

onMounted(() => {
  void loadPresets()
})

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('keydown', onLightboxKeydown)
})

function defaultSampleState(variant: typeof SAMPLE_VARIANTS[number]): LiveSampleState {
  return {
    variant_id: variant.id,
    label: variant.label,
    scene_hint: variant.scene_hint,
    loading: false,
    url: null,
    hash: null,
    sourceFile: null,
    included: false,
    cached: null,
    error: null,
  }
}

function resetEditor(): void {
  editingPresetId.value = null
  editorOriginLabel.value = null
  draftName.value = ''
  draftDescription.value = ''
  renderError.value = null
  liveSamples.value = SAMPLE_VARIANTS.map(defaultSampleState)
}

async function loadPresets(): Promise<void> {
  try {
    const cfg = await get<{ style_presets?: PresetEntry[] }>(`/projects/${props.projectSlug}/settings/config`)
    presets.value = Array.isArray(cfg?.style_presets) ? cfg.style_presets : []
  } catch {
    presets.value = []
  }
}

function previewUrlForPreset(preset: PresetEntry, file: string): string {
  const stamp = encodeURIComponent(preset.preview_saved_at || '')
  return `/api/projects/${props.projectSlug}/style-presets/${encodeURIComponent(preset.id)}/preview?file=${encodeURIComponent(file)}&t=${stamp}`
}

function presetPreviewFiles(preset: PresetEntry): string[] {
  const files = Array.isArray(preset.preview_files) ? preset.preview_files : []
  if (files.length) return files
  return preset.preview_filename ? [preset.preview_filename] : []
}

async function generateAllSamples(): Promise<void> {
  if (!draftDescription.value.trim() || !previewModel.value || renderingAll.value || anySampleLoading.value) return
  renderingAll.value = true
  renderError.value = null
  liveSamples.value = liveSamples.value.map(sample => ({ ...sample, loading: true, error: null }))
  try {
    await Promise.all(SAMPLE_VARIANTS.map(variant => renderSample(variant.id, false)))
  } finally {
    renderingAll.value = false
    if (liveSamples.value.every(s => !s.url)) {
      renderError.value = 'No samples rendered. Check the selected model or API key.'
    }
  }
}

async function generateSample(variantId: string, force: boolean): Promise<void> {
  if (!draftDescription.value.trim() || !previewModel.value || renderingAll.value) return
  renderError.value = null
  await renderSample(variantId, force)
}

async function renderSample(variantId: string, force: boolean): Promise<void> {
  patchSample(variantId, { loading: true, error: null })
  try {
    const data = await post<{
      hash: string
      url: string
      cached: boolean
      model_id: string
      aspect_ratio: string
      tier: string
      variant_id: string
      created_at: string
    }>(`/projects/${props.projectSlug}/style-preview`, {
      style_tag: draftDescription.value.trim(),
      model: previewModel.value,
      aspect_ratio: previewAspect.value,
      variant_id: variantId,
      force,
    })
    patchSample(variantId, {
      loading: false,
      url: `${data.url}${data.url.includes('?') ? '&' : '?'}t=${encodeURIComponent(data.created_at || Date.now())}`,
      hash: data.hash,
      sourceFile: null,
      included: true,
      cached: !!data.cached,
      error: null,
    })
  } catch (e: any) {
    const message = e?.data?.detail || e?.message || 'Preview failed'
    patchSample(variantId, { loading: false, error: message })
  }
}

function patchSample(variantId: string, patch: Partial<LiveSampleState>): void {
  liveSamples.value = liveSamples.value.map(sample =>
    sample.variant_id === variantId ? { ...sample, ...patch } : sample,
  )
}

function savePayload() {
  const includedSamples = liveSamples.value.filter(sample => sample.url && sample.included)
  const gallery_items: Array<{ hash?: string; source_file?: string }> = []
  for (const sample of includedSamples) {
    if (sample.hash) gallery_items.push({ hash: sample.hash })
    else if (sample.sourceFile) gallery_items.push({ source_file: sample.sourceFile })
  }
  return {
    name: draftName.value.trim(),
    description: draftDescription.value.trim(),
    gallery_items,
    ...(previewModel.value ? { preview_model: previewModel.value } : {}),
    ...(previewAspect.value ? { preview_aspect_ratio: previewAspect.value } : {}),
  }
}

async function saveStyle(): Promise<void> {
  if (!draftName.value.trim() || !draftDescription.value.trim() || saving.value) return
  saving.value = true
  try {
    let saved: PresetEntry
    if (editingPresetId.value) {
      saved = await put<PresetEntry>(`/projects/${props.projectSlug}/style-presets/${encodeURIComponent(editingPresetId.value)}`, savePayload())
      presets.value = presets.value.map(p => p.id === saved.id ? saved : p)
      success(`Updated style "${saved.name}"`)
    } else {
      saved = await post<PresetEntry>(`/projects/${props.projectSlug}/style-presets`, savePayload())
      presets.value = [...presets.value, saved]
      editingPresetId.value = saved.id
      success(`Saved style "${saved.name}"`)
    }
    loadPreset(saved)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save style')
  } finally {
    saving.value = false
  }
}

async function saveAsNewStyle(): Promise<void> {
  if (!draftName.value.trim() || !draftDescription.value.trim() || saving.value) return
  const previousEditingId = editingPresetId.value
  editingPresetId.value = null
  try {
    await saveStyle()
  } finally {
    if (!editingPresetId.value) editingPresetId.value = previousEditingId
  }
}

function loadPreset(preset: PresetEntry): void {
  editingPresetId.value = preset.id
  editorOriginLabel.value = null
  draftName.value = preset.name
  draftDescription.value = preset.description
  if (preset.preview_model) previewModel.value = preset.preview_model
  if (preset.preview_aspect_ratio && ASPECT_OPTIONS.includes(preset.preview_aspect_ratio as any)) {
    previewAspect.value = preset.preview_aspect_ratio as (typeof ASPECT_OPTIONS)[number]
  }
  const previewFiles = presetPreviewFiles(preset)
  liveSamples.value = SAMPLE_VARIANTS.map((variant, index) => {
    const file = previewFiles[index]
    if (!file) return defaultSampleState(variant)
    return {
      ...defaultSampleState(variant),
      url: previewUrlForPreset(preset, file),
      sourceFile: file,
      included: true,
      cached: true,
    }
  })
}

function toggleSampleIncluded(variantId: string): void {
  const sample = liveSamples.value.find(item => item.variant_id === variantId)
  if (!sample?.url) return
  patchSample(variantId, { included: !sample.included })
}

function liveSampleLightboxImages(): LightboxImage[] {
  return liveSamples.value
    .filter(sample => !!sample.url)
    .map(sample => ({ url: sample.url!, label: sample.label }))
}

function openLiveSample(variantId: string): void {
  const images = liveSampleLightboxImages()
  const sample = liveSamples.value.find(item => item.variant_id === variantId)
  if (!sample?.url) return
  openLightbox(images, Math.max(0, images.findIndex(image => image.url === sample.url)))
}

function openPresetPreview(preset: PresetEntry, file: string): void {
  const images = presetPreviewFiles(preset).map((previewFile, index) => ({
    url: previewUrlForPreset(preset, previewFile),
    label: `${preset.name} · Sample ${index + 1}`,
  }))
  openLightbox(images, Math.max(0, presetPreviewFiles(preset).indexOf(file)))
}

function openLightbox(images: LightboxImage[], index: number): void {
  if (!images.length) return
  lightboxImages.value = images
  lightboxIndex.value = Math.max(0, Math.min(index, images.length - 1))
  if (typeof document !== 'undefined') document.addEventListener('keydown', onLightboxKeydown)
}

function closeLightbox(): void {
  lightboxImages.value = []
  lightboxIndex.value = 0
  if (typeof document !== 'undefined') document.removeEventListener('keydown', onLightboxKeydown)
}

function onLightboxKeydown(event: KeyboardEvent): void {
  if (!lightboxImages.value.length) return
  if (event.key === 'Escape') closeLightbox()
  if (event.key === 'ArrowLeft' && lightboxIndex.value > 0) lightboxIndex.value--
  if (event.key === 'ArrowRight' && lightboxIndex.value < lightboxImages.value.length - 1) lightboxIndex.value++
}

function emitApply(): void {
  if (!draftDescription.value.trim()) return
  emit('apply', { style_bible: draftDescription.value.trim(), negative_prompt: '' })
}

function applyPreset(preset: PresetEntry): void {
  emit('apply', { style_bible: preset.description, negative_prompt: '' })
}

function loadBuiltInStyle(style: BuiltInStyle): void {
  editingPresetId.value = null
  editorOriginLabel.value = `Loaded from built-in: ${style.name}`
  draftName.value = style.name
  draftDescription.value = style.data.style_bible
  liveSamples.value = SAMPLE_VARIANTS.map(defaultSampleState)
}

function applyBuiltInStyle(style: BuiltInStyle): void {
  emit('apply', { style_bible: style.data.style_bible, negative_prompt: style.data.negative_prompt || '' })
}

async function deletePreset(preset: PresetEntry): Promise<void> {
  const ok = await ask({
    title: `Delete style "${preset.name}"?`,
    body: 'This removes the saved prompt and bundled preview gallery from this project. Existing generated images stay untouched.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await del(`/projects/${props.projectSlug}/style-presets/${encodeURIComponent(preset.id)}`)
    presets.value = presets.value.filter(p => p.id !== preset.id)
    if (editingPresetId.value === preset.id) resetEditor()
    success(`Deleted style "${preset.name}"`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}
</script>

<style scoped>
.psl {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.psl-head,
.psl-saved-head,
.psl-preset-top,
.psl-sample-head,
.psl-builtin-top,
.psl-editor-state {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.psl-controls,
.psl-actions,
.psl-preset-actions,
.psl-sample-actions,
.psl-sample-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.psl-preview-model { width: min(360px, 72vw); }
.psl-editor,
.psl-empty,
.psl-preset-card,
.psl-builtins,
.psl-builtin-card {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-secondary);
}
.psl-editor-grid {
  display: grid;
  gap: 12px;
}
.psl-field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.psl-samples-grid,
.psl-preset-grid,
.psl-builtins-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.psl-builtin-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background:
    radial-gradient(circle at top right, rgba(240, 198, 116, 0.12), transparent 34%),
    var(--bg-primary);
}
.psl-builtin-card h4 {
  margin: 0;
  font-size: 14px;
}
.psl-builtin-img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.psl-state-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(108, 143, 255, 0.14);
  color: var(--accent);
}
.psl-sample-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-primary);
}
.psl-sample-card.is-included {
  border-color: rgba(108, 143, 255, 0.55);
  box-shadow: inset 0 0 0 1px rgba(108, 143, 255, 0.12);
}
.psl-sample-preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.psl-image-button {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: inherit;
  overflow: hidden;
  background: transparent;
  cursor: zoom-in;
}
.psl-zoom-hint {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.72);
  color: white;
  font-size: 10px;
  opacity: 0;
  transform: translateY(3px);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.psl-image-button:hover .psl-zoom-hint,
.psl-image-button:focus-visible .psl-zoom-hint {
  opacity: 1;
  transform: translateY(0);
}
.psl-sample-img,
.psl-preset-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.psl-gallery-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
}
.psl-gallery-toggle-active,
.psl-sample-chip-gallery {
  color: rgb(110, 231, 183);
  border-color: rgba(16, 185, 129, 0.45);
  background: rgba(16, 185, 129, 0.12);
}
.psl-sample-empty {
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
.psl-sample-copy,
.psl-preset-copy {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.psl-preset-card h4 {
  margin: 0;
  font-size: 14px;
}
.psl-preset-previews {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
  margin: 10px 0;
}
.psl-preset-img {
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.psl-sample-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(108, 143, 255, 0.14);
  color: var(--accent);
}
.psl-error {
  margin: 0;
  font-size: 12px;
  color: rgb(220, 38, 38);
}
.psl-delete {
  color: rgb(220, 38, 38);
}
.psl-lightbox {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  background: rgba(4, 7, 14, 0.94);
}
.psl-lightbox-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  color: white;
}
.psl-lightbox-head div {
  display: flex;
  gap: 12px;
  align-items: baseline;
}
.psl-lightbox-head span,
.psl-lightbox-help {
  color: rgba(255, 255, 255, 0.58);
  font-size: 12px;
}
.psl-lightbox-close,
.psl-lightbox-arrow {
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(0, 0, 0, 0.38);
  color: white;
  cursor: pointer;
}
.psl-lightbox-close {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 23px;
}
.psl-lightbox-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 80px;
}
.psl-lightbox-stage img {
  display: block;
  max-width: 92vw;
  max-height: calc(100vh - 120px);
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.62);
}
.psl-lightbox-arrow {
  position: absolute;
  top: 50%;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  transform: translateY(-50%);
  font-size: 32px;
}
.psl-lightbox-arrow:disabled {
  opacity: 0.25;
  cursor: default;
}
.psl-lightbox-prev { left: 18px; }
.psl-lightbox-next { right: 18px; }
.psl-lightbox-help {
  margin: 0;
  padding: 10px 20px 16px;
  text-align: center;
}
</style>
