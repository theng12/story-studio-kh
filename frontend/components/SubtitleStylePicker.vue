<template>
  <div class="sub-style-picker">
    <!-- ── Preset gallery ────────────────────────────────────────────── -->
    <section class="ssp-gallery">
      <header class="ssp-gallery-head">
        <div>
          <strong>Caption looks</strong>
          <p class="text-muted">Sixteen built-in styles. Applying one changes the LOOK only — it never touches which subtitle file this episode burns, or whether subtitles are on.</p>
        </div>
        <button type="button" class="btn btn-sm btn-secondary" @click="galleryOpen = !galleryOpen">
          {{ galleryOpen ? 'Hide looks' : 'Show looks' }}
        </button>
      </header>
      <div v-if="galleryOpen" class="ssp-gallery-grid">
        <button
          v-for="p in BUILT_IN_SUBTITLE_PRESETS"
          :key="p.id"
          type="button"
          :class="['ssp-preset-card', appliedPresetId === p.id ? 'is-active' : '']"
          @click="applyBuiltInPreset(p)"
        >
          <span class="ssp-preset-swatch" :style="swatchStyle(p)">
            <span :style="swatchTextStyle(p)">Aa</span>
          </span>
          <span class="ssp-preset-body">
            <span class="ssp-preset-name">
              {{ p.name }}
              <span v-if="p.wordLevel" class="ssp-chip">word-by-word</span>
            </span>
            <span class="ssp-preset-desc">{{ p.description }}</span>
            <span v-if="p.approximation" class="ssp-preset-approx" :title="p.approximation">Approximation — hover for detail</span>
          </span>
        </button>
      </div>
    </section>

    <!-- ── Live preview ─────────────────────────────────────────────── -->
    <section class="ssp-preview">
      <div ref="frameEl" class="ssp-preview-frame" :style="previewFrameStyle">
        <div class="ssp-caption-layer" :style="captionLayerStyle">
          <span class="ssp-caption" :style="captionStyle">{{ cssPreviewText }}</span>
        </div>
      </div>
      <div class="ssp-preview-actions">
        <button class="btn btn-sm btn-secondary" :disabled="rendering" @click="renderExact">
          {{ rendering ? 'Rendering…' : 'Render exact preview' }}
        </button>
        <video
          v-if="exactUrl"
          :key="exactUrl"
          :src="exactUrl"
          class="ssp-exact-video"
          autoplay muted loop playsinline
        />
      </div>
      <p v-if="previewError" class="validation-msg text-sm mt-1">{{ previewError }}</p>
      <p class="text-muted ssp-note">
        The block above is a rough CSS sketch. "Render exact preview" runs the real FFmpeg burn —
        the same caption document the final video uses, at 640×360 for {{ previewDuration }} seconds.
      </p>
      <p v-if="style.word.mode !== 'off'" class="text-muted ssp-note">
        Word timing is estimated from the caption timings — Story Studio spreads each caption's
        duration across its words by length. It is close, not measured.
      </p>
    </section>

    <!-- ── Properties ───────────────────────────────────────────────── -->
    <section
      v-for="group in GROUPS"
      :key="group.id"
      class="ssp-group"
    >
      <button type="button" class="ssp-group-head" @click="toggle(group.id)">
        <span class="ssp-group-caret">{{ open[group.id] ? '▾' : '▸' }}</span>
        <span class="ssp-group-title">{{ group.label }}</span>
        <span class="ssp-group-hint">{{ group.hint }}</span>
      </button>

      <div v-if="open[group.id]" class="ssp-grid">
        <!-- Typography -->
        <template v-if="group.id === 'typography'">
          <div class="form-group">
            <label>Font family</label>
            <select :value="isCustomFont ? '__custom__' : style.typography.font_family" @change="onFontSelect(($event.target as HTMLSelectElement).value)" class="select">
              <option v-for="f in FONT_CHOICES" :key="f" :value="f">{{ f }}</option>
              <option value="__custom__">Custom…</option>
            </select>
            <input
              v-if="isCustomFont"
              :value="style.typography.font_family"
              @input="set('typography', 'font_family', ($event.target as HTMLInputElement).value)"
              class="input mt-1"
              placeholder="Any font installed on your Mac (e.g. Bebas Neue)"
            />
          </div>
          <SubtitleSliderField label="Font size" unit="px" :min="8" :max="200" :value="style.typography.font_size_px" @change="v => set('typography','font_size_px', v)" />
          <div class="form-group">
            <label>Weight &amp; case</label>
            <div class="ssp-btn-row">
              <button :class="toggleClass(style.typography.bold)" @click="set('typography','bold', !style.typography.bold)">Bold</button>
              <button :class="toggleClass(style.typography.italic)" @click="set('typography','italic', !style.typography.italic)">Italic</button>
              <button :class="toggleClass(style.typography.all_caps)" @click="set('typography','all_caps', !style.typography.all_caps)">ALL CAPS</button>
            </div>
          </div>
          <SubtitleSliderField label="Letter spacing" unit="px" :min="-20" :max="60" :value="style.typography.letter_spacing_px" @change="v => set('typography','letter_spacing_px', v)" />
          <SubtitleSliderField label="Extra line spacing" unit="px" :min="0" :max="80" :value="style.typography.line_spacing_px" @change="v => set('typography','line_spacing_px', v)"
            hint="libass has no line-spacing setting. Story Studio inserts a spacer line, so only extra space is possible." />
          <SubtitleSliderField label="Max characters per line" :min="8" :max="120" :value="style.typography.max_chars_per_line" @change="v => set('typography','max_chars_per_line', v)" />
          <SubtitleSliderField label="Max lines" :min="1" :max="6" :value="style.typography.max_lines" @change="v => set('typography','max_lines', v)"
            hint="A caption too long for this is SPLIT across its own time window, never cut short." />
          <div class="form-group">
            <label>Wrapping</label>
            <select :value="style.typography.wrap_style" @change="set('typography','wrap_style', ($event.target as HTMLSelectElement).value)" class="select">
              <option value="engine">Story Studio wraps (uses max characters)</option>
              <option value="balanced">libass, upper line wider</option>
              <option value="bottom-wider">libass, lower line wider</option>
              <option value="end-of-line">libass, break at the margin</option>
            </select>
          </div>
        </template>

        <!-- Colour -->
        <template v-if="group.id === 'color'">
          <SubtitleColorField label="Text" :hex="style.color.primary_hex" :opacity="style.color.primary_opacity"
            @hex="v => set('color','primary_hex', v)" @opacity="v => set('color','primary_opacity', v)" />
          <SubtitleColorField label="Outline" :hex="style.color.outline_hex" :opacity="style.color.outline_opacity"
            @hex="v => set('color','outline_hex', v)" @opacity="v => set('color','outline_opacity', v)" />
          <SubtitleColorField label="Shadow" :hex="style.color.shadow_hex" :opacity="style.color.shadow_opacity"
            @hex="v => set('color','shadow_hex', v)" @opacity="v => set('color','shadow_opacity', v)" />
          <SubtitleColorField label="Box / backdrop" :hex="style.color.box_hex" :opacity="style.color.box_opacity"
            @hex="v => set('color','box_hex', v)" @opacity="v => set('color','box_opacity', v)" />
          <SubtitleColorField label="Secondary (ASS)" :hex="style.color.secondary_hex ?? style.color.primary_hex" :opacity="style.color.secondary_opacity"
            @hex="v => set('color','secondary_hex', v)" @opacity="v => set('color','secondary_opacity', v)"
            hint="Written into the ASS style line. Story Studio's own word modes drive colour directly and do not read it." />
        </template>

        <!-- Box & outline -->
        <template v-if="group.id === 'box'">
          <div class="form-group">
            <label>Backdrop</label>
            <div class="ssp-btn-row">
              <button v-for="b in BOX_MODES" :key="b.id"
                :class="['btn btn-sm', style.box.mode === b.id ? 'btn-primary' : 'btn-secondary']"
                :title="b.hint"
                @click="set('box','mode', b.id)">{{ b.label }}</button>
            </div>
            <p v-if="style.box.mode === 'rounded'" class="text-muted text-xs mt-1">
              libass cannot round an opaque box. "Rounded" draws a thick soft outline in the box
              colour instead, so it hugs the letters rather than forming a rectangle.
            </p>
          </div>
          <SubtitleSliderField v-if="style.box.mode === 'semi' || style.box.mode === 'full'"
            label="Box padding" unit="px" :min="0" :max="80"
            :value="style.box.padding_px ?? style.edge.outline_px"
            @change="v => set('box','padding_px', v)"
            hint="libass reuses the outline width as box padding; set this to override it." />
          <SubtitleSliderField v-if="style.box.mode === 'rounded'" label="Corner radius" unit="px" :min="0" :max="60" :value="style.box.corner_radius_px" @change="v => set('box','corner_radius_px', v)" />
          <SubtitleSliderField label="Outline width" unit="px" :min="0" :max="40" :value="style.edge.outline_px" @change="v => set('edge','outline_px', v)" />
          <SubtitleSliderField label="Shadow depth" unit="px" :min="0" :max="40" :value="style.edge.shadow_px" @change="v => set('edge','shadow_px', v)" />
          <SubtitleSliderField label="Shadow offset X" unit="px" :min="-40" :max="40" :value="style.edge.shadow_offset_x_px" @change="v => set('edge','shadow_offset_x_px', v)" />
          <SubtitleSliderField label="Shadow offset Y" unit="px" :min="-40" :max="40" :value="style.edge.shadow_offset_y_px" @change="v => set('edge','shadow_offset_y_px', v)" />
          <SubtitleSliderField label="Edge blur" :min="0" :max="20" :value="style.edge.blur_px" @change="v => set('edge','blur_px', v)"
            hint="Softens the outline AND the shadow together — that is what libass's blur does." />
        </template>

        <!-- Placement -->
        <template v-if="group.id === 'placement'">
          <div class="form-group">
            <label>Vertical position</label>
            <div class="ssp-btn-row">
              <button v-for="p in POSITIONS" :key="p.id"
                :class="['btn btn-sm', style.placement.position === p.id ? 'btn-primary' : 'btn-secondary']"
                @click="setVerticalPosition(p.id)">{{ p.label }}</button>
            </div>
          </div>
          <div class="form-group">
            <label>Horizontal position</label>
            <div class="ssp-btn-row">
              <button v-for="a in ALIGNMENTS" :key="a.id"
                :class="['btn btn-sm', style.placement.align === a.id ? 'btn-primary' : 'btn-secondary']"
                @click="setHorizontalPosition(a.id)">{{ a.label }}</button>
            </div>
          </div>
          <SubtitleSliderField label="Frame margin" unit="px" :min="0" :max="300" :value="style.placement.margin_px" @change="v => set('placement','margin_px', v)" />
        </template>

        <!-- Cue animation -->
        <template v-if="group.id === 'animation'">
          <div class="form-group">
            <label>Caption animation</label>
            <select :value="style.animation.type" @change="setAnimationType(($event.target as HTMLSelectElement).value)" class="select">
              <option v-for="a in ANIMATIONS" :key="a.id" :value="a.id">{{ a.label }}</option>
            </select>
          </div>
          <SubtitleSliderField v-if="style.animation.type !== 'none'" label="Fade in" unit="ms" :min="0" :max="3000" :step="10" :value="style.animation.in_ms" @change="v => set('animation','in_ms', v)" />
          <SubtitleSliderField v-if="style.animation.type !== 'none'" label="Fade out" unit="ms" :min="0" :max="3000" :step="10" :value="style.animation.out_ms" @change="v => set('animation','out_ms', v)" />
          <SubtitleSliderField v-if="style.animation.type === 'pop'" label="Pop from" unit="%" :min="10" :max="200" :value="style.animation.pop_from_pct" @change="v => set('animation','pop_from_pct', v)" />
          <SubtitleSliderField v-if="style.animation.type === 'pop'" label="Pop duration" unit="ms" :min="0" :max="3000" :step="10" :value="style.animation.transform_ms" @change="v => set('animation','transform_ms', v)" />
          <SubtitleSliderField v-if="style.animation.type === 'slide-up' || style.animation.type === 'slide-down'" label="Slide distance" unit="px" :min="0" :max="400" :value="style.animation.travel_px" @change="v => set('animation','travel_px', v)" />
        </template>

        <!-- Word mode -->
        <template v-if="group.id === 'word'">
          <div class="form-group">
            <label>Word mode</label>
            <select :value="style.word.mode" @change="set('word','mode', ($event.target as HTMLSelectElement).value)" class="select">
              <option v-for="m in WORD_MODES" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
            <p class="text-muted text-xs mt-1">{{ wordModeHint }}</p>
          </div>
          <template v-if="style.word.mode !== 'off'">
            <SubtitleColorField label="Active word" :hex="style.word.active_color_hex" :opacity="style.word.active_opacity"
              @hex="v => set('word','active_color_hex', v)" @opacity="v => set('word','active_opacity', v)" />
            <SubtitleColorField v-if="style.word.mode === 'highlight' || style.word.mode === 'pop'"
              label="Resting words" :hex="style.word.inactive_color_hex ?? style.color.primary_hex" :opacity="style.word.inactive_opacity"
              @hex="v => set('word','inactive_color_hex', v)" @opacity="v => set('word','inactive_opacity', v)" />
            <SubtitleSliderField label="Transition" unit="ms" :min="0" :max="1000" :step="10" :value="style.word.transition_ms" @change="v => set('word','transition_ms', v)" />
            <div v-if="style.word.mode === 'highlight' || style.word.mode === 'pop' || style.word.mode === 'single'" class="form-group">
              <SubtitleColorField label="Active word outline"
                :hex="style.word.active_outline_hex ?? style.color.outline_hex"
                :opacity="style.word.active_outline_opacity"
                @hex="v => set('word','active_outline_hex', v)"
                @opacity="v => set('word','active_outline_opacity', v)"
                hint="Recolours the spoken word's stroke — how the Neon and accent looks get their lift." />
              <button v-if="style.word.active_outline_hex !== null" class="btn btn-sm btn-secondary mt-1"
                @click="set('word','active_outline_hex', null)">Follow the outline colour</button>
            </div>
            <SubtitleSliderField v-if="style.word.mode === 'pop'" label="Active word scale" unit="%" :min="100" :max="300" :value="style.word.active_scale_pct" @change="v => set('word','active_scale_pct', v)" />
            <div v-if="style.word.mode === 'highlight' || style.word.mode === 'pop'" class="form-group">
              <label>Highlighter block</label>
              <div class="ssp-btn-row">
                <button :class="toggleClass(style.word.highlight_box)" @click="set('word','highlight_box', !style.word.highlight_box)">
                  {{ style.word.highlight_box ? 'On' : 'Off' }}
                </button>
              </div>
              <p v-if="style.word.highlight_box" class="text-muted text-xs mt-1">
                libass has no per-word background. The block is a thick soft outline in the
                highlight colour, so it follows the shape of the letters.
              </p>
            </div>
            <SubtitleColorField v-if="style.word.highlight_box" label="Block colour" :hex="style.word.highlight_box_hex" :opacity="style.word.highlight_box_opacity"
              @hex="v => set('word','highlight_box_hex', v)" @opacity="v => set('word','highlight_box_opacity', v)" />
            <SubtitleSliderField v-if="style.word.highlight_box" label="Block thickness" unit="px" :min="0" :max="60" :value="style.word.highlight_box_px" @change="v => set('word','highlight_box_px', v)" />
          </template>
        </template>
      </div>
    </section>

    <!-- ── Precise placement pad ────────────────────────────────────── -->
    <section class="ssp-placement-panel">
      <div class="ssp-placement-heading">
        <div>
          <strong>Precise safe-area position</strong>
          <p class="text-muted">Drag the caption inside the closed box. The protected edge keeps its anchor away from cropping and player controls.</p>
        </div>
        <button type="button" class="btn btn-sm btn-secondary" @click="resetPlacement">Bottom centre</button>
      </div>
      <div
        ref="placementPadEl"
        class="ssp-placement-pad"
        role="application"
        aria-label="Subtitle position control"
        @pointerdown="startPlacementDrag"
        @pointermove="movePlacementDrag"
        @pointerup="stopPlacementDrag"
        @pointercancel="stopPlacementDrag"
      >
        <div class="ssp-safe-boundary" :style="safeBoundaryStyle" />
        <div class="ssp-placement-crosshair ssp-crosshair-x" :style="{ top: `${positionY}%` }" />
        <div class="ssp-placement-crosshair ssp-crosshair-y" :style="{ left: `${positionX}%` }" />
        <div class="ssp-placement-caption" :style="placementCaptionStyle">Subtitle</div>
      </div>
      <div class="ssp-placement-values">
        <label>
          Horizontal ({{ positionX.toFixed(1) }}%)
          <input type="range" :min="safeMargin" :max="100 - safeMargin" step="0.5" :value="positionX" @input="setPlacementAxis('x', Number(($event.target as HTMLInputElement).value))" />
        </label>
        <label>
          Vertical ({{ positionY.toFixed(1) }}%)
          <input type="range" :min="safeMargin" :max="100 - safeMargin" step="0.5" :value="positionY" @input="setPlacementAxis('y', Number(($event.target as HTMLInputElement).value))" />
        </label>
        <label>
          Safe edge ({{ safeMargin.toFixed(0) }}%)
          <input type="range" min="5" max="20" step="1" :value="safeMargin" @input="setSafeMargin(Number(($event.target as HTMLInputElement).value))" />
        </label>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * The caption properties panel.
 *
 * Every field in the shared style schema is controllable here — the schema is
 * the contract, this is its whole surface. Grouped and collapsed because the
 * panel sits inside an already-long wizard step and would otherwise bury it.
 *
 * Two boundaries this component must respect:
 *
 *  1. It emits STYLE and nothing else. Applying a built-in look must never
 *     touch `enabled`, `source`, `srt_path` or `hide_during_intro` — see the
 *     Preset Boundaries section of AGENTS.md and the three shipped defects it
 *     lists. `subtitlePresetBoundary.test.ts` holds that line.
 *  2. It never re-implements the renderer. The CSS block is an admitted
 *     sketch; "Render exact preview" asks the backend for the real ASS burn.
 */
