<template>
  <div class="workspace-page creation-workspace thumbnail-generator-workspace">
    <WorkspaceHero
      eyebrow="Create · Render"
      :title="form.mode === 'thumbs' ? 'Thumbnail Generator' : 'Scene Generator'"
      :description="form.mode === 'thumbs'
        ? 'Render finished YouTube thumbnail artwork from the approved thumbnail prompts.'
        : 'Render story artwork from the active scene prompt source.'"
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Image generator context">
          <span class="workspace-metric" :data-tone="form.episode_id ? 'success' : 'warning'"><strong>{{ form.episode_id || 'No episode' }}</strong> target</span>
          <span class="workspace-metric" data-tone="info"><strong>{{ form.mode === 'thumbs' ? 'Thumbnail artwork' : 'Scene artwork' }}</strong> workflow</span>
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
      :filter-field="form.mode === 'thumbs' ? 'thumbnails' : 'images'"
      :generate-label="generateButtonLabel"
      loading-label="Queuing…"
      :generate-loading="submitting || imageJobActiveForEpisode"
      :generate-disabled="!form.episode_id"
      :generate-status="(generating || imageJobActiveForEpisode) ? `${generatingLabel} for ${form.episode_id}…` : ''"
      @generate="submit"
    >
      <template #actions>
        <EpisodeImportButton
          :slug="slug"
          :episode-code="form.episode_id"
          :default-tab="form.mode === 'thumbs' ? 'thumb' : 'scene'"
          @imported="() => { refreshImageStatus(); onPanelRefresh() }"
        />
      </template>
      </TopActionBar>
      <p class="workspace-command-copy">
        {{ form.mode === 'thumbs'
          ? 'Choose the episode and render model, then generate or repair only the thumbnail artwork still needed.'
          : 'Choose the episode and render model, then generate or repair only the scene artwork still needed.' }}
      </p>
    </div>

    <div class="card workspace-section generator-settings-panel">
      <div class="grid-2">
        <div class="form-group">
          <label>Image Model <span class="required" aria-hidden="true">*</span></label>
          <!-- v1.0.152+ — custom ImageModelPicker replaces the plain
               <select>. Source-aware (☁︎ cloud vs 💻 local), live
               catalog fetch from the Image Studio modal, capability
               badges, search + I2I filter, open-modal-UI link. The
               picker emits the same string model id the old select
               did, so the watch(activeForm.value.model, …) below and
               every downstream computed (cap, tier, label, etc.) keep
               working unchanged. -->
          <ImageModelPicker
            v-model="activeForm.model"
            :project-slug="slug"
            :image-models="config?.image_models || {}"
            :image-mode="thumbnailReferenceActive ? 'img2img' : 'text2img'"
          />
          <span v-if="form.mode === 'thumbs'" class="text-muted text-xs">
            <template v-if="thumbnailReferenceActive">Reference-guided generation · your image is used privately as a composition reference and is not sent as a public URL.</template>
            <template v-else>Tip: Use a higher-quality model for eye-catching thumbnails</template>
          </span>
          <!-- Prompt-character cap indicator. Surfaces the documented limit
               for the active model so users know how long their image
               prompts can be before the provider rejects/silently truncates.
               Cap values come from electron/server/models/defaults.ts and
               are approximate. v1.4.206 — the "View all caps" reference table
               is gone (owner decision 3): it printed copied caps and credit
               prices as though they were current, which rule 1 forbids. -->
          <span class="cap-row">
            <template v-if="activeModelCap">
              <span class="cap-pill" :title="`Approximate provider limit for ${activeModelLabel}. Prompts over this may be rejected or silently truncated.`">
                Prompt cap: <strong>~{{ activeModelCap.toLocaleString() }} chars</strong>
              </span>
            </template>
            <template v-else>
              <span class="cap-pill cap-pill-unknown" title="No documented cap recorded for this model.">
                Prompt cap: <strong>unknown</strong>
              </span>
            </template>
          </span>
        </div>

        <!-- Tier picker — only renders for variable-priced models that
             carry a `tiers[]` array (resolution/speed/etc.). Flat-priced
             models hide it entirely. Credits are quoted authoritatively by
             GenStudio at confirmation and settlement. -->
        <div v-if="modelTiers.length > 0" class="form-group">
          <label>{{ modelTierLabel }}</label>
          <div class="tier-picker">
            <label
              v-for="t in modelTiers"
              :key="t.id"
              class="tier-option"
              :class="{ active: activeForm.tier === t.id }"
            >
              <input type="radio" :value="t.id" v-model="activeForm.tier" />
              <span class="tier-option-label">{{ t.label }}</span>
              <span class="tier-option-cost">{{ t.credits }} GenStudio credits</span>
            </label>
          </div>
        </div>
      </div>

      <!-- Published `(resolution, aspect_ratio)` rows for the selected model,
           each priced by GenStudio. Absent for a model publishing none. -->
      <ImageOutputOptionPicker
        v-if="activeGenStudioModel"
        v-model="outputOption"
        :model="activeGenStudioModel"
        :reference-guided="thumbnailReferenceActive"
        @switched="onOutputOptionSwitched"
      />
      <p v-if="activeGenStudioModel" class="image-cost" :class="`basis-${imageUnitCost.basis}`" :title="imageUnitCost.title">
        {{ CREDIT_BASIS_LABEL[imageUnitCost.basis] }}: {{ imageUnitCost.text }}
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
            <span>GenStudio uses {{ activeGenStudioModel.display_name }}’s recommended quality.</span>
          </div>
          <p class="text-muted text-xs mt-1">No step setting is saved or sent by Story Studio.</p>
        </div>
        <!-- `supports_seed: false` is published, so the control is not offered
             rather than accepting a value that would be silently dropped. -->
        <div v-if="activeGenStudioModel && activeGenStudioModel.supports_seed !== false" class="form-group">
          <label>Seed <span class="text-muted text-xs">optional</span></label>
          <input v-model.number="activeForm.seed" class="input" type="number" min="0" max="2147483647" placeholder="Random" />
          <p class="text-muted text-xs mt-1">Reuse a seed for repeatable composition; leave blank for a fresh variation.</p>
        </div>
        <!-- v1.0.478 — Quality tier resolved against the model's own size menu
             (Image Studio /imagestudio/models). Works for local AND cloud models
             that advertise `sizes`, so cloud can use its full higher-res range. -->
        <div v-if="activeModelHasSizes" class="form-group">
          <label>
            Quality
            <span
              class="text-muted text-xs"
              title="Output resolution from this model's own size menu. Highest = the largest size offered for the aspect (ultra → high → max). Balanced = a sensible mid size. Fast = the smallest. Resolves per model, so a preset stays usable across models."
            >ⓘ</span>
          </label>
          <select v-model="activeForm.render_tier" class="select">
            <option v-for="t in QUALITY_TIERS" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
          <p class="text-muted text-xs mt-1">
            <template v-if="activeTierDimsLabel">Sending {{ activeTierDimsLabel }} px.</template>
            <template v-else>Resolved from the model's size menu.</template>
          </p>
        </div>
        <!-- v1.0.308 — legacy render-size scale, only for local models on older
             Image Studio builds that don't advertise a size menu. Hidden for
             cloud models (they use the aspect string, not pixels). -->
        <div v-else-if="activeIsLocalModel" class="form-group">
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
              <span class="text-muted">Don't regenerate {{ form.mode === 'thumbs' ? 'thumbnails' : 'scenes' }} that already exist.</span>
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

    </div>

    <!-- ── Per-tab generator panel (v1.0.87+) ─────────────────────────────
         Each panel lists the episode's prompts for ONE kind (scene or
         thumbnail), shows the rendered image inline per row, and exposes
         per-row Generate / Regenerate buttons plus a missing-only bulk action.
         bulk button. Replaces the old all-or-nothing top Generate flow as
         the PRIMARY interaction surface. Form fields above (model, aspect
         ratio, and generation mode) flow into both panels.
         v-show toggles based on the existing mode tabs so the panel
         matches whichever tab is active. -->
    <ImageGeneratorPanel
      v-show="form.mode === 'thumbs' && form.episode_id"
      kind="thumbnail"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="selectedEpisode?.title || ''"
      :model="form.thumbnail.model"
      :aspect-ratio="form.thumbnail.aspect_ratio"
      :generation-mode="form.thumbnail.generation_mode"
      :tier="form.thumbnail.tier"
      :seed="form.thumbnail.seed"
      :render-width="thumbnailRenderSize?.width"
      :render-height="thumbnailRenderSize?.height"
      :refresh-key="igPanelRefreshKey"
      :prompt-char-cap="thumbnailModelInfo.cap"
      :model-label="thumbnailModelInfo.label"
      :thumbnail-reference-asset="(config as any)?.thumbnail_reference_asset || null"
      :pinned-filename="pinnedThumbnailFilename"
      @open-preview="openLightboxAt"
      @refresh="onPanelRefresh"
      @pin-toggle="toggleThumbnailPin"
    />
    <ImageGeneratorPanel
      v-show="form.mode === 'scenes' && form.episode_id"
      kind="scene"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="selectedEpisode?.title || ''"
      :model="form.scene.model"
      :aspect-ratio="form.scene.aspect_ratio"
      :generation-mode="form.scene.generation_mode"
      :tier="form.scene.tier"
      :seed="form.scene.seed"
      :render-width="sceneRenderSize?.width"
      :render-height="sceneRenderSize?.height"
      :refresh-key="igPanelRefreshKey"
      :prompt-char-cap="sceneModelInfo.cap"
      :model-label="sceneModelInfo.label"
      @open-preview="openLightboxAt"
      @refresh="onPanelRefresh"
    />

    <!-- ── Preview what will be generated ─────────────────────────────────
         Read-only list of the active prompt kind for this episode,
         each with an inline "🖼️ Preview" button that renders a single
         sample image of that exact prompt with the user's currently-
         selected model + aspect + tier. Per-prompt cache keyed by
         sha256(prompt+model+aspect+tier), so re-clicking the same combo
         is free; switching any input invalidates the preview and submits a
         fresh GenStudio job.

         Hidden until prompts exist on disk and the user expands the
         card — keeps the page calm by default; the user opts in.
    -->
    <div v-if="form.episode_id && form.mode === 'scenes'" class="card workspace-section" aria-labelledby="image-preview-heading">
      <button
        type="button"
        class="preview-card-toggle"
        :aria-expanded="previewOpen ? 'true' : 'false'"
        @click="onPreviewToggle"
      >
        <span class="preview-card-icon" aria-hidden="true">{{ previewOpen ? '▾' : '▸' }}</span>
        <h3 id="image-preview-heading" class="preview-card-title">
          Preview what will be generated
        </h3>
        <span v-if="activePromptRows.length" class="text-muted text-xs">
          {{ activePromptRows.length }} scene prompt(s) on disk
        </span>
      </button>
      <p v-if="previewOpen" class="text-muted text-sm preview-card-blurb">
        Inspect the scene prompts that will be sent to the image provider,
        and render a single sample of any one to gut-check the visual style before kicking off the full batch.
        <strong>Cached app-wide</strong> by prompt + model + aspect + tier — same
        combo across episodes / projects re-uses the cached render and
        costs nothing.
      </p>

      <div v-if="previewOpen && promptList.loading" class="text-muted text-md">
        <LoadingSpinner size="sm" /> Loading prompts…
      </div>
      <div v-else-if="previewOpen && promptList.error" class="text-muted text-md">
        {{ promptList.error }}
      </div>
      <template v-else-if="previewOpen">
        <ul v-if="activePromptRows.length" class="preview-list" role="list">
          <li class="preview-list-section">Scenes</li>
          <li v-for="row in activePromptRows" :key="`${activePreviewKind}-${row.number}`" class="preview-row">
            <PreviewPromptRow
              :row="row"
              prefix="Scene"
              :state="previewState[previewKey(activePreviewKind, row.number)] || null"
              @preview="renderPromptPreview(activePreviewKind, row)"
            />
          </li>
        </ul>
        <div v-if="!activePromptRows.length" class="text-muted text-md">
          No planned scene prompts found yet. Build them in
          <NuxtLink :to="`/projects/${slug}/scene-plan`">Scene Plan</NuxtLink> first.
        </div>
      </template>
    </div>

    <!-- Recovery is scoped to the active artwork pool. It only reclaims an
         accepted GenStudio result; fresh work remains an explicit action. -->
    <div v-if="form.episode_id" class="card workspace-section" aria-labelledby="image-integrity-heading">
      <h3 id="image-integrity-heading" class="integrity-title">
        {{ form.mode === 'thumbs' ? 'Recovery & completeness' : 'Image integrity' }}
      </h3>
      <p class="text-muted text-sm integrity-blurb">
        Check the expected {{ activePoolLabel }} against files on disk. <strong>Recover prior result(s)</strong>
        downloads only accepted GenStudio work without charging again. Missing artwork with no saved recovery record
        needs a fresh generation; existing files are never overwritten in missing-only mode.
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
        first on the <NuxtLink :to="`/projects/${slug}/image-prompts?tab=${form.mode === 'thumbs' ? 'thumbnails' : 'scenes'}`">{{ promptPageLabel }}</NuxtLink> page.
      </div>

      <div v-else class="flex items-center gap-2 flex-wrap">
        <!-- Tier 1: outline ↔ prompts. Surfaces when the user changed the
             title's listicle [N] (e.g. 7 → 20) and rebuilt the outline
             but didn't re-run Scene Prompts. Without this pill, Repair
             would silently regenerate against the OLD prompt count,
             leaving the user with images for 7 of 20 expected chapters
             and burning credits to find out. -->
        <span
          v-if="form.mode === 'scenes' && promptsStaleVsOutline.stale"
          class="integrity-pill warn"
          :title="`The outline has ${promptsStaleVsOutline.chapterCount} chapters but only ${promptsStaleVsOutline.promptCount} scene prompts exist on disk. Regenerate Scene Prompts at the new chapter count first — otherwise images will only cover ${promptsStaleVsOutline.promptCount} of the ${promptsStaleVsOutline.chapterCount} chapters.`"
        >
          ⚠ Prompts stale: {{ promptsStaleVsOutline.promptCount }} / {{ promptsStaleVsOutline.chapterCount }} chapters
        </span>
        <NuxtLink
          v-if="form.mode === 'scenes' && promptsStaleVsOutline.stale"
          :to="`/projects/${slug}/image-prompts`"
          class="btn btn-sm btn-secondary"
          title="Regenerate Scene Prompts at the current chapter count before generating images."
        >
          Regenerate prompts →
        </NuxtLink>

        <!-- Tier 2: prompts ↔ on-disk images. Scoped to the ACTIVE pool only. -->
        <span v-if="activePoolStatus" class="integrity-pill" :class="activeMissingCount ? 'warn' : 'ok'">
          <template v-if="activeMissingCount === 0">✓ {{ activePoolStatus.total }} {{ activePoolLabel }} present</template>
          <template v-else>⚠ {{ activeMissingCount }} of {{ activePoolStatus.total }} {{ activePoolLabel }} missing</template>
        </span>

        <button
          v-if="activeRecoverableCount > 0"
          class="btn btn-sm btn-secondary"
          :disabled="submitting || generating || (form.mode === 'scenes' && promptsStaleVsOutline.stale)"
          :title="form.mode === 'scenes' && promptsStaleVsOutline.stale
            ? 'Prompts are stale vs the outline — regenerate prompts first so the repair targets the right chapter count.'
            : `Re-fetches missing ${activePoolLabel} from provider history — no credit cost. Existing files with content are skipped.`"
          @click="repairMissing"
        >
          Recover prior result{{ activeRecoverableCount === 1 ? '' : 's' }} ({{ activeRecoverableCount }})
        </button>

        <button
          v-if="activeFreshCount > 0"
          class="btn btn-sm btn-primary"
          :disabled="submitting || generating || (form.mode === 'scenes' && promptsStaleVsOutline.stale)"
          :title="`Creates only the ${activeFreshCount} missing ${activePoolLabel}; existing files are skipped. This submits new provider work and may use credits.`"
          @click="generateMissingFresh"
        >
          Generate missing fresh ({{ activeFreshCount }})
        </button>

        <button class="btn btn-sm btn-ghost" :disabled="imageStatus.loading" @click="refreshImageStatus">
          Refresh
        </button>
      </div>

      <details v-if="activeMissingList" class="missing-detail mt-2">
        <summary>Technical recovery details ({{ activeMissingCount }} missing)</summary>
        <div class="text-muted text-sm">
          Missing {{ activePoolLabel }}: {{ activeMissingList }}
        </div>
        <div v-for="item in activeRepairItems" :key="item.filename" class="repair-task-row">
          <span>{{ item.filename }}</span>
          <!-- Recovery evidence stays in the manifest; customer copy only says
               whether that evidence exists. -->
          <span v-if="item.task_id" class="repair-task-id">
            Provider recovery record saved
          </span>
          <span v-else class="repair-task-none">No provider recovery record · fresh generation required</span>
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
      v-if="form.mode === 'thumbs' && form.episode_id && activePoolStatus && activeMissingCount === 0"
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

    <!-- Browse the active image pool without exposing the retired direct
         provider image-edit path. -->
    <div v-if="form.episode_id && form.mode === 'scenes'" class="card workspace-section">
      <div class="card-header">
        <h3>Browse Existing Images</h3>
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
        Click any image to preview it. Image editing will return after GenStudio
        exposes and qualifies a secure image-edit API.
      </p>

      <div v-if="editScanError" class="text-danger text-sm mt-2">{{ editScanError }}</div>

      <!-- Scenes -->
      <div v-if="form.mode === 'scenes' && editScenes.length" class="mt-2">
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
            <ResilientImage
              :src="getImagePreviewUrlImages(scn.path)"
              :alt="scn.filename"
              class="edit-image-thumb"
              loading="lazy"
              compact
              :manual-retry="false"
            />
            <span class="edit-image-label">S{{ scn.scene_number ?? '?' }}</span>
          </button>
        </div>
      </div>

      <p
        v-if="!activeEditImages.length && !editScanLoading && !editScanError"
        class="text-muted text-sm mt-2"
      >
        No {{ activePoolLabel }} on disk yet for {{ form.episode_id }}. Generate some first using the form above.
      </p>
    </div>

    <!-- Contextual help -->
    <div class="help-note mt-2">
      <span class="help-icon" aria-hidden="true">💡</span>
      <div>
        <strong>Need prompts first?</strong>
        Generate {{ form.mode === 'thumbs' ? 'thumbnail' : 'scene' }} prompts for this episode on the
        <NuxtLink :to="`/projects/${slug}/image-prompts?tab=${form.mode === 'thumbs' ? 'thumbnails' : 'scenes'}`">{{ promptPageLabel }}</NuxtLink>
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


    <!-- Provider prompt-cap reference table. Mounts on demand from the
         "View all caps →" link beside the model selector. Sorted strict-
         first so the user can immediately spot the tight providers
         (Seedream variants at ~500 chars) vs. the generous ones
         (Nano Banana at ~5000). All numbers approximate — recorded from
         each provider's published docs at last audit, see
         electron/server/models/defaults.ts:prompt_char_cap. -->

  </div>
