<template>
  <div class="psl">
    <div v-if="showCatalogStarters" class="psl-catalog-launch card">
      <div>
        <span class="psl-library-kicker">Style library</span>
        <label>Start from an available style</label>
        <p class="text-muted text-xs mt-1">
          Browse {{ styles.length }} searchable looks in a focused library instead of expanding every card on this page.
        </p>
      </div>
      <button type="button" class="btn btn-primary" @click="catalogLibraryOpen = true">Browse Style Library</button>
    </div>

    <ContentPackStyleLibraryModal
      :visible="catalogLibraryOpen"
      :project-slug="projectSlug"
      action-label="Load into editor"
      @close="catalogLibraryOpen = false"
      @select="loadCatalogStyle"
    />

    <div class="psl-head">
      <div>
        <label>{{ title }}</label>
        <p class="text-muted text-xs mt-1">
          Build a reusable style pack, render its three previews with a live Gateway image model, then save the style text with this project. Every style shows the same three: the hero shot, a quiet wide scene with no figure in it, and the hardest case the look can be asked for.
        </p>
      </div>
      <div class="psl-controls">
        <ImageModelPicker
          v-model="previewModel"
          :project-slug="projectSlug"
          class="psl-preview-model"
          default-label="Choose an image model…"
        />
        <select v-if="aspectOptions.length" v-model="previewAspect" class="input input-sm">
          <option v-for="opt in aspectOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
      </div>
    </div>

    <div class="psl-editor card">
      <div class="psl-editor-grid">
        <div>
          <label class="psl-field-label">Style name</label>
          <input v-model="draftName" class="input" placeholder="e.g. Prehistoric Stick Cartoon" />
        </div>
        <div>
          <label class="psl-field-label">Style prompt</label>
          <textarea
            v-model="draftDescription"
            class="textarea"
            rows="5"
            placeholder="Describe the art direction, line work, colours, character design, mood, framing, texture, and what the model should avoid."
          />
        </div>
      </div>
      <div class="psl-editor-state">
        <span v-if="editingPresetId" class="psl-state-pill">Editing saved style</span>
        <span v-else-if="editorOriginLabel" class="psl-state-pill">{{ editorOriginLabel }}</span>
        <span v-if="editorStale" class="psl-stale-pill">Out of date</span>
        <button
          v-if="editingPresetId || draftName || draftDescription || liveSamples.some(sample => sample.url)"
          class="btn btn-ghost btn-sm"
          @click="resetEditor()"
        >
          New blank style
        </button>
      </div>
      <div class="psl-actions">
        <button
          class="btn btn-secondary btn-sm"
          :disabled="renderingAll || anySampleLoading || !draftDescription.trim() || !previewModel || !editorMissingSlots.length"
          :title="previewModel
            ? 'Render the previews this style is still missing, one image at a time'
            : 'Pick a Gateway image model first'"
          @click="generateMissingSamples"
        >
          {{ generateAllLabel }}
        </button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="saving || !draftName.trim() || !draftDescription.trim()"
          :title="editingPresetId
            ? 'Update this saved style. Its saved previews stay on disk either way.'
            : 'Save this style into the project library.'"
          @click="saveStyle"
        >
          {{ saving ? 'Saving…' : (editingPresetId ? 'Update Saved Style' : 'Save Style to Project') }}
        </button>
        <button
          v-if="editingPresetId"
          class="btn btn-ghost btn-sm"
          :disabled="saving || !draftName.trim() || !draftDescription.trim()"
          :title="'Fork this into a new saved style instead of overwriting the current one.'"
          @click="saveAsNewStyle"
        >
          {{ saving ? 'Saving…' : 'Save as New Style' }}
        </button>
        <button
          v-if="showApply"
          class="btn btn-ghost btn-sm"
          :disabled="!draftDescription.trim()"
          @click="emitApply()"
        >
          Apply to Style Bible
        </button>
        <span class="text-muted text-xs">Uses the live Gateway catalog and the selected model's supported defaults.</span>
      </div>
      <p v-if="editorStale" class="psl-stale-note">
        These previews were made before this style's text was last edited. They are still shown, and they still describe a real look — generate them again to see the look as it is now.
      </p>
      <p v-if="renderError" class="psl-error">{{ renderError }}</p>

      <div class="psl-samples-grid">
        <article
          v-for="sample in liveSamples"
          :key="sample.slot"
          class="psl-sample-card"
          :class="{ 'is-empty': !sample.url }"
        >
          <div class="psl-sample-head">
            <strong>{{ sample.label }}</strong>
            <div class="psl-sample-badges">
              <span v-if="sample.url" class="psl-sample-chip">{{ editorStale ? 'out of date' : 'ready' }}</span>
            </div>
          </div>
          <div class="psl-sample-preview">
            <button
              v-if="sample.url"
              type="button"
              class="psl-image-button"
              title="Open large preview"
              @click="openLiveSample(sample.slot)"
            >
              <img :src="sample.url" :alt="sample.label" class="psl-sample-img" />
              <span class="psl-zoom-hint">View larger</span>
            </button>
            <div v-else class="psl-sample-empty">
              {{ sample.loading ? 'Rendering…' : 'Not generated yet' }}
            </div>
          </div>
          <div class="psl-sample-actions">
            <button
              class="btn btn-secondary btn-sm"
              :disabled="renderingAll || sample.loading || !draftDescription.trim() || !previewModel"
              :title="sample.url ? 'Spend one image credit to create a new version of this preview' : 'Generate only this preview'"
              @click="generateSample(sample.slot, !!sample.url)"
            >
              {{ sample.loading ? 'Rendering…' : (sample.url ? 'Regenerate This Preview' : 'Generate This Preview') }}
            </button>
          </div>
          <p class="psl-sample-copy">{{ sample.scene_hint }}</p>
          <p v-if="sample.error" class="psl-error">{{ sample.error }}</p>
        </article>
      </div>
    </div>

    <div class="psl-saved">
      <div class="psl-saved-head">
        <label>Saved custom styles</label>
        <span class="text-muted text-xs">{{ presets.length }} in this project</span>
      </div>
      <div v-if="!presets.length" class="psl-empty card">
        No custom styles saved yet.
      </div>
      <div v-else class="psl-preset-grid">
        <article v-for="preset in presets" :key="preset.id" class="psl-preset-card">
          <div class="psl-preset-top">
            <div>
              <h4>{{ preset.name }}</h4>
              <p class="text-muted text-xs mt-1">
                {{ preset.preview_model || 'No preview model saved' }}{{ preset.preview_aspect_ratio ? ` · ${preset.preview_aspect_ratio}` : '' }}{{ preset.preview_tier ? ` · ${preset.preview_tier}` : '' }}
              </p>
            </div>
            <div class="psl-preset-actions">
              <button class="btn btn-ghost btn-sm" @click="loadPreset(preset)">Edit</button>
              <button v-if="showApply" class="btn btn-ghost btn-sm" @click="applyPreset(preset)">Apply</button>
              <button class="btn btn-ghost btn-sm psl-delete" @click="deletePreset(preset)">Delete</button>
            </div>
          </div>
          <div class="psl-preset-previews">
            <template v-for="(tile, index) in presetTiles(preset)" :key="tile.slot">
              <button
                v-if="presetTileUrl(preset, tile)"
                type="button"
                class="psl-image-button"
                :title="`${SLOT_TITLES[tile.slot]} — open large preview`"
                @click="openPresetPreview(preset, index)"
              >
                <img :src="presetTileUrl(preset, tile)" :alt="`${preset.name} ${SLOT_TITLES[tile.slot]}`" class="psl-preset-img" />
                <span class="psl-zoom-hint">View larger</span>
              </button>
              <div
                v-else
                class="psl-preset-empty-tile"
                :title="`${SLOT_TITLES[tile.slot]} — not generated yet`"
                :aria-label="`${SLOT_TITLES[tile.slot]} not generated`"
              >
                <strong>{{ SLOT_TILE_LABELS[tile.slot] }}</strong>
              </div>
            </template>
          </div>
          <div class="psl-preset-meta">
            <span v-if="presetOutOfDate(preset)" class="psl-stale-mark">Out of date</span>
            <button
              v-if="presetMissingSlots(preset).length"
              class="btn btn-secondary btn-sm"
              :disabled="!previewModel || presetGenerating === preset.id"
              :title="previewModel
                ? `Render the ${presetMissingSlots(preset).length} preview${presetMissingSlots(preset).length === 1 ? '' : 's'} this style is missing`
                : 'Choose an image model first'"
              @click="generatePresetPreviews(preset)"
            >
              {{ presetGenerating === preset.id ? 'Rendering…' : 'Generate previews' }}
            </button>
          </div>
          <p v-if="presetOutOfDate(preset)" class="psl-stale-note">
            Shown from previews made before this style's text was last edited. Generating again renders the three as the style is now; the older pictures stay on disk.
          </p>
          <p class="psl-preset-copy">{{ preset.description }}</p>
        </article>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="lightboxImages.length"
        class="psl-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="lightboxCurrent?.label || 'Style preview'"
        @click.self="closeLightbox"
      >
        <header class="psl-lightbox-head">
          <div>
            <strong>{{ lightboxCurrent?.label }}</strong>
            <span v-if="lightboxImages.length > 1">{{ lightboxIndex + 1 }} / {{ lightboxImages.length }}</span>
          </div>
          <button type="button" class="psl-lightbox-close" aria-label="Close preview" @click="closeLightbox">×</button>
        </header>
        <div class="psl-lightbox-stage">
          <button
            v-if="lightboxImages.length > 1"
            type="button"
            class="psl-lightbox-arrow psl-lightbox-prev"
            :disabled="lightboxIndex === 0"
            aria-label="Previous image"
            @click="lightboxIndex--"
          >‹</button>
          <img v-if="lightboxCurrent" :src="lightboxCurrent.url" :alt="lightboxCurrent.label" />
          <button
            v-if="lightboxImages.length > 1"
            type="button"
            class="psl-lightbox-arrow psl-lightbox-next"
            :disabled="lightboxIndex === lightboxImages.length - 1"
            aria-label="Next image"
            @click="lightboxIndex++"
          >›</button>
        </div>
        <p class="psl-lightbox-help">Esc to close · Arrow keys to browse</p>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { type VisualStyleCatalogItem, useVisualStyleCatalog } from '~/composables/useVisualStyleCatalog'
