<template>
  <div class="sub-style-picker">
    <div class="ssp-grid">
      <div class="form-group">
        <label>Font family</label>
        <select :value="isCustomFont ? '__custom__' : style.font_family" @change="onFontSelect(($event.target as HTMLSelectElement).value)" class="select">
          <option v-for="f in FONT_CHOICES" :key="f" :value="f">{{ f }}</option>
          <option value="__custom__">Custom…</option>
        </select>
        <input
          v-if="isCustomFont"
          :value="style.font_family"
          @input="update('font_family', ($event.target as HTMLInputElement).value)"
          class="input mt-1"
          placeholder="Type any font installed on your Mac (e.g. Bebas Neue)"
        />
      </div>

      <div class="form-group">
        <label>Font size ({{ style.font_size_px }} px)</label>
        <input type="range" min="16" max="72" step="1"
          :value="style.font_size_px"
          @input="update('font_size_px', parseInt(($event.target as HTMLInputElement).value))"
          class="slider" />
      </div>

      <div class="form-group">
        <label>Text colour</label>
        <input type="color" :value="style.color_hex"
          @input="update('color_hex', ($event.target as HTMLInputElement).value)"
          class="color-picker" />
      </div>

      <div class="form-group">
        <label>Outline colour</label>
        <input type="color" :value="style.outline_color_hex"
          @input="update('outline_color_hex', ($event.target as HTMLInputElement).value)"
          class="color-picker" />
      </div>

      <div class="form-group">
        <label>Outline thickness ({{ style.outline_px }} px)</label>
        <input type="range" min="0" max="6" step="1"
          :value="style.outline_px"
          @input="update('outline_px', parseInt(($event.target as HTMLInputElement).value))"
          class="slider" />
      </div>

      <div class="form-group">
        <label>Background</label>
        <div class="ssp-btn-row">
          <button
            v-for="b in BG_OPTIONS" :key="b.id"
            :class="['btn btn-sm', style.background === b.id ? 'btn-primary' : 'btn-secondary']"
            @click="update('background', b.id)"
          >{{ b.label }}</button>
        </div>
      </div>

      <div class="form-group">
        <label>Vertical position</label>
        <div class="ssp-btn-row">
          <button
            v-for="p in POSITIONS" :key="p.id"
            :class="['btn btn-sm', style.position === p.id ? 'btn-primary' : 'btn-secondary']"
            @click="update('position', p.id)"
          >{{ p.label }}</button>
        </div>
      </div>

      <div class="form-group">
        <label>Alignment</label>
        <div class="ssp-btn-row">
          <button
            v-for="a in ALIGNMENTS" :key="a.id"
            :class="['btn btn-sm', style.align === a.id ? 'btn-primary' : 'btn-secondary']"
            @click="update('align', a.id)"
          >{{ a.label }}</button>
        </div>
      </div>

      <div class="form-group">
        <label>Max chars per line ({{ style.max_chars_per_line }})</label>
        <input type="range" min="20" max="80" step="1"
          :value="style.max_chars_per_line"
          @input="update('max_chars_per_line', parseInt(($event.target as HTMLInputElement).value))"
          class="slider" />
      </div>

      <div class="form-group">
        <label>Max lines ({{ style.max_lines }})</label>
        <input type="range" min="1" max="4" step="1"
          :value="style.max_lines"
          @input="update('max_lines', parseInt(($event.target as HTMLInputElement).value))"
          class="slider" />
      </div>

      <!-- v1.0.353 — caption entrance animation. -->
      <div class="form-group">
        <label>Caption animation</label>
        <select :value="style.animation || 'none'" @change="update('animation', ($event.target as HTMLSelectElement).value as SubtitleStyle['animation'])" class="select">
          <option v-for="a in ANIMATIONS" :key="a.id" :value="a.id">{{ a.label }}</option>
        </select>
        <p class="text-muted" style="font-size: 11px; margin-top: 4px;">
          How each line enters. The CSS preview above is static — use "Render exact preview" to see it animate.
        </p>
      </div>
    </div>

    <!-- Live preview: CSS approximation + optional "Exact render" via FFmpeg -->
    <div class="ssp-preview mt-2">
      <div ref="frameEl" class="ssp-preview-frame" :style="previewFrameStyle">
        <div class="ssp-caption-layer" :style="captionLayerStyle">
          <span class="ssp-caption" :style="captionStyle">{{ sampleText }}</span>
        </div>
      </div>
      <div class="ssp-preview-actions">
        <button class="btn btn-sm btn-secondary" :disabled="rendering" @click="renderExact">
          {{ rendering ? 'Rendering…' : 'Render exact preview' }}
        </button>
        <video
          v-if="exactUrl"
          :src="exactUrl"
          class="ssp-exact-video"
          autoplay muted loop playsinline
        />
      </div>
      <p class="text-muted" style="font-size: 11px; margin-top: 4px;">
        CSS preview approximates libass output. Use "Render exact preview" for the real FFmpeg render.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
