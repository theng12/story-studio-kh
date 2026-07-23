<template>
  <div class="genstudio-image-picker">
    <ModelMenu
      :model-value="modelValue"
      :options="options"
      :loading="loading"
      media-type="image"
      title="Choose a GenStudio image model"
      :placeholder="defaultLabel"
      search-placeholder="Search GenStudio image models…"
      aria-label="GenStudio image model options"
      :catalog-notice="planNotice"
      catalog-notice-href="/usage"
      @update:model-value="select"
    />
    <p v-if="error" class="notice notice-error">{{ error }}</p>
    <p v-if="migrationMessage" class="notice">{{ migrationMessage }}</p>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue: string
  projectSlug: string
  imageModels?: Record<string, unknown>
  imageMode?: 'text2img' | 'img2img'
  defaultLabel?: string
}>(), {
  imageMode: 'text2img',
  imageModels: () => ({}),
  defaultLabel: 'Pick a GenStudio model…',
})

const emit = defineEmits<{ 'update:modelValue': [modelId: string] }>()
const { models, loading, error, refresh } = useGenStudioImageModels()
const { planNotice, badgeFor, refresh: refreshAccess } = useGenStudioAccess()

const currentExists = computed(() => models.value.some(model => model.id === props.modelValue))
const migrationMessage = computed(() => {
  if (!props.modelValue || currentExists.value) return ''
  return `Saved image model “${props.modelValue}” is unavailable in GenStudio. Select a live catalog model; no legacy provider fallback will run.`
})

const options = computed(() => {
  const rows = models.value.map((model) => {
    const unlimited = badgeFor(model.unlimited_relaxed === true)
    return {
      id: model.id,
      label: model.display_name,
      group: 'GenStudio KH',
      provider: model.execution_label || 'GenStudio KH',
      description: model.description || 'Pricing is quoted and settled by GenStudio.',
      disabled: !model.available || props.imageMode === 'img2img',
      disabledReason: !model.available
        ? 'This model is currently unavailable in GenStudio.'
        : props.imageMode === 'img2img'
          ? 'This catalog currently supports prompt-only generation.'
          : '',
      badges: [
        { label: 'GenStudio', tone: 'info' as const },
        ...(unlimited ? [unlimited] : []),
      ],
    }
  })
  if (props.modelValue && !currentExists.value) {
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

function select(modelId: string): void {
  const selected = models.value.find(model => model.id === modelId)
  if (!selected?.available || props.imageMode === 'img2img') return
  emit('update:modelValue', modelId)
}

watch(models, catalog => {
  if (!props.modelValue || catalog.some(model => model.id === props.modelValue)) return
  const mapped = catalog.find(model => model.available && model.legacy_ids?.includes(props.modelValue))
  if (mapped) emit('update:modelValue', mapped.id)
}, { deep: true })

onMounted(() => {
  void Promise.all([refresh(), refreshAccess()])
})
</script>

<style scoped>
.notice { margin: 6px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }
.notice-error { color: var(--danger, #dc2626); }
</style>
