<template>
  <div class="placement">
    <p>Drag the label or its pointing target. Use the arrow keys for fine adjustments.</p>
    <div ref="frame" class="frame">
      <img v-if="imageUrl && !imageFailed" :src="imageUrl" alt="" class="scene" @error="imageFailed = true" />
      <div v-else class="empty">No scene image yet</div>
      <template v-if="!cue.template.startsWith('label:') || preview">
        <svg v-if="preview?.pointing && target" class="line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line :x1="position.xPct" :y1="position.yPct" :x2="target.x" :y2="target.y" />
        </svg>
        <button type="button" class="label" :class="{ 'image-label': preview }" :style="labelStyle" aria-label="Move label; use arrow keys" @pointerdown="start($event, 'label')" @keydown="nudge($event, 'label')">
          <img v-if="preview" :src="preview.image" alt="" />
          <template v-else><strong>{{ cue.title || 'Cue title' }}</strong><small v-if="cue.subtitle">{{ cue.subtitle }}</small></template>
        </button>
        <button v-if="preview?.pointing" type="button" class="target" :style="targetStyle" aria-label="Move pointing target; use arrow keys" @pointerdown="start($event, 'target')" @keydown="nudge($event, 'target')"><span></span></button>
      </template>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="cue.template.startsWith('label:') && !preview" role="status">Loading label preview…</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { clampCuePct, labelImagePosition, nearestCueCorner, resolveContextualCuePosition, type ContextualCueCorner } from '@shared/contextual-cue-position'

type Cue = { placement: ContextualCueCorner; position_x_pct?: number | null; position_y_pct?: number | null; target_x_pct?: number | null; target_y_pct?: number | null; template: string; title: string; subtitle?: string }
type Preview = { image: string; width: number; height: number; anchor: { x: number; y: number }; pointing: boolean }
const props = defineProps<{ cue: Cue; imageUrl: string; projectSlug: string }>()
const emit = defineEmits<{ change: [] }>()
const { post } = useApi()
const frame = ref<HTMLElement | null>(null)
const preview = ref<Preview | null>(null)
const error = ref('')
const imageFailed = ref(false)
const position = computed(() => resolveContextualCuePosition(props.cue))
const target = computed(() => props.cue.target_x_pct != null && props.cue.target_y_pct != null ? { x: props.cue.target_x_pct, y: props.cue.target_y_pct } : null)
const targetStyle = computed(() => ({ left: `${target.value?.x ?? 50}%`, top: `${target.value?.y ?? 50}%` }))
const labelStyle = computed(() => {
  if (preview.value) {
    const p = labelImagePosition(props.cue, preview.value, 1920, 1080)
    return { left: `${p.x / 1920 * 100}%`, top: `${p.y / 1080 * 100}%`, width: `${preview.value.width / 1920 * 100}%`, height: `${preview.value.height / 1080 * 100}%` }
  }
  const { xPct, yPct } = position.value
  return { left: `${xPct}%`, top: `${yPct}%`, transform: `translate(${xPct <= 33 ? '0%' : xPct >= 67 ? '-100%' : '-50%'}, ${yPct <= 33 ? '0%' : yPct >= 67 ? '-100%' : '-50%'})` }
})
let request = 0
watch(() => [props.projectSlug, props.cue.template, props.cue.title, props.cue.subtitle], async () => {
  const seq = ++request
  preview.value = null; error.value = ''
  if (!props.cue.template.startsWith('label:')) return
  try {
    const result = await post<Preview>(`/projects/${encodeURIComponent(props.projectSlug)}/sound-and-labels/label-preview`, { template: props.cue.template, title: props.cue.title, subtitle: props.cue.subtitle })
    if (seq === request) preview.value = result
  } catch { if (seq === request) error.value = 'Could not load this label preview. Try choosing the design again.' }
}, { immediate: true })
watch(() => props.imageUrl, () => { imageFailed.value = false })
function move(kind: 'label' | 'target', x: number, y: number) {
  x = Number(clampCuePct(x).toFixed(1)); y = Number(clampCuePct(y).toFixed(1))
  if (kind === 'label') { props.cue.position_x_pct = x; props.cue.position_y_pct = y; props.cue.placement = nearestCueCorner(x, y) }
  else { props.cue.target_x_pct = x; props.cue.target_y_pct = y }
  emit('change')
}
function start(event: PointerEvent, kind: 'label' | 'target') {
  if (event.button !== 0 || !frame.value) return
  event.preventDefault()
  const element = event.currentTarget as HTMLElement
  element.focus(); element.setPointerCapture(event.pointerId)
  const rect = frame.value.getBoundingClientRect()
  const original = kind === 'label' ? { x: position.value.xPct, y: position.value.yPct } : target.value ?? { x: 50, y: 50 }
  const startX = event.clientX, startY = event.clientY
  const onMove = (e: PointerEvent) => move(kind, original.x + (e.clientX - startX) / rect.width * 100, original.y + (e.clientY - startY) / rect.height * 100)
  const finish = () => { element.removeEventListener('pointermove', onMove); element.removeEventListener('pointerup', finish); element.removeEventListener('pointercancel', finish) }
  element.addEventListener('pointermove', onMove); element.addEventListener('pointerup', finish); element.addEventListener('pointercancel', finish)
}
function nudge(event: KeyboardEvent, kind: 'label' | 'target') {
  const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const delta = direction[event.key]
  if (!delta) return
  event.preventDefault()
  const current = kind === 'label' ? { x: position.value.xPct, y: position.value.yPct } : target.value ?? { x: 50, y: 50 }
  const step = event.shiftKey ? 5 : 1
  move(kind, current.x + delta[0] * step, current.y + delta[1] * step)
}
</script>

<style scoped>
.placement { min-width: 0; display: grid; gap: .35rem; }
.placement p { margin: 0; color: var(--text-muted); font-size: .75rem; overflow-wrap: anywhere; }
.frame { position: relative; aspect-ratio: 16 / 9; width: 100%; max-width: 32rem; overflow: hidden; background: #0b1220; border: 1px solid #364152; border-radius: .45rem; }
.scene { display: block; width: 100%; height: 100%; object-fit: fill; }
.empty { display: grid; place-items: center; height: 100%; color: #b6c0d1; font-size: .8rem; }
.line { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.line line { stroke: #f4c75d; stroke-width: .5; vector-effect: non-scaling-stroke; }
.label { position: absolute; display: grid; max-width: 62%; padding: .25rem .45rem; color: white; background: #111827; border: 1px solid #65738b; border-radius: .25rem; text-align: left; font-size: .65rem; overflow-wrap: anywhere; cursor: grab; touch-action: none; }
.label small { font-size: .55rem; }
.label.image-label { max-width: none; padding: 0; border: 0; background: transparent; }
.label img { display: block; width: 100%; height: 100%; }
.target { position: absolute; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; transform: translate(-50%, -50%); background: transparent; border: 0; cursor: grab; touch-action: none; }
.target span { width: 10px; height: 10px; border-radius: 50%; background: #f4c75d; border: 2px solid #242322; }
.label:focus-visible, .target:focus-visible { outline: 2px solid white; outline-offset: 2px; }
.label:active, .target:active { cursor: grabbing; }
</style>