import { selectLiveGenStudioModel } from '~/utils/live-genstudio-model-selection'
import {
  STYLE_PREVIEW_SLOTS,
  STYLE_PREVIEW_SLOT_LABELS,
  channelStylePreviewDisplay,
  type ChannelStylePreviewDisplay,
  type ChannelStylePreviewState,
  type ChannelStylePreviewTile,
  type StylePreviewSlot,
} from '~/utils/style-preview-queue'

interface PresetEntry {
  id: string
  name: string
  description: string
  preview_filename?: string
  preview_files?: string[]
  preview_model?: string
  preview_aspect_ratio?: string
  preview_tier?: string
  preview_saved_at?: string
  preview_source_hash?: string
}

interface LiveSampleState {
  slot: StylePreviewSlot
  label: string
  scene_hint: string
  loading: boolean
  url: string | null
  error: string | null
}

interface LightboxImage {
  url: string
  label: string
}

const props = withDefaults(defineProps<{
  projectSlug: string
  title?: string
  showApply?: boolean
  showCatalogStarters?: boolean
}>(), {
  title: 'Project style library',
  showApply: false,
  showCatalogStarters: false,
})

const emit = defineEmits<{
  (e: 'apply', data: { style_bible: string; negative_prompt: string }): void
}>()

const { get, post, put, del } = useApi()
const { styles, refresh: refreshVisualStyles } = useVisualStyleCatalog()
const { success, error: showError } = useToast()
const { ask } = useConfirm()
const { models: genStudioImageModels, refresh: refreshGenStudioImageModels } = useGenStudioImageModels()

