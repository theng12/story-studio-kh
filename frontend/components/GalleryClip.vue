<!--
  One effects-gallery clip (1.4.283): a 6-second loop rendered by Story itself.
  The video is only asked for once the card scrolls into view, and whatever is
  in the default slot (the live canvas thumbnail) shows until it has loaded.
-->
<template>
  <div ref="root" class="gallery-clip">
    <video
      v-if="visible && src && !failed"
      v-show="ready"
      :src="src"
      class="gallery-clip-video"
      autoplay muted loop playsinline preload="auto"
      @loadeddata="ready = true"
      @error="failed = true"
    />
    <div v-if="!ready || failed" class="gallery-clip-fallback"><slot /></div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ src: string }>()
const root = ref<HTMLElement | null>(null)
const visible = ref(false)
const ready = ref(false)
const failed = ref(false)
let observer: IntersectionObserver | null = null

watch(() => props.src, () => { ready.value = false; failed.value = false })

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') { visible.value = true; return }
  observer = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) { visible.value = true; observer?.disconnect() }
  }, { rootMargin: '200px' })
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<style scoped>
.gallery-clip { position: relative; width: 100%; height: 100%; background: #000; }
.gallery-clip-video { width: 100%; height: 100%; object-fit: cover; display: block; }
.gallery-clip-fallback { position: absolute; inset: 0; }
</style>
