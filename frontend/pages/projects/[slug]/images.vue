<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Images</h1>
    </div>
    <!-- Live download speed for the running image-generation job. Only
         visible while bytes are flowing in from the provider CDN; auto-
         hides between jobs. Hover any metric for an inline explainer. -->
    <AssetDownloadStrip :job-types="['images', 'scene_images', 'thumb_images', 'images_repair']" />
    <TopActionBar
      :project-slug="slug"
      :presets="imgPresets"
      v-model:episode-id="form.episode_id"
      :filter-field="form.mode === 'thumbs' ? 'thumbnails' : 'images'"
      :generate-label="generateButtonLabel"
      loading-label="Queuing…"
      :generate-loading="submitting"
      :generate-disabled="!form.episode_id"
      :generate-status="generating ? `${generatingLabel} for ${form.episode_id}…` : ''"
      @generate="submit"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted mt-1 mb-2">Generate scene and thumbnail artwork from your prompts via kie.ai.</p>

    <!-- Mode tabs — replaces three separate pages -->
    <div class="mode-tabs mt-3" role="tablist" aria-label="Image generation mode">
      <button
        v-for="tab in modeTabs" :key="tab.id"
        :class="['mode-tab', { active: form.mode === tab.id }]"
        role="tab"
        :aria-selected="form.mode === tab.id"
        @click="selectMode(tab.id)"
      >
        <span class="mode-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
        <span class="mode-tab-label">{{ tab.label }}</span>
        <span class="mode-tab-hint">{{ tab.hint }}</span>
      </button>
    </div>

    <div class="card mt-2">
      <div class="grid-2">
        <div class="form-group">
          <label>Image Model <span class="required" aria-hidden="true">*</span></label>
          <select v-model="form.model" class="select">
            <optgroup v-for="g in imageModelGroups" :key="g.provider" :label="g.label">
              <option v-for="m in g.items" :key="m.id" :value="m.id">
                {{ formatModelOption(m) }}
              </option>
            </optgroup>
          </select>
          <span v-if="form.mode === 'thumbs'" class="text-muted text-xs">
            Tip: Use a higher-quality model for eye-catching thumbnails
          </span>
        </div>

        <!-- Tier picker — only renders for variable-priced models that
             carry a `tiers[]` array (resolution/speed/etc.). Flat-priced
             models hide it entirely. Inline cost preview ("8 cr · ~$0.04")
             keeps the explain-as-you-go expectation: every option shows
             both credits and rough USD so the user can compare without
             pulling out a calculator. -->
        <div v-if="modelTiers.length > 0" class="form-group">
          <label>{{ modelTierLabel }}</label>
          <div class="tier-picker">
            <label
              v-for="t in modelTiers"
              :key="t.id"
              class="tier-option"
              :class="{ active: form.tier === t.id }"
            >
              <input type="radio" :value="t.id" v-model="form.tier" />
              <span class="tier-option-label">{{ t.label }}</span>
              <span class="tier-option-cost">{{ t.credits }} cr · ~{{ formatUsd(t.credits) }}</span>
            </label>
          </div>
        </div>
      </div>

      <div class="grid-3">
        <div class="form-group">
          <label>Aspect Ratio</label>
          <select v-model="form.aspect_ratio" class="select">
            <option v-for="ar in aspectRatios" :key="ar.value" :value="ar.value">
              {{ ar.value }} — {{ ar.label }}
            </option>
          </select>
        </div>
        <div class="form-group">
          <label>Specific # (optional)</label>
          <input
            v-model.number="specificNum"
            class="input"
            type="number"
            min="1"
            :placeholder="specificPlaceholder"
          />
        </div>
      </div>

      <!-- Generation Mode (M6): single tri-state replaces the `force`
           checkbox. Backend payload is unchanged — translation happens at
           submit. NOTE: today the image generator skips existing files by
           default, so 'skip' and 'new_version' behave identically until
           generators/images.ts learns _v2 naming. The UI option is kept
           visible so the surface is consistent with audio. -->
      <div class="form-group">
        <label>Generation Mode</label>
        <div class="generation-mode-row">
          <label class="generation-mode-option">
            <input type="radio" value="skip" v-model="form.generation_mode" />
            <div>
              <strong>Skip existing</strong>
              <span class="text-muted">Don't regenerate scenes/thumbs that already exist.</span>
            </div>
          </label>
          <label class="generation-mode-option">
            <input type="radio" value="regenerate" v-model="form.generation_mode" />
            <div>
              <strong>Regenerate</strong>
              <span class="text-muted">Overwrite existing variants in place.</span>
            </div>
          </label>
          <label class="generation-mode-option">
            <input type="radio" value="new_version" v-model="form.generation_mode" />
            <div>
              <strong>New version</strong>
              <span class="text-muted">Currently behaves like Skip — _v2 image variants are planned.</span>
            </div>
          </label>
        </div>
      </div>

    </div>

    <!-- Image integrity pill + Repair. Generators skip existing non-empty -->
    <!-- files natively, so Repair = re-submit the same form with force=false. -->
    <div v-if="form.episode_id" class="card mt-2" aria-labelledby="image-integrity-heading">
      <h3 id="image-integrity-heading" class="integrity-title">Image integrity</h3>
      <p class="text-muted text-sm integrity-blurb">
        Check whether every expected image is on disk. <strong>Repair missing</strong>
        queues a new job with the current form settings — the generator automatically
        skips scenes/thumbnails that already have ≥1 variant with content.
      </p>

      <div v-if="imageStatus.loading" class="text-muted text-md">
        <LoadingSpinner size="sm" /> Checking…
      </div>

      <div v-else-if="imageStatus.error" class="text-danger text-md">
        {{ imageStatus.error }}
        <button class="btn btn-sm btn-ghost ml-2" @click="refreshImageStatus">Retry</button>
      </div>

      <div v-else-if="!imageStatus.hasAny" class="text-muted text-md">
        No scene or thumbnail prompts found for this episode yet. Generate prompts
        first on the <NuxtLink :to="`/projects/${slug}/image-prompts`">Image Prompts</NuxtLink> page.
      </div>

      <div v-else class="flex items-center gap-2 flex-wrap">
        <span v-if="imageStatus.scenes" class="integrity-pill" :class="imageStatus.scenes.missing.length ? 'warn' : 'ok'">
          <template v-if="imageStatus.scenes.missing.length === 0">✓ {{ imageStatus.scenes.total }} scenes present</template>
          <template v-else>⚠ {{ imageStatus.scenes.missing.length }} of {{ imageStatus.scenes.total }} scenes missing</template>
        </span>
        <span v-if="imageStatus.thumbnails" class="integrity-pill" :class="imageStatus.thumbnails.missing.length ? 'warn' : 'ok'">
          <template v-if="imageStatus.thumbnails.missing.length === 0">✓ {{ imageStatus.thumbnails.total }} thumbnails present</template>
          <template v-else>⚠ {{ imageStatus.thumbnails.missing.length }} of {{ imageStatus.thumbnails.total }} thumbnails missing</template>
        </span>

        <button
          v-if="imageStatus.hasMissing"
          class="btn btn-sm btn-secondary"
          :disabled="submitting || generating"
          @click="repairMissing"
        >
          Repair missing ({{ imageStatus.totalMissing }})
        </button>

        <button class="btn btn-sm btn-ghost" :disabled="imageStatus.loading" @click="refreshImageStatus">
          Refresh
        </button>
      </div>

      <div v-if="imageStatus.missingScenesList || imageStatus.missingThumbsList" class="missing-detail mt-2">
        <div v-if="imageStatus.missingScenesList" class="text-muted text-sm">
          Missing scenes: {{ imageStatus.missingScenesList }}
        </div>
        <div v-if="imageStatus.missingThumbsList" class="text-muted text-sm">
          Missing thumbnails: {{ imageStatus.missingThumbsList }}
        </div>
      </div>
    </div>

    <!-- ── Edit existing image (AI clean-up / removal) ────────────────────
         Tile grid that lists already-generated scenes + thumbnails and
         opens the shared ImageEditDialog on click. Audit pain-point #14. -->
    <div v-if="form.episode_id" class="card mt-2">
      <div class="card-header">
        <h3>Edit Existing Images</h3>
        <button
          class="btn btn-sm btn-ghost"
          :disabled="editScanLoading"
          :title="editScanLoading ? 'Refreshing…' : 'Re-scan the disk for newly-generated images'"
          @click="loadEditScan"
        >
          <LoadingSpinner v-if="editScanLoading" size="sm" />
          <span v-else aria-hidden="true">↻</span>
          Refresh
        </button>
      </div>
      <p class="text-muted text-sm mt-1">
        Click any image to clean up unwanted text, watermarks, or details with AI.
        Each edit is saved as <code>_edited_v1.png</code> next to the original — no destructive overwrites.
      </p>

      <div v-if="editScanError" class="text-danger text-sm mt-2">{{ editScanError }}</div>

      <!-- Scenes -->
      <div v-if="editScenes.length" class="mt-2">
        <h4 class="edit-grid-heading">Scenes ({{ editScenes.length }})</h4>
        <div class="edit-image-grid">
          <button
            v-for="scn in editScenes"
            :key="scn.path"
            type="button"
            class="edit-image-tile"
            :title="`Preview ${scn.filename}`"
            @click="openLightboxAt(scn.path)"
          >
            <img :src="getImagePreviewUrlImages(scn.path)" :alt="scn.filename" class="edit-image-thumb" />
            <span class="edit-image-label">S{{ scn.scene_number ?? '?' }}</span>
          </button>
        </div>
      </div>

      <!-- Thumbnails -->
      <div v-if="editThumbs.length" class="mt-2">
        <h4 class="edit-grid-heading">Thumbnails ({{ editThumbs.length }})</h4>
        <div class="edit-image-grid">
          <button
            v-for="(thumb, ti) in editThumbs"
            :key="thumb.path"
            type="button"
            class="edit-image-tile"
            :title="`Preview ${thumb.filename}`"
            @click="openLightboxAt(thumb.path)"
          >
            <img :src="getImagePreviewUrlImages(thumb.path)" :alt="thumb.filename" class="edit-image-thumb" />
            <span class="edit-image-label">T{{ ti + 1 }}</span>
          </button>
        </div>
      </div>

      <p
        v-if="!editScenes.length && !editThumbs.length && !editScanLoading && !editScanError"
        class="text-muted text-sm mt-2"
      >
        No images on disk yet for {{ form.episode_id }}. Generate some first using the form above.
      </p>
    </div>

    <!-- Contextual help -->
    <div class="help-note mt-2">
      <span class="help-icon" aria-hidden="true">💡</span>
      <div>
        <strong>Need prompts first?</strong>
        Generate image prompts for this episode on the
        <NuxtLink :to="`/projects/${slug}/image-prompts`">Image Prompts</NuxtLink>
        page before running image generation.
      </div>
    </div>

    <!-- Lightbox: fullscreen preview + carousel. Tile clicks open this -->
    <!-- first; the user browses / decides, then triggers Edit which -->
    <!-- closes the lightbox and opens ImageEditDialog on the same path. -->
    <ImagePreviewLightbox
      v-model:visible="lightboxOpen"
      v-model:index="lightboxIndex"
      :images="allEditableImages"
      :project-slug="slug"
      @edit="onLightboxEdit"
    />

    <!-- Shared AI image-edit dialog. Mounted once at the page root; -->
    <!-- triggered from inside the lightbox (Edit with AI button / Enter). -->
    <ImageEditDialog
      v-model="imageEditOpen"
      :project-slug="slug"
      :image-path="imageEditTarget || ''"
      @accepted="onImageEditAccepted"
    />

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Images')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, get } = useApi()
const { config } = useProject()

