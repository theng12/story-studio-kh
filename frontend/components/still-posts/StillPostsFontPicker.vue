<!--
  Choosing a face from a pool, in a popup: every offered face with a sample line in the post's language.
  The sample is drawn by the real renderer, so what is chosen is what posts are lettered in.
-->
<template>
  <PickerDialog
    :visible="visible"
    kind="FONT"
    :title="`Add a ${languageLabel} font`"
    description="Each face is shown with a sample line in this language."
    :count="`${faces.length}`"
    size="lg"
    @close="emit('close')"
  >
    <div class="sp-font-grid" role="listbox" :aria-label="`${languageLabel} fonts`">
      <button
        v-for="face in faces"
        :key="face.id"
        type="button"
        role="option"
        :aria-selected="false"
        class="sp-font-card"
        @click="emit('choose', face.id)"
      >
        <StillPostsFontSample :font-id="face.id" :label="face.label" />
        <span class="sp-font-name">{{ face.label }}</span>
      </button>
      <p v-if="!faces.length" class="sp-help">No bundled font covers {{ languageLabel }}.</p>
    </div>
  </PickerDialog>
</template>

<script setup lang="ts">
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

defineProps<{ visible: boolean, languageLabel: string, faces: Array<{ id: string, label: string }> }>()
const emit = defineEmits<{ close: [], choose: [fontId: string] }>()
void useStillPosts
</script>