import {
  defaultSubtitleStyle,
  mergeSubtitleStyle,
  normalizeSubtitleStyle,
  type SubtitleStyleDocument,
} from '@shared/subtitle-style'
import { BUILT_IN_SUBTITLE_PRESETS, type BuiltInSubtitlePreset } from '@shared/subtitle-presets'

const props = defineProps<{
  slug: string
  episodeId?: string
  style: SubtitleStyleDocument
  backdropUrl?: string
  sampleText: string
}>()

const emit = defineEmits<{ 'update:style': [style: SubtitleStyleDocument] }>()

const FONT_CHOICES = [
  'Helvetica', 'Helvetica Neue', 'Arial', 'Arial Black', 'Avenir', 'Avenir Next',
  'Futura', 'Gill Sans', 'Optima', 'Georgia', 'Times New Roman', 'Palatino',
  'Baskerville', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Menlo',
  'Impact', 'American Typewriter', 'Marker Felt', 'Chalkboard SE', 'Comic Sans MS',
]
const CUSTOM_FONT = '__custom__'

const GROUPS = [
  { id: 'typography', label: 'Typography', hint: 'Face, size, case, wrapping' },
  { id: 'color', label: 'Colour', hint: 'Text, outline, shadow, backdrop' },
  { id: 'box', label: 'Box & outline', hint: 'Backdrop, stroke, shadow, blur' },
  { id: 'placement', label: 'Placement', hint: 'Anchor and frame margins' },
  { id: 'animation', label: 'Caption animation', hint: 'How each line enters and leaves' },
  { id: 'word', label: 'Word by word', hint: 'Highlight, pop, reveal, single, typewriter' },
] as const

