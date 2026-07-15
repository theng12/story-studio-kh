<template>
  <div class="form-group">
    <label>
      {{ label || 'AI Model' }}
      <!-- v1.0.48: visible loading state. Empty &lt;select&gt; during fetch
           used to look identical to a broken/no-models state — same
           class of bug as EpisodeSelector. -->
      <span v-if="loading" class="ms-loading-inline">
        <span class="ms-spinner" aria-hidden="true" />
        Loading models…
      </span>
    </label>
    <!-- v1.0.498 — cost-tier tabs. Filter the dropdown to Local / Cloud-free /
         Cloud-paid so a paid model can't be picked by accident. Only shown when
         the list spans more than one tier (e.g. Chat Studio configured). -->
    <div v-if="!loading && tierTabs.length" class="ms-tier-tabs" role="tablist">
      <button
        v-for="t in tierTabs"
        :key="t.key"
        type="button"
        role="tab"
        :aria-selected="activeTier === t.key"
        :class="['ms-tier-tab', { active: activeTier === t.key, paid: t.key === 'paid' }]"
        :title="t.key === 'paid' ? 'Models that spend paid API credits' : t.key === 'free' ? 'Free cloud APIs (rate-limited)' : t.key === 'local' ? 'Runs on your machine — free' : 'All models'"
        @click="activeTier = t.key"
      >{{ t.label }} <span class="ms-tier-count">{{ t.count }}</span></button>
    </div>
    <ModelMenu
      :model-value="modelValue"
      :options="menuOptions"
      :loading="loading"
      media-type="llm"
      title="Choose an AI model"
      placeholder="Pick an AI model…"
      search-placeholder="Search model, provider, or capability…"
      aria-label="AI model options"
      @update:model-value="selectModel"
    />
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
  // True when the model accepts image input. Image-aware callers can require
  // this capability while keeping one shared model picker.
  supports_vision?: boolean
  // v1.0.498 — cost tier for the picker tabs. 'local' = on-machine (free),
  // 'free' = free cloud API, 'paid' = uses paid credits. Absent → treated as
  // 'paid' (safe default; older backends only served paid cloud models).
  cost_tier?: 'local' | 'free' | 'paid'
  min_unified_memory_gb?: number
  is_reasoning?: boolean
}

const props = defineProps<{
  modelValue: string
  projectSlug: string
  /** Optional task-specific label; defaults to the shared "AI Model" label. */
  label?: string
  /**
   * v1.0.283 — when true, models that don't `supports_vision` are shown but
   * disabled with a "Text-only model" tooltip. Default false preserves the
   * standard text-only picker behavior.
   */
  requireVision?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'model-meta': [value: LlmModelRow | null]
}>()

const { get } = useApi()

const allModels = ref<LlmModelRow[]>([])
// v1.0.48 — visible loading state for the dropdown. Tracks the
// in-flight `loadModels` so the label + select can show "Loading…"
// instead of an empty pulldown that looks indistinguishable from a
// broken-no-models state.
const loading = ref(false)

function emitModelMeta(value: string) {
  emit('model-meta', allModels.value.find(model => model.id === value) || null)
}

function selectModel(value: string) {
  emit('update:modelValue', value)
  emitModelMeta(value)
}

function isDisabled(m: LlmModelRow) {
  if (!m.available || !!m.disabled_reason) return true
  if (props.requireVision && m.supports_vision === false) return true
  return false
}
function tierOf(m: LlmModelRow): 'local' | 'free' | 'paid' {
  return m.cost_tier || 'paid'
}
function suffixFor(m: LlmModelRow) {
  if (m.disabled_reason) return ' (unavailable)'
  if (!m.available) return ' (no key)'
  if (props.requireVision && m.supports_vision === false) return ' (text-only)'
  if (tierOf(m) === 'local') {
    const memory = m.min_unified_memory_gb ? ` · ≥${m.min_unified_memory_gb} GB` : ''
    const reasoning = m.is_reasoning ? ' · reasoning' : ''
    return `${memory}${reasoning}`
  }
  // v1.0.498 — flag paid models in the option text so an accidental pick in the
  // "All" tab is visible even without reading the tooltip. Free/local stay clean.
  if (tierOf(m) === 'paid') return ' · 💲 paid'
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

// v1.0.498 — cost-tier tabs (All / Local / Cloud free / Cloud paid). Lets the
// user hide paid models so they can't be picked by accident (wasting credits).
// The tabs only appear when the model list actually spans more than one tier —
// otherwise they'd be noise (e.g. a fresh install with only paid cloud models).
type Tier = 'all' | 'local' | 'free' | 'paid'
const activeTier = ref<Tier>('all')
const tierCounts = computed(() => {
  const c = { local: 0, free: 0, paid: 0 }
  for (const m of allModels.value) c[tierOf(m)]++
  return c
})
const tierTabs = computed(() => {
  const c = tierCounts.value
  const tabs: Array<{ key: Tier; label: string; count: number }> = [
    { key: 'all', label: 'All', count: allModels.value.length },
  ]
  if (c.local) tabs.push({ key: 'local', label: 'Local', count: c.local })
  if (c.free) tabs.push({ key: 'free', label: 'Cloud · free', count: c.free })
  if (c.paid) tabs.push({ key: 'paid', label: 'Cloud · paid', count: c.paid })
  // Only worth showing when models span >1 tier (2 tabs = All + one tier).
  return tabs.length > 2 ? tabs : []
})

// The shared menu owns searching and full-label display. Tier filtering stays
// here because it is a safety control that prevents accidental paid selection.
const menuOptions = computed(() => {
  const tier = activeTier.value
  const matches = (m: { id: string; data: LlmModelRow }): boolean => {
    if (m.id === props.modelValue) return true   // never hide the active selection
    if (tier !== 'all' && tierOf(m.data) !== tier) return false
    return true
  }
  return groups.value.flatMap(group => group.items.filter(matches).map(({ id, data }) => ({
    id,
    label: data.label || id,
    group: group.label,
    provider: group.label,
    meta: suffixFor(data).replace(/^\s*·\s*/, '').replace(/^\s*\((.*)\)\s*$/, '$1'),
    description: tooltipFor(data),
    disabled: isDisabled(data),
    disabledReason: isDisabled(data) ? tooltipFor(data) : '',
    badges: [
      { label: tierOf(data) === 'local' ? 'local' : tierOf(data) === 'free' ? 'free' : 'paid', tone: tierOf(data) },
      ...(props.requireVision && data.supports_vision ? [{ label: 'vision', tone: 'info' as const }] : []),
    ],
  })))
})

// Reset filters when the project (and thus the model list) changes.
watch(() => props.projectSlug, () => { activeTier.value = 'all' })

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
        emit('model-meta', firstUsable)
      }
    } else {
      emit('model-meta', current)
    }
  } catch {} finally {
    loading.value = false
  }
}

watch(() => props.projectSlug, loadModels, { immediate: true })
watch(() => props.modelValue, emitModelMeta)
</script>

<style scoped>
/* v1.0.498 — cost-tier tabs above the search box. */
.ms-tier-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.ms-tier-tab {
  padding: 3px 10px;
  font-size: 11.5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.ms-tier-tab:hover { color: var(--text-primary); }
.ms-tier-tab.active { background: var(--accent, #6c8fff); color: #fff; border-color: var(--accent, #6c8fff); }
.ms-tier-tab.paid.active { background: #b4530a; border-color: #b4530a; }
.ms-tier-count { opacity: 0.7; font-size: 10px; }

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
