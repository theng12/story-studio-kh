<template>
  <div class="swn-row">
    <input
      type="range"
      class="slider swn-slider"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      @input="onRange"
    />
    <div class="swn-number-wrap">
      <input
        type="number"
        class="input input-sm swn-number"
        :min="min"
        :max="max"
        :step="step"
        :value="text"
        :disabled="disabled"
        @focus="onFocus"
        @input="onNumber"
        @blur="onBlur"
      />
      <span v-if="suffix" class="swn-suffix">{{ suffix }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Slider paired with a precise number input. Both edit the same bound value
 * (`v-model`). The number input clamps to [min, max] on blur, so free-typing
 * an out-of-range value snaps back instead of quietly corrupting state.
 *
 * Step applies to both controls. For decimal steps (e.g. 0.01), the number
 * field retains full precision — the slider display is what the browser
 * renders, but the raw value emitted is whatever the user typed (clamped).
 */
const props = withDefaults(defineProps<{
  modelValue: number
  min: number
  max: number
  step?: number
  suffix?: string
  disabled?: boolean
  /** Decimals shown in the number field. Defaults to inferring from step. */
  decimals?: number
}>(), {
  step: 1,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: number]
}>()

const decimals = computed(() => {
  if (typeof props.decimals === 'number') return props.decimals
  // Infer from step: e.g. 0.01 → 2 decimals, 1 → 0.
  const s = String(props.step)
  const dot = s.indexOf('.')
  return dot >= 0 ? s.length - dot - 1 : 0
})

// v1.0.306 — the number field is a FOCUS-AWARE text buffer. Previously the
// input was bound `:value="modelValue.toFixed(decimals)"`, which re-formatted on
// every keystroke's emit: typing "0.8" went "0" → emit 0 → field snaps to
// "0.00" → "0." → "0.00" again… landing on garbage. Now `text` holds exactly
// what the user types WHILE the field is focused, and only re-syncs from the
// (clamped) model when the field is NOT focused — e.g. the slider moved, a
// preset loaded, or the user blurred. This fully decouples typing from display.
const focused = ref(false)
const text = ref(Number(props.modelValue).toFixed(decimals.value))

watch(() => [props.modelValue, decimals.value] as const, () => {
  if (!focused.value) text.value = Number(props.modelValue).toFixed(decimals.value)
})

function clamp(v: number): number {
  if (Number.isNaN(v)) return props.min
  return Math.min(props.max, Math.max(props.min, v))
}

function onRange(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  emit('update:modelValue', v)
}

function onFocus() {
  focused.value = true
}

function onNumber(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  text.value = raw  // keep exactly what the user typed — no re-format mid-edit
  // Mid-typing tokens that aren't a complete number yet: don't thrash the model.
  if (raw === '' || raw === '-' || raw === '.' || raw === '-.' || raw.endsWith('.')) return
  const v = parseFloat(raw)
  if (Number.isNaN(v)) return
  emit('update:modelValue', v)  // emit raw value live; clamp happens on blur
}

function onBlur() {
  focused.value = false
  const v = text.value.trim() === '' ? props.min : parseFloat(text.value)
  const c = clamp(Number.isNaN(v) ? props.min : v)
  emit('update:modelValue', c)
  text.value = c.toFixed(decimals.value)  // snap the field to the clamped value
}
</script>

<style scoped>
.swn-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.swn-slider {
  flex: 1;
  min-width: 0;
}
.swn-number-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.swn-number {
  width: 68px;
  text-align: right;
  /* Hide the native spinner so it doesn't compete with the slider for space. */
  appearance: textfield;
  -moz-appearance: textfield;
}
.swn-number::-webkit-outer-spin-button,
.swn-number::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}
.swn-suffix {
  font-size: var(--font-xs);
  color: var(--text-muted);
  min-width: 12px;
}
</style>
