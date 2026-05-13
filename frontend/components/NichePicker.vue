<template>
  <div class="niche-picker">
    <label class="picker-label">
      <span>Niche</span>
      <span class="hint">Subject-domain layer — gives the channel its topic-area vocabulary, visual style sheet, reference images, and YouTube tag hints. Orthogonal to Format: any format can pair with any niche.</span>
    </label>

    <select
      :value="modelValue || ''"
      class="select"
      :disabled="isLoading || disabled"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
    >
      <option value="">— No niche (format defaults only) —</option>
      <option
        v-for="n in niches"
        :key="n.id"
        :value="n.id"
        :title="n.description"
      >
        {{ n.name }}{{ n.builtin ? '' : ' (custom)' }}
      </option>
    </select>

    <div v-if="selected" class="niche-card">
      <div class="niche-card-header">
        <strong>{{ selected.name }}</strong>
        <span v-if="!selected.builtin" class="custom-badge">custom</span>
        <span v-if="selected.tagline" class="tagline">{{ selected.tagline }}</span>
      </div>
      <p class="niche-description">{{ selected.description }}</p>
      <div class="niche-stats">
        <span><strong>{{ selected.exampleTopics.length }}</strong> example topics</span>
        <span v-if="selected.vocabulary?.keyword">
          <strong>{{ selected.vocabulary.keyword.length }}</strong> niche keywords
        </span>
        <span v-if="selected.referenceImages?.length">
          <strong>{{ selected.referenceImages.length }}</strong> references
        </span>
      </div>
      <details class="niche-preview">
        <summary>Preview niche context</summary>
        <div class="preview-grid">
          <div v-if="selected.scriptContext" class="preview-row">
            <span class="preview-key">Script context</span>
            <span class="preview-val">{{ selected.scriptContext }}</span>
          </div>
          <div v-if="selected.visualStyleSheet" class="preview-row">
            <span class="preview-key">Visual style</span>
            <span class="preview-val">{{ selected.visualStyleSheet }}</span>
          </div>
          <div v-if="selected.audienceHint" class="preview-row">
            <span class="preview-key">Audience</span>
            <span class="preview-val">{{ selected.audienceHint }}</span>
          </div>
          <div v-if="selected.exampleTopics?.length" class="preview-row">
            <span class="preview-key">Example topics</span>
            <span class="preview-val">{{ selected.exampleTopics.slice(0, 6).join(' · ') }}{{ selected.exampleTopics.length > 6 ? ` · +${selected.exampleTopics.length - 6} more` : '' }}</span>
          </div>
        </div>
      </details>
    </div>

    <div v-if="error" class="niche-error">
      Failed to load niches: {{ formatErr(error) }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Niche } from '../composables/useNiches.js'

const props = defineProps<{
  /** Empty string = no niche (this primitive is OPTIONAL, unlike Format). */
  modelValue: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'change': [niche: Niche | null]
}>()

const { niches, isLoading, error, find } = useNiches()

const selected = computed<Niche | undefined>(() => find(props.modelValue))

function onSelect(id: string) {
  emit('update:modelValue', id)
  const n = id ? find(id) : null
  emit('change', n ?? null)
}

function formatErr(e: any): string {
  return e?.data?.detail || e?.message || String(e)
}
</script>

<style scoped>
.niche-picker {
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
  font-size: 11px;
  color: var(--text-muted);
  font-weight: normal;
  line-height: 1.4;
}

.niche-card {
  margin-top: 4px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.niche-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
  flex-wrap: wrap;
}

.custom-badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  background: var(--accent-dim, #2a3148);
  color: var(--accent, #6c8fff);
  border-radius: 3px;
}

.tagline {
  font-size: 11px;
  font-style: italic;
  color: var(--text-muted);
}

.niche-description {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.niche-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 11px;
  color: var(--text-muted);
}

.niche-preview summary {
  cursor: pointer;
  font-size: 11px;
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
  font-size: 11px;
  line-height: 1.5;
}

.preview-key {
  color: var(--text-muted);
  font-weight: 500;
}

.preview-val {
  color: var(--text-primary);
}

.niche-error {
  margin-top: 4px;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--error, #e25c5c);
  background: rgba(226, 92, 92, 0.08);
  border-radius: 4px;
}
</style>