/** Short captions for the three tiles a style card shows, in slot order. */
const SLOT_TITLES: Record<StylePreviewSlot, string> = {
  hero: 'Hero',
  scene: 'Empty scene',
  face: 'Hardest case',
}
/**
 * The same three slots, one word each, for the caption inside an empty tile —
 * a card can be only ~220px wide, so a three-word caption would wrap inside a
 * 16:9 tile. The full name is the tile's own title and its accessible label.
 */
const SLOT_TILE_LABELS: Record<StylePreviewSlot, string> = {
  hero: 'Hero',
  scene: 'Scene',
  face: 'Face',
}

/**
 * The three framings, in slot order: the hero, a quiet wide scene with no figure
 * in it, and the hardest legal case (owner, 2026-09-08 and again 2026-10-25 —
 * every art style shows exactly these three). The prompts themselves are built
 * on the server from the style's own text and are never sent from here; these
 * hints only say what each picture is for.
 */
const SAMPLE_VARIANTS = [
  {
    slot: 'hero' as StylePreviewSlot,
    label: SLOT_TITLES.hero,
    scene_hint: `The shot the look exists for — ${STYLE_PREVIEW_SLOT_LABELS.hero}, the one a cover would use.`,
  },
  {
    slot: 'scene' as StylePreviewSlot,
    label: SLOT_TITLES.scene,
    scene_hint: 'A quiet wide scene with no figure in it at all: no person, no face, no hands, no animal — so the look can be judged on somewhere nobody is standing.',
  },
  {
    slot: 'face' as StylePreviewSlot,
    label: SLOT_TITLES.face,
    scene_hint: 'The hardest case the look can legally be asked for from its own description: a face held close to camera, or a crowd at readable size.',
  },
]