const BOX_MODES = [
  { id: 'none', label: 'None', hint: 'No backdrop' },
  { id: 'semi', label: 'Semi', hint: 'Translucent panel' },
  { id: 'full', label: 'Full', hint: 'Opaque panel' },
  { id: 'rounded', label: 'Rounded', hint: 'Soft blob hugging the letters (approximation)' },
] as const

const POSITIONS = [
  { id: 'top', label: 'Top' }, { id: 'center', label: 'Center' }, { id: 'bottom', label: 'Bottom' },
] as const
const ALIGNMENTS = [
  { id: 'left', label: 'Left' }, { id: 'center', label: 'Center' }, { id: 'right', label: 'Right' },
] as const
const ANIMATIONS = [
  { id: 'none', label: 'None (static)' },
  { id: 'fade', label: 'Fade in / out' },
  { id: 'pop', label: 'Pop in' },
  { id: 'slide-up', label: 'Slide up' },
  { id: 'slide-down', label: 'Slide down' },
] as const
const WORD_MODES = [
  { id: 'off', label: 'Off — whole caption at once' },
  { id: 'highlight', label: 'Highlight — active word swaps colour' },
  { id: 'pop', label: 'Pop — active word swaps colour and grows' },
  { id: 'reveal', label: 'Reveal — words appear and stay' },
  { id: 'single', label: 'Single — one word at a time' },
  { id: 'typewriter', label: 'Typewriter — instant, word by word' },
] as const

