<!--
  Option (the layout): the chosen one stays visible as its own sample, drawn by the real renderer's
  layout on a neutral placeholder. The popup lists every layout with that same drawn sample — no image
  model is ever called, and the sample reads the option's own boxes, so it cannot drift.
-->
<template>
  <div class="sp-visual-field">
    <span class="sp-label">Option (the layout)</span>
    <button type="button" class="sp-visual-current" :aria-label="`Change layout (now ${current?.name || 'none'})`" @click="open = true">
      <StillPostsLayoutSample v-if="current" :option="current" :fill="fill" :panel-color="panelColor" :ratio="ratio" class="sp-visual-sample" />
      <span v-else class="sp-visual-noimage">No layout yet</span>
      <span class="sp-visual-copy">
        <strong>{{ current?.name || 'Choose a layout' }}</strong>
        <span>{{ current?.description || 'Where the words sit and what the picture leaves room for.' }}</span>
      </span>
      <span class="sp-visual-action">Change</span>
    </button>

    <PickerDialog :visible="open" kind="LAYOUT" title="Choose a layout" :description="`${options.length} layouts, drawn by the real renderer on a placeholder`" size="xl" @close="open = false">
      <div class="sp-visual-grid" role="radiogroup" aria-label="Layout">
        <button
          v-for="option in options"
          :key="option.id"
          type="button"
          role="radio"
          :aria-checked="preset.option_id === option.id"
          class="sp-visual-card"
          :class="{ 'is-selected': preset.option_id === option.id }"
          @click="choose(option.id)"
        >
          <StillPostsLayoutSample :option="option" :fill="fill" :panel-color="panelColor" :ratio="ratio" compact />
          <span class="sp-visual-card-copy">
            <strong>{{ option.name }}<span v-if="option.panels === 2" class="sp-count"> · two panels</span></strong>
            <span>{{ option.description }}</span>
          </span>
        </button>
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const { workspace, preset, draftOption, draftFormat } = useStillPosts()
const options = computed(() => workspace.value?.options || [])
const current = computed(() => draftOption.value)
const open = ref(false)

/** The format's own ink and panel colour, so the sample is in this batch's voice. */
const fill = computed(() => {
  const format = draftFormat.value as any
  const color = format?.lettering?.fill?.color
  return typeof color === 'string' ? color : '#F4EFE6'
})
const panelColor = computed(() => {
  const format = draftFormat.value as any
  const panel = format?.text_panel
  return panel?.color ? panel.color : 'rgba(0,0,0,0.55)'
})
const ratio = computed(() => preset.aspects[0] || '1:1')

function choose(id: string): void {
  preset.option_id = id
  open.value = false
}
</script>
