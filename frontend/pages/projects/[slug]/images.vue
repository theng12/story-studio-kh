<template>
  <div class="workspace-page creation-workspace thumbnail-generator-workspace">
    <WorkspaceHero
      eyebrow="Create · Render"
      title="Thumbnail Generator"
      description="Render finished YouTube thumbnail artwork from the approved thumbnail prompts."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Image generator context">
          <span class="workspace-metric" :data-tone="form.episode_id ? 'success' : 'warning'"><strong>{{ form.episode_id || 'No episode' }}</strong> target</span>
          <span class="workspace-metric" data-tone="info"><strong>Thumbnail artwork</strong> workflow</span>
          <span class="workspace-metric" :data-tone="activeMissingCount ? 'warning' : 'success'"><strong>{{ activeMissingCount }}</strong> missing</span>
        </div>
      </template>
    </WorkspaceHero>
    <!-- Live download speed for the running image-generation job. Only
         visible while bytes are flowing in from the provider CDN; auto-
         hides between jobs. Hover any metric for an inline explainer. -->
    <AssetDownloadStrip :job-types="['images', 'scene_images', 'thumb_images', 'images_repair']" />
    <div class="workspace-command-surface creation-command-surface">
      <TopActionBar
      :project-slug="slug"
      :presets="imgPresets"
      v-model:episode-id="form.episode_id"
      filter-field="thumbnails"
      :generate-label="generateButtonLabel"
      :generate-loading="submitting || imageJobActiveForEpisode"
      :generate-disabled="!form.episode_id"
      :generate-status="(generating || imageJobActiveForEpisode) ? `${generatingLabel} for ${form.episode_id}…` : ''"
      @generate="submit"
    >
      <template #actions>
        <EpisodeImportButton
          :slug="slug"
          :episode-code="form.episode_id"
          default-tab="thumb"
          @imported="() => { refreshImageStatus(); onPanelRefresh() }"
        />
      </template>
      </TopActionBar>
      <p class="workspace-command-copy">
        Choose the episode and render model, then generate or repair only the thumbnail artwork still needed.
      </p>
    </div>

    <!-- Music (Episode Builder) episode: a scene picture, or a prompt from a scene for the model -->
    <MusicThumbnailPanel
      v-if="form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      @changed="() => { refreshImageStatus(); onPanelRefresh(); loadThumbnailPinState() }"
    />

    <div class="card workspace-section generator-settings-panel">
      <div class="grid-2">
        <div class="form-group">
          <label>Image Model <span class="required" aria-hidden="true">*</span></label>
          <ImageModelPicker
            v-model="activeForm.model"
            :project-slug="slug"
            :image-mode="thumbnailReferenceActive ? 'img2img' : 'text2img'"
          />
          <p v-if="thumbnailReferenceActive" class="reference-notice" role="status">
            A reference thumbnail is switched on for this project, so only <strong>paid</strong> models that can use a
            reference image are listed. Your image is used privately as a composition guide.
            <button type="button" class="btn btn-sm btn-ghost" :disabled="clearingReference" @click="stopUsingReference">
              {{ clearingReference ? 'Turning Off…' : 'Stop Using the Reference' }}
            </button>
          </p>
          <span v-else class="text-muted text-xs">Tip: Use a higher-quality model for eye-catching thumbnails</span>
          <!-- Prompt-character cap indicator. Surfaces the limit the Gateway
               publishes for the active model so users know how long their
               image prompts can be before the provider rejects or truncates
               them. The published figure is exact — no approximation marker. -->
          <span class="cap-row">
            <template v-if="activeModelCap">
              <span class="cap-pill" :title="`The published prompt length limit for ${activeModelLabel}. A prompt longer than this is refused before it is sent, so no credits are spent on it.`">
                Prompt cap: <strong>{{ activeModelCap.toLocaleString() }} chars</strong>
              </span>
            </template>
            <template v-else>
              <span class="cap-pill cap-pill-unknown" title="No prompt limit is published for this model — Story Studio cannot check the length in advance.">
                Prompt cap: <strong>unknown</strong>
              </span>
            </template>
          </span>
        </div>
      </div>

      <!-- Published `(resolution, aspect_ratio)` rows for the selected model,
           each priced by the Gateway. Absent for a model publishing none. -->
      <ImageOutputOptionPicker
        v-if="activeGenStudioModel"
        v-model="outputOption"
        :model="activeGenStudioModel"
        :preferred-aspect-ratio="activeForm.aspect_ratio"
        :reference-guided="thumbnailReferenceActive"
        @switched="onOutputOptionSwitched"
      />
      <p v-if="activeGenStudioModel" class="image-cost" :class="`basis-${imageUnitCost.basis}`" :title="imageUnitCost.title">
        {{ CREDIT_BASIS_LABEL[imageUnitCost.basis] }}: {{ imageUnitCost.text }} <PriceDetails :cost="imageUnitCost" />
      </p>

      <div class="grid-3">
        <div class="form-group">
          <label>Aspect Ratio</label>
          <select v-model="activeForm.aspect_ratio" class="select">
            <option v-for="ar in aspectRatios" :key="ar.value" :value="ar.value">
              {{ ar.value }} — {{ ar.label }}
            </option>
          </select>
        </div>
        <div v-if="activeGenStudioModel" class="form-group">
          <label>Generation quality</label>
          <div class="input generator-automatic-quality" aria-live="polite">
            <strong>Automatic</strong>
            <span>Gateway uses {{ activeGenStudioModel.display_name }}’s recommended quality.</span>
          </div>
          <p class="text-muted text-xs mt-1">Nothing to set here — quality is picked for you.</p>
        </div>
        <!-- `supports_seed: false` is published, so the control is not offered
             rather than accepting a value that would be silently dropped. -->
        <div v-if="activeGenStudioModel && activeGenStudioModel.supports_seed !== false" class="form-group">
          <label>Seed <span class="text-muted text-xs">optional</span></label>
          <input v-model.number="activeForm.seed" class="input" type="number" min="0" max="2147483647" placeholder="Random" />
          <p class="text-muted text-xs mt-1">Reuse a seed for repeatable composition; leave blank for a fresh variation.</p>
        </div>
        <!-- v1.0.308 — legacy render-size scale, only for local models on older
             Image Studio builds that don't advertise a size menu. Hidden for
             cloud models (they use the aspect string, not pixels). -->
        <div v-if="activeIsLocalModel" class="form-group">
          <label>
            Render Size
            <span
              class="text-muted text-xs"
              title="Output resolution for the local Image Studio model. Smaller cuts GPU/VAE memory (fewer out-of-memory crashes), renders faster on your Macs, and writes smaller files. The exact pixels sent are shown in each option. Cloud models ignore this and use the aspect ratio."
            >ⓘ</span>
          </label>
          <select v-model.number="activeForm.render_scale" class="select">
            <option v-for="rs in renderSizes" :key="rs.value" :value="rs.value">
              {{ rs.label }} — {{ activeLegacyDimsLabel(rs.value) }}
            </option>
          </select>
          <p class="text-muted text-xs mt-1">
            Lower = less GPU load + faster on local Macs.
            <template v-if="activeForm.render_scale !== 100">Sending {{ activeLegacyDimsLabel(activeForm.render_scale) }} px.</template>
            <template v-else>Full resolution.</template>
          </p>
        </div>
      </div>

      <!-- The two choices map directly to the real file behavior. -->
      <div class="form-group">
        <label>Generation Mode</label>
        <div class="generation-mode-row">
          <label class="generation-mode-option">
            <input type="radio" value="skip" v-model="activeForm.generation_mode" />
            <div>
              <strong>Skip existing</strong>
              <span class="text-muted">Don't regenerate thumbnails that already exist.</span>
            </div>
          </label>
          <label class="generation-mode-option">
            <input type="radio" value="regenerate" v-model="activeForm.generation_mode" />
            <div>
              <strong>Regenerate</strong>
              <span class="text-muted">Overwrite existing variants in place.</span>
            </div>
          </label>
        </div>
      </div>

      <!-- v1.0.416 — optional render-time guidance appended to the prompt for
           every thumbnail rendered from this page (top button, board, rows).
           It belongs to ONE episode, so it is never remembered or put in a
           preset, and it is cleared (with a notice) when the episode changes. -->
      <div class="form-group">
        <label for="thumb-extra-details">
          Extra details for this render <span class="text-muted text-xs">(optional — this episode only)</span>
        </label>
        <textarea
          id="thumb-extra-details"
          v-model="extraDetails"
          class="textarea textarea-sm"
          rows="2"
          placeholder="e.g. push the subject closer, make the title bigger and higher-contrast, warmer lighting"
        ></textarea>
        <p class="text-muted text-xs mt-1">Added to every thumbnail you render on this page. Cleared when you switch episode.</p>
      </div>

      <!-- The length the model will ACTUALLY receive.
           The saved prompt is not the prompt: the render appends the extras,
           the reference guidance and the style keywords, and refuses the
           result when it is over the model's published limit. The number that
           matters is therefore the ASSEMBLED length, and the customer must see
           it while they are still choosing the extras and the reference.

           The count is MEASURED by the backend with the render's own assembly
           and read here. The page never re-derives it: the reference guidance
           depends on the reference file existing on disk, and the style
           keywords depend on the episode's cast and on the renderer's name
           matching. Both live in the renderer, so a second copy of the
           assembly here would be a second answer (AGENTS §1). -->
      <div v-if="form.episode_id" class="form-group prompt-length-check" aria-live="polite">
        <label>Prompt length check</label>
        <p class="text-muted text-xs">
          <template v-if="publishedCap">
            {{ activeModelLabel || 'This model' }} accepts up to
            <strong>{{ publishedCap.toLocaleString() }} characters</strong> per prompt.
          </template>
          <template v-else>
            No prompt limit is published for {{ activeModelLabel || 'this model' }} —
            Story Studio cannot check the length in advance.
          </template>
        </p>
        <p class="text-muted text-xs">
          Counts the prompt as the model receives it — the saved prompt plus your extra details, the
          reference guidance and the style keywords. The badge on a board row counts the saved prompt only.
        </p>
        <p v-if="!canMeasureAssembled" class="text-muted text-xs">Choose an image model to measure the assembled prompts.</p>
        <p v-else-if="assembledLengthsLoading" class="text-muted text-xs">Measuring the assembled prompts…</p>
        <p v-else-if="assembledLengthsError" class="text-muted text-xs">
          {{ assembledLengthsError }} The length is not shown. The render checks the model's own limit
          before it submits anything, so an over-limit prompt is still refused there — before any credits are spent.
        </p>
        <ul v-else-if="assembledLengthRows.length" class="prompt-length-list">
          <li v-for="row in assembledLengthRows" :key="row.number" :class="{ 'is-over': isOverCap(row) }">
            <span class="prompt-length-num">{{ String(row.number).padStart(2, '0') }}</span>
            <span class="prompt-length-count">
              {{ row.characters.toLocaleString() }}<template v-if="publishedCap"> / {{ publishedCap.toLocaleString() }}</template> chars
            </span>
            <span v-if="isOverCap(row)" class="prompt-length-over">
              {{ (row.characters - (publishedCap || 0)).toLocaleString() }} over the limit
            </span>
          </li>
        </ul>
        <p v-else class="text-muted text-xs">No thumbnail prompts for this episode yet.</p>
        <p v-if="overCapRows.length" class="text-muted text-xs prompt-length-note">
          A prompt over the limit is refused before it is sent, so no credits are spent on it. Thumbnails
          already on disk are kept as they are unless you choose Regenerate.
        </p>
      </div>

    </div>

    <!-- ── Thumbnail board ────────────────────────────────────────────────
         Lists the episode's thumbnail prompts, shows the rendered image
         inline per row, and exposes per-row Generate / Regenerate buttons.
         Bulk generation is the top Generate button; the form fields above
         (model, aspect ratio, generation mode) flow into both. -->
    <ImageGeneratorPanel
      v-show="form.episode_id"
      kind="thumbnail"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="selectedEpisode?.title || ''"
      :prepare="prepareGeneration"
      :paid="activeModelPaid"
      :refresh-key="igPanelRefreshKey"
      :prompt-char-cap="thumbnailModelInfo.cap"
      :model-label="thumbnailModelInfo.label"
      :pinned-filename="pinnedThumbnailFilename"
      @open-preview="openLightboxAt"
      @refresh="onPanelRefresh"
      @pin-toggle="toggleThumbnailPin"
    />

    <!-- Recovery is scoped to the active artwork pool. It only reclaims an
         accepted Gateway result; fresh work remains an explicit action. -->
    <div v-if="form.episode_id" class="card workspace-section" aria-labelledby="image-integrity-heading">
      <h3 id="image-integrity-heading" class="integrity-title">
        Recovery & completeness
      </h3>
      <p class="text-muted text-sm integrity-blurb">
        Check the expected {{ activePoolLabel }} against files on disk. <strong>Recover prior result(s)</strong>
        downloads thumbnails that were already made but never saved, without charging again. Missing artwork that can't
        be recovered needs a new render with Generate Thumbnail Images above; existing files are never overwritten in missing-only mode.
      </p>

      <div v-if="imageStatus.loading" class="text-muted text-md">
        <LoadingSpinner size="sm" /> Checking…
      </div>

      <div v-else-if="imageStatus.error" class="text-danger text-md">
        {{ imageStatus.error }}
        <button class="btn btn-sm btn-ghost ml-2" @click="refreshImageStatus">Retry</button>
      </div>

      <div v-else-if="!activePoolStatus" class="text-muted text-md">
        No {{ activePoolLabel }} prompts found for this episode yet. Generate them
        first on the <NuxtLink :to="`/projects/${slug}/image-prompts?tab=thumbnails`">Thumbnail Prompts</NuxtLink> page.
      </div>

      <div v-else class="flex items-center gap-2 flex-wrap">
        <!-- Tier 2: prompts ↔ on-disk images. Scoped to the ACTIVE pool only. -->
        <span v-if="activePoolStatus" class="integrity-pill" :class="activeMissingCount ? 'warn' : 'ok'">
          <template v-if="activeMissingCount === 0">✓ {{ activePoolStatus.total }} {{ activePoolLabel }} present</template>
          <template v-else>⚠ {{ activeMissingCount }} of {{ activePoolStatus.total }} {{ activePoolLabel }} missing</template>
        </span>

        <button
          v-if="activeRecoverableCount > 0"
          class="btn btn-sm btn-secondary"
          :disabled="submitting || imageJobActiveForEpisode"
          :title="`Downloads ${activePoolLabel} that were already made but never saved — no new credits used. Existing files are kept.`"
          @click="repairMissing"
        >
          Recover prior result{{ activeRecoverableCount === 1 ? '' : 's' }} ({{ activeRecoverableCount }})
        </button>

        <button class="btn btn-sm btn-ghost" :disabled="imageStatus.loading" @click="refreshImageStatus">
          Refresh
        </button>
        <span v-if="imageJobActiveForEpisode && activeRecoverableCount > 0" class="text-muted text-xs">
          A thumbnail render for this episode is running — these buttons unlock when it finishes.
        </span>
      </div>

      <details v-if="activeMissingList" class="missing-detail disclosure mt-2">
        <summary>Which thumbnails are missing ({{ activeMissingCount }})</summary>
        <div class="text-muted text-sm">
          Missing {{ activePoolLabel }}: {{ activeMissingList }}
        </div>
        <div v-for="item in activeRepairItems" :key="item.filename" class="repair-task-row">
          <span>{{ item.filename }}</span>
          <!-- Recovery evidence stays in the manifest; customer copy only says
               whether that evidence exists. -->
          <span v-if="item.task_id" class="repair-task-id">
            Can be recovered for free
          </span>
          <span v-else class="repair-task-none">Can't be recovered · needs a new render</span>
        </div>
      </details>

      <div v-if="lastRepairJob" class="repair-job-result mt-2" :class="lastRepairJobClass">
        <span>
          Repair:
          {{ lastRepairJobText }}
          <NuxtLink :to="`/projects/${slug}/jobs`">View in Jobs</NuxtLink>
        </span>
      </div>
    </div>

    <div
      v-if="form.episode_id && activePoolStatus && activeMissingCount === 0"
      class="card workspace-section thumbnail-handoff"
    >
      <div>
        <p class="section-eyebrow">Upload readiness</p>
        <h3>Thumbnail set ready</h3>
        <p class="text-muted text-sm">
          {{ pinnedThumbnailFilename
            ? `${pinnedThumbnailFilename} is pinned for upload.`
            : autoThumbnailFilename
              ? `${autoThumbnailFilename} will be selected automatically for upload.`
              : 'All thumbnail artwork is ready. Choose one from the board before uploading if you want to pin it.' }}
        </p>
      </div>
      <button type="button" class="btn btn-primary" @click="navigateTo(`/projects/${slug}/upload`)">
        Open YouTube Upload →
      </button>
    </div>

    <!-- Contextual help -->
    <div class="help-note mt-2">
      <span class="help-icon" aria-hidden="true">💡</span>
      <div>
        <strong>Need prompts first?</strong>
        Generate thumbnail prompts for this episode on the
        <NuxtLink :to="`/projects/${slug}/image-prompts?tab=thumbnails`">Thumbnail Prompts</NuxtLink>
        page before running image generation.
      </div>
    </div>

    <!-- Lightbox: fullscreen preview + carousel. -->
    <!-- v1.0.41: pin-toggle is enabled when the current image is a -->
    <!-- thumbnail (the lightbox + parent both gate on `section`). -->
    <ImagePreviewLightbox
      v-model:visible="lightboxOpen"
      v-model:index="lightboxIndex"
      :images="allEditableImagesWithPin"
      :project-slug="slug"
      :version="igPanelRefreshKey"
      :pin-enabled="currentLightboxIsThumbnail"
      @pin-toggle="onLightboxPinToggle"
    />

  </div>