</template>

<script setup lang="ts">
import { findOutputOption, type OutputOptionChoice } from '../../../utils/genstudio-output-options.js'
import { CREDIT_BASIS_LABEL, describeImageUnitCost } from '../../../utils/genstudio-credit-cost.js'
import { customerSafeJobText, jobRequestIds } from '../../../utils/job-presentation.js'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, get } = useApi()
const freshImagesAction = useFreshGenerationAction()
const { config } = useProject()
const {
  models: genStudioImageModels,
  refresh: refreshGenStudioImageModels,
} = useGenStudioImageModels()

// Image models are loaded from the live GenStudio catalog. The picker keeps
// its catalog handling in one place as the available routes evolve.
//
// v1.0.152 — the legacy `imageModelGroups` computed + the
// `formatModelOption(m)` formatter that drove the old <optgroup>
// <select> have been removed. ImageModelPicker (introduced in 1.0.152)
// owns the grouping, search, capability filter, and label formatting
// internally. The picker reads `config.image_models` directly and
// emits a model id back into activeForm.value.model — every existing
// downstream watch / computed (cap, tier, label) continues to fire
// unchanged because the bound value type didn't change.

const { success, error: showError } = useToast()
const { imageGenerating, thumbImageGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()
const { isJobActiveFor, jobs } = useJobs()

const submitting = ref(false)

type Mode = 'scenes' | 'thumbs'

// v1.0.88+: form is split into two completely independent per-kind
// sub-objects (form.thumbnail + form.scene). Each carries its own model,
// aspect ratio, quality, seed, and generation mode.
// `mode` and `episode_id` stay at the top level — they're the tab
// selector and the episode pick, both inherently page-level.
//
// `activeForm` below is a computed proxy returning the sub-object that
// matches the active tab; template bindings on shared-field controls
// (Model picker, Aspect Ratio dropdown, and Generation Mode radios) all flow
// through this so editing the visible control
// updates only the active kind's state. Switching tabs swaps the entire
// surface — Thumbnail tab's Flux Kontext model and 1:1 aspect ratio
// won't leak into the Scene tab's seedream + 16:9 setup.
type ImagesSubForm = {
  model: string
  aspect_ratio: string
  generation_mode: 'skip' | 'regenerate'
  tier: string
  // v1.0.308 — LEGACY render-size scale (100 = Full, 75 = Balanced, 50 = Light)
  // for models that DON'T expose a per-model size menu. Scales the aspect's base
  // pixels. Superseded by render_tier when the model reports `sizes`.
  render_scale: number
  // v1.0.478 — quality tier resolved against the selected model's `sizes` menu
  // (Image Studio). 'highest' = largest size for the AR (ultra→high→max),
  // 'balanced' = middle/default, 'fast' = smallest. Portable across models.
  render_tier: 'highest' | 'balanced' | 'fast'
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
  // Catalog variant for models with selectable output sizes or qualities.
  // Models without variants ignore it. Reset on model switch below.
  tier: '',
  // Local render size: Full by default so existing behaviour is unchanged.
  render_scale: 100,
  // v1.0.478 — model-menu quality tier. Balanced = a sensible default (e.g. 1080p
  // for 16:9 on cloud models); only used when the model reports `sizes`.
  render_tier: 'balanced',
  seed: null,
})
const form = reactive({
  episode_id: '',
  // v1.0.87+: default to 'thumbs' so the page lands on the Thumbnails tab.
  // v1.0.88+: initial value picks up the route's ?tab= query so the
  // sidebar's split "Thumbnail Generator" / "Scene Generator" entries
  // land on the right tab. Query value 'scenes' → mode 'scenes'; any
  // other value (including missing) → 'thumbs'.
  mode: 'thumbs' as Mode,
  thumbnail: defaultSubForm(),
  scene: defaultSubForm(),
})
const promptPageLabel = computed(() => form.mode === 'thumbs' ? 'Thumbnail Prompts' : 'Scene Prompts')
const generatorPageTitle = computed(() => form.mode === 'thumbs' ? 'Thumbnail Generator' : 'Scene Generator')
useAppTitle(generatorPageTitle)

