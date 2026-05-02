<template>
  <div v-if="modelValue" class="iedit-overlay" @click.self="cancel">
    <div class="iedit-modal">
      <div class="iedit-header">
        <h3>✨ Edit with AI</h3>
        <button type="button" class="btn-icon" aria-label="Close" @click="cancel">✕</button>
      </div>

      <div class="iedit-body">
        <!-- STAGE 1: compose prompt -->
        <div v-if="stage === 'compose'" class="iedit-stage">
          <!-- Top-of-dialog row: collapsed thumb + filename. The user can
               toggle the brush below to switch to the painting view. -->
          <div v-if="!brushOpen" class="iedit-thumb-row">
            <img :src="sourcePreviewUrl" :alt="sourceName" class="iedit-thumb" />
            <div class="iedit-thumb-meta">
              <div class="iedit-filename">{{ sourceName }}</div>
              <div class="text-muted" style="font-size: 11px;">{{ imagePath }}</div>
            </div>
          </div>

          <!-- Brush toggle — only meaningful when the selected model accepts
               masks. For prompt-only models the brush stays hidden so the
               user isn't tempted to paint a mask that'll be ignored. -->
          <div v-if="selectedModelSupportsMask" class="iedit-brush-toggle-row">
            <button
              type="button"
              :class="['btn btn-sm', brushOpen ? 'btn-primary' : 'btn-secondary']"
              :disabled="generating"
              @click="brushOpen = !brushOpen"
              :title="brushOpen ? 'Collapse brush — keep your mask' : 'Paint over the area to erase'"
            >
              {{ brushOpen ? '🖌 Hide brush' : '🖌 Paint a mask…' }}
            </button>
            <span v-if="brushHasMask" class="iedit-brush-status has-mask">Mask drawn — will be sent with the prompt.</span>
            <span v-else-if="brushOpen" class="iedit-brush-status">No mask yet — paint over what you want erased.</span>
          </div>
          <p v-else class="text-muted iedit-brush-disabled-hint">
            Selected model is prompt-only. Pick a model with brush support (fal.ai LaMa, OpenAI gpt-image-1) to paint a mask.
          </p>

          <BrushCanvas
            v-if="brushOpen && selectedModelSupportsMask"
            ref="brushRef"
            :image-url="sourcePreviewUrl"
            :alt="sourceName"
            class="iedit-brush mt-2"
            @update:hasMask="brushHasMask = $event"
          />

          <div class="form-group mt-2">
            <label>Describe the edit</label>
            <textarea
              v-model="prompt"
              class="textarea"
              style="min-height: 80px; font-size: 13px;"
              :disabled="generating"
              placeholder="e.g. remove the yellow text at the top, remove the watermark, clean up the background…"
              @keydown.meta.enter="generate"
              @keydown.ctrl.enter="generate"
            />
            <p class="text-muted mt-1" style="font-size: 11px;">
              Plain English. Don't describe the whole image — just say what to change. Press <kbd>⌘ + Enter</kbd> to generate.
            </p>
          </div>

          <div class="iedit-chips">
            <button v-for="c in SUGGESTION_CHIPS" :key="c" type="button" class="iedit-chip" :disabled="generating" @click="applyChip(c)">
              {{ c }}
            </button>
          </div>

          <div class="form-group mt-2">
            <label>Model</label>
            <p class="text-muted iedit-model-blurb">
              Direct providers go straight to the source API; kie.ai routes
              several alternative models through your existing kie credits.
              Try <strong>Flux Kontext Pro</strong> first — it's the cheapest at ~$0.02/edit
              and is purpose-built for image edits (less drift than general-purpose vision LLMs).
            </p>
            <template v-for="group in groupedModels" :key="group.provider">
              <div v-if="group.models.length" class="iedit-model-group">
                <div class="iedit-model-group-heading">{{ group.label }}</div>
                <div class="iedit-models">
                  <label
                    v-for="m in group.models"
                    :key="m.id"
                    :class="['iedit-model-card', { active: selectedModel === m.id, disabled: !m.has_key }]"
                  >
                    <input
                      type="radio"
                      name="iedit-model"
                      :value="m.id"
                      v-model="selectedModel"
                      :disabled="!m.has_key || generating"
                    />
                    <div class="iedit-model-body">
                      <span class="iedit-model-label">{{ m.label }}</span>
                      <span class="iedit-model-meta">
                        {{ formatCost(m) }}
                        <template v-if="!m.has_key"> · <span class="iedit-nokey">no {{ providerKeyName(m.provider) }} key</span></template>
                      </span>
                    </div>
                  </label>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- STAGE 2: generating -->
        <div v-else-if="stage === 'generating'" class="iedit-stage iedit-generating">
          <LoadingSpinner size="sm" />
          <div class="mt-2" style="font-size: 13px;">Generating via {{ modelLabel(selectedModel) }}…</div>
          <div class="text-muted mt-1" style="font-size: 11px;">Typically 5–20 seconds. Don't refresh.</div>
        </div>

        <!-- STAGE 3: preview before/after -->
        <div v-else-if="stage === 'preview' && resultPath" class="iedit-stage">
          <div class="iedit-diff">
            <div class="iedit-diff-side">
              <div class="iedit-diff-label">Before</div>
              <img :src="sourcePreviewUrl" :alt="sourceName" class="iedit-diff-img" />
            </div>
            <div class="iedit-diff-side">
              <div class="iedit-diff-label">After</div>
              <img :src="resultPreviewUrl" :alt="resultName" class="iedit-diff-img" :key="resultKey" />
            </div>
          </div>
          <p class="text-muted mt-2" style="font-size: 11px;">
            Saved as <code>{{ resultName }}</code>. Original kept.
          </p>

          <label class="iedit-replace-toggle mt-2">
            <input type="checkbox" v-model="replaceOriginal" />
            <span>Replace original file</span>
          </label>
          <p v-if="replaceOriginal" class="text-muted" style="font-size: 11px; margin-top: 4px;">
            Replace original file? The original will be moved to <code>{{ sourceBaseName }}_pre-edit_{timestamp}{{ sourceExt }}</code> first —
            this is reversible by renaming that file back.
          </p>
        </div>
      </div>

      <div class="iedit-footer">
        <button v-if="stage === 'preview'" type="button" class="btn btn-sm btn-secondary" @click="backToCompose">
          ← Try different prompt
        </button>
        <span style="flex: 1;"></span>
        <button type="button" class="btn btn-sm btn-ghost" :disabled="generating" @click="cancel">
          Cancel
        </button>
        <button
          v-if="stage === 'compose'"
          type="button"
          class="btn btn-sm btn-primary"
          :disabled="!canGenerate || generating"
          :title="generateBtnTooltip"
          @click="generate"
        >
          <LoadingSpinner v-if="generating" size="sm" />
          ✨ Generate edit
        </button>
        <button
          v-if="stage === 'preview'"
          type="button"
          class="btn btn-sm btn-primary"
          @click="accept"
        >
          Accept ↓
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * AI-driven image edit modal. The parent mounts this with `v-model`
 * (bool open/close) + `imagePath`. On accept, emits `accepted` with the
 * new absolute path so the parent can swap its own state.
 */

