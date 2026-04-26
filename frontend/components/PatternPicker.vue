<template>
  <div class="pattern-picker">
    <label class="picker-label">
      <span>Pattern <span class="optional-tag">(optional)</span></span>
      <span class="hint">
        Episode-shape template that composes on top of your project's format. Leave blank to
        generate a normal episode in your format. Pick a pattern (e.g. "Fall asleep to {X}",
        "The entire history of {X} explained") to apply a structural template — title shape,
        opening device, chapter arc, closing.
      </span>
    </label>

    <div class="picker-row">
      <select
        :value="modelValue"
        class="select"
        :disabled="isLoading || disabled"
        @change="onSelect(($event.target as HTMLSelectElement).value)"
      >
        <option value="">— No pattern (use format defaults) —</option>
        <option
          v-for="p in availablePatterns"
          :key="p.id"
          :value="p.id"
          :title="p.description"
        >
          {{ p.name }}{{ p.builtin ? '' : ' (custom)' }}
        </option>
      </select>

      <input
        v-if="selected"
        v-model="subjectLocal"
        class="input subject-input"
        :placeholder="selected.subjectLabel + ' (the {X} value)'"
        @input="emit('update:subject', subjectLocal)"
      />
    </div>

    <!-- Filter toggle: by default we hide patterns whose preferredFormats
         doesn't include the current format. Power users can flip this
         off to see every pattern (the "pairs with" badge below still
         flags the mismatch). Hidden when no formatId is supplied since
         the filter wouldn't apply. -->
    <div v-if="formatId" class="picker-filter">
      <label class="filter-toggle">
        <input type="checkbox" v-model="showAll" />
        Show all patterns (including those not paired with <code>{{ formatId }}</code>)
      </label>
      <span v-if="!showAll && hiddenCount > 0" class="filter-meta">
        {{ hiddenCount }} hidden — uncheck "Show all" if you want them
      </span>
    </div>

    <div v-if="selected" class="pattern-card">
      <div class="card-row">
        <span class="card-key">Resolved title</span>
        <span class="card-val">
          <strong>{{ resolvedTitle }}</strong>
        </span>
      </div>
      <div class="card-row">
        <span class="card-key">POV</span>
        <span class="card-val">{{ povLabel(selected.pov) }}</span>
      </div>
      <div class="card-row">
        <span class="card-key">Opening device</span>
        <span class="card-val">{{ selected.openingDevice }}</span>
      </div>
      <details v-if="selected.bodyStructure?.length" class="pattern-body">
        <summary>Body structure ({{ selected.bodyStructure.length }} beats)</summary>
        <ol class="beats">
          <li v-for="(b, i) in selected.bodyStructure" :key="i">{{ b }}</li>
        </ol>
      </details>
      <div class="card-row">
        <span class="card-key">Closing device</span>
        <span class="card-val">{{ selected.closingDevice }}</span>
      </div>
      <div v-if="selected.preferredFormats?.length" class="card-row">
        <span class="card-key">Pairs with</span>
        <span class="card-val">
          <span v-if="selected.preferredFormats.includes(formatId)" class="pairs-badge ok">✓ {{ formatId }}</span>
          <span v-else class="pairs-badge warn">⚠ better with: {{ selected.preferredFormats.join(', ') }}</span>
        </span>
      </div>
    </div>

    <div v-if="error" class="pattern-error">
      Failed to load patterns: {{ formatErr(error) }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Pattern } from '../composables/usePatterns.js'

const props = defineProps<{
  modelValue: string             // pattern_id
  subject: string                // pattern_subject
  formatId: string               // current project format, for compatibility hints
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:subject': [value: string]
  'change': [pattern: Pattern | null]
}>()

const { patterns, isLoading, error, find, compatibleWith } = usePatterns()
const subjectLocal = ref(props.subject)
watch(() => props.subject, v => { subjectLocal.value = v })

const selected = computed<Pattern | undefined>(() => find(props.modelValue))

// Default behavior: FILTER patterns by current format compatibility.
// Power users can flip the toggle to see everything. We always include
// the currently-selected pattern in the dropdown even when it doesn't
// match — otherwise switching format would visually drop the user's
// selection from the list (without unsetting modelValue), which is
// confusing.
const showAll = ref(false)

const availablePatterns = computed(() => {
  if (!props.formatId || showAll.value) return patterns.value
  const compat = compatibleWith(props.formatId)
  // Ensure the currently-selected pattern stays visible even if filter
  // would hide it. Without this, switching format mid-edit would make
  // the dropdown briefly look empty for the chosen value.
  if (props.modelValue && !compat.some(p => p.id === props.modelValue)) {
    const sel = find(props.modelValue)
    if (sel) return [sel, ...compat]
  }
  return compat
})

const hiddenCount = computed(() => {
  if (!props.formatId || showAll.value) return 0
  return patterns.value.length - availablePatterns.value.length
})

const resolvedTitle = computed(() => {
  if (!selected.value) return ''
  const subj = (subjectLocal.value || '').trim() || selected.value.subjectLabel
  return selected.value.titleTemplate.replace(/\{X\}/g, subj)
})

function onSelect(id: string) {
  emit('update:modelValue', id)
  emit('change', id ? find(id) || null : null)
}

function povLabel(pov: string): string {
  return ({
    first: 'First-person ("I")',
    second: 'Second-person ("you")',
    third: 'Third-person',
    mixed: 'Mixed POV',
  } as Record<string, string>)[pov] || pov
}

function formatErr(e: any): string {
  return e?.data?.detail || e?.message || String(e)
}
</script>

<style scoped>
.pattern-picker {
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

.optional-tag {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  margin-left: 6px;
}

.picker-label .hint {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: normal;
  line-height: 1.4;
}

.picker-row {
  display: flex;
  gap: 8px;
}

.subject-input {
  flex: 1;
}

.picker-filter {
  display: flex; align-items: center; gap: 12px;
  margin-top: 6px; padding: 0 2px;
  font-size: 11px; color: var(--text-muted);
  flex-wrap: wrap;
}
.filter-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  cursor: pointer;
}
.filter-toggle code {
  background: var(--bg-tertiary);
  padding: 1px 5px; border-radius: 3px;
}
.filter-meta { font-style: italic; }

.pattern-card {
  margin-top: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 10px;
  font-size: 11px;
  line-height: 1.5;
}

.card-key {
  color: var(--text-muted);
  font-weight: 500;
}

.card-val {
  color: var(--text-primary);
  word-break: break-word;
}

.pattern-body summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--accent, #6c8fff);
  user-select: none;
}

.beats {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.beats li { margin-bottom: 4px; }

.pairs-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
}

.pairs-badge.ok {
  background: rgba(75, 200, 100, 0.12);
  color: #5fc070;
}

.pairs-badge.warn {
  background: rgba(255, 180, 0, 0.12);
  color: #d4a017;
}

.pattern-error {
  margin-top: 4px;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--error, #e25c5c);
  background: rgba(226, 92, 92, 0.08);
  border-radius: 4px;
}
</style>