// v1.0.259 — remember each tab's render settings (model / aspect / tier /
// generation mode) across reloads. `mode` is deliberately NOT
// remembered: it comes from the sidebar's ?tab= so the split Thumbnail/Scene
// entries always land on the right tab.
useRememberedForm('images', slug, form, { include: ['thumbnail', 'scene'] })

// Active sub-form. Switches between thumbnail/scene based on mode.
// Template auto-unwraps computed refs — `activeForm.model` Just Works
// there; script uses `activeForm.value.model`.
const activeForm = computed<ImagesSubForm>(() =>
  form.mode === 'thumbs' ? form.thumbnail : form.scene,
)
const thumbnailReferenceActive = computed(() => form.mode === 'thumbs' && !!(config.value as any)?.thumbnail_reference_asset?.id)

// Hydrate the selected episode so child components + computeds can read
// the human-readable title (resolveEpisodePaths needs it on the prompt-
// list fetch).
const episodeIdRef = computed(() => form.episode_id)
const { selectedEpisode } = useEpisodeStatus(episodeIdRef, slug, {
  // Refetch when an upstream script job lands so the page picks up the
  // freshly-saved title without the user having to re-pick the episode
  // from the dropdown (mirrors video.vue's pattern).
  refetchOnJobTypes: ['script-only', 'expand_chapters'],
})

