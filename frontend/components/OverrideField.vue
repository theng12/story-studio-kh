<template>
  <div class="ovf">
    <div class="ovf-header">
      <label class="ovf-label">
        <span>{{ label }}</span>
        <span class="ovf-hint">{{ hint }}</span>
      </label>
      <div class="ovf-toggle">
        <span v-if="isOverridden" class="ovf-state ovf-state-on">overridden</span>
        <span v-else class="ovf-state ovf-state-off">using base</span>
        <button
          v-if="!isOverridden"
          class="btn btn-ghost btn-tiny"
          type="button"
          @click="startOverride"
        >Override</button>
        <button
          v-else
          class="btn btn-ghost btn-tiny"
          type="button"
          @click="$emit('update', undefined)"
        >Reset to base</button>
      </div>
    </div>

    <div v-if="!isOverridden" class="ovf-base">
      <span class="ovf-base-label">Base value:</span>
      <span class="ovf-base-value">{{ formatBase(baseValue) }}</span>
    </div>

    <template v-else>
      <textarea
        v-if="type === 'textarea'"
        class="input"
        :value="String(overrideValue ?? '')"
        rows="3"
        @input="$emit('update', ($event.target as HTMLTextAreaElement).value)"
      />
      <input
        v-else-if="type === 'number'"
        class="input"
        type="number"
        :value="overrideValue"
        :min="min" :max="max"
        @input="$emit('update', Number(($event.target as HTMLInputElement).value))"
      />
      <select
        v-else-if="type === 'select'"
        class="select"
        :value="overrideValue ?? ''"
        @change="$emit('update', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="o in (options || [])" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <input
        v-else
        class="input"
        type="text"
        :value="String(overrideValue ?? '')"
        @input="$emit('update', ($event.target as HTMLInputElement).value)"
      />
      <div class="ovf-base-compare">
        <span class="ovf-base-label">Was:</span>
        <span class="ovf-base-value muted">{{ formatBase(baseValue) }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
  hint: string
  baseValue: any
  overrideValue: any
  type: 'text' | 'textarea' | 'number' | 'select'
  min?: number
  max?: number
  options?: Array<{ value: string; label: string }>
}>()

const emit = defineEmits<{
  'update': [value: any]
}>()

const isOverridden = computed(() => props.overrideValue !== undefined && props.overrideValue !== null)

function startOverride() {
  // Seed the override with the current base value so the user sees what
  // they're editing rather than an empty input.
  emit('update', props.baseValue)
}

function formatBase(v: any): string {
  if (v == null) return '—'
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}
</script>

<style scoped>
.ovf {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  border-left: 2px solid transparent;
}

.ovf:has(.ovf-state-on) {
  border-left-color: var(--accent, #6c8fff);
}

.ovf-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.ovf-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--text-primary);
}

.ovf-hint {
  font-size: 10px;
  color: var(--text-muted);
  font-weight: normal;
  line-height: 1.4;
  max-width: 460px;
}

.ovf-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.ovf-state {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  border-radius: 3px;
}

.ovf-state-on {
  background: var(--accent-dim, #2a3148);
  color: var(--accent, #6c8fff);
}

.ovf-state-off {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.btn-tiny { font-size: 10px; padding: 2px 8px; }

.ovf-base, .ovf-base-compare {
  display: flex;
  gap: 6px;
  font-size: 11px;
  line-height: 1.5;
}

.ovf-base-label {
  color: var(--text-muted);
  flex-shrink: 0;
}

.ovf-base-value {
  color: var(--text-secondary);
  word-break: break-word;
}

.ovf-base-value.muted {
  opacity: 0.6;
  text-decoration: line-through;
  text-decoration-color: var(--text-muted);
}

textarea.input {
  font-family: inherit;
  resize: vertical;
}
</style>
