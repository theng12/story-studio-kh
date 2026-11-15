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
          <p class="text-muted tte-subtitle"><span class="tte-pill tte-pill-fork">new template</span> saved as one of your own templates</p>
        </template>
        <template v-else>
          <h3 class="tte-title">{{ workingTemplate?.name || 'Loading…' }}</h3>
          <p class="text-muted tte-subtitle">
            <span v-if="isFork" class="tte-pill tte-pill-fork">your copy</span>
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
          :disabled="!dirty || saving || shellBusy"
          title="Save writes the whole template, so it waits while a picture analysis owns it."
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>

    <p v-if="willFork" class="tte-fork-warn">
      <strong>This is a built-in template.</strong>
      Saving makes your own copy of it; the built-in stays as it is. Later edits change your copy.
    </p>

    <!-- Shell picture + layout note — the template's saved Shell fields. The
         picture is previewed through preview.png; shellImage is filesystem
         metadata and is never put in a browser URL. -->
    <div v-if="workingTemplate" class="tte-shell" data-testid="tte-shell-section">
      <div class="tte-shell-head">
        <strong>Shell picture</strong>
        <span class="text-muted tte-props-hint">
          {{ workingTemplate.shellImage ? 'Saved with this template.' : 'Optional — a picture the image model follows for layout.' }}
        </span>
      </div>
      <div class="tte-shell-row">
        <div class="tte-shell-thumb">
          <img
            v-if="shellThumbSrc && !shellPreviewFailed"
            :src="shellThumbSrc"
            alt="Shell picture preview"
            class="tte-shell-img"
            data-testid="tte-shell-preview"
            @error="shellPreviewFailed = true"
          />
          <span v-else-if="shellPreviewFailed" class="tte-shell-empty">{{ workingTemplate?.shellImage ? 'Shell image unavailable' : 'Preview unavailable' }}</span>
          <span v-else class="tte-shell-empty" data-testid="tte-shell-pending">Preview pending</span>
        </div>
        <div class="tte-shell-controls">
          <div class="tte-prop">
            <span class="tte-prop-label">Vision model (read live; used once, when a picture is analysed)</span>
            <ModelMenu
              v-model="visionModelId"
              :options="visionModelMenuOptions"
              media-type="llm"
              title="Shell picture analysis model"
              search-placeholder="Search vision models…"
              loading-label="Loading vision models…"
              :loading="visionLoading"
              :disabled="shellBusy"
              :catalogue-error="visionError"
              data-testid="tte-vision-model"
            />
          </div>
          <p v-if="visionError" class="tte-shell-error" data-testid="tte-vision-error">{{ visionError }}</p>
          <button
            v-if="visionError"
            type="button"
            class="btn btn-sm btn-ghost"
            data-testid="tte-vision-retry"
            :disabled="visionLoading"
            @click="loadVisionModels"
          >
            {{ visionLoading ? 'Checking vision models…' : 'Retry Vision Models' }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="shellBusy || saving || !visionModelId"
            data-testid="tte-shell-choose"
            @click="chooseShellPicture"
          >
            {{ shellBusy ? 'Analysing…' : (workingTemplate.shellImage ? 'Replace picture' : 'Add picture') }}
          </button>
          <span v-if="shellBusy" class="text-muted tte-props-hint">Reading the picture once and writing the layout note.</span>
        </div>
      </div>
      <label class="tte-prop">
        <span class="tte-prop-label">Layout note</span>
        <textarea
          v-model="workingTemplate.layoutNote"
          class="input tte-note"
          rows="4"
          maxlength="4000"
          placeholder="What this layout keeps: zones, framing, hierarchy, text placement."
          data-testid="tte-layout-note"
        ></textarea>
        <span class="tte-prop-hint">
          {{ (workingTemplate.layoutNote || '').length }} / 4000 · saved with the template; editing it never re-runs the analysis.
        </span>
      </label>
    </div>

    <!-- Live preview: the browser draws the SAME overlay SVG the server -->
    <!-- renders (contracts/thumbnail-overlay.ts), over the placeholder or -->
    <!-- the Shell's own picture, so it updates as you edit — no save needed. -->
    <p v-if="workingTemplate" class="tte-text-scope-note" data-testid="tte-text-scope-note">
      <strong>These text settings only shape this template's gallery preview card.</strong>
      Real thumbnails get their headline from the image model, not from these settings.
    </p>
    <p v-if="workingTemplate" class="text-muted tte-preview-note">
      <strong>Preview</strong> — the gallery card may differ slightly. Line breaks, positions, sizes and colours are worked out
      the same way as the card, but your browser draws the letter shapes.
      Drag a box to move its text.
    </p>
    <div v-if="workingTemplate" class="tte-canvas-wrap" :style="canvasWrapStyle">
      <img :src="canvasBgSrc" alt="" class="tte-canvas-bg" draggable="false" />
      <img
        :src="overlaySrc"
        :alt="`${workingTemplate.name} live preview`"
        class="tte-canvas-bg"
        draggable="false"
        data-testid="tte-live-preview"
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
    <p v-if="workingTemplate && !(workingTemplate.textZones || []).length" class="text-muted tte-props-hint">
      This template has no text layers to edit.
    </p>
    <div v-if="workingTemplate && selectedZone" class="tte-props">
      <div class="tte-props-head">
        <strong>{{ selectedZone.name }} zone</strong>
        <span class="text-muted tte-props-hint">
          Use arrow keys for ±1px nudges. Shift-arrow for ±10px.
        </span>
      </div>
      <div class="tte-props-grid">
        <label v-if="zoneShowsTitle(selectedZone)" class="tte-prop tte-prop-wide">
          <span class="tte-prop-label">Sample title</span>
          <input v-model="sampleTitle" type="text" class="input" maxlength="200" data-testid="tte-sample-title" />
          <span class="tte-prop-hint">Preview only — each episode puts its own title here.</span>
        </label>
        <label v-else class="tte-prop tte-prop-wide">
          <span class="tte-prop-label">Text</span>
          <input
            type="text"
            class="input"
            maxlength="200"
            :value="selectedZone.defaultText ?? ''"
            @input="updateZone({ defaultText: ($event.target as HTMLInputElement).value })"
          />
          <span class="tte-prop-hint">Saved with the template. Leave empty to hide this layer.</span>
        </label>
        <label class="tte-prop tte-prop-wide">
          <span class="tte-prop-label">Font</span>
          <FontPicker
            :model-value="selectedZone.fontFamily"
            :options="fontOptions"
            title="Choose a font"
            :sample="zoneSample"
            @select="value => updateZone({ fontFamily: value })"
          />
          <span class="tte-prop-hint">Fonts every Mac has, so the saved thumbnail can use them too.</span>
        </label>
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
 *
 * Live preview: the overlay SVG comes from `@shared/thumbnail-overlay`, the
 * same builder the server's template preview uses, so every edit shows at once.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { thumbnailVisionModelMenuOption, type ThumbnailVisionModel } from '~/utils/thumbnail-vision-model-menu'
import {
  buildOverlaySvg,
  layoutTextZone,
  previewOverlayText,
  THUMBNAIL_PLACEHOLDER_SVG,
} from '@shared/thumbnail-overlay'

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
  /** Managed relative asset reference (`shell/…`) — filesystem metadata,
   *  never a browser URL; previewed through /preview.png. */
  shellImage?: string
  /** Saved layout note, <= 4000 chars. A shell image needs a non-empty one. */
  layoutNote?: string
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
const sampleTitle = ref('Your title here')

// Shell picture + layout note state. `savedId` holds the real id this editor
// session writes to once a new template exists or an analysis forked the
// source (see `targetId` below).
const savedId = ref('')
const previewKey = ref(Date.now())
const shellPreviewFailed = ref(false)
const shellBusy = ref(false)
const visionModels = ref<ThumbnailVisionModel[]>([])
const visionModelMenuOptions = computed(() => visionModels.value.map(model => {
  const option = thumbnailVisionModelMenuOption(model)
  // Owner, 2026-11-06: owner-facing menus carry no cost annotation. Opt in to
  // the shared row's identity, queue shelf and retirement facts only.
  return { id: option.id, label: option.label, group: option.group, groupNote: option.groupNote, meta: option.meta, badges: option.badges }
}))
const visionLoading = ref(false)
const visionError = ref('')
const visionModelId = ref('')

/** Mac system fonts (the composer resolves font-family through the OS). */
const FONT_CHOICES = [
  { label: 'Impact (tall, bold)', value: "Impact, 'Arial Black', 'Helvetica Neue', sans-serif" },
  { label: 'Arial Black (heavy, wide)', value: "'Arial Black', Arial, sans-serif" },
  { label: 'Helvetica Neue (clean)', value: "'Helvetica Neue', Arial, sans-serif" },
  { label: 'Arial (plain)', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia (classic serif)', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Times New Roman (book serif)', value: "'Times New Roman', Times, serif" },
]

const svgSrc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
const placeholderSrc = svgSrc(THUMBNAIL_PLACEHOLDER_SVG)
const previewText = computed(() => previewOverlayText(sampleTitle.value))
// An <img> data URL, never injected markup: template strings cannot run as code.
const overlaySrc = computed(() => workingTemplate.value ? svgSrc(buildOverlaySvg(workingTemplate.value, previewText.value)) : '')

/** The zone that shows the episode title — its text is a preview-only sample. */
function zoneShowsTitle(zone: TextZone) {
  return zone.name === 'title' || /\{episode_title\}/.test(zone.defaultText || '')
}

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

const isFork = computed(() => workingTemplate.value && !workingTemplate.value.builtin)
const willFork = computed(() => workingTemplate.value && workingTemplate.value.builtin)

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
    layoutNote: '',
  }
}

