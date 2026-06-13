<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">{{ form.mode === 'thumbs' ? 'Thumbnail Generator' : 'Scene Generator' }}</h1>
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
      :generate-loading="submitting || imageJobActiveForEpisode"
      :generate-disabled="!form.episode_id"
      :generate-status="(generating || imageJobActiveForEpisode) ? `${generatingLabel} for ${form.episode_id}…` : ''"
      @generate="submit"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
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

    <p class="text-muted mt-1 mb-2">
      {{ form.mode === 'thumbs'
        ? 'Generate YouTube thumbnail artwork from your thumbnail prompts.'
        : 'Generate scene artwork from your scene prompts.' }}
    </p>

    <!-- Image mode tabs (Text → Image vs Image → Image). Mirrors the
         video page's Text→Video / Image→Video pattern. Default is
         text2img — the existing flow, unchanged. img2img surfaces an
         additional reference-sources card and filters the model
         dropdown to img2img-capable models. -->
    <div class="mode-tabs mt-3" role="tablist" aria-label="Image generation pipeline">
      <button
        v-for="tab in imageModeTabs" :key="tab.id"
        :class="['mode-tab', { active: activeForm.image_mode === tab.id }]"
        role="tab"
        :aria-selected="activeForm.image_mode === tab.id"
        @click="selectImageMode(tab.id)"
      >
        <span class="mode-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
        <span class="mode-tab-label">{{ tab.label }}</span>
        <span class="mode-tab-hint">{{ tab.hint }}</span>
      </button>
    </div>

    <!-- v1.0.201 — the in-page Thumbnail/Scene switcher was removed so each
         sidebar entry (Thumbnail Generator / Scene Generator) is its own
         focused view. The mode is set by the sidebar's ?tab=; switch via the
         sidebar. Formats that don't use scenes (broll, timestamp, continuity-
         chain) only show Thumbnail Generator in the sidebar, so no scene
         controls leak in here. -->
    <div class="generator-mode-head mt-2">
      <span class="generator-mode-icon" aria-hidden="true">{{ form.mode === 'thumbs' ? '📸' : '🎬' }}</span>
      <strong>{{ form.mode === 'thumbs' ? 'Thumbnail Generator' : 'Scene Generator' }}</strong>
      <span class="text-muted text-xs">{{ form.mode === 'thumbs' ? 'YouTube thumbnails' : 'Story artwork (scene images)' }}</span>
    </div>

    <div class="card mt-2">
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
            :image-mode="activeForm.image_mode"
          />
          <span v-if="form.mode === 'thumbs'" class="text-muted text-xs">
            Tip: Use a higher-quality model for eye-catching thumbnails
          </span>
          <!-- Prompt-character cap indicator. Surfaces the documented limit
               for the active model so users know how long their image
               prompts can be before the provider rejects/silently truncates.
               Cap values come from electron/server/models/defaults.ts and
               are approximate — clickable "View all caps" link below opens
               the full reference table. -->
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
            <button type="button" class="cap-link" @click="showCapsTable = true">View all caps →</button>
          </span>
          <!-- Img2img mode: warn the user when their current model can't
               actually consume references — kie.ai silently ignores the
               field on text-only models, which would look like img2img
               mode "doing nothing." -->
          <span v-if="activeForm.image_mode === 'img2img' && !currentModelSupportsRefs"
                class="text-danger text-xs"
                title="In Image → Image mode this model will silently ignore reference images and behave as text-to-image. Pick a model with reference support (Flux Kontext, Nano Banana, Qwen Image 2, GPT Image 2)."
          >
            ⚠ This model doesn't support reference images — pick one of the img2img-capable models above.
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
              :class="{ active: activeForm.tier === t.id }"
            >
              <input type="radio" :value="t.id" v-model="activeForm.tier" />
              <span class="tier-option-label">{{ t.label }}</span>
              <span class="tier-option-cost">{{ t.credits }} cr · ~{{ formatUsd(t.credits) }}</span>
            </label>
          </div>
        </div>
      </div>

      <div class="grid-3">
        <div class="form-group">
          <label>Aspect Ratio</label>
          <select v-model="activeForm.aspect_ratio" class="select">
            <option v-for="ar in aspectRatios" :key="ar.value" :value="ar.value">
              {{ ar.value }} — {{ ar.label }}
            </option>
          </select>
        </div>
        <!-- v1.0.308 — render-size tier for LOCAL Image Studio models. Hidden
             for cloud models (they use the aspect string, not pixels). Lower
             resolution = less GPU/VAE memory, faster renders, smaller files. -->
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
              {{ rs.label }} — {{ activeDimsLabel(rs.value) }}
            </option>
          </select>
          <p class="text-muted text-xs mt-1">
            Lower = less GPU load + faster on local Macs.
            <template v-if="activeForm.render_scale !== 100">Sending {{ activeDimsLabel(activeForm.render_scale) }} px.</template>
            <template v-else>Full resolution.</template>
          </p>
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
          <label class="generation-mode-option">
            <input type="radio" value="new_version" v-model="activeForm.generation_mode" />
            <div>
              <strong>New version</strong>
              <span class="text-muted">Currently behaves like Skip — _v2 image variants are planned.</span>
            </div>
          </label>
        </div>
      </div>

    </div>

    <!-- ── Image-to-image reference sources ───────────────────────────────
         Only mounts in img2img mode. Surfaces the four configurable
         reference sources (master / per-scene / characters / chain)
         + the upload UI for the file-backed sources. Toggles bind to
         activeForm.reference_sources which is sent to the backend on submit. -->
    <Img2ImgReferencesCard
      v-if="form.mode === 'scenes' && activeForm.image_mode === 'img2img' && form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="ep2imgTitle"
      :value="activeForm.reference_sources"
      @update:value="activeForm.reference_sources = $event"
    />

    <!-- ── Style Preview card ──────────────────────────────────────────────
         Free-form "what does THIS style look like?" sample render, using
         the model + aspect + tier picked above. Episode-independent —
         visible without picking an episode. Cached app-wide by
         sha256(style + model + aspect + tier); re-clicking the same combo
         is free, switching any input bills a fresh render once. -->
    <StylePreviewCard
      :project-slug="slug"
      :model="activeForm.model"
      :aspect-ratio="activeForm.aspect_ratio"
      :tier="activeForm.tier"
      :model-label="modelLabelForStylePreview"
      :episode-id="form.episode_id || ''"
      :episode-title="selectedEpisode?.title || ''"
      :kind="form.mode === 'thumbs' ? 'thumbnail' : 'scene'"
    />

    <!-- ── Per-tab generator panel (v1.0.87+) ─────────────────────────────
         Each panel lists the episode's prompts for ONE kind (scene or
         thumbnail), shows the rendered image inline per row, and exposes
         per-row Generate / Regenerate buttons plus a top "Generate All N"
         bulk button. Replaces the old all-or-nothing top Generate flow as
         the PRIMARY interaction surface. Form fields above (model, aspect
         ratio, generation_mode, reference sources) flow into both panels.
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
      :image-mode="form.thumbnail.image_mode"
      :tier="form.thumbnail.tier"
      :reference-sources="form.thumbnail.reference_sources"
      :render-width="thumbnailRenderSize?.width"
      :render-height="thumbnailRenderSize?.height"
      :refresh-key="igPanelRefreshKey"
      :prompt-char-cap="thumbnailModelInfo.cap"
      :model-label="thumbnailModelInfo.label"
      @open-preview="openLightboxAt"
      @refresh="onPanelRefresh"
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
      :image-mode="form.scene.image_mode"
      :tier="form.scene.tier"
      :reference-sources="form.scene.reference_sources"
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
         is free; switching any input invalidates and bills a fresh
         render (~$0.005 on kie.ai).

         Hidden until prompts exist on disk and the user expands the
         card — keeps the page calm by default; the user opts in.
    -->
    <div v-if="form.episode_id" class="card mt-2" aria-labelledby="image-preview-heading">
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
          {{ activePromptRows.length }} {{ form.mode === 'thumbs' ? 'thumbnail' : 'scene' }} prompt(s) on disk
        </span>
      </button>
      <p v-if="previewOpen" class="text-muted text-sm preview-card-blurb">
        Inspect the {{ form.mode === 'thumbs' ? 'thumbnail' : 'scene' }} prompts that will be sent to the image provider,
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
          <li class="preview-list-section">{{ form.mode === 'thumbs' ? 'Thumbnails' : 'Scenes' }}</li>
          <li v-for="row in activePromptRows" :key="`${activePreviewKind}-${row.number}`" class="preview-row">
            <PreviewPromptRow
              :row="row"
              :prefix="form.mode === 'thumbs' ? 'Thumbnail' : 'Scene'"
              :state="previewState[previewKey(activePreviewKind, row.number)] || null"
              @preview="renderPromptPreview(activePreviewKind, row)"
            />
          </li>
        </ul>
        <div v-if="!activePromptRows.length" class="text-muted text-md">
          No prompts found yet. Generate them on the
          <NuxtLink :to="`/projects/${slug}/image-prompts?tab=${form.mode === 'thumbs' ? 'thumbnails' : 'scenes'}`">{{ promptPageLabel }}</NuxtLink> page first.
        </div>
      </template>
    </div>

    <!-- Image integrity pill + Repair. Generators skip existing non-empty -->
    <!-- files natively, so Repair = re-submit the same form with force=false. -->
    <div v-if="form.episode_id" class="card mt-2" aria-labelledby="image-integrity-heading">
      <h3 id="image-integrity-heading" class="integrity-title">Image integrity</h3>
      <p class="text-muted text-sm integrity-blurb">
        Check whether every expected image is on disk. <strong>Repair missing</strong>
        queues a new job with the current form settings — the generator automatically
        skips {{ activePoolLabel }} that already have ≥1 variant with content.
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
          v-if="promptsStaleVsOutline.stale"
          class="integrity-pill warn"
          :title="`The outline has ${promptsStaleVsOutline.chapterCount} chapters but only ${promptsStaleVsOutline.promptCount} scene prompts exist on disk. Regenerate Scene Prompts at the new chapter count first — otherwise images will only cover ${promptsStaleVsOutline.promptCount} of the ${promptsStaleVsOutline.chapterCount} chapters.`"
        >
          ⚠ Prompts stale: {{ promptsStaleVsOutline.promptCount }} / {{ promptsStaleVsOutline.chapterCount }} chapters
        </span>
        <NuxtLink
          v-if="promptsStaleVsOutline.stale"
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
          v-if="activeMissingCount > 0"
          class="btn btn-sm btn-secondary"
          :disabled="submitting || generating || promptsStaleVsOutline.stale"
          :title="promptsStaleVsOutline.stale
            ? 'Prompts are stale vs the outline — regenerate prompts first so the repair targets the right chapter count.'
            : `Re-fetches missing ${activePoolLabel} from provider history — no credit cost. Existing files with content are skipped.`"
          @click="repairMissing"
        >
          Repair missing {{ activePoolLabel }} ({{ activeMissingCount }})
        </button>

        <button class="btn btn-sm btn-ghost" :disabled="imageStatus.loading" @click="refreshImageStatus">
          Refresh
        </button>
      </div>

      <div v-if="activeMissingList" class="missing-detail mt-2">
        <div class="text-muted text-sm">
          Missing {{ activePoolLabel }}: {{ activeMissingList }}
        </div>
      </div>
    </div>

    <!-- ── Edit existing image (AI clean-up / removal) ────────────────────
         Tile grid that lists the active image pool and
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
            <img :src="getImagePreviewUrlImages(scn.path)" :alt="scn.filename" class="edit-image-thumb" />
            <span class="edit-image-label">S{{ scn.scene_number ?? '?' }}</span>
          </button>
        </div>
      </div>

      <!-- Thumbnails -->
      <div v-if="form.mode === 'thumbs' && editThumbs.length" class="mt-2">
        <div class="edit-grid-heading-row">
          <h4 class="edit-grid-heading">Thumbnails ({{ editThumbs.length }})</h4>
          <span class="text-muted" style="font-size: 11px;">
            <template v-if="pinnedThumbnailFilename">
              📌 <strong>{{ pinnedThumbnailFilename }}</strong> will be uploaded.
              <button class="link-btn" type="button" @click="setThumbnailPin(null)">Unpin</button>
            </template>
            <template v-else-if="autoThumbnailFilename">
              Auto-picking <strong>{{ autoThumbnailFilename }}</strong> for upload (highest version).
              Click any thumbnail and use 📌 Pin to lock a different one.
            </template>
          </span>
          <!-- v1.0.104+ — niche-templated text overlay composer. Opens
               a modal that POSTs to /thumbnails/compose with the active
               niche's thumbnailTemplate. Disabled until at least one
               thumbnail exists to compose over. -->
          <button
            type="button"
            class="btn btn-sm btn-secondary thumbnail-compose-btn"
            :disabled="!editThumbs.length || !form.episode_id"
            :title="!editThumbs.length
              ? 'Generate at least one thumbnail first — Compose layers text over an existing image.'
              : 'Layer the niche\'s title + subtitle + accent rule over one of these thumbnails.'"
            @click="openComposeDialog"
          >
            ✏️ Compose with text…
          </button>
        </div>
        <div class="edit-image-grid">
          <button
            v-for="(thumb, ti) in editThumbs"
            :key="thumb.path"
            type="button"
            :class="['edit-image-tile', { 'is-pinned-thumb': thumb.filename === pinnedThumbnailFilename }]"
            :title="thumb.filename === pinnedThumbnailFilename
              ? `📌 Pinned for upload — ${thumb.filename}. Click to preview, or use the Unpin button to revert to auto-pick.`
              : `Preview ${thumb.filename}`"
            @click="openLightboxAt(thumb.path)"
          >
            <img :src="getImagePreviewUrlImages(thumb.path)" :alt="thumb.filename" class="edit-image-thumb" />
            <span class="edit-image-label">T{{ ti + 1 }}</span>
            <span v-if="thumb.filename === pinnedThumbnailFilename" class="pinned-badge" aria-label="Pinned for upload">📌</span>
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

    <!-- Lightbox: fullscreen preview + carousel. Tile clicks open this -->
    <!-- first; the user browses / decides, then triggers Edit which -->
    <!-- closes the lightbox and opens ImageEditDialog on the same path. -->
    <!-- v1.0.41: pin-toggle is enabled when the current image is a -->
    <!-- thumbnail (the lightbox + parent both gate on `section`). -->
    <ImagePreviewLightbox
      v-model:visible="lightboxOpen"
      v-model:index="lightboxIndex"
      :images="allEditableImagesWithPin"
      :project-slug="slug"
      :pin-enabled="currentLightboxIsThumbnail"
      @edit="onLightboxEdit"
      @pin-toggle="onLightboxPinToggle"
    />

    <!-- Shared AI image-edit dialog. Mounted once at the page root; -->
    <!-- triggered from inside the lightbox (Edit with AI button / Enter). -->
    <ImageEditDialog
      v-model="imageEditOpen"
      :project-slug="slug"
      :image-path="imageEditTarget || ''"
      @accepted="onImageEditAccepted"
    />

    <!-- Niche-templated thumbnail composer (v1.0.104+). Opens from the -->
    <!-- "✏️ Compose with text" button on the thumbnail grid header. -->
    <!-- Pulls the niche's thumbnailTemplate on open, posts to the -->
    <!-- /thumbnails/compose endpoint, optionally pins the result. -->
    <ThumbnailComposeDialog
      v-model="composeOpen"
      :project-slug="slug"
      :episode-code="composeEpisodeCode"
      :thumbs="composeThumbs"
      :default-title="composeDefaultTitle"
      :initial-source-filename="composeInitialSource"
      @composed="onComposeFinished"
      @pinned="onComposePinned"
    />

    <!-- Provider prompt-cap reference table. Mounts on demand from the
         "View all caps →" link beside the model selector. Sorted strict-
         first so the user can immediately spot the tight providers
         (Seedream variants at ~500 chars) vs. the generous ones
         (Nano Banana at ~5000). All numbers approximate — recorded from
         each provider's published docs at last audit, see
         electron/server/models/defaults.ts:prompt_char_cap. -->
    <div v-if="showCapsTable" class="modal-overlay" @click.self="showCapsTable = false">
      <div class="caps-modal">
        <div class="caps-modal-head">
          <h3>Image model prompt-character caps</h3>
          <button type="button" class="caps-modal-close" @click="showCapsTable = false" title="Close">×</button>
        </div>
        <p class="text-muted text-sm caps-modal-intro">
          Approximate per-prompt character limits documented by each provider. A prompt longer than
          the cap is typically rejected outright or silently truncated — wasting credits either way.
          Keep prompts under the cap of whichever model you choose. Numbers refresh as
          providers update their docs.
        </p>
        <div class="caps-table-wrap">
          <table class="caps-table">
            <thead>
              <tr>
                <th>Model</th>
                <th class="caps-th-right">Prompt cap</th>
                <th class="caps-th-right">Credits / image</th>
                <th>Refs?</th>
                <th>Provider</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in allModelCaps" :key="row.id"
                  :class="{ 'caps-row-active': row.id === activeForm.model }">
                <td>{{ row.label }}</td>
                <td class="caps-td-right">
                  <template v-if="row.cap">~{{ row.cap.toLocaleString() }}</template>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="caps-td-right">
                  <template v-if="row.credits != null">{{ row.credits }}</template>
                  <span v-else class="text-muted">—</span>
                </td>
                <td>
                  <span v-if="row.supportsRefs" title="Supports reference / img2img images">✓</span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="text-muted">{{ row.provider }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, get } = useApi()
