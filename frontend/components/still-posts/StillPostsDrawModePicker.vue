<!--
  The drawing choice as two picture examples, not a sentence: one drawing fitted into each frame (the
  default) or a fresh drawing for every frame. The little diagrams show exactly what each means.
-->
<template>
  <div class="sp-field">
    <span class="sp-label">Drawings</span>
    <div class="sp-drawmode-row" role="radiogroup" aria-label="Drawings per post">
      <button
        type="button"
        role="radio"
        :aria-checked="!modelValue"
        class="sp-drawmode"
        :class="{ 'is-selected': !modelValue }"
        @click="emit('update:modelValue', false)"
      >
        <span class="sp-drawmode-art" aria-hidden="true">
          <span class="sp-drawmode-source">1</span>
          <span class="sp-drawmode-frames">
            <span class="sp-frame-shape shape-1-1" /><span class="sp-frame-shape shape-9-16" /><span class="sp-frame-shape shape-16-9" />
          </span>
        </span>
        <span class="sp-drawmode-copy">
          <strong>One drawing, fitted to each size (default)</strong>
          <span>One picture, framed into every chosen size. The default, and the cheapest.</span>
        </span>
      </button>
      <button
        type="button"
        role="radio"
        :aria-checked="modelValue"
        class="sp-drawmode"
        :class="{ 'is-selected': modelValue }"
        @click="emit('update:modelValue', true)"
      >
        <span class="sp-drawmode-art" aria-hidden="true">
          <span class="sp-drawmode-source is-many">3</span>
          <span class="sp-drawmode-frames">
            <span class="sp-frame-shape shape-1-1" /><span class="sp-frame-shape shape-9-16" /><span class="sp-frame-shape shape-16-9" />
          </span>
        </span>
        <span class="sp-drawmode-copy">
          <strong>A fresh drawing for each size (up to 3× the drawings)</strong>
          <span>Each frame is composed for its own shape. Up to 3× the drawings, so 3× the cost.</span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>
