<!--
  The layout (option) sample, DRAWN by the real layout data: the placeholder frame is neutral on purpose,
  and every box comes from the option's own text boxes (anchor, centre, width, height, alignment, line
  budget) and the format's own lettering colour. Nothing here duplicates those numbers, so a sample can
  never drift from what the renderer does.
-->
<template>
  <div class="sp-layout-sample" :class="{ compact }" :style="{ aspectRatio: ratio.replace(':', ' / ') }">
    <div class="sp-layout-art" aria-hidden="true">
      <span class="sp-layout-moon" />
      <span class="sp-layout-hill" />
    </div>
    <div
      v-for="(box, index) in boxes"
      :key="index"
      class="sp-layout-box"
      :class="{ 'is-panel': boxes.length === 1 }"
      :style="boxStyle(box)"
    >
      <span v-for="line in box.lines" :key="line" class="sp-layout-line" :style="lineStyle(box.align)">Your words</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  option: { panels: 1 | 2, text: Array<{ anchor: string, x_pct: number, y_pct: number, width_pct: number, height_pct: number, align: string, max_lines: number }>, text_background: boolean }
  fill?: string
  panelColor?: string
  ratio?: string
  compact?: boolean
}>(), {
  fill: '#F4EFE6',
  panelColor: 'rgba(0, 0, 0, 0.55)',
  ratio: '1:1',
  compact: false,
})

const boxes = computed(() => props.option.text.map(box => ({
  ...box,
  lines: Array.from({ length: Math.max(1, Math.min(3, box.max_lines)) }, (_, index) => index),
})))

function lineStyle(align: string): Record<string, string> {
  return { color: props.fill, textAlign: align as 'left' | 'center' | 'right' }
}

function boxStyle(box: { x_pct: number, y_pct: number, width_pct: number, height_pct: number, align: string }): Record<string, string> {
  return {
    left: `${box.x_pct}%`,
    top: `${box.y_pct}%`,
    width: `${box.width_pct}%`,
    minHeight: `${Math.max(6, box.height_pct / 2)}%`,
    transform: 'translate(-50%, -50%)',
    textAlign: box.align,
    background: props.option.text_background ? props.panelColor : 'transparent',
    color: props.fill,
  }
}
</script>

<style scoped>
.sp-layout-sample { position: relative; width: 100%; overflow: hidden; border-radius: 10px; background: linear-gradient(180deg, #232a3f, #0f1220); }
.sp-layout-sample.compact { border-radius: 8px; }
.sp-layout-art { position: absolute; inset: 0; }
.sp-layout-moon { position: absolute; top: 16%; left: 50%; width: 22%; aspect-ratio: 1; transform: translateX(-50%); border-radius: 50%; background: #e9dcc0; opacity: .75; }
.sp-layout-hill { position: absolute; right: 0; bottom: 0; left: 0; height: 32%; background: #0b0e16; border-radius: 60% 40% 0 0; }
.sp-layout-box { position: absolute; display: flex; flex-direction: column; gap: 4%; padding: 3% 0; border-radius: 10px; outline: 1px dashed color-mix(in srgb, #ffffff 42%, transparent); outline-offset: 2px; }
.sp-layout-line { font-size: clamp(6px, 3.4vw, 15px); font-weight: 700; line-height: 1.15; letter-spacing: .01em; }
.sp-layout-sample.compact .sp-layout-line { font-size: var(--font-xs); transform: scale(.9); transform-origin: center; }
</style>
