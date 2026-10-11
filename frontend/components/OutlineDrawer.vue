<!--
  E1 (1.4.287) — draw an outline on a scene's picture: ellipses, rectangles and
  polygons, with a feather. Saved like an uploaded outline (the backend draws the
  shapes at the picture's own size, checks them and stores `living_masks/<scene>-<name>.png`).
  Coordinates are 0..1 of the picture, the same shapes `region.shapes` takes.
-->
<template>
  <div class="od">
    <div class="od-tools" role="toolbar" aria-label="Outline tools">
      <button v-for="t in TOOLS" :key="t.key" type="button" class="btn btn-sm" :class="tool === t.key ? 'btn-primary' : 'btn-ghost'" @click="setTool(t.key)">{{ t.label }}</button>
      <button type="button" class="btn btn-sm btn-ghost" :disabled="!shapes.length && !points.length" @click="undo">Undo</button>
      <button type="button" class="btn btn-sm btn-ghost" :disabled="!shapes.length && !points.length" @click="clear">Clear</button>
    </div>
    <canvas
      ref="canvas"
      class="od-canvas"
      :width="size.w"
      :height="size.h"
      @mousedown="down"
      @mousemove="move"
      @mouseup="up"
      @dblclick="closePolygon"
    />
    <p class="hint">{{ toolHint }}</p>
    <div class="od-row">
      <label>Name <input v-model="label" class="input input-sm" placeholder="fire, water, sky, window…" aria-label="Outline name" /></label>
      <label>Feather <input v-model.number="feather" type="range" min="0" max="80" step="1" aria-label="Feather" /> <b>{{ feather }} px</b></label>
    </div>
    <p class="hint">
      The name lets a Living Picture on the whole episode find this scene's outline: “fire” moves every scene with a fire outline.
      Feather softens the edge so the moving part blends in.
    </p>
    <div class="od-row">
      <button type="button" class="btn btn-sm btn-primary" :disabled="!shapes.length || saving" @click="save">{{ saving ? 'Saving…' : 'Save Outline' }}</button>
      <button type="button" class="btn btn-sm btn-ghost" @click="emit('cancel')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

type Shape =
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'polygon'; points: Array<[number, number]> }

const props = defineProps<{ imageUrl: string; saving?: boolean }>()
const emit = defineEmits<{ save: [payload: { label: string; shapes: Shape[]; feather_px: number }]; cancel: [] }>()

const TOOLS = [
  { key: 'ellipse', label: 'Ellipse' },
  { key: 'rect', label: 'Rectangle' },
  { key: 'polygon', label: 'Polygon' },
] as const
type Tool = (typeof TOOLS)[number]['key']

const canvas = ref<HTMLCanvasElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
const size = ref({ w: 640, h: 360 })
const tool = ref<Tool>('ellipse')
const shapes = ref<Shape[]>([])
const points = ref<Array<[number, number]>>([])
const drag = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
const label = ref('outline')
const feather = ref(8)
const saving = computed(() => !!props.saving)

const toolHint = computed(() => tool.value === 'polygon'
  ? 'Click to add corners; double-click (or click the first corner) to close the shape.'
  : `Drag on the picture to draw ${tool.value === 'ellipse' ? 'an ellipse' : 'a rectangle'}. Add as many shapes as you need.`)

function setTool(next: Tool): void {
  tool.value = next
  points.value = []
}

function at(event: MouseEvent): [number, number] {
  const rect = canvas.value!.getBoundingClientRect()
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)]
}

function down(event: MouseEvent): void {
  const [x, y] = at(event)
  if (tool.value === 'polygon') {
    const first = points.value[0]
    if (first && points.value.length >= 3 && Math.hypot(first[0] - x, first[1] - y) < 0.015) { closePolygon(); return }
    points.value = [...points.value, [x, y]]
  } else {
    drag.value = { x0: x, y0: y, x1: x, y1: y }
  }
  draw()
}

function move(event: MouseEvent): void {
  if (!drag.value) return
  const [x, y] = at(event)
  drag.value = { ...drag.value, x1: x, y1: y }
  draw()
}

function dragShape(d: { x0: number; y0: number; x1: number; y1: number }): Shape | null {
  const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0)
  if (w < 0.005 || h < 0.005) return null
  return tool.value === 'ellipse' ? { type: 'ellipse', cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 } : { type: 'rect', x, y, w, h }
}

function up(): void {
  if (!drag.value) return
  const shape = dragShape(drag.value)
  drag.value = null
  if (shape) shapes.value = [...shapes.value, shape]
  draw()
}

function closePolygon(): void {
  if (tool.value !== 'polygon' || points.value.length < 3) return
  shapes.value = [...shapes.value, { type: 'polygon', points: points.value.slice(0, 64) }]
  points.value = []
  draw()
}

function undo(): void {
  if (points.value.length) points.value = points.value.slice(0, -1)
  else shapes.value = shapes.value.slice(0, -1)
  draw()
}

function clear(): void {
  shapes.value = []
  points.value = []
  draw()
}

function trace(ctx: CanvasRenderingContext2D, shape: Shape): void {
  const { w: W, h: H } = size.value
  ctx.beginPath()
  if (shape.type === 'ellipse') ctx.ellipse(shape.cx * W, shape.cy * H, shape.rx * W, shape.ry * H, 0, 0, Math.PI * 2)
  else if (shape.type === 'rect') ctx.rect(shape.x * W, shape.y * H, shape.w * W, shape.h * H)
  else shape.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)))
  ctx.closePath()
}

function draw(): void {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return
  const { w: W, h: H } = size.value
  ctx.clearRect(0, 0, W, H)
  if (image.value) ctx.drawImage(image.value, 0, 0, W, H)
  else { ctx.fillStyle = '#26303a'; ctx.fillRect(0, 0, W, H) }
  const pending = drag.value ? dragShape(drag.value) : null
  for (const shape of [...shapes.value, ...(pending ? [pending] : [])]) {
    trace(ctx, shape)
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fill()
    ctx.strokeStyle = '#ffd27a'
    ctx.lineWidth = 2
    ctx.stroke()
  }
  if (points.value.length) {
    ctx.beginPath()
    points.value.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)))
    ctx.strokeStyle = '#ffd27a'
    ctx.lineWidth = 2
    ctx.stroke()
    for (const [x, y] of points.value) { ctx.fillStyle = '#ffd27a'; ctx.fillRect(x * W - 3, y * H - 3, 6, 6) }
  }
}

function save(): void {
  emit('save', { label: label.value.trim() || 'outline', shapes: shapes.value, feather_px: feather.value })
}

function load(): void {
  const img = new Image()
  img.onload = () => {
    image.value = img
    // Drawn at the picture's own shape, 640 wide on screen; the shapes are fractions of it.
    size.value = { w: 640, h: Math.round(640 * img.naturalHeight / Math.max(1, img.naturalWidth)) }
    requestAnimationFrame(draw)
  }
  img.onerror = () => { image.value = null; draw() }
  img.src = props.imageUrl
}

watch(() => props.imageUrl, () => { clear(); load() })
onMounted(load)
</script>

<style scoped>
.od { display: grid; gap: 8px; }
.od-tools, .od-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.od-canvas { width: 100%; max-width: 640px; height: auto; border-radius: 6px; cursor: crosshair; background: #26303a; }
.od-row label { display: inline-flex; gap: 6px; align-items: center; }
</style>
