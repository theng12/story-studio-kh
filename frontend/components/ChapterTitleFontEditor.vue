<template>
  <div class="ctfe">
    <!-- The choice, drawn the way it will render: a real chapter heading over the
         selected background. The browser approximates the drawtext (wrap/fit are
         measured here; the exact face is FFmpeg's to draw) — the badge below says
         so out loud, because a preview that only admits it in a comment reads as
         the render itself. -->
    <div class="ctfe-preview" :style="previewBackground">
      <p
        ref="sampleEl"
        class="ctfe-sample"
        :style="sampleStyle"
      >{{ sampleText }}</p>
      <p class="ctfe-preview-note">Approximate preview — the exact heading is drawn at render.</p>
    </div>

    <div class="ctfe-source" role="radiogroup" aria-label="Chapter title font">
      <button
        type="button"
        class="ctfe-choice"
        :class="{ 'is-active': source === 'default' }"
        role="radio"
        :aria-checked="source === 'default'"
        @click="chooseSource('default')"
      >No font — today's look</button>
      <button
        v-if="poolFaces.length"
        type="button"
        class="ctfe-choice"
        :class="{ 'is-active': source === 'pool' }"
        role="radio"
        :aria-checked="source === 'pool'"
        @click="chooseSource('pool')"
      >Channel font pool</button>
      <button
        type="button"
        class="ctfe-choice"
        :class="{ 'is-active': source === 'font' }"
        role="radio"
        :aria-checked="source === 'font'"
        @click="chooseSource('font')"
      >Choose a font</button>
    </div>

    <div v-if="source === 'pool'" class="ctfe-resolved" role="status">
      <template v-if="resolvedFace">{{ resolvedFace }} — chosen once for this episode and kept.</template>
      <template v-else>The channel pool has no face for this episode yet. Pick a font instead, or leave today's look.</template>
    </div>

    <FontPicker
      v-if="source === 'font' || picking"
      :model-value="modelValue?.font_id ?? null"
      :options="fontOptions"
      title="Choose a chapter title font"
      description="Bundled fonts, drawn in their own face. The heading must be covered by the font you pick."
      :sample="sampleText"
      @select="value => patch({ font_id: value, resolved_font_id: undefined, channel_look: false })"
    />

    <fieldset class="ctfe-appearance" :disabled="!hasFace">
      <legend>Appearance</legend>
      <label class="ctfe-field">
        <span>Colour</span>
        <input
          type="color"
          class="ctfe-color"
          :value="appearanceColor"
          :disabled="!hasFace"
          @input="patchAppearance({ color: ($event.target as HTMLInputElement).value })"
        />
        <span class="ctfe-hint">{{ hasFace ? 'Hex, as the preview shows it.' : 'Choose a font first.' }}</span>
      </label>
      <label class="ctfe-field">
        <span>Outline ({{ appearance.outline ?? 2 }} px)</span>
        <input
          type="range"
          min="0"
          max="8"
          step="1"
          :value="appearance.outline ?? 2"
          :disabled="!hasFace"
          @input="patchAppearance({ outline: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>
      <label class="ctfe-check">
        <input
          type="checkbox"
          :checked="appearance.wrap === true"
          :disabled="!hasFace"
          @change="patchAppearance({ wrap: ($event.target as HTMLInputElement).checked })"
        />
        <span>Wrap long headings to lines</span>
      </label>
      <label class="ctfe-check">
        <input
          type="checkbox"
          :checked="modelValue?.automatic_fit === true"
          :disabled="!hasFace"
          @change="patch({ automatic_fit: ($event.target as HTMLInputElement).checked })"
        />
        <span>Fit the heading to the frame</span>
      </label>
    </fieldset>

    <p v-if="error" class="ctfe-error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * The chapter-title font field, built on the ONE shared FontPicker — this is a
 * field, not a second chooser. It owns only the four decisions the backend
 * reads: no font / the channel's existing font-pool policy / an explicit face,
 * plus the appearance (colour, outline, wrap, fit) that rides with the choice.
 *
 * The preview samples a REAL chapter heading over the selected background so
 * the customer judges the choice by looking, not by reading a name (owner,
 * 2026-10-30). Selection only: nothing here writes a preset or a channel —
 * the host page owns the save path, and an episode change replaces the value
 * outright (AGENTS §4).
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ChapterTitlePresentation } from '../../electron/server/models/types'
import type { ThumbnailFont } from '@shared/thumbnail-text'
import { decideFont, type StillPostFontCursor, type StillPostFontPool } from '@shared/still-post-fonts'
import { fontsForText } from '../utils/thumbnail-text'
import { fontSampleAvailable } from '../utils/font-sample'