// ── Shell picture + layout note ─────────────────────────────────────────────

/**
 * The real id this session saves to: a new template created here, or the id
 * an analysis returned (analysing a built-in source forks it server-side and
 * the response template.id differs). The parent's `saved` handler CLOSES the
 * editor, so the id is tracked here instead of being emitted mid-flow.
 */
const targetId = computed(() => savedId.value || props.templateId)

/** preview.png serves the Shell's own picture when one is declared — the
 *  browser never sees the raw `shellImage` path (filesystem metadata). */
const shellPreviewSrc = computed(() => {
  const t = workingTemplate.value
  if (!t?.shellImage) return ''
  return `/api/thumbnail-templates/${encodeURIComponent(t.id)}/preview.png?k=${previewKey.value}`
})
/** The small Shell thumb asks the endpoint even with no stored picture: a
 *  text-only template previews its layout and typography over the placeholder
 *  (a fork with no artwork shows its layout, not a grey box). An unsaved new
 *  template has no id to ask, so it keeps the pending label until it exists. */
const shellThumbSrc = computed(() => {
  const t = workingTemplate.value
  if (!t) return ''
  if (shellPreviewSrc.value) return shellPreviewSrc.value
  if (isNew.value) return ''
  return `/api/thumbnail-templates/${encodeURIComponent(t.id)}/preview.png?k=${previewKey.value}`
})
/** The canvas previews the text over the Shell's own picture when it has one,
 *  and over the placeholder while the template is text-only — the live overlay
 *  SVG is drawn on top here, so it must NOT use the composed endpoint image
 *  (that would paint the overlay twice). */