const WORD_MODE_HINTS: Record<string, string> = {
  off: 'The whole caption appears at once. No per-word timing is used.',
  highlight: 'Every word stays visible; the spoken one changes colour and changes back.',
  pop: 'As Highlight, and the spoken word also scales up and settles.',
  reveal: 'Words fade in one at a time and remain on screen.',
  single: 'Only the current word is on screen. Best very large and centred.',
  typewriter: 'Words appear instantly, one after another. Reveals whole words — Story Studio has no per-character timing.',
}
const wordModeHint = computed(() => WORD_MODE_HINTS[props.style.word.mode] || '')

const galleryOpen = ref(true)
const open = reactive<Record<string, boolean>>({
  typography: true, color: false, box: false, placement: false, animation: false, word: false,
})
function toggle(id: string) { open[id] = !open[id] }

function toggleClass(active: boolean) {
  return ['btn', 'btn-sm', active ? 'btn-primary' : 'btn-secondary']
}

const isCustomFont = computed(() => {
  const f = props.style.typography.font_family
  return f != null && !FONT_CHOICES.includes(f)
})
function onFontSelect(value: string) {
  if (value === CUSTOM_FONT) {
    if (!isCustomFont.value) set('typography', 'font_family', '')
  } else {
    set('typography', 'font_family', value)
  }
}