</template>

<script setup lang="ts">
import { findOutputOption, isPublishedAspectRatio, outputOptionsForRatio, storyDefaultAspectRatio, type OutputOptionChoice } from '../../../utils/genstudio-output-options.js'
import { CREDIT_BASIS_LABEL, describeImageUnitCost } from '../../../utils/genstudio-credit-cost.js'
import { customerSafeJobText, jobRequestIds } from '../../../utils/job-presentation.js'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, get, put } = useApi()
const freshImagesAction = useFreshGenerationAction()
const { config, refreshConfig } = useProject()
const {
  models: genStudioImageModels,
  refresh: refreshGenStudioImageModels,
} = useGenStudioImageModels()

const { success, error: showError, info: showInfo } = useToast()
const { thumbImageGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()
const { isJobActiveFor, jobs } = useJobs()

const submitting = ref(false)

// The form holds the episode pick plus the thumbnail render settings (model, aspect
// ratio, quality, seed, generation mode). This page renders thumbnails only.
type ImagesSubForm = {
  model: string
  aspect_ratio: string
  generation_mode: 'skip' | 'regenerate'
  // v1.0.308 — LEGACY render-size scale (100 = Full, 75 = Balanced, 50 = Light)
  // for local models that DON'T expose a per-model size menu. Scales the aspect's
  // base pixels.
  render_scale: number
  seed: number | null
}
const defaultSubForm = (): ImagesSubForm => ({
  // The live GenStudio image catalog selects a usable model on mount. This
  // must stay empty so retired image-provider ids cannot leak into renders.
  model: '',
  aspect_ratio: '',
  // Unified Generation Mode (M6) — replaces the standalone `force` checkbox.
  // Translated to `force` at submit time; the backend's image generator
  // (generators/images.ts) only knows about that boolean today, so this
  // is purely a UI consolidation. Default 'skip' matches the prior
  // default behaviour (force=false).
  generation_mode: 'skip',
  // Local render size: Full by default so existing behaviour is unchanged.
  render_scale: 100,
  seed: null,
})
const form = reactive({
  episode_id: '',
  thumbnail: defaultSubForm(),
})
useAppTitle('Thumbnail Generator')

// v1.0.259 — remember the render settings (model / aspect / generation mode) across reloads.
useRememberedForm('images', slug, form, { include: ['thumbnail'] })
// The format's recommended ratio only seeds a form that remembered none.
const aspectRatioRemembered = !!form.thumbnail.aspect_ratio

// Render-time guidance for ONE episode. Deliberately outside `form`, so it is
// neither remembered nor captured by a preset (AGENTS §4/§5).
const extraDetails = ref('')

// Template auto-unwraps computed refs — `activeForm.model` Just Works
// there; script uses `activeForm.value.model`.
const activeForm = computed<ImagesSubForm>(() => form.thumbnail)
const thumbnailReferenceActive = computed(() => !!(config.value as any)?.thumbnail_reference_asset?.id)
const clearingReference = ref(false)
/** Same project setting the Thumbnail Prompts "Remove reference" button clears. */
async function stopUsingReference(): Promise<void> {
  if (!await useConfirm().ask({
    title: 'Stop using the reference thumbnail?',
    message: 'Thumbnails will be rendered from the prompt alone, and free models become available again. You can add a reference again on Thumbnail Prompts.',
    confirmLabel: 'Stop Using It',
  })) return
  clearingReference.value = true
  try {
    await put(`/projects/${slug.value}/settings/config`, { thumbnail_reference_asset: null })
    await refreshConfig(slug.value)
    success('Reference thumbnail switched off for this project.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not switch off the reference thumbnail')
  } finally {
    clearingReference.value = false
  }
}

// Hydrate the selected episode so child components + computeds can read
// the human-readable title (resolveEpisodePaths needs it on the prompt-
// list fetch).
const episodeIdRef = computed(() => form.episode_id)
const { selectedEpisode } = useEpisodeStatus(episodeIdRef, slug, {
  // Refetch when an upstream script job lands so the page picks up the
  // freshly-saved title without the user having to re-pick the episode
  // from the dropdown (mirrors video.vue's pattern).
  refetchOnJobTypes: ['expand_chapters'],
})

// Prompt-character cap + friendly label for the selected model. Both come from
// the selected live GenStudio row, so the advisory badge agrees with preview admission.
function modelInfoFor(modelId: string) {
  const m = genStudioImageModels.value.find(model => model.id === modelId)
  return {
    cap: typeof m?.max_prompt_characters === 'number' ? m.max_prompt_characters : null,
    label: m?.display_name || modelId || '',
  }
}
const thumbnailModelInfo = computed(() => modelInfoFor(form.thumbnail.model))
const activeModelCap = computed(() => thumbnailModelInfo.value.cap)
/**
 * The model's PUBLISHED prompt-length limit, live.
 *
 * `0` — or a model that publishes no limit at all — is the ABSENCE of a
 * limit, never a number this page made up. So the limit is either the
 * catalogue's own figure or nothing: there is no fallback ceiling anywhere
 * on this page (AGENTS §1).
 */
const publishedCap = computed<number | null>(() => (
  typeof activeModelCap.value === 'number' && activeModelCap.value > 0 ? activeModelCap.value : null
))
const activeModelLabel = computed(() => thumbnailModelInfo.value.label)

const activeGenStudioModel = computed(() =>
  genStudioImageModels.value.find(model => model.id === activeForm.value.model) || null,
)

function normalizeImageAspectRatio(target: ImagesSubForm): boolean {
  const model = genStudioImageModels.value.find(row => row.id === target.model)
  // Rows are authoritative when present: a ratio still listed in
  // `aspect_ratios` whose row disappeared cannot be submitted.
  if (isPublishedAspectRatio(model, target.aspect_ratio)) return true
  // A missing/unpublished ratio uses the shared Story default (16:9 when the
  // live model publishes it); the project format/preset/remembered value was
  // already applied above and is preserved whenever it is still published.
  const preferred = storyDefaultAspectRatio(model)
  target.aspect_ratio = isPublishedAspectRatio(model, preferred) ? preferred : ''
  return isPublishedAspectRatio(model, target.aspect_ratio)
}

// The saved form follows its actual catalogue list, including same-count
// refreshes and preset edits. Preserve any choice the model still publishes;
// a forced replacement is announced so the customer sees what changed.
watch(() => {
  const target = form.thumbnail
  const model = genStudioImageModels.value.find(row => row.id === target.model)
  return [target.model, target.aspect_ratio, modelArs(target.model),
    model?.default_aspect_ratio, model?.output_options]
}, () => {
  const before = form.thumbnail.aspect_ratio
  normalizeImageAspectRatio(form.thumbnail)
  const after = form.thumbnail.aspect_ratio
  if (!before || !after || before === after) return
  showInfo(`${activeModelLabel.value || 'The selected model'} does not publish ${before}. Switched to ${after}.`)
}, { immediate: true })

// ── Presets ─────────────────────────────────────────────────────────────
// v1.0.88+: presets are SPLIT per kind (thumbnail_generator vs
// scene_generator). Each tab maintains its own preset list so a
// "seedream + 16:9 + skip" thumbnail preset can't accidentally
// overwrite a separate scene preset, and
// vice versa. The TopActionBar binds to whichever preset object
// matches the active tab via the `imgPresets` computed below.
//
// Legacy `image_generator_presets` is intentionally NOT migrated.
// Existing presets stay on disk under that key but no longer surface
// in the new split UI (re-save from the new tabs to materialize them).
function imageGeneratorPresetForm(value: ImagesSubForm): Omit<ImagesSubForm, 'image_quality' | 'image_steps'> {
  // Inference steps are GenStudio-owned. Drop legacy values as presets are
  // saved so Pipeline cannot revive an obsolete manual step selection.
  const { image_quality: _quality, image_steps: _steps, ...saved } = value as ImagesSubForm & {
    image_quality?: unknown
    image_steps?: unknown
  }
  return saved
}

function applyImageGeneratorPreset(target: ImagesSubForm, data: any): void {
  if (!data?.form) return
  const {
    image_quality: _quality,
    image_steps: _steps,
    image_mode: _imageMode,
    reference_sources: _referenceSources,
    reference_strength: _referenceStrength,
    specific_number: _specificNumber,
    generation_mode: savedGenerationMode,
    ...saved
  } = data.form
  const generation_mode = savedGenerationMode === 'regenerate' ? 'regenerate' : 'skip'
  Object.assign(target, saved, { generation_mode })
}

const thumbnailGeneratorPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'thumbnail_generator',
  snapshot: () => ({ form: imageGeneratorPresetForm(form.thumbnail) }),
  apply: (data) => applyImageGeneratorPreset(form.thumbnail, data),
})
// Bound to TopActionBar.
const imgPresets = computed(() => thumbnailGeneratorPresets)