const canvasBgSrc = computed(() => (shellPreviewSrc.value && !shellPreviewFailed.value ? shellPreviewSrc.value : placeholderSrc))
watch(shellThumbSrc, () => { shellPreviewFailed.value = false })

/** Live Gateway vision choices (AGENTS §1) — read when the editor opens,
 *  never remembered past it. Only the analysis needs one. */
async function loadVisionModels() {
  visionLoading.value = true
  visionError.value = ''
  try {
    const r = await get<{ models: ThumbnailVisionModel[] }>('/thumbnail-templates/vision/models')
    visionModels.value = Array.isArray(r.models) ? r.models : []
    if (!visionModels.value.length) {
      visionError.value = 'The Gateway has published no vision model for Shell analysis right now.'
    }
  } catch (e: any) {
    visionModels.value = []
    visionError.value = e?.data?.detail || 'Could not load the Gateway vision models.'
  } finally {
    visionLoading.value = false
  }
}

/**
 * The id a picture gets analysed against. A brand-new template is created
 * first through the existing POST; the id is kept here rather than emitted,
 * because `saved` closes the editor.
 */
async function ensureSavedId(): Promise<string> {
  if (savedId.value) return savedId.value
  if (!isNew.value) return props.templateId
  if (!workingTemplate.value?.name?.trim()) {
    toastError('Give the template a name before saving.')
    throw new Error('A template name is required')
  }
  const r = await post<{ template: Template }>('/thumbnail-templates', createPayload())
  adoptSaved(r.template)
  savedJson.value = JSON.stringify(workingTemplate.value)
  return savedId.value
}

