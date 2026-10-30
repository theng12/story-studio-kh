<!--
  Text size, with the size shown rather than described: the slider and a live sample of the post's own
  face at that size, drawn by the real renderer.
-->
<template>
  <div class="sp-field">
    <span class="sp-label">Text size <span class="sp-count">{{ value.toFixed(2) }}×</span></span>
    <input :value="value" class="sp-range" type="range" min="0.6" max="1.6" step="0.05" aria-label="Text size" @input="onInput">
    <StillPostsFontSample v-if="sampleFont" :font-id="sampleFont" :scale="value" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const props = defineProps<{ modelValue: number }>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
const { preset, poolRows, draftFormat } = useStillPosts()

const value = computed(() => Number(props.modelValue) || 1)
/** The face posts are actually lettered in: the pool's first for this language, else the format's own. */
const sampleFont = computed(() => {
  const row = poolRows.value.find(entry => entry.language === preset.language)
  const pooled = row?.pool.fonts[0]?.font_id
  if (pooled) return pooled
  const script = row?.script || 'latn'
  return (draftFormat.value as any)?.lettering?.fonts?.[script] || ''
})

function onInput(event: Event): void {
  emit('update:modelValue', Number((event.target as HTMLInputElement).value))
}
</script>
