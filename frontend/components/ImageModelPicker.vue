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
  </div>
</template>

<script setup lang="ts">
import { selectLiveGenStudioModel } from '../utils/live-genstudio-model-selection.js'

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

const options = computed(() => {
  const rows = models.value.map((model) => {
    const unlimited = badgeFor(model.unlimited_relaxed === true)
    return {
      id: model.id,
      label: model.display_name,
      group: 'GenStudio KH',
      provider: 'GenStudio KH',
      description: 'Image generation through GenStudio KH.',
      disabled: !model.available || props.imageMode === 'img2img',
      disabledReason: !model.available
        ? 'This model is currently unavailable in GenStudio.'
        : props.imageMode === 'img2img'
          ? 'This catalog currently supports prompt-only generation.'
          : '',
      badges: [
        { label: 'GenStudio KH', tone: 'info' as const },
        ...(unlimited ? [unlimited] : []),
      ],
    }
  })
  return rows
})

function select(modelId: string): void {
  const selected = models.value.find(model => model.id === modelId)
  if (!selected?.available || props.imageMode === 'img2img') return
  emit('update:modelValue', modelId)
}

function syncLiveSelection(): void {
  if (!models.value.length || props.imageMode === 'img2img') return
  const selected = selectLiveGenStudioModel(props.modelValue, models.value)
  if (selected && selected.id !== props.modelValue) emit('update:modelValue', selected.id)
}

watch([models, () => props.modelValue, () => props.imageMode], syncLiveSelection, { deep: true, immediate: true })

onMounted(() => {
  void Promise.all([refresh(), refreshAccess()])
})
</script>

<style scoped>
.notice { margin: 6px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }
.notice-error { color: var(--danger, #dc2626); }
</style>