/**
 * Format-aware seeding of aspect_ratio BEFORE preset loaders run. The
 * format schema exposes `imagePrompts.recommendedAspect`. The live catalogue
 * watcher retains that preference only while the selected model publishes it.
 *
 * Saved presets still override these — preset.load() runs after seeding.
 */
async function applyImageFormatDefaultsIfNoPreset() {
  // A remembered or preset ratio is the customer's choice; never overwrite it.
  if (aspectRatioRemembered || thumbnailGeneratorPresets.activeId.value) return
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const ip = f?.imagePrompts
    if (!ip) return
    if (typeof ip.recommendedAspect === 'string' && ip.recommendedAspect) {
      form.thumbnail.aspect_ratio = ip.recommendedAspect
    }
  } catch {
    // Format endpoint unavailable — use the selected model's published options.
  }
}

onMounted(async () => {
  await Promise.all([
    thumbnailGeneratorPresets.load(),
    refreshGenStudioImageModels(),
  ])
  await applyImageFormatDefaultsIfNoPreset()
})

// Bumped on every project/episode change so a slow read for the previous scope can tell it is stale.
let imageScopeSequence = 0
watch([slug, () => form.episode_id], () => { imageScopeSequence++ }, { immediate: true })

// Old presets could contain the retired "new version" mode. It has no safe
// distinct behavior, so migrate it to missing-only generation on load.
watch(() => activeForm.value.generation_mode as string, mode => {
  if (mode !== 'skip' && mode !== 'regenerate') activeForm.value.generation_mode = 'skip'
}, { immediate: true })