interface SubtitleStyle {
  font_family: string
  font_size_px: number
  color_hex: string
  outline_color_hex: string
  outline_px: number
  background: 'none' | 'semi' | 'full'
  position: 'top' | 'center' | 'bottom'
  align: 'left' | 'center' | 'right'
  max_chars_per_line: number
  max_lines: number
  // v1.0.353 — entrance animation per caption line.
  animation?: 'none' | 'fade' | 'pop' | 'slide-up'
}

const props = defineProps<{
  slug: string
  episodeId?: string
  style: SubtitleStyle
  backdropUrl?: string
  sampleText: string
}>()

const emit = defineEmits<{ 'update:style': [style: SubtitleStyle] }>()

// v1.0.353 — a fuller curated list of caption-friendly faces that ship with
// macOS (libass resolves them via fontconfig). 'Custom…' lets the user type any
// installed font name not in the list.
const FONT_CHOICES = [
  'Helvetica', 'Helvetica Neue', 'Arial', 'Arial Black', 'Avenir', 'Avenir Next',
  'Futura', 'Gill Sans', 'Optima', 'Georgia', 'Times New Roman', 'Palatino',
  'Baskerville', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Menlo',
  'Impact', 'American Typewriter', 'Marker Felt', 'Chalkboard SE', 'Comic Sans MS',
]
const CUSTOM_FONT = '__custom__'
const isCustomFont = computed(() => {
  const f = props.style.font_family
  return f != null && !FONT_CHOICES.includes(f)
})
function onFontSelect(value: string) {
  if (value === CUSTOM_FONT) {
    if (!isCustomFont.value) update('font_family', '')  // blank → type a name
  } else {
    update('font_family', value)
  }
}

const ANIMATIONS = [
  { id: 'none' as const,     label: 'None (static)' },
  { id: 'fade' as const,     label: 'Fade in / out' },
  { id: 'pop' as const,      label: 'Pop in' },
  { id: 'slide-up' as const, label: 'Slide up' },
]

const BG_OPTIONS = [
  { id: 'none' as const, label: 'None' },
  { id: 'semi' as const, label: 'Semi' },
  { id: 'full' as const, label: 'Full' },
]

const POSITIONS = [
  { id: 'top' as const,    label: 'Top' },
  { id: 'center' as const, label: 'Center' },
  { id: 'bottom' as const, label: 'Bottom' },
]

const ALIGNMENTS = [
  { id: 'left' as const,   label: 'Left' },
  { id: 'center' as const, label: 'Center' },
  { id: 'right' as const,  label: 'Right' },
]

function update<K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) {
  emit('update:style', { ...props.style, [key]: value })
}

// v1.0.413 — track the live preview frame's pixel height so the caption font
// scales to match the 1080-referenced render (see captionStyle).
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