// v1.0.152 — `formatModelOption()` was the option-row formatter for
// the old plain <select>. The new ImageModelPicker renders its own
// rows with structured chips (cost / capability / size / gated
// badges), so the formatter is no longer called. Removed.

// Tier helpers — exposed to the template via computeds so the picker
// renders only when the active model has tiers.
const modelTiers = computed<{ id: string; label: string; credits: number }[]>(() => {
  const m = config.value?.image_models?.[activeForm.value.model] as any
  return Array.isArray(m?.tiers) ? m.tiers : []
})

// Per-tab prompt-character cap + friendly label. Both come from the selected
// live GenStudio row, so the advisory badge agrees with preview admission.
// Each tab can select a different model.
function modelInfoFor(modelId: string) {
  const m = genStudioImageModels.value.find(model => model.id === modelId)
  return {
    cap: typeof m?.max_prompt_characters === 'number' ? m.max_prompt_characters : null,
    label: m?.display_name || modelId || '',
  }
}
const thumbnailModelInfo = computed(() => modelInfoFor(form.thumbnail.model))
const sceneModelInfo = computed(() => modelInfoFor(form.scene.model))
const activeModelCap = computed(() => (form.mode === 'thumbs' ? thumbnailModelInfo : sceneModelInfo).value.cap)
const activeModelLabel = computed(() => (form.mode === 'thumbs' ? thumbnailModelInfo : sceneModelInfo).value.label)

const modelTierLabel = computed(() => {
  // Naming the picker by axis: "Resolution" if tier ids look like 1k/2k/4k,
  // "Quality" for turbo/balanced/quality, generic "Tier" otherwise. Keeps
  // the label descriptive without forcing per-model schema config.
  const ids = modelTiers.value.map(t => t.id.toLowerCase())
  if (ids.some(id => /^\d+k(-\d+k)?$/.test(id))) return 'Resolution'
  if (ids.some(id => ['turbo', 'balanced', 'quality'].includes(id))) return 'Quality'
  return 'Tier'
})

// v1.0.478 — Image Studio per-model size catalog (id → {sizes, default AR}).
// Declared here (above the model watcher, which fires immediately during setup)
// so it's initialized before modelArs() reads it. Populated onMounted.
const isCatalog = ref<Map<string, IsModel>>(new Map())
const activeGenStudioModel = computed(() =>
  genStudioImageModels.value.find(model => model.id === activeForm.value.model) || null,
)
// When the active model changes, snap the tier selection back to the new
// model's default_tier (or first tier, or empty). Without this, switching
// from gpt-image-2 (default '1k') to ideogram-v3 (default 'balanced')
// would leave activeForm.value.tier='1k', which isn't a valid ideogram tier.
watch(() => [activeForm.value.model, genStudioImageModels.value.length], () => {
  const m = config.value?.image_models?.[activeForm.value.model] as any
  const tiers = Array.isArray(m?.tiers) ? m.tiers : []
  if (!tiers.length) {
    activeForm.value.tier = ''
  } else {
    const def = tiers.find((t: any) => t.id === m.default_tier) ?? tiers[0]
    activeForm.value.tier = def?.id || ''
  }
}, { immediate: true })

function normalizeImageAspectRatio(target: ImagesSubForm): boolean {
  const ratios = modelArs(target.model) || []
  if (!ratios.includes(target.aspect_ratio)) {
    const model = genStudioImageModels.value.find(row => row.id === target.model)
    const defaultRatio = model
      ? model.default_aspect_ratio
      : isCatalog.value.get(target.model)?.default_aspect_ratio
    target.aspect_ratio = defaultRatio && ratios.includes(defaultRatio) ? defaultRatio : ratios[0] || ''
  }
  return !!target.aspect_ratio && ratios.includes(target.aspect_ratio)
}

// Both saved forms follow their actual catalogue lists, including same-count
// refreshes and preset edits. Preserve any choice the model still publishes.
for (const kind of ['thumbnail', 'scene'] as const) {
  watch(() => {
    const target = form[kind]
    const model = genStudioImageModels.value.find(row => row.id === target.model)
    return [target.model, target.aspect_ratio, modelArs(target.model),
      model?.default_aspect_ratio, isCatalog.value.get(target.model)?.default_aspect_ratio]
  }, () => normalizeImageAspectRatio(form[kind]), { immediate: true })
}

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
const sceneGeneratorPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'scene_generator',
  snapshot: () => ({ form: imageGeneratorPresetForm(form.scene) }),
  apply: (data) => applyImageGeneratorPreset(form.scene, data),
})
// Bound to TopActionBar — swaps active preset surface on tab change.
const imgPresets = computed(() => thumbnailGeneratorPresets)

