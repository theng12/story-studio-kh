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

    <div v-if="refusals.length" class="effect-refusals text-muted">
      <span v-for="refusal in refusals" :key="refusal.item_id">{{ refusal.item_id }} — {{ refusal.reason }}</span>
    </div>

    <div v-if="model.enabled" class="mt-2">
      <p class="text-muted text-sm">
        Overlays composite on top of the finished picture, in the order listed.
        They are drawn before captions, so a scrim makes captions easier to read
        instead of covering them. Effects chosen here go on every episode that
        uses this Effects preset; rain, fog, grade and the other atmosphere
        effects take their place in the layer groups (under the vignette and grain).
      </p>
      <p class="text-muted text-sm">
        To put effects on one scene, see them move live, or set their order, open the
        <NuxtLink :to="effectsLibraryLink">Effects Library</NuxtLink> — what you set there is saved with the episode and rendered here.
      </p>
      <p v-if="episodeStackSummary" class="text-sm effect-episode-stack">{{ episodeStackSummary }}</p>

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
              <span
                v-if="entry.origin?.origin === 'content-pack'"
                class="effect-pack-chip"
                :title="packLabel(entry)"
              >from a pack</span>
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
                  v-else-if="field.type === 'color' || (field.type === 'nullable-color' && paramValue(entry, field.key))"
                  type="color"
                  :value="paramValue(entry, field.key)"
                  @input="setParam(entry, field.key, ($event.target as HTMLInputElement).value.toUpperCase())"
                />
                <button
                  v-else-if="field.type === 'nullable-color'"
                  type="button"
                  class="btn btn-sm btn-ghost"
                  @click="setParam(entry, field.key, '#8AB8FF')"
                >Add</button>
                <input
                  v-else-if="field.type === 'seed'"
                  type="number"
                  class="input input-sm"
                  :min="field.min"
                  :max="field.max"
                  :value="paramValue(entry, field.key)"
                  @change="setParam(entry, field.key, Number(($event.target as HTMLInputElement).value))"
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
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { effectParamFields, type ParamField } from '@shared/effect-params'

interface OverlayEntry {
  id: string
  name: string
  description: string
  category: string
  approximation?: string
  document: Record<string, any>
  /** v1.2.1 — where the effect came from. Absent on a pre-1.2.1 payload. */
  origin?: { origin: 'built-in' | 'content-pack'; pack_id?: string; pack_version?: string }
}

/** An installed pack item the merge refused, shown rather than left to vanish. */
interface EffectRefusal { item_id: string; reason: string }

interface AppliedOverlay {
  id: string
  enabled: boolean
  params?: Record<string, unknown>
}

const props = defineProps<{
  slug: string
  episodeId?: string
  /** The render's shape. Corner logos, lower thirds, scrims and cinematic bars
   *  are laid out against the frame, so the preview has to use the real one. */
  aspectRatio?: string
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
const refusals = ref<EffectRefusal[]>([])
const previewingId = ref('')
const previewUrls = reactive<Record<string, string>>({})

const selectedCount = computed(() => model.value.overlays.filter(o => o.enabled).length)

const GROUP_LABELS: Record<string, string> = {
  light: 'Light and shadow',
  texture: 'Texture',
  framing: 'Framing',
  title: 'Titles',
  brand: 'Branding',
  weather: 'Weather',
  atmosphere: 'Atmosphere',
  grade: 'Colour grade',
}

/**
 * v1.5 — say what the Effects Library adds to THIS episode, so nothing renders
 * that the owner cannot see from Video Assembly. Read-only; re-read on every
 * episode change and blanked first, so one episode's count never shows on another.
 */
const episodeStackSummary = ref('')
async function loadEpisodeStack(): Promise<void> {
  episodeStackSummary.value = ''
  const episode = props.episodeId
  if (!episode) return
  try {
    const data = await props.get(`/projects/${props.slug}/effects-library/${episode}`)
    if (props.episodeId !== episode) return
    const file = data?.file || {}
    const whole = (file.episode || []).length
    const scenes = (file.scenes || []).reduce((n: number, s: any) => n + (s.effects || []).length, 0)
    const themes = (file.themes || []).reduce((n: number, t: any) => n + (t.effects || []).length, 0)
    const total = whole + scenes + themes
    if (!total) return
    const parts = [whole && `${whole} on the whole episode`, scenes && `${scenes} on single scenes`, themes && `${themes} on theme scenes`].filter(Boolean)
    episodeStackSummary.value = `This episode also has ${total} Effects Library effect${total === 1 ? '' : 's'} (${parts.join(', ')}). They render with this video.`
  } catch { /* the Effects Library page reports its own errors */ }
}
watch(() => props.episodeId, loadEpisodeStack, { immediate: true })

const effectsLibraryLink = computed(() => ({
  path: `/projects/${props.slug}/effects-library`,
  ...(props.episodeId ? { query: { episode: props.episodeId } } : {}),
}))
function groupLabel(category: string): string {
  return GROUP_LABELS[category] || category
}

/**
 * v1.2.1 — say where an effect came from.
 *
 * It matters because the two behave differently the day a pack is uninstalled:
 * a built-in is always there, and a pack effect an episode still uses stops
 * that episode's render with a named error rather than quietly rendering
 * without it.
 */
function packLabel(entry: OverlayEntry): string {
  const pack = [entry.origin?.pack_id, entry.origin?.pack_version].filter(Boolean).join(' ')
  return `From the Content Pack ${pack || '(unnamed)'}. If that pack is uninstalled while an episode still uses this effect, `
    + 'the render stops and names it rather than publishing the video without it.'
}

onMounted(async () => {
  try {
    const data = await props.get(`/projects/${props.slug}/video-editor/effects/catalog`)
    catalog.grouped_overlays = data.grouped_overlays || []
    catalog.supports_text_overlays = data.supports_text_overlays !== false
    refusals.value = Array.isArray(data.refusals) ? data.refusals : []
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

/**
 * Which controls one effect shows.
 *
 * v1.5 — the table moved to `@shared/effect-params` so this picker and the
 * Effects Library page show the same controls with the same ranges as the
 * normaliser. Still keyed by KIND (and, for atmosphere loops, by variant), so a
 * new effect of an existing kind needs no UI change.
 */
function fieldsFor(entry: OverlayEntry): ParamField[] {
  return effectParamFields({ ...entry.document, ...(applied(entry)?.params || {}) } as any)
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
    if (props.aspectRatio) body.aspect_ratio = props.aspectRatio
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
.effect-episode-stack {
  margin: 0.35rem 0 0;
  padding: 0.35rem 0.5rem;
  border-radius: 5px;
  border-left: 2px solid var(--accent, #4fc3f7);
  background: color-mix(in srgb, var(--accent, #4fc3f7) 10%, transparent);
}
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
/* Provenance, not a warning: a neutral tint, so it never competes with the
   amber "not exact" and "unavailable" notes below it. */
.effect-pack-chip {
  margin-left: auto;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-secondary) 18%, transparent);
  color: var(--text-secondary);
  white-space: nowrap;
}
.effect-refusals {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
  opacity: 0.8;
  overflow-wrap: anywhere;
}
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
