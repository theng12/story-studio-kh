<template>
  <div v-if="open" class="wizard-backdrop" @click.self="cancel">
    <div class="wizard">
      <header class="wiz-header">
        <h3>Create format from sample script</h3>
        <button class="btn btn-ghost btn-sm" @click="cancel">✕</button>
      </header>

      <p class="wiz-hint">
        Paste 1–3 sample scripts of the genre you want this channel to imitate. The AI extracts a
        Format profile (system prompt, narrator personas, pacing arc, image style, metadata
        keywords) from the samples. You'll review and edit before it lands in the format library.
        Uses this project's API keys.
      </p>

      <!-- Step 1: input -->
      <div v-if="step === 'input'" class="wiz-pane">
        <div class="form-group">
          <label>Sample scripts (1–3, separated by a blank line + "===" between them)</label>
          <span class="hint">Paste full sample text. The AI captures conventions only — your specific characters and plot points won't leak into the format.</span>
          <textarea
            v-model="samplesText"
            class="input"
            rows="14"
            placeholder="Paste your first sample here.&#10;&#10;===&#10;&#10;Optional second sample.&#10;&#10;==="
          />
          <div class="text-muted" style="font-size: var(--font-xs);">
            {{ sampleCount }} sample{{ sampleCount === 1 ? '' : 's' }} detected · {{ totalChars.toLocaleString() }} characters total (capped at ~12k each)
          </div>
        </div>

        <div class="form-group">
          <label>Format name (optional)</label>
          <span class="hint">Leave blank and the AI will infer one. Provide one if you want to control the label and id slug.</span>
          <input v-model="desiredName" class="input" placeholder="e.g. Coastal Folk Tales" />
        </div>

        <div class="form-group">
          <label>Channel intent (optional)</label>
          <span class="hint">One line about what kind of channel you're building. Helps the AI commit to the right vibe when samples are ambiguous.</span>
          <input v-model="channelIntent" class="input" placeholder="e.g. Bedtime channel for adults who like coastal/maritime settings" />
        </div>

        <div class="form-group">
          <label>Model</label>
          <span class="hint">The AI that does the extraction. Uses this project's API keys.</span>
          <ModelSelector v-model="model" :project-slug="projectSlug" label="Format extraction model" />
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" @click="cancel">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="extracting || !canExtract"
            @click="extract"
          >
            <LoadingSpinner v-if="extracting" size="sm" />
            {{ extracting ? 'Extracting…' : 'Extract format' }}
          </button>
        </div>
        <div v-if="extractError" class="wiz-error">{{ extractError }}</div>
      </div>

      <!-- Step 2: review -->
      <div v-if="step === 'review' && extracted" class="wiz-pane">
        <div class="review-header">
          <strong>Extracted format</strong>
          <span class="text-muted" style="font-size: var(--font-xs);">Review the JSON below. Edit anything that looks off, then save.</span>
        </div>

        <div class="form-group">
          <label>Format id (slug — must be kebab-case, no spaces)</label>
          <span class="hint">This is the file name <code>{id}.json</code>. Must be unique. Inferred from the name; edit if it collides.</span>
          <input v-model="formatId" class="input" placeholder="kebab-case-slug" />
        </div>

        <div class="form-group">
          <label>Format JSON</label>
          <span class="hint">Edit the extracted JSON in place. Save will validate the shape; invalid JSON shows an inline error.</span>
          <textarea
            v-model="extractedJson"
            class="input mono"
            rows="20"
            spellcheck="false"
          />
          <div v-if="jsonParseError" class="wiz-error">{{ jsonParseError }}</div>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" @click="step = 'input'">← Back to samples</button>
          <button
            class="btn btn-primary"
            :disabled="saving || !!jsonParseError"
            @click="save(false)"
          >
            <LoadingSpinner v-if="saving" size="sm" />
            {{ saving ? 'Saving…' : 'Save format' }}
          </button>
        </div>
        <div v-if="saveError" class="wiz-error">
          {{ saveError }}
          <button v-if="canOverwrite" class="btn btn-secondary btn-sm" @click="save(true)">
            Overwrite anyway
          </button>
        </div>
      </div>

      <!-- Step 3: done -->
      <div v-if="step === 'done'" class="wiz-pane">
        <div class="wiz-success">
          ✓ Saved as <code>{{ savedFormat?.id }}</code> — {{ savedFormat?.name }}
        </div>
        <p class="text-muted" style="font-size: 12px;">
          The new format now appears in the Format picker (refreshed automatically). Switch any
          project to it from Project Settings → Format. The file lives at
          <code>{{ savedTo }}</code> — copy / share that file to use the format on another machine.
        </p>
        <div class="wiz-actions">
          <button class="btn btn-primary" @click="closeAndUseFormat">Use this format here</button>
          <button class="btn btn-ghost" @click="cancel">Done</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{
  open: boolean
  projectSlug: string
}>()