/**
 * The published output row this form renders at, kept as the PAIR because the
 * pair is the row GenStudio published. `null` = the selected model publishes
 * no `output_options[]`, so no resolution is sent and GenStudio applies its
 * own default — exactly what this page did before.
 */
const outputOption = ref<OutputOptionChoice | null>(null)
/** A model switch that moved the pick is announced, never applied silently. */
function onOutputOptionSwitched(notice: string): void { showInfo(notice) }
// The row owns the ratio, so the submitted combination is the one on screen.
watch(outputOption, (choice) => {
  if (choice?.aspect_ratio) activeForm.value.aspect_ratio = choice.aspect_ratio
})
// ...and the other way: a ratio picked from the dropdown that no longer matches
// the chosen row clears the row, so the picker shows (and the request sends)
// the ratio on screen rather than the old row's resolution.
watch(() => activeForm.value.aspect_ratio, (ratio) => {
  outputOption.value = realignOutputOption(activeGenStudioModel.value, outputOption.value, ratio)
})
/** Keep the same size at the newly picked ratio when published; otherwise clear the row. */
function realignOutputOption(model: any, current: OutputOptionChoice | null, ratio: string): OutputOptionChoice | null {
  if (!current || current.aspect_ratio === ratio) return current
  const same = outputOptionsForRatio(model, ratio).find(row => row.resolution === current.resolution)
  return same ? { resolution: same.resolution, aspect_ratio: same.aspect_ratio } : null
}
/** Live price of the current model + row. Recomputes on every selection change. */
const imageUnitCost = computed(() => describeImageUnitCost(
  activeGenStudioModel.value,
  findOutputOption(activeGenStudioModel.value, outputOption.value),
  { referenceGuided: thumbnailReferenceActive.value },
))

const aspectRatios = computed(() => (modelArs(activeForm.value.model) || [])
  .map(value => ({ value, label: AR_LABELS[value] || value })))

// ── Render dimensions ─────────────────────────────────────────────────────
// Compatibility aspect presets for catalog entries that expose an aspect ratio
// rather than explicit pixel dimensions.
const LOCAL_ASPECT_PRESETS: Record<string, [number, number]> = {
  '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344],
  '4:3': [1152, 864], '3:4': [864, 1152], '21:9': [1536, 640],
  '3:2': [1216, 832], '2:3': [832, 1216],
}
const round16 = (n: number) => Math.max(256, Math.round(n / 16) * 16)
const renderSizes = [
  { value: 100, label: 'Full' },
  { value: 75, label: 'Balanced' },
  { value: 50, label: 'Light' },
]
const AR_LABELS: Record<string, string> = {
  '16:9': 'Landscape', '1:1': 'Square', '9:16': 'Portrait', '4:3': 'Standard',
  '3:4': 'Tall', '21:9': 'Ultrawide', '3:2': 'Photo', '2:3': 'Photo tall',
}
function isLocalModelId(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('imagestudio:')
}

/** Distinct aspect ratios the model supports (menu order), or null when no menu. */
function modelArs(modelId: string | undefined): string[] | null {
  const genStudio = genStudioImageModels.value.find(model => model.id === modelId)
  if (genStudio) return [...(genStudio.aspect_ratios || [])]
  return null
}
function legacyDimsFor(aspectRatio: string, scale: number): { width: number; height: number } {
  const base = LOCAL_ASPECT_PRESETS[aspectRatio] || LOCAL_ASPECT_PRESETS['1:1']!
  const s = (scale || 100) / 100
  return { width: round16(base[0] * s), height: round16(base[1] * s) }
}
// {width,height} for a subform: the legacy local table, or null for cloud models (aspect string).
function sizeBodyFor(sf: ImagesSubForm): { width: number; height: number } | null {
  return isLocalModelId(sf.model) ? legacyDimsFor(sf.aspect_ratio, sf.render_scale) : null
}
// Active-tab helpers drive the resolution control shown in the form.
const activeIsLocalModel = computed(() => isLocalModelId(activeForm.value.model))
function activeLegacyDimsLabel(scale: number): string {
  const d = legacyDimsFor(activeForm.value.aspect_ratio, scale)
  return `${d.width}×${d.height}`
}
const generateButtonLabel = 'Generate Thumbnail Images'
const generatingLabel = 'Generating thumbnail images'
const generating = computed(() => thumbImageGenerating.value)

