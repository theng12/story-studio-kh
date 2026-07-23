<!--
  Single row inside PromptReviewPanel. Number + title + Regenerate
  button. Click the title row to expand and read the full prompt.
  Owns no fetch state — parent (PromptReviewPanel) drives via
  `busy` + `error` props.
-->
<template>
  <div class="prr">
    <div class="prr-head">
      <button
        type="button"
        class="prr-toggle"
        :aria-expanded="expanded ? 'true' : 'false'"
        :title="expanded ? 'Hide full prompt text' : 'Show full prompt text'"
        @click="expanded = !expanded"
      >
        <span class="prr-toggle-icon" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
        <span class="prr-num">{{ String(row.number).padStart(2, '0') }}</span>
        <span class="prr-title">{{ prefix }} — {{ row.title || '(no title)' }}</span>
      </button>
      <!-- Char counter badge — color-coded against the active image-model's
           prompt cap (passed in by the parent). Green if well under, yellow
           if approaching the cap (≥80%), red if over. When no cap is known
           the badge shows the raw count in muted grey. -->
      <span class="prr-chars" :class="charStatusClass" :title="charBadgeTooltip">
        {{ draftPromptLen }}<template v-if="cap"> / {{ cap }}</template> chars
      </span>
      <button
        type="button"
        class="btn btn-sm btn-secondary prr-regen-btn"
        :disabled="busy || saving"
        :title="busy
          ? 'Regenerating this prompt — wait a couple of seconds'
          : 'Re-run this single prompt through the LLM. Other prompts on disk stay untouched.'"
        @click="emitRegenerate"
      >
        <LoadingSpinner v-if="busy" size="sm" />
        <span v-else aria-hidden="true">🔁</span>
        {{ busy ? 'Regenerating…' : 'Regenerate' }}
      </button>
    </div>

    <div v-if="expanded" class="prr-body">
      <div class="prr-field">
        <label class="prr-label">Title</label>
        <input v-model="draftTitle" type="text" class="input prr-input" maxlength="300" />
      </div>
      <div class="prr-field">
        <div class="prr-label-row">
          <label class="prr-label">Prompt Preview</label>
          <span class="text-muted text-xs">Edit freely, then save or reprompt this row only.</span>
        </div>
        <textarea v-model="draftPrompt" class="textarea prr-textarea" rows="8" />
      </div>
      <div class="prr-field">
        <div class="prr-label-row">
          <label class="prr-label">Reprompt Notes</label>
          <span class="text-muted text-xs">Optional guidance for the next retry.</span>
        </div>
        <textarea
          v-model="repromptNotes"
          class="textarea prr-notes"
          rows="3"
          placeholder="e.g. Make the title treatment more premium, push the hero subject closer, keep stronger negative space behind the lettering."
        />
      </div>
      <div class="prr-actions">
        <button
          type="button"
          class="btn btn-sm btn-primary"
          :disabled="saving || !isDirty || !canSave"
          @click="emitSave"
        >
          <LoadingSpinner v-if="saving" size="sm" />
          {{ saving ? 'Saving…' : 'Save Edits' }}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="!isDirty || busy || saving"
          @click="resetDraft"
        >
          Reset
        </button>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="busy || saving || !canSave"
          @click="emitRegenerate"
        >
          <span aria-hidden="true">✨</span>
          Reprompt With Notes
        </button>
      </div>
    </div>
    <div v-if="error" class="prr-error" :title="error">⚠ {{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

interface PromptRowData { number: number; title: string; prompt: string }
const props = defineProps<{
  row: PromptRowData
  prefix: string
  busy: boolean
  saving?: boolean
  error: string | null
  /** Provider's documented prompt char cap for the active model (advisory).
   *  Pass 0 / null when no cap is known — the counter still renders but
   *  without comparison. */
  cap?: number | null
  /** Friendly model label for the tooltip ("Seedream", "Nano Banana"). */
  modelLabel?: string
}>()
const emit = defineEmits<{
  (e: 'regenerate', payload: { title: string; prompt: string; notes: string }): void
  (e: 'save', payload: { title: string; prompt: string }): void
}>()

const expanded = ref(false)
const draftTitle = ref(props.row.title || '')
const draftPrompt = ref(props.row.prompt || '')
const repromptNotes = ref('')

watch(() => props.row.title, (next) => { draftTitle.value = next || '' })
watch(() => props.row.prompt, (next) => { draftPrompt.value = next || '' })

const draftPromptLen = computed(() => (draftPrompt.value || '').length)
const isDirty = computed(() =>
  draftTitle.value !== (props.row.title || '') ||
  draftPrompt.value !== (props.row.prompt || ''),
)
const canSave = computed(() =>
  draftTitle.value.trim().length > 0 &&
  draftPrompt.value.trim().length >= 10,
)
const charStatusClass = computed(() => {
  if (!props.cap) return 'prr-chars-neutral'
  const ratio = draftPromptLen.value / props.cap
  if (ratio > 1) return 'prr-chars-over'
  if (ratio >= 0.8) return 'prr-chars-warn'
  return 'prr-chars-ok'
})
const charBadgeTooltip = computed(() => {
  if (!props.cap) return `${draftPromptLen.value} characters — no documented cap`
  const remaining = props.cap - draftPromptLen.value
  const modelHint = props.modelLabel ? ` (${props.modelLabel})` : ''
  if (remaining < 0) {
    return `⚠ ${Math.abs(remaining)} chars over the ${props.cap}-char cap${modelHint}. ` +
      `The provider will reject or silently truncate — regenerate prompts before paying credits.`
  }
  if (remaining < props.cap * 0.2) {
    return `Close to the ${props.cap}-char cap${modelHint} — ${remaining} chars left.`
  }
  return `${draftPromptLen.value} / ${props.cap} chars${modelHint}.`
})

function resetDraft(): void {
  draftTitle.value = props.row.title || ''
  draftPrompt.value = props.row.prompt || ''
}

function emitSave(): void {
  if (!canSave.value) return
  emit('save', {
    title: draftTitle.value.trim(),
    prompt: draftPrompt.value.trim(),
  })
}

function emitRegenerate(): void {
  if (!canSave.value) return
  emit('regenerate', {
    title: draftTitle.value.trim(),
    prompt: draftPrompt.value.trim(),
    notes: repromptNotes.value.trim(),
  })
}
</script>

<style scoped>
.prr {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  padding: 8px 10px;
  margin: 4px 0;
}
.prr-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.prr-toggle {
  flex: 1 1 200px; min-width: 0;
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0; background: none; border: none;
  text-align: left; cursor: pointer;
  color: var(--text-primary);
}
.prr-toggle:hover { color: var(--accent); }
.prr-toggle-icon {
  display: inline-block; width: 12px; text-align: center;
  color: var(--text-muted);
}
.prr-num {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs); color: var(--text-muted); font-weight: 600;
}
.prr-title {
  font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.prr-regen-btn { white-space: nowrap; }
.prr-chars {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs);
  padding: 2px 7px;
  border-radius: 10px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.prr-chars-ok      { background: rgba(34,197,94,0.10); color: rgb(21,128,61); border-color: rgba(34,197,94,0.25); }
.prr-chars-warn    { background: rgba(234,179,8,0.12); color: rgb(161,98,7);  border-color: rgba(234,179,8,0.30); }
.prr-chars-over    { background: rgba(220,38,38,0.12); color: rgb(185,28,28); border-color: rgba(220,38,38,0.35); font-weight: 600; }
.prr-chars-neutral { background: var(--bg-tertiary);   color: var(--text-muted); border-color: var(--border); }
.prr-prompt {
  margin-top: 8px; padding: 8px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: 12px; line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap; word-break: break-word;
}
.prr-error {
  margin-top: 6px;
  font-size: var(--font-xs); color: rgb(220, 38, 38);
  cursor: help;
}
.prr-body {
  margin-top: 8px;
  display: grid;
  gap: 10px;
}
.prr-field { display: grid; gap: 4px; }
.prr-label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.prr-label {
  font-size: var(--font-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.prr-input,
.prr-textarea,
.prr-notes {
  width: 100%;
}
.prr-textarea,
.prr-notes {
  font-size: 12px;
  line-height: 1.5;
}
.prr-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