// All image models currently go via kie.ai. Grouping future-proofs the
// dropdown for when a second provider is added.
const imageModelGroups = computed(() => groupModels(config.value?.image_models, () => 'kie'))
const { success, error: showError } = useToast()
const { imageGenerating, thumbImageGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()

const submitting = ref(false)
const specificNum = ref<number | null>(null)

type Mode = 'all' | 'scenes' | 'thumbs'

const form = reactive({
  episode_id: '',
  model: 'grok-imagine',
  mode: 'all' as Mode,
  aspect_ratio: '16:9',
  // Unified Generation Mode (M6) — replaces the standalone `force` checkbox.
  // Translated to `force` at submit time; the backend's image generator
  // (generators/images.ts) only knows about that boolean today, so this
  // is purely a UI consolidation. Default 'skip' matches the prior
  // default behaviour (force=false).
  generation_mode: 'skip' as 'skip' | 'regenerate' | 'new_version',
  // Tier id for variable-priced kie.ai models (nano-banana-2 1k/2k/4k,
  // ideogram-v3 turbo/balanced/quality, etc.). Flat-priced models ignore
  // this. Reset on model switch via the watcher below.
  tier: '' as string,
})

// Per-credit USD rate at kie.ai (1 credit = $0.005, verified across the
// 2026-04-28 pricing-page audit). Plumbed here so the dropdown labels
// + tier picker share one source of truth — change in one place if the
// rate shifts.
const KIE_USD_PER_CREDIT = 0.005
function formatUsd(credits: number): string {
  if (!credits || credits <= 0) return ''
  const usd = credits * KIE_USD_PER_CREDIT
  // 3 decimals for sub-penny prices (z-image at $0.004), 2 otherwise.
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}

// Renders a single line for the model dropdown. For tiered models we
// show a price RANGE (cheapest tier → priciest) so the user sees at a
// glance that the cost varies with resolution/speed; the tier picker
// below the dropdown locks in the actual choice. Flat-priced models
// just show one number.
function formatModelOption(m: { data: any }): string {
  const d = m.data
  if (Array.isArray(d.tiers) && d.tiers.length > 1) {
    const credits = d.tiers.map((t: any) => t.credits)
    const min = Math.min(...credits)
    const max = Math.max(...credits)
    return `${d.label} (${min}–${max} cr · ${formatUsd(min)}–${formatUsd(max)})`
  }
  return `${d.label} (${d.credits_per_image} cr · ${formatUsd(d.credits_per_image)})`
}

// Tier helpers — exposed to the template via computeds so the picker
// renders only when the active model has tiers.
const modelTiers = computed<{ id: string; label: string; credits: number }[]>(() => {
  const m = config.value?.image_models?.[form.model] as any
  return Array.isArray(m?.tiers) ? m.tiers : []
})
const modelTierLabel = computed(() => {
  // Naming the picker by axis: "Resolution" if tier ids look like 1k/2k/4k,
  // "Quality" for turbo/balanced/quality, generic "Tier" otherwise. Keeps
  // the label descriptive without forcing per-model schema config.
  const ids = modelTiers.value.map(t => t.id.toLowerCase())
  if (ids.some(id => /^\d+k(-\d+k)?$/.test(id))) return 'Resolution'
  if (ids.some(id => ['turbo', 'balanced', 'quality'].includes(id))) return 'Quality'
  return 'Tier'
})

// When the active model changes, snap the tier selection back to the new
// model's default_tier (or first tier, or empty). Without this, switching
// from gpt-image-2 (default '1k') to ideogram-v3 (default 'balanced')
// would leave form.tier='1k', which isn't a valid ideogram tier.
watch(() => form.model, () => {
  const m = config.value?.image_models?.[form.model] as any
  const tiers = Array.isArray(m?.tiers) ? m.tiers : []
  if (!tiers.length) {
    form.tier = ''
    return
  }
  const def = tiers.find((t: any) => t.id === m.default_tier) ?? tiers[0]
  form.tier = def?.id || ''
}, { immediate: true })

// ── Presets ─────────────────────────────────────────────────────────────
const imgPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'image_generator',
  snapshot: () => ({ form: { ...form } }),
  apply: (data) => { if (data?.form) Object.assign(form, data.form) },
})
onMounted(() => imgPresets.load())