// v1.0.307 — keep the Generate button disabled for the WHOLE job, not just
// the brief enqueue POST. `submitting` flips false the instant the job is
// queued, which let the user re-click and double-queue. This reads the
// authoritative job queue (per-episode, per-kind) so the button stays greyed
// until the running render actually finishes — and survives a page reload or
// a job launched from the in-page panel. Scene vs thumbnail are independent
// pools, so we only watch the kind matching the active tab.
const imageJobActiveForEpisode = computed(() =>
  isJobActiveFor(
    form.episode_id,
    ['thumb_images'],
  ),
)

// The scene half of this page is retired; an old ?tab=scenes link lands on Thumbnails.
if (route.query.tab === 'scenes') {
  void useRouter().replace({ query: { ...route.query, tab: 'thumbnails' } })
}

// Fetches on-disk status and provider-history recoverability together so the
// page never presents a fresh-generation gap as a free repair candidate.
interface ImageStatusState {
  loading: boolean
  error: string
  thumbnails: { total: number; present: number; missing: number[] } | null
  missingThumbsList: string
}
// No `provider`: the repair status endpoint no longer returns one, and a
// legacy manifest's transport name has nothing to say to the customer.
interface RepairMissingItem { filename: string; recoverable: boolean; task_id?: string }
interface RepairPoolStatus {
  expected: number; present: number; missing: number
  with_manifest: number; without_manifest: number
  missing_items: RepairMissingItem[]
}
/**
 * v1.4.196 — one definition of "nothing loaded yet".
 *
 * The reset in the episode-change watcher has to blank EVERY episode-scoped
 * field. Writing the literal twice is how a field gets forgotten, which is the
 * same drift that produced several defects in this audit, so the reset reuses
 * this factory rather than repeating it.
 */
function emptyImageStatus(): ImageStatusState {
  return {
    loading: false, error: '',
    thumbnails: null,
    missingThumbsList: '',
  }
}
const imageStatus = reactive<ImageStatusState>(emptyImageStatus())
let imageStatusLoadSequence = 0

// The integrity card covers the thumbnail pool. (Repair is the user's favourite
// money-saver.)
const integrityPool = 'thumbnails'
const activePoolStatus = computed(() => imageStatus.thumbnails)
const activeMissingCount = computed(() => activePoolStatus.value?.missing.length ?? 0)
const activeMissingList = computed(() => imageStatus.missingThumbsList)
const activePoolLabel = 'thumbnails'
const repairStatus = reactive<{ thumb: RepairPoolStatus | null }>({ thumb: null })
const activeRepairPool = computed(() => repairStatus.thumb)
const activeRepairItems = computed(() => activeRepairPool.value?.missing_items || [])
const activeRecoverableCount = computed(() => activeRepairPool.value?.with_manifest || 0)
const lastRepairJobId = ref('')
const lastRepairJob = computed(() => jobs.value.find(j => j.job_id === lastRepairJobId.value) || null)
const lastRepairJobClass = computed(() => {
  if (!lastRepairJob.value || ['queued', 'running'].includes(lastRepairJob.value.status)) return 'busy'
  const result = lastRepairJob.value.result || {}
  return Number(result.needs_fresh_generation || 0) + Number(result.unrecoverable || 0) > 0 ? 'warn' : 'ok'
})
const lastRepairJobText = computed(() => {
  const job = lastRepairJob.value
  if (!job) return ''
  if (job.status === 'queued') return 'queued'
  if (job.status === 'running') return 'looking for earlier results'
  if (job.status === 'error') return job.error ? customerSafeJobText(job.error, jobRequestIds(job)) : 'failed'
  const result = job.result || {}
  const recovered = Number(result.recovered || 0)
  const remaining = Number(result.needs_fresh_generation || 0) + Number(result.unrecoverable || 0)
  if (!recovered && remaining) return `nothing restored; ${remaining} need fresh generation`
  if (remaining) return `${recovered} restored; ${remaining} need fresh generation`
  return `${recovered} restored and verified on disk`
})

watch(() => lastRepairJob.value?.status, (status) => {
  if (status !== 'done' && status !== 'error' && status !== 'cancelled') return
  // v1.2.9: repair restores artwork at the same paths, so it is a
  // bytes-changed event exactly like a regeneration. It previously re-scanned
  // without bumping the cache key, which re-read the file list but left every
  // preview showing the pre-repair pixels. onPanelRefresh() does the re-scan
  // AND the bump.
  onPanelRefresh()
})