/**
 * Format-aware seeding of aspect_ratio BEFORE preset loaders run. The
 * format schema exposes `imagePrompts.recommendedAspect`. The live catalogue
 * watcher retains that preference only while the selected model publishes it.
 *
 * Saved presets still override these — preset.load() runs after seeding.
 */
async function applyImageFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const ip = f?.imagePrompts
    if (!ip) return
    // v1.0.88+: seed BOTH sub-forms (each kind starts from the same
    // format-recommended aspect; the user can then diverge per tab).
    if (typeof ip.recommendedAspect === 'string' && ip.recommendedAspect) {
      form.thumbnail.aspect_ratio = ip.recommendedAspect
      form.scene.aspect_ratio = ip.recommendedAspect
    }
  } catch {
    // Format endpoint unavailable — use the selected model's published options.
  }
}

onMounted(async () => {
  await applyImageFormatDefaultsIfNoPreset()
  // v1.0.88+: load both per-kind preset lists so either tab can
  // immediately pick a saved preset without requiring a tab-switch first.
  await Promise.all([
    thumbnailGeneratorPresets.load(),
    loadImageStudioCatalog(),
    refreshGenStudioImageModels(),
  ])
})

// ── Preview-what-will-be-generated card ─────────────────────────────────
//
// Lazy-loaded list of scene + thumbnail prompts (read-only) plus a
// per-prompt preview state for the inline 🖼️ Preview buttons. The card
// stays collapsed by default; opening it (or switching episodes while
// open) triggers a single GET /image-prompts. Per-prompt preview state
// is keyed by `${kind}-${number}` so scenes and thumbnails with the
// same number don't collide.
interface PromptRow { number: number; title?: string; prompt: string }
// Preview card opens by default. Lazy-load is still single-fetch on first
// expand (cheap docx parse), and starting open makes the prompts visible
// before the user clicks Generate — main use case for the card. Click
// the chevron to collapse if it gets in the way.
const previewOpen = ref(true)
const promptList = reactive<{
  loading: boolean
  error: string | null
  scenes: PromptRow[]
  thumbnails: PromptRow[]
}>({ loading: false, error: null, scenes: [], thumbnails: [] })
let promptListLoadSequence = 0
let imageScopeSequence = 0

interface PreviewState {
  loading: boolean
  url: string | null
  cached: boolean | null
  hash: string | null
  model_id: string | null
  aspect_ratio: string | null
  tier: string | null
  error: string | null
}
const previewState = reactive<Record<string, PreviewState>>({})
function previewKey(kind: 'scene' | 'thumbnail', number: number): string {
  return `${kind}-${number}`
}

async function loadPrompts(): Promise<void> {
  const ep = form.episode_id
  const project = slug.value
  const scope = imageScopeSequence
  const requestSequence = ++promptListLoadSequence
  const current = () => scope === imageScopeSequence && project === slug.value && ep === form.episode_id
  if (!ep || !project) return
  promptList.loading = true
  promptList.error = null
  promptList.scenes = []
  promptList.thumbnails = []
  try {
    // Title param is required for resolveEpisodePaths to find the right
    // folder — without it the backend builds a path with an empty {title}
    // slot ("Season 001/EP0001 - /…") that doesn't match the actual
    // on-disk folder name. Cause of the empty-card bug.
    const titleParam = selectedEpisode.value?.title
      ? `?title=${encodeURIComponent(selectedEpisode.value.title)}`
      : ''
    const data = await get<{ scenes: PromptRow[]; thumbnails: PromptRow[] }>(
      `/projects/${project}/episodes/${ep}/image-prompts${titleParam}`,
    )
    if (requestSequence !== promptListLoadSequence || !current()) return
    promptList.scenes = Array.isArray(data?.scenes) ? data.scenes : []
    promptList.thumbnails = Array.isArray(data?.thumbnails) ? data.thumbnails : []
  } catch (e: any) {
    if (requestSequence !== promptListLoadSequence || !current()) return
    if (e?.status === 404) {
      promptList.error = e?.data?.detail
        || `No prompts found yet. Generate them on the ${promptPageLabel.value} page first.`
    } else {
      promptList.error = e?.data?.detail || e?.message || 'Failed to load prompts'
    }
  } finally {
    if (requestSequence === promptListLoadSequence && current()) promptList.loading = false
  }
}

function onPreviewToggle(): void {
  previewOpen.value = !previewOpen.value
  // Lazy-load on first open. The list itself is cheap (single docx
  // parse) but we still avoid the round-trip until the user shows
  // intent by expanding the card.
  if (previewOpen.value && promptList.scenes.length === 0
      && promptList.thumbnails.length === 0 && !promptList.loading) {
    void loadPrompts()
  }
}

// Re-load prompts when the user switches episodes while the card is
// open. Closed → no fetch (next open will lazy-load).
// `immediate: true` so the initial episode (set from query params on
// page mount, or pre-filled by EpisodeSelector) triggers the load
// even though the card defaults to open — without immediate, the
// open-by-default would render with an empty list until the user
// re-selected the episode.
watch([slug, () => form.episode_id], () => {
  imageScopeSequence++
  // Wipe per-prompt preview state too; the previous episode's renders
  // don't apply here.
  for (const k of Object.keys(previewState)) delete previewState[k]
  promptList.scenes = []
  promptList.thumbnails = []
  promptList.error = null
  if (previewOpen.value && form.episode_id) void loadPrompts()
}, { immediate: true })

async function renderPromptPreview(kind: 'scene' | 'thumbnail', row: PromptRow): Promise<void> {
  const key = previewKey(kind, row.number)
  const scope = imageScopeSequence
  const project = slug.value
  const episode = form.episode_id
  const current = () => scope === imageScopeSequence
    && project === slug.value && episode === form.episode_id
  if (previewState[key]?.loading) return
  if (!previewState[key]) {
    previewState[key] = {
      loading: true, url: null, cached: null, hash: null,
      model_id: null, aspect_ratio: null, tier: null, error: null,
    }
  } else {
    previewState[key]!.loading = true
    previewState[key]!.error = null
  }
  try {
    const data = await post<{
      hash: string; url: string; cached: boolean
      model_id: string; aspect_ratio: string; tier: string
      created_at: string; size_bytes: number
    }>(`/projects/${slug.value}/preview-image`, {
      prompt: row.prompt,
      model: activeForm.value.model,
      aspect_ratio: activeForm.value.aspect_ratio,
      tier: activeForm.value.tier || undefined,
      ...(typeof activeForm.value.seed === 'number' ? { seed: activeForm.value.seed } : {}),
    })
    if (!current()) return
    previewState[key] = {
      loading: false,
      url: data.url,
      cached: !!data.cached,
      hash: data.hash,
      model_id: data.model_id,
      aspect_ratio: data.aspect_ratio,
      tier: data.tier || null,
      error: null,
    }
  } catch (e: any) {
    if (!current()) return
    previewState[key] = {
      ...(previewState[key] as PreviewState),
      loading: false,
      error: e?.data?.detail || e?.message || 'Preview failed',
    }
  }
}