interface ImageEditModel {
  id: string
  provider: 'google' | 'openai' | 'kie' | 'fal'
  label: string
  flat_cost_usd: number | null
  has_key: boolean
  /** True when the model accepts a binary mask. Surfaced for the future
   *  brush UI so the mask layer can hide for prompt-only models. */
  supports_mask?: boolean
}

interface ModelGroup {
  provider: ImageEditModel['provider']
  label: string
  models: ImageEditModel[]
}

const props = withDefaults(defineProps<{
  modelValue: boolean
  projectSlug: string
  imagePath: string
}>(), {})

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  accepted: [newPath: string]
}>()

const { get, post } = useApi()
const { success, error: showError } = useToast()

const SUGGESTION_CHIPS = [
  'Remove all text',
  'Remove the watermark',
  'Remove the logo',
  'Clean up the background',
  'Remove the text at the top',
  'Remove the text at the bottom',
]

const stage = ref<'compose' | 'generating' | 'preview'>('compose')
const prompt = ref('')
const generating = ref(false)
const replaceOriginal = ref(false)
const resultPath = ref<string | null>(null)
const resultKey = ref(0)  // bumped after accept to bust the img cache if needed
const models = ref<ImageEditModel[]>([])
const selectedModel = ref<string>('gemini-2.5-flash-image')