async function refreshImageStatus() {
  const ep = form.episode_id
  const project = slug.value
  const scope = imageScopeSequence
  const requestSequence = ++imageStatusLoadSequence
  const current = () => scope === imageScopeSequence && project === slug.value && ep === form.episode_id
  if (!ep || !project) return
  imageStatus.loading = true
  imageStatus.error = ''
  try {
    const [r, repair] = await Promise.all([
      get<any>(`/projects/${project}/episodes/${ep}/image-status`),
      get<{ scene: RepairPoolStatus; thumb: RepairPoolStatus }>(
        `/projects/${project}/episodes/${ep}/images-repair-status`,
      ),
    ])
    if (requestSequence !== imageStatusLoadSequence || !current()) return
    imageStatus.thumbnails = r.thumbnails ?? null
    const missThumb = imageStatus.thumbnails?.missing.length ?? 0
    imageStatus.missingThumbsList = missThumb > 0 ? imageStatus.thumbnails!.missing.join(', ') : ''
    repairStatus.thumb = repair.thumb
  } catch (e: any) {
    if (requestSequence !== imageStatusLoadSequence || !current()) return
    imageStatus.error = e?.data?.detail || e?.message || 'Could not check image integrity'
  } finally {
    if (requestSequence === imageStatusLoadSequence && current()) imageStatus.loading = false
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
    // Scope the repair to this page's pool (thumbnails).
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/generate/images-repair`, {
      episode_id: form.episode_id,
      pool: integrityPool,
    })
    lastRepairJobId.value = job.job_id
    success('Thumbnail repair queued — watch progress in Jobs.')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue repair')
  } finally {
    submitting.value = false
  }
}


// ── On-disk thumbnail scan (feeds the lightbox) ──────────────────────────
// Reuses the same `/video-editor/scan/{episodeId}` endpoint Video Assembly
// uses to enumerate already-on-disk images. Cheap (one read of the
// thumbnails subfolder) so re-fetching after each render is fine.
//
// IMPORTANT: declared BEFORE the episode-id watcher below. Earlier this
// block lived after the watch, but `{ immediate: true }` fires the watch
// synchronously during setup — and the watch's else-branch touches
// `editThumbs.value`. With the refs declared after, that synchronous fire
// hit a temporal dead zone and crashed the whole page on first load.
interface ScannedImage { filename: string; path: string }
const editThumbs = ref<ScannedImage[]>([])
let editScanLoadSequence = 0

// Cache-bust key for the ImageGeneratorPanel. The page's ONE "the pixels on
// disk may have changed" signal. It feeds the panel's `refreshKey` and the
// lightbox's `version`, and `loadEditScan()` bumps it, so every path that
// re-reads the disk also re-fetches the images.
const igPanelRefreshKey = ref(0)

function onPanelRefresh() {
  // Re-run the thumbnail scan so the lightbox + the integrity card stay
  // in sync with whatever the panel just wrote — loadEditScan() bumps
  // igPanelRefreshKey, which is what actually re-fetches the pixels.
  void loadEditScan()
  refreshImageStatus()
}

async function loadEditScan() {
  const ep = form.episode_id
  const project = slug.value
  const scope = imageScopeSequence
  const requestSequence = ++editScanLoadSequence
  const current = () => scope === imageScopeSequence && project === slug.value && ep === form.episode_id
  if (!ep || !project) return
  try {
    const r = await get<{ thumbnails?: ScannedImage[] }>(
      `/projects/${project}/video-editor/scan/${ep}`,
    )
    if (requestSequence !== editScanLoadSequence || !current()) return
    editThumbs.value = r.thumbnails || []
    // v1.2.9: re-reading the disk must also re-fetch the pixels. The scan
    // returns paths, and regeneration reuses the same paths, so a changed
    // image is invisible in the response — refreshing only the list left the
    // "Refresh" button re-rendering the pre-change picture, which is exactly
    // what the button exists to disprove.
    igPanelRefreshKey.value++
    // v1.0.41: refresh pin state alongside the scan so the badge +
    // hint stay in sync with what's actually on disk after edits /
    // re-renders / external file moves.
    void loadThumbnailPinState()
  } catch (e: any) {
    if (requestSequence !== editScanLoadSequence || !current()) return
    console.error('[images/edit-scan] failed:', e)
  }
}

// ── Lightbox / carousel ──────────────────────────────────────────────────
// Tile clicks open this fullscreen preview. The user browses with ← / →
// and closes it with Escape.
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)

/**
 * Flat list backing the lightbox carousel. Order matches the on-page grid
 * — the episode's thumbnails — so left/right arrow navigation feels predictable.
 */
interface LightboxImage {
  filename: string
  path: string
  section: 'thumbnails'
}
const allEditableImages = computed<LightboxImage[]>(() =>
  editThumbs.value.map(t => ({ filename: t.filename, path: t.path, section: 'thumbnails' as const })))

// v1.0.41 — augment with `is_pinned` so the lightbox's Pin button
// reflects current state without a per-render API hit. The pin metadata
// lives in `pinnedThumbnailFilename` (loaded alongside the editScan).
const allEditableImagesWithPin = computed(() => allEditableImages.value.map(img => ({
  ...img,
  is_pinned: img.section === 'thumbnails' && img.filename === pinnedThumbnailFilename.value,
})))
const currentLightboxIsThumbnail = computed(() => {
  const i = lightboxIndex.value
  const img = allEditableImages.value[i]
  return !!(img && img.section === 'thumbnails')
})

function openLightboxAt(path: string) {
  const i = allEditableImages.value.findIndex(img => img.path === path)
  lightboxIndex.value = i >= 0 ? i : 0
  lightboxOpen.value = true
}

// ── Thumbnail pin state (v1.0.41) ────────────────────────────────────────
// Mirrors the GET /thumbnails response keyed by current episode_id. The
// editScan loader (loadEditScan) is augmented to refresh this on every
// scan, so the pin badge stays in sync with the disk view.
const pinnedThumbnailFilename = ref<string | null>(null)
const autoThumbnailFilename = ref<string | null>(null)

async function loadThumbnailPinState() {
  const ep = form.episode_id
  const project = slug.value
  const scope = imageScopeSequence
  const current = () => scope === imageScopeSequence && project === slug.value && ep === form.episode_id
  if (!ep) {
    pinnedThumbnailFilename.value = null
    autoThumbnailFilename.value = null
    return
  }
  try {
    const r = await get<{
      files: Array<{ filename: string; size_bytes: number; is_pinned: boolean }>
      pinned: string | null
      pinned_missing: boolean
      resolved: string
      auto_pick: string
    }>(`/projects/${project}/episodes/${ep}/thumbnails?platform=youtube`)
    if (!current()) return
    pinnedThumbnailFilename.value = r.pinned
    autoThumbnailFilename.value = r.auto_pick || null
  } catch {
    if (!current()) return
    // Non-fatal — fall back to "no pin known", grid still renders fine.
    pinnedThumbnailFilename.value = null
    autoThumbnailFilename.value = null
  }
}

async function setThumbnailPin(filename: string | null) {
  const code = form.episode_id
  if (!code) return
  try {
    await post<{ ok: true; pinned: string | null }>(
      `/projects/${slug.value}/episodes/${code}/thumbnails/pin`,
      { filename, platform: 'youtube' },
    )
    pinnedThumbnailFilename.value = filename
    success(filename ? `📌 Pinned ${filename}` : 'Pin cleared — uploads use auto-pick')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to update pin')
  }
}

async function toggleThumbnailPin(filename: string) {
  await setThumbnailPin(filename === pinnedThumbnailFilename.value ? null : filename)
}

async function onLightboxPinToggle(payload: { filename: string; pin: boolean }) {
  await setThumbnailPin(payload.pin ? payload.filename : null)
}
// Episode-id watcher MUST come after the editThumbs
// declarations above — `{ immediate: true }` fires this synchronously
// during setup, and the else-branch reads those refs. See comment above.
watch([slug, () => form.episode_id], ([, v], old) => {
  // Extra render details were written for the previous episode (AGENTS §4).
  if (old?.[1] && extraDetails.value.trim()) {
    extraDetails.value = ''
    showInfo('Cleared "Extra details for this render" — they were written for the previous episode.')
  }
  lastRepairJobId.value = ''
  repairStatus.thumb = null
  // v1.4.196 — blank on the CHANGE, not only when the episode becomes empty.
  // `refreshImageStatus` and `loadEditScan` replace their results only on a
  // SUCCESSFUL read, so switching from one episode to another left the previous
  // episode's integrity figures and thumbnail list on screen for the whole load —
  // and permanently if the read failed (AGENTS.md §4). The old code cleared
  // these ONLY in the else branch, i.e. when there was no episode at all.
  Object.assign(imageStatus, emptyImageStatus())
  editThumbs.value = []
  if (v) {
    refreshImageStatus()
    void loadEditScan()
  }
}, { immediate: true })

// ── The ASSEMBLED prompt length (measured by the server) ──────────────────
//
// The SAVED prompt is not the prompt the model receives. The render appends
// the render-time extras, the reference guidance and the style keywords, then
// measures the result against the model's published limit and refuses it
// BEFORE anything is submitted. So the number that decides the render is the
// assembled length — and the customer has to see it while they are still
// choosing the extras and the reference.
//
// The count is MEASURED by the backend with the render's own assembly and
// read here. This page never re-derives it: the reference guidance depends
// on the reference file existing on disk, and the style keywords depend on
// the episode's cast and on the renderer's name matching. Both live in the
// renderer, so a second copy of the assembly here would be a second answer
// (AGENTS §1).
interface AssembledThumbnailLength { number: number; characters: number }
const assembledLengths = ref<AssembledThumbnailLength[] | null>(null)
const assembledLengthsError = ref('')
const assembledLengthsLoading = ref(false)
/** The inputs the reading on screen was measured for. A reading that does not
 *  match the live inputs is stale, and a stale length must never refuse a
 *  render. Reactive, so a completed measurement is seen by everything that
 *  asks whether the reading is current. */
const assembledLengthsSignature = ref('')
/** Bumped on every relevant change, so a reply measured for the old inputs
 *  is dropped instead of landing on screen. */
let assembledLengthsRequest = 0

/**
 * Everything the measurement depends on: the project, the episode, the model,
 * the extras, the reference the render would use, and the revision of the
 * prompt files (bumped whenever the board reloads them, so an edited or
 * reloaded prompt set is re-measured rather than kept on screen).
 *
 * The reference is the WHOLE payload, not its id: the same id can come back
 * with a different file or a different reframing prompt, and the render reads
 * all three. This string is compared, never displayed — nothing from the
 * project travels to the customer through it.
 */
/**
 * A measurement needs the model the render would use: the endpoint takes the
 * model id, and a page with no model selected has nothing to measure. While
 * the live catalogue is still choosing one, the card says so — it does not ask
 * the server for a reading it cannot produce.
 */
const canMeasureAssembled = computed(() => !!activeForm.value.model)

const assembledLengthsInputs = computed(() => JSON.stringify({
  project: slug.value,
  episode: form.episode_id,
  title: selectedEpisode.value?.title || '',
  model: activeForm.value.model,
  extras: extraDetails.value.trim(),
  reference: thumbnailReferenceActive.value
    ? ((config.value as any)?.thumbnail_reference_asset ?? null)
    : null,
  imageMode: thumbnailReferenceActive.value ? 'img2img' : 'text2img',
  prompts: igPanelRefreshKey.value,
}))

/**
 * One measured row — or null when the answer is malformed.
 *
 * A malformed answer is UNKNOWN. It must never become a row that reads as
 * zero characters, which would look like a fact about the prompt (AGENTS §6:
 * a zero that means two things is a defect).
 */
function decodeAssembledRow(value: unknown): AssembledThumbnailLength | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as { number?: unknown; characters?: unknown }
  if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number < 0) return null
  if (typeof row.characters !== 'number' || !Number.isInteger(row.characters) || row.characters < 0) return null
  return { number: row.number, characters: row.characters }
}

async function loadAssembledLengths(signature: string): Promise<void> {
  const project = slug.value
  const episode = form.episode_id
  if (!project || !episode) return
  const request = ++assembledLengthsRequest
  try {
    const data = await post<{ thumbnails?: AssembledThumbnailLength[] }>(
      `/projects/${project}/episodes/${episode}/thumbnail-prompt-lengths`,
      {
        // The same fields the render request carries, so the measurement is
        // the render's own assembly and not a parallel one. Everything the
        // render request omits (reference strength, reference sources) must
        // fall back to the render's own defaults there.
        model: activeForm.value.model,
        episode_title: selectedEpisode.value?.title || '',
        extra_details: extraDetails.value.trim(),
        thumbnail_reference_asset: thumbnailReferenceActive.value
          ? (config.value as any).thumbnail_reference_asset
          : null,
        image_mode: thumbnailReferenceActive.value ? 'img2img' : 'text2img',
      },
    )
    if (request !== assembledLengthsRequest) return
    // The answer is decoded, not trusted. A row that is not a whole,
    // non-negative count, or a repeated thumbnail number, makes the WHOLE
    // reading unknown — never a row that reads as zero characters, which
    // would look like a fact about the prompt (AGENTS §6).
    const raw = (data as any)?.thumbnails
    if (!Array.isArray(raw)) {
      assembledLengths.value = null
      assembledLengthsSignature.value = ''
      assembledLengthsError.value = 'The assembled prompt length came back in a shape this page cannot read.'
      return
    }
    const rows: AssembledThumbnailLength[] = []
    const seen = new Set<number>()
    for (const item of raw) {
      const row = decodeAssembledRow(item)
      if (!row || seen.has(row.number)) {
        assembledLengths.value = null
        assembledLengthsSignature.value = ''
        assembledLengthsError.value = 'The assembled prompt length came back in a shape this page cannot read.'
        return
      }
      seen.add(row.number)
      rows.push(row)
    }
    assembledLengths.value = rows
    assembledLengthsError.value = ''
    assembledLengthsSignature.value = signature
  } catch (e: any) {
    if (request !== assembledLengthsRequest) return
    assembledLengths.value = null
    assembledLengthsSignature.value = ''
    // The server's own words when it has any. A missing measurement is never
    // dressed up as a fact about the episode — "no prompts yet" is said only
    // when the measurement SUCCEEDS and finds none.
    assembledLengthsError.value = e?.data?.detail || 'The assembled prompt length could not be measured.'
  } finally {
    if (request === assembledLengthsRequest) assembledLengthsLoading.value = false
  }
}

let assembledLengthsTimer: ReturnType<typeof setTimeout> | undefined
watch(assembledLengthsInputs, (signature) => {
  // Any change invalidates the reading on screen: it was measured for the old
  // inputs, so it is dropped (and its reply cancelled) rather than left to
  // answer for a selection the customer has already moved on from.
  assembledLengthsRequest++
  assembledLengthsSignature.value = ''
  assembledLengths.value = null
  assembledLengthsError.value = ''
  if (assembledLengthsTimer) clearTimeout(assembledLengthsTimer)
  if (!form.episode_id || !activeForm.value.model) {
    assembledLengthsLoading.value = false
    return
  }
  assembledLengthsLoading.value = true
  // One request per settled state — the extras box is typed into.
  assembledLengthsTimer = setTimeout(() => { void loadAssembledLengths(signature) }, 250)
}, { immediate: true })

onBeforeUnmount(() => {
  if (assembledLengthsTimer) clearTimeout(assembledLengthsTimer)
  // A reply that lands after the page is gone must not touch anything.
  assembledLengthsRequest++
})

/** True when the reading on screen was measured for the CURRENT inputs. */
const assembledLengthsFresh = computed(() => (
  !!assembledLengthsSignature.value && assembledLengthsSignature.value === assembledLengthsInputs.value
))

/** The measured rows, or none — the template never walks a nullable list. */
const assembledLengthRows = computed<AssembledThumbnailLength[]>(() => assembledLengths.value || [])

/**
 * The measurement must describe the same prompt set the board shows.
 *
 * The count is checked first, and then the EXACT prompt numbers the board
 * reports as missing: every one of them has to be a thumbnail this reading
 * measured. A count that matches while the numbers do not is a different
 * prompt set, and a different prompt set is not evidence about this one.
 */
const assembledLengthsMatchBoard = computed(() => {
  const rows = assembledLengths.value
  const total = activePoolStatus.value?.total
  if (!rows || typeof total !== 'number') return false
  if (rows.length !== total) return false
  const missing = activePoolStatus.value?.missing
  if (!missing?.length) return true
  const measured = new Set(rows.map(row => row.number))
  for (const value of missing) {
    if (!measured.has(Number(value))) return false
  }
  return true
})

/** Prompts whose assembled length is over the model's published limit. */
const overCapRows = computed(() => {
  const rows = assembledLengths.value
  const cap = publishedCap.value
  if (!rows?.length || !cap) return []
  return rows.filter(row => row.characters > cap)
})

function isOverCap(row: AssembledThumbnailLength): boolean {
  const cap = publishedCap.value
  return !!cap && row.characters > cap
}

/**
 * The thumbnails a render of THIS page would actually submit.
 *
 * "Skip existing" (force=false) keeps the thumbnails already on disk and
 * submits only the missing ones, so an over-limit prompt on a thumbnail that
 * is already rendered must NOT block the healthy ones. "Regenerate"
 * (force=true) submits every prompt.
 *
 * `null` = unknown (the integrity figures have not loaded) — and an unknown
 * set never refuses a render.
 */
function submittedThumbnailNumbers(force: boolean): Set<number> | null {
  const rows = assembledLengths.value
  if (!rows?.length) return null
  if (force) return new Set(rows.map(row => row.number))
  const missing = activePoolStatus.value?.missing
  if (!missing) return null
  return new Set(missing.map(n => Number(n)).filter(n => Number.isFinite(n)))
}

/**
 * The prompts a render would submit that are over the model's published
 * limit.
 *
 * Empty when nothing is over, when the model publishes no limit, and when the
 * reading is stale, unmatched or unknown — an unknown length never refuses
 * anything (it would be a guess, and the render refuses authoritatively).
 */
function overCapToSubmit(force: boolean): AssembledThumbnailLength[] {
  if (!assembledLengthsFresh.value) return []
  if (!assembledLengthsMatchBoard.value) return []
  if (!publishedCap.value) return []
  const submitted = submittedThumbnailNumbers(force)
  if (!submitted) return []
  return overCapRows.value.filter(row => submitted.has(row.number))
}

function overCapRefusalText(rows: AssembledThumbnailLength[]): string {
  const cap = publishedCap.value || 0
  const model = activeModelLabel.value || 'The selected model'
  const list = rows
    .map(row => `Thumbnail ${String(row.number).padStart(2, '0')} `
      + `(${row.characters.toLocaleString()} characters, ${(row.characters - cap).toLocaleString()} over)`)
    .join(', ')
  return `${model} accepts up to ${cap.toLocaleString()} characters per prompt. `
    + `${list} would be refused. `
    + 'Shorten "Extra details for this render" or the prompt itself on Thumbnail Prompts, '
    + 'or render with a model that publishes a larger limit. '
    + 'Nothing is submitted and no credits are spent on a refused prompt.'
}

function generationParams(forceOverride?: boolean) {
  // A submit can occur before Vue flushes a catalogue/preset watcher.
  if (!normalizeImageAspectRatio(activeForm.value)) return null
  // Missing-only is the safe default. Regeneration is the one explicit
  // overwrite action exposed by the thumbnail and scene boards.
  const force = forceOverride ?? activeForm.value.generation_mode === 'regenerate'
  const params: any = {
    episode_id: form.episode_id,
    model: activeForm.value.model,
    mode: 'thumbs',
    aspect_ratio: activeForm.value.aspect_ratio,
    image_mode: thumbnailReferenceActive.value ? 'img2img' : 'text2img',
    ...(thumbnailReferenceActive.value ? { thumbnail_reference_asset: (config.value as any).thumbnail_reference_asset } : {}),
    ...(extraDetails.value.trim() ? { extra_details: extraDetails.value.trim() } : {}),
    force,
  }
  // A seed only travels when the model publishes support for one; otherwise
  // it would be dropped at the boundary without the customer being told.
  if (activeGenStudioModel.value?.supports_seed !== false
    && typeof activeForm.value.seed === 'number' && Number.isFinite(activeForm.value.seed)) {
    params.seed = Math.max(0, Math.min(2147483647, Math.trunc(activeForm.value.seed)))
  }

  // The published output row, when the customer picked one. It carries the
  // real output size, so the legacy render-size pair is not also sent — two
  // size instructions could bill a combination other than the one shown.
  if (outputOption.value?.resolution) {
    params.resolution = outputOption.value.resolution
  } else {
    // v1.0.308/478 — explicit render dimensions. sizeBodyFor resolves from the
    // model's own size menu when it has one, falls back to the compatibility
    // presets, and otherwise keeps the catalog aspect ratio server-side.
    const sz = sizeBodyFor(activeForm.value)
    if (sz) { params.width = sz.width; params.height = sz.height }
  }

  return params
}

/** Unknown counts as paid: the confirm must never promise "free" by guessing. */
const activeModelPaid = computed(() => activeGenStudioModel.value?.chargeable !== false)
const regenerateAllAction = computed(() => activeModelPaid.value
  ? 'Re-render ALL thumbnails? This replaces the existing ones and uses credits again.'
  : 'Re-render ALL thumbnails? This replaces the existing ones. This model is free, so no credits are used.')

/**
 * The ONE request builder for every thumbnail render on this page: the top
 * button, the board's bulk button and each row. The board adds only
 * thumb_number / operation_id. `ask` = show the same confirmation the top
 * button shows (rows render a single image and skip it).
 */
async function prepareGeneration(forceOverride?: boolean, ask = true): Promise<any | null> {
  const params = generationParams(forceOverride)
  if (!params) {
    showError("This model doesn't list any picture shapes yet. Refresh the model list or choose another model before generating.")
    return null
  }
  if (!ask) return params
  // Same Model + price rows the Audio page's confirm shows ("Free — your fleet" for a local model).
  const details = [
    { label: 'Model', value: activeModelLabel.value || 'Unavailable' },
    { label: 'Cost per image', value: imageUnitCost.value.text },
  ]
  const confirmed = await confirmGeneration(slug.value, 'thumb_images', params, params.force
    ? { action: regenerateAllAction.value, details, always: true }
    : { action: 'Start Thumbnail Images?', details })
  if (!confirmed) return null
  // Never replace a confirmed choice with a new model/ratio behind the dialog.
  // The ratio check is rows-authoritative, exactly like the backend: a ratio
  // published only by an output row is valid even when `aspect_ratios` omits it.
  if (activeForm.value.model !== params.model
    || activeForm.value.aspect_ratio !== params.aspect_ratio
    || !isPublishedAspectRatio(activeGenStudioModel.value, params.aspect_ratio)) {
    showError('The image model or picture shape changed during confirmation. Review the current selection and generate again to confirm it.')
    return null
  }
  return params
}

async function queueGeneration(forceOverride?: boolean, queuedMessage = 'Image generation queued!') {
  // A prompt that is verifiably over the model's published limit is refused
  // HERE, before a job is queued. The render would refuse it too — before it
  // submits or charges — but the customer would otherwise only learn about it
  // from a failed job, after the batch was already running. Only the prompts
  // this render would actually submit count: "Skip existing" keeps the
  // thumbnails already on disk, so those must not hold up the missing ones.
  const force = forceOverride ?? activeForm.value.generation_mode === 'regenerate'
  const overCap = overCapToSubmit(force)
  if (overCap.length) {
    showError(overCapRefusalText(overCap))
    return
  }
  const params = await prepareGeneration(forceOverride)
  if (!params) return
  const operationId = params.force ? freshImagesAction.begin(params) : null
  if (operationId) params.operation_id = operationId

  submitting.value = true
  thumbImageGenerating.value = true

  try {
    await post(`/projects/${slug.value}/generate/images`, params)
    if (operationId) freshImagesAction.complete(operationId)
    success(queuedMessage)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to queue image generation')
    thumbImageGenerating.value = false
  } finally {
    submitting.value = false
  }
}

async function submit() {
  await queueGeneration()
}
</script>

<style scoped>
/* "Image integrity" card title and blurb beneath it. */
.integrity-title { margin-bottom: 6px; }
.integrity-blurb { margin-bottom: 10px; }
.required { color: var(--error); margin-left: 2px; }

/* Generation Mode (M6) — two-up radio cards. Mirror of audio.vue;
   if more pages adopt this control later, lift to a shared component. */
.generation-mode-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
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
.generation-mode-option .text-muted { display: block; font-size: var(--font-xs); color: var(--text-muted); margin-top: 2px; }

.image-cost { margin: 8px 0 0; color: var(--text); font-size: var(--font-xs); line-height: 1.4; }
.image-cost.basis-unpublished { color: var(--warning, #d97706); }
.image-cost.basis-free { color: var(--success, #16a34a); }

.generator-automatic-quality {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 38px;
  color: var(--text-secondary);
}
.generator-automatic-quality strong { color: var(--text-primary); }
.generator-automatic-quality span { font-size: var(--font-xs); }

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
.repair-task-row {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  padding-top: 5px;
  overflow-wrap: anywhere;
}
.repair-task-id { color: var(--text-muted); }
.repair-task-none { color: rgb(245, 158, 11); }
.repair-job-result {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 12px;
}
.repair-job-result.busy { color: var(--text-muted); }
.repair-job-result.ok { color: rgb(34, 197, 94); border-color: rgba(34, 197, 94, .35); }
.repair-job-result.warn { color: rgb(245, 158, 11); border-color: rgba(245, 158, 11, .4); }

.thumbnail-handoff {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border-color: rgba(34, 197, 94, .4);
  background: linear-gradient(110deg, rgba(34, 197, 94, .09), var(--bg-secondary) 58%);
}
.thumbnail-handoff h3 { margin: 0 0 4px; }
.thumbnail-handoff p { margin: 0; max-width: 720px; }
@media (max-width: 720px) {
  .thumbnail-handoff { align-items: stretch; flex-direction: column; }
}

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

/* Prompt-cap pill. */
.cap-row {
  display: inline-flex; align-items: center; gap: 8px; margin-top: 4px;
}
.cap-pill {
  font-size: var(--font-xs);
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(108, 143, 255, 0.12);
  color: var(--accent, #6c8fff);
  border: 1px solid rgba(108, 143, 255, 0.3);
  cursor: help;
}
.cap-pill-unknown {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border-color: var(--border);
}
.cap-pill strong { font-weight: 600; }

/* Prompt length check — the assembled length the model receives. */
.prompt-length-check { margin-top: 4px; }
.prompt-length-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}
.prompt-length-list li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.prompt-length-list li.is-over { color: rgb(185, 28, 28); }
.prompt-length-num {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  min-width: 2ch;
}
.prompt-length-count { font-family: var(--font-mono, monospace); }
.prompt-length-over { font-weight: 600; }
.prompt-length-note { margin-top: 6px; }
</style>