const props = withDefaults(defineProps<{
  /** The saved presentation. Display and selection only — the host writes it. */
  modelValue?: ChapterTitlePresentation | null
  /** A real chapter heading to sample. The host passes this episode's own text. */
  sampleText?: string
  /** The background the heading sits on (css colour or image), as the render sees it. */
  background?: string
  /** The chapter style's own colour, so "no colour override" previews as the render draws it. */
  styleColor?: string
  /** The channel's existing lettering pool. Absent = the pool option is not offered. */
  pool?: StillPostFontPool | null
  /** The pool's standing cursor; the pool decides the face, once. */
  poolCursor?: StillPostFontCursor | null
  /** Preloaded bundled fonts. Absent = fetched once on mount. */
  fonts?: ThumbnailFont[] | null
}>(), {
  modelValue: null,
  sampleText: 'Chapter One — The Quiet Harbor',
  background: '',
  styleColor: 'white',
  pool: null,
  poolCursor: null,
  fonts: null,
})

const emit = defineEmits<{ 'update:modelValue': [value: ChapterTitlePresentation | null] }>()

const loaded = ref<ThumbnailFont[]>([])
const error = ref('')
const sampleEl = ref<HTMLElement | null>(null)
const previewFontSize = ref(34)
/** True while the customer is inside "choose a font" and has not picked yet — the
 *  picker must be reachable before a font_id exists, and emitting an empty
 *  presentation would read as "no selection". */
const picking = ref(false)

const fonts = computed(() => props.fonts?.length ? props.fonts : loaded.value)
const presentation = computed(() => props.modelValue ?? null)
const appearance = computed(() => presentation.value?.appearance ?? {})

/** The face in force: the explicit pick, else the pool's resolution for this episode. */
const faceId = computed(() => presentation.value?.font_id || presentation.value?.resolved_font_id || '')
const hasFace = computed(() => !!faceId.value)
const face = computed(() => fonts.value.find(font => font.id === faceId.value) ?? null)

const source = computed<'default' | 'pool' | 'font'>(() => {
  if (presentation.value?.channel_look) return 'pool'
  if (presentation.value?.font_id) return 'font'
  return 'default'
})

const poolFaces = computed(() => (props.pool?.fonts ?? []).map(choice => choice.font_id))
const resolvedFace = computed(() => face.value?.label ?? faceId.value ?? '')

/** Options this heading can actually be drawn in — the thumbnail coverage rule, same helper.
 *  The saved face stays in the list even when this sample no longer covers it: the picker's
 *  trigger must show the chosen face's name, not a raw id the customer never picked. */
const fontOptions = computed(() => {
  const covered = fontsForText(fonts.value, props.sampleText)
  const saved = fonts.value.find(font => font.id === faceId.value)
  const list = saved && !covered.some(font => font.id === saved.id) ? [saved, ...covered] : covered
  return list.map(font => ({
    value: font.id,
    label: font.label,
    family: font.label,
  }))
})

/** `#RRGGBB`/`0xRRGGBB`/named → something css draws; the style's own colour when nothing is picked. */
const styleColorCss = computed(() => {
  const raw = String(props.styleColor || 'white').trim()
  const map: Record<string, string> = { gold: '#ffd700', white: '#ffffff', neon: '#00ffcc', minimal: 'rgba(255,255,255,0.8)' }
  if (map[raw]) return map[raw]!
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  if (/^0x[0-9a-f]{6}$/i.test(raw)) return `#${raw.slice(2)}`
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`
  return raw
})

const appearanceColor = computed(() => {
  const picked = appearance.value.color
  if (!picked) return styleColorCss.value.startsWith('#') ? styleColorCss.value : '#ffffff'
  return /^#[0-9a-f]{6}$/i.test(picked) ? picked
    : /^0x[0-9a-f]{6}$/i.test(picked) ? `#${picked.slice(2)}`
      : /^[0-9a-f]{6}$/i.test(picked) ? `#${picked}` : '#ffffff'
})