// Brush state. Hidden by default — many users will use prompt-only edits;
// the brush opens only when they explicitly click "Paint a mask…" AND the
// selected model supports it.
const brushOpen = ref(false)
const brushHasMask = ref(false)
const brushRef = ref<{ getMaskBase64: () => string | null; clearMask: () => void } | null>(null)

const sourcePreviewUrl = computed(() => {
  if (!props.imagePath) return ''
  return `/api/projects/${props.projectSlug}/video-editor/preview-image?path=${encodeURIComponent(props.imagePath)}&k=${resultKey.value}`
})

const resultPreviewUrl = computed(() => {
  if (!resultPath.value) return ''
  return `/api/projects/${props.projectSlug}/video-editor/preview-image?path=${encodeURIComponent(resultPath.value)}&k=${resultKey.value}`
})

const sourceName = computed(() => (props.imagePath || '').split('/').pop() || '')
const sourceBaseName = computed(() => sourceName.value.replace(/\.[^.]+$/, ''))
const sourceExt = computed(() => {
  const m = sourceName.value.match(/(\.[^.]+)$/)
  return m ? m[1] : ''
})
const resultName = computed(() => (resultPath.value || '').split('/').pop() || '')

const selectedModelAvailable = computed(() => {
  const m = models.value.find(x => x.id === selectedModel.value)
  return !!m && m.has_key
})

function modelLabel(id: string): string {
  return models.value.find(m => m.id === id)?.label || id
}

/**
 * Groups the flat models[] into provider-titled buckets for the picker.
 * Order matters — direct providers first (cheapest paths, most predictable),
 * then kie.ai (large catalog, some are tiered), then fal (Session 3+).
 * Empty groups are filtered out by the template.
 */
const PROVIDER_LABELS: Record<ImageEditModel['provider'], string> = {
  google: 'Direct providers — Google',
  openai: 'Direct providers — OpenAI',
  kie:    'kie.ai (uses your kie credits)',
  fal:    'fal.ai',
}
const groupedModels = computed<ModelGroup[]>(() => {
  const order: ImageEditModel['provider'][] = ['google', 'openai', 'kie', 'fal']
  return order.map(p => ({
    provider: p,
    label: PROVIDER_LABELS[p],
    models: models.value.filter(m => m.provider === p),
  }))
})

/**
 * Cost label per model. Flat cost → "$0.039/edit". Tiered/variable
 * (flat_cost_usd === null) → a per-provider hint based on the typical
 * range of that provider's models.
 */
function formatCost(m: ImageEditModel): string {
  if (m.flat_cost_usd != null) return `~$${m.flat_cost_usd.toFixed(3)}/edit`
  if (m.provider === 'openai') return '~$0.04–0.19/edit'
  if (m.provider === 'kie')    return '~$0.05–0.24/edit (tiered)'
  return '~varies/edit'
}

function providerKeyName(p: ImageEditModel['provider']): string {
  switch (p) {
    case 'google': return 'Google AI'
    case 'openai': return 'OpenAI'
    case 'kie':    return 'kie.ai'
    case 'fal':    return 'fal.ai'
  }
}

const selectedModelSupportsMask = computed(() => {
  return models.value.find(m => m.id === selectedModel.value)?.supports_mask === true
})

/**
 * Whether the user has provided enough input for `generate()` to proceed.
 *
 *   - fal.ai LaMa: mask required, prompt ignored.
 *   - Other mask-capable models: prompt required (mask optional — strengthens
 *     precision when present, but the model can still run prompt-only).
 *   - Prompt-only models: prompt required.
 */
