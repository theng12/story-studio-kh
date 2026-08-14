<template>
  <div class="form-group">
    <label>
      {{ label || 'LLM model' }}
      <span v-if="loading" class="loading">Loading GenStudio catalog…</span>
    </label>
    <ModelMenu
      :model-value="modelValue"
      :options="menuOptions"
      :loading="loading"
      media-type="llm"
      title="Choose LLM model"
      placeholder="Pick an LLM model…"
      search-placeholder="Search LLM models…"
      aria-label="LLM model options"
      @update:model-value="selectModel"
    />
    <p v-if="loadError" class="catalog-message">{{ loadError }}</p>
  </div>
</template>

<script setup lang="ts">
import {
  isUsableLiveGenStudioModel,
  selectLiveGenStudioModel,
  genStudioModelLockReason,
} from '../utils/live-genstudio-model-selection.js'
import { invalidateModelCatalogCache } from '../composables/useApi.js'
import type { GenStudioCostTier } from '../utils/genstudio-cost-tier.js'
import { describeChatRate } from '../utils/genstudio-credit-cost.js'

interface LlmModelRow {
  id: string
  label: string
  provider: 'genstudio'
  provider_name?: string | null
  available: boolean
  disabled_reason?: string | null
  hint?: string | null
  supports_vision?: boolean
  /** Total prompt-plus-output budget, published live by GenStudio. */
  context_window_tokens?: number
  /** @deprecated Backwards-compatibility alias for older GenStudio releases.
   *  Read only when `context_window_tokens` is absent. */
  context_limit_tokens?: number
  /** Maximum selectable output allowance, published live by GenStudio. */
  max_output_tokens?: number
  structured_output_mode?: 'json_object' | 'request_json_schema'
  legacy_ids?: string[]
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string | null
  input_credits_per_million_tokens?: number | null
  output_credits_per_million_tokens?: number | null
  minimum_credits?: number | null
  price_version?: string | null
}

const props = defineProps<{
  modelValue: string
  projectSlug: string
  label?: string
  requireVision?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'model-meta': [value: LlmModelRow | null]
}>()

const { get } = useApi()
const allModels = ref<LlmModelRow[]>([])
const loading = ref(false)
const loadError = ref('')

function isDisabled(model: LlmModelRow): boolean {
  return !isUsableLiveGenStudioModel(model, props.requireVision === true)
}

const menuOptions = computed(() => {
  // A reference-guided request has an image input. Do not leave text-only
  // models in the menu as disabled dead ends: they cannot run this request at
  // all, and showing them invites a confusing failure after the user uploads
  // a reference. The server remains authoritative at execution time.
  const eligibleModels = props.requireVision
    ? allModels.value.filter(model => isUsableLiveGenStudioModel(model, true))
    : allModels.value
  // The gateway is named once by the group heading. A creator/provider is a
  // separate published fact and appears on the row only when GenStudio sends
  // `provider_name`; it is never reconstructed from an id or display name.
  const rows = eligibleModels.map((model) => {
    const rate = describeChatRate({ ...model, display_name: model.label })
    return {
      id: model.id,
      label: model.label,
      group: 'Language models',
      provider: model.provider_name || '',
      price: rate.text,
      priceTitle: rate.title,
      description: model.disabled_reason || model.hint || '',
      disabled: isDisabled(model),
      disabledReason: genStudioModelLockReason(model) || model.disabled_reason || (props.requireVision && !model.supports_vision ? 'This GenStudio model does not publish image-input support.' : ''),
      badges: [],
      costTier: model.cost_tier,
    }
  })
  return rows
})

function selectModel(value: string): void {
  const model = allModels.value.find(entry => entry.id === value)
  if (!model || isDisabled(model)) return
  emit('update:modelValue', value)
  emit('model-meta', model)
}

function syncModelSelection(): void {
  const selected = selectLiveGenStudioModel(
    props.modelValue,
    allModels.value,
    props.requireVision === true,
  )
  if (!selected) {
    const saved = props.modelValue.trim()
    const unavailable = allModels.value.find(model => model.id === saved)
    if (saved && unavailable) {
      loadError.value = unavailable.disabled_reason
        || `${unavailable.label} is retired or unavailable. Choose a replacement; Story Studio will not switch products automatically.`
    }
    emit('model-meta', null)
    return
  }
  loadError.value = ''
  // Persist the healed value through the owning form. This replaces stale
  // direct-provider defaults (notably GPT-4o) and means they cannot reappear
  // after the next visit.
  if (props.modelValue !== selected.id) emit('update:modelValue', selected.id)
  emit('model-meta', selected)
}

/**
 * Load the catalogue through the shared `/models?` read cache.
 *
 * `force` drops that shared entry first, so the next read goes to the network.
 * It is used when GenStudio itself has told us our view of the published limits
 * is wrong — see `reloadCatalog` below.
 */
async function loadModels(force = false): Promise<void> {
  if (force) invalidateModelCatalogCache()
  loading.value = true
  loadError.value = ''
  try {
    const models = await get<LlmModelRow[]>(`/models?project=${props.projectSlug}`)
    allModels.value = models
    syncModelSelection()
  } catch (error: any) {
    allModels.value = []
    loadError.value = error?.data?.detail || error?.message || 'GenStudio catalog unavailable.'
  } finally {
    loading.value = false
  }
}

watch(() => props.projectSlug, () => { void loadModels() }, { immediate: true })
watch(() => props.modelValue, syncModelSelection)
watch(() => props.requireVision, syncModelSelection)

/**
 * Re-read the published catalogue from the network and re-emit the selected
 * model's live limits. Owning pages call this after GenStudio — the final
 * validator — rejects a request for exceeding a context or output limit, so the
 * UI clamps to what the model publishes NOW instead of to a stale snapshot.
 */
async function reloadCatalog(): Promise<void> {
  await loadModels(true)
}

defineExpose({ reloadCatalog })
</script>

<style scoped>
.loading { margin-left: 8px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 400; }
.catalog-message { margin: 6px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }
</style>