const presets = ref<PresetEntry[]>([])
/** What each saved style shows right now, as the channel-style-previews route resolves it. */
const channelStates = ref<Record<string, ChannelStylePreviewState>>({})
const draftName = ref('')
const draftDescription = ref('')
const previewModel = ref('')
const previewAspect = ref('16:9')
const saving = ref(false)
const renderingAll = ref(false)
const renderError = ref<string | null>(null)
const liveSamples = ref<LiveSampleState[]>(SAMPLE_VARIANTS.map(defaultSampleState))
/** The style text the images in the editor were made from. */
const samplesSourceText = ref('')
/** True when those images were already out of date when they were loaded. */
const samplesStaleAtLoad = ref(false)
/** The saved style whose previews are rendering right now, if any. */
const presetGenerating = ref('')
const editingPresetId = ref<string | null>(null)
const editorOriginLabel = ref<string | null>(null)
const lightboxImages = ref<LightboxImage[]>([])
const lightboxIndex = ref(0)
const catalogLibraryOpen = ref(false)

const selectedImageModel = computed(() =>
  genStudioImageModels.value.find(model => model.id === previewModel.value),
)
// Published ratios only. A model that publishes none gets NO ratio control
// rather than an invented '16:9' the customer would take for the model's own.
const aspectOptions = computed<string[]>(() => selectedImageModel.value?.aspect_ratios?.filter(Boolean) || [])
const anySampleLoading = computed(() => liveSamples.value.some(sample => sample.loading))
const lightboxCurrent = computed(() => lightboxImages.value[lightboxIndex.value] || null)
const hasSampleImages = computed(() => liveSamples.value.some(sample => !!sample.url))
/**
 * True when the previews on screen do not describe the text in the editor —
 * either because they were already out of date when loaded, or because the text
 * has been edited since. Either way they say so rather than passing for current.
 */
const editorStale = computed(() => hasSampleImages.value
  && (samplesStaleAtLoad.value || samplesSourceText.value !== draftDescription.value.trim()))
/**
 * The slots still needed for the text as it is NOW. A stale set needs all three
 * re-made even though three pictures are already on screen.
 */
const editorMissingSlots = computed<StylePreviewSlot[]>(() => (editorStale.value
  ? [...STYLE_PREVIEW_SLOTS]
  : liveSamples.value.filter(sample => !sample.url).map(sample => sample.slot)))
const generateAllLabel = computed(() => {
  if (renderingAll.value) return 'Rendering previews…'
  const count = editorMissingSlots.value.length
  if (!count) return 'Previews are complete'
  if (count === STYLE_PREVIEW_SLOTS.length) return 'Generate Previews'
  return `Generate ${count} missing preview${count === 1 ? '' : 's'}`
})

watch(genStudioImageModels, (models) => {
  previewModel.value = selectLiveGenStudioModel(previewModel.value, models)?.id || ''
}, { immediate: true, deep: true })

watch([selectedImageModel, aspectOptions], ([model, aspects]) => {
  if (!model || !aspects.length) return
  if (!aspects.includes(previewAspect.value)) {
    // The model's OWN published default, never a hardcoded '16:9'.
    previewAspect.value = aspects.includes(model.default_aspect_ratio)
      ? model.default_aspect_ratio
      : aspects[0]!
  }
}, { immediate: true })

watch(() => props.projectSlug, () => {
  resetEditor()
  void loadPresets()
  void loadChannelStates()
})

onMounted(() => {
  void refreshGenStudioImageModels()
  void refreshVisualStyles()
  void loadPresets()
  void loadChannelStates()
})

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('keydown', onLightboxKeydown)
})

function defaultSampleState(variant: typeof SAMPLE_VARIANTS[number]): LiveSampleState {
  return {
    slot: variant.slot,
    label: variant.label,
    scene_hint: variant.scene_hint,
    loading: false,
    url: null,
    error: null,
  }
}

function resetEditor(): void {
  editingPresetId.value = null
  editorOriginLabel.value = null
  draftName.value = ''
  draftDescription.value = ''
  renderError.value = null
  liveSamples.value = SAMPLE_VARIANTS.map(defaultSampleState)
  samplesSourceText.value = ''
  samplesStaleAtLoad.value = false
}