/** `id: 'new'` is this editor's sentinel, never a stored id — the server
 *  slugs a new template's id from its name. */
function createPayload(): Template {
  return { ...workingTemplate.value!, id: '' }
}

/**
 * Take a template the server just wrote as the new on-disk state. Only the
 * Shell fields are the server's: this editor's unsaved text edits stay put,
 * so `dirty` still reports them and Save still has something to write.
 */
function adoptSaved(saved: Template) {
  savedId.value = saved.id
  previewKey.value = Date.now()
  originalTemplate.value = JSON.parse(JSON.stringify(saved))
  const local = workingTemplate.value
  if (!local) return
  workingTemplate.value = {
    ...local,
    id: saved.id,
    builtin: saved.builtin,
    shellImage: saved.shellImage,
    layoutNote: saved.layoutNote,
  }
}

/**
 * Add or replace the Shell picture: pick a file (native dialog, or the
 * in-app browser picker when Story is served remotely), save first when the
 * template is brand-new, then analyse EXACTLY ONCE — the upload, its image
 * bytes and its layout note live on the template, reusable by any channel.
 * Editing the note alone never comes here.
 */
async function chooseShellPicture() {
  if (!workingTemplate.value || shellBusy.value || saving.value) return
  if (!visionModelId.value) {
    toastError('Choose a vision model before adding a picture.')
    return
  }
  // A brand-new template is saved first, so its name has to exist before the
  // picker opens — otherwise the flow stops half-way through for nothing.
  if (isNew.value && !savedId.value && !workingTemplate.value.name?.trim()) {
    toastError('Give the template a name before adding a picture.')
    return
  }
  // shellBusy covers the WHOLE operation, picker included: Save stays
  // disabled while this flow owns the template, and a rejected pick is
  // caught below instead of leaving an unhandled rejection.
  shellBusy.value = true
  try {
    const picked = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose a Shell picture',
      buttonLabel: 'Use this picture',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (!picked.path) return // picker cancelled — nothing analysed
    const id = await ensureSavedId()
    const r = await post<{ template: Template; reference: { analysis_model_name?: string } }>(
      `/thumbnail-templates/${encodeURIComponent(id)}/analyze`,
      { source_path: picked.path, model_id: visionModelId.value },
    )
    adoptSaved(r.template)
    toastSuccess(`Shell picture saved${r.reference?.analysis_model_name ? ` via ${r.reference.analysis_model_name}` : ''} — the layout note now describes it`)
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not add the Shell picture')
  } finally {
    shellBusy.value = false
  }
}

const selectedZone = computed(() => {
  const zones = workingTemplate.value?.textZones || []
  return zones[selectedIdx.value] || null
})

/**
 * The font field's list. A zone that already holds a family outside the six
 * every Mac has stays here as its own row: the value is saved with the
 * template, so it must remain visible and selectable rather than silently
 * falling back to the first row (AGENTS §4 — an episode's own value is never
 * left standing next to a list that does not contain it).
 */
const fontOptions = computed(() => {
  const current = selectedZone.value?.fontFamily
  const choices = FONT_CHOICES.map(f => ({ value: f.value, label: f.label, family: f.value }))
  if (!current || FONT_CHOICES.some(f => f.value === current)) return choices
  return [{ value: current, label: `Current: ${current}`, family: current }, ...choices]
})

/** What each face is drawn with: this zone's own words, else the preview title. */
const zoneSample = computed(() => (selectedZone.value?.defaultText || '').trim() || sampleTitle.value)

/**
 * The zone's box on the scaled canvas — the block its text occupies, from the
 * shared layout (so it sits exactly where the preview draws the text).
 */
