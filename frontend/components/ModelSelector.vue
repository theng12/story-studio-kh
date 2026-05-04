<template>
  <div class="form-group">
    <label>
      AI Model
      <!-- v1.0.48: visible loading state. Empty &lt;select&gt; during fetch
           used to look identical to a broken/no-models state — same
           class of bug as EpisodeSelector. -->
      <span v-if="loading" class="ms-loading-inline">
        <span class="ms-spinner" aria-hidden="true" />
        Loading models…
      </span>
    </label>
    <select :value="modelValue" :disabled="loading && allModels.length === 0" @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)" class="select">
      <option v-if="loading && allModels.length === 0" value="" disabled>Loading AI models… please wait</option>
      <optgroup v-for="g in groups" :key="g.provider" :label="g.label">
        <option
          v-for="m in g.items"
          :key="m.id"
          :value="m.id"
          :disabled="isDisabled(m.data)"
          :title="tooltipFor(m.data)"
        >
          {{ m.data.label }}{{ suffixFor(m.data) }}
        </option>
      </optgroup>
    </select>
  </div>
</template>

<script setup lang="ts">
interface LlmModelRow {
  id: string
  label: string
  provider: string
  available: boolean
  // Backend-supplied reason explaining why a model that *has* a key still
  // can't be used (e.g. account tier doesn't include GPT-5). null/undefined
  // means no extra restriction beyond the api-key check.
  disabled_reason?: string | null
}

const props = defineProps<{
  modelValue: string
  projectSlug: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { get } = useApi()

const allModels = ref<LlmModelRow[]>([])
// v1.0.48 — visible loading state for the dropdown. Tracks the
// in-flight `loadModels` so the label + select can show "Loading…"
// instead of an empty pulldown that looks indistinguishable from a
// broken-no-models state.
const loading = ref(false)

function isDisabled(m: LlmModelRow) {
  return !m.available || !!m.disabled_reason
}
function suffixFor(m: LlmModelRow) {
  if (m.disabled_reason) return ' (unavailable)'
  if (!m.available) return ' (no key)'
  return ''
}
function tooltipFor(m: LlmModelRow) {
  if (m.disabled_reason) return m.disabled_reason
  if (!m.available) return 'No API key configured for this provider'
  return ''
}

// Provider-grouped view for the <optgroup> rendering.
const groups = computed(() => {
  const record: Record<string, LlmModelRow> = {}
  for (const m of allModels.value) record[m.id] = m
  return groupModels<LlmModelRow>(record, (_id, m) => m.provider || 'other')
})

async function loadModels() {
  loading.value = true
  try {
    allModels.value = await get(`/models?project=${props.projectSlug}`)

    // Auto-fallback: if the current selection isn't usable (no key OR
    // flagged unavailable), switch to the first model that *is* usable.
    // Excluding disabled_reason here prevents accidentally landing on
    // gpt-5 just because alphabetically/declaration-order it comes first.
    const current = allModels.value.find(m => m.id === props.modelValue)
    if (!current || isDisabled(current)) {
      const firstUsable = allModels.value.find(m => !isDisabled(m))
      if (firstUsable) {
        emit('update:modelValue', firstUsable.id)
      }
    }
  } catch {} finally {
    loading.value = false
  }
}

watch(() => props.projectSlug, loadModels, { immediate: true })
</script>

<style scoped>
option:disabled {
  color: var(--text-muted);
  font-style: italic;
}

/* v1.0.48 — loading-state hint next to the label. Same spinner pattern
   as EpisodeSelector so the two dropdowns feel consistent during a
   slow first-fetch (TerraNash + iCloud-synced storage). */
.ms-loading-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: normal;
  color: var(--text-muted);
  margin-left: 6px;
}
.ms-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--text-muted);
  border-top-color: transparent;
  border-radius: 50%;
  animation: ms-spin 0.7s linear infinite;
}
@keyframes ms-spin {
  to { transform: rotate(360deg); }
}
</style>