const { config } = useProject()

// All image models currently go via kie.ai. Grouping future-proofs the
// dropdown for when a second provider is added.
//
// v1.0.152 — the legacy `imageModelGroups` computed + the
// `formatModelOption(m)` formatter that drove the old <optgroup>
// <select> have been removed. ImageModelPicker (introduced in 1.0.152)
// owns the grouping, search, capability filter, and label formatting
// internally. The picker reads `config.image_models` directly and
// emits a model id back into activeForm.value.model — every existing
// downstream watch / computed (cap, tier, label) continues to fire
// unchanged because the bound value type didn't change.

// Surface a hint when the user's currently-selected model isn't in the
// img2img-eligible list, so they aren't surprised by silent text2img
// fallback. Read from the same supports_reference_images flag.
const currentModelSupportsRefs = computed(() => {
  const cfg = (config.value?.image_models || {} as any)[activeForm.value.model]
  const params = cfg?.provider_params || cfg
  return params?.supports_reference_images === true
})
const { success, error: showError } = useToast()
const { imageGenerating, thumbImageGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()
const { isJobActiveFor } = useJobs()

const submitting = ref(false)
const specificNum = ref<number | null>(null)

type Mode = 'all' | 'scenes' | 'thumbs'

type ImageMode = 'text2img' | 'img2img'
interface ReferenceSources { master: boolean; per_scene: boolean; characters: boolean; chain: boolean }

// v1.0.88+: form is split into two completely independent per-kind
// sub-objects (form.thumbnail + form.scene). Each carries its own model,
// aspect_ratio, tier, image_mode, generation_mode, and reference_sources.
// `mode` and `episode_id` stay at the top level — they're the tab
// selector and the episode pick, both inherently page-level.
//
// `activeForm` below is a computed proxy returning the sub-object that
// matches the active tab; template bindings on shared-field controls
// (Model picker, Aspect Ratio dropdown, Generation Mode radios, img2img
// references card) all flow through this so editing the visible control
// updates only the active kind's state. Switching tabs swaps the entire
// surface — Thumbnail tab's Flux Kontext model and 1:1 aspect ratio
// won't leak into the Scene tab's seedream + 16:9 setup.
type ImagesSubForm = {
  model: string
  aspect_ratio: string
  generation_mode: 'skip' | 'regenerate' | 'new_version'
  tier: string
  image_mode: ImageMode
  reference_sources: ReferenceSources
  // v1.0.308 — render-size tier for LOCAL Image Studio models (100 = Full,
  // 75 = Balanced, 50 = Light). Scales the aspect's base pixels; cloud models
  // ignore it (they use the aspect string). Default 100 = no change.
  render_scale: number
}
const defaultSubForm = (): ImagesSubForm => ({
  model: 'grok-imagine',
  aspect_ratio: '16:9',
  // Unified Generation Mode (M6) — replaces the standalone `force` checkbox.
  // Translated to `force` at submit time; the backend's image generator
  // (generators/images.ts) only knows about that boolean today, so this
  // is purely a UI consolidation. Default 'skip' matches the prior
  // default behaviour (force=false).
  generation_mode: 'skip',
  // Tier id for variable-priced kie.ai models (nano-banana-2 1k/2k/4k,
  // ideogram-v3 turbo/balanced/quality, etc.). Flat-priced models ignore
  // this. Reset on model switch via the watcher below.
  tier: '',
  // Image-to-image pipeline (Phase 4). Default text2img preserves
  // every prior behaviour exactly. img2img surfaces the references
  // card and forwards reference_sources to the backend so the
  // generator can resolve master / per-scene / character / chain
  // refs and pass them through to provider.generateImage's
  // referenceImagePaths.
  image_mode: 'text2img',
  reference_sources: {
    // master + per_scene off by default — they require the user to
    // upload images. characters defaults ON (matches Phase 8 default).
    // chain off by default — it forces serial execution.
    master: false,
    per_scene: false,
    characters: true,
    chain: false,
  },
  // Local render size: Full by default so existing behaviour is unchanged.
  render_scale: 100,
})
const form = reactive({
  episode_id: '',
  // v1.0.87+: default to 'thumbs' so the page lands on the Thumbnails tab.
  // v1.0.88+: initial value picks up the route's ?tab= query so the
  // sidebar's split "Thumbnail Generator" / "Scene Generator" entries
  // land on the right tab. Query value 'scenes' → mode 'scenes'; any
  // other value (including missing) → 'thumbs'.
  mode: (route.query.tab === 'scenes' ? 'scenes' : 'thumbs') as Mode,
  thumbnail: defaultSubForm(),
  scene: defaultSubForm(),
})
const promptPageLabel = computed(() => form.mode === 'thumbs' ? 'Thumbnail Prompts' : 'Scene Prompts')
const generatorPageTitle = computed(() => form.mode === 'thumbs' ? 'Thumbnail Generator' : 'Scene Generator')
useAppTitle(generatorPageTitle)

// v1.0.259 — remember each tab's render settings (model / aspect / tier /
// image_mode / reference_sources) across reloads. `mode` is deliberately NOT
// remembered: it comes from the sidebar's ?tab= so the split Thumbnail/Scene
// entries always land on the right tab.
useRememberedForm('images', slug, form, { include: ['thumbnail', 'scene'] })

// Active sub-form. Switches between thumbnail/scene based on mode.
// Template auto-unwraps computed refs — `activeForm.model` Just Works
// there; script uses `activeForm.value.model`.
const activeForm = computed<ImagesSubForm>(() =>
  form.mode === 'thumbs' ? form.thumbnail : form.scene,
)

// Hydrate the selected episode so child components + computeds can read
// the human-readable title (resolveEpisodePaths needs it on the prompt-
// list fetch and the Img2ImgReferencesCard threads it through to its
// reference uploads). The Phase-4 image-to-image commit added
// selectedEpisode references at lines 708 / 823 but forgot to actually
// wire the composable that brings it into scope — flipping into img2img
// mode threw "selectedEpisode is not defined" on the first render of
// the references card.
const episodeIdRef = computed(() => form.episode_id)
const { selectedEpisode } = useEpisodeStatus(episodeIdRef, slug, {
  // Refetch when an upstream script job lands so the page picks up the
  // freshly-saved title without the user having to re-pick the episode
  // from the dropdown (mirrors video.vue's pattern).
  refetchOnJobTypes: ['script-only', 'expand_chapters'],
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

// Friendly model label for the StylePreviewCard's blurb. Falls back to
// the model id when the config doesn't have a label.
const modelLabelForStylePreview = computed(() => {
  const m = config.value?.image_models?.[activeForm.value.model] as any
  return (m?.label as string) || activeForm.value.model || ''
})

// Per-tab prompt-character cap + friendly label. Threaded into each
// ImageGeneratorPanel so the per-row char badge can colour-code against
// the provider's documented limit (advisory — see types.ts:prompt_char_cap).
// Each tab can be configured with a different model, so we resolve caps
// from form.thumbnail.model and form.scene.model independently.
function modelInfoFor(modelId: string) {
  const m = config.value?.image_models?.[modelId] as any
  return {
    cap: (m && typeof m.prompt_char_cap === 'number') ? (m.prompt_char_cap as number) : null,
    label: (m?.label as string) || modelId || '',
  }
}
const thumbnailModelInfo = computed(() => modelInfoFor(form.thumbnail.model))
const sceneModelInfo = computed(() => modelInfoFor(form.scene.model))
const activeModelCap = computed(() => (form.mode === 'thumbs' ? thumbnailModelInfo : sceneModelInfo).value.cap)
const activeModelLabel = computed(() => (form.mode === 'thumbs' ? thumbnailModelInfo : sceneModelInfo).value.label)

// All-models caps table — sorted by cap ascending so the strictest
// providers (e.g. Seedream at ~500) surface first. Built once per
// config change; the modal mounts on demand via showCapsTable.
const showCapsTable = ref(false)
const allModelCaps = computed(() => {
  const models = config.value?.image_models || {}
  return Object.entries(models).map(([id, raw]) => {
    const m = raw as any
    return {
      id,
      label: (m?.label as string) || id,
      provider: (m?.provider as string) || 'kie',
      cap: typeof m?.prompt_char_cap === 'number' ? m.prompt_char_cap : null,
      credits: typeof m?.credits_per_image === 'number' ? m.credits_per_image : null,
      supportsRefs: !!m?.supports_reference_images,
    }
  }).sort((a, b) => {
    if (a.cap == null && b.cap == null) return a.label.localeCompare(b.label)
    if (a.cap == null) return 1
    if (b.cap == null) return -1
    return a.cap - b.cap
  })
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
// would leave activeForm.value.tier='1k', which isn't a valid ideogram tier.
watch(() => activeForm.value.model, () => {
  const m = config.value?.image_models?.[activeForm.value.model] as any
  const tiers = Array.isArray(m?.tiers) ? m.tiers : []
  if (!tiers.length) {
    activeForm.value.tier = ''
    return
  }
  const def = tiers.find((t: any) => t.id === m.default_tier) ?? tiers[0]
  activeForm.value.tier = def?.id || ''
}, { immediate: true })

// ── Presets ─────────────────────────────────────────────────────────────
// v1.0.88+: presets are SPLIT per kind (thumbnail_generator vs
// scene_generator). Each tab maintains its own preset list so a
// "seedream + 16:9 + skip" thumbnail preset can't accidentally
// overwrite a "Flux Kontext + img2img + chain on" scene preset, and
// vice versa. The TopActionBar binds to whichever preset object
// matches the active tab via the `imgPresets` computed below.
//
// Legacy `image_generator_presets` is intentionally NOT migrated.
// Existing presets stay on disk under that key but no longer surface
// in the new split UI (re-save from the new tabs to materialize them).
const thumbnailGeneratorPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'thumbnail_generator',
  snapshot: () => ({ form: { ...form.thumbnail } }),
  apply: (data) => { if (data?.form) Object.assign(form.thumbnail, data.form) },
})
const sceneGeneratorPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'scene_generator',
  snapshot: () => ({ form: { ...form.scene } }),
  apply: (data) => { if (data?.form) Object.assign(form.scene, data.form) },
})
// Bound to TopActionBar — swaps active preset surface on tab change.
const imgPresets = computed(() =>
  form.mode === 'thumbs' ? thumbnailGeneratorPresets : sceneGeneratorPresets,
)

/**
 * Format-aware seeding of aspect_ratio BEFORE preset loaders run. The
 * page default is hardcoded '16:9' (sleep-story); the format schema
 * already exposes `imagePrompts.recommendedAspect` for image-prompts.vue,
 * so we read the same field here. Listicle / explainer channels currently
 * also recommend 16:9 (chroma-key compositing assumes landscape) but
 * vertical / Shorts-format custom formats can declare 9:16 and the page
 * will pick it up.
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
    // Format endpoint unavailable — keep the legacy '16:9' default.
  }
}

onMounted(async () => {
  await applyImageFormatDefaultsIfNoPreset()
  // v1.0.88+: load both per-kind preset lists so either tab can
  // immediately pick a saved preset without requiring a tab-switch first.
  await Promise.all([
    thumbnailGeneratorPresets.load(),
    sceneGeneratorPresets.load(),
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
  if (!form.episode_id || !slug.value) return
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
      `/projects/${slug.value}/episodes/${form.episode_id}/image-prompts${titleParam}`,
    )
    promptList.scenes = Array.isArray(data?.scenes) ? data.scenes : []
    promptList.thumbnails = Array.isArray(data?.thumbnails) ? data.thumbnails : []
  } catch (e: any) {
    if (e?.status === 404) {
      promptList.error = e?.data?.detail
        || `No prompts found yet. Generate them on the ${promptPageLabel.value} page first.`
    } else {
      promptList.error = e?.data?.detail || e?.message || 'Failed to load prompts'
    }
  } finally {
    promptList.loading = false
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
watch(() => form.episode_id, () => {
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
    })
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

// Image pipeline mode tabs (Text → Image vs Image → Image).
// text2img is the existing flow, default. img2img surfaces the
// references card + filters the model dropdown to ref-supporting
// models. Both produce the same scene + thumbnail PNGs at the
// same paths, so downstream stages (audio / video assembly) don't
// care which pipeline was used.
const imageModeTabs = computed<Array<{ id: ImageMode; label: string; icon: string; hint: string }>>(() => [
  { id: 'text2img', label: 'Text → Image', icon: '✏️',
    hint: 'Prompt-only generation (default).' },
  { id: 'img2img',  label: 'Image → Image', icon: '🔁',
    hint: form.mode === 'thumbs'
      ? 'Reference images can guide a thumbnail render.'
      : 'Reference images guide each scene — continuity + character consistency.' },
])
function selectImageMode(m: ImageMode) {
  activeForm.value.image_mode = m
}

// Friendly title fed to the references card so the backend can resolve
// the right episode folder. Falls back to '' when no episode picked
// (the card is only mounted when episode_id is set anyway).
const ep2imgTitle = computed(() => selectedEpisode.value?.title || '')

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

// ── v1.0.308 — render-size tier for LOCAL Image Studio models ─────────────
// Mirrors the Scene Review page. A local model id is `imagestudio:<repo>`;
// cloud models take an aspect string (not pixels), so the Size control is
// hidden and width/height are not sent for them. The selected scale% multiplies
// the aspect's base preset (which mirrors the provider's ASPECT_PRESETS in
// electron/server/providers/image/imagestudio.ts), rounded to /16. Rendering
// smaller cuts a local model's GPU/VAE memory, renders faster, and writes
// smaller files — the whole point the user asked for.
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
function isLocalModelId(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('imagestudio:')
}
function dimsFor(aspectRatio: string, scale: number): { width: number; height: number } {
  const base = LOCAL_ASPECT_PRESETS[aspectRatio] || LOCAL_ASPECT_PRESETS['1:1']
  const s = (scale || 100) / 100
  return { width: round16(base[0]! * s), height: round16(base[1]! * s) }
}
// {width,height} for a subform when it targets a local model; null otherwise
// (cloud → omit so the backend falls back to the aspect string).
function sizeBodyFor(sf: ImagesSubForm): { width: number; height: number } | null {
  return isLocalModelId(sf.model) ? dimsFor(sf.aspect_ratio, sf.render_scale) : null
}
// Active-tab helpers drive the Size <select> shown in the form.
const activeIsLocalModel = computed(() => isLocalModelId(activeForm.value.model))
function activeDimsLabel(scale: number): string {
  const d = dimsFor(activeForm.value.aspect_ratio, scale)
  return `${d.width}×${d.height}`
}
// Per-kind sizes passed down to each ImageGeneratorPanel so its bulk + per-row
// renders carry the same pixels the form shows.
const sceneRenderSize = computed(() => sizeBodyFor(form.scene))
const thumbnailRenderSize = computed(() => sizeBodyFor(form.thumbnail))

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

// v1.0.307 — keep the Generate button disabled for the WHOLE job, not just
// the brief enqueue POST. `submitting` flips false the instant the job is
// queued, which let the user re-click and double-queue. This reads the
// authoritative job queue (per-episode, per-kind) so the button stays greyed
// until the running render actually finishes — and survives a page reload or
// a job launched from the in-page panel. Scene vs thumbnail are independent
// pools, so we only watch the kind matching the active tab (legacy unified
// `images` jobs cover both, so they're always included).
const imageJobActiveForEpisode = computed(() =>
  isJobActiveFor(
    form.episode_id,
    form.mode === 'thumbs' ? ['thumb_images', 'images'] : ['scene_images', 'images'],
  ),
)

function selectMode(m: Mode) {
  form.mode = m
  specificNum.value = null
  // Reset aspect ratio to the default for this mode
  if (m === 'thumbs' && !['16:9', '1:1', '4:3'].includes(activeForm.value.aspect_ratio)) {
    activeForm.value.aspect_ratio = '16:9'
  }
}

// v1.0.88+: keep form.mode in sync with the route's ?tab= query so the
// sidebar's split "Thumbnail Generator" / "Scene Generator" entries
// drive the active tab, and browser back/forward navigation moves
// between them. Mapping: query 'thumbnails'/'scenes' ↔ form.mode
// 'thumbs'/'scenes'. The legacy 'all' mode is no longer reachable
// from the sidebar but a saved preset with mode='all' still loads as
// the legacy unified flow (no query → defaults to thumbs tab visually
// but the saved preset's mode wins the actual submit value).
const _router = useRouter()
watch(() => route.query.tab, (v) => {
  const next = v === 'scenes' ? 'scenes' : 'thumbs'
  if (next !== form.mode && (form.mode === 'thumbs' || form.mode === 'scenes')) {
    selectMode(next)
  }
})
watch(() => form.mode, (m) => {
  if (m !== 'thumbs' && m !== 'scenes') return
  const desired = m === 'scenes' ? 'scenes' : 'thumbnails'
  const cur = String(route.query.tab || 'thumbnails')
  if (cur === desired) return
  _router.replace({ query: { ...route.query, tab: desired } })
})

function getConfirmationType(): 'scene_images' | 'thumb_images' | 'images' {
  if (form.mode === 'scenes') return 'scene_images'
  if (form.mode === 'thumbs') return 'thumb_images'
  return 'images'
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
  outlineChapterCount.value = null
  if (!form.episode_id || !slug.value) return
  try {
    const data = await get<{ total_chapters?: number }>(
      `/projects/${slug.value}/episodes/${form.episode_id}/outline`,
    )
    if (typeof data?.total_chapters === 'number' && data.total_chapters > 0) {
      outlineChapterCount.value = data.total_chapters
    }
  } catch {
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
    // v1.0.306 — scope the repair to this page's pool (thumbnails on the
    // Thumbnail Generator, scenes on the Scene Generator).
    await post(`/projects/${slug.value}/generate/images-repair`, {
      episode_id: form.episode_id,
      pool: integrityPool.value,
    })
    success(`${activePoolLabel.value === 'thumbnails' ? 'Thumbnail' : 'Scene'} repair queued — recovers from provider history (no credit cost). Check the Jobs tab.`)
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
const activeEditImages = computed(() => form.mode === 'thumbs' ? editThumbs.value : editScenes.value)

// v1.0.87+: cache-bust key for the new ImageGeneratorPanel components.
// Bumped after a per-row or bulk render completes inside either panel
// so the parent Edit gallery + image-integrity card can pick up the
// new files on the next refresh. Mirrors the pattern used by the
// Prompts page (reviewRefreshKey for PromptReviewPanel).
const igPanelRefreshKey = ref(0)

function onPanelRefresh() {
  igPanelRefreshKey.value++
  // Re-run the Edit gallery's scan so its grid + the integrity card stay
  // in sync with whatever the panels just wrote. The integrity card has
  // its own refresh on the existing watcher; this just nudges the scan.
  void loadEditScan()
  refreshImageStatus()
}

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
    // v1.0.41: refresh pin state alongside the scan so the badge +
    // hint stay in sync with what's actually on disk after edits /
    // re-renders / external file moves.
    void loadThumbnailPinState()
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

// ── Niche-templated thumbnail composer (v1.0.104+) ───────────────────────
//
// Opens a dialog that POSTs to /thumbnails/compose with the active
// niche's thumbnailTemplate. Composes are pure local file operations
// (no API spend) so the dialog can be re-opened freely. Successful
// composes append a new file to editThumbs via loadEditScan().
const composeOpen = ref(false)
const composeInitialSource = ref('')

// The dialog reads these refs. We snapshot the current episode_id +
// editThumbs at open-time so a mid-flow scan refresh doesn't yank the
// list out from under the dialog.
const composeEpisodeCode = computed(() => form.episode_id || '')
const composeThumbs = computed(() => editThumbs.value.map(t => ({
  filename: t.filename,
  is_pinned: t.filename === pinnedThumbnailFilename.value,
})))
// images.vue doesn't load idea titles client-side, so we pass empty
// — the backend substitutes the actual episode title via the ideas
// service when the user submits with title_text blank.
const composeDefaultTitle = computed(() => '')

function openComposeDialog() {
  // Default to the pinned thumbnail when one exists — most likely the
  // user wants to recompose THAT image with the niche overlay. Falls
  // back to the highest-version file (first in the sorted grid).
  composeInitialSource.value = pinnedThumbnailFilename.value
    || editThumbs.value[0]?.filename
    || ''
  composeOpen.value = true
}

function onComposeFinished(_filename: string) {
  // Re-scan so the newly composited file appears in the grid. The
  // dialog stays open with its in-line preview so the user can pin
  // without scrolling back to the grid.
  void loadEditScan()
}

function onComposePinned(filename: string) {
  // Mirror the pin state locally without waiting for the next scan.
  pinnedThumbnailFilename.value = filename
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

// ── Thumbnail pin state (v1.0.41) ────────────────────────────────────────
// Mirrors the GET /thumbnails response keyed by current episode_id. The
// editScan loader (loadEditScan) is augmented to refresh this on every
// scan, so the pin badge stays in sync with the disk view.
const pinnedThumbnailFilename = ref<string | null>(null)
const autoThumbnailFilename = ref<string | null>(null)

async function loadThumbnailPinState() {
  const code = form.episode_id
  if (!code) {
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
    }>(`/projects/${slug.value}/episodes/${code}/thumbnails?platform=youtube`)
    pinnedThumbnailFilename.value = r.pinned
    autoThumbnailFilename.value = r.auto_pick || null
  } catch {
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

async function onLightboxPinToggle(payload: { filename: string; pin: boolean }) {
  await setThumbnailPin(payload.pin ? payload.filename : null)
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
    void loadOutlineChapterCount()
  } else {
    editScenes.value = []
    editThumbs.value = []
    outlineChapterCount.value = null
  }
}, { immediate: true })

async function submit() {
  // Translate Generation Mode (M6) → backend `force`. The image generator
  // doesn't have _v2 file naming yet, so 'new_version' currently maps to
  // 'skip' until that lands; the radio option is documented to that effect.
  const force = activeForm.value.generation_mode === 'regenerate'
  const params: any = {
    episode_id: form.episode_id,
    model: activeForm.value.model,
    mode: form.mode,
    aspect_ratio: activeForm.value.aspect_ratio,
    force,
  }
  // Forward tier only when the active model has tiers. Flat-priced models
  // ignore the field server-side, but sending it would clutter the request
  // log + the cost-confirmation receipt with a meaningless ' · ' suffix.
  if (activeForm.value.tier) params.tier = activeForm.value.tier

  // v1.0.308 — explicit render dimensions for local models. sizeBodyFor returns
  // null for cloud models, so width/height are only sent for Image Studio.
  const sz = sizeBodyFor(activeForm.value)
  if (sz) { params.width = sz.width; params.height = sz.height }

  // Image-to-image plumbing. Default text2img mode sends nothing extra —
  // the backend's resolveSceneReferenceImages then operates as it has
  // for the existing flow. img2img mode forwards the explicit pipeline
  // marker + the four-toggle reference_sources object so the generator
  // can resolve master / per-scene / characters / chain refs.
  if (activeForm.value.image_mode === 'img2img') {
    params.image_mode = 'img2img'
    params.reference_sources = { ...activeForm.value.reference_sources }
  }

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
  font-size: 11px;
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
  font-size: 10px;
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
  font-size: 11px;
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

/* Prompt-cap pill + caps reference modal. */
.cap-row {
  display: inline-flex; align-items: center; gap: 8px; margin-top: 4px;
}
.cap-pill {
  font-size: 11px;
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
.cap-link {
  font-size: 11px;
  background: none; border: none;
  color: var(--accent, #6c8fff);
  cursor: pointer; padding: 0;
  text-decoration: underline;
}
.cap-link:hover { color: var(--text-primary); }

.caps-modal {
  background: var(--bg-secondary);
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border);
  padding: 18px 22px;
  max-width: 720px;
  width: 90vw;
  max-height: 85vh;
  display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
}
.caps-modal-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 6px;
}
.caps-modal-head h3 { margin: 0; font-size: 16px; color: var(--text-primary); }
.caps-modal-close {
  background: none; border: none; font-size: 22px;
  color: var(--text-muted); cursor: pointer; padding: 0 6px; line-height: 1;
}
.caps-modal-close:hover { color: var(--text-primary); }
.caps-modal-intro { margin: 4px 0 12px; line-height: 1.5; }
.caps-table-wrap { overflow: auto; flex: 1 1 auto; }
.caps-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.caps-table th, .caps-table td {
  padding: 6px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.caps-table th {
  position: sticky; top: 0;
  background: var(--bg-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 600;
}
.caps-th-right, .caps-td-right { text-align: right !important; font-variant-numeric: tabular-nums; }
.caps-row-active {
  background: rgba(108, 143, 255, 0.08);
}
.caps-row-active td:first-child::before { content: '▸ '; color: var(--accent, #6c8fff); }
</style>
