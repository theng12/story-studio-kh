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
          <div class="iedit-thumb-row">
            <img :src="sourcePreviewUrl" :alt="sourceName" class="iedit-thumb" />
            <div class="iedit-thumb-meta">
              <div class="iedit-filename">{{ sourceName }}</div>
              <div class="text-muted" style="font-size: 11px;">{{ imagePath }}</div>
            </div>
          </div>

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
            <div class="iedit-models">
              <label
                v-for="m in models"
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
                    {{ m.flat_cost_usd ? `~$${m.flat_cost_usd.toFixed(3)}/edit` : '~$0.04–0.19/edit' }}
                    <template v-if="!m.has_key"> · <span class="iedit-nokey">no {{ m.provider === 'google' ? 'Google AI' : 'OpenAI' }} key</span></template>
                  </span>
                </div>
              </label>
            </div>
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
          :disabled="!prompt.trim() || !selectedModelAvailable || generating"
          :title="!selectedModelAvailable ? 'Add the matching API key in Settings' : ''"
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
  provider: 'google' | 'openai'
  label: string
  flat_cost_usd: number | null
  has_key: boolean
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
  if (!prompt.value.trim() || !selectedModelAvailable.value) return
  generating.value = true
  stage.value = 'generating'
  try {
    const r = await post<{ output_path: string; model_used: string }>(
      `/projects/${props.projectSlug}/edit-image`,
      {
        image_path: props.imagePath,
        prompt: prompt.value.trim(),
        model: selectedModel.value,
        replace_original: false,  // never replace on first pass — user confirms in preview
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
