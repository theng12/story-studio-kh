<!--
  Where the handle and logo sit, as a small diagram: the post is a frame, the mark is a spot on it.
  The same seven anchors the renderer understands, nothing invented.
-->
<template>
  <div class="sp-field">
    <span class="sp-label">Placement</span>
    <div class="sp-pos-grid" role="radiogroup" aria-label="Handle and logo placement">
      <button
        v-for="cell in cells"
        :key="cell.anchor"
        type="button"
        role="radio"
        :aria-checked="modelValue === cell.anchor"
        :aria-label="cell.anchor"
        :disabled="!cell.anchor"
        class="sp-pos-cell"
        :class="{ 'is-selected': modelValue === cell.anchor, 'is-blank': !cell.anchor }"
        @click="cell.anchor && emit('update:modelValue', cell.anchor)"
      >
        <span v-if="cell.anchor" class="sp-pos-mark" />
      </button>
    </div>
    <span class="sp-help">The handle and the logo are drawn in this corner of every post.</span>
  </div>
</template>

<script setup lang="ts">
/**
 * Three rows of three. The renderer knows seven anchors; two cells of this grid are empty on purpose,
 * because naming a spot it cannot draw would be a control that does nothing.
 */
const cells: Array<{ anchor: string | null }> = [
  { anchor: 'top-left' }, { anchor: 'top' }, { anchor: 'top-right' },
  { anchor: null }, { anchor: 'center' }, { anchor: null },
  { anchor: 'bottom-left' }, { anchor: 'bottom' }, { anchor: 'bottom-right' },
]
defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
