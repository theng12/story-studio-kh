<!--
  Format (the look): the chosen one stays visible as its sample picture on the page; changing it opens a
  popup of cards, one per format, each with that format's own sample picture. A format with no sample
  shows a plain "no sample yet" card — never a borrowed or invented image.
-->
<template>
  <div class="sp-visual-field">
    <span class="sp-label">Format (the look)</span>
    <button type="button" class="sp-visual-current" :aria-label="`Change format (now ${current?.name || 'none'})`" @click="open = true">
      <img v-if="current && sampleOk[current.id] !== false" :src="sampleUrl(current.id)" :alt="`${current.name} sample`" @error="sampleOk[current.id] = false">
      <span v-else class="sp-visual-noimage">{{ current ? 'No sample yet' : 'No format' }}</span>
      <span class="sp-visual-copy">
        <strong>{{ current?.name || 'Choose a format' }}</strong>
        <span>{{ current?.description || 'The look every picture of this batch is drawn in.' }}</span>
      </span>
      <span class="sp-visual-action">Change</span>
    </button>

    <PickerDialog :visible="open" kind="LOOK" title="Choose a format" :description="`${formats.length} looks, each with its own sample picture`" :count="`${formats.length}`" size="xl" @close="open = false">
      <div class="sp-visual-grid" role="radiogroup" aria-label="Format">
        <button
          v-for="format in formats"
          :key="format.id"
          type="button"
          role="radio"
          :aria-checked="preset.format_id === format.id"
          class="sp-visual-card"
          :class="{ 'is-selected': preset.format_id === format.id }"
          @click="choose(format.id)"
        >
          <span class="sp-visual-card-image">
            <img v-if="sampleOk[format.id] !== false" :src="sampleUrl(format.id)" :alt="`${format.name} sample`" loading="lazy" @error="sampleOk[format.id] = false">
            <span v-else class="sp-visual-noimage">No sample yet</span>
          </span>
          <span class="sp-visual-card-copy">
            <strong>{{ format.name }}</strong>
            <span>{{ format.description }}</span>
          </span>
        </button>
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const { workspace, preset, draftFormat, formatSampleUrl } = useStillPosts()
const formats = computed(() => workspace.value?.formats || [])
const current = computed(() => draftFormat.value)
const open = ref(false)
const sampleOk = reactive<Record<string, boolean>>({})

function sampleUrl(id: string): string {
  return formatSampleUrl(id)
}
function choose(id: string): void {
  preset.format_id = id
  open.value = false
}
</script>