async function loadPresets(): Promise<void> {
  try {
    const cfg = await get<{ style_presets?: PresetEntry[] }>(`/projects/${props.projectSlug}/settings/config`)
    presets.value = Array.isArray(cfg?.style_presets) ? cfg.style_presets : []
  } catch {
    presets.value = []
  }
}

/**
 * What this channel's custom styles show right now.
 *
 * The three images are not stored per channel: they live once per style text in
 * the shared store, and this route resolves which of them each style shows —
 * including whether what is shown was made from text the style no longer has.
 */
async function loadChannelStates(): Promise<void> {
  try {
    const data = await get<{ styles?: ChannelStylePreviewState[] }>(
      `/projects/${props.projectSlug}/channel-style-previews`,
    )
    const next: Record<string, ChannelStylePreviewState> = {}
    for (const state of data?.styles || []) next[state.preset_id] = state
    channelStates.value = next
  } catch {
    channelStates.value = {}
  }
}

function previewUrlForPreset(preset: PresetEntry, file: string): string {
  const stamp = encodeURIComponent(preset.preview_saved_at || '')
  return `/api/projects/${props.projectSlug}/style-presets/${encodeURIComponent(preset.id)}/preview?file=${encodeURIComponent(file)}&t=${stamp}`
}

function presetPreviewFiles(preset: PresetEntry): string[] {
  const files = Array.isArray(preset.preview_files) ? preset.preview_files : []
  if (files.length) return files
  return preset.preview_filename ? [preset.preview_filename] : []
}

/**
 * The three tiles one saved style shows, in slot order.
 *
 * With no resolved state — the route has not answered yet, or is unavailable —
 * the preset's own saved files stand in, capped at the same three tiles, so a
 * style that has pictures on disk never reads as empty.
 */
function presetDisplay(preset: PresetEntry): ChannelStylePreviewDisplay {
  const state = channelStates.value[preset.id]
  if (state) return channelStylePreviewDisplay(state)
  const files = presetPreviewFiles(preset).slice(0, STYLE_PREVIEW_SLOTS.length)
  return channelStylePreviewDisplay({ stored_files: files, stale: files.length > 0 })
}

function presetTiles(preset: PresetEntry): ChannelStylePreviewTile[] {
  return presetDisplay(preset).tiles
}

function presetTileUrl(preset: PresetEntry, tile: ChannelStylePreviewTile): string {
  if (tile.url) return tile.url
  return tile.sourceFile ? previewUrlForPreset(preset, tile.sourceFile) : ''
}

function presetOutOfDate(preset: PresetEntry): boolean {
  return presetDisplay(preset).stale
}

function presetMissingSlots(preset: PresetEntry): StylePreviewSlot[] {
  return presetDisplay(preset).missing
}

function patchSample(slot: StylePreviewSlot, patch: Partial<LiveSampleState>): void {
  liveSamples.value = liveSamples.value.map(sample =>
    sample.slot === slot ? { ...sample, ...patch } : sample,
  )
}

/**
 * Take the slots the route just published into the editor.
 *
 * The editor only calls itself current when all three images describe the text
 * in the box: regenerating one preview of three leaves the set mixed, and a
 * mixed set still says "out of date" rather than passing for the look.
 */
function applySampleSlots(slots: Array<{ slot: string; url: string }>, styleTag: string): void {
  for (const entry of slots) {
    const slot = entry.slot as StylePreviewSlot
    if (!STYLE_PREVIEW_SLOTS.includes(slot)) continue
    patchSample(slot, { loading: false, url: entry.url, error: null })
  }
  if (STYLE_PREVIEW_SLOTS.every(slot => liveSamples.value.find(sample => sample.slot === slot)?.url)) {
    samplesSourceText.value = styleTag
    samplesStaleAtLoad.value = false
  }
}

async function generateMissingSamples(): Promise<void> {
  await renderSamples(editorMissingSlots.value, false)
}

async function generateSample(slot: StylePreviewSlot, force: boolean): Promise<void> {
  await renderSamples([slot], force)
}

/**
 * Render the given previews, ONE image at a time.
 *
 * Each call asks only for the slot it names, so a failure costs that one image
 * and the others still land (§8), and a retry asks for exactly what is still
 * missing rather than re-rendering what already exists.
 */
