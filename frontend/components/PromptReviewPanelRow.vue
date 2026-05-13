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
        {{ promptLen }}<template v-if="cap"> / {{ cap }}</template> chars
      </span>
      <button
        type="button"
        class="btn btn-sm btn-secondary prr-regen-btn"
        :disabled="busy"
        :title="busy
          ? 'Regenerating this prompt — wait a couple of seconds'
          : 'Re-run this single prompt through the LLM. Other prompts on disk stay untouched.'"
        @click="$emit('regenerate')"
      >
        <LoadingSpinner v-if="busy" size="sm" />
        <span v-else aria-hidden="true">🔁</span>
        {{ busy ? 'Regenerating…' : 'Regenerate' }}
      </button>
    </div>

    <div v-if="expanded" class="prr-prompt">{{ row.prompt }}</div>
    <div v-if="error" class="prr-error" :title="error">⚠ {{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

interface PromptRowData { number: number; title: string; prompt: string }
const props = defineProps<{
  row: PromptRowData
  prefix: string
  busy: boolean
  error: string | null
  /** Provider's documented prompt char cap for the active model (advisory).
   *  Pass 0 / null when no cap is known — the counter still renders but
   *  without comparison. */
  cap?: number | null
  /** Friendly model label for the tooltip ("Seedream", "Nano Banana"). */
  modelLabel?: string
}>()
defineEmits<{ (e: 'regenerate'): void }>()

const expanded = ref(false)

const promptLen = computed(() => (props.row?.prompt || '').length)
const charStatusClass = computed(() => {
  if (!props.cap) return 'prr-chars-neutral'
  const ratio = promptLen.value / props.cap
  if (ratio > 1) return 'prr-chars-over'
  if (ratio >= 0.8) return 'prr-chars-warn'
  return 'prr-chars-ok'
})
const charBadgeTooltip = computed(() => {
  if (!props.cap) return `${promptLen.value} characters — no documented cap`
  const remaining = props.cap - promptLen.value
  const modelHint = props.modelLabel ? ` (${props.modelLabel})` : ''
  if (remaining < 0) {
    return `⚠ ${Math.abs(remaining)} chars over the ${props.cap}-char cap${modelHint}. ` +
      `The provider will reject or silently truncate — regenerate prompts before paying credits.`
  }
  if (remaining < props.cap * 0.2) {
    return `Close to the ${props.cap}-char cap${modelHint} — ${remaining} chars left.`
  }
  return `${promptLen.value} / ${props.cap} chars${modelHint}.`
})
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
  font-size: 11px; color: var(--text-muted); font-weight: 600;
}
.prr-title {
  font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.prr-regen-btn { white-space: nowrap; }
.prr-chars {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
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
  font-size: 11px; color: rgb(220, 38, 38);
  cursor: help;
}
</style>