const canGenerate = computed(() => {
  if (!selectedModelAvailable.value) return false
  if (selectedModel.value === 'fal-lama') {
    return brushOpen.value && brushHasMask.value
  }
  return prompt.value.trim().length > 0
})

const generateBtnTooltip = computed(() => {
  if (!selectedModelAvailable.value) return 'Add the matching API key in Settings'
  if (selectedModel.value === 'fal-lama' && !(brushOpen.value && brushHasMask.value)) {
    return 'fal.ai LaMa needs a mask — open the brush above and paint over the area to erase.'
  }
  if (!prompt.value.trim() && selectedModel.value !== 'fal-lama') {
    return 'Describe the edit before generating.'
  }
  return ''
})

// When the user picks a non-mask-capable model while the brush is open,
// auto-collapse it so the painted mask isn't silently ignored on submit.
// We don't clear the painted strokes — switching back to a mask-capable
// model restores them.
watch(selectedModelSupportsMask, (supports) => {
  if (!supports && brushOpen.value) {
    brushOpen.value = false
  }
})

async function loadCaps() {
  try {
    const data = await get<{ models: ImageEditModel[]; default: string }>(`/projects/${props.projectSlug}/image-edit/caps`)
    models.value = data.models
    const firstWithKey = data.models.find(m => m.has_key)
    selectedModel.value = firstWithKey?.id || data.default
  } catch (e: any) {
    showError(e?.data?.detail || 'Could not load edit-image models')
  }
}

function applyChip(text: string) {
  prompt.value = prompt.value.trim() ? `${prompt.value.trim()}. ${text.toLowerCase()}` : text
}

async function generate() {
  if (!selectedModelAvailable.value) return
  // fal.ai LaMa is mask-only and ignores the prompt — guard the input
  // contract so the user can't generate without a mask.
  const usingMask = selectedModelSupportsMask.value && brushOpen.value && brushHasMask.value
  const isFalLama = selectedModel.value === 'fal-lama'
  if (isFalLama && !usingMask) {
    showError('fal.ai LaMa needs a mask — open the brush above and paint over the area to erase.')
    return
  }
  if (!isFalLama && !prompt.value.trim()) return

  // Snapshot the mask BEFORE we toggle to "generating" — that hides the
  // BrushCanvas and we lose the ref to its export helper.
  const maskB64 = usingMask ? (brushRef.value?.getMaskBase64() || null) : null

  generating.value = true
  stage.value = 'generating'
  try {
    const r = await post<{ output_path: string; model_used: string }>(
      `/projects/${props.projectSlug}/edit-image`,
      {
        image_path: props.imagePath,
        prompt: isFalLama ? '' : prompt.value.trim(),
        model: selectedModel.value,
        replace_original: false,  // never replace on first pass — user confirms in preview
        mask_b64: maskB64 || undefined,
      },
    )
    resultPath.value = r.output_path
    resultKey.value++
    stage.value = 'preview'
  } catch (e: any) {
    showError(e?.data?.detail || 'Image edit failed')
    stage.value = 'compose'
  } finally {
    generating.value = false
  }
}

async function accept() {
  if (!resultPath.value) return
  if (!replaceOriginal.value) {
    // Already saved as _edited_vN — just return that path.
    success('Edit applied')
    emit('accepted', resultPath.value)
    close()
    return
  }
  // User asked to replace — confirm, then re-run with replace_original=true.
  const ok = confirm(
    `Replace original file?\n\nThe original will be moved to "${sourceBaseName.value}_pre-edit_{timestamp}${sourceExt.value}" first — this is reversible by renaming that file back.`,
  )
  if (!ok) return
  generating.value = true
  try {
    const r = await post<{ output_path: string; backup_path: string }>(
      `/projects/${props.projectSlug}/edit-image`,
      {
        image_path: props.imagePath,
        prompt: prompt.value.trim(),
        model: selectedModel.value,
        replace_original: true,
      },
    )
    resultKey.value++  // bust preview caches
    success(`Original replaced — backup at ${(r.backup_path || '').split('/').pop() || 'disk'}`)
    emit('accepted', r.output_path)
    close()
  } catch (e: any) {
    showError(e?.data?.detail || 'Replace failed')
  } finally {
    generating.value = false
  }
}