function zoneStyle(zone: TextZone) {
  const canvas = workingTemplate.value?.canvas || { width: 1920, height: 1080 }
  const { box } = layoutTextZone(zone, canvas, previewText.value)
  return {
    left: `${box.left * SCALE.value}px`,
    top: `${box.top * SCALE.value}px`,
    width: `${box.width * SCALE.value}px`,
    height: `${box.height * SCALE.value}px`,
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
  // A picture analysis owns the template while it runs (the Save button is
  // disabled too) — saving would write the pre-analysis state back over it.
  if (shellBusy.value) return
  if (!workingTemplate.value.name?.trim()) {
    toastError('Give the template a name before saving.')
    return
  }
  // Backend rule mirrored: a Shell image is never saved without its note.
  if ((workingTemplate.value.shellImage || '').trim() && !(workingTemplate.value.layoutNote || '').trim()) {
    toastError('A Shell picture needs a layout note — say what this layout keeps.')
    return
  }
  // New template → create in the user library (server slugs the id from name).
  // A picture already created it, so the second Save writes with PUT below.
  if (isNew.value && !savedId.value) {
    saving.value = true
    try {
      const r = await post<{ template: Template }>('/thumbnail-templates', createPayload())
      adoptSaved(r.template)
      savedJson.value = JSON.stringify(workingTemplate.value)
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
    let saveId = targetId.value
    let payload = workingTemplate.value
    if (workingTemplate.value.builtin) {
      // Fork first, then PUT to the forked id.
      const forkRes = await post<{ template: Template }>(
        `/thumbnail-templates/${encodeURIComponent(targetId.value)}/fork`,
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
    savedJson.value = JSON.stringify(workingTemplate.value)
    toastSuccess(`Saved "${r.template.name}"`)
    emit('saved', r.template.id)
  } catch (e: any) {
    toastError(e?.data?.detail || 'Failed to save template')
  } finally {
    saving.value = false
  }
}

// Leaving the page with unsaved edits asks first, same as Cancel. A brand-new
// template is "dirty" from the start, so it only asks once something changed.
const savedJson = ref('')
const hasUnsavedEdits = computed(() => {
  if (!workingTemplate.value) return false
  if (savedJson.value && savedJson.value === JSON.stringify(workingTemplate.value)) return false
  if (isNew.value) return JSON.stringify(workingTemplate.value) !== JSON.stringify(blankTemplate())
  return dirty.value
})
onBeforeRouteLeave(async () => {
  if (!hasUnsavedEdits.value || saving.value) return true
  const { ask } = useConfirm()
  return ask({ title: 'Leave without saving?', message: 'Your thumbnail template changes have not been saved.', confirmLabel: 'Leave', danger: true })
})

async function cancel() {
  if (hasUnsavedEdits.value) {
    const { ask } = useConfirm()
    if (!await ask({ title: 'Discard changes?', message: 'Discard all unsaved thumbnail template changes?', confirmLabel: 'Discard', danger: true })) return
  }
  emit('cancelled')
}

watch(() => props.templateId, () => {
  selectedIdx.value = 0
  savedId.value = ''
  void load()
})

onMounted(() => {
  void load()
  void loadVisionModels()
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
  /* --surface is not a theme token (it fell back to a dark grey in light
     mode, hiding the title and zone name); use the theme's own surface. */
  background: var(--bg-secondary);
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border);
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
  background: var(--bg-tertiary);
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

.tte-text-scope-note { margin: 0 0 6px; padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-tertiary); font-size: 13px; }
.tte-preview-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.5;
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

/* Shell picture + layout note */
.tte-shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.tte-shell-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.tte-shell-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
}
.tte-shell-thumb {
  position: relative;
  flex: 0 0 auto;
  width: 200px;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}
.tte-shell-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tte-shell-empty {
  font-size: var(--font-xs);
  color: var(--text-muted, #b3b3bb);
  text-align: center;
  padding: 8px;
}
.tte-shell-controls {
  flex: 1 1 240px;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tte-shell-error {
  margin: 0;
  font-size: var(--font-xs);
  color: #f0883e;
}
.tte-note {
  font-size: 12px;
  resize: vertical;
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
  width: 100%;
  height: 100%;
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
  border-top: 1px solid var(--border);
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
.tte-prop-wide {
  grid-column: span 2;
}
.tte-prop-hint {
  font-size: var(--font-xs);
  color: var(--text-muted, #b3b3bb);
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