const emit = defineEmits<{
  'close': []
  'saved': [formatId: string]
}>()

const { post } = useApi()
const { refresh: refreshFormats } = useFormats()

const step = ref<'input' | 'review' | 'done'>('input')
const samplesText = ref('')
const desiredName = ref('')
const channelIntent = ref('')
const model = ref('')
const extracting = ref(false)
const extractError = ref('')

const extracted = ref<any>(null)
const extractedJson = ref('')
const formatId = ref('')
const saving = ref(false)
const saveError = ref('')
const canOverwrite = ref(false)
const savedFormat = ref<any>(null)
const savedTo = ref('')

// Reset on open so a re-open starts fresh.
watch(() => props.open, (o) => {
  if (o) {
    step.value = 'input'
    extractError.value = ''
    saveError.value = ''
    canOverwrite.value = false
  }
})

// Parse the textarea into 1–3 samples split on blank-line + ===.
const samples = computed<string[]>(() => {
  if (!samplesText.value.trim()) return []
  return samplesText.value
    .split(/\n\s*===+\s*\n/)
    .map(s => s.trim())
    .filter(Boolean)
})
const sampleCount = computed(() => samples.value.length)
const totalChars = computed(() => samples.value.reduce((s, x) => s + x.length, 0))
const canExtract = computed(() => samples.value.length >= 1 && samples.value.length <= 3 && model.value)

const jsonParseError = computed(() => {
  if (!extractedJson.value.trim()) return 'Empty JSON'
  try {
    JSON.parse(extractedJson.value)
    return ''
  } catch (e: any) {
    return `JSON parse error: ${e.message}`
  }
})

async function extract() {
  extracting.value = true
  extractError.value = ''
  try {
    const r = await post<{ format: any }>(`/projects/${props.projectSlug}/formats/from-sample`, {
      samples: samples.value,
      model: model.value,
      desired_name: desiredName.value || undefined,
      channel_intent: channelIntent.value || undefined,
    })
    extracted.value = r.format
    formatId.value = String(r.format?.id || '')
    extractedJson.value = JSON.stringify(r.format, null, 2)
    step.value = 'review'
  } catch (e: any) {
    extractError.value = e?.data?.detail || e?.message || 'Extraction failed'
  } finally {
    extracting.value = false
  }
}

async function save(overwrite: boolean) {
  saving.value = true
  saveError.value = ''
  canOverwrite.value = false
  try {
    const parsed = JSON.parse(extractedJson.value)
    parsed.id = formatId.value  // honour any edit to the slug
    const r = await post<{ format: any; savedTo: string }>(`/formats/custom`, {
      format: parsed,
      overwrite,
    })
    savedFormat.value = r.format
    savedTo.value = r.savedTo
    await refreshFormats()
    step.value = 'done'
  } catch (e: any) {
    const detail = e?.data?.detail || e?.message || 'Save failed'
    saveError.value = detail
    if (e?.status === 409 || e?.statusCode === 409 || /already exists/i.test(detail)) {
      canOverwrite.value = true
    }
  } finally {
    saving.value = false
  }
}

function cancel() {
  emit('close')
}

function closeAndUseFormat() {
  emit('saved', savedFormat.value?.id || formatId.value)
  emit('close')
}
</script>

<style scoped>
.wizard-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 24px;
}

.wizard {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 8px);
  width: min(800px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.wiz-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.wiz-header h3 { margin: 0; font-size: 15px; }

.wiz-hint {
  margin: 0;
  padding: 12px 20px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  line-height: 1.5;
}

.wiz-pane {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--text-primary); }
.form-group .hint { font-size: var(--font-xs); color: var(--text-muted); line-height: 1.4; margin-bottom: 4px; }

.review-header { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }

.input.mono { font-family: 'Menlo', 'Monaco', monospace; font-size: var(--font-xs); line-height: 1.5; }

.wiz-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.wiz-error {
  padding: 8px 12px;
  background: rgba(226, 92, 92, 0.08);
  color: var(--error, #e25c5c);
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.wiz-success {
  padding: 12px 14px;
  background: rgba(75, 200, 100, 0.10);
  color: #5fc070;
  border-radius: 6px;
  font-size: 13px;
}
</style>
