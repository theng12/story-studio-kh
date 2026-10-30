<!--
  One bundled face, shown in its own type with a sample line in the post's language, drawn by the real
  lettering renderer on the server. A face that cannot draw the line says so plainly instead of showing
  a sample in some other font.
-->
<template>
  <span class="sp-font-sample" :class="{ selected }">
    <img
      v-if="!failed && fontId"
      :src="sampleUrl"
      :alt="`${label}: the sample line drawn in this face`"
      loading="lazy"
      @error="failed = true"
    >
    <span v-else class="sp-font-sample-fallback">{{ fontId ? 'This face cannot draw this language.' : 'No sample' }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const props = defineProps<{ fontId: string, label?: string, selected?: boolean, scale?: number }>()
const { fontSampleUrl, preset } = useStillPosts()
const failed = ref(false)
watch(() => [props.fontId, preset.language, props.scale], () => { failed.value = false })
const sampleUrl = computed(() => fontSampleUrl(props.fontId, preset.language, props.scale ?? 1))
</script>
