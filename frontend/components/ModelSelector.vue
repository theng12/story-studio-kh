<template>
  <div class="form-group">
    <label>
      {{ label || 'GenStudio model' }}
      <span v-if="loading" class="loading">Loading GenStudio catalog…</span>
    </label>
    <ModelMenu
      :model-value="modelValue"
      :options="menuOptions"
      :loading="loading"
      media-type="llm"
      title="Choose a GenStudio model"
      placeholder="Pick a GenStudio model…"
      search-placeholder="Search GenStudio models…"
      aria-label="GenStudio model options"
      :catalog-notice="planNotice"
      catalog-notice-href="/usage"
      @update:model-value="selectModel"
    />
    <p v-if="loadError" class="catalog-message">{{ loadError }}</p>
  </div>
</template>

<script setup lang="ts">
import {
  isUsableLiveGenStudioModel,
  selectLiveGenStudioModel,
} from '../utils/live-genstudio-model-selection.js'
import { invalidateModelCatalogCache } from '../composables/useApi.js'

interface LlmModelRow {
  id: string
  label: string
  provider: 'genstudio'
  available: boolean
  disabled_reason?: string | null
  hint?: string | null
  supports_vision?: boolean
  unlimited_relaxed?: boolean
  /** Total prompt-plus-output budget, published live by GenStudio. */
  context_window_tokens?: number
  /** @deprecated Backwards-compatibility alias for older GenStudio releases.
   *  Read only when `context_window_tokens` is absent. */
  context_limit_tokens?: number
  /** Maximum selectable output allowance, published live by GenStudio. */
  max_output_tokens?: number
  structured_output_mode?: 'json_object' | 'request_json_schema'
  legacy_ids?: string[]
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
const { planNotice, badgeFor, refresh: refreshAccess } = useGenStudioAccess()

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
  // The gateway is named ONCE per dialog, by the group heading. It is not
  // repeated as a per-row badge and no longer appended to the model name:
  // every model in this app comes through GenStudio, so a row that said it
  // three times spent its width on the one fact that never varies.
  //
  // No `provider` is set, because the chat catalogue publishes none.
  // `ChatModelResponse` has no provider/vendor/engine field at all, and
  // AGENTS.md → "Provider Transparency" is explicit that an unpublished
  // provider is unknown, never reconstructed from an id or a name.
  const rows = eligibleModels.map((model) => {
    const unlimited = badgeFor(model.unlimited_relaxed === true)
    return {
      id: model.id,
      label: model.label,
      group: 'GenStudio KH',
      description: model.disabled_reason || model.hint || '',
      disabled: isDisabled(model),
      disabledReason: model.disabled_reason || (props.requireVision && !model.supports_vision ? 'This GenStudio model does not publish image-input support.' : ''),
      badges: unlimited ? [unlimited] : [],
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
    const [models] = await Promise.all([
      get<LlmModelRow[]>(`/models?project=${props.projectSlug}`),
      refreshAccess(),
    ])
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
