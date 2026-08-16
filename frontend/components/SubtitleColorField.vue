<template>
  <div class="form-group">
    <label>{{ label }}</label>
    <div class="scf-row">
      <input
        type="color"
        :value="hex"
        class="color-picker"
        @input="emit('hex', ($event.target as HTMLInputElement).value.toUpperCase())"
      />
      <label class="scf-opacity">
        Opacity {{ Math.round(opacity * 100) }}%
        <input
          type="range" min="0" max="100" step="1"
          :value="Math.round(opacity * 100)"
          @input="emit('opacity', Number(($event.target as HTMLInputElement).value) / 100)"
        />
      </label>
    </div>
    <p v-if="hint" class="text-muted scf-hint">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * Colour plus opacity, as one control.
 *
 * ASS keeps colour and alpha in separate fields and so does the style schema,
 * because a caption often wants a fully-saturated colour at partial opacity.
 * Pairing them here keeps that honest without asking the customer to think
 * about `&HAABBGGRR`.
 */
defineProps<{
  label: string
  hex: string
  opacity: number
  hint?: string
}>()

const emit = defineEmits<{ hex: [value: string]; opacity: [value: number] }>()
</script>

<style scoped>
.scf-row { display: flex; align-items: center; gap: 10px; }
.scf-opacity { display: grid; gap: 2px; font-size: var(--font-xs); color: var(--text-secondary); flex: 1; }
.scf-opacity input { width: 100%; }
.scf-hint { font-size: var(--font-xs); margin-top: 3px; max-width: 40ch; }
.color-picker {
  width: 56px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  padding: 2px;
  flex: 0 0 auto;
}
</style>
