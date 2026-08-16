<template>
  <div class="form-group">
    <label>{{ label }} ({{ display }}{{ unit ? ` ${unit}` : '' }})</label>
    <input
      type="range"
      :min="min" :max="max" :step="step"
      :value="value"
      class="slider"
      @input="emit('change', Number(($event.target as HTMLInputElement).value))"
    />
    <p v-if="hint" class="text-muted ssf-hint">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * One numeric field in the subtitle properties panel.
 *
 * Every schema field has a documented range, and that range is the slider's
 * bounds — the panel cannot produce a value the renderer would have to clamp.
 * `hint` exists so a field whose libass behaviour is surprising can say so at
 * the point of use instead of only in the schema comments.
 */
const props = withDefaults(defineProps<{
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  hint?: string
}>(), { step: 1, unit: '', hint: '' })

const emit = defineEmits<{ change: [value: number] }>()

const display = computed(() => {
  const n = Number(props.value)
  if (!Number.isFinite(n)) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
})
</script>

<style scoped>
.ssf-hint { font-size: var(--font-xs); margin-top: 3px; max-width: 40ch; }
</style>
