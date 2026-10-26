<template>
  <div class="genstudio-image-picker">
    <ModelMenu
      :model-value="modelValue"
      :options="options"
      :loading="loading"
      media-type="image"
      title="Choose an image model"
      :placeholder="defaultLabel"
      search-placeholder="Search image models…"
      aria-label="Image model options"
      :catalogue-error="error"
      @update:model-value="select"
    />
    <!-- Price of the CURRENT selection, in the Gateway's published terms. A
         computed, so switching model re-prices immediately. -->
    <p v-if="selectedModel" class="notice notice-cost" :class="`basis-${unitCost.basis}`" :title="unitCost.title">
      {{ CREDIT_BASIS_LABEL[unitCost.basis] }}: {{ unitCost.text }} <PriceDetails :cost="unitCost" />
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
    <!-- A model the picker replaced on its own is announced, never swapped silently. -->
    <p v-if="switchNotice" class="notice" role="status">{{ switchNotice }}</p>
    <!-- The app-wide default is gone from the catalogue: said plainly, and the field stays empty
         rather than filled with a product the owner did not choose. -->
    <p v-if="appDefaultGone" class="notice notice-limit" role="status">{{ appDefaultGone }}</p>
    <p v-if="catalogStaleNote" class="notice notice-stale" role="status">
      {{ catalogStaleNote }} · display only. Refresh before starting new image work.
      <button type="button" class="btn btn-sm btn-ghost" :disabled="loading" @click="refresh(true)">Retry</button>
    </p>
    <p v-if="error" class="notice notice-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { genStudioModelLockReason, selectLiveGenStudioModel } from '../utils/live-genstudio-model-selection.js'
import { CREDIT_BASIS_LABEL, describeImageModelRate, describeImageUnitCost } from '../utils/genstudio-credit-cost.js'
import { defaultOutputOption } from '../utils/genstudio-output-options.js'
import { genstudioStaleNote } from '../utils/genstudio-freshness.js'
import { emptyDefaultModels, normalizeDefaultModels, resolveEffectiveModel } from '../utils/live-genstudio-model-selection.js'

const props = withDefaults(defineProps<{
  modelValue: string
  projectSlug: string
  imageMode?: 'text2img' | 'img2img'
  /**
   * Scene Review "Reference to Image": references are attached to a model the
   * picker would otherwise treat as text-to-image. Turns ON the published
   * dimension/count notices and the reference-guided rate — and deliberately
   * leaves the `img2img` MODEL FILTER alone, because reference capability is a
   * mode of the same model, not a separate model list.
   */
  referenceActive?: boolean
  defaultLabel?: string
  preserveAutomaticSelection?: boolean
}>(), {
  imageMode: 'text2img',
  referenceActive: false,
  defaultLabel: 'Pick an image model…',
  preserveAutomaticSelection: false,
})

const emit = defineEmits<{
  'update:modelValue': [modelId: string]
  selected: [modelId: string]
}>()
const { models, loading, error, isStale, isUsable, lastFetchedAt, refresh } = useGenStudioImageModels()
const { get } = useApi()
const catalogStaleNote = computed(() => genstudioStaleNote(isStale.value, lastFetchedAt.value))
/** Reference mode without changing which models are offered. */
const referenceMode = computed(() => props.imageMode === 'img2img' || props.referenceActive)