const modeTabs: Array<{ id: Mode; label: string; icon: string; hint: string }> = [
  { id: 'all',    label: 'Both',        icon: '🖼️', hint: 'Scenes + Thumbnails' },
  { id: 'scenes', label: 'Scenes',      icon: '🎬', hint: 'Story artwork only' },
  { id: 'thumbs', label: 'Thumbnails',  icon: '📸', hint: 'YouTube thumbnails only' },
]

const aspectRatios = computed(() => {
  if (form.mode === 'thumbs') {
    return [
      { value: '16:9', label: 'YouTube Thumbnail' },
      { value: '1:1',  label: 'Square' },
      { value: '4:3',  label: 'Classic' },
    ]
  }
  return [
    { value: '16:9',  label: 'Landscape' },
    { value: '1:1',   label: 'Square' },
    { value: '9:16',  label: 'Portrait' },
    { value: '4:3',   label: 'Standard' },
    { value: '3:4',   label: 'Tall' },
    { value: '21:9',  label: 'Ultrawide' },
  ]
})

const specificPlaceholder = computed(() => {
  if (form.mode === 'scenes') return 'All scenes'
  if (form.mode === 'thumbs') return 'All thumbnails'
  return 'All'
})

const generateButtonLabel = computed(() => {
  if (form.mode === 'scenes') return 'Generate Scene Images'
  if (form.mode === 'thumbs') return 'Generate Thumbnail Images'
  return 'Generate Images (Scenes + Thumbnails)'
})

