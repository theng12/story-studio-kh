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
      @update:model-value="selectModel"
    />
    <p v-if="migrationMessage" class="migration-message">{{ migrationMessage }}</p>
    <p v-else-if="loadError" class="migration-message">{{ loadError }}</p>
  </div>
</template>

<script setup lang="ts">
interface LlmModelRow {
  id: string
  label: string
  provider: 'genstudio'
  available: boolean
  disabled_reason?: string | null
  hint?: string | null
  supports_vision?: boolean
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

const current = computed(() => allModels.value.find(model => model.id === props.modelValue))
const migrationMessage = computed(() => {
  if (!props.modelValue || current.value) return ''
  return `Saved model “${props.modelValue}” is unavailable in the live GenStudio catalog. Choose a GenStudio model; no legacy fallback will run.`
})

function isDisabled(model: LlmModelRow): boolean {
  return !model.available || !!model.disabled_reason || (props.requireVision === true && model.supports_vision !== true)
}

const menuOptions = computed(() => {
  const rows = allModels.value.map(model => ({
    id: model.id,
    label: model.label,
    group: 'GenStudio KH',
    provider: 'GenStudio KH',
    description: model.disabled_reason || model.hint || '',
    disabled: isDisabled(model),
    disabledReason: model.disabled_reason || (props.requireVision && !model.supports_vision ? 'This GenStudio model does not publish image-input support.' : ''),
    badges: [{ label: 'GenStudio', tone: 'info' as const }],
  }))
  if (props.modelValue && !allModels.value.some(model => model.id === props.modelValue)) {
    rows.unshift({
      id: props.modelValue,
      label: `${props.modelValue} (migration required)`,
      group: 'Unavailable saved selection',
      provider: 'Historical',
      description: migrationMessage.value,
      disabled: true,
      disabledReason: migrationMessage.value,
      badges: [{ label: 'unavailable', tone: 'info' as const }],
    })
  }
  return rows
})

function selectModel(value: string): void {
  const model = allModels.value.find(entry => entry.id === value)
  if (!model || isDisabled(model)) return
  emit('update:modelValue', value)
  emit('model-meta', model)
}

async function loadModels(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    allModels.value = await get<LlmModelRow[]>(`/models?project=${props.projectSlug}`)
    const exact = allModels.value.find(model => model.id === props.modelValue)
    if (exact) {
      emit('model-meta', exact)
      return
    }
    const mapped = allModels.value.find(model => model.available && model.legacy_ids?.includes(props.modelValue))
    if (mapped) {
      emit('update:modelValue', mapped.id)
      emit('model-meta', mapped)
      return
    }
    emit('model-meta', null)
  } catch (error: any) {
    allModels.value = []
    loadError.value = error?.data?.detail || error?.message || 'GenStudio catalog unavailable.'
  } finally {
    loading.value = false
  }
}

watch(() => props.projectSlug, loadModels, { immediate: true })
watch(() => props.modelValue, value => emit('model-meta', allModels.value.find(model => model.id === value) || null))
</script>

<style scoped>
.loading { margin-left: 8px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 400; }
.migration-message { margin: 6px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }
</style>
