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
import { ref } from 'vue'

interface PromptRowData { number: number; title: string; prompt: string }
defineProps<{
  row: PromptRowData
  prefix: string
  busy: boolean
  error: string | null
}>()
defineEmits<{ (e: 'regenerate'): void }>()

const expanded = ref(false)
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