async function renderSamples(slots: StylePreviewSlot[], force: boolean): Promise<void> {
  const styleTag = draftDescription.value.trim()
  if (!styleTag || !previewModel.value || !slots.length || renderingAll.value || presetGenerating.value) return
  renderingAll.value = true
  renderError.value = null
  const failures: string[] = []
  try {
    for (const slot of slots) {
      patchSample(slot, { loading: true, error: null })
      try {
        const data = await post<{
          slots: Array<{ slot: string; url: string }>
          failed: Array<{ slot: string; error: string }>
        }>(`/projects/${props.projectSlug}/channel-style-previews`, {
          style_tag: styleTag,
          model: previewModel.value,
          aspect_ratio: previewAspect.value,
          slots: [slot],
          force,
        })
        applySampleSlots(data.slots || [], styleTag)
        for (const failure of data.failed || []) {
          const message = `${STYLE_PREVIEW_SLOT_LABELS[failure.slot as StylePreviewSlot] || failure.slot}: ${failure.error}`
          failures.push(message)
          if (failure.slot === slot) patchSample(slot, { loading: false, error: failure.error })
        }
      } catch (e: any) {
        const message = e?.data?.detail || e?.message || 'Preview failed'
        failures.push(`${STYLE_PREVIEW_SLOT_LABELS[slot]}: ${message}`)
        patchSample(slot, { loading: false, error: message })
      } finally {
        patchSample(slot, { loading: false })
      }
    }
  } finally {
    renderingAll.value = false
  }
  if (failures.length) {
    renderError.value = `${failures.length} of ${slots.length} image${failures.length === 1 ? '' : 's'} failed (${failures.join('; ')}). Generate again to render only what is missing.`
  } else if (editingPresetId.value) {
    // A saved style's own record follows the previews it now has.
    await Promise.all([loadPresets(), loadChannelStates()])
  }
}

/** Render the previews one SAVED style is missing, one image at a time. */
async function generatePresetPreviews(preset: PresetEntry): Promise<void> {
  if (!previewModel.value || presetGenerating.value || renderingAll.value || !preset.description.trim()) return
  const slots = presetMissingSlots(preset)
  if (!slots.length) return
  presetGenerating.value = preset.id
  const failures: string[] = []
  try {
    for (const slot of slots) {
      try {
        const data = await post<{ failed: Array<{ slot: string; error: string }> }>(
          `/projects/${props.projectSlug}/channel-style-previews`,
          {
            style_tag: preset.description,
            model: previewModel.value,
            aspect_ratio: previewAspect.value,
            slots: [slot],
          },
        )
        for (const failure of data.failed || []) {
          failures.push(`${STYLE_PREVIEW_SLOT_LABELS[failure.slot as StylePreviewSlot] || failure.slot}: ${failure.error}`)
        }
      } catch (e: any) {
        failures.push(`${STYLE_PREVIEW_SLOT_LABELS[slot]}: ${e?.data?.detail || e?.message || 'Preview failed'}`)
      }
    }
  } finally {
    presetGenerating.value = ''
    await Promise.all([loadPresets(), loadChannelStates()])
  }
  if (failures.length) {
    showError(`${failures.length} of ${slots.length} preview${failures.length === 1 ? '' : 's'} for "${preset.name}" failed: ${failures.join('; ')}`)
  } else {
    success(`Rendered the previews for "${preset.name}"`)
  }
}

function savePayload() {
  // No gallery is sent: the three previews live in the shared store, keyed by
  // the style's own text, and a save must not touch the preset's older files on
  // disk (§5 — never rewrite stored project data to compensate).
  return {
    name: draftName.value.trim(),
    description: draftDescription.value.trim(),
    ...(previewModel.value ? { preview_model: previewModel.value } : {}),
    ...(previewAspect.value ? { preview_aspect_ratio: previewAspect.value } : {}),
  }
}

async function saveStyle(): Promise<void> {
  if (!draftName.value.trim() || !draftDescription.value.trim() || saving.value) return
  saving.value = true
  try {
    let saved: PresetEntry
    if (editingPresetId.value) {
      saved = await put<PresetEntry>(`/projects/${props.projectSlug}/style-presets/${encodeURIComponent(editingPresetId.value)}`, savePayload())
      presets.value = presets.value.map(p => p.id === saved.id ? saved : p)
      success(`Updated style "${saved.name}"`)
    } else {
      saved = await post<PresetEntry>(`/projects/${props.projectSlug}/style-presets`, savePayload())
      presets.value = [...presets.value, saved]
      editingPresetId.value = saved.id
      success(`Saved style "${saved.name}"`)
    }
    await Promise.all([loadPresets(), loadChannelStates()])
    const target = presets.value.find(p => p.id === saved.id)
    if (target) loadPreset(target)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save style')
  } finally {
    saving.value = false
  }
}