// v1.0.87+: dropped the 'Both' tab and reordered (Thumbnails first).
// The "generate everything in one go" mode encouraged users to fire
// 250 scene jobs + 3 thumbnail jobs as a single batch, which made
// retries painful when only the thumbnails came back wrong. Splitting
// forces the user to tune each surface separately — same pattern as
// the Prompts page where Thumbnail and Scene are now distinct
// tabs. Thumbnails first because they're the CTR lever (you lock the
// cover image direction before committing to N scene renders).
// Backend still accepts 'all' for API parity / older clients; only the
// frontend tab UI is restricted.
const modeTabs: Array<{ id: Mode; label: string; icon: string; hint: string }> = [
  { id: 'thumbs', label: 'Thumbnails',  icon: '📸', hint: 'YouTube thumbnails only' },
  { id: 'scenes', label: 'Scenes',      icon: '🎬', hint: 'Story artwork only' },
]

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
function onOutputOptionSwitched(notice: string): void { showError(notice) }
// The row owns the ratio, so the submitted combination is the one on screen.
watch(outputOption, (choice) => {
  if (choice?.aspect_ratio) activeForm.value.aspect_ratio = choice.aspect_ratio
})
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
const QUALITY_TIERS = [
  { value: 'highest', label: 'Highest' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'fast', label: 'Fast' },
] as const
const AR_LABELS: Record<string, string> = {
  '16:9': 'Landscape', '1:1': 'Square', '9:16': 'Portrait', '4:3': 'Standard',
  '3:4': 'Tall', '21:9': 'Ultrawide', '3:2': 'Photo', '2:3': 'Photo tall',
}
function isLocalModelId(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('imagestudio:')
}

// v1.0.478 — Image Studio's per-model size menu (GET /imagestudio/models). When a
// model reports `sizes`, the AR list + resolution come from it. Lazy-fetched;
// an empty response falls back to the compatibility table above.
interface IsSize { aspect_ratio: string; label?: string; width: number; height: number; tier?: string; default?: boolean; fixed?: boolean }
interface IsModel { id: string; sizes?: IsSize[]; default_aspect_ratio?: string; supports_custom_dimensions?: boolean }
async function loadImageStudioCatalog() {
  try {
    const data = await get<{ models: IsModel[] }>(`/imagestudio/models`)
    const m = new Map<string, IsModel>()
    for (const x of (data.models || [])) if (x?.id) m.set(x.id, x)
    isCatalog.value = m
  } catch { /* leave empty → compatibility presets */ }
}
function modelSizes(modelId: string | undefined): IsSize[] | null {
  const info = modelId ? isCatalog.value.get(modelId) : undefined
  return info?.sizes?.length ? info.sizes : null
}
/** Distinct aspect ratios the model supports (menu order), or null when no menu. */
function modelArs(modelId: string | undefined): string[] | null {
  const genStudio = genStudioImageModels.value.find(model => model.id === modelId)
  if (genStudio) return [...(genStudio.aspect_ratios || [])]
  const sizes = modelSizes(modelId)
  if (!sizes) return null
  const out: string[] = []
  for (const s of sizes) if (!out.includes(s.aspect_ratio)) out.push(s.aspect_ratio)
  return out
}
/** Resolve a model's size for (AR, quality tier) → {width,height}, or null. */
function modelDims(modelId: string | undefined, ar: string, tier: string): { width: number; height: number } | null {
  const sizes = modelSizes(modelId)
  if (!sizes || !modelId) return null
  const info = isCatalog.value.get(modelId)
  let forAr = sizes.filter(s => s.aspect_ratio === ar)
  if (!forAr.length) {
    const defAr = info?.default_aspect_ratio || sizes[0]!.aspect_ratio
    forAr = sizes.filter(s => s.aspect_ratio === defAr)
  }
  if (!forAr.length) return null
  const byTier = (t: string) => forAr.find(s => s.tier === t)
  const ends = (dir: 1 | -1) => [...forAr].sort((a, b) => (a.width - b.width) * dir)[0]!
  let pick: IsSize | undefined
  if (tier === 'fast') pick = byTier('fast') || ends(1)
  else if (tier === 'highest') pick = byTier('ultra') || byTier('high') || ends(-1)
  else pick = byTier('balanced') || forAr.find(s => s.default) || forAr[Math.floor(forAr.length / 2)]
  return pick ? { width: pick.width, height: pick.height } : null
}
function legacyDimsFor(aspectRatio: string, scale: number): { width: number; height: number } {
  const base = LOCAL_ASPECT_PRESETS[aspectRatio] || LOCAL_ASPECT_PRESETS['1:1']!
  const s = (scale || 100) / 100
  return { width: round16(base[0] * s), height: round16(base[1] * s) }
}
// {width,height} for a subform: model menu first (incl cloud → full res), then the
// legacy local table, then null for menu-less cloud models (aspect string).
function sizeBodyFor(sf: ImagesSubForm): { width: number; height: number } | null {
  const d = modelDims(sf.model, sf.aspect_ratio, sf.render_tier)
  if (d) return d
  return isLocalModelId(sf.model) ? legacyDimsFor(sf.aspect_ratio, sf.render_scale) : null
}
// Active-tab helpers drive the resolution control shown in the form.
const activeModelHasSizes = computed(() => !!modelSizes(activeForm.value.model))
const activeIsLocalModel = computed(() => isLocalModelId(activeForm.value.model))
function activeLegacyDimsLabel(scale: number): string {
  const d = legacyDimsFor(activeForm.value.aspect_ratio, scale)
  return `${d.width}×${d.height}`
}
const activeTierDimsLabel = computed(() => {
  const d = modelDims(activeForm.value.model, activeForm.value.aspect_ratio, activeForm.value.render_tier)
  return d ? `${d.width}×${d.height}` : ''
})
// Per-kind sizes passed down to each ImageGeneratorPanel so its bulk + per-row
// renders carry the same pixels the form shows.
const sceneRenderSize = computed(() => sizeBodyFor(form.scene))
const thumbnailRenderSize = computed(() => sizeBodyFor(form.thumbnail))

const generateButtonLabel = computed(() => {
  if (form.mode === 'scenes') return 'Generate Scene Images'
  return 'Generate Thumbnail Images'
})

const generatingLabel = computed(() => {
  if (form.mode === 'scenes') return 'Generating scene images'
  return 'Generating thumbnail images'
})

const generating = computed(() => {
  if (form.mode === 'scenes') return imageGenerating.value
  return thumbImageGenerating.value
})

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
    form.mode === 'thumbs' ? ['thumb_images'] : ['scene_images'],
  ),
)

// v1.0.88+: keep form.mode in sync with the route's ?tab= query so the
// sidebar's split "Thumbnail Generator" / "Scene Generator" entries
// drive the active tab, and browser back/forward navigation moves
// between them. Mapping: query 'thumbnails'/'scenes' ↔ form.mode
// 'thumbs'/'scenes'. The legacy unified "all" mode is not loaded by the
// split generator pages.
const _router = useRouter()
if (route.query.tab === 'scenes') {
  void _router.replace({ query: { ...route.query, tab: 'thumbnails' } })
}
watch(() => form.mode, (m) => {
  if (m !== 'thumbs' && m !== 'scenes') return
  const desired = m === 'scenes' ? 'scenes' : 'thumbnails'
  const cur = String(route.query.tab || 'thumbnails')
  if (cur === desired) return
  _router.replace({ query: { ...route.query, tab: desired } })
})

function getConfirmationType(): 'scene_images' | 'thumb_images' {
  if (form.mode === 'scenes') return 'scene_images'
  return 'thumb_images'
}

