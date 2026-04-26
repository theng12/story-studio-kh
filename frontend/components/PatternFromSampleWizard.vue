<template>
  <div v-if="open" class="wizard-backdrop" @click.self="cancel">
    <div class="wizard">
      <header class="wiz-header">
        <h3>Create pattern from sample script</h3>
        <button class="btn btn-ghost btn-sm" @click="cancel">✕</button>
      </header>

      <p class="wiz-hint">
        Paste 1–3 sample scripts that share the same <em>title style + structure</em>
        (e.g. all "Fall asleep to {X}" pieces or all "History of {X} explained" docs).
        The AI extracts a Pattern profile — the title template, opening hook, body
        pacing, closing wind-down — that you can then use to generate any new
        episode in that style. Uses this project's API keys.
      </p>

      <!-- Step 1: input -->
      <div v-if="step === 'input'" class="wiz-pane">
        <div class="form-group">
          <label>Sample scripts (1–3, separated by a blank line + "===" between them)</label>
          <span class="hint">
            Paste full sample text. The AI captures the GENERIC convention only —
            the specific subject (e.g. "a Roman bathhouse") doesn't leak into the pattern;
            it gets templated as <code>{X}</code> automatically.
          </span>
          <textarea
            v-model="samplesText"
            class="input"
            rows="14"
            placeholder="Paste your first sample here.&#10;&#10;===&#10;&#10;Optional second sample.&#10;&#10;==="
          />
          <div class="text-muted" style="font-size: 11px;">
            {{ sampleCount }} sample{{ sampleCount === 1 ? '' : 's' }} detected · {{ totalChars.toLocaleString() }} characters total (capped at ~12k each)
          </div>
        </div>

        <div class="form-group">
          <label>Pattern name (optional)</label>
          <span class="hint">
            Leave blank and the AI will infer one. If you provide it, include the
            <code>{X}</code> placeholder verbatim — e.g. <code>"History of {X} explained"</code>.
          </span>
          <input v-model="desiredName" class="input" placeholder="e.g. History of {X} explained" />
        </div>

        <div class="form-group">
          <label>Intent / hint (optional)</label>
          <span class="hint">One line about what kind of pattern you're building. Helps the AI commit when samples are ambiguous.</span>
          <input v-model="intent" class="input" placeholder="e.g. Educational deep-dives in second-person POV with a soft sleep-friendly close" />
        </div>

        <div class="form-group">
          <label>Model</label>
          <span class="hint">The AI that does the extraction. Uses this project's API keys.</span>
          <select v-model="model" class="select">
            <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (recommended)</option>
            <option value="claude-opus-4-5">Claude Opus 4.5</option>
            <option value="gpt-4o">GPT-4o</option>
            <option value="gpt-4-turbo">GPT-4 Turbo</option>
          </select>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" @click="cancel">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="extracting || !canExtract"
            @click="extract"
          >
            <LoadingSpinner v-if="extracting" size="sm" />
            {{ extracting ? 'Extracting…' : 'Extract pattern' }}
          </button>
        </div>
        <div v-if="extractError" class="wiz-error">{{ extractError }}</div>
      </div>

      <!-- Step 2: review -->
      <div v-if="step === 'review' && extracted" class="wiz-pane">
        <div class="review-header">
          <strong>Extracted pattern</strong>
          <span class="text-muted" style="font-size: 11px;">
            Review the JSON below. Edit anything that looks off, then save.
            <code>titleTemplate</code> must contain <code>{X}</code>; the slug id
            should be unique.
          </span>
        </div>

        <div class="form-group">
          <label>Pattern id (slug — letters, digits, hyphens; uppercase OK for the X suffix)</label>
          <span class="hint">
            This is the file name <code>{id}.json</code>. Must be unique. Built-in
            patterns use the convention <code>fall-asleep-to-X</code> with an
            uppercase X mirroring the placeholder.
          </span>
          <input v-model="patternId" class="input" placeholder="e.g. history-of-X-explained" />
        </div>

        <div class="form-group">
          <label>Pattern JSON</label>
          <span class="hint">Edit the extracted JSON in place. Save validates the shape; invalid JSON shows an inline error.</span>
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
            {{ saving ? 'Saving…' : 'Save pattern' }}
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
          ✓ Saved as <code>{{ savedPattern?.id }}</code> — {{ savedPattern?.name }}
        </div>
        <p class="text-muted" style="font-size: 12px;">
          The new pattern now appears in the Pattern picker (Script Generator + Ideas Generator).
          The file lives at <code>~/.../projects/.patterns/{{ savedPattern?.id }}.json</code> —
          copy / share that file to use the pattern on another machine.
        </p>
        <div class="wiz-actions">
          <button class="btn btn-ghost" @click="cancel">Done</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Two-step wizard mirroring FormatFromSampleWizard.vue:
 *   1. INPUT  — paste samples + optional name/intent/model → POST extract
 *   2. REVIEW — show extracted JSON + slug input → save (allows
 *               overwrite-on-conflict)
 *   3. DONE   — success ack with file path hint
 *
 * Re-uses the project API keys for the LLM call. The backend prompt is
 * pattern-specific (lib/pattern-extraction-prompt.ts) — it knows about
 * {X} placeholders, preferredFormats, etc. — so the wizard only has to
 * surface the same UX shape as the format wizard.
 */