async function saveAsNewStyle(): Promise<void> {
  if (!draftName.value.trim() || !draftDescription.value.trim() || saving.value) return
  const previousEditingId = editingPresetId.value
  editingPresetId.value = null
  try {
    await saveStyle()
  } finally {
    if (!editingPresetId.value) editingPresetId.value = previousEditingId
  }
}

/**
 * Load a saved style into the editor, previews and all.
 *
 * The three tiles come from the resolved state, so what the editor shows is
 * exactly what the card shows — and when those images were made from other text
 * than the style has now, the editor says so instead of passing them for the
 * look in the box.
 */
function loadPreset(preset: PresetEntry): void {
  editingPresetId.value = preset.id
  editorOriginLabel.value = null
  draftName.value = preset.name
  draftDescription.value = preset.description
  if (preset.preview_model) previewModel.value = preset.preview_model
  if (preset.preview_aspect_ratio) {
    previewAspect.value = preset.preview_aspect_ratio
  }
  const display = presetDisplay(preset)
  liveSamples.value = SAMPLE_VARIANTS.map((variant, index) => {
    const tile = display.tiles[index]
    const url = tile?.url || (tile?.sourceFile ? previewUrlForPreset(preset, tile.sourceFile) : '')
    return { ...defaultSampleState(variant), url: url || null }
  })
  samplesSourceText.value = preset.description
  samplesStaleAtLoad.value = display.stale
}

function liveSampleLightboxImages(): LightboxImage[] {
  return liveSamples.value
    .filter(sample => !!sample.url)
    .map(sample => ({ url: sample.url!, label: sample.label }))
}

function openLiveSample(slot: StylePreviewSlot): void {
  const images = liveSampleLightboxImages()
  const sample = liveSamples.value.find(item => item.slot === slot)
  if (!sample?.url) return
  openLightbox(images, Math.max(0, images.findIndex(image => image.url === sample.url)))
}

function openPresetPreview(preset: PresetEntry, index: number): void {
  const shown = presetTiles(preset)
    .map((tile, position) => ({
      url: presetTileUrl(preset, tile),
      label: `${preset.name} · ${SLOT_TITLES[tile.slot]}`,
      position,
    }))
    .filter(image => !!image.url)
  openLightbox(shown, Math.max(0, shown.findIndex(image => image.position === index)))
}

function openLightbox(images: LightboxImage[], index: number): void {
  if (!images.length) return
  lightboxImages.value = images
  lightboxIndex.value = Math.max(0, Math.min(index, images.length - 1))
  if (typeof document !== 'undefined') document.addEventListener('keydown', onLightboxKeydown)
}

function closeLightbox(): void {
  lightboxImages.value = []
  lightboxIndex.value = 0
  if (typeof document !== 'undefined') document.removeEventListener('keydown', onLightboxKeydown)
}

function onLightboxKeydown(event: KeyboardEvent): void {
  if (!lightboxImages.value.length) return
  if (event.key === 'Escape') closeLightbox()
  if (event.key === 'ArrowLeft' && lightboxIndex.value > 0) lightboxIndex.value--
  if (event.key === 'ArrowRight' && lightboxIndex.value < lightboxImages.value.length - 1) lightboxIndex.value++
}

function emitApply(): void {
  if (!draftDescription.value.trim()) return
  emit('apply', { style_bible: draftDescription.value.trim(), negative_prompt: '' })
}

function applyPreset(preset: PresetEntry): void {
  emit('apply', { style_bible: preset.description, negative_prompt: '' })
}

function loadCatalogStyle(style: VisualStyleCatalogItem): void {
  editingPresetId.value = null
  editorOriginLabel.value = `Loaded from library: ${style.name}`
  draftName.value = style.name
  draftDescription.value = style.data.style_bible
  liveSamples.value = SAMPLE_VARIANTS.map(defaultSampleState)
  samplesSourceText.value = ''
  samplesStaleAtLoad.value = false
}