/** Every edit funnels through the shared normaliser, so the panel can never
 *  emit a value the renderer would have to defend against. */
function set(group: keyof Omit<SubtitleStyleDocument, 'schema_version'>, key: string, value: any) {
  emit('update:style', mergeSubtitleStyle(props.style, { [group]: { [key]: value } } as any))
}

function setAnimationType(type: string) {
  // Switching animation resets its timings to that animation's own defaults,
  // which is what the shared normaliser does when in_ms/out_ms are absent.
  emit('update:style', normalizeSubtitleStyle({
    ...props.style,
    animation: { type },
  }))
}

/**
 * Apply a built-in look. STYLE ONLY — this emits a style document and has no
 * access to anything episode-specific, which is the structural version of the
 * Preset Boundaries rule rather than a promise to remember it.
 */
const appliedPresetId = ref('')
function applyBuiltInPreset(p: BuiltInSubtitlePreset) {
  appliedPresetId.value = p.id
  emit('update:style', normalizeSubtitleStyle(p.style))
}

// ── Placement pad ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const safeMargin = computed(() => clamp(Number(props.style.placement.safe_margin_pct) || 8, 5, 20))
const positionX = computed(() => clamp(
  props.style.placement.position_x_pct ?? (props.style.placement.align === 'left' ? safeMargin.value : props.style.placement.align === 'right' ? 100 - safeMargin.value : 50),
  safeMargin.value, 100 - safeMargin.value,
))
const positionY = computed(() => clamp(
  props.style.placement.position_y_pct ?? (props.style.placement.position === 'top' ? safeMargin.value : props.style.placement.position === 'center' ? 50 : 100 - safeMargin.value),
  safeMargin.value, 100 - safeMargin.value,
))

