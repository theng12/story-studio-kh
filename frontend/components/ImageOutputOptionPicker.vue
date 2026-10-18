<template>
  <div v-if="options.length" class="output-options">
    <div class="output-head">
      <span class="output-label">Output size</span>
      <span class="output-sub">Published by {{ modelName }} — each row is one size Gateway renders, at its own price.</span>
    </div>
    <!-- Only when the Story default cannot be honoured: name the published
         fallback honestly instead of pretending 16:9 exists. -->
    <p v-if="preferredConstraint" class="output-constraint">{{ preferredConstraint }}</p>
    <div class="output-grid" role="radiogroup" aria-label="Published output size">
      <button
        v-for="option in options"
        :key="`${option.resolution}|${option.aspect_ratio}`"
        type="button"
        role="radio"
        class="output-row"
        :class="{ active: isActive(option) }"
        :aria-checked="isActive(option)"
        @click="choose(option)"
      >
        <span class="output-main">
          <span class="output-res">{{ option.resolution }}</span>
          <span class="output-ratio">{{ option.aspect_ratio }}</span>
          <span v-if="defaultLabel(option)" class="output-default" :title="defaultTitle(option)">{{ defaultLabel(option) }}</span>
        </span>
        <span class="output-dims">{{ option.width.toLocaleString() }}×{{ option.height.toLocaleString() }} px</span>
        <span class="output-cost" :class="`basis-${costFor(option).basis}`" :title="costFor(option).title">
          {{ CREDIT_BASIS_LABEL[costFor(option).basis] }}: {{ costFor(option).text }} <PriceDetails :cost="costFor(option)" />
        </span>
      </button>
    </div>
    <!-- A model switch that changed the customer's pick has to SAY so; never
         submit a combination other than the one on screen. -->
    <p v-if="notice" class="output-notice">{{ notice }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * The published `(resolution, aspect_ratio)` rows for the selected model.
 *
 * Rows come from the live catalogue verbatim: resolution label, ratio, the
 * real `width`×`height`, and that row's own price. A model publishing none
 * renders nothing at all, so the flow falls back to aspect ratio alone and
 * GenStudio applies its own default resolution — no invented ladder.
 */
import {
  PREFERRED_IMAGE_ASPECT_RATIO,
  findOutputOption,
  isPublishedAspectRatio,
  outputOptionDefaultRole,
  publishedOutputOptions,
  reconcileOutputOption,
  storyDefaultAspectRatio,
  type OutputOptionChoice,
  type PublishedOutputOption,
} from '../utils/genstudio-output-options.js'
import {
  CREDIT_BASIS_LABEL,
  describeImageUnitCost,
  type CreditDisplay,
} from '../utils/genstudio-credit-cost.js'
import type { GenStudioImageModelInfo } from '../composables/useGenStudioImageModels.js'

const props = withDefaults(defineProps<{
  model: GenStudioImageModelInfo | null | undefined
  /** The customer's current pick. Preserved across a model switch when published. */
  modelValue: OutputOptionChoice | null
  /** True when references are attached, so the published effective rate is shown. */
  referenceGuided?: boolean
  /** Keep an attempted request's raw row while the live catalog keeps changing. */
  preserveAutomaticSelection?: boolean
  /**
   * The ratio currently on screen — remembered, preset, or project format.
   * Passed to the first reconcile so the Story default cannot overwrite an
   * explicit choice before the customer sees it.
   */
  preferredAspectRatio?: string
}>(), { referenceGuided: false, preserveAutomaticSelection: false, preferredAspectRatio: '' })

const emit = defineEmits<{
  'update:modelValue': [choice: OutputOptionChoice | null]
  /** Fired with a sentence whenever a model switch moved the customer's pick. */
  'switched': [notice: string]
  selected: [choice: OutputOptionChoice]
}>()

const notice = ref('')

const options = computed<PublishedOutputOption[]>(() => publishedOutputOptions(props.model))
const modelName = computed(() => props.model?.display_name || 'this model')

function optionRole(option: PublishedOutputOption) {
  return outputOptionDefaultRole(option, props.model)
}

/** `Default` is Story Studio's choice; `Gateway default` is the provider's. */
function defaultLabel(option: PublishedOutputOption): string {
  const role = optionRole(option)
  if (role === 'story-default') return 'Default'
  if (role === 'gateway-default') return 'Gateway default'
  return ''
}

function defaultTitle(option: PublishedOutputOption): string {
  const role = optionRole(option)
  if (role === 'story-default') return 'Story Studio uses this when no size is chosen.'
  if (role === 'gateway-default') return "The Gateway's own default; used only when Story Studio cannot prefer 16:9."
  return ''
}

/** A truthful constraint line, shown only when the Story default is unavailable. */
const preferredConstraint = computed(() => {
  if (!options.value.length) return ''
  if (isPublishedAspectRatio(props.model, PREFERRED_IMAGE_ASPECT_RATIO)) return ''
  const fallback = storyDefaultAspectRatio(props.model)
  return fallback
    ? `This model does not publish ${PREFERRED_IMAGE_ASPECT_RATIO}; Story Studio uses ${fallback} instead.`
    : `This model does not publish ${PREFERRED_IMAGE_ASPECT_RATIO}.`
})

function isActive(option: PublishedOutputOption): boolean {
  return props.modelValue?.resolution === option.resolution
    && props.modelValue?.aspect_ratio === option.aspect_ratio
}

/** Recomputed per row, so switching model re-prices every row immediately. */
function costFor(option: PublishedOutputOption): CreditDisplay {
  return describeImageUnitCost(props.model, option, { referenceGuided: props.referenceGuided })
}

function choose(option: PublishedOutputOption): void {
  notice.value = ''
  const choice = { resolution: option.resolution, aspect_ratio: option.aspect_ratio }
  emit('update:modelValue', choice)
  emit('selected', choice)
}

/**
 * Re-resolve the pick against whatever model is now selected.
 *
 * The pair survives when the new model publishes that exact combination.
 * Otherwise it moves to the row at the page's current ratio, or the new
 * model's Story default, and the change is stated out loud rather than
 * applied behind the customer's back.
 */
function reconcile(): void {
  const result = reconcileOutputOption(props.modelValue, props.model, {
    preferredAspectRatio: props.preferredAspectRatio,
  })
  const next = result.option
    ? { resolution: result.option.resolution, aspect_ratio: result.option.aspect_ratio }
    : null
  const current = props.modelValue
  const same = (!next && !current)
    || (!!next && !!current && next.resolution === current.resolution && next.aspect_ratio === current.aspect_ratio)
  if (!same && props.preserveAutomaticSelection && current) {
    // Retry keeps the raw attempted output; only say the catalog moved when it
    // actually stopped publishing that pair.
    notice.value = findOutputOption(props.model, current)
      ? ''
      : `The live catalog no longer publishes ${current.resolution} at ${current.aspect_ratio}. `
        + 'Retry keeps the original output; choose a live size to start a different request.'
    return
  }
  notice.value = result.notice
  if (result.notice) emit('switched', result.notice)
  if (!same) emit('update:modelValue', next)
}

watch(
  [() => props.model, () => props.preserveAutomaticSelection, () => props.preferredAspectRatio],
  reconcile,
  { immediate: true, deep: true },
)
</script>

<style scoped>
.output-options { margin-top: 10px; }
.output-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.output-label { font-size: var(--font-sm); font-weight: 600; color: var(--text); }
.output-sub { font-size: var(--font-xs); color: var(--text-muted); line-height: 1.4; }
.output-constraint { margin: 0 0 6px; font-size: var(--font-xs); color: var(--text-muted); line-height: 1.4; }
.output-grid { display: grid; gap: 6px; }
.output-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'main dims' 'cost cost';
  gap: 2px 12px;
  align-items: center;
  text-align: left;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface, transparent);
  cursor: pointer;
}
.output-row.active { border-color: var(--primary, #2563eb); box-shadow: inset 0 0 0 1px var(--primary, #2563eb); }
.output-main { grid-area: main; display: flex; align-items: center; gap: 8px; min-width: 0; }
.output-res { font-size: var(--font-sm); font-weight: 600; color: var(--text); }
.output-ratio { font-size: var(--font-xs); color: var(--text-muted); }
.output-default {
  font-size: var(--font-xs);
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
}
.output-dims { grid-area: dims; font-size: var(--font-xs); color: var(--text-muted); white-space: nowrap; }
.output-cost { grid-area: cost; font-size: var(--font-xs); color: var(--text-muted); }
.output-cost.basis-unpublished { color: var(--warning, #d97706); }
.output-cost.basis-free { color: var(--success, #16a34a); }
.output-notice { margin: 8px 0 0; font-size: var(--font-xs); color: var(--warning, #d97706); line-height: 1.4; }
</style>
