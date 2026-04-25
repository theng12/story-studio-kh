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
        :value="displayedValue"
        :disabled="disabled"
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

const displayedValue = computed(() => {
  // Keep the field value matching the bound value precisely so typing
  // 0.1 doesn't get round-tripped to 0.10000000001 from parseFloat.
  return Number(props.modelValue).toFixed(decimals.value)
})

function clamp(v: number): number {
  if (Number.isNaN(v)) return props.min
  return Math.min(props.max, Math.max(props.min, v))
}

function onRange(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  emit('update:modelValue', v)
}

function onNumber(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  // Allow empty while typing — don't thrash the bound value to 0. The
  // blur handler will snap back to min if they leave it blank.
  if (raw === '' || raw === '-' || raw === '.') return
  const v = parseFloat(raw)
  if (Number.isNaN(v)) return
  emit('update:modelValue', v)
}

function onBlur(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const v = raw === '' ? props.min : parseFloat(raw)
  emit('update:modelValue', clamp(v))
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
  font-size: 11px;
  color: var(--text-muted);
  min-width: 12px;
}
</style>
