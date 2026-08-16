<!--
  The effect library picker.

  Everything in here is DATA fetched from `/video-editor/effects/catalog` —
  there is no local list of effects, no per-effect branch, and no hardcoded
  parameter form. Each overlay declares its kind; the kind decides which
  controls appear. Adding an effect to the backend registry makes it show up
  here with no change to this file, which is the whole point of the release.

  Two things this component must never soften:

  - An `approximation` note is shown wherever the registry carries one, in the
    tile itself and not behind a tooltip. An effect that quietly renders
    something other than its name is worse than one that says what it does.
  - When the FFmpeg build cannot draw text, the lower-third effects are shown
    DISABLED with the reason, not hidden. A missing control is a mystery; a
    disabled one with a sentence beside it is an answer.
-->
<template>
  <div class="effect-library">
    <div class="flex gap-2 items-center">
      <label class="checkbox-label" @click.stop>
        <input type="checkbox" v-model="model.enabled" />
      </label>
      <h4>Effect Library</h4>
      <span class="text-muted text-sm">({{ selectedCount }} selected)</span>
    </div>

    <p v-if="loadError" class="text-muted text-sm mt-1">{{ loadError }}</p>

    <div v-if="model.enabled" class="mt-2">
      <p class="text-muted text-sm">
        Overlays composite on top of the finished picture, in the order listed.
        They are drawn before captions, so a scrim makes captions easier to read
        instead of covering them.
      </p>

      <div v-for="group in catalog.grouped_overlays" :key="group.category" class="effect-group mt-2">
        <div class="effect-group-title">{{ groupLabel(group.category) }}</div>
        <div class="effect-grid">
          <div
            v-for="entry in group.overlays"
            :key="entry.id"
            class="effect-tile"
            :class="{ active: isSelected(entry.id), unavailable: !isAvailable(entry) }"
          >
            <label class="effect-tile-head">
              <input
                type="checkbox"
                :checked="isSelected(entry.id)"
                :disabled="!isAvailable(entry)"
                @change="toggle(entry)"
              />
              <span class="effect-name">{{ entry.name }}</span>
            </label>
            <p class="effect-description">{{ entry.description }}</p>
            <p v-if="!isAvailable(entry)" class="effect-unavailable">
              This FFmpeg build cannot draw text, so this effect is unavailable.
              Reinstall FFmpeg from Settings to enable it.
            </p>
            <p v-else-if="entry.approximation" class="effect-approximation">
              <strong>Not exact:</strong> {{ entry.approximation }}
            </p>

            <div class="effect-tile-actions">
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                :disabled="!isAvailable(entry) || previewingId === entry.id"
                @click="preview(entry)"
              >
                {{ previewingId === entry.id ? 'Rendering…' : 'Preview' }}
              </button>
            </div>

            <video
              v-if="previewUrls[entry.id]"
              :src="previewUrls[entry.id]"
              class="effect-preview"
              autoplay
              loop
              muted
              playsinline
            />

            <div v-if="isSelected(entry.id)" class="effect-params">
              <div v-for="field in fieldsFor(entry)" :key="field.key" class="effect-field">
                <label>{{ field.label }}</label>
                <input
                  v-if="field.type === 'number'"
                  type="range"
                  :min="field.min"
                  :max="field.max"
                  :step="field.step"
                  :value="paramValue(entry, field.key)"
                  @input="setParam(entry, field.key, Number(($event.target as HTMLInputElement).value))"
                />
                <input
                  v-else-if="field.type === 'color'"
                  type="color"
                  :value="paramValue(entry, field.key)"
                  @input="setParam(entry, field.key, ($event.target as HTMLInputElement).value.toUpperCase())"
                />
                <input
                  v-else-if="field.type === 'text'"
                  type="text"
                  class="input input-sm"
                  :value="paramValue(entry, field.key)"
                  @input="setParam(entry, field.key, ($event.target as HTMLInputElement).value)"
                />
                <select
                  v-else-if="field.type === 'select'"
                  class="select select-sm"
                  :value="paramValue(entry, field.key)"
                  @change="setParam(entry, field.key, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
                </select>
                <span v-if="field.type === 'number'" class="effect-field-value">
                  {{ paramValue(entry, field.key) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

interface OverlayEntry {
  id: string
  name: string
  description: string
  category: string
  approximation?: string
  document: Record<string, any>
}

interface AppliedOverlay {
  id: string
  enabled: boolean
  params?: Record<string, unknown>
}

const props = defineProps<{
  slug: string
  episodeId?: string
  /** `useApi().get` / `.post`, passed in so this component owns no transport. */
  get: (url: string) => Promise<any>
  post: (url: string, body: unknown) => Promise<any>
}>()

const model = defineModel<{ enabled: boolean; overlays: AppliedOverlay[] }>({
  default: () => ({ enabled: false, overlays: [] }),
})

const catalog = reactive<{
  grouped_overlays: Array<{ category: string; overlays: OverlayEntry[] }>
  supports_text_overlays: boolean
}>({ grouped_overlays: [], supports_text_overlays: true })

const loadError = ref('')
const previewingId = ref('')
const previewUrls = reactive<Record<string, string>>({})

const selectedCount = computed(() => model.value.overlays.filter(o => o.enabled).length)

const GROUP_LABELS: Record<string, string> = {
  light: 'Light and shadow',
  texture: 'Texture',
  framing: 'Framing',
  title: 'Titles',
  brand: 'Branding',
}
function groupLabel(category: string): string {
  return GROUP_LABELS[category] || category
}

onMounted(async () => {
  try {
    const data = await props.get(`/projects/${props.slug}/video-editor/effects/catalog`)
    catalog.grouped_overlays = data.grouped_overlays || []
    catalog.supports_text_overlays = data.supports_text_overlays !== false
  } catch {
    loadError.value = 'The effect library could not be loaded. The backend may still be starting.'
  }
})

/**
 * Text overlays need an FFmpeg built with freetype. The catalogue reports
 * whether this one has it, so the answer is the real binary's, not a guess.
 */
function isAvailable(entry: OverlayEntry): boolean {
  return entry.document.kind !== 'lower-third' || catalog.supports_text_overlays
}

function isSelected(id: string): boolean {
  return model.value.overlays.some(o => o.id === id && o.enabled)
}

function toggle(entry: OverlayEntry): void {
  const existing = model.value.overlays.find(o => o.id === entry.id)
  if (existing) existing.enabled = !existing.enabled
  else model.value.overlays.push({ id: entry.id, enabled: true, params: {} })
}

function applied(entry: OverlayEntry): AppliedOverlay | undefined {
  return model.value.overlays.find(o => o.id === entry.id)
}

function paramValue(entry: OverlayEntry, key: string): any {
  const override = applied(entry)?.params?.[key]
  return override === undefined ? entry.document[key] : override
}

function setParam(entry: OverlayEntry, key: string, value: unknown): void {
  const target = applied(entry)
  if (!target) return
  if (!target.params) target.params = {}
  target.params[key] = value
  delete previewUrls[entry.id]
}

interface Field {
  key: string
  label: string
  type: 'number' | 'color' | 'text' | 'select'
  min?: number
  max?: number
  step?: number
  options?: string[]
}

const ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

/**
 * Which controls one effect shows.
 *
 * Keyed by KIND, not by effect id, so a new effect of an existing kind gets its
 * controls for free — and a new kind is the only thing that needs a line here.
 */
const FIELDS_BY_KIND: Record<string, Field[]> = {
  vignette: [
    { key: 'intensity', label: 'Strength', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
  'film-grain': [
    { key: 'amount', label: 'Amount', type: 'number', min: 0, max: 100, step: 1 },
  ],
  'light-leak': [
    { key: 'color_hex', label: 'Colour', type: 'color' },
    { key: 'intensity', label: 'Strength', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'softness', label: 'Softness', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'from_anchor', label: 'Starts at', type: 'select', options: ANCHORS },
    { key: 'to_anchor', label: 'Drifts to', type: 'select', options: ANCHORS },
  ],
  letterbox: [
    { key: 'ratio', label: 'Aspect ratio', type: 'select', options: ['2.35:1', '2.00:1', '1.85:1', 'custom'] },
    { key: 'bar_share', label: 'Bar depth (custom only)', type: 'number', min: 0, max: 0.4, step: 0.01 },
  ],
  'lower-third': [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'subtitle', label: 'Subtitle', type: 'text' },
    { key: 'title_size_px', label: 'Title size', type: 'number', min: 8, max: 200, step: 1 },
    { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS },
    { key: 'margin_px', label: 'Margin', type: 'number', min: 0, max: 400, step: 4 },
  ],
  'corner-logo': [
    { key: 'image_path', label: 'Image path', type: 'text' },
    { key: 'anchor', label: 'Corner', type: 'select', options: ANCHORS },
    { key: 'width_pct', label: 'Width', type: 'number', min: 0.01, max: 1, step: 0.01 },
    { key: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'margin_px', label: 'Margin', type: 'number', min: 0, max: 400, step: 4 },
  ],
  'gradient-scrim': [
    { key: 'edge', label: 'Edge', type: 'select', options: ['top', 'bottom', 'left', 'right'] },
    { key: 'color_hex', label: 'Colour', type: 'color' },
    { key: 'opacity', label: 'Strength', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'coverage', label: 'Reach', type: 'number', min: 0.02, max: 1, step: 0.02 },
    { key: 'steps', label: 'Smoothness', type: 'number', min: 2, max: 64, step: 1 },
  ],
}

function fieldsFor(entry: OverlayEntry): Field[] {
  return FIELDS_BY_KIND[entry.document.kind] || []
}

/**
 * Ask the backend to render this effect and hand back a token.
 *
 * The overlay is sent as an id plus the fields the customer changed, never as
 * a whole document — the server resolves the current built-in, so a preview
 * always shows what the render would actually do.
 */
async function preview(entry: OverlayEntry): Promise<void> {
  previewingId.value = entry.id
  try {
    const body: Record<string, unknown> = {
      overlays: [{ id: entry.id, params: applied(entry)?.params || {} }],
    }
    if (props.episodeId) body.episode = props.episodeId
    const result = await props.post(`/projects/${props.slug}/video-editor/preview-effect`, body)
    previewUrls[entry.id] = result.url
  } catch (e: any) {
    loadError.value = e?.data?.detail || 'The preview could not be rendered.'
  } finally {
    previewingId.value = ''
  }
}
</script>

<style scoped>
.effect-group-title {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.65;
  margin-bottom: 0.35rem;
}
.effect-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 0.6rem;
}
.effect-tile {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  padding: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  /* The tile grows with its parameter panel; a fixed height would clip the
     approximation note, which is the one thing here that must always be
     readable. */
  min-width: 0;
}
.effect-tile.active { border-color: var(--accent, #4fc3f7); }
.effect-tile.unavailable { opacity: 0.6; }
.effect-tile-head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  cursor: pointer;
}
.effect-name { font-weight: 600; }
.effect-description { font-size: 0.8rem; opacity: 0.75; margin: 0; }
.effect-approximation,
.effect-unavailable {
  font-size: 0.75rem;
  margin: 0;
  padding: 0.35rem 0.45rem;
  border-radius: 5px;
  background: rgba(255, 196, 0, 0.12);
  border-left: 2px solid rgba(255, 196, 0, 0.6);
}
.effect-unavailable {
  background: rgba(255, 90, 90, 0.12);
  border-left-color: rgba(255, 90, 90, 0.6);
}
.effect-preview {
  width: 100%;
  border-radius: 5px;
  background: #000;
}
.effect-params {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  padding-top: 0.4rem;
}
.effect-field {
  display: grid;
  grid-template-columns: 8.5rem 1fr auto;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
}
.effect-field-value { opacity: 0.7; font-variant-numeric: tabular-nums; }
</style>