import { ref, computed, watch } from 'vue'
import type { Pattern } from '~/composables/usePatterns'

const props = defineProps<{
  open: boolean
  projectSlug: string
}>()

const emit = defineEmits<{
  'close': []
  'saved': [patternId: string]
}>()

const { extract: extractPattern, save: savePattern, refresh: refreshPatterns } = usePatterns()

const step = ref<'input' | 'review' | 'done'>('input')
const samplesText = ref('')
const desiredName = ref('')
const intent = ref('')
const model = ref('claude-sonnet-4-5')
const extracting = ref(false)
const extractError = ref('')

const extracted = ref<Pattern | null>(null)
const extractedJson = ref('')
const patternId = ref('')
const saving = ref(false)
const saveError = ref('')
const canOverwrite = ref(false)
const savedPattern = ref<Pattern | null>(null)

// Reset on each open so a re-open starts fresh.
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
    const pattern = await extractPattern(props.projectSlug, {
      samples: samples.value,
      model: model.value,
      desired_name: desiredName.value || undefined,
      intent: intent.value || undefined,
    })
    extracted.value = pattern
    patternId.value = String((pattern as any)?.id || '')
    extractedJson.value = JSON.stringify(pattern, null, 2)
    step.value = 'review'
  } catch (e: any) {
    // 422 returns { detail, raw } — show the detail so the user knows
    // what to tweak rather than getting an opaque "extraction failed".
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
    parsed.id = patternId.value  // honour any user edit to the slug
    const saved = await savePattern(parsed as Pattern, { overwrite })
    savedPattern.value = saved
    await refreshPatterns()
    step.value = 'done'
    emit('saved', saved.id)
  } catch (e: any) {
    const detail = e?.data?.detail || e?.message || 'Save failed'
    saveError.value = detail
    // 409 conflict → offer overwrite. Built-in collision is also 409
    // territory but the user-action there is "rename", not "overwrite",
    // so the button gets ignored if message contains "matches a built-in".
    if ((e?.status === 409 || e?.statusCode === 409 || /already exists/i.test(detail))
        && !/matches a built-in/i.test(detail)) {
      canOverwrite.value = true
    }
  } finally {
    saving.value = false
  }
}

function cancel() {
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
.form-group .hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; margin-bottom: 4px; }

.review-header { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }

.input.mono { font-family: 'Menlo', 'Monaco', monospace; font-size: 11px; line-height: 1.5; }

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