const previewFrameStyle = computed(() => {
  return props.backdropUrl
    ? { backgroundImage: `url("${props.backdropUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)' }
})

const captionLayerStyle = computed(() => {
  const justify = props.style.align === 'left'
    ? 'flex-start'
    : props.style.align === 'right' ? 'flex-end' : 'center'
  const align =
    props.style.position === 'top' ? 'flex-start'
    : props.style.position === 'center' ? 'center'
    : 'flex-end'
  return { justifyContent: justify, alignItems: align }
})

const captionStyle = computed(() => {
  // v1.0.413 — scale by the REAL preview-frame height ÷ 1080: every px value
  // in the style means "px at a 1080 reference", so a preview frame of height
  // H shows it at value·(H/1080).
  const previewFactor = (frameHeight.value || 360) / 1080
  // v1.0.517 — outline_px scales like font_size_px (before, a 2px outline drew
  // 2 raw px on the small preview frame — ~3× thicker relative to the text
  // than the real render).
  const outline = Math.round((props.style.outline_px || 0) * previewFactor * 10) / 10
  // CSS can't do a true libass-style stroke, so emulate with layered text-shadow.
  const shadow = outline > 0
    ? `-${outline}px -${outline}px 0 ${props.style.outline_color_hex},` +
      `${outline}px -${outline}px 0 ${props.style.outline_color_hex},` +
      `-${outline}px ${outline}px 0 ${props.style.outline_color_hex},` +
      `${outline}px ${outline}px 0 ${props.style.outline_color_hex}`
    : 'none'

  let background: string
  if (props.style.background === 'full') background = 'rgba(0, 0, 0, 0.95)'
  else if (props.style.background === 'semi') background = 'rgba(0, 0, 0, 0.5)'
  else background = 'transparent'

  return {
    fontFamily: props.style.font_family,
    fontSize: `${Math.round(props.style.font_size_px * previewFactor)}px`,
    color: props.style.color_hex,
    textShadow: shadow,
    background,
    padding: props.style.background === 'none' ? '0' : '4px 10px',
    borderRadius: '3px',
    maxWidth: '90%',
    whiteSpace: 'normal',
    lineHeight: '1.3',
    textAlign: props.style.align,
    display: 'inline-block',
  } as Record<string, string>
})

const { post: _post } = useApi() // unused but keeps the module scaffolding consistent
const rendering = ref(false)
const exactUrl = ref<string | null>(null)

async function renderExact() {
  if (rendering.value) return
  rendering.value = true
  exactUrl.value = null
  try {
    const qs = new URLSearchParams({
      text: props.sampleText,
      font_family: props.style.font_family,
      font_size_px: String(props.style.font_size_px),
      color_hex: props.style.color_hex,
      outline_color_hex: props.style.outline_color_hex,
      outline_px: String(props.style.outline_px),
      background: props.style.background,
      position: props.style.position,
      align: props.style.align,
      max_chars_per_line: String(props.style.max_chars_per_line),
      max_lines: String(props.style.max_lines),
    })
    if (props.episodeId) qs.set('episode', props.episodeId)
    // Adding a cache-bust parameter so the preview tag reloads when style changes.
    qs.set('_', String(Date.now()))
    exactUrl.value = `/api/projects/${props.slug}/video-editor/preview-subtitles?${qs.toString()}`
  } finally {
    // Wait a tick; the <video> element triggers its own load.
    setTimeout(() => { rendering.value = false }, 400)
  }
}
</script>

<style scoped>
.sub-style-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ssp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}

.ssp-btn-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.color-picker {
  width: 56px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  padding: 2px;
}

.ssp-preview-frame {
  width: 100%;
  max-width: 640px;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  border: 1px solid var(--border);
  position: relative;
  overflow: hidden;
}

.ssp-caption-layer {
  position: absolute;
  inset: 0;
  display: flex;
  padding: 16px;
}

.ssp-caption {
  /* style set inline; defaults come from captionStyle */
}

.ssp-preview-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.ssp-exact-video {
  max-width: 320px;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #000;
}
</style>
