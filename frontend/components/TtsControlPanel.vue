<template>
  <!-- A model publishing no controls shows no control section at all. -->
  <div v-if="fields.length" class="form-group mb-2">
    <label>
      Model controls
      <span class="field-hint">— published by {{ modelName || 'the selected model' }}</span>
    </label>
    <p class="text-muted text-xs hint-line">
      These are {{ modelName || 'this model' }}'s own controls, exactly as GenStudio publishes them.
      Choosing another model shows that model's controls instead, reset to its own defaults — nothing carries over.
    </p>

    <div class="tts-controls">
      <div v-for="field in fields" :key="field.name" class="tts-control">
        <!-- The ONLY dispatch in the panel: the published `type`. -->
        <template v-if="field.kind === 'number'">
          <label :for="fieldId(field)">
            {{ field.label }}
            <span class="tts-control-value">{{ displayNumber(field) }}</span>
          </label>
          <SliderWithNumber
            v-if="field.minimum !== null && field.maximum !== null"
            :model-value="numberValue(field)"
            :min="field.minimum"
            :max="field.maximum"
            :step="field.step ?? undefined"
            :decimals="decimalsFor(field)"
            @update:model-value="(next: number) => update(field, next)"
          />
          <!-- No published bound means no bound is applied. A slider needs two
               ends, so an unbounded number gets a plain field rather than a
               range Story Studio would have had to invent limits for. -->
          <input
            v-else
            :id="fieldId(field)"
            type="number"
            class="input input-sm"
            :min="field.minimum ?? undefined"
            :max="field.maximum ?? undefined"
            :step="field.step ?? undefined"
            :value="numberValue(field)"
            @change="(event: Event) => update(field, (event.target as HTMLInputElement).value)"
          />
        </template>

        <template v-else-if="field.kind === 'boolean'">
          <label class="checkbox-label" :for="fieldId(field)">
            <input
              :id="fieldId(field)"
              type="checkbox"
              :checked="field.value === true"
              @change="(event: Event) => update(field, (event.target as HTMLInputElement).checked)"
            />
            <span>{{ field.label }}</span>
          </label>
        </template>

        <template v-else>
          <label :for="fieldId(field)">
            {{ field.label }}
            <span v-if="field.maxLength !== null" class="field-hint">
              — up to {{ field.maxLength.toLocaleString() }} characters
            </span>
          </label>
          <textarea
            :id="fieldId(field)"
            class="input tts-control-text"
            rows="3"
            :maxlength="field.maxLength ?? undefined"
            :value="String(field.value)"
            @input="(event: Event) => update(field, (event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </template>

        <p v-if="field.description" class="text-muted text-xs hint-line">{{ field.description }}</p>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Module scope, so each panel instance gets its own label-id prefix. */
let panelInstances = 0
</script>

<script setup lang="ts">
/**
 * Renders whatever controls the selected TTS model publishes — and nothing
 * else.
 *
 * Every widget, label, bound, step and default on this page comes from
 * `TTSModelResponse.controls[]`. There is no list of control names here, no
 * range, no default and no per-provider branch: the single decision the
 * template makes is `field.kind`, which is the published `type` narrowed to
 * the three shapes this build can draw. A control this build does not
 * recognise is dropped upstream by `describeTtsControls`, so a new GenStudio
 * type degrades to "not shown" rather than to a crash.
 *
 * Values are always emitted through `coerceTtsControlValue`, so what leaves
 * here is inside the range the model itself published for that control.
 */
import {
  coerceTtsControlValue,
  describeTtsControls,
  ttsControlDecimals,
  type GenStudioTtsControl,
  type TtsControlField,
  type TtsControlValues,
} from '~/utils/tts-controls'

const props = defineProps<{
  /** The SELECTED model's published `controls[]`, straight from the catalogue. */
  controls: GenStudioTtsControl[]
  /** Current values, keyed by published control name. */
  modelValue: Record<string, unknown>
  /** For the heading only — GenStudio's own display name for the model. */
  modelName?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: TtsControlValues] }>()

/** Published controls plus their current values, ready to draw. */
const fields = computed<TtsControlField[]>(() => describeTtsControls(props.controls, props.modelValue))

// Per-instance prefix so two panels on one page cannot collide on a label's
// `for`. A counter, not a control name — ids are ours, control names are not.
const uid = `tts-control-${++panelInstances}`
const fieldId = (field: TtsControlField): string => `${uid}-${field.name}`

const numberValue = (field: TtsControlField): number =>
  typeof field.value === 'number' ? field.value : Number(field.value) || 0

const decimalsFor = (field: TtsControlField): number => ttsControlDecimals(field.step)

/** Shown beside the label, at the precision the model's own `step` implies. */
const displayNumber = (field: TtsControlField): string =>
  numberValue(field).toFixed(decimalsFor(field))

/**
 * Write one control back, coerced against its own published definition.
 *
 * The emitted map is rebuilt from the published list every time, so a value
 * belonging to a control this model does not publish can never survive an
 * edit — the same guarantee the request path enforces before sending.
 */
function update(field: TtsControlField, next: unknown): void {
  const control = props.controls.find(entry => entry.name === field.name)
  if (!control) return
  const coerced = coerceTtsControlValue(control, next)
  if (coerced === undefined) return
  const values: TtsControlValues = {}
  for (const entry of fields.value) values[entry.name] = entry.value
  values[field.name] = coerced
  emit('update:modelValue', values)
}
</script>

<style scoped>
.hint-line { margin-top: 4px; }

.tts-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
  margin-top: 8px;
}

.tts-control { display: flex; flex-direction: column; gap: 4px; }

/* The live value, beside the control's published label. */
.tts-control-value {
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}

.tts-control-text { resize: vertical; min-height: 64px; }
</style>