async function deletePreset(preset: PresetEntry): Promise<void> {
  const ok = await ask({
    title: `Delete style "${preset.name}"?`,
    body: 'This removes the saved prompt and its saved preview files from this project. Previews held for other styles with the same text are left where they are.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await del(`/projects/${props.projectSlug}/style-presets/${encodeURIComponent(preset.id)}`)
    presets.value = presets.value.filter(p => p.id !== preset.id)
    if (editingPresetId.value === preset.id) resetEditor()
    success(`Deleted style "${preset.name}"`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}
</script>

<style scoped>
.psl {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.psl-head,
.psl-saved-head,
.psl-preset-top,
.psl-sample-head,
.psl-editor-state,
.psl-preset-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.psl-controls,
.psl-actions,
.psl-preset-actions,
.psl-sample-actions,
.psl-sample-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.psl-preview-model { width: min(360px, 72vw); }
.psl-editor,
.psl-empty,
.psl-preset-card {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-secondary);
}
.psl-editor-grid {
  display: grid;
  gap: 12px;
}
.psl-field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.psl-samples-grid {
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}
.psl-samples-grid,
.psl-preset-grid {
  display: grid;
  gap: 12px;
}
.psl-preset-grid {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}
.psl-catalog-launch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: 12px;
  background: linear-gradient(135deg, var(--surface-accent), var(--bg-secondary));
}
.psl-catalog-launch label {
  display: block;
  margin-top: 2px;
  font-size: 14px;
}
.psl-library-kicker {
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.psl-state-pill,
.psl-stale-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 600;
}
.psl-state-pill {
  background: rgba(108, 143, 255, 0.14);
  color: var(--accent);
}
.psl-stale-pill {
  background: color-mix(in srgb, var(--warning, #e6a23c) 20%, transparent);
  color: var(--warning, #e6a23c);
}
.psl-sample-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-primary);
}
.psl-sample-card.is-empty {
  border-style: dashed;
}
.psl-sample-preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.psl-image-button {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: inherit;
  overflow: hidden;
  background: transparent;
  cursor: zoom-in;
}
.psl-zoom-hint {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.72);
  color: white;
  font-size: var(--font-xs);
  opacity: 0;
  transform: translateY(3px);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.psl-image-button:hover .psl-zoom-hint,
.psl-image-button:focus-visible .psl-zoom-hint {
  opacity: 1;
  transform: translateY(0);
}
.psl-sample-img,
.psl-preset-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.psl-sample-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
  padding: 12px;
}
.psl-sample-copy,
.psl-preset-copy {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.psl-preset-card h4 {
  margin: 0;
  font-size: 14px;
}
/* Exactly three tiles, always side by side: the owner's rule is three options,
   no more or less, so the card reads as one contact sheet rather than a
   wrapping gallery whose last row changes length per style. */
.psl-preset-previews {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 10px 0;
}
.psl-preset-img {
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.psl-preset-empty-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.2;
  text-align: center;
  padding: 2px 4px;
}
.psl-preset-empty-tile strong {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.psl-sample-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 600;
  background: rgba(108, 143, 255, 0.14);
  color: var(--accent);
}
.psl-stale-mark {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(220, 110, 20, .9);
  color: #fff;
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.psl-stale-note {
  margin: 0;
  font-size: 12px;
  color: var(--warning, #e6a23c);
  line-height: 1.5;
}
.psl-error {
  margin: 0;
  font-size: 12px;
  color: rgb(220, 38, 38);
}
.psl-delete {
  color: rgb(220, 38, 38);
}
.psl-lightbox {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  background: rgba(4, 7, 14, 0.94);
}
.psl-lightbox-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  color: white;
}
.psl-lightbox-head div {
  display: flex;
  gap: 12px;
  align-items: baseline;
}
.psl-lightbox-head span,
.psl-lightbox-help {
  color: rgba(255, 255, 255, 0.58);
  font-size: 12px;
}
.psl-lightbox-close,
.psl-lightbox-arrow {
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(0, 0, 0, 0.38);
  color: white;
  cursor: pointer;
}
.psl-lightbox-close {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 23px;
}
.psl-lightbox-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 80px;
}
.psl-lightbox-stage img {
  display: block;
  max-width: 92vw;
  max-height: calc(100vh - 120px);
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.62);
}
.psl-lightbox-arrow {
  position: absolute;
  top: 50%;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  transform: translateY(-50%);
  font-size: 32px;
}
.psl-lightbox-arrow:disabled {
  opacity: 0.25;
  cursor: default;
}
.psl-lightbox-prev { left: 18px; }
.psl-lightbox-next { right: 18px; }
.psl-lightbox-help {
  margin: 0;
  padding: 10px 20px 16px;
  text-align: center;
}
@media (max-width: 720px) {
  .psl-catalog-launch {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
