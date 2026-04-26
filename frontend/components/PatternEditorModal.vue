<template>
  <div v-if="open" class="modal-backdrop" @click.self="cancel">
    <div class="modal">
      <header class="hd">
        <h3>{{ mode === 'create' ? 'New pattern' : 'Edit pattern' }}</h3>
        <button class="btn btn-ghost btn-sm" @click="cancel">✕</button>
      </header>

      <p class="hint-bar">
        Patterns control title shape + body structure on top of a Format.
        Required: an id (slug), a name, a <code>titleTemplate</code> with the
        <code>{X}</code> placeholder, and the opening + closing devices.
        Built-in patterns can't be edited — copy as new instead.
      </p>

      <div class="body">
        <div class="row two">
          <div class="form-group">
            <label>id (slug, locked after create)</label>
            <span class="hint">Letters / digits / hyphens. Mirror the {X} convention with an
              uppercase suffix if useful — e.g. <code>fall-asleep-to-X</code>.</span>
            <input
              v-model="form.id"
              :disabled="mode === 'edit'"
              class="input"
              placeholder="my-custom-X"
            />
          </div>
          <div class="form-group">
            <label>Name (display)</label>
            <span class="hint">Include the literal <code>{X}</code> placeholder so the picker
              shows the template shape — e.g. <code>"History of {X} explained"</code>.</span>
            <input v-model="form.name" class="input" placeholder="My Pattern {X}" />
          </div>
        </div>

        <div class="form-group">
          <label>Description</label>
          <span class="hint">1–2 sentences: when to use this, what tone it produces.</span>
          <textarea v-model="form.description" class="input" rows="2" />
        </div>

        <div class="row two">
          <div class="form-group">
            <label>Title template</label>
            <span class="hint">MUST contain <code>{X}</code>. The user fills {X} per-episode.</span>
            <input v-model="form.titleTemplate" class="input" placeholder="History of {X} explained" />
          </div>
          <div class="form-group">
            <label>Subject label</label>
            <span class="hint">1–2 words describing what {X} is — "Topic", "Era", "City".</span>
            <input v-model="form.subjectLabel" class="input" placeholder="Topic" />
          </div>
        </div>

        <div class="row two">
          <div class="form-group">
            <label>POV</label>
            <select v-model="form.pov" class="select">
              <option value="first">First person ("I…")</option>
              <option value="second">Second person ("you…")</option>
              <option value="third">Third person ("they…")</option>
              <option value="mixed">Mixed</option>
            </select>
          </div>
          <div class="form-group">
            <label>Suggested length (minutes)</label>
            <span class="hint">Min – max range typical for this pattern. Optional.</span>
            <div class="row range">
              <input v-model.number="lengthMin" type="number" min="1" class="input" placeholder="30" />
              <span class="dash">–</span>
              <input v-model.number="lengthMax" type="number" min="1" class="input" placeholder="90" />
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Opening device</label>
          <span class="hint">RULE for opening chapter 1, not actual prose. The script generator
            uses this as an instruction.</span>
          <textarea v-model="form.openingDevice" class="input" rows="3"
            placeholder="Open with a soft welcome. Address the listener in second person…" />
        </div>

        <div class="form-group">
          <label>Body structure (chapter pacing arc)</label>
          <span class="hint">Optional. Each line is one chapter range. Use <code>{lastButOne}</code>
            and <code>{last}</code> as chapter-number placeholders. Leave empty to use the
            current Format's pacing arc unchanged.</span>
          <div class="list-editor">
            <div v-for="(_, i) in bodyStructureRows" :key="i" class="list-row">
              <input v-model="bodyStructureRows[i]" class="input" placeholder="Chapters 1-2: …" />
              <button class="btn btn-ghost btn-sm" @click="bodyStructureRows.splice(i, 1)" title="Remove">−</button>
            </div>
            <button class="btn btn-secondary btn-sm" @click="bodyStructureRows.push('')">+ Add chapter beat</button>
          </div>
        </div>

        <div class="form-group">
          <label>Closing device</label>
          <span class="hint">RULE for the final chapter. Style + intent, not actual prose.</span>
          <textarea v-model="form.closingDevice" class="input" rows="3"
            placeholder="Close with a slow wind-down. The last paragraph should fade rather than end…" />
        </div>

        <div class="form-group">
          <label>Preferred formats</label>
          <span class="hint">
            The Pattern Picker will hide this pattern unless the project's current Format is
            on this list. Leave empty to allow this pattern with any format.
          </span>
          <div class="format-grid">
            <label
              v-for="f in availableFormats"
              :key="f.id"
              class="format-chip"
              :class="{ active: selectedFormatIds.includes(f.id) }"
            >
              <input
                type="checkbox"
                :checked="selectedFormatIds.includes(f.id)"
                @change="toggleFormat(f.id)"
              />
              {{ f.name }}
            </label>
          </div>
        </div>

        <div class="form-group">
          <label>Metadata keyword additions</label>
          <span class="hint">
            Comma-separated. Appended to the format's keyword pool when this pattern is in use
            (search-engine-friendly tags, audience cues).
          </span>
          <input
            v-model="keywordsCsv"
            class="input"
            placeholder="fall asleep to, sleep meditation, ambient narration"
          />
        </div>
      </div>

      <footer class="ft">
        <button class="btn btn-ghost" @click="cancel">Cancel</button>
        <button class="btn btn-primary" :disabled="saving || !validationOk" @click="save">
          <LoadingSpinner v-if="saving" size="sm" />
          {{ saving ? 'Saving…' : (mode === 'create' ? 'Create pattern' : 'Save changes') }}
        </button>
      </footer>
      <div v-if="saveError" class="ft-error">{{ saveError }}</div>
      <div v-if="!validationOk && validationMessage" class="ft-error">{{ validationMessage }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Hand-edit modal for a Pattern. Field-level controls (not raw JSON)
 * so non-power-users can use it. The PatternFromSampleWizard handles
 * the LLM-extract path; this modal is for "I want to type the rules
 * myself" or "let me tweak this extracted pattern further before save".
 *
 * Edit mode locks the id (renaming via PUT isn't supported — the user
 * deletes + recreates). Create mode lets the user pick the id; we
 * default-derive one from the name on first input.
 */
import { ref, reactive, computed, watch } from 'vue'
import type { Pattern } from '~/composables/usePatterns'

const props = defineProps<{
  open: boolean
  /** Edit if a pattern is supplied, Create if null. */
  pattern: Pattern | null
}>()

const emit = defineEmits<{
  'close': []
  'saved': [patternId: string]
}>()

const { save: savePattern, update: updatePattern, refresh: refreshPatterns } = usePatterns()
const { formats } = useFormats()

const mode = computed<'create' | 'edit'>(() => (props.pattern ? 'edit' : 'create'))

// Working copy. We keep bodyStructure + preferredFormats + suggestedLengthMinutes
// out of `form` because they need richer input controls than a plain string.
const form = reactive({
  id: '',
  name: '',
  description: '',
  titleTemplate: '',
  subjectLabel: '',
  pov: 'second' as Pattern['pov'],
  openingDevice: '',
  closingDevice: '',
})
const bodyStructureRows = ref<string[]>([])
const selectedFormatIds = ref<string[]>([])
const keywordsCsv = ref('')
const lengthMin = ref<number | null>(null)
const lengthMax = ref<number | null>(null)
const saving = ref(false)
const saveError = ref('')

const availableFormats = computed(() => formats.value)

function toggleFormat(id: string) {
  const idx = selectedFormatIds.value.indexOf(id)
  if (idx >= 0) selectedFormatIds.value.splice(idx, 1)
  else selectedFormatIds.value.push(id)
}

// On open, hydrate from props.pattern (edit) or reset to blanks (create).
watch(() => props.open, (o) => {
  if (!o) return
  saveError.value = ''
  if (props.pattern) {
    const p = props.pattern
    form.id = p.id
    form.name = p.name
    form.description = p.description
    form.titleTemplate = p.titleTemplate
    form.subjectLabel = p.subjectLabel
    form.pov = p.pov
    form.openingDevice = p.openingDevice
    form.closingDevice = p.closingDevice
    bodyStructureRows.value = [...(p.bodyStructure || [])]
    selectedFormatIds.value = [...(p.preferredFormats || [])]
    keywordsCsv.value = (p.metadataKeywordAdditions || []).join(', ')
    lengthMin.value = p.suggestedLengthMinutes?.[0] ?? null
    lengthMax.value = p.suggestedLengthMinutes?.[1] ?? null
  } else {
    form.id = ''
    form.name = ''
    form.description = ''
    form.titleTemplate = ''
    form.subjectLabel = ''
    form.pov = 'second'
    form.openingDevice = ''
    form.closingDevice = ''
    bodyStructureRows.value = []
    selectedFormatIds.value = []
    keywordsCsv.value = ''
    lengthMin.value = null
    lengthMax.value = null
  }
})

// Auto-derive id from name on create. Once the user types in the id
// field directly, leave it alone (the watch only fires while id is
// empty and we're in create mode).
let userTouchedId = false
watch(() => form.id, () => { if (form.id) userTouchedId = true })
watch(() => form.name, (n) => {
  if (mode.value !== 'create') return
  if (userTouchedId) return
  form.id = slugifyPatternName(n)
})

function slugifyPatternName(name: string): string {
  // Replace {X} with literal X (matches built-in convention) then
  // lowercase + hyphenate. Keep uppercase X intact since that's the
  // shipped convention.
  const replaced = name.replace(/\{X\}/g, 'X')
  return replaced
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const validationMessage = computed(() => {
  if (!form.id.trim()) return 'id is required'
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/.test(form.id)) {
    return 'id must be a slug — letters, digits, hyphens (no leading/trailing hyphen)'
  }
  if (!form.name.trim()) return 'Name is required'
  if (!form.titleTemplate.trim()) return 'Title template is required'
  if (!form.titleTemplate.includes('{X}')) return 'Title template must contain {X}'
  if (!form.subjectLabel.trim()) return 'Subject label is required'
  if (!form.openingDevice.trim()) return 'Opening device is required'
  if (!form.closingDevice.trim()) return 'Closing device is required'
  if ((lengthMin.value !== null || lengthMax.value !== null)
      && !(typeof lengthMin.value === 'number' && lengthMin.value > 0
        && typeof lengthMax.value === 'number' && lengthMax.value > 0
        && lengthMax.value >= lengthMin.value)) {
    return 'Suggested length must be a valid min–max range or both blank'
  }
  return ''
})
const validationOk = computed(() => !validationMessage.value)

async function save() {
  if (!validationOk.value) return
  saving.value = true
  saveError.value = ''
  try {
    // Build the pattern from the working state. Empty optional fields
    // are stripped so they don't end up serialised as empty arrays
    // (which the loader would accept but is noisy on disk).
    const trimmedBody = bodyStructureRows.value.map(r => r.trim()).filter(Boolean)
    const trimmedKeywords = keywordsCsv.value
      .split(',').map(k => k.trim()).filter(Boolean)
    const candidate: any = {
      id: form.id,
      name: form.name.trim(),
      description: form.description.trim(),
      builtin: false,
      schemaVersion: 1,
      titleTemplate: form.titleTemplate.trim(),
      subjectLabel: form.subjectLabel.trim(),
      pov: form.pov,
      openingDevice: form.openingDevice.trim(),
      closingDevice: form.closingDevice.trim(),
    }
    if (trimmedBody.length) candidate.bodyStructure = trimmedBody
    if (selectedFormatIds.value.length) candidate.preferredFormats = [...selectedFormatIds.value]
    if (trimmedKeywords.length) candidate.metadataKeywordAdditions = trimmedKeywords
    if (lengthMin.value && lengthMax.value) {
      candidate.suggestedLengthMinutes = [lengthMin.value, lengthMax.value]
    }

    let saved: Pattern
    if (mode.value === 'edit') {
      saved = await updatePattern(form.id, candidate as Pattern)
    } else {
      saved = await savePattern(candidate as Pattern)
    }
    await refreshPatterns()
    emit('saved', saved.id)
    emit('close')
  } catch (e: any) {
    saveError.value = e?.data?.detail || e?.message || 'Failed to save pattern'
  } finally {
    saving.value = false
  }
}

function cancel() { emit('close') }
</script>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 200; padding: 24px;
}
.modal {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 8px);
  width: min(720px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  display: flex; flex-direction: column;
}
.hd {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
.hd h3 { margin: 0; font-size: 15px; }
.hint-bar {
  margin: 0; padding: 10px 18px;
  background: var(--bg-tertiary);
  font-size: 11px; color: var(--text-secondary); line-height: 1.5;
}

.body { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--text-primary); font-weight: 500; }
.hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; }

.row { display: flex; gap: 12px; }
.row.two > * { flex: 1; min-width: 0; }
.row.range { align-items: center; gap: 8px; }
.row.range .input { width: 80px; }
.dash { color: var(--text-muted); }

.list-editor { display: flex; flex-direction: column; gap: 6px; }
.list-row { display: flex; gap: 6px; align-items: stretch; }
.list-row .input { flex: 1; }

.format-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.format-chip {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 10px; font-size: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px; cursor: pointer;
}
.format-chip.active { background: var(--accent-bg, rgba(75, 130, 200, 0.15)); border-color: var(--accent, #4b82c8); }
.format-chip input { margin: 0; }

.ft { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); }
.ft-error {
  padding: 8px 18px; background: rgba(226, 92, 92, 0.08);
  color: var(--error, #e25c5c); font-size: 12px;
}
</style>