const generatingLabel = computed(() => {
  if (form.mode === 'scenes') return 'Generating scene images'
  if (form.mode === 'thumbs') return 'Generating thumbnail images'
  return 'Generating images'
})

const generating = computed(() => {
  if (form.mode === 'scenes') return imageGenerating.value
  if (form.mode === 'thumbs') return thumbImageGenerating.value
  return imageGenerating.value || thumbImageGenerating.value
})

function selectMode(m: Mode) {
  form.mode = m
  specificNum.value = null
  // Reset aspect ratio to the default for this mode
  if (m === 'thumbs' && !['16:9', '1:1', '4:3'].includes(form.aspect_ratio)) {
    form.aspect_ratio = '16:9'
  }
}

function getConfirmationType(): 'scene_images' | 'thumb_images' | 'images' {
  if (form.mode === 'scenes') return 'scene_images'
  if (form.mode === 'thumbs') return 'thumb_images'
  return 'images'
}

// ── Image integrity pill ────────────────────────────────────────────────
// Fetches asset-status when episode changes. Repair just re-submits the
// same form — `fileExistsWithContent` in the generator means existing
// files are skipped, so only missing ones get regenerated.
interface ImageStatusState {
  loading: boolean
  error: string
  hasAny: boolean       // whether any prompts were found
  scenes: { total: number; present: number; missing: number[] } | null
  thumbnails: { total: number; present: number; missing: number[] } | null
  hasMissing: boolean
  totalMissing: number
  missingScenesList: string    // "3, 7, 12" for the UI
  missingThumbsList: string
}
const imageStatus = reactive<ImageStatusState>({
  loading: false, error: '', hasAny: false,
  scenes: null, thumbnails: null,
  hasMissing: false, totalMissing: 0,
  missingScenesList: '', missingThumbsList: '',
})