const options = computed(() => {
  const visibleModels = props.imageMode === 'img2img'
    ? models.value.filter(model => model.available && model.supports_reference_images && model.max_reference_images >= 1)
    : models.value
  const rows = visibleModels.map((model) => {
    const rate = describeImageModelRate(model, { referenceGuided: referenceMode.value })
    return {
      id: model.id,
      label: model.display_name,
      group: 'Image models',
      provider: model.provider_name || '',
      price: rate.text,
      priceTitle: rate.title,
      disabled: !isUsable.value || !model.available || model.locked === true,
      disabledReason: !isUsable.value
        ? 'Last-known catalog only. Refresh the Gateway before starting new image work.'
        : genStudioModelLockReason(model) || (!model.available
          ? 'This model is currently unavailable in the Gateway.'
          : ''),
      badges: !isUsable.value ? [{ label: 'last known', tone: 'warning' as const }] : [],
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
  { referenceGuided: referenceMode.value },
))

const referenceDimensionNotice = computed(() => {
  // Deliberately NOT reference-active: that flow (Scene Review) fits oversized
  // portraits itself, so the img2img advice to "resize them first" would be
  // wrong there. The block states the ceiling in its own words instead.
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
  if (!referenceMode.value) return ''
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
    + "That is the model's published capability in the Gateway, not a Story Studio restriction. "
    + 'Choose a reference-capable model to render from references.'
})

/** `supports_seed: false` is published, so the seed control is not offered. */
const seedNotice = computed(() => {
  const selected = selectedModel.value
  if (!selected || selected.supports_seed !== false) return ''
  return `${selected.display_name} publishes no seed support, so the seed control is hidden and no seed is sent. `
    + "That is the model's published capability in the Gateway, not a Story Studio restriction."
})

/** Set when the picker replaced the selection itself; cleared on a manual pick. */
const switchNotice = ref('')

function select(modelId: string): void {
  if (!isUsable.value) return
  switchNotice.value = ''
  const selected = models.value.find(model => model.id === modelId)
  if (!selected?.available || (props.imageMode === 'img2img' && (!selected.supports_reference_images || selected.max_reference_images < 1))) return
  emit('update:modelValue', modelId)
  emit('selected', modelId)
}

function syncLiveSelection(): void {
  if (!isUsable.value || !models.value.length) return
  const candidates = props.imageMode === 'img2img'
    ? models.value.filter(model => model.available && model.supports_reference_images && model.max_reference_images >= 1)
    : models.value
  const selected = selectLiveGenStudioModel(props.modelValue, candidates)
  if (selected && selected.id !== props.modelValue) {
    if (props.modelValue) {
      const previous = models.value.find(model => model.id === props.modelValue)?.display_name || props.modelValue
      if (props.preserveAutomaticSelection) {
        switchNotice.value = `${previous} now maps to ${selected.display_name} in the live catalog. `
          + 'Retry keeps the original model; choose a model to start a different request.'
        return
      }
      switchNotice.value = props.imageMode === 'img2img'
        ? `${previous} can't be used with a reference image right now, so ${selected.display_name} was picked instead.`
        : `${previous} isn't available right now, so ${selected.display_name} was picked instead.`
    }
    emit('update:modelValue', selected.id)
  }
}

watch([models, () => props.modelValue, () => props.imageMode, () => props.preserveAutomaticSelection], syncLiveSelection, { deep: true, immediate: true })

/**
 * Last of all, the app-wide default image model (Settings → Default models).
 *
 * The page's own selection wins; `useRememberedForm` has already restored it before this runs. This
 * is READ only and never written back, so changing the default later reaches every page. Only a
 * usable, live row is filled — a default that has left the catalogue fills nothing and says so.
 */
/** Settings → Default models, read once per mount. See `resolveEffectiveModel` for the decision. */
const appDefaults = ref(emptyDefaultModels())
const resolvedDefault = computed(() => resolveEffectiveModel(
  'image',
  props.modelValue,
  models.value.map(model => model.id),
  appDefaults.value,
))
const appDefaultGone = computed(() => resolvedDefault.value.goneNotice)

function fillAppDefault(): void {
  if (props.modelValue.trim() || !isUsable.value || !models.value.length) return
  const fallback = resolvedDefault.value.model
  if (!fallback) return
  const row = models.value.find(model => model.id === fallback)
  if (!row || !isUsableModelRow(row)) return
  emit('update:modelValue', fallback)
  emit('selected', fallback)
}

function isUsableModelRow(model: { available: boolean; supports_reference_images?: boolean; max_reference_images?: number }): boolean {
  if (!model.available) return false
  return props.imageMode !== 'img2img'
    || (model.supports_reference_images === true && typeof model.max_reference_images === 'number' && model.max_reference_images >= 1)
}

onMounted(async () => {
  await refresh(true)
  try {
    appDefaults.value = normalizeDefaultModels(await get('/app-settings/default-models', { cache: 'no-store' }))
  } catch {
    // An unreadable setting is "no default"; the page asks for a choice as usual.
    appDefaults.value = emptyDefaultModels()
  }
  fillAppDefault()
})
</script>

<style scoped>
.notice { margin: 6px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }
.notice-limit { color: var(--text-muted); }
.notice-cost { color: var(--text); }
.notice-cost.basis-unpublished { color: var(--warning, #d97706); }
.notice-cost.basis-free { color: var(--success, #16a34a); }
.notice-stale { color: var(--warning, #d97706); }
.notice-error { color: var(--danger, #dc2626); }
</style>
