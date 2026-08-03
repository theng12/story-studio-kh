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
    <!-- Price of the CURRENT selection, in GenStudio's published terms. A
         computed, so switching model re-prices immediately. -->
    <p v-if="selectedModel" class="notice notice-cost" :class="`basis-${unitCost.basis}`" :title="unitCost.title">
      {{ CREDIT_BASIS_LABEL[unitCost.basis] }}: {{ unitCost.text }}
    </p>
    <!-- An enforced limit has to be visible at the point of choosing. Shown
         only in reference mode, only when the selected model publishes a
         ceiling, and re-derived live whenever the selection changes. -->
    <p v-if="referenceDimensionNotice" class="notice notice-limit">{{ referenceDimensionNotice }}</p>
    <!-- The reference-count floor/ceiling the backend already enforces. -->
    <p v-if="referenceCountNotice" class="notice notice-limit">{{ referenceCountNotice }}</p>
    <!-- A published capability, stated as the model's, not Story Studio's. -->
    <p v-if="referenceUnsupportedNotice" class="notice notice-limit">{{ referenceUnsupportedNotice }}</p>
    <p v-if="seedNotice" class="notice notice-limit">{{ seedNotice }}</p>
    <p v-if="error" class="notice notice-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { selectLiveGenStudioModel } from '../utils/live-genstudio-model-selection.js'
import { CREDIT_BASIS_LABEL, describeImageUnitCost } from '../utils/genstudio-credit-cost.js'
import { defaultOutputOption } from '../utils/genstudio-output-options.js'

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
      // Named once, by the group heading. `ImageModelResponse` publishes no
      // provider field, so no `provider` is set and none is invented.
      group: 'GenStudio KH',
      disabled: !model.available,
      disabledReason: !model.available
        ? 'This model is currently unavailable in GenStudio.'
        : '',
      badges: unlimited ? [unlimited] : [],
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
const selectedModel = computed(() => models.value.find(model => model.id === props.modelValue) || null)

/**
 * Price of the current selection, for the model's DEFAULT published output
 * option when it publishes options at all. The per-row prices live in
 * `ImageOutputOptionPicker`; this is the headline figure at the moment of
 * choosing a model. Recomputed on every selection change.
 */
const unitCost = computed(() => describeImageUnitCost(
  selectedModel.value,
  defaultOutputOption(selectedModel.value),
  { referenceGuided: props.imageMode === 'img2img' },
))

const referenceDimensionNotice = computed(() => {
  if (props.imageMode !== 'img2img') return ''
  const selected = selectedModel.value
  const limit = selected?.reference_image_max_dimension
  if (!selected || typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return ''
  return `${selected.display_name} accepts reference images up to ${limit.toLocaleString()}px on the longest side. `
    + 'Larger references are refused before upload, so resize them first.'
})

/**
 * The reference COUNT window the backend already enforces before every charged
 * submit. It was invisible until now, which turned a clear published limit
 * into a mystery error. Only figures GenStudio published are stated.
 */
const referenceCountNotice = computed(() => {
  if (props.imageMode !== 'img2img') return ''
  const selected = selectedModel.value
  if (!selected?.supports_reference_images) return ''
  const max = typeof selected.max_reference_images === 'number' && selected.max_reference_images > 0
    ? selected.max_reference_images
    : null
  const min = typeof selected.min_reference_images === 'number' && selected.min_reference_images > 0
    ? selected.min_reference_images
    : null
  if (max === null && min === null) return ''
  const clauses: string[] = []
  if (max !== null) clauses.push(`accepts up to ${max} reference image${max === 1 ? '' : 's'}`)
  if (min !== null) clauses.push(`needs at least ${min}`)
  return `${selected.display_name} ${clauses.join(' and ')}. Extra references beyond the ceiling are not submitted.`
})

/** A published "no" is stated as the MODEL's, so it is not mistaken for a Story Studio restriction. */
const referenceUnsupportedNotice = computed(() => {
  const selected = selectedModel.value
  if (!selected || selected.supports_reference_images !== false) return ''
  return `${selected.display_name} publishes no support for reference images, so attaching one would be ignored. `
    + "That is the model's published capability in GenStudio, not a Story Studio restriction. "
    + 'Choose a reference-capable model to render from references.'
})

/** `supports_seed: false` is published, so the seed control is not offered. */
const seedNotice = computed(() => {
  const selected = selectedModel.value
  if (!selected || selected.supports_seed !== false) return ''
  return `${selected.display_name} publishes no seed support, so the seed control is hidden and no seed is sent. `
    + "That is the model's published capability in GenStudio, not a Story Studio restriction."
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
.notice-cost { color: var(--text); }
.notice-cost.basis-unpublished { color: var(--warning, #d97706); }
.notice-cost.basis-free { color: var(--success, #16a34a); }
.notice-error { color: var(--danger, #dc2626); }
</style>