// ── Image integrity pill ────────────────────────────────────────────────
// Authoritative chapter count from the chunked-progress sidecar. Loaded
// when the episode changes. Used by the integrity card to detect "stale
// prompts" — i.e. the prompt docx has fewer entries than the outline
// has chapters, which means the user regenerated the outline at a
// different count (e.g. title's [N] flipped from 7 to 20) but didn't
// re-run Scene Prompts. Without this signal the integrity card would
// happily say "✓ 7 scenes present" even though the user expects 20.
const outlineChapterCount = ref<number | null>(null)
async function loadOutlineChapterCount() {
  const ep = form.episode_id
  const project = slug.value
  const scope = imageScopeSequence
  const current = () => scope === imageScopeSequence && project === slug.value && ep === form.episode_id
  outlineChapterCount.value = null
  if (!ep || !project) return
  try {
    const data = await get<{ total_chapters?: number }>(
      `/projects/${project}/episodes/${ep}/outline`,
    )
    if (!current()) return
    if (typeof data?.total_chapters === 'number' && data.total_chapters > 0) {
      outlineChapterCount.value = data.total_chapters
    }
  } catch {
    if (!current()) return
    // No sidecar yet — leave null so the integrity card just shows the
    // existing prompt-vs-image comparison without the new tier.
  }
}

// "Prompts are stale relative to outline" detector. True when:
//   - We have an outline chapter count (sidecar present), AND
//   - The scene-prompts docx has fewer entries than the outline's
//     total_chapters.
// When true, the integrity card surfaces a warning pill + a direct
// link back to Scene Prompts so the user regenerates prompts before
// burning provider calls on a wrong-count batch. Triggered by, for
// example, the user changing the title's listicle [N] from 7 → 20
// and rebuilding the outline at 20 without rerunning prompts.
const promptsStaleVsOutline = computed<{ stale: boolean; promptCount: number; chapterCount: number }>(() => {
  // Thumbnail prompts are not expected to match chapter count. This warning is
  // scene-only; showing it on the Thumbnail Generator leaks scene workflow state.
  if (form.mode === 'thumbs') return { stale: false, promptCount: 0, chapterCount: 0 }
  const chapterCount = outlineChapterCount.value
  const promptCount = imageStatus.scenes?.total ?? 0
  if (!chapterCount || promptCount <= 0) return { stale: false, promptCount: 0, chapterCount: 0 }
  return { stale: promptCount < chapterCount, promptCount, chapterCount }
})

// Fetches on-disk status and provider-history recoverability together so the
// page never presents a fresh-generation gap as a free repair candidate.
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
    loading: false, error: '', hasAny: false,
    scenes: null, thumbnails: null,
    hasMissing: false, totalMissing: 0,
    missingScenesList: '', missingThumbsList: '',
  }
}
const imageStatus = reactive<ImageStatusState>(emptyImageStatus())
let imageStatusLoadSequence = 0

// v1.0.306 — the integrity card is scoped to the ACTIVE generator pool. The
// Thumbnail Generator and Scene Generator are separate pages; each shows +
// repairs only its own pool, not both. (Repair is the user's favourite
// money-saver — keeping the pools separate avoids re-checking the wrong half.)
const integrityPool = computed<'scenes' | 'thumbnails'>(() => form.mode === 'thumbs' ? 'thumbnails' : 'scenes')
const activePoolStatus = computed(() => form.mode === 'thumbs' ? imageStatus.thumbnails : imageStatus.scenes)
const activeMissingCount = computed(() => activePoolStatus.value?.missing.length ?? 0)
const activeMissingList = computed(() => form.mode === 'thumbs' ? imageStatus.missingThumbsList : imageStatus.missingScenesList)
const activePoolLabel = computed(() => form.mode === 'thumbs' ? 'thumbnails' : 'scenes')
const activePreviewKind = computed<'scene' | 'thumbnail'>(() => form.mode === 'thumbs' ? 'thumbnail' : 'scene')
const activePromptRows = computed(() => form.mode === 'thumbs' ? promptList.thumbnails : promptList.scenes)
const repairStatus = reactive<{ scene: RepairPoolStatus | null; thumb: RepairPoolStatus | null }>({ scene: null, thumb: null })
const activeRepairPool = computed(() => form.mode === 'thumbs' ? repairStatus.thumb : repairStatus.scene)
const activeRepairItems = computed(() => activeRepairPool.value?.missing_items || [])
const activeRecoverableCount = computed(() => activeRepairPool.value?.with_manifest || 0)
const activeFreshCount = computed(() => activeRepairPool.value?.without_manifest || 0)
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
  if (job.status === 'running') return 'checking provider history'
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
    imageStatus.scenes = r.scenes ?? null
    imageStatus.thumbnails = r.thumbnails ?? null
    imageStatus.hasAny = !!(r.scenes || r.thumbnails)
    const missScene = imageStatus.scenes?.missing.length ?? 0
    const missThumb = imageStatus.thumbnails?.missing.length ?? 0
    imageStatus.hasMissing = missScene + missThumb > 0
    imageStatus.totalMissing = missScene + missThumb
    imageStatus.missingScenesList = missScene > 0 ? imageStatus.scenes!.missing.join(', ') : ''
    imageStatus.missingThumbsList = missThumb > 0 ? imageStatus.thumbnails!.missing.join(', ') : ''
    repairStatus.scene = repair.scene
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
    // v1.0.306 — scope the repair to this page's pool (thumbnails on the
    // Thumbnail Generator, scenes on the Scene Generator).
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/generate/images-repair`, {
      episode_id: form.episode_id,
      pool: integrityPool.value,
    })
    lastRepairJobId.value = job.job_id
    success(`${activePoolLabel.value === 'thumbnails' ? 'Thumbnail' : 'Scene'} repair queued — watch progress in Jobs.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue repair')
  } finally {
    submitting.value = false
  }
}

async function generateMissingFresh() {
  await queueGeneration(false, `Fresh generation queued for ${activeFreshCount.value} missing ${activePoolLabel.value}.`)
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
let editScanLoadSequence = 0
const activeEditImages = computed(() => form.mode === 'thumbs' ? editThumbs.value : editScenes.value)

// v1.0.87+: cache-bust key for the new ImageGeneratorPanel components.
// Bumped after a per-row or bulk render completes inside either panel
// so the parent Edit gallery + image-integrity card can pick up the
// new files on the next refresh. Mirrors the pattern used by the
// Prompts page (reviewRefreshKey for PromptReviewPanel).
//
// v1.2.9: this is now the page's ONE "the pixels on disk may have changed"
// signal. It feeds the panels' `refreshKey`, the Browse grid's URLs and the
// lightbox's `version`, and `loadEditScan()` bumps it, so every path that
// re-reads the disk also re-fetches the images.
const igPanelRefreshKey = ref(0)

function onPanelRefresh() {
  // Re-run the Edit gallery's scan so its grid + the integrity card stay
  // in sync with whatever the panels just wrote — loadEditScan() bumps
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
  editScanLoading.value = true
  editScanError.value = ''
  try {
    const r = await get<{ scenes?: ScannedImage[]; thumbnails?: ScannedImage[] }>(
      `/projects/${project}/video-editor/scan/${ep}`,
    )
    if (requestSequence !== editScanLoadSequence || !current()) return
    editScenes.value = (r.scenes || []).slice().sort(
      (a, b) => (a.scene_number ?? 999) - (b.scene_number ?? 999),
    )
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
    editScanError.value = e?.data?.detail || e?.message || 'Could not list existing images'
  } finally {
    if (requestSequence === editScanLoadSequence && current()) editScanLoading.value = false
  }
}

// ── Lightbox / carousel ──────────────────────────────────────────────────
// Tile clicks open this fullscreen preview. The user browses with ← / →
// and closes it with Escape.
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
  if (form.mode === 'scenes') {
    for (const s of editScenes.value) {
      out.push({ filename: s.filename, path: s.path, section: 'scenes', scene_number: s.scene_number ?? null })
    }
  } else {
    for (const t of editThumbs.value) {
      out.push({ filename: t.filename, path: t.path, section: 'thumbnails' })
    }
  }
  return out
})

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
// Cache-buster for refreshed disk previews. v1.2.9: this used to read a
// private `_editKey` ref that nothing ever incremented — a cache-buster that
// never busted, so the Browse grid kept showing pre-regeneration pixels for
// as long as the page stayed mounted. It now shares `igPanelRefreshKey`, the
// one signal this page has that the files on disk may have been rewritten.
function getImagePreviewUrlImages(path: string): string {
  return `/api/projects/${slug.value}/video-editor/preview-image?path=${encodeURIComponent(path)}&k=${igPanelRefreshKey.value}`
}

