<template>
  <div class="format-picker">
    <label class="picker-label">
      <span>Production Path — how the video is built</span>
      <span class="hint">This controls scene generation and assembly. Your <strong>Series Formula</strong> decides what the video says, its point of view, and how it sounds.</span>
    </label>

    <select
      :value="modelValue"
      class="select"
      :disabled="isLoading || disabled"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
    >
      <option v-if="!modelValue" value="">— Select a format —</option>
      <option
        v-for="f in formats"
        :key="f.id"
        :value="f.id"
        :title="f.description"
      >
        {{ f.name }}{{ f.builtin ? '' : ' (custom)' }}
      </option>
    </select>

    <div v-if="selected" class="format-card">
      <div class="format-card-header">
        <strong>{{ selected.name }}</strong>
        <span v-if="!selected.builtin" class="custom-badge">custom</span>
      </div>
      <p class="format-buildline">🛠 {{ buildLine }}</p>
      <p class="format-description">{{ selected.description }}</p>
      <div class="format-stats">
        <span><strong>{{ selected.script.defaultChapterCount }}</strong> {{ sectionPlural.toLowerCase() }} / <strong>{{ selected.script.defaultLengthMinutes }}</strong> min default</span>
        <span><strong>{{ selected.imagePrompts.defaultScenesTotalRange[0] }}–{{ selected.imagePrompts.defaultScenesTotalRange[1] }}</strong> scenes</span>
        <span><strong>{{ sceneTiming }}</strong> pacing</span>
      </div>
      <p class="format-niche-note">
        Voice, vocabulary, narrator style, and emotional tone come from the <strong>Series Formula</strong> — not the Production Path.
      </p>
    </div>

    <div v-if="error" class="format-error">
      Failed to load formats: {{ formatErr(error) }}
      <button type="button" class="btn btn-ghost btn-sm" :disabled="isLoading" @click="refresh()">
        {{ isLoading ? 'Retrying…' : 'Try again' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatBuildLine, type Format } from '../composables/useFormats.js'

const props = defineProps<{
  modelValue: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'change': [format: Format]
}>()

const { formats, isLoading, error, find, refresh } = useFormats()

const selected = computed<Format | undefined>(() => find(props.modelValue))
const buildLine = computed(() => selected.value ? formatBuildLine(selected.value) : '')
const sectionPlural = computed(() => selected.value?.script.sectionLabel?.plural || 'Chapters')
const sceneTiming = computed(() => {
  const f = selected.value
  if (!f) return ''
  const sentence = f.visualSource === 'timestamp-driven' || f.visualSource === 'narrated-scenes' || f.sceneAlignment === 'sentence'
  return sentence ? 'sentence-timed' : 'chapter-even'
})

function onSelect(id: string) {
  emit('update:modelValue', id)
  const fmt = find(id)
  if (fmt) emit('change', fmt)
}

function formatErr(e: any): string {
  return e?.data?.detail || e?.message || String(e)
}
</script>

<style scoped>
.format-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.picker-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  color: var(--text-primary);
}

.picker-label .hint {
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-weight: normal;
  line-height: 1.4;
}

.format-card {
  margin-top: 4px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.format-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
}

.custom-badge {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  background: var(--accent-dim, #2a3148);
  color: var(--accent, #6c8fff);
  border-radius: 3px;
}

.format-buildline {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
}

.format-description {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.format-niche-note {
  margin: 4px 0 0;
  padding: 8px 10px;
  font-size: var(--font-xs);
  line-height: 1.45;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 4px;
}

.format-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.format-preview summary {
  cursor: pointer;
  font-size: var(--font-xs);
  color: var(--accent, #6c8fff);
  user-select: none;
  margin-top: 4px;
}

.preview-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 10px;
  background: var(--bg-tertiary);
  border-radius: 4px;
}

.preview-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 10px;
  font-size: var(--font-xs);
  line-height: 1.5;
}

.preview-key {
  color: var(--text-muted);
  font-weight: 500;
}

.preview-val {
  color: var(--text-primary);
}

.format-error {
  margin-top: 4px;
  padding: 8px 10px;
  font-size: var(--font-xs);
  color: var(--error, #e25c5c);
  background: rgba(226, 92, 92, 0.08);
  border-radius: 4px;
}
</style>