function horizontalAnchor(x: number) { return x <= 33 ? 'left' : x >= 67 ? 'right' : 'center' }
function verticalAnchor(y: number) { return y <= 33 ? 'top' : y >= 67 ? 'bottom' : 'center' }

function setPlacement(x: number, y: number, margin = safeMargin.value) {
  const safe = clamp(margin, 5, 20)
  const nextX = clamp(x, safe, 100 - safe)
  const nextY = clamp(y, safe, 100 - safe)
  emit('update:style', mergeSubtitleStyle(props.style, {
    placement: {
      position_x_pct: nextX,
      position_y_pct: nextY,
      safe_margin_pct: safe,
      align: horizontalAnchor(nextX) as any,
      position: verticalAnchor(nextY) as any,
    },
  }))
}

function setHorizontalPosition(align: 'left' | 'center' | 'right') {
  setPlacement(align === 'left' ? safeMargin.value : align === 'right' ? 100 - safeMargin.value : 50, positionY.value)
}
function setVerticalPosition(position: 'top' | 'center' | 'bottom') {
  setPlacement(positionX.value, position === 'top' ? safeMargin.value : position === 'bottom' ? 100 - safeMargin.value : 50)
}
function setPlacementAxis(axis: 'x' | 'y', value: number) {
  setPlacement(axis === 'x' ? value : positionX.value, axis === 'y' ? value : positionY.value)
}
function setSafeMargin(value: number) { setPlacement(positionX.value, positionY.value, value) }
function resetPlacement() { setPlacement(50, 100 - safeMargin.value) }

const placementPadEl = ref<HTMLElement | null>(null)
const placementDragging = ref(false)
function placementFromPointer(event: PointerEvent) {
  const rect = placementPadEl.value?.getBoundingClientRect()
  if (!rect?.width || !rect.height) return
  setPlacement(((event.clientX - rect.left) / rect.width) * 100, ((event.clientY - rect.top) / rect.height) * 100)
}
function startPlacementDrag(event: PointerEvent) {
  placementDragging.value = true
  placementPadEl.value?.setPointerCapture(event.pointerId)
  placementFromPointer(event)
}
function movePlacementDrag(event: PointerEvent) { if (placementDragging.value) placementFromPointer(event) }
function stopPlacementDrag(event: PointerEvent) {
  placementDragging.value = false
  if (placementPadEl.value?.hasPointerCapture(event.pointerId)) placementPadEl.value.releasePointerCapture(event.pointerId)
}

const safeBoundaryStyle = computed(() => ({ inset: `${safeMargin.value}%` }))
const placementCaptionStyle = computed(() => {
  const x = positionX.value, y = positionY.value
  const tx = x <= 33 ? '0%' : x >= 67 ? '-100%' : '-50%'
  const ty = y <= 33 ? '0%' : y >= 67 ? '-100%' : '-50%'
  return { left: `${x}%`, top: `${y}%`, transform: `translate(${tx}, ${ty})` }
})

// ── CSS sketch ─────────────────────────────────────────────────────────────

const frameEl = ref<HTMLElement | null>(null)
const frameHeight = ref(360)
let frameRO: ResizeObserver | null = null
onMounted(() => {
  if (frameEl.value) {
    frameHeight.value = frameEl.value.clientHeight || 360
    frameRO = new ResizeObserver(() => { frameHeight.value = frameEl.value?.clientHeight || frameHeight.value })
    frameRO.observe(frameEl.value)
  }
})
onBeforeUnmount(() => { frameRO?.disconnect(); frameRO = null })

const cssPreviewText = computed(() =>
  props.style.typography.all_caps ? props.sampleText.toUpperCase() : props.sampleText)

