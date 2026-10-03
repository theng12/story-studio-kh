<template>
  <div class="niche-picker">
    <label class="picker-label">
      <span>Series Formula — the repeatable episode promise</span>
      <span class="hint">Defines the recurring hook, title shape, script flow, narrator voice, and payoff. Topic Packs choose what the formula covers.</span>
    </label>

    <select
      :value="modelValue || ''"
      class="select"
      :disabled="isLoading || disabled"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
    >
      <option value="">— No Series Formula (generic generation) —</option>
      <optgroup v-for="group in groupedNiches" :key="group.family" :label="group.family">
        <option
          v-for="n in group.items"
          :key="n.id"
          :value="n.id"
          :title="n.description"
        >
          {{ displayName(n) }}{{ n.builtin ? '' : ' (custom)' }}{{ n.catalogStatus === 'legacy' ? ' (legacy)' : '' }}
        </option>
      </optgroup>
    </select>

    <p v-if="!modelValue" class="niche-empty-note">
      Without a Series Formula, Story Studio has no reusable hook or structure to keep a channel consistent.
    </p>

    <div v-if="selected" class="niche-card">
      <div class="niche-card-header">
        <strong>{{ displayName(selected) }}</strong>
        <span v-if="!selected.builtin" class="custom-badge">custom</span>
        <span v-if="selected.catalogStatus === 'legacy'" class="legacy-badge">legacy</span>
        <span v-if="selected.tagline" class="tagline">{{ selected.tagline }}</span>
      </div>
      <p class="niche-description">{{ selected.description }}</p>
      <p v-if="selected.catalogStatus === 'legacy' && selected.successorFormulaId" class="niche-migration-note">
        This existing formula remains usable. New channels should use its successor Formula in the same family when you next save Channel Identity.
      </p>
      <div class="niche-stats">
        <span><strong>{{ selected.exampleTopics.length }}</strong> example topics</span>
        <span v-if="selected.vocabulary?.keyword">
          <strong>{{ selected.vocabulary.keyword.length }}</strong> niche keywords
        </span>
        <span v-if="selected.narratorStyles?.length">
          <strong>{{ selected.narratorStyles.length }}</strong> narrator voices
        </span>
        <span v-if="selected.referenceImages?.length">
          <strong>{{ selected.referenceImages.length }}</strong> references
        </span>
      </div>
      <div v-if="ownsVoice" class="niche-owns" title="This niche provides its own complete voice, independent of the format.">
        ✓ Defines the series voice<span v-if="selected.titleShapeRules?.length"> · title style</span><span v-if="selected.narratorStyles?.length"> · narrator picker</span>
      </div>
      <details class="niche-preview">
        <summary>Preview formula context</summary>
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
      Failed to load Series Formulas: {{ formatErr(error) }}
      <button type="button" class="btn btn-ghost btn-sm" :disabled="isLoading" @click="refresh()">
        {{ isLoading ? 'Retrying…' : 'Try again' }}
      </button>
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
}>()

const { niches, isLoading, error, find, refresh } = useNiches()

const selected = computed<Niche | undefined>(() => find(props.modelValue))
const ownsVoice = computed(() => !!selected.value?.scriptSystemPromptRole)
const groupedNiches = computed(() => {
  const visible = niches.value.filter(n => n.catalogStatus !== 'legacy' || n.id === props.modelValue)
  const byFamily = new Map<string, Niche[]>()
  for (const niche of visible) {
    const family = niche.formulaFamily || (niche.builtin ? 'Other formulas' : 'Custom formulas')
    const items = byFamily.get(family) || []
    items.push(niche)
    byFamily.set(family, items)
  }
  return [...byFamily.entries()]
    .map(([family, items]) => ({ family, items: items.sort((a, b) => displayName(a).localeCompare(displayName(b))) }))
    .sort((a, b) => a.family.localeCompare(b.family))
})

function displayName(niche: Niche): string {
  return niche.catalogName || niche.name
}

function onSelect(id: string) {
  emit('update:modelValue', id)
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  background: var(--accent-dim, #2a3148);
  color: var(--accent, #6c8fff);
  border-radius: 3px;
}
.legacy-badge { font-size: var(--font-xs); text-transform: uppercase; letter-spacing: .05em; padding: 2px 6px; border-radius: 3px; color: #f4c36a; background: rgba(204, 144, 40, .14); }

.tagline {
  font-size: var(--font-xs);
  font-style: italic;
  color: var(--text-muted);
}

.niche-description {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.niche-migration-note { margin: 0; font-size: var(--font-xs); line-height: 1.45; color: #e9c47a; }

.niche-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.niche-owns {
  font-size: var(--font-xs);
  color: var(--success, #4caf7d);
  font-weight: 500;
}

.niche-empty-note {
  margin: 2px 0 0;
  padding: 8px 10px;
  font-size: var(--font-xs);
  line-height: 1.45;
  color: var(--text-secondary);
  background: var(--warning-dim, rgba(220, 160, 60, 0.1));
  border-radius: 4px;
}

.niche-preview summary {
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

.niche-error {
  margin-top: 4px;
  padding: 8px 10px;
  font-size: var(--font-xs);
  color: var(--error, #e25c5c);
  background: rgba(226, 92, 92, 0.08);
  border-radius: 4px;
}
</style>