const previewBackground = computed(() => {
  const bg = String(props.background || '').trim()
  if (!bg) return { background: '#101418' }
  if (/^(https?:|data:|blob:|\/)/.test(bg) || bg.includes('.')) return { backgroundImage: `url("${bg.replace(/"/g, '%22')}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
  return { background: bg }
})

const outlinePx = computed(() => Number(appearance.value.outline ?? 2) || 0)

/**
 * The family the browser ACTUALLY draws, never the label as a guess: the same
 * measurement the shared picker uses. A face this browser cannot resolve is
 * left unset, so the preview shows the honest fallback instead of passing the
 * UI font off as the chosen face (AGENTS §6).
 */
const previewFontFamily = computed(() => {
  const family = face.value?.label
  if (!family) return undefined
  return fontSampleAvailable(family) === true ? `"${family}", sans-serif` : undefined
})

const sampleStyle = computed(() => ({
  fontFamily: previewFontFamily.value,
  color: appearanceColor.value,
  // drawtext draws the border UNDER the fill; paint-order does the same in css.
  WebkitTextStrokeWidth: outlinePx.value ? `${outlinePx.value}px` : undefined,
  WebkitTextStrokeColor: outlinePx.value ? 'rgba(0,0,0,0.6)' : undefined,
  paintOrder: outlinePx.value ? 'stroke fill' as const : undefined,
  whiteSpace: appearance.value.wrap === true ? 'pre-wrap' as const : 'nowrap' as const,
  fontSize: `${previewFontSize.value}px`,
  width: '100%',
}))

/**
 * The browser half of automatic_fit: shrink until the sample stops overflowing.
 * Approximate by nature (the browser measures its own shaping) — the exact fit
 * is the backend's bisection on the real face. Bounded loop, never below 14px.
 */
async function refitPreview(): Promise<void> {
  await nextTick()
  const el = sampleEl.value
  if (!el) return
  previewFontSize.value = 34
  if (props.modelValue?.automatic_fit !== true) return
  let guard = 40
  while (el.scrollWidth > el.clientWidth + 1 && previewFontSize.value > 14 && guard-- > 0) {
    previewFontSize.value -= 2
    await nextTick()
  }
}

function patch(partial: Partial<ChapterTitlePresentation>): void {
  const base: ChapterTitlePresentation = { ...(presentation.value ?? {}) }
  const next: ChapterTitlePresentation = { ...base, ...partial }
  if (!next.font_id && !next.channel_look && !next.resolved_font_id
    && !next.appearance?.color && next.appearance?.outline === undefined
    && next.appearance?.wrap === undefined && next.automatic_fit !== true) {
    emit('update:modelValue', null)
    return
  }
  emit('update:modelValue', next)
}

function patchAppearance(partial: NonNullable<ChapterTitlePresentation['appearance']>): void {
  patch({ appearance: { ...appearance.value, ...partial } })
}

/**
 * The source is the DELIBERATE choice: default, the channel's existing pool
 * policy, or one named face. Picking the pool resolves it once into
 * `resolved_font_id` — the render and the preview both read that stored id,
 * so retry and re-preview never re-roll the face.
 */
function chooseSource(next: 'default' | 'pool' | 'font'): void {
  picking.value = false
  if (next === 'default') {
    emit('update:modelValue', null)
    return
  }
  if (next === 'pool') {
    const chosen = props.pool ? decideFont(props.pool, props.poolCursor) : null
    patch({ channel_look: true, font_id: undefined, resolved_font_id: chosen?.font_id ?? undefined })
    return
  }
  picking.value = true
}

onMounted(async () => {
  if (props.fonts?.length) return
  try {
    const response = await fetch('/api/thumbnail-text/fonts', { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`font list failed (${response.status})`)
    loaded.value = await response.json()
    error.value = ''
  } catch (cause: any) {
    // Honest state: the list was not fetched, so no face may be chosen from it.
    error.value = `Bundled fonts could not be loaded: ${cause?.message || cause}. The font choice is unavailable until it loads.`
  }
})

watch(() => [props.sampleText, faceId.value, props.modelValue?.automatic_fit, appearance.value.wrap], refitPreview, { immediate: true })
</script>

<style scoped>
.ctfe { display: grid; gap: 12px; min-width: 0; }

.ctfe-preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 132px;
  padding: 18px 16px 36px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background-color: #101418;
  background-blend-mode: normal;
}

/* The honest label, on the preview itself: this is not the render. */
.ctfe-preview-note {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 8px;
  margin: 0;
  text-align: center;
  font-size: var(--font-xs);
  color: rgba(255, 255, 255, 0.72);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

.ctfe-sample {
  margin: 0;
  color: #fff;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0;
  text-align: center;
  overflow: hidden;
}

.ctfe-source { display: flex; flex-wrap: wrap; gap: 8px; }

.ctfe-choice {
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--font-sm);
  cursor: pointer;
}
.ctfe-choice:hover { border-color: var(--border-light); }
.ctfe-choice:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--focus-ring); }
.ctfe-choice.is-active { border-color: var(--accent); color: var(--accent); font-weight: 600; }

.ctfe-resolved { color: var(--text-muted); font-size: var(--font-sm); }

.ctfe-appearance {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 12px 14px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.ctfe-appearance legend { padding: 0 6px; font-size: var(--font-sm); font-weight: 600; color: var(--text-primary); }
.ctfe-appearance:disabled { opacity: 0.55; }

.ctfe-field { display: grid; gap: 6px; font-size: var(--font-sm); color: var(--text-primary); }
.ctfe-field > span:first-child { font-weight: 600; }
.ctfe-hint { color: var(--text-muted); font-size: var(--font-xs); }

.ctfe-color {
  width: 56px;
  height: 32px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  cursor: pointer;
}
.ctfe-color:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--focus-ring); }

.ctfe-check { display: flex; align-items: center; gap: 8px; font-size: var(--font-sm); color: var(--text-primary); cursor: pointer; }
.ctfe-check input { accent-color: var(--accent); }

.ctfe-error { margin: 0; color: var(--danger, #d9534f); font-size: var(--font-sm); }
</style>
