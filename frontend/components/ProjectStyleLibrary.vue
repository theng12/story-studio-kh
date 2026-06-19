<template>
  <div class="psl">
    <div class="psl-head">
      <div>
        <label>{{ title }}</label>
        <p class="text-muted text-xs mt-1">
          Build your own style pack for this project, render five real samples with your chosen image model, then save it so every machine sees the same style text and preview gallery.
        </p>
      </div>
      <div class="psl-controls">
        <select v-model="previewModel" class="input input-sm">
          <option value="" :disabled="!!modelOptions.length">Pick preview model</option>
          <option v-for="opt in modelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
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
      <div class="psl-actions">
        <button
          class="btn btn-secondary btn-sm"
          :disabled="renderingAll || !draftDescription.trim() || !previewModel"
          :title="!previewModel ? 'Pick a preview model first' : 'Render five fixed sample scenes with this style'"
          @click="generateAllSamples"
        >
          {{ renderingAll ? 'Rendering 5 samples…' : 'Generate 5 live samples' }}
        </button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="saving || !draftName.trim() || !draftDescription.trim()"
          :title="'Save this style into the project library. If live samples exist, they are saved too.'"
          @click="saveStyle"
        >
          {{ saving ? 'Saving…' : 'Save style to project' }}
        </button>
        <button
          v-if="showApply"
          class="btn btn-ghost btn-sm"
          :disabled="!draftDescription.trim()"
          @click="emitApply()"
        >
          Apply to Style Bible
        </button>
        <span class="text-muted text-xs">Uses your current model selection, so `gpt-image-2` works here.</span>
      </div>
      <p v-if="renderError" class="psl-error">{{ renderError }}</p>

      <div class="psl-samples-grid">
        <article v-for="sample in liveSamples" :key="sample.variant_id" class="psl-sample-card">
          <div class="psl-sample-head">
            <strong>{{ sample.label }}</strong>
            <span v-if="sample.url" class="psl-sample-chip">{{ sample.cached ? 'cached' : 'fresh' }}</span>
          </div>
          <div class="psl-sample-preview">
            <img v-if="sample.url" :src="sample.url" :alt="sample.label" class="psl-sample-img" />
            <div v-else class="psl-sample-empty">
              {{ sample.loading ? 'Rendering…' : 'Not generated yet' }}
            </div>
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
              <button class="btn btn-ghost btn-sm" @click="loadPreset(preset)">Load</button>
              <button v-if="showApply" class="btn btn-ghost btn-sm" @click="applyPreset(preset)">Apply</button>
              <button class="btn btn-ghost btn-sm psl-delete" @click="deletePreset(preset)">Delete</button>
            </div>
          </div>
          <div v-if="presetPreviewFiles(preset).length" class="psl-preset-previews">
            <img
              v-for="file in presetPreviewFiles(preset)"
              :key="file"
              :src="previewUrlForPreset(preset, file)"
              :alt="`${preset.name} preview`"
              class="psl-preset-img"
            />
          </div>
          <p class="psl-preset-copy">{{ preset.description }}</p>
        </article>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
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
  cached: boolean | null
  error: string | null
}

const props = withDefaults(defineProps<{
  projectSlug: string
  imageModels?: Record<string, any>
  title?: string
  showApply?: boolean
}>(), {
  title: 'Project style library',
  showApply: false,
})

const emit = defineEmits<{
  (e: 'apply', data: { style_bible: string; negative_prompt: string }): void
}>()

const { get, post, del } = useApi()
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

const modelOptions = computed(() =>
  Object.keys(props.imageModels || {}).map(id => ({ value: id, label: id })),
)

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

function defaultSampleState(variant: typeof SAMPLE_VARIANTS[number]): LiveSampleState {
  return {
    variant_id: variant.id,
    label: variant.label,
    scene_hint: variant.scene_hint,
    loading: false,
    url: null,
    hash: null,
    cached: null,
    error: null,
  }
}

function resetEditor(): void {
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
  if (!draftDescription.value.trim() || !previewModel.value || renderingAll.value) return
  renderingAll.value = true
  renderError.value = null
  liveSamples.value = SAMPLE_VARIANTS.map(variant => ({ ...defaultSampleState(variant), loading: true }))
  try {
    await Promise.all(SAMPLE_VARIANTS.map(async (variant) => {
      try {
        const data = await post<{
          hash: string
          url: string
          cached: boolean
          model_id: string
          aspect_ratio: string
          tier: string
          variant_id: string
        }>(`/projects/${props.projectSlug}/style-preview`, {
          style_tag: draftDescription.value.trim(),
          model: previewModel.value,
          aspect_ratio: previewAspect.value,
          variant_id: variant.id,
        })
        patchSample(variant.id, {
          loading: false,
          url: data.url,
          hash: data.hash,
          cached: !!data.cached,
          error: null,
        })
      } catch (e: any) {
        const message = e?.data?.detail || e?.message || 'Preview failed'
        patchSample(variant.id, {
          loading: false,
          error: message,
        })
      }
    }))
  } finally {
    renderingAll.value = false
    if (liveSamples.value.every(s => !s.url)) {
      renderError.value = 'No samples rendered. Check the selected model or API key.'
    }
  }
}

function patchSample(variantId: string, patch: Partial<LiveSampleState>): void {
  liveSamples.value = liveSamples.value.map(sample =>
    sample.variant_id === variantId ? { ...sample, ...patch } : sample,
  )
}

async function saveStyle(): Promise<void> {
  if (!draftName.value.trim() || !draftDescription.value.trim() || saving.value) return
  saving.value = true
  try {
    const hashes = liveSamples.value.map(s => s.hash).filter((v): v is string => !!v)
    const saved = await post<PresetEntry>(`/projects/${props.projectSlug}/style-presets`, {
      name: draftName.value.trim(),
      description: draftDescription.value.trim(),
      ...(hashes.length ? { hashes } : {}),
      ...(previewModel.value ? { preview_model: previewModel.value } : {}),
      ...(previewAspect.value ? { preview_aspect_ratio: previewAspect.value } : {}),
    })
    presets.value = [...presets.value, saved]
    success(`Saved style "${saved.name}"`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save style')
  } finally {
    saving.value = false
  }
}

function loadPreset(preset: PresetEntry): void {
  draftName.value = preset.name
  draftDescription.value = preset.description
  if (preset.preview_model) previewModel.value = preset.preview_model
  if (preset.preview_aspect_ratio && ASPECT_OPTIONS.includes(preset.preview_aspect_ratio as any)) {
    previewAspect.value = preset.preview_aspect_ratio as (typeof ASPECT_OPTIONS)[number]
  }
  liveSamples.value = SAMPLE_VARIANTS.map(defaultSampleState)
}

function emitApply(): void {
  if (!draftDescription.value.trim()) return
  emit('apply', { style_bible: draftDescription.value.trim(), negative_prompt: '' })
}

function applyPreset(preset: PresetEntry): void {
  emit('apply', { style_bible: preset.description, negative_prompt: '' })
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
.psl-sample-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.psl-controls,
.psl-actions,
.psl-preset-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.psl-editor,
.psl-empty,
.psl-preset-card {
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
.psl-preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
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
.psl-sample-preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.psl-sample-img,
.psl-preset-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
</style>