// Episode-id watcher MUST come after the editScenes/editThumbs
// declarations above — `{ immediate: true }` fires this synchronously
// during setup, and the else-branch reads those refs. See comment above.
watch([slug, () => form.episode_id], ([, v]) => {
  lastRepairJobId.value = ''
  repairStatus.scene = null
  repairStatus.thumb = null
  // v1.4.196 — blank on the CHANGE, not only when the episode becomes empty.
  // `refreshImageStatus` and `loadEditScan` replace their results only on a
  // SUCCESSFUL read, so switching from one episode to another left the previous
  // episode's integrity figures and Browse grid on screen for the whole load —
  // and permanently if the read failed (AGENTS.md §4). The old code cleared
  // these ONLY in the else branch, i.e. when there was no episode at all.
  Object.assign(imageStatus, emptyImageStatus())
  editScenes.value = []
  editThumbs.value = []
  outlineChapterCount.value = null
  if (v) {
    refreshImageStatus()
    void loadEditScan()
    void loadOutlineChapterCount()
  }
}, { immediate: true })

function generationParams(forceOverride?: boolean) {
  // A submit can occur before Vue flushes a catalogue/preset watcher.
  if (!normalizeImageAspectRatio(activeForm.value)) return null
  // Missing-only is the safe default. Regeneration is the one explicit
  // overwrite action exposed by the thumbnail and scene boards.
  const force = forceOverride ?? activeForm.value.generation_mode === 'regenerate'
  const params: any = {
    episode_id: form.episode_id,
    model: activeForm.value.model,
    mode: form.mode,
    aspect_ratio: activeForm.value.aspect_ratio,
    image_mode: thumbnailReferenceActive.value ? 'img2img' : 'text2img',
    ...(thumbnailReferenceActive.value ? { thumbnail_reference_asset: (config.value as any).thumbnail_reference_asset } : {}),
    force,
  }
  // Forward a tier only when the active model has tiers.
  if (activeForm.value.tier) params.tier = activeForm.value.tier
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

async function queueGeneration(forceOverride?: boolean, queuedMessage = 'Image generation queued!') {
  const params = generationParams(forceOverride)
  if (!params) {
    showError('This model has no published aspect ratios. Refresh the catalogue or choose another model before generating.')
    return
  }
  if (!await confirmGeneration(slug.value, getConfirmationType(), params)) return
  // Never replace a confirmed choice with a new model/ratio behind the dialog.
  if (activeForm.value.model !== params.model || form.mode !== params.mode
    || activeForm.value.aspect_ratio !== params.aspect_ratio
    || !modelArs(params.model)?.includes(params.aspect_ratio)) {
    showError('The image model or aspect ratio changed during confirmation. Review the current selection and generate again to confirm it.')
    return
  }
  const operationId = params.force ? freshImagesAction.begin(params) : null
  if (operationId) params.operation_id = operationId

  submitting.value = true
  if (form.mode === 'thumbs') thumbImageGenerating.value = true
  else imageGenerating.value = true

  try {
    await post(`/projects/${slug.value}/generate/images`, params)
    if (operationId) freshImagesAction.complete(operationId)
    success(queuedMessage)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to queue image generation')
    imageGenerating.value = false
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

/* Preview-what-will-be-generated card header. Click target spans the
   whole row (icon + title + on-disk count summary) so it's easy to
   collapse / expand. */
.preview-card-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  padding: 4px 0;
  cursor: pointer;
  text-align: left;
}
.preview-card-toggle:hover .preview-card-title { color: var(--accent); }
.preview-card-icon { color: var(--text-muted); width: 14px; text-align: center; }
.preview-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  flex: 1 1 auto;
  /* Explicit color so the title is readable in dark theme — without it
     the h3 inherited near-black on near-black and only became visible
     on hover (the existing :hover rule sets var(--accent)). */
  color: var(--text-primary);
}
.preview-card-blurb { margin: 6px 0 12px; }
.preview-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.preview-list-section {
  margin-top: 12px;
  font-size: var(--font-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.preview-list-section:first-child { margin-top: 0; }
.preview-row { padding: 0; }
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
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}

/* v1.0.41 — pinned-thumbnail visuals. Amber border + corner badge so a
   single glance at the grid tells the user "this one will go to YouTube". */
.edit-image-tile.is-pinned-thumb {
  border-color: rgba(217, 119, 6, 0.85);
  box-shadow: 0 0 0 1px rgba(217, 119, 6, 0.35);
}
.edit-image-tile .pinned-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(217, 119, 6, 0.92);
  color: white;
  font-size: var(--font-xs);
  padding: 2px 6px;
  border-radius: 999px;
  pointer-events: none;
}
.edit-grid-heading-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.edit-grid-heading-row .edit-grid-heading {
  margin-bottom: 0;
}
.link-btn {
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
}
.link-btn:hover { color: var(--accent-hover, var(--accent)); }

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
.generation-mode-option .text-muted { display: block; font-size: var(--font-xs); color: var(--text-muted); margin-top: 2px; }

/* Tier picker — compact pill row sized to fit alongside the model dropdown. */
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
.tier-option-cost { color: var(--text-muted); font-size: var(--font-xs); }
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

/* v1.0.201 — focused-view header (replaces the thumbnail/scene switcher). */
.generator-mode-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.generator-mode-head strong { font-size: 15px; }
.generator-mode-icon { font-size: 16px; }

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
.mode-tab:disabled { cursor: not-allowed; }
.mode-tab.is-coming-soon { opacity: .62; }
.mode-tab.is-coming-soon:hover { color: var(--text-secondary); background: transparent; }
.mode-tab.active {
  background: var(--accent-dim);
  color: var(--accent);
  border-color: rgba(240, 198, 116, 0.3);
}
.mode-tab-icon { font-size: 18px; }
.mode-tab-label { font-weight: 600; font-size: 13px; }
.mode-tab-label small { margin-left: 5px; color: var(--accent); font-size: var(--font-xs); font-weight: 700; }
.mode-tab-hint { font-size: var(--font-xs); color: var(--text-muted); }
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

/* Prompt-cap pill + caps reference modal. */
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
</style>
