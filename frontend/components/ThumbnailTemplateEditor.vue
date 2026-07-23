<template>
  <div class="tte-root">
    <div class="tte-header">
      <div>
        <template v-if="isNew && workingTemplate">
          <input
            v-model="workingTemplate.name"
            class="input input-sm tte-name-input"
            placeholder="Template name (e.g. Bold Left Title)"
          />
          <input
            v-model="workingTemplate.description"
            class="input input-sm tte-desc-input"
            placeholder="Short description (optional)"
          />
          <p class="text-muted tte-subtitle"><span class="tte-pill tte-pill-fork">new template</span> saves to your library</p>
        </template>
        <template v-else>
          <h3 class="tte-title">{{ workingTemplate?.name || 'Loading…' }}</h3>
          <p class="text-muted tte-subtitle">
            <span v-if="isFork" class="tte-pill tte-pill-fork">forked copy</span>
            <code class="tte-mono">{{ workingTemplate?.id }}</code>
            <template v-if="dirty"> · <span class="tte-pill tte-pill-dirty">unsaved changes</span></template>
          </p>
        </template>
      </div>
      <div class="tte-header-actions">
        <button type="button" class="btn btn-sm btn-secondary" @click="cancel">Cancel</button>
        <button
          type="button"
          class="btn btn-sm btn-primary"
          :disabled="!dirty || saving"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>

    <p v-if="willFork" class="tte-fork-warn">
      <strong>This is a built-in template.</strong>
      Saving will fork a copy to your user library at
      <code class="tte-mono">~/Documents/Story Studio KH/.thumbnail-templates/{{ forkedId }}.json</code> —
      the original built-in stays pristine. Future edits save to the fork.
    </p>

    <!-- Canvas -->
    <div v-if="workingTemplate" class="tte-canvas-wrap" :style="canvasWrapStyle">
      <!-- Background preview image — same endpoint the gallery card uses, -->
      <!-- so the editor view matches what's saved to disk. -->
      <img
        :src="previewUrl"
        :alt="`${workingTemplate.name} canvas`"
        class="tte-canvas-bg"
        :style="canvasInnerStyle"
        draggable="false"
      />
      <!-- Draggable zones overlaid on top -->
      <div
        v-for="(zone, idx) in workingTemplate.textZones || []"
        :key="zone.name"
        class="tte-zone"
        :class="{ 'is-selected': selectedIdx === idx, 'is-dragging': draggingIdx === idx }"
        :style="zoneStyle(zone)"
        @mousedown.prevent="onZoneMouseDown($event, idx)"
        @click.stop="selectedIdx = idx"
        :title="`${zone.name} zone — drag to reposition`"
      >
        <span class="tte-zone-label">{{ zone.name }}</span>
      </div>
    </div>

    <!-- Properties panel for the selected zone -->
    <div v-if="workingTemplate && selectedZone" class="tte-props">
      <div class="tte-props-head">
        <strong>{{ selectedZone.name }} zone</strong>
        <span class="text-muted tte-props-hint">
          Use arrow keys for ±1px nudges. Shift-arrow for ±10px.
        </span>
      </div>
      <div class="tte-props-grid">
        <label class="tte-prop">
          <span class="tte-prop-label">Font size (px)</span>
          <input
            type="number"
            class="input"
            min="12" max="400" step="1"
            :value="selectedZone.fontSize"
            @input="updateZone({ fontSize: Number(($event.target as HTMLInputElement).value) || selectedZone.fontSize })"
          />
        </label>
        <label class="tte-prop">
          <span class="tte-prop-label">Max width (px)</span>
          <input
            type="number"
            class="input"
            min="100" max="1920" step="10"
            :value="selectedZone.maxWidth"
            @input="updateZone({ maxWidth: Number(($event.target as HTMLInputElement).value) || selectedZone.maxWidth })"
          />
        </label>
        <label class="tte-prop">
          <span class="tte-prop-label">Color (fill)</span>
          <input
            type="color"
            class="input tte-color"
            :value="selectedZone.fill || '#ffffff'"
            @input="updateZone({ fill: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="tte-prop">
          <span class="tte-prop-label">Letter spacing</span>
          <input
            type="number"
            class="input"
            min="0" max="40" step="1"
            :value="selectedZone.letterSpacing ?? 0"
            @input="updateZone({ letterSpacing: Number(($event.target as HTMLInputElement).value) || 0 })"
          />
        </label>
        <label class="tte-prop tte-prop-checkbox">
          <input
            type="checkbox"
            :checked="!!selectedZone.uppercase"
            @change="updateZone({ uppercase: ($event.target as HTMLInputElement).checked })"
          />
          <span>Uppercase</span>
        </label>
        <label class="tte-prop">
          <span class="tte-prop-label">Font weight</span>
          <select
            class="select"
            :value="String(selectedZone.fontWeight ?? 400)"
            @change="updateZone({ fontWeight: Number(($event.target as HTMLSelectElement).value) || 400 })"
          >
            <option value="400">400 (regular)</option>
            <option value="600">600 (semibold)</option>
            <option value="700">700 (bold)</option>
            <option value="800">800 (extra-bold)</option>
            <option value="900">900 (black)</option>
          </select>
        </label>
      </div>
      <div class="tte-props-position">
        <div>
          <span class="tte-prop-label">Position</span>
          <code class="tte-mono">
            x={{ selectedZone.x }} +{{ selectedZone.xOffset ?? 0 }},
            y={{ selectedZone.y }} +{{ selectedZone.yOffset ?? 0 }}
          </code>
        </div>
        <div v-if="livePreviewSrc" class="tte-live-preview-wrap">
          <button
            type="button"
            class="link-btn"
            :disabled="rendering"
            @click="renderLivePreview"
          >
            {{ rendering ? 'Rendering…' : '↻ Re-render preview' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Inline thumbnail-template visual editor (v1.0.108+).
 *
 * Built-in templates fork to the user library on save — the bundle
 * stays pristine. User-library templates save in place. The editor
 * supports drag-to-reposition for any textZone, plus a properties
 * panel for font size / max width / color / letter spacing / weight /
 * uppercase on the selected zone.
 *
 * Position math: zones declare `x: left|center|right` + `xOffset` and
 * `y: top|middle|bottom` + `yOffset`. Dragging the zone updates the
 * offsets while preserving the anchor (left-anchored zones stay
 * left-anchored, etc.) so the layout's intent is preserved.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'

interface TextZone {
  name: string
  x: 'left' | 'center' | 'right'
  y: 'top' | 'middle' | 'bottom'
  xOffset?: number
  yOffset?: number
  maxWidth: number
  fontFamily: string
  fontSize: number
  fontWeight?: number | string
  fill?: string
  letterSpacing?: number
  uppercase?: boolean
  defaultText?: string
  textAnchor?: 'start' | 'middle' | 'end'
  lineHeight?: number
  shadow?: { dx?: number; dy?: number; blur?: number; color?: string }
}
interface Template {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1
  tagline?: string
  recommendedNicheIds?: string[]
  aspectRatio?: '16:9' | '9:16' | '1:1'
  canvas?: { width: number; height: number }
  backgroundDimGradient?: any
  textZones?: TextZone[]
  accentStrokes?: any[]
  logoSlot?: any
}

const props = defineProps<{
  templateId: string
}>()

const emit = defineEmits<{
  /** Fired after a successful save (id is the saved id — may differ
   *  from the original templateId when a built-in was forked). */
  saved: [id: string]
  /** Fired when user cancels — parent collapses the editor. */
  cancelled: []
}>()

const { get, post, put } = useApi()
const { success: toastSuccess, error: toastError } = useToast()

const originalTemplate = ref<Template | null>(null)
const workingTemplate = ref<Template | null>(null)
const selectedIdx = ref(0)
const draggingIdx = ref(-1)
const saving = ref(false)
const rendering = ref(false)
const cacheKey = ref(Date.now())

// Canvas display: scale 1920×1080 to fit available width (max 720px)
const SCALE = computed(() => {
  const w = workingTemplate.value?.canvas?.width || 1920
  return Math.min(720, w) / w
})

const canvasWrapStyle = computed(() => {
  const w = workingTemplate.value?.canvas?.width || 1920
  const h = workingTemplate.value?.canvas?.height || 1080
  return {
    width: `${w * SCALE.value}px`,
    height: `${h * SCALE.value}px`,
  }
})

const canvasInnerStyle = computed(() => ({
  width: '100%',
  height: '100%',
}))

const isFork = computed(() => workingTemplate.value && !workingTemplate.value.builtin)
const willFork = computed(() => workingTemplate.value && workingTemplate.value.builtin)
const forkedId = computed(() =>
  props.templateId.endsWith('-custom') ? props.templateId : `${props.templateId}-custom`,
)

// v1.0.417 — creating a brand-new template (parent passes templateId='new').
const isNew = computed(() => props.templateId === 'new')

const dirty = computed(() => {
  if (!workingTemplate.value) return false
  if (isNew.value) return true   // a fresh template is always saveable
  if (!originalTemplate.value) return false
  return JSON.stringify(originalTemplate.value) !== JSON.stringify(workingTemplate.value)
})

/** A sensible blank starting point for a new template: one centered title
 *  over a full dim, plus a top-left logo slot. The user repositions/styles
 *  from here. `{episode_title}` is substituted at compose time. */
function blankTemplate(): Template {
  return {
    id: 'new',
    name: 'My Thumbnail Template',
    description: '',
    builtin: false,
    schemaVersion: 1,
    aspectRatio: '16:9',
    canvas: { width: 1920, height: 1080 },
    backgroundDimGradient: { side: 'full', coverage: 1, color: '#000000', strength: 0.45 },
    textZones: [
      {
        name: 'title',
        defaultText: '{episode_title}',
        x: 'center', y: 'middle', xOffset: 0, yOffset: 0,
        maxWidth: 1500,
        fontFamily: "Impact, 'Arial Black', 'Helvetica Neue', sans-serif",
        fontSize: 150, fontWeight: 900, fill: '#ffffff',
        letterSpacing: 2, uppercase: true, lineHeight: 1.05,
        textAnchor: 'middle',
        shadow: { dx: 0, dy: 4, blur: 20, color: '#000000' },
      },
    ],
    accentStrokes: [],
    logoSlot: { x: 'left', y: 'top', xOffset: 56, yOffset: 56, width: 132 },
  }
}

const selectedZone = computed(() => {
  const zones = workingTemplate.value?.textZones || []
  return zones[selectedIdx.value] || null
})

const previewUrl = computed(() => {
  // Use the LIVE preview URL when we have one (after a re-render);
  // otherwise fall back to the persisted preview (which reflects what's
  // on disk). The re-render path is opt-in because preview generation
  // hits the server.
  if (livePreviewSrc.value) return livePreviewSrc.value
  return `/api/thumbnail-templates/${encodeURIComponent(props.templateId)}/preview.png?k=${cacheKey.value}`
})

const livePreviewSrc = ref('')

/**
 * Convert a zone's anchor + offset to a CSS rect on the scaled canvas.
 * The "box" we draw is conceptually the zone's maxWidth × ~fontSize block.
 */
function zoneStyle(zone: TextZone) {
  const w = workingTemplate.value?.canvas?.width || 1920
  const h = workingTemplate.value?.canvas?.height || 1080
  const xOff = zone.xOffset ?? 0
  const yOff = zone.yOffset ?? 0
  // Compute the box's top-left in canvas coords. boxW = maxWidth;
  // boxH ≈ fontSize * lineHeight (use 1.1 default; we want a visible
  // hit area, not a pixel-perfect match).
  const boxW = zone.maxWidth || 600
  const boxH = (zone.fontSize || 100) * (zone.lineHeight || 1.1)
  let boxX = 0
  if (zone.x === 'left') boxX = xOff
  else if (zone.x === 'right') boxX = w - xOff - boxW
  else /* center */ boxX = (w - boxW) / 2 + xOff
  let boxY = 0
  if (zone.y === 'top') boxY = yOff
  else if (zone.y === 'bottom') boxY = h - yOff - boxH
  else /* middle */ boxY = (h - boxH) / 2 + yOff
  return {
    left: `${boxX * SCALE.value}px`,
    top: `${boxY * SCALE.value}px`,
    width: `${boxW * SCALE.value}px`,
    height: `${boxH * SCALE.value}px`,
  }
}

// ── Drag handling ────────────────────────────────────────────────────────

let dragState: { startX: number; startY: number; origXOff: number; origYOff: number; zone: TextZone } | null = null

function onZoneMouseDown(e: MouseEvent, idx: number) {
  selectedIdx.value = idx
  draggingIdx.value = idx
  const zones = workingTemplate.value?.textZones
  if (!zones) return
  const z = zones[idx]
  if (!z) return
  dragState = {
    startX: e.clientX,
    startY: e.clientY,
    origXOff: z.xOffset ?? 0,
    origYOff: z.yOffset ?? 0,
    zone: z,
  }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e: MouseEvent) {
  if (!dragState || !workingTemplate.value) return
  const dxScreen = e.clientX - dragState.startX
  const dyScreen = e.clientY - dragState.startY
  // Translate screen pixels back to canvas pixels via the SCALE factor.
  const dxCanvas = dxScreen / SCALE.value
  const dyCanvas = dyScreen / SCALE.value
  const zone = dragState.zone
  // Direction depends on the anchor: dragging a right-anchored zone
  // to the RIGHT decreases xOffset (the box moves closer to the right
  // edge → offset shrinks). Dragging a left-anchored zone to the right
  // increases xOffset. Center-anchored: drag right = +offset.
  let newX = dragState.origXOff
  if (zone.x === 'left') newX = Math.round(dragState.origXOff + dxCanvas)
  else if (zone.x === 'right') newX = Math.round(dragState.origXOff - dxCanvas)
  else /* center */ newX = Math.round(dragState.origXOff + dxCanvas)
  let newY = dragState.origYOff
  if (zone.y === 'top') newY = Math.round(dragState.origYOff + dyCanvas)
  else if (zone.y === 'bottom') newY = Math.round(dragState.origYOff - dyCanvas)
  else /* middle */ newY = Math.round(dragState.origYOff + dyCanvas)
  updateZone({ xOffset: newX, yOffset: newY })
}

function onMouseUp() {
  draggingIdx.value = -1
  dragState = null
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

// Arrow keys for fine nudges
function onKeyDown(e: KeyboardEvent) {
  if (selectedIdx.value < 0 || !selectedZone.value || !workingTemplate.value) return
  // Don't intercept arrows when an input/textarea/select is focused
  const t = e.target as HTMLElement
  if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
  const step = e.shiftKey ? 10 : 1
  let dx = 0
  let dy = 0
  if (e.key === 'ArrowLeft') dx = -step
  else if (e.key === 'ArrowRight') dx = step
  else if (e.key === 'ArrowUp') dy = -step
  else if (e.key === 'ArrowDown') dy = step
  else return
  e.preventDefault()
  const zone = selectedZone.value
  let newX = zone.xOffset ?? 0
  if (zone.x === 'left') newX += dx
  else if (zone.x === 'right') newX -= dx
  else newX += dx
  let newY = zone.yOffset ?? 0
  if (zone.y === 'top') newY += dy
  else if (zone.y === 'bottom') newY -= dy
  else newY += dy
  updateZone({ xOffset: newX, yOffset: newY })
}

// ── Mutation helpers ─────────────────────────────────────────────────────

function updateZone(patch: Partial<TextZone>) {
  if (!workingTemplate.value || !workingTemplate.value.textZones) return
  const zones = workingTemplate.value.textZones.slice()
  zones[selectedIdx.value] = { ...zones[selectedIdx.value]!, ...patch }
  workingTemplate.value = { ...workingTemplate.value, textZones: zones }
}

// ── Save / cancel / load ─────────────────────────────────────────────────

async function load() {
  // New template: start from a blank default, no fetch.
  if (isNew.value) {
    originalTemplate.value = null
    workingTemplate.value = blankTemplate()
    selectedIdx.value = 0
    return
  }
  try {
    const t = await get<Template>(`/thumbnail-templates/${encodeURIComponent(props.templateId)}`)
    originalTemplate.value = JSON.parse(JSON.stringify(t))
    workingTemplate.value = JSON.parse(JSON.stringify(t))
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not load template for editing')
  }
}

async function save() {
  if (!workingTemplate.value || !dirty.value) return
  // New template → create in the user library (server slugs the id from name).
  if (isNew.value) {
    if (!workingTemplate.value.name?.trim()) {
      toastError('Give the template a name before saving.')
      return
    }
    saving.value = true
    try {
      const r = await post<{ template: Template }>(`/thumbnail-templates`, workingTemplate.value)
      toastSuccess(`Created "${r.template.name}"`)
      emit('saved', r.template.id)
    } catch (e: any) {
      toastError(e?.data?.detail || 'Failed to create template')
    } finally {
      saving.value = false
    }
    return
  }
  saving.value = true
  try {
    let saveId = props.templateId
    let payload = workingTemplate.value
    if (workingTemplate.value.builtin) {
      // Fork first, then PUT to the forked id.
      const forkRes = await post<{ template: Template }>(
        `/thumbnail-templates/${encodeURIComponent(props.templateId)}/fork`,
        {},
      )
      saveId = forkRes.template.id
      // Carry over the working edits onto the just-forked id so the
      // PUT writes our changes (not the freshly-cloned defaults).
      payload = { ...workingTemplate.value, id: saveId, builtin: false }
    }
    const r = await put<{ template: Template }>(
      `/thumbnail-templates/${encodeURIComponent(saveId)}`,
      payload,
    )
    toastSuccess(`Saved "${r.template.name}"`)
    emit('saved', r.template.id)
  } catch (e: any) {
    toastError(e?.data?.detail || 'Failed to save template')
  } finally {
    saving.value = false
  }
}

async function cancel() {
  if (dirty.value) {
    const { ask } = useConfirm()
    if (!await ask({ title: 'Discard changes?', message: 'Discard all unsaved thumbnail template changes?', confirmLabel: 'Discard', danger: true })) return
  }
  emit('cancelled')
}

async function renderLivePreview() {
  if (!workingTemplate.value || rendering.value) return
  rendering.value = true
  try {
    // Bump the cache key so the preview URL refetches. Note: the
    // server-side preview reads what's on DISK, so unsaved changes
    // won't reflect here. Re-render is most useful AFTER save.
    cacheKey.value = Date.now()
    livePreviewSrc.value = `/api/thumbnail-templates/${encodeURIComponent(props.templateId)}/preview.png?k=${cacheKey.value}`
  } finally {
    rendering.value = false
  }
}

watch(() => props.templateId, () => {
  livePreviewSrc.value = ''
  selectedIdx.value = 0
  void load()
})

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKeyDown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})
</script>

<style scoped>
.tte-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--surface, #1e1e22);
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}
.tte-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.tte-title {
  margin: 0;
  font-size: 16px;
}
.tte-name-input {
  font-size: 15px;
  font-weight: 600;
  min-width: 320px;
  margin-bottom: 6px;
}
.tte-desc-input {
  font-size: 12px;
  min-width: 320px;
  display: block;
}
.tte-subtitle {
  margin: 4px 0 0;
  font-size: var(--font-xs);
  display: flex;
  align-items: center;
  gap: 8px;
}
.tte-header-actions {
  display: flex;
  gap: 8px;
}
.tte-mono {
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--font-xs);
}
.tte-pill {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 9px;
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tte-pill-fork {
  background: rgba(110, 168, 254, 0.18);
  color: #6ea8fe;
}
.tte-pill-dirty {
  background: rgba(245, 188, 66, 0.18);
  color: #f5bc42;
}

.tte-fork-warn {
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.5;
  background: rgba(110, 168, 254, 0.06);
  border-left: 3px solid #6ea8fe;
  border-radius: 6px;
  margin: 0;
}

/* Canvas */
.tte-canvas-wrap {
  position: relative;
  margin: 0 auto;
  background: #000;
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
.tte-canvas-bg {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
}
.tte-zone {
  position: absolute;
  border: 1.5px dashed rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.05);
  cursor: grab;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
}
.tte-zone:hover {
  border-color: rgba(110, 168, 254, 0.8);
  background: rgba(110, 168, 254, 0.10);
}
.tte-zone.is-selected {
  border: 2px solid #6ea8fe;
  background: rgba(110, 168, 254, 0.12);
}
.tte-zone.is-dragging {
  cursor: grabbing;
  border-color: #f5bc42;
}
.tte-zone-label {
  position: absolute;
  top: 2px;
  left: 4px;
  font-size: var(--font-xs);
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  padding: 1px 5px;
  border-radius: 3px;
  pointer-events: none;
}

/* Properties panel */
.tte-props {
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  padding-top: 12px;
}
.tte-props-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.tte-props-hint {
  font-size: var(--font-xs);
}
.tte-props-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px 12px;
}
.tte-prop {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tte-prop-label {
  font-size: var(--font-xs);
  color: var(--text-secondary, #b3b3bb);
}
.tte-prop input,
.tte-prop select {
  font-size: 12px;
}
.tte-prop-checkbox {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-top: 16px;
}
.tte-color {
  height: 32px;
  padding: 2px;
}
.tte-props-position {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  font-size: var(--font-xs);
}
</style>
