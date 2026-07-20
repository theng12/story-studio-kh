<!--
  Style Preview card for /projects/:slug/images.

  Free-form textarea + Preview button. Renders ONE sample image of the
  user's typed style description against a fixed neutral baseline scene,
  using whatever model + aspect + tier they've picked on the page.
  Cached app-wide by sha256(style + model + aspect + tier) so re-clicks
  on the same combo are free.

  Episode-independent — visible at the top of /images even when no
  episode is selected. Useful for "what does 'oil painting at golden
  hour' look like on Flux Kontext at 16:9?" exploration before
  committing to an episode batch.

  v1.0.88 additions:
   - Click-to-zoom modal on the rendered thumbnail (parity with the
     gallery's lightbox UX).
   - "Save to episode" button that copies the cached preview PNG into
     the active episode's scene-images folder under a stable filename
     so the user has a permanent reference alongside their renders.
   - localStorage persistence of the textarea content per-(project, kind)
     so reloads no longer wipe a freshly-iterated style description.
-->
<template>
  <div class="card mt-2 spc">
    <div class="spc-head">
      <h3 class="spc-title">🎨 Try a style</h3>
      <span class="text-muted text-xs">~$0.005 first time on this combo, free thereafter</span>
    </div>
    <p class="text-muted text-sm spc-blurb">
      Type a style description and render one sample with your current
      <strong>{{ modelLabel }}</strong> · <strong>{{ aspectRatio }}</strong>{{ tier ? ` · ${tier}` : '' }}.
      Quick visual gut-check before kicking off a full batch.
    </p>

    <!-- Saved presets — project-level pool, shared with the Prompts
         page's "Custom" style dropdown. Selecting a preset fills the
         textarea + shows its saved preview PNG (if one was attached).
         The same pool also surfaces on /image-prompts under Custom,
         so a style saved here is reusable across surfaces. v1.0.89+. -->
    <div v-if="presets.length" class="spc-presets-row">
      <label class="spc-presets-label">Saved styles for this project:</label>
      <select
        :value="selectedPresetId"
        class="select spc-presets-select"
        @change="onPresetSelect(($event.target as HTMLSelectElement).value)"
      >
        <option value="">— pick a saved style —</option>
        <option v-for="p in presets" :key="p.id" :value="p.id">
          {{ p.name }}{{ p.preview_filename ? ' 🖼️' : '' }}{{ p.preview_model ? ` (${p.preview_model})` : '' }}
        </option>
      </select>
      <button
        v-if="selectedPresetId"
        type="button"
        class="btn btn-ghost btn-sm spc-presets-delete"
        :title="`Delete preset '${selectedPreset?.name}' from this project. Past renders that used it stay untouched.`"
        @click="deleteSelectedPreset"
      >
        ✕ Delete
      </button>
    </div>

    <textarea
      v-model="styleText"
      class="textarea spc-textarea"
      rows="3"
      placeholder="e.g. oil painting at golden hour, soft brush strokes, warm palette, 2D illustration"
    />
    <div class="spc-controls">
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        :disabled="state.loading || !styleText.trim() || !model"
        :title="!styleText.trim()
          ? 'Type a style description first'
          : !model
            ? 'Pick an image model first'
            : state.cached === true
              ? 'Cached preview — free. Edit the style above or change model/aspect/tier to invalidate.'
              : state.cached === false
                ? 'Generated a fresh sample. Cached now — re-clicking the same combo is free.'
                : 'Render one sample image of this style with your current model + aspect + tier.'"
        @click="generate"
      >
        <LoadingSpinner v-if="state.loading" size="sm" />
        <span v-else aria-hidden="true">🖼️</span>
        {{ state.loading ? 'Rendering…' : (state.url ? 'Re-preview' : 'Preview style') }}
      </button>
      <span v-if="state.error" class="spc-error" :title="state.error">⚠ {{ state.error }}</span>
    </div>
    <div v-if="state.url" class="spc-thumb-wrap">
      <button
        type="button"
        class="spc-thumb-btn"
        :title="'Click to view full-size'"
        @click="zoomOpen = true"
      >
        <img :src="state.url" alt="Style preview sample" class="spc-thumb" />
        <span class="spc-thumb-zoom-hint" aria-hidden="true">🔍</span>
      </button>
      <div class="spc-thumb-meta">
        <span :class="['spc-tag', state.cached ? 'is-cache' : 'is-fresh']">
          {{ state.cached ? '✓ cached' : '✨ fresh' }}
        </span>
        <span v-if="state.model_id" class="text-muted text-xs">
          {{ state.model_id }}{{ state.aspect_ratio ? ` · ${state.aspect_ratio}` : '' }}{{ state.tier ? ` · ${state.tier}` : '' }}
        </span>
        <button
          type="button"
          class="btn btn-ghost btn-sm spc-save-btn"
          :disabled="!episodeId || saveState.saving || !!saveState.saved"
          :title="!episodeId
            ? 'Pick an episode above to enable saving this preview into its folder.'
            : saveState.saved
              ? `Saved to ${saveState.saved}`
              : saveState.saving
                ? 'Copying preview to the episode folder…'
                : 'Copy this preview PNG into the active episode folder as a permanent reference for that scene/thumbnail style.'"
          @click="saveToEpisode"
        >
          <LoadingSpinner v-if="saveState.saving" size="sm" />
          <span v-else aria-hidden="true">{{ saveState.saved ? '✓' : '💾' }}</span>
          {{ saveState.saving ? 'Saving…' : saveState.saved ? 'Saved' : 'Save to episode' }}
        </button>
        <!-- Save the current preview + style description as a NAMED preset
             in the project. Becomes available from the dropdown above on
             every subsequent visit + on the Prompts page's Custom
             style picker. v1.0.89+. -->
        <button
          type="button"
          class="btn btn-ghost btn-sm spc-save-btn"
          :disabled="presetSaveState.saving"
          :title="'Save the current style description + preview as a named preset for this project. Reusable from the dropdown above next time you open the page.'"
          @click="openSavePresetModal"
        >
          <LoadingSpinner v-if="presetSaveState.saving" size="sm" />
          <span v-else aria-hidden="true">⭐</span>
          {{ presetSaveState.saving ? 'Saving preset…' : 'Save as preset' }}
        </button>
        <span v-if="saveState.error" class="spc-error" :title="saveState.error">⚠ {{ saveState.error }}</span>
        <span v-if="presetSaveState.error" class="spc-error" :title="presetSaveState.error">⚠ {{ presetSaveState.error }}</span>
      </div>
    </div>

    <!-- Save-as-preset modal — small ad-hoc form for the name input.
         Backend auto-bumps the slug if it collides with an existing
         preset, so we don't need to pre-check uniqueness here. -->
    <div
      v-if="presetSaveState.modalOpen"
      class="spc-zoom-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Save style as preset"
      @click.self="closeSavePresetModal"
    >
      <div class="spc-preset-modal">
        <h4>Save as project style preset</h4>
        <p class="text-muted text-sm">
          The style description + rendered preview will be saved in this
          project. Reusable across episodes from the dropdown above and
          from the Prompts page's Custom style picker.
        </p>
        <input
          v-model="presetSaveState.draftName"
          class="input"
          placeholder="e.g. Bound cartoon, Soft watercolor, Cinematic noir"
          autofocus
          @keyup.enter.stop.prevent="confirmSavePreset"
          @keydown.escape="closeSavePresetModal"
        />
        <div class="spc-preset-modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeSavePresetModal">Cancel</button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="!presetSaveState.draftName.trim() || presetSaveState.saving"
            @click="confirmSavePreset"
          >
            {{ presetSaveState.saving ? 'Saving…' : 'Save preset' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Click-to-zoom modal — mirrors the rest of the app's lightbox UX
         pattern without dragging in the full gallery navigation (style
         preview is a single ad-hoc image, not part of the scene/thumb
         pool). Close: backdrop click, ✕ button, or Escape. -->
    <div
      v-if="zoomOpen && state.url"
      class="spc-zoom-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Style preview full-size view"
      @click.self="zoomOpen = false"
      @keydown.esc="zoomOpen = false"
    >
      <div class="spc-zoom-card">
        <button type="button" class="spc-zoom-close" title="Close (Esc)" @click="zoomOpen = false">×</button>
        <img :src="state.url" alt="Style preview full size" class="spc-zoom-img" />
        <div class="spc-zoom-meta">
          {{ state.model_id }}{{ state.aspect_ratio ? ` · ${state.aspect_ratio}` : '' }}{{ state.tier ? ` · ${state.tier}` : '' }}
          <span v-if="saveState.saved"> · saved as <code>{{ saveState.saved }}</code></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

interface PreviewState {
  loading: boolean
  url: string | null
  cached: boolean | null
  hash: string | null
  model_id: string | null
  aspect_ratio: string | null
  tier: string | null
  /** Style text + model + aspect + tier that produced the rendered
   *  thumbnail. We track this so editing any of those clears the
   *  thumbnail (stale-render protection). */
  signature_at_render: string | null
  error: string | null
}

interface SaveState {
  saving: boolean
  /** Filename written into the episode folder on successful save. */
  saved: string | null
  error: string | null
}

const props = defineProps<{
  projectSlug: string
  model: string
  aspectRatio: string
  tier?: string
  imageSteps?: number
  seed?: number | null
  /** Friendly model label for the blurb — falls back to model id when absent. */
  modelLabel?: string
  /** Currently-selected episode code on the page (empty when no episode
   *  picked). When set, the "Save to episode" button is enabled and the
   *  preview can be copied into that episode's scene-images folder. */
  episodeId?: string
  /** Episode title — used by the backend's resolveEpisodePaths to find
   *  the right folder. Passed through so saves don't fail on episodes
   *  whose code lives in multiple folder prefixes. */
  episodeTitle?: string
  /** "scene" or "thumbnail" — drives the localStorage key so the user's
   *  scene-side and thumbnail-side style descriptions persist separately
   *  (the two tabs can target different image models, hence different
   *  styles). Falls back to "scene" when absent. */
  kind?: 'scene' | 'thumbnail'
}>()

const { get: apiGet, post, del } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()

const styleText = ref('')
const zoomOpen = ref(false)
const state = ref<PreviewState>({
  loading: false,
  url: null,
  cached: null,
  hash: null,
  model_id: null,
  aspect_ratio: null,
  tier: null,
  signature_at_render: null,
  error: null,
})
const saveState = ref<SaveState>({ saving: false, saved: null, error: null })

// ── Project-level named presets (v1.0.89+) ─────────────────────────────
//
// Shared pool with the Prompts page's "Custom" style dropdown.
// Stored on ProjectConfig.style_presets — iCloud-synced via the project
// folder. Preview PNG (when attached) lives at
// <project>/style-previews/<slug>.png; we serve it through a dedicated
// route so the frontend doesn't have to know the disk layout.
interface StylePresetEntry {
  id: string
  name: string
  description: string
  preview_filename?: string
  preview_model?: string
  preview_aspect_ratio?: string
  preview_tier?: string
  preview_saved_at?: string
}
const presets = ref<StylePresetEntry[]>([])
const selectedPresetId = ref<string>('')
const selectedPreset = computed(() => presets.value.find(p => p.id === selectedPresetId.value) || null)

const presetSaveState = ref({
  modalOpen: false,
  draftName: '',
  saving: false,
  error: null as string | null,
})

async function loadPresets(): Promise<void> {
  try {
    const cfg = await apiGet<{ style_presets?: StylePresetEntry[] }>(
      `/projects/${props.projectSlug}/settings/config`,
    )
    presets.value = Array.isArray(cfg?.style_presets) ? cfg.style_presets! : []
  } catch {
    presets.value = []
  }
}

onMounted(() => { void loadPresets() })
watch(() => props.projectSlug, () => {
  selectedPresetId.value = ''
  void loadPresets()
})

function previewUrlForPreset(p: StylePresetEntry): string {
  return `/api/projects/${props.projectSlug}/style-presets/${encodeURIComponent(p.id)}/preview?t=${encodeURIComponent(p.preview_saved_at || '')}`
}

/**
 * Apply a saved preset — fill the textarea, then show the saved PNG
 * inline if one was attached. We DON'T call /style-preview to re-render;
 * the saved preview IS the cached output. If model/aspect/tier on the
 * page now differ from when the preview was saved, the user can click
 * Re-preview to render against current settings.
 */
function onPresetSelect(id: string): void {
  selectedPresetId.value = id
  const p = presets.value.find(x => x.id === id)
  if (!p) return
  styleText.value = p.description
  if (p.preview_filename) {
    state.value = {
      loading: false,
      url: previewUrlForPreset(p),
      cached: true,
      hash: null,
      model_id: p.preview_model || null,
      aspect_ratio: p.preview_aspect_ratio || null,
      tier: p.preview_tier || null,
      signature_at_render: null, // separate origin — saved preset, not a fresh app-cache hit
      error: null,
    }
    // Reset the per-episode save state — the badge tracked the previous
    // render's save, irrelevant for this just-loaded preset.
    saveState.value = { saving: false, saved: null, error: null }
  } else {
    // Preset has description only (no preview). Clear the thumbnail so
    // the user understands "preview not yet rendered" and clicks the
    // Preview button.
    state.value = {
      loading: false, url: null, cached: null, hash: null,
      model_id: null, aspect_ratio: null, tier: null,
      signature_at_render: null, error: null,
    }
  }
}

function openSavePresetModal(): void {
  presetSaveState.value = {
    modalOpen: true,
    draftName: '',
    saving: false,
    error: null,
  }
}
function closeSavePresetModal(): void {
  presetSaveState.value.modalOpen = false
}

async function confirmSavePreset(): Promise<void> {
  const name = presetSaveState.value.draftName.trim()
  if (!name || presetSaveState.value.saving) return
  presetSaveState.value.saving = true
  presetSaveState.value.error = null
  try {
    const saved = await post<StylePresetEntry>(
      `/projects/${props.projectSlug}/style-presets`,
      {
        name,
        description: styleText.value.trim(),
        // Pass the hash so the backend can copy the cached PNG into the
        // project folder. Backend tolerates missing hash → text-only
        // preset, falls back to no preview file.
        ...(state.value.hash ? { hash: state.value.hash } : {}),
        ...(state.value.model_id ? { preview_model: state.value.model_id } : {}),
        ...(state.value.aspect_ratio ? { preview_aspect_ratio: state.value.aspect_ratio } : {}),
        ...(state.value.tier ? { preview_tier: state.value.tier } : {}),
      },
    )
    presets.value = [...presets.value, saved]
    selectedPresetId.value = saved.id
    presetSaveState.value.modalOpen = false
    success(`Saved style preset "${saved.name}"`)
  } catch (e: any) {
    presetSaveState.value.error = e?.data?.detail || e?.message || 'Save failed'
    showError(presetSaveState.value.error || 'Save failed')
  } finally {
    presetSaveState.value.saving = false
  }
}

async function deleteSelectedPreset(): Promise<void> {
  const p = selectedPreset.value
  if (!p) return
  const ok = await ask({
    title: `Delete style preset "${p.name}"?`,
    body: 'Removes the preset from this project. Any episodes that already used this style stay rendered — the style text was baked into each prompt at render time, so there\'s no live link to break.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await del(`/projects/${props.projectSlug}/style-presets/${encodeURIComponent(p.id)}`)
    presets.value = presets.value.filter(x => x.id !== p.id)
    selectedPresetId.value = ''
    success(`Deleted style preset "${p.name}"`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}

// ── localStorage persistence ───────────────────────────────────────────
//
// Persist the textarea contents per-(project, kind) so a page reload (or
// app restart) doesn't wipe a style description the user iterated on for
// 10 minutes. Scene-tab and thumbnail-tab keys are separate because each
// tab can target a different image model, so the natural style for each
// will diverge (e.g. cartoon for thumbnails, photoreal for scenes).
function storageKey(): string {
  const k = props.kind || 'scene'
  return `storyStudio:styleTag:${props.projectSlug}:${k}`
}

onMounted(() => {
  if (typeof localStorage === 'undefined') return
  try {
    const saved = localStorage.getItem(storageKey())
    if (typeof saved === 'string' && saved.trim()) styleText.value = saved
  } catch { /* localStorage disabled — fall back to empty */ }
})

watch(styleText, (v) => {
  if (typeof localStorage === 'undefined') return
  try {
    if (v && v.trim()) localStorage.setItem(storageKey(), v)
    else localStorage.removeItem(storageKey())
  } catch { /* quota exceeded etc — best effort */ }
})

// When the project slug changes (rare, but happens on multi-project
// dev sessions), re-read from the new project's localStorage entry
// rather than carrying over the previous project's style description.
watch(() => props.projectSlug, () => {
  if (typeof localStorage === 'undefined') return
  try {
    const saved = localStorage.getItem(storageKey())
    styleText.value = (typeof saved === 'string') ? saved : ''
  } catch { styleText.value = '' }
})

// Escape handler for the zoom modal — Vue's @keydown.esc only fires on
// elements that can receive keyboard focus; an unfocused modal misses it.
// Bind to document while the modal is open instead.
watch(zoomOpen, (open) => {
  if (typeof window === 'undefined') return
  if (open) window.addEventListener('keydown', onZoomKeydown)
  else window.removeEventListener('keydown', onZoomKeydown)
})
function onZoomKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') zoomOpen.value = false
}

function currentSignature(): string {
  return [
    styleText.value.trim().toLowerCase(),
    props.model,
    props.aspectRatio,
    props.tier || '',
    props.imageSteps ?? '',
    props.seed ?? '',
  ].join('|')
}

async function generate(): Promise<void> {
  const styleTag = styleText.value.trim()
  if (!styleTag || state.value.loading || !props.model) return
  state.value.loading = true
  state.value.error = null
  try {
    const data = await post<{
      hash: string; url: string; cached: boolean
      model_id: string; aspect_ratio: string; tier: string
      created_at: string; size_bytes: number
    }>(`/projects/${props.projectSlug}/style-preview`, {
      style_tag: styleTag,
      model: props.model,
      aspect_ratio: props.aspectRatio,
      tier: props.tier || undefined,
      image_steps: props.imageSteps,
      seed: props.seed ?? undefined,
    })
    state.value = {
      loading: false,
      url: data.url,
      cached: !!data.cached,
      hash: data.hash,
      model_id: data.model_id,
      aspect_ratio: data.aspect_ratio,
      tier: data.tier || null,
      signature_at_render: currentSignature(),
      error: null,
    }
  } catch (e: any) {
    state.value = {
      ...state.value,
      loading: false,
      error: e?.data?.detail || e?.message || 'Preview failed',
    }
  }
}

// Clear the rendered thumbnail when ANY input that affects the cache key
// changes. Avoids the misleading "this preview matches your current
// settings" implication when the sample on screen no longer matches what
// would be rendered now. Also clears the saved-to-episode badge so the
// user knows the next save will write a fresh file.
watch([
  styleText,
  () => props.model,
  () => props.aspectRatio,
  () => props.tier,
  () => props.imageSteps,
  () => props.seed,
], () => {
  if (state.value.signature_at_render &&
      state.value.signature_at_render !== currentSignature()) {
    state.value.url = null
    state.value.cached = null
    state.value.hash = null
    state.value.model_id = null
    state.value.aspect_ratio = null
    state.value.tier = null
    state.value.signature_at_render = null
    saveState.value = { saving: false, saved: null, error: null }
    zoomOpen.value = false
  }
})

/**
 * Copy the currently-rendered style preview PNG into the active episode's
 * scene-images folder. The on-disk filename encodes the episode + model +
 * aspect + tier so saved previews are self-describing when the user
 * opens the folder in Finder later.
 *
 * Backend: POST /projects/:slug/episodes/:id/style-preview-save with the
 * cache hash. The backend resolves the cached file by hash, validates
 * the episode dir, and writes a copy with a stable name. The cache
 * entry stays in the global pool — this is a SAVE, not a move.
 */
async function saveToEpisode(): Promise<void> {
  if (!props.episodeId || !state.value.hash || saveState.value.saving) return
  saveState.value = { saving: true, saved: null, error: null }
  try {
    const r = await post<{ filename: string; path: string }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/style-preview-save`,
      {
        hash: state.value.hash,
        title: props.episodeTitle || '',
        kind: props.kind || 'scene',
      },
    )
    saveState.value = { saving: false, saved: r.filename, error: null }
    success(`Saved preview to ${r.filename}`)
  } catch (e: any) {
    const msg = e?.data?.detail || e?.message || 'Save failed'
    saveState.value = { saving: false, saved: null, error: msg }
    showError(msg)
  }
}
</script>

<style scoped>
.spc { padding: 12px 14px; }
.spc-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.spc-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.spc-blurb {
  margin: 4px 0 8px 0;
}
.spc-textarea {
  width: 100%;
  font-size: 12px;
  resize: vertical;
}
.spc-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.spc-error {
  font-size: 11px;
  color: rgb(220, 38, 38);
  cursor: help;
}
.spc-thumb-wrap {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}
.spc-thumb-btn {
  position: relative;
  padding: 0;
  background: none;
  border: none;
  cursor: zoom-in;
  display: block;
  line-height: 0;
}
.spc-thumb-btn:hover .spc-thumb { border-color: var(--accent, #6c8fff); }
.spc-thumb-btn:hover .spc-thumb-zoom-hint { opacity: 1; }
.spc-thumb {
  width: 200px;
  height: 200px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  transition: border-color 0.15s;
}
.spc-thumb-zoom-hint {
  position: absolute;
  right: 6px; bottom: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.spc-save-btn { font-size: 11px; }

/* Zoom modal — full-bleed backdrop, scaled-to-fit image, close on
   backdrop click / Escape. Keeps the gallery's existing
   ImagePreviewLightbox intact; this is the lighter ad-hoc variant for
   one-off style samples. */
.spc-zoom-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.78);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
  padding: 32px;
}
.spc-zoom-card {
  position: relative;
  max-width: 95vw;
  max-height: 90vh;
  display: flex; flex-direction: column;
  align-items: center;
  gap: 6px;
}
.spc-zoom-img {
  max-width: 100%;
  max-height: 80vh;
  object-fit: contain;
  border-radius: var(--radius-md);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
}
.spc-zoom-meta {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  font-family: var(--font-mono, monospace);
}
.spc-zoom-meta code {
  background: rgba(255, 255, 255, 0.10);
  padding: 1px 5px;
  border-radius: 3px;
}
.spc-zoom-close {
  position: absolute;
  top: -36px;
  right: -4px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #fff;
  width: 32px; height: 32px;
  border-radius: 50%;
  font-size: 20px;
  cursor: pointer;
  line-height: 28px;
  padding: 0;
}
.spc-zoom-close:hover { background: rgba(255, 255, 255, 0.22); }

/* Project preset picker — sits above the style textarea. */
.spc-presets-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 4px 0 8px;
  font-size: 12px;
}
.spc-presets-label { color: var(--text-muted); }
.spc-presets-select {
  font-size: 12px;
  padding: 3px 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  flex: 1 1 240px;
  min-width: 200px;
}
.spc-presets-delete { font-size: 11px; color: var(--error, #e25c5c); }
.spc-presets-delete:hover { background: rgba(226, 92, 92, 0.08); }

/* Save-as-preset modal */
.spc-preset-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  padding: 18px 22px;
  width: min(500px, 92vw);
  display: flex; flex-direction: column; gap: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}
.spc-preset-modal h4 { margin: 0; font-size: 14px; color: var(--text-primary); }
.spc-preset-modal-actions {
  display: flex; justify-content: flex-end; gap: 8px;
  margin-top: 6px;
}
.spc-thumb-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.spc-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  font-family: var(--font-mono, monospace);
}
.spc-tag.is-cache {
  background: rgba(16, 185, 129, 0.10);
  color: rgb(16, 185, 129);
  border: 1px solid rgba(16, 185, 129, 0.28);
}
.spc-tag.is-fresh {
  background: rgba(245, 158, 11, 0.10);
  color: rgb(180, 120, 8);
  border: 1px solid rgba(245, 158, 11, 0.28);
}
</style>
