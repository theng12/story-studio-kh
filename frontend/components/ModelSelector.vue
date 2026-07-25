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

interface LlmModelRow {
  id: string
  label: string
  provider: 'genstudio'
  available: boolean
  disabled_reason?: string | null
  hint?: string | null
  supports_vision?: boolean
  unlimited_relaxed?: boolean
  context_limit_tokens?: number
  max_output_tokens?: number
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
  const rows = eligibleModels.map((model) => {
    const unlimited = badgeFor(model.unlimited_relaxed === true)
    return {
      id: model.id,
      label: model.label,
      group: 'GenStudio KH',
      provider: 'GenStudio KH',
      description: model.disabled_reason || model.hint || '',
      disabled: isDisabled(model),
      disabledReason: model.disabled_reason || (props.requireVision && !model.supports_vision ? 'This GenStudio model does not publish image-input support.' : ''),
      badges: [
        { label: 'GenStudio KH', tone: 'info' as const },
        ...(unlimited ? [unlimited] : []),
      ],
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
    emit('model-meta', null)
    return
  }
  // Persist the healed value through the owning form. This replaces stale
  // direct-provider defaults (notably GPT-4o) and means they cannot reappear
  // after the next visit.
  if (props.modelValue !== selected.id) emit('update:modelValue', selected.id)
  emit('model-meta', selected)
}

async function loadModels(): Promise<void> {
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

watch(() => props.projectSlug, loadModels, { immediate: true })
watch(() => props.modelValue, syncModelSelection)
watch(() => props.requireVision, syncModelSelection)
</script>

<style scoped>
.loading { margin-left: 8px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 400; }
.catalog-message { margin: 6px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }
</style>
