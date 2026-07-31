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
    <!-- An enforced limit has to be visible at the point of choosing. Shown
         only in reference mode, only when the selected model publishes a
         ceiling, and re-derived live whenever the selection changes. -->
    <p v-if="referenceDimensionNotice" class="notice notice-limit">{{ referenceDimensionNotice }}</p>
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
  const visibleModels = props.imageMode === 'img2img'
    ? models.value.filter(model => model.available && model.supports_reference_images && model.max_reference_images >= 1 && model.chargeable)
    : models.value
  const rows = visibleModels.map((model) => {
    const unlimited = badgeFor(model.unlimited_relaxed === true)
    return {
      id: model.id,
      label: model.display_name,
      group: 'GenStudio KH',
      provider: 'GenStudio KH',
      description: 'Image generation through GenStudio KH.',
      disabled: !model.available,
      disabledReason: !model.available
        ? 'This model is currently unavailable in GenStudio.'
        : '',
      badges: [
        { label: 'GenStudio KH', tone: 'info' as const },
        ...(unlimited ? [unlimited] : []),
      ],
    }
  })
  return rows
})

/**
 * The reference-image pixel ceiling the backend will enforce for the CURRENT
 * selection, as a sentence.
 *
 * Empty when the picker is not in reference mode, when no model is selected,
 * or when GenStudio publishes no `reference_image_max_dimension` for it —
 * an unpublished limit is shown as nothing, never as an invented number.
 * A computed, so switching model re-derives it immediately.
 */
const referenceDimensionNotice = computed(() => {
  if (props.imageMode !== 'img2img') return ''
  const selected = models.value.find(model => model.id === props.modelValue)
  const limit = selected?.reference_image_max_dimension
  if (!selected || typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return ''
  return `${selected.display_name} accepts reference images up to ${limit.toLocaleString()}px on the longest side. `
    + 'Larger references are refused before upload, so resize them first.'
})

function select(modelId: string): void {
  const selected = models.value.find(model => model.id === modelId)
  if (!selected?.available || (props.imageMode === 'img2img' && (!selected.supports_reference_images || selected.max_reference_images < 1 || !selected.chargeable))) return
  emit('update:modelValue', modelId)
}

function syncLiveSelection(): void {
  if (!models.value.length) return
  const candidates = props.imageMode === 'img2img'
    ? models.value.filter(model => model.available && model.supports_reference_images && model.max_reference_images >= 1 && model.chargeable)
    : models.value
  const selected = selectLiveGenStudioModel(props.modelValue, candidates)
  if (selected && selected.id !== props.modelValue) emit('update:modelValue', selected.id)
}

watch([models, () => props.modelValue, () => props.imageMode], syncLiveSelection, { deep: true, immediate: true })

onMounted(() => {
  void Promise.all([refresh(), refreshAccess()])
})
</script>

<style scoped>
.notice { margin: 6px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }
.notice-limit { color: var(--text-muted); }
.notice-error { color: var(--danger, #dc2626); }
</style>
