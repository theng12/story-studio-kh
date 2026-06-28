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
    <!-- v1.0.471 — search/filter box. Native <select> can't filter, so this
         narrows the option list by label / id / provider. Shown once there are
         enough models to be worth searching. The current selection always stays
         in the list so the dropdown never goes blank while filtering. -->
    <input
      v-if="!loading && allModels.length > SEARCH_THRESHOLD"
      v-model="query"
      type="search"
      class="input ms-search"
      placeholder="Search models (name / provider)…"
      aria-label="Search AI models"
    />
    <select :value="modelValue" :disabled="loading && allModels.length === 0" @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)" class="select">
      <option v-if="loading && allModels.length === 0" value="" disabled>Loading AI models… please wait</option>
      <optgroup v-for="g in filteredGroups" :key="g.provider" :label="g.label">
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
    <p v-if="query.trim() && filteredGroups.length === 0" class="ms-no-match">No models match “{{ query.trim() }}”.</p>
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
  // Curated per-model hint, surfaced in the dropdown tooltip when the model
  // is available. Other tooltip states (disabled reason, no key) take
  // precedence — those are gating; the hint is optional context.
  hint?: string | null
  // v1.0.283 — true when the model accepts image input. Used by callers
  // that pass `require-vision` to grey out text-only models (e.g. Co-writer
  // when the user has attached an image). Local LM Studio models claim true
  // unconditionally — see the comment in routes/health.ts.
  supports_vision?: boolean
}

const props = defineProps<{
  modelValue: string
  projectSlug: string
  /**
   * v1.0.283 — when true, models that don't `supports_vision` are shown but
   * disabled with a "Text-only model" tooltip. Used by Co-writer when the
   * user has attached an image to the chat. Default false preserves the
   * existing behaviour for every other ModelSelector caller.
   */
  requireVision?: boolean
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
  if (!m.available || !!m.disabled_reason) return true
  if (props.requireVision && m.supports_vision === false) return true
  return false
}
function suffixFor(m: LlmModelRow) {
  if (m.disabled_reason) return ' (unavailable)'
  if (!m.available) return ' (no key)'
  if (props.requireVision && m.supports_vision === false) return ' (text-only)'
  return ''
}
function tooltipFor(m: LlmModelRow) {
  if (m.disabled_reason) return m.disabled_reason
  if (!m.available) return 'No API key configured for this provider'
  if (props.requireVision && m.supports_vision === false) {
    return 'This model is text-only. Detach the image or pick a vision-capable model.'
  }
  if (m.hint) return m.hint
  return ''
}

// Provider-grouped view for the <optgroup> rendering.
const groups = computed(() => {
  const record: Record<string, LlmModelRow> = {}
  for (const m of allModels.value) record[m.id] = m
  return groupModels<LlmModelRow>(record, (_id, m) => m.provider || 'other')
})

// v1.0.471 — only surface the search box once the list is long enough to need it.
const SEARCH_THRESHOLD = 8
const query = ref('')

// Filtered groups for rendering. Matches the typed query against the model's
// label, id, and provider (case-insensitive, all whitespace-separated terms must
// match somewhere). The currently-selected model is always kept so the native
// <select> never shows a blank value mid-filter. Empty query → all groups.
const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return groups.value
  const terms = q.split(/\s+/)
  const matches = (m: { id: string; data: LlmModelRow }): boolean => {
    if (m.id === props.modelValue) return true
    const hay = `${m.data.label} ${m.id} ${m.data.provider || ''}`.toLowerCase()
    return terms.every(t => hay.includes(t))
  }
  return groups.value
    .map(g => ({ ...g, items: g.items.filter(matches) }))
    .filter(g => g.items.length > 0)
})

// Reset the filter when the project (and thus the model list) changes.
watch(() => props.projectSlug, () => { query.value = '' })

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

/* v1.0.471 — model search box sits just above the select. */
.ms-search {
  width: 100%;
  margin-bottom: 6px;
}
.ms-no-match {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

/* v1.0.48 — loading-state hint next to the label. Same spinner pattern
   as EpisodeSelector so the two dropdowns feel consistent during a
   slow first-fetch (large iCloud-synced project storage). */
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
