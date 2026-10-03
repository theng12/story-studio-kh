<!--
  One effect card's picture: the effect drawn over the episode's own scene (or
  a dusk gradient when there is none) by the live-preview renderer, so the
  thumbnail is the effect itself rather than a stock image. Still until
  hovered; plays while the pointer is on it.
-->
<template>
  <canvas
    ref="canvas"
    class="effect-thumb"
    :width="width"
    :height="height"
    aria-hidden="true"
    @mouseenter="play"
    @mouseleave="stop"
  />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SceneOverlayDocument } from '@shared/scene-effects'
import { EffectCanvasRenderer, SLOW_ZOOM } from '~/utils/effect-preview-canvas'

const props = withDefaults(defineProps<{
  doc: SceneOverlayDocument | null
  image: HTMLImageElement | null
  width?: number
  height?: number
}>(), { width: 320, height: 180 })

const canvas = ref<HTMLCanvasElement | null>(null)
const renderer = new EffectCanvasRenderer((w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }))
let raf = 0
let started = 0

function draw(t: number): void {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return
  renderer.draw(ctx, props.image, props.doc ? [props.doc] : [], t, SLOW_ZOOM)
}

function play(): void {
  if (raf) return
  started = performance.now() - 1300
  const tick = (now: number) => { draw((now - started) / 1000); raf = requestAnimationFrame(tick) }
  raf = requestAnimationFrame(tick)
}

function stop(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  draw(1.3)
}

onMounted(() => draw(1.3))
watch(() => [props.doc, props.image], () => { if (!raf) draw(1.3) })
onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf) })
</script>

<style scoped>
.effect-thumb {
  display: block;
  width: 100%;
  height: 92px;
  object-fit: cover;
  background: var(--bg-tertiary);
}
</style>