async function refreshImageStatus() {
  if (!form.episode_id) return
  imageStatus.loading = true
  imageStatus.error = ''
  try {
    const r = await get<any>(`/projects/${slug.value}/episodes/${form.episode_id}/image-status`)
    imageStatus.scenes = r.scenes ?? null
    imageStatus.thumbnails = r.thumbnails ?? null
    imageStatus.hasAny = !!(r.scenes || r.thumbnails)
    const missScene = imageStatus.scenes?.missing.length ?? 0
    const missThumb = imageStatus.thumbnails?.missing.length ?? 0
    imageStatus.hasMissing = missScene + missThumb > 0
    imageStatus.totalMissing = missScene + missThumb
    imageStatus.missingScenesList = missScene > 0 ? imageStatus.scenes!.missing.join(', ') : ''
    imageStatus.missingThumbsList = missThumb > 0 ? imageStatus.thumbnails!.missing.join(', ') : ''
  } catch (e: any) {
    imageStatus.error = e?.data?.detail || e?.message || 'Could not check image integrity'
  } finally {
    imageStatus.loading = false
  }
}

async function repairMissing() {
  // Calls the dedicated repair endpoint (not the generation endpoint).
  // The reconciler downloads from already-paid-for provider task records
  // and never re-submits the prompt — zero credit cost.
  //
  // Files without a stored task id (generated before recordTask() was
  // wired up, or never generated at all) come back as
  // "needs_fresh_generation" — the user sees a clear message in the job
  // log telling them to click Generate for those specific items.
  submitting.value = true
  try {
    await post(`/projects/${slug.value}/generate/images-repair`, { episode_id: form.episode_id })
    success(`Repair job queued — recovers from provider history (no credit cost). Check the Jobs tab.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue repair')
  } finally {
    submitting.value = false
  }
}

// ── Edit-existing-images grid (audit pain-point #14) ─────────────────────
// Reuses the same `/video-editor/scan/{episodeId}` endpoint Video Assembly
// uses to enumerate already-on-disk images. Cheap (one read of the
// scenes / thumbnails subfolders) so re-fetching after each accepted edit
// is fine.
//
// IMPORTANT: declared BEFORE the episode-id watcher below. Earlier this
// block lived after the watch, but `{ immediate: true }` fires the watch
// synchronously during setup — and the watch's else-branch touches
// `editScenes.value`. With the refs declared after, that synchronous fire
// hit a temporal dead zone and crashed the whole page on first load.
interface ScannedImage { filename: string; path: string; scene_number?: number | null }
const editScenes = ref<ScannedImage[]>([])
const editThumbs = ref<ScannedImage[]>([])
const editScanLoading = ref(false)
const editScanError = ref('')

async function loadEditScan() {
  if (!form.episode_id) return
  editScanLoading.value = true
  editScanError.value = ''
  try {
    const r = await get<{ scenes?: ScannedImage[]; thumbnails?: ScannedImage[] }>(
      `/projects/${slug.value}/video-editor/scan/${form.episode_id}`,
    )
    editScenes.value = (r.scenes || []).slice().sort(
      (a, b) => (a.scene_number ?? 999) - (b.scene_number ?? 999),
    )
    editThumbs.value = r.thumbnails || []
  } catch (e: any) {
    console.error('[images/edit-scan] failed:', e)
    editScanError.value = e?.data?.detail || e?.message || 'Could not list existing images'
  } finally {
    editScanLoading.value = false
  }
}

const imageEditOpen = ref(false)
const imageEditTarget = ref<string | null>(null)
function openEditOnPath(path: string) {
  imageEditTarget.value = path
  imageEditOpen.value = true
}

// ── Lightbox / carousel (preview-then-edit flow) ─────────────────────────
// Tile clicks now open this fullscreen preview first. The user browses
// with ← / → and Esc-closes; the "Edit with AI" CTA inside the lightbox
// closes itself and forwards to openEditOnPath() above.
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)

/**
 * Flat list backing the lightbox carousel. Order matches the on-page grid
 * — scenes first (sorted by scene_number), then thumbnails — so left/right
 * arrow navigation feels predictable. Section + scene_number ride along
 * for the position-indicator label inside the lightbox.
 */
interface LightboxImage {
  filename: string
  path: string
  section: 'scenes' | 'thumbnails'
  scene_number?: number | null
}
const allEditableImages = computed<LightboxImage[]>(() => {
  const out: LightboxImage[] = []
  for (const s of editScenes.value) {
    out.push({ filename: s.filename, path: s.path, section: 'scenes', scene_number: s.scene_number ?? null })
  }
  for (const t of editThumbs.value) {
    out.push({ filename: t.filename, path: t.path, section: 'thumbnails' })
  }
  return out
})

function openLightboxAt(path: string) {
  const i = allEditableImages.value.findIndex(img => img.path === path)
  lightboxIndex.value = i >= 0 ? i : 0
  lightboxOpen.value = true
}

/**
 * Wired to the lightbox's `edit` emit. Sequence matters: close the
 * lightbox first so its document-level keydown listener detaches before
 * ImageEditDialog mounts. Otherwise ArrowLeft inside the dialog's prompt
 * textarea would also navigate the lightbox in the background.
 */
function onLightboxEdit(path: string) {
  lightboxOpen.value = false
  openEditOnPath(path)
}
function onImageEditAccepted(newPath: string) {
  // After an edit, refresh the grid so the new `_edited_v1.png` (or its
  // replaced original) shows up. The grid uses absolute paths as keys, so
  // an existing tile updates in place when the path stays the same.
  void loadEditScan()
  // Bust the preview-img cache for the affected path so the displayed
  // thumbnail reflects the new content. _editKey changes drive the
  // `getImagePreviewUrlImages` cache-busting query param below.
  _editKey.value++
  void newPath
}

// Cache-buster bumped after each accepted edit so <img> tags re-fetch.
const _editKey = ref(0)
function getImagePreviewUrlImages(path: string): string {
  return `/api/projects/${slug.value}/video-editor/preview-image?path=${encodeURIComponent(path)}&k=${_editKey.value}`
}

// Episode-id watcher MUST come after the editScenes/editThumbs
// declarations above — `{ immediate: true }` fires this synchronously
// during setup, and the else-branch reads those refs. See comment above.
watch(() => form.episode_id, (v) => {
  if (v) {
    refreshImageStatus()
    void loadEditScan()
  } else {
    editScenes.value = []
    editThumbs.value = []
  }
}, { immediate: true })

async function submit() {
  // Translate Generation Mode (M6) → backend `force`. The image generator
  // doesn't have _v2 file naming yet, so 'new_version' currently maps to
  // 'skip' until that lands; the radio option is documented to that effect.
  const force = form.generation_mode === 'regenerate'
  const params: any = {
    episode_id: form.episode_id,
    model: form.model,
    mode: form.mode,
    aspect_ratio: form.aspect_ratio,
    force,
  }
  // Forward tier only when the active model has tiers. Flat-priced models
  // ignore the field server-side, but sending it would clutter the request
  // log + the cost-confirmation receipt with a meaningless ' · ' suffix.
  if (form.tier) params.tier = form.tier

  // Send the right optional # field per mode
  if (specificNum.value) {
    if (form.mode === 'thumbs') params.thumb_number = specificNum.value
    else params.scene_number = specificNum.value
  }

  if (!await confirmGeneration(slug.value, getConfirmationType(), params)) return

  submitting.value = true
  if (form.mode === 'thumbs') thumbImageGenerating.value = true
  else imageGenerating.value = true

  try {
    await post(`/projects/${slug.value}/generate/images`, params)
    success('Image generation queued!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to queue image generation')
    imageGenerating.value = false
    thumbImageGenerating.value = false
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* "Image integrity" card title and blurb beneath it. */
.integrity-title { margin-bottom: 6px; }
.integrity-blurb { margin-bottom: 10px; }

/* Edit-existing-images grid — section heading + tile grid. Tiles match
 * the size of the title-image picker in Video Assembly so the visual
 * vocabulary is consistent across pages. */
.edit-grid-heading {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin-bottom: 6px;
  font-weight: 600;
}
.edit-image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}
.edit-image-tile {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-md);
  border: 2px solid var(--border);
  background: var(--bg-tertiary);
  cursor: pointer;
  overflow: hidden;
  padding: 0;
  transition: border-color 0.15s, transform 0.15s;
}
.edit-image-tile:hover {
  border-color: var(--accent);
  transform: scale(1.02);
}
.edit-image-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.edit-image-label {
  position: absolute;
  bottom: 4px;
  left: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}

.required { color: var(--error); margin-left: 2px; }

/* Generation Mode (M6) — three-up radio cards. Mirror of audio.vue;
   if more pages adopt this control later, lift to a shared component. */
.generation-mode-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 4px;
}
@media (max-width: 720px) {
  .generation-mode-row { grid-template-columns: 1fr; }
}
.generation-mode-option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.generation-mode-option:has(input:checked) {
  border-color: var(--accent);
  background: rgba(96, 165, 250, 0.08);
}
.generation-mode-option input { margin-top: 2px; }
.generation-mode-option strong { display: block; font-size: 13px; color: var(--text-primary); }
.generation-mode-option .text-muted { display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px; }

/* Tier picker — compact pill row sized to fit alongside the model
   dropdown. Matches the generation-mode option look but without the
   helper-text line, since each tier already shows credits + USD. */
.tier-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tier-option {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  cursor: pointer;
  font-size: 12px;
  transition: border-color .12s, background .12s;
}
.tier-option:hover { border-color: var(--accent); }
.tier-option.active {
  border-color: var(--accent);
  background: rgba(240, 198, 116, 0.10);
}
.tier-option input { margin: 0; }
.tier-option-label { font-weight: 600; color: var(--text-primary); }
.tier-option-cost { color: var(--text-muted); font-size: 11px; }

.integrity-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid transparent;
}
.integrity-pill.ok {
  background: rgba(34, 197, 94, 0.12);
  color: rgb(22, 163, 74);
  border-color: rgba(34, 197, 94, 0.3);
}
.integrity-pill.warn {
  background: rgba(245, 158, 11, 0.14);
  color: rgb(180, 83, 9);
  border-color: rgba(245, 158, 11, 0.35);
}
.missing-detail { font-family: var(--font-mono, monospace); }

.mode-tabs {
  display: flex;
  gap: 6px;
  background: var(--bg-tertiary);
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
}
.mode-tab {
  flex: 1;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  transition: all 0.15s;
}
.mode-tab:hover { color: var(--text-primary); background: var(--bg-hover); }
.mode-tab.active {
  background: var(--accent-dim);
  color: var(--accent);
  border-color: rgba(240, 198, 116, 0.3);
}
.mode-tab-icon { font-size: 18px; }
.mode-tab-label { font-weight: 600; font-size: 13px; }
.mode-tab-hint { font-size: 11px; color: var(--text-muted); }
.mode-tab.active .mode-tab-hint { color: var(--accent); opacity: 0.8; }

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-muted);
}

.generating-status { display: flex; flex-direction: column; gap: 4px; }
.gen-label { font-size: 12px; color: var(--accent); }
.progress-bar { height: 3px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; animation: progressIndeterminate 1.5s ease-in-out infinite; }
@keyframes progressIndeterminate { 0% { width: 0%; margin-left: 0; } 50% { width: 60%; margin-left: 20%; } 100% { width: 0%; margin-left: 100%; } }

.help-note {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-secondary);
}
.help-note strong { color: var(--text-primary); }
.help-note a { color: var(--accent); }
.help-icon { font-size: 16px; }
</style>