const previewFrameStyle = computed(() => props.backdropUrl
  ? { backgroundImage: `url("${props.backdropUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
  : { background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)' })

const captionLayerStyle = computed(() => {
  if (props.style.placement.position_x_pct !== null && props.style.placement.position_y_pct !== null) {
    return { display: 'block', padding: '0' }
  }
  const justify = props.style.placement.align === 'left' ? 'flex-start'
    : props.style.placement.align === 'right' ? 'flex-end' : 'center'
  const align = props.style.placement.position === 'top' ? 'flex-start'
    : props.style.placement.position === 'center' ? 'center' : 'flex-end'
  return { justifyContent: justify, alignItems: align }
})

function rgba(hex: string, opacity: number): string {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

const captionStyle = computed(() => {
  // Every px value means "px at 1080", so the sketch scales by frameHeight/1080.
  const factor = (frameHeight.value || 360) / 1080
  const t = props.style.typography
  const outline = Math.round(props.style.edge.outline_px * factor * 10) / 10
  const outlineColor = rgba(props.style.color.outline_hex, props.style.color.outline_opacity)
  const shadow: string[] = []
  if (outline > 0) {
    shadow.push(
      `-${outline}px -${outline}px 0 ${outlineColor}`,
      `${outline}px -${outline}px 0 ${outlineColor}`,
      `-${outline}px ${outline}px 0 ${outlineColor}`,
      `${outline}px ${outline}px 0 ${outlineColor}`,
    )
  }
  if (props.style.edge.shadow_px > 0) {
    const d = Math.round(props.style.edge.shadow_px * factor * 10) / 10
    const blur = Math.round(props.style.edge.blur_px * factor * 10) / 10
    shadow.push(`${d}px ${d}px ${blur}px ${rgba(props.style.color.shadow_hex, props.style.color.shadow_opacity)}`)
  }

  const boxed = props.style.box.mode === 'semi' || props.style.box.mode === 'full'
  const result: Record<string, string> = {
    fontFamily: t.font_family,
    fontSize: `${Math.round(t.font_size_px * factor)}px`,
    fontWeight: t.bold ? '700' : '400',
    fontStyle: t.italic ? 'italic' : 'normal',
    letterSpacing: `${Math.round(t.letter_spacing_px * factor * 10) / 10}px`,
    color: rgba(props.style.color.primary_hex, props.style.color.primary_opacity),
    textShadow: shadow.length ? shadow.join(',') : 'none',
    background: boxed ? rgba(props.style.color.box_hex, props.style.color.box_opacity) : 'transparent',
    padding: boxed ? '4px 10px' : '0',
    borderRadius: props.style.box.mode === 'rounded' ? '999px' : '3px',
    maxWidth: `${100 - safeMargin.value * 2}%`,
    whiteSpace: 'normal',
    lineHeight: `${1.3 + props.style.typography.line_spacing_px / 100}`,
    textAlign: props.style.placement.align,
    display: 'inline-block',
  }
  if (props.style.placement.position_x_pct !== null && props.style.placement.position_y_pct !== null) {
    const x = positionX.value, y = positionY.value
    const tx = x <= 33 ? '0%' : x >= 67 ? '-100%' : '-50%'
    const ty = y <= 33 ? '0%' : y >= 67 ? '-100%' : '-50%'
    const availableWidth = x <= 33 ? 100 - safeMargin.value - x
      : x >= 67 ? x - safeMargin.value
      : 2 * Math.min(x - safeMargin.value, 100 - safeMargin.value - x)
    result.position = 'absolute'
    result.left = `${x}%`
    result.top = `${y}%`
    result.transform = `translate(${tx}, ${ty})`
    result.maxWidth = `${Math.max(20, availableWidth)}%`
  }
  return result
})

function swatchStyle(p: BuiltInSubtitlePreset) {
  const boxed = p.style.box.mode === 'semi' || p.style.box.mode === 'full'
  return {
    background: boxed ? rgba(p.style.color.box_hex, p.style.color.box_opacity) : 'linear-gradient(135deg, #1a1a2e, #16213e)',
  }
}
function swatchTextStyle(p: BuiltInSubtitlePreset) {
  const active = p.style.word.mode !== 'off' ? p.style.word.active_color_hex : p.style.color.primary_hex
  return {
    fontFamily: p.style.typography.font_family,
    fontWeight: p.style.typography.bold ? '700' : '400',
    fontStyle: p.style.typography.italic ? 'italic' : 'normal',
    color: active,
    textShadow: p.style.edge.outline_px > 0 ? `0 0 3px ${p.style.color.outline_hex}, 0 0 1px ${p.style.color.outline_hex}` : 'none',
  }
}

// ── Exact render ───────────────────────────────────────────────────────────

const { post } = useApi()
const rendering = ref(false)
const exactUrl = ref<string | null>(null)
const previewError = ref('')
const previewDuration = ref(4)

async function renderExact() {
  if (rendering.value) return
  rendering.value = true
  previewError.value = ''
  try {
    // POST, not a querystring: the style document is far past what a URL can
    // carry. The response hands back a cache token the <video> can GET.
    const res = await post<{ url: string; duration_sec: number }>(
      `/projects/${props.slug}/video-editor/preview-subtitles`,
      {
        style: props.style,
        text: props.sampleText,
        ...(props.episodeId ? { episode: props.episodeId } : {}),
      },
    )
    previewDuration.value = res.duration_sec || 4
    exactUrl.value = res.url
  } catch (e: any) {
    exactUrl.value = null
    previewError.value = e?.data?.detail || e?.message || 'Subtitle preview failed'
  } finally {
    rendering.value = false
  }
}

defineExpose({ defaultSubtitleStyle })
</script>

<style scoped>
.sub-style-picker { display: flex; flex-direction: column; gap: 12px; }

.ssp-gallery {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: color-mix(in srgb, var(--bg-tertiary) 88%, transparent);
}
.ssp-gallery-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ssp-gallery-head p { margin: 3px 0 0; font-size: 12px; max-width: 60ch; }
.ssp-gallery-grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px;
  max-height: 340px;
  overflow-y: auto;
}
.ssp-preset-card {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  text-align: left;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  cursor: pointer;
}
.ssp-preset-card:hover { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.ssp-preset-card.is-active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.ssp-preset-swatch {
  flex: 0 0 46px;
  height: 34px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  font-size: 15px;
  overflow: hidden;
}
.ssp-preset-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ssp-preset-name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ssp-preset-desc { font-size: var(--font-xs); color: var(--text-secondary); }
.ssp-preset-approx { font-size: var(--font-xs); color: var(--text-secondary); font-style: italic; }
.ssp-chip {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 25%, transparent);
}

.ssp-group { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.ssp-group-head {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--bg-tertiary) 88%, transparent);
  border: 0;
  cursor: pointer;
  text-align: left;
}
.ssp-group-caret { color: var(--text-secondary); font-size: var(--font-xs); }
.ssp-group-title { font-weight: 600; font-size: 13px; }
.ssp-group-hint { font-size: var(--font-xs); color: var(--text-secondary); }

.ssp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
  padding: 12px;
}

.ssp-btn-row { display: flex; gap: 4px; flex-wrap: wrap; }

.ssp-placement-panel {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-tertiary) 88%, transparent);
}
.ssp-placement-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.ssp-placement-heading p { margin: 3px 0 0; font-size: 12px; }
.ssp-placement-pad {
  width: 100%;
  max-width: 640px;
  aspect-ratio: 16 / 9;
  position: relative;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--accent) 60%, var(--border));
  border-radius: 8px;
  background:
    linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px),
    linear-gradient(145deg, #111827, #26354a);
  background-size: 10% 10%, 10% 10%, auto;
  cursor: crosshair;
  touch-action: none;
  user-select: none;
}
.ssp-safe-boundary {
  position: absolute;
  border: 2px solid rgba(240, 198, 116, 0.8);
  border-radius: 5px;
  box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.18);
  pointer-events: none;
}
.ssp-placement-crosshair { position: absolute; pointer-events: none; opacity: 0.24; }
.ssp-crosshair-x { left: 0; right: 0; height: 1px; background: var(--accent); }
.ssp-crosshair-y { top: 0; bottom: 0; width: 1px; background: var(--accent); }
.ssp-placement-caption {
  position: absolute;
  z-index: 2;
  max-width: 70%;
  padding: 5px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.72);
  border: 1px solid rgba(255,255,255,0.72);
  color: white;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  pointer-events: none;
}
.ssp-placement-values { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 10px; }
.ssp-placement-values label { display: grid; gap: 4px; font-size: 12px; color: var(--text-secondary); }
.ssp-placement-values input { width: 100%; }

.ssp-preview-frame {
  width: 100%;
  max-width: 640px;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  border: 1px solid var(--border);
  position: relative;
  overflow: hidden;
}
.ssp-caption-layer { position: absolute; inset: 0; display: flex; padding: 16px; }
.ssp-preview-actions { display: flex; gap: 10px; margin-top: 8px; align-items: flex-start; flex-wrap: wrap; }
.ssp-exact-video {
  max-width: 320px;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #000;
}
.ssp-note { font-size: var(--font-xs); margin-top: 4px; max-width: 78ch; }

@media (max-width: 720px) {
  .ssp-placement-heading { flex-direction: column; }
  .ssp-placement-values { grid-template-columns: 1fr; }
}
</style>
