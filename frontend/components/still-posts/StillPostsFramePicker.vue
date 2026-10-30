<!--
  Export frames as small shapes rather than words: a square for 1:1, a tall rectangle for 9:16 and a
  wide one for 16:9. The shape IS the label, so the choice is visible without reading.
-->
<template>
  <div class="sp-field">
    <span class="sp-label">Export frames</span>
    <div class="sp-frame-row" role="group" aria-label="Export frames">
      <button
        v-for="aspect in aspects"
        :key="aspect"
        type="button"
        class="sp-frame"
        :class="{ 'is-on': modelValue.includes(aspect) }"
        :aria-pressed="modelValue.includes(aspect)"
        :aria-label="`${aspect} frames`"
        @click="toggle(aspect)"
      >
        <span class="sp-frame-shape" :class="`shape-${aspect.replace(':', '-')}`" aria-hidden="true" />
        <span class="sp-frame-label">{{ aspect }}</span>
      </button>
    </div>
    <span class="sp-help">Every ticked frame is rendered for every post before a batch is complete.</span>
  </div>
</template>

<script setup lang="ts">
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const props = defineProps<{ modelValue: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const { aspects } = useStillPosts()

function toggle(aspect: string): void {
  const has = props.modelValue.includes(aspect)
  // At least one frame always stays ticked: a post with no frame has nothing to publish.
  if (has && props.modelValue.length === 1) return
  emit('update:modelValue', has ? props.modelValue.filter(entry => entry !== aspect) : [...props.modelValue, aspect])
}
</script>