function backToCompose() {
  stage.value = 'compose'
  resultPath.value = null
}

function close() {
  emit('update:modelValue', false)
}

function cancel() {
  if (generating.value) return
  close()
}

// Reset on open; load caps once per open.
watch(() => props.modelValue, (open) => {
  if (open) {
    stage.value = 'compose'
    prompt.value = ''
    replaceOriginal.value = false
    resultPath.value = null
    brushOpen.value = false
    brushHasMask.value = false
    void loadCaps()
  }
})

onMounted(() => {
  if (props.modelValue) void loadCaps()
})
</script>

<style scoped>
.iedit-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0, 0, 0, 0.65);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.iedit-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: min(640px, 95vw);
  max-height: 90vh;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.iedit-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.iedit-header h3 { margin: 0; font-size: 15px; }
.btn-icon {
  background: none; border: none; cursor: pointer;
  color: var(--text-muted); font-size: 16px; padding: 4px 8px;
}
.btn-icon:hover { color: var(--text-primary); }
.iedit-body { padding: 16px 18px; overflow-y: auto; flex: 1; }
.iedit-footer {
  display: flex; gap: 8px; align-items: center;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

.iedit-stage { display: flex; flex-direction: column; }

.iedit-thumb-row { display: flex; gap: 12px; align-items: flex-start; }
.iedit-thumb { width: 120px; height: 120px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border); flex-shrink: 0; }
.iedit-thumb-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.iedit-filename { font-size: 13px; font-weight: 600; color: var(--text-primary); }

.iedit-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.iedit-chip {
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  transition: background 0.1s, border-color 0.1s;
}
.iedit-chip:hover { border-color: var(--accent); color: var(--accent); }
.iedit-chip:disabled { opacity: 0.5; cursor: not-allowed; }

/* Inline blurb above the provider-grouped model list. */
.iedit-model-blurb { font-size: 11px; margin-top: 2px; margin-bottom: 8px; line-height: 1.5; }

/* Brush toggle row — sits where the source-thumb row would normally
 * appear, swapping in only when a mask-capable model is selected. */
.iedit-brush-toggle-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.iedit-brush-status {
  font-size: 11px;
  color: var(--text-muted);
}
.iedit-brush-status.has-mask {
  color: var(--accent);
  font-weight: 500;
}
.iedit-brush-disabled-hint {
  font-size: 11px;
  margin-top: 4px;
  font-style: italic;
}
.iedit-brush { width: 100%; }

/* Provider buckets — each group has its own heading + grid of cards.
 * Heading is small + uppercase to read as section break, not as a competing
 * label with the cards beneath it. */
.iedit-model-group { margin-top: 8px; }
.iedit-model-group:first-child { margin-top: 0; }
.iedit-model-group-heading {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin-bottom: 4px;
  font-weight: 600;
}

.iedit-models { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.iedit-model-card {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  border: 2px solid var(--border);
  cursor: pointer;
}
.iedit-model-card:hover { border-color: var(--text-secondary); }
.iedit-model-card.active { border-color: var(--accent); background: var(--accent-dim); }
.iedit-model-card.disabled { opacity: 0.55; cursor: not-allowed; }
.iedit-model-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.iedit-model-label { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.iedit-model-meta { font-size: 10px; color: var(--text-muted); }
.iedit-nokey { color: rgb(180, 83, 9); }

.iedit-generating {
  padding: 40px 20px;
  align-items: center;
  text-align: center;
}

.iedit-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.iedit-diff-side { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.iedit-diff-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; }
.iedit-diff-img { width: 100%; border-radius: var(--radius-sm); border: 1px solid var(--border); background: #000; }

.iedit-replace-toggle {
  display: flex; gap: 8px; align-items: center;
  font-size: 12px;
  cursor: pointer;
}

kbd {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 10px;
  font-family: inherit;
}

@media (max-width: 640px) {
  .iedit-models { grid-template-columns: 1fr; }
  .iedit-diff { grid-template-columns: 1fr; }
}
</style>
