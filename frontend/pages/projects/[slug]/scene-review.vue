<!--
  v1.0.144+ — Scene Review real content. Last gate before video assembly
  for the timestamp-driven pipeline:
    - Audio player at top (loads merged audio, currentTime drives scene
      highlighting in the grid below).
    - One row per scene: image thumbnail | transcript | visual prompt
      | actions (Regenerate / Edit prompt / Approve).
    - Bulk Approve all + Generate all missing images at the top.
    - "Greenlight indicator" panel — final video assembly is unlocked
      only when every scene is approved (v1.0.145 wires the assembler
      gate).

  Image cache busting: <img :key="imageKey(scene)"> includes the
  page-level cacheBuster ref so a regen Refresh swaps the src without
  the browser using a stale cached PNG.
-->
<template>
  <div class="review-workspace workspace-page">
    <WorkspaceHero
      eyebrow="Review · Image quality gate"
      title="Scene Review"
      description="Review every planned image against its narration, repair gaps, and approve the final visual sequence before assembly."
    >
      <template #aside>
        <div class="review-hero-route" aria-label="Review workflow">
          <span class="is-complete">1</span>
          <b>Plan</b>
          <i />
          <span class="is-current">2</span>
          <b>Images</b>
          <i />
          <span>3</span>
          <b>Motion</b>
        </div>
      </template>
    </WorkspaceHero>

    <div class="review-command-bar">
      <TopActionBar
        :project-slug="slug"
        v-model:episode-id="episodeId"
        filter-field="scene_review"
        :presets="srPresets"
        generate-label="Generate all missing"
        loading-label="Queuing…"
        :generate-loading="(bulkQueuing && !isRenderPaused) || isRendering"
        :generate-disabled="!canBulkGenerate || reviewJobActive"
        :generate-status="bulkStatus"
        @generate="generateAllMissing"
      />
    </div>

    <WorkspaceNotice
      v-if="subtitleIntegrity && !subtitleIntegrity.complete"
      tone="error"
      :title="subtitleIntegrity.blocking_cue_gaps?.length ? 'Scene rendering paused: subtitle coverage gap' : 'Scene rendering paused: subtitle timeline is incomplete'"
    >
      <template v-if="subtitleIntegrity.blocking_cue_gaps?.length">
        The stitched timeline has an interval with no subtitle cues
        <template v-if="subtitleGapSections.length">in {{ subtitleGapSections.join(', ') }}.</template>
        <template v-else>in an unmapped section.</template>
        Re-stitching alone cannot add the missing cues.
      </template>
      <template v-else>
        Subtitle timeline verification is incomplete. Review the subtitle workspace before rendering scenes.
      </template>
      <template #actions>
        <NuxtLink :to="subtitleRepairLink" class="btn btn-sm btn-secondary">Fix subtitles</NuxtLink>
      </template>
    </WorkspaceNotice>
    <WorkspaceNotice
      v-if="promptIntegrity && !promptIntegrity.complete"
      tone="error"
      title="Scene rendering paused: visual prompts are incomplete"
    >
      {{ promptIntegrity.empty_ids.length }} missing and {{ promptIntegrity.duplicate_ids.length }} duplicated.
      <template #actions>
        <NuxtLink :to="`/projects/${slug}/scene-plan`" class="btn btn-sm btn-secondary">Fix Scene Plan</NuxtLink>
      </template>
    </WorkspaceNotice>
    <WorkspaceNotice
      v-if="stats?.legacy_unmapped_images"
      tone="warning"
      title="Older images are not mapped to this timeline"
    >
      {{ stats.legacy_unmapped_images }} older numbered image{{ stats.legacy_unmapped_images === 1 ? '' : 's' }} cannot be safely assigned to these stable scene IDs and are intentionally not counted.
    </WorkspaceNotice>

    <!-- Greenlight panel -->
    <section v-if="stats" class="card mt-3 sr-control-deck" :class="{ 'is-greenlit': stats.all_approved }">
      <div class="sr-greenlight-head">
        <div class="sr-status-copy">
          <span class="sr-status-kicker">Episode readiness</span>
          <h3 v-if="stats.all_approved">Greenlit for Video Assembly</h3>
          <h3 v-else>{{ stats.approved }} of {{ stats.total_scenes }} scenes approved</h3>
          <p>{{ stats.with_image }} images ready · {{ stats.total_scenes - stats.with_image }} missing · {{ staleCount }} stale</p>
        </div>
        <div class="sr-status-orb" :class="{ ready: stats.all_approved }">
          <strong>{{ stats.total_scenes ? Math.round((stats.approved / stats.total_scenes) * 100) : 0 }}%</strong>
          <span>approved</span>
        </div>
      </div>

      <div class="sr-progress-track" aria-hidden="true">
        <span :style="{ width: `${stats.total_scenes ? (stats.approved / stats.total_scenes) * 100 : 0}%` }" />
      </div>

      <div v-if="stats.all_approved && episodeId" class="sr-greenlight-actions" aria-label="Continue this approved episode">
        <NuxtLink :to="motionReviewLink" class="btn btn-sm btn-secondary">
          Motion Review (optional) →
        </NuxtLink>
        <NuxtLink :to="videoAssemblyLink" class="btn btn-sm btn-primary">
          Open Video Assembly →
        </NuxtLink>
      </div>

      <div class="sr-control-section">
        <div class="sr-section-heading">
          <div><span>01</span><strong>Render settings</strong></div>
          <small>Controls used for missing images and re-renders</small>
        </div>
        <div class="sr-model-grid is-single">
          <div class="sr-model-field">
            <div class="sr-field-heading">
              <label class="sr-ratio-label">Image model</label>
              <small>Creates missing images and re-renders</small>
            </div>
            <ImageModelPicker
              v-model="form.model"
              :project-slug="slug"
              :image-models="config?.image_models || {}"
              image-mode="text2img"
              default-label="Pick an image model…"
            />
          </div>
        </div>

        <div class="sr-settings-grid">
          <!-- v1.0.240 — aspect-ratio control. Scenes default to 16:9 (the video
               frame), but the box is now selectable + the thumbnails below
               re-shape live so you can see the ratio you're rendering at. -->
          <div class="sr-ratio-pick" title="Aspect ratio every scene image is rendered at. 16:9 is the YouTube video frame; the thumbnails below re-shape to match.">
            <label class="sr-ratio-label" for="sr-aspect">Aspect</label>
            <select id="sr-aspect" v-model="form.aspect_ratio" class="select sr-ratio-select">
              <option v-for="ar in aspectRatios" :key="ar.value" :value="ar.value">
                {{ ar.value }} — {{ ar.label }}
              </option>
            </select>
          </div>
          <!-- Only shown when the model publishes NO output options: there is
               then genuinely no resolution to choose and GenStudio decides. -->
          <div v-if="form.model && !hasPublishedOutputOptions" class="sr-ratio-pick" title="GenStudio decides the output resolution for this render.">
            <span class="sr-ratio-label">Resolution</span>
            <div class="sr-static-control">
              <strong>{{ selectedGenStudioModel ? 'Managed by GenStudio' : 'Managed by provider' }}</strong>
              <small>
                Uses {{ form.aspect_ratio }}<template v-if="selectedGenStudioModel?.default_resolution"> · {{ selectedGenStudioModel.default_resolution }}</template>
              </small>
            </div>
          </div>
          <!-- Inference steps are not a customer control: GenStudio publishes
               no step contract and its request schema has no `steps` field, so
               no control is offered rather than one driving a phantom value. -->
          <div v-if="selectedGenStudioModel && selectedGenStudioModel.supports_seed !== false" class="sr-ratio-pick" title="Optional reproducible seed. Leave blank for a fresh random composition per scene.">
            <label class="sr-ratio-label" for="sr-gen-seed">Seed</label>
            <input id="sr-gen-seed" v-model="form.seed" class="input sr-number-input" type="number" min="0" max="2147483647" placeholder="Random">
          </div>
        </div>
        <!-- Published `(resolution, aspect_ratio)` rows with their real pixel
             size and their own price. Renders nothing when none are published. -->
        <ImageOutputOptionPicker
          v-if="selectedGenStudioModel"
          v-model="outputOption"
          :model="selectedGenStudioModel"
          @switched="onOutputOptionSwitched"
        />
        <p v-if="selectedGenStudioModel" class="sr-cost" :class="`basis-${sceneImageCost.basis}`" :title="sceneImageCost.title">
          {{ CREDIT_BASIS_LABEL[sceneImageCost.basis] }}: {{ sceneImageCost.text }}
        </p>
        <label
          class="sr-auto-approve"
          title="Approve each generated image only after Story Studio verifies and registers the saved file. Manual uploads still require review."
        >
          <input v-model="autoApproveGenerated" type="checkbox">
          <span>
            <strong>Auto-approve generated images</strong>
            <small>Default off · saved with this Scene Review preset</small>
          </span>
        </label>
      </div>

      <div class="sr-control-section sr-action-section">
        <div class="sr-section-heading">
          <div><span>02</span><strong>Review actions</strong></div>
          <small>Approve, select, or re-render without changing scene timing</small>
        </div>
        <div class="sr-actions-grid">
          <button
            class="btn btn-sm btn-secondary"
            :disabled="approvingAll || stats.with_image === 0"
            @click="approveAll(true)"
            title="Approves every scene that has an image. Useful after spot-checking the first few."
          >
            ✓ Approve all
          </button>
          <button
            class="btn btn-sm btn-ghost"
            :disabled="approvingAll || stats.approved === 0"
            @click="approveAll(false)"
            title="Unapprove every scene — back to needs-review for everything."
          >
            ↺ Reset
          </button>
          <!-- Re-roll a chosen set as one durable GenStudio batch. -->
          <button
            v-if="isContinuity && selectedCount > 0"
            class="btn btn-sm btn-primary"
            :disabled="!form.model || continuityRendering || reviewJobActive"
            @click="regenerateSelected"
            title="Re-render the selected scenes in one durable GenStudio batch."
          >
            Regenerate selected ({{ selectedCount }})
          </button>
          <button
            v-if="isContinuity && selectedCount > 0"
            class="btn btn-sm btn-ghost"
            @click="clearSelection"
            title="Clear the scene selection."
          >
            Clear
          </button>
          <button
            v-if="isContinuity && selectedCount === 0 && stats.approved < stats.total_scenes"
            class="btn btn-sm btn-ghost"
            @click="selectAllUnapproved"
            title="Tick every not-yet-approved scene so you can trim the selection, then Regenerate selected."
          >
            ☑ Select unapproved
          </button>
          <!-- Stale images were rendered from an older prompt. -->
          <button
            v-if="isContinuity && selectedCount === 0 && staleCount > 0"
            class="btn btn-sm btn-warn"
            @click="selectAllStale"
            title="Tick every scene whose image is older than its current prompt, then Regenerate selected."
          >
            ⚠ Select stale ({{ staleCount }})
          </button>
          <button
            v-if="isContinuity && stats.with_image > 0 && stats.approved < stats.total_scenes"
            class="btn btn-sm btn-ghost"
            :disabled="!form.model || continuityRendering || reviewJobActive"
            @click="regenerateUnapproved"
            title="Re-render every not-yet-approved scene in one durable GenStudio batch."
          >
            Regenerate all unapproved
          </button>
        </div>
      </div>
    </section>

    <!-- Render presets are owned by the page-level TopActionBar. -->

    <section v-if="!stats && !plan && !loading" class="card mt-3">
      <p class="text-muted text-sm">
        <strong>No scene plan yet.</strong>
        Open the <NuxtLink :to="`/projects/${slug}/scene-plan`" class="text-accent">Scene Plan</NuxtLink>
        page to stitch subtitles + run the planner first.
      </p>
    </section>

    <!-- Audio player + scene grid -->
    <section v-if="scenes.length" class="card mt-3">
      <audio
        v-if="audioUrl"
        ref="audioEl"
        :src="audioUrl"
        controls
        class="review-audio"
        @timeupdate="onAudioTimeUpdate"
      />
      <p v-else class="text-muted text-sm">
        Merged audio not found — generate Audio Assembly first to enable synced playback.
      </p>

      <!-- v1.0.231 — live render banner. Shows while a render job for this
           episode is active, with overall progress + the current scene. -->
      <div v-if="activeRenderJob" class="review-render-banner mt-2">
        <span v-if="!isRenderPaused" class="review-spinner" aria-hidden="true" />
        <span v-if="isRenderPaused">
          Paused — awaiting explicit Resume.
          <span class="text-muted">{{ hasSettlingProviderWork ? ' Accepted provider work is still settling; no new submissions will start.' : ' No new submissions will start until you resume.' }}</span>
        </span>
        <span v-else>
          Rendering with GenStudio
          <template v-if="batchInFlight.size"> — {{ batchInFlight.size }} scene{{ batchInFlight.size === 1 ? '' : 's' }} in flight</template>
          <template v-if="renderProgress != null"> · {{ renderProgress }}% done</template>
          <span class="text-muted"> — GenStudio schedules the batch and images appear here as each one finishes.</span>
        </span>
        <span v-if="!isRenderPaused && renderProgress != null" class="review-render-bar" aria-hidden="true">
          <span class="review-render-fill" :style="{ width: renderProgress + '%' }" />
        </span>
        <button
          v-if="isRenderPaused && activeContinuityRenderJob"
          type="button"
          class="review-stop-btn"
          :disabled="cancelingRender"
          @click="resumeActiveRender"
          title="Resume explicitly. Story Studio audits saved files and submits only missing scenes."
        >{{ cancelingRender ? 'Resuming…' : 'Resume' }}</button>
        <button
          v-for="control in sceneRenderControls(activeContinuityRenderJob)"
          :key="control.action"
          type="button"
          class="review-stop-btn"
          :disabled="cancelingRender || !control.enabled"
          :title="control.reason"
          @click="runSceneRenderControl(activeContinuityRenderJob, control)"
        >{{ cancelingRender ? 'Working…' : control.label }}</button>
      </div>

      <!-- Plan-health banner. Missing and duplicated prompts are blocking work;
           timing warnings remain visible without reviving the retired planner. -->
      <div v-if="problemScenes.length" class="sr-health mt-2">
        <div class="sr-health-head">
          ⚠ {{ problemScenes.length }} scene{{ problemScenes.length === 1 ? '' : 's' }} need attention
          <NuxtLink :to="`/projects/${slug}/scene-plan`" class="sr-health-link">Fix on Scene Plan →</NuxtLink>
        </div>
        <div class="sr-health-list">
          <button
            v-for="p in problemScenes"
            :key="p.scene.id"
            class="sr-health-chip"
            :title="`Jump to scene #${p.index} — ${p.reasons.join(', ')}`"
            @click="jumpToScene(p.scene.id)"
          >
            #{{ p.index }} <span class="sr-health-why">{{ p.reasons.join(' · ') }}</span>
          </button>
        </div>
      </div>

      <ul class="review-scene-list mt-2">
        <li
          v-for="scene in renderedScenes"
          :id="`sr-scene-${scene.id}`"
          :key="scene.id"
          tabindex="-1"
          :class="['review-scene-row', {
            'is-approved': scene.approved,
            'is-current': scene.id === currentSceneId,
            'is-missing': !scene.image_filename,
            'sr-row-problem': problemIds.has(scene.id),
          }]"
        >
          <div
            class="review-thumb-cell"
            :class="{ 'is-previewable': !!scene.image_filename }"
            :role="scene.image_filename ? 'button' : undefined"
            :tabindex="scene.image_filename ? 0 : undefined"
            :aria-label="scene.image_filename ? `Preview scene ${scene.scene_index} image full size` : undefined"
            @click="scene.image_filename && openPreview(scene)"
            @keydown.enter.prevent="scene.image_filename && openPreview(scene)"
            @keydown.space.prevent="scene.image_filename && openPreview(scene)"
          >
            <template v-if="scene.image_filename">
              <img
                :src="imageUrl(scene)"
                :key="imageKey(scene)"
                :alt="`Scene ${scene.scene_index}`"
                class="review-thumb"
                :style="{ aspectRatio: thumbAspect }"
                loading="lazy"
                title="Click to preview full size"
              />
              <!-- Per-scene generation overlay. -->
              <div v-if="isSceneGenerating(scene)" class="review-thumb-overlay">
                <span class="review-spinner" aria-hidden="true" />
                <small>Rendering…</small>
              </div>
              <!-- v1.0.359 — stale corner flag (image older than current prompt). -->
              <span v-if="scene.stale && !isSceneGenerating(scene)" class="review-thumb-stale" title="Stale — rendered from an older prompt">⚠</span>
              <!-- v1.0.470 — animated-clip badge. Click to preview the clip. -->
              <span
                v-if="scene.clip_exists"
                class="review-thumb-clip"
                :title="scene.clip_stale ? 'Animated clip exists but the motion prompt changed since — re-animate to refresh' : 'Animated clip ready — click to preview'"
                @click.stop="openClipPreview(scene)"
              >{{ scene.clip_stale ? '🎬⚠' : '🎬' }}</span>
            </template>
            <!-- Empty scene currently generating in the batch. -->
            <div v-else-if="isSceneGenerating(scene)" class="review-thumb-generating" :style="{ aspectRatio: thumbAspect }">
              <span class="review-spinner" aria-hidden="true" />
              <small>Generating…</small>
            </div>
            <div
              v-else
              :class="['review-thumb-empty', { 'is-disabled': reviewJobActive }]"
              :style="{ aspectRatio: thumbAspect }"
              :aria-disabled="reviewJobActive"
              :title="reviewJobActive ? 'Resume or finish the current scene render before generating another image.' : 'Generate image'"
              @click="!reviewJobActive && generateOne(scene)"
            >
              <span>No image yet</span>
              <small>(click to generate)</small>
            </div>
          </div>

          <div class="review-body-cell">
            <div class="review-row-head">
              <input
              v-if="isContinuity"
              type="checkbox"
              class="review-select"
              :checked="selectedIds.has(scene.id)"
              @change="toggleSelected(scene.id)"
              title="Select for batch regeneration"
              />
              <strong>#{{ scene.scene_index }}</strong>
              <button class="review-time-btn" @click="seekTo(scene.start_sec)" title="Jump audio to this scene">
                {{ scene.start_sec.toFixed(1) }}s → {{ scene.end_sec.toFixed(1) }}s
              </button>
              <span class="text-muted text-xs">
                ({{ (scene.end_sec - scene.start_sec).toFixed(1) }}s)
              </span>
              <span v-if="scene.boundary_reason" class="text-muted text-xs">
                · {{ scene.boundary_reason }}
              </span>
              <!-- v1.0.359 — stale: image older than the current prompt. -->
              <span
                v-if="scene.stale"
                class="review-stale-badge"
                title="This image was rendered from an older prompt — the prompt has changed since. Re-render to refresh it."
              >⚠ stale — re-render</span>
            </div>
            <p class="review-transcript">{{ scene.transcript_segment }}</p>
            <details class="review-prompt-details">
              <summary class="text-muted text-xs">Visual prompt</summary>
              <p class="review-prompt">{{ scene.visual_prompt }}</p>
            </details>
          </div>

          <div class="review-actions-cell">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!form.model || regeneratingId === scene.id || reviewJobActive"
              @click="generateOne(scene)"
              :title="!form.model ? 'Pick a model in the Render settings first' : 'Generate or regenerate this scene image with GenStudio'"
            >
              {{ regeneratingId === scene.id ? '⏳' : (scene.image_filename ? '↻' : '✦') }}
              {{ scene.image_filename ? 'Regenerate image' : 'Generate image' }}
            </button>
            <button
              :class="['btn btn-sm', scene.approved ? 'btn-primary' : 'btn-secondary']"
              :disabled="!scene.image_filename || approvingId === scene.id"
              @click="approveOne(scene, !scene.approved)"
              :title="scene.image_filename ? 'Toggle approval' : 'Generate an image first'"
            >
              {{ approvingId === scene.id ? '⏳' : (scene.approved ? '✓ Approved' : 'Approve') }}
            </button>
            <OverflowMenu
              :items="sceneOverflowItems(scene)"
              :aria-label="`More actions for scene ${scene.scene_index}`"
            />
          </div>
        </li>
      </ul>
      <div
        v-if="renderedScenes.length < scenes.length"
        ref="sceneLoadSentinel"
        class="review-list-more"
      >
        <span>{{ renderedScenes.length }} of {{ scenes.length }} scenes loaded</span>
        <button class="btn btn-sm btn-ghost" @click="loadMoreScenes">Load next {{ SCENE_RENDER_BATCH }}</button>
      </div>
    </section>


    <!-- v1.0.241 — click-to-preview lightbox. Full-size view of a generated
         scene image, with prev/next nav across scenes that have images. -->
    <Teleport to="body">
      <div
        v-if="previewScene"
        class="sr-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="`Scene ${previewScene.scene_index} image preview`"
        @click.self="closePreview"
      >
      <button class="sr-lb-close" @click="closePreview" title="Close (Esc)">✕</button>
      <button
        v-if="previewNeighbours.prev"
        class="sr-lb-nav sr-lb-prev"
        @click.stop="stepPreview(-1)"
        title="Previous scene with an image (←)"
      >‹</button>
      <figure class="sr-lb-figure" @click.stop>
        <img
          :src="imageUrl(previewScene)"
          :key="imageKey(previewScene)"
          :alt="`Scene ${previewScene.scene_index}`"
          class="sr-lb-img"
        />
        <figcaption class="sr-lb-cap">
          <div class="sr-lb-meta">
            <strong>Scene #{{ previewScene.scene_index }}</strong>
            <span class="text-muted">{{ previewScene.start_sec.toFixed(1) }}s → {{ previewScene.end_sec.toFixed(1) }}s</span>
            <span v-if="previewScene.approved" class="sr-lb-approved">✓ Approved</span>
            <span v-if="promptDirty" class="sr-lb-dirty" title="You've edited the prompt but haven't saved/regenerated yet.">● unsaved prompt edit</span>
            <span v-if="previewScene.stale" class="sr-lb-stale" title="This image was rendered from an older prompt — re-render to refresh it.">⚠ stale — re-render</span>
          </div>
          <!-- v1.0.342 — the prompt that produced this image, editable inline so
               a bad LLM prompt can be fixed + re-rendered without leaving review. -->
          <div class="sr-lb-prompt">
            <label class="sr-lb-prompt-label">Image prompt <span class="text-muted">— edit to fix, then Regenerate</span></label>
            <textarea
              v-model="editPrompt"
              class="sr-lb-prompt-input"
              rows="3"
              spellcheck="false"
              placeholder="(no prompt on this scene)"
              @keydown.stop
            />
          </div>
          <span class="sr-lb-actions">
            <button class="btn btn-sm btn-ghost" @click.stop="seekTo(previewScene.start_sec)" title="Jump the audio player to this scene">▶ Play from here</button>
            <button
              v-if="promptDirty"
              class="btn btn-sm btn-secondary"
              :disabled="savingPrompt || !editPrompt.trim()"
              @click.stop="savePromptOnly(previewScene)"
              title="Save the edited prompt (the image stays until you Regenerate)"
            >{{ savingPrompt ? '⏳' : '💾 Save prompt' }}</button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!form.model || regeneratingId === previewScene.id || reviewJobActive"
              @click.stop="regenerateFromPreview(previewScene)"
              :title="!form.model ? 'Pick a model in the Greenlight panel first' : 'Re-render this image (saves your prompt edit first)'"
            >{{ regeneratingId === previewScene.id ? '⏳ Rendering…' : '🔄 Regenerate' }}</button>
            <!-- Tick this scene for the selected-scene batch without leaving the preview. -->
            <button
              v-if="isContinuity"
              :class="['btn btn-sm', previewSelected ? 'btn-primary' : 'btn-ghost']"
              @click.stop="toggleSelected(previewScene.id)"
              title="Mark this scene for batch regeneration. Keyboard: Shift+Y"
            >{{ previewSelected ? '☑ Selected' : '☐ Select for re-render' }}<span class="sr-lb-kbd">⇧Y</span></button>
            <button
              :class="['btn btn-sm', previewScene.approved ? 'btn-primary' : 'btn-secondary']"
              @click.stop="approveOne(previewScene, !previewScene.approved)"
            >{{ previewScene.approved ? '✓ Approved' : 'Approve' }}</button>
          </span>
        </figcaption>
      </figure>
      <button
        v-if="previewNeighbours.next"
        class="sr-lb-nav sr-lb-next"
        @click.stop="stepPreview(1)"
        title="Next scene with an image (→)"
      >›</button>
      </div>
    </Teleport>

    <!-- v1.0.358 — back-to-top floating button (mirrors Scene Plan). The scene
         grid gets very tall on long episodes (50+ scenes); this saves the
         scroll-grind back up. The promised button in v1.0.286 only ever landed
         on the Scene Plan page — this adds it to Scene Review too. -->
    <Transition name="review-float">
      <button
        v-if="showBackToTop"
        class="back-to-top"
        title="Back to top"
        aria-label="Scroll to top of page"
        @click="scrollToTop"
      >
        <span aria-hidden="true">↑</span>
        Back to top
      </button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { resolveActiveSceneRenderJob } from '~/utils/scene-render-job-state'
import { findOutputOption, publishedOutputOptions, type OutputOptionChoice } from '../../../utils/genstudio-output-options.js'
import { CREDIT_BASIS_LABEL, describeImageUnitCost } from '../../../utils/genstudio-credit-cost.js'
import { findGenStudioProduct } from '../../../../electron/server/contracts/genstudio-product-identity'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Scene Review')

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)
// v1.0.229 — image-model catalog for the picker. Scene Review renders IMAGES
// (continuity chain / per-scene regen), so it needs the image-model picker,
// not the LLM ModelSelector that used to be here.
const { config } = useProject()
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()
const { updateEpisode: updateCachedEpisode, revalidateAfterMutation } = useEpisodes(slug)

// v1.0.475 — per-project duration floor for bulk animation (config-backed). The
// backend (generate-missing-clips) reads config.animate_min_seconds; the GET
// scene-review response echoes it so this control reflects the saved value.
const animateMinSeconds = ref<number>(Math.max(0, Number((config.value as any)?.animate_min_seconds) || 0))
watch(config, (c) => { animateMinSeconds.value = Math.max(0, Number((c as any)?.animate_min_seconds) || 0) })
async function setAnimateMinSeconds(v: number) {
  const n = Math.max(0, Math.min(60, Math.round(v) || 0))
  const prev = animateMinSeconds.value
  animateMinSeconds.value = n
  try {
    await put(`/projects/${slug.value}/settings/config`, { animate_min_seconds: n })
    if (config.value) (config.value as any).animate_min_seconds = n
    success(n > 0 ? `Bulk animate now skips scenes shorter than ${n}s.` : 'Bulk animate has no minimum length.')
  } catch (e: any) {
    animateMinSeconds.value = prev
    showError(e?.data?.detail || e?.message || 'Could not save the setting')
  }
}

const initialEpisodeId = typeof route.query.episode_id === 'string'
  ? route.query.episode_id
  : typeof route.query.episode === 'string'
    ? route.query.episode
    : ''
const episodeId = ref(initialEpisodeId)
const pendingSceneDeepLink = ref(typeof route.query.scene_id === 'string' ? route.query.scene_id : '')
const motionReviewLink = computed(() => `/projects/${slug.value}/motion-review?episode_id=${encodeURIComponent(episodeId.value)}`)
const videoAssemblyLink = computed(() => `/projects/${slug.value}/video-assembly?episode_id=${encodeURIComponent(episodeId.value)}`)

interface ReviewScene {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  transcript_segment: string
  visual_prompt: string
  motion_prompt?: string
  approved: boolean
  image_filename: string | null
  boundary_reason?: string
  /** v1.0.359 — image exists but was rendered from a different prompt than the
   *  current visual_prompt (re-prompted in Scene Plan / edited here without
   *  re-rendering). */
  stale?: boolean
  /** v1.0.470 — an animated clip (mp4) exists for this scene. */
  clip_exists?: boolean
  /** v1.0.470 — clip exists but its motion prompt changed since it was rendered. */
  clip_stale?: boolean
}
interface ReviewStats {
  total_scenes: number
  approved: number
  with_image: number
  all_approved: boolean
  legacy_unmapped_images?: number
}
interface PromptIntegrity {
  complete: boolean
  empty_ids: string[]
  duplicate_ids: string[]
}
interface SubtitleIntegrity {
  complete: boolean
  missing_sections: string[]
  max_cue_gap_sec?: number
  blocking_cue_gaps?: Array<{
    previous_end_sec: number
    next_start_sec: number
    gap_sec: number
    section_slugs: string[]
    section_local_start_sec?: number
    section_local_end_sec?: number
  }>
}
interface PlanMeta {
  schema_version: 1
  generated_at: string
  planner_model?: string
  total_duration_sec: number
  research_used: boolean
}
interface RenderStatus {
  active: boolean
  provider?: string
  model?: string
  total?: number
  mode?: 'batch'
  to_render?: number
  rendered_so_far?: number
  in_flight?: number[]
}

const plan = ref<PlanMeta | null>(null)
const scenes = ref<ReviewScene[]>([])
const SCENE_RENDER_BATCH = 40
const renderedSceneLimit = ref(SCENE_RENDER_BATCH)
const renderedScenes = computed(() => scenes.value.slice(0, renderedSceneLimit.value))
const sceneLoadSentinel = ref<HTMLElement | null>(null)
let sceneLoadObserver: IntersectionObserver | null = null
let reviewLoadSequence = 0
function loadMoreScenes(): void {
  renderedSceneLimit.value = Math.min(scenes.value.length, renderedSceneLimit.value + SCENE_RENDER_BATCH)
}
const audioPath = ref<string | null>(null)
const stats = ref<ReviewStats | null>(null)
const promptIntegrity = ref<PromptIntegrity | null>(null)
const subtitleIntegrity = ref<SubtitleIntegrity | null>(null)
const subtitleGapSections = computed(() => Array.from(new Set(
  subtitleIntegrity.value?.blocking_cue_gaps?.flatMap(gap => gap.section_slugs) || [],
)))
const subtitleRepairLink = computed(() => {
  const section = subtitleIntegrity.value?.missing_sections[0]
    || subtitleIntegrity.value?.blocking_cue_gaps?.flatMap(gap => gap.section_slugs)[0]
  const query = new URLSearchParams({ episode_id: episodeId.value })
  if (section) query.set('section', section)
  return `/projects/${slug.value}/subtitles?${query.toString()}`
})
const loading = ref(false)
const renderStatus = ref<RenderStatus | null>(null)
const activeRenderJobFromReview = ref<any | null>(null)
const cancelingRender = ref(false)

const form = ref({
  model: '',
  aspect_ratio: '16:9',
  seed: '' as string | number,
})
// GenStudio-only state intentionally uses a new key. Retired reference,
// provider, and manual-concurrency settings are not read or migrated.
useRememberedForm('scene-review-genstudio', slug, form)
// Safety-sensitive and intentionally separate from remembered form state:
// this turns on only when the user applies a preset that explicitly saved it.
const autoApproveGenerated = ref(false)

// Scene Review presets contain only current GenStudio render controls.
// Presets saved by older builds can still carry retired quality, step-count,
// and pixel-size keys. They are simply not read — a saved project keeps
// loading, and nothing revives a control GenStudio never published.
const srPresets = usePresets<{
  model: string
  aspect_ratio: string
  seed?: string | number
  auto_approve_generated?: boolean
}>({
  slug: slug.value,
  configKey: 'scene_review_genstudio',
  presetType: 'scene-review',
  snapshot: () => ({
    model: form.value.model,
    aspect_ratio: form.value.aspect_ratio,
    seed: form.value.seed,
    auto_approve_generated: autoApproveGenerated.value,
  }),
  apply: (data) => {
    if (typeof data.model === 'string') form.value.model = data.model
    if (typeof data.aspect_ratio === 'string') form.value.aspect_ratio = data.aspect_ratio
    if (typeof data.seed === 'string' || typeof data.seed === 'number') form.value.seed = data.seed
    autoApproveGenerated.value = data.auto_approve_generated === true
  },
})

// Aspect-ratio choices for scene renders. 16:9 is the default video frame;
// the rest are offered for non-standard cuts. The picked value is sent to
// every generate/continuity endpoint and drives the live thumbnail shape.
const defaultAspectRatios = [
  { value: '16:9', label: 'Landscape (YouTube)' },
  { value: '21:9', label: 'Ultrawide' },
  { value: '4:3',  label: 'Standard' },
  { value: '1:1',  label: 'Square' },
  { value: '9:16', label: 'Portrait' },
]
const { models: genStudioImageModels, refresh: refreshGenStudioImageModels } = useGenStudioImageModels()
// Alias-aware on purpose: this preset is remembered per-project in
// localStorage and may hold an identifier from before GenStudio republished
// the product under its customer handle. Resolving by id alone here is what
// leaves the picker blank and the render guards unarmed.
const selectedGenStudioModel = computed(() => findGenStudioProduct(genStudioImageModels.value, form.value.model))
const aspectRatios = computed(() => {
  const ratios = selectedGenStudioModel.value?.aspect_ratios
  if (!ratios?.length) return defaultAspectRatios
  const labels = Object.fromEntries(defaultAspectRatios.map(item => [item.value, item.label]))
  return ratios.map(value => ({ value, label: labels[value] || 'Supported by GenStudio' }))
})
/**
 * The published output row this page renders at, kept as the PAIR because the
 * pair is the row GenStudio published. `null` = the model publishes no
 * `output_options[]`, so no resolution is sent and GenStudio applies its own.
 */
const outputOption = ref<OutputOptionChoice | null>(null)
const hasPublishedOutputOptions = computed(() => publishedOutputOptions(selectedGenStudioModel.value).length > 0)
/** A model switch that moved the pick is announced, never applied silently. */
function onOutputOptionSwitched(notice: string): void { showError(notice) }
// The row owns the ratio, so the request submits exactly the combination shown.
watch(outputOption, (choice) => {
  if (choice?.aspect_ratio) form.value.aspect_ratio = choice.aspect_ratio
})
const sceneImageCost = computed(() => describeImageUnitCost(
  selectedGenStudioModel.value,
  findOutputOption(selectedGenStudioModel.value, outputOption.value),
))
// Resolution and seed are the render request Story Studio owns beyond the
// ratio. Resolution travels only as a published row, and a seed only when the
// model publishes support for one.
const genStudioImageBody = computed(() => selectedGenStudioModel.value ? {
  ...(outputOption.value?.resolution ? { resolution: outputOption.value.resolution } : {}),
  ...(form.value.seed === '' || selectedGenStudioModel.value.supports_seed === false
    ? {}
    : { seed: Math.max(0, Math.min(2147483647, Number(form.value.seed))) }),
} : {})
watch([selectedGenStudioModel, () => form.value.aspect_ratio], ([model]) => {
  if (!model) return
  if (!model.aspect_ratios.includes(form.value.aspect_ratio)) form.value.aspect_ratio = model.default_aspect_ratio
})
// CSS aspect-ratio string ("16:9" → "16 / 9") so the thumbnail boxes re-shape
// to whatever ratio is selected — making the enforced frame visible.
const thumbAspect = computed(() => form.value.aspect_ratio.replace(':', ' / '))

const audioEl = ref<HTMLAudioElement | null>(null)
const currentTime = ref(0)
const cacheBuster = ref(Date.now())

// ── v1.0.470 — image-to-video (Animate) state ───────────────────────────────
const videoModel = ref('')
const animatingId = ref<string | null>(null)
const animatingAll = ref(false)
const clipPreviewScene = ref<ReviewScene | null>(null)
// Project video models that support image-to-video (modes includes 'frames').
const i2vModels = computed(() => {
  const vm = (config.value as any)?.video_models || {}
  return Object.entries(vm)
    .filter(([, m]: [string, any]) => Array.isArray(m?.modes) && m.modes.includes('frames'))
    .map(([id, m]: [string, any]) => ({ id, label: m.label || id }))
})
// Auto-pick the first i2v model so the Animate buttons light up without a manual step.
watch(i2vModels, (list) => {
  if (!videoModel.value && list.length) videoModel.value = list[0]!.id
}, { immediate: true })
function clipUrl(scene: ReviewScene): string {
  return `/api/projects/${slug.value}/scene-review/${episodeId.value}/clip/${scene.id}?t=${cacheBuster.value}`
}
function openClipPreview(scene: ReviewScene): void { clipPreviewScene.value = scene }

async function animateScene(scene: ReviewScene): Promise<void> {
  if (!videoModel.value) { showError('Pick an image-to-video model in the Greenlight panel first'); return }
  if (!scene.image_filename) { showError('Generate the image first — there\'s nothing to animate'); return }
  if (!scene.motion_prompt) { showError('This scene has no motion prompt. Add one on the Scene Plan page.'); return }
  animatingId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-clip`, {
      scene_id: scene.id,
      model: videoModel.value,
      aspect_ratio: form.value.aspect_ratio,
    })
    success(`Animation queued for scene ${scene.scene_index} — the clip badge appears when it lands.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue animation')
  } finally {
    animatingId.value = null
  }
}

async function animateMissing(): Promise<void> {
  if (!videoModel.value) { showError('Pick an image-to-video model first'); return }
  animatingAll.value = true
  try {
    const r = await post<{ queued: number; skipped: number }>(
      `/projects/${slug.value}/scene-review/${episodeId.value}/generate-missing-clips`,
      { model: videoModel.value, aspect_ratio: form.value.aspect_ratio },
    )
    success(`Animation: queued ${r?.queued ?? 0}, skipped ${r?.skipped ?? 0}. Watch the Jobs panel.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue animations')
  } finally {
    animatingAll.value = false
  }
}
const regeneratingId = ref<string | null>(null)
const approvingId = ref<string | null>(null)
const approvingAll = ref(false)
// v1.0.272 — per-episode in-flight flags: a bulk-gen / render holds its flag
// through a long poll, so key it to the episode it started for — switching
// episodes mid-job then frees the new episode's buttons instead of leaving them
// disabled. (See auto-memory: per-episode-inflight-gating.md.)
const bulkQueuingEpisode = ref<string | null>(null)
const bulkQueuing = computed(() => bulkQueuingEpisode.value === episodeId.value)

// ── Computeds ───────────────────────────────────────────────────────
const audioUrl = computed(() => {
  if (!audioPath.value || !episodeId.value) return ''
  return `/api/projects/${slug.value}/scene-review/${episodeId.value}/audio?t=${cacheBuster.value}`
})
const currentSceneId = computed(() => {
  const t = currentTime.value
  return scenes.value.find(s => t >= s.start_sec && t < s.end_sec)?.id ?? null
})

// Plan health mirrors the backend's prompt-integrity result. Later copies of an
// exact prompt are pending work and may not be rendered as another scene.
// v1.4.82 — this was a hardcoded `OVERLONG_SEC = 20`, so Scene Review flagged
// scenes the episode's OWN pacing band considers perfectly fine, and stayed
// silent about ones it considers too long. Read the configured maximum the way
// Scene Plan does (see scene-plan.vue's `pacingMaximumSec`).
const continuityPacing = ref<{ min_sec: number; max_sec: number } | null>(null)
const pacingMaximumSec = computed(() => continuityPacing.value?.max_sec || 20)
const duplicatePromptIds = computed(() => new Set(promptIntegrity.value?.duplicate_ids || []))
const problemScenes = computed(() => {
  const list: Array<{ scene: ReviewScene; index: number; reasons: string[] }> = []
  scenes.value.forEach((s, i) => {
    const reasons: string[] = []
    const dur = s.end_sec - s.start_sec
    if (!s.visual_prompt || !s.visual_prompt.trim()) reasons.push('no prompt')
    else if (duplicatePromptIds.value.has(s.id)) reasons.push('duplicate prompt')
    if (dur > pacingMaximumSec.value) reasons.push(`${dur.toFixed(0)}s long`)
    if (reasons.length) list.push({ scene: s, index: s.scene_index ?? i + 1, reasons })
  })
  return list
})
const problemIds = computed(() => new Set(problemScenes.value.map(p => p.scene.id)))
const sceneInputsComplete = computed(() =>
  promptIntegrity.value?.complete === true && subtitleIntegrity.value?.complete === true,
)
async function jumpToScene(id: string, { focus = false }: { focus?: boolean } = {}): Promise<void> {
  if (typeof document === 'undefined') return
  const index = scenes.value.findIndex(scene => scene.id === id)
  if (index >= renderedSceneLimit.value) {
    renderedSceneLimit.value = index + 1
    await nextTick()
  }
  const el = document.getElementById(`sr-scene-${id}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (focus) el.focus({ preventScroll: true })
    el.classList.add('sr-row-flash')
    setTimeout(() => el.classList.remove('sr-row-flash'), 1500)
  }
}
const canBulkGenerate = computed(() => {
  if (!episodeId.value) return false
  if (!form.value.model) return false
  if (!stats.value) return false
  if (!sceneInputsComplete.value) return false
  return stats.value.total_scenes > stats.value.with_image
})
const bulkStatus = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!form.value.model) return 'Pick a model'
  if (!stats.value) return ''
  if (subtitleIntegrity.value && !subtitleIntegrity.value.complete) return 'Complete and re-stitch subtitles first'
  if (promptIntegrity.value && !promptIntegrity.value.complete) return 'Repair missing or duplicated prompts first'
  const missing = stats.value.total_scenes - stats.value.with_image
  if (missing === 0) return 'All scenes have images'
  return `${missing} scene${missing === 1 ? '' : 's'} missing — queue one recoverable batch`
})

function imageUrl(scene: ReviewScene): string {
  return `/api/projects/${slug.value}/scene-review/${episodeId.value}/image/${scene.id}?t=${cacheBuster.value}`
}
function imageKey(scene: ReviewScene): string {
  return `${scene.id}:${cacheBuster.value}`
}

// ── Click-to-preview lightbox (v1.0.241) ────────────────────────────
const previewScene = ref<ReviewScene | null>(null)
// Scenes that actually have an image — the lightbox only navigates across these.
const scenesWithImage = computed(() => scenes.value.filter(s => s.image_filename))
const previewNeighbours = computed<{ prev: ReviewScene | null; next: ReviewScene | null }>(() => {
  const list = scenesWithImage.value
  const cur = previewScene.value
  if (!cur) return { prev: null, next: null }
  const i = list.findIndex(s => s.id === cur.id)
  if (i < 0) return { prev: null, next: null }
  return { prev: list[i - 1] ?? null, next: list[i + 1] ?? null }
})
function openPreview(scene: ReviewScene): void {
  if (!scene.image_filename) return
  previewScene.value = scene
}
function closePreview(): void {
  previewScene.value = null
}
function stepPreview(dir: -1 | 1): void {
  const target = dir === -1 ? previewNeighbours.value.prev : previewNeighbours.value.next
  if (target) previewScene.value = target
}
function onPreviewKey(e: KeyboardEvent): void {
  if (!previewScene.value) return
  // Ignore keystrokes while typing in the inline prompt editor (it has
  // @keydown.stop, but guard anyway so Shift+Y can't fire from a text field).
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return
  if (e.key === 'Escape') { closePreview(); e.preventDefault() }
  else if (e.key === 'ArrowLeft') { stepPreview(-1); e.preventDefault() }
  else if (e.key === 'ArrowRight') { stepPreview(1); e.preventDefault() }
  // v1.0.359 — Shift+Y toggles THIS scene's re-render selection without
  // leaving the preview (continuity only — that's where the batch lives).
  else if (e.shiftKey && (e.key === 'Y' || e.key === 'y') && isContinuity.value) {
    toggleSelected(previewScene.value.id)
    e.preventDefault()
  }
}
// Keep the open preview pointed at the freshest scene object after reloads
// (e.g. when its approval flips or a parallel render lands its image).
watch(scenes, (list) => {
  if (!previewScene.value) return
  const fresh = list.find(s => s.id === previewScene.value!.id)
  if (fresh) previewScene.value = fresh
})

// v1.0.342 — inline prompt fix in the preview lightbox. The editor resets when
// the previewed SCENE changes (open / step), but survives a background scenes
// reload of the SAME scene so an in-progress edit isn't clobbered.
const editPrompt = ref('')
const savingPrompt = ref(false)

// Multi-select for one durable selected-scene GenStudio batch.
const selectedIds = ref<Set<string>>(new Set())
const selectedCount = computed(() => selectedIds.value.size)
function toggleSelected(id: string): void {
  const s = new Set(selectedIds.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  selectedIds.value = s
}
function clearSelection(): void { selectedIds.value = new Set() }
function selectAllUnapproved(): void {
  selectedIds.value = new Set(scenes.value.filter(s => !s.approved && s.visual_prompt).map(s => s.id))
}

// v1.0.359 — stale images (rendered from an older prompt). Surfaced as a count
// + a one-click "select all stale" so re-prompted scenes are easy to re-render.
const staleCount = computed(() => scenes.value.filter(s => s.stale).length)
function selectAllStale(): void {
  selectedIds.value = new Set(scenes.value.filter(s => s.stale && s.visual_prompt).map(s => s.id))
}
/** Is the currently-previewed scene ticked for re-render? (modal selection.) */
const previewSelected = computed(() =>
  !!previewScene.value && selectedIds.value.has(previewScene.value.id))
/** Re-render the checked scenes as one durable GenStudio batch. */
async function regenerateSelected(): Promise<void> {
  const ids = scenes.value.filter(s => selectedIds.value.has(s.id) && s.visual_prompt).map(s => s.id)
  if (!ids.length) { showError('Select at least one scene that has a prompt'); return }
  await renderContinuity({ sceneIds: ids })
  clearSelection()
}
/** Re-render every not-yet-approved scene as one durable GenStudio batch. */
async function regenerateUnapproved(): Promise<void> {
  const ids = scenes.value.filter(s => !s.approved && s.visual_prompt).map(s => s.id)
  if (!ids.length) { showError('No unapproved scenes to regenerate'); return }
  if (!await ask({ title: 'Re-render unapproved scenes?', message: `Re-render all ${ids.length} unapproved scene(s) as a GenStudio batch? Existing images for those scenes are replaced.`, confirmLabel: `Re-render ${ids.length}`, danger: true })) return
  await renderContinuity({ sceneIds: ids })
}
watch(() => previewScene.value?.id, (id) => {
  editPrompt.value = id ? (previewScene.value?.visual_prompt || '') : ''
})
const promptDirty = computed(() =>
  !!previewScene.value && editPrompt.value.trim() !== (previewScene.value.visual_prompt || '').trim())

/** Persist the hand-edited prompt for one scene (resets its approval server-side). */
async function savePromptOnly(scene: ReviewScene): Promise<boolean> {
  const next = editPrompt.value.trim()
  if (!next) { showError('Prompt can\'t be empty'); return false }
  savingPrompt.value = true
  try {
    await post(`/projects/${slug.value}/scene-plan/${episodeId.value}/set-prompt`, {
      scene_id: scene.id,
      visual_prompt: next,
    })
    scene.visual_prompt = next
    scene.approved = false   // image is now stale vs the edited prompt
    success(`Prompt saved for scene ${scene.scene_index}`)
    return true
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save prompt')
    return false
  } finally {
    savingPrompt.value = false
  }
}

/** "Fix it right now": save the edited prompt (if changed) then re-render. */
async function regenerateFromPreview(scene: ReviewScene): Promise<void> {
  if (promptDirty.value && !(await savePromptOnly(scene))) return
  await generateOne(scene)
}

// ── Audio / seek ────────────────────────────────────────────────────
function onAudioTimeUpdate(): void {
  if (audioEl.value) currentTime.value = audioEl.value.currentTime
}
function seekTo(sec: number): void {
  if (audioEl.value) {
    audioEl.value.currentTime = sec
    void audioEl.value.play().catch(() => { /* user gesture may be needed */ })
  }
}

// ── Data fetch ──────────────────────────────────────────────────────
async function loadReview(): Promise<void> {
  const ep = episodeId.value
  const requestSequence = ++reviewLoadSequence
  if (!ep) {
    plan.value = null
    scenes.value = []
    audioPath.value = null
    stats.value = null
    promptIntegrity.value = null
    subtitleIntegrity.value = null
    return
  }
  let loaded = false
  loading.value = true
  try {
    interface ReviewResponse {
      scene_plan: PlanMeta | null
      scenes: ReviewScene[]
      audio_path: string | null
      stats: ReviewStats | null
      render_status: RenderStatus | null
      active_render_job?: any | null
      prompt_integrity?: PromptIntegrity
      subtitle_integrity?: SubtitleIntegrity
    }
    const r = await get<ReviewResponse>(`/projects/${slug.value}/scene-review/${ep}`)
    if (requestSequence !== reviewLoadSequence || episodeId.value !== ep) return
    plan.value = r.scene_plan
    scenes.value = r.scenes
    audioPath.value = r.audio_path
    stats.value = r.stats
    promptIntegrity.value = r.prompt_integrity || null
    subtitleIntegrity.value = r.subtitle_integrity || null
    renderStatus.value = r.render_status || null
    activeRenderJobFromReview.value = r.active_render_job || null
    loaded = true
  } catch (e: any) {
    if (e?.__slugRace) return
  } finally {
    if (requestSequence === reviewLoadSequence && episodeId.value === ep) loading.value = false
  }
  if (loaded && requestSequence === reviewLoadSequence && episodeId.value === ep) await focusPendingScene()
}

// ── Actions ─────────────────────────────────────────────────────────
async function generateOne(scene: ReviewScene): Promise<void> {
  if (reviewJobActive.value) return
  if (!sceneInputsComplete.value) {
    showError('Complete subtitles and repair every missing or duplicated prompt before rendering images.')
    return
  }
  if (!form.value.model) {
    showError('Pick a model in the Greenlight panel before regenerating')
    return
  }
  const ep = episodeId.value
  regeneratingId.value = scene.id
  try {
    if (isContinuity.value) {
      await post(`/projects/${slug.value}/scene-review/${episodeId.value}/continuity-render`, {
        model: form.value.model,
        aspect_ratio: form.value.aspect_ratio,
        single_scene_id: scene.id,
        force: !!scene.image_filename,
        auto_approve_generated: autoApproveGenerated.value,
        ...genStudioImageBody.value,
      })
      success(`${scene.image_filename ? 'Regeneration' : 'Generation'} queued for scene ${scene.scene_index} — it'll update above.`)
    } else {
      await post(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-image`, {
        scene_id: scene.id,
        model: form.value.model,
        aspect_ratio: form.value.aspect_ratio,
        auto_approve_generated: autoApproveGenerated.value,
        ...genStudioImageBody.value,
      })
      success(`Queued scene ${scene.scene_index} — watch the Jobs panel`)
      await pollUntilImageReady(scene.id, ep)
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue scene image')
  } finally {
    regeneratingId.value = null
  }
}

function sceneOverflowItems(scene: ReviewScene) {
  return [{
    label: 'Upload replacement…',
    disabled: regeneratingId.value === scene.id,
    title: 'Replace this scene with an image from your computer.',
    onClick: () => uploadOne(scene),
  }]
}

// Set a scene's image directly from an uploaded file.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result || '')
      const i = s.indexOf('base64,')
      resolve(i >= 0 ? s.slice(i + 'base64,'.length) : s)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}
async function uploadOne(scene: ReviewScene): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    regeneratingId.value = scene.id
    try {
      const data_base64 = await fileToBase64(file)
      await post(`/projects/${slug.value}/scene-review/${episodeId.value}/upload-image/${scene.id}`, {
        filename: file.name,
        data_base64,
      })
      success(`Uploaded image for scene ${scene.scene_index}`)
      cacheBuster.value = Date.now()
      await loadReview()
    } catch (e: any) {
      showError(e?.data?.detail || e?.message || 'Failed to upload image')
    } finally {
      regeneratingId.value = null
    }
  }
  input.click()
}

// v1.0.475 — set a scene's animated CLIP directly from an externally-made mp4
// (manual parity with the extension's upload-clip). Raw-binary POST because the
// app-wide JSON limit is 10mb; the endpoint takes a 256mb raw body.
async function uploadClipOne(scene: ReviewScene): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/mp4'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    animatingId.value = scene.id
    try {
      const resp = await fetch(
        `/api/projects/${slug.value}/scene-review/${episodeId.value}/upload-clip/${scene.id}`,
        { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: file },
      )
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({} as any))
        throw new Error(j.detail || `Upload failed (${resp.status})`)
      }
      success(`Uploaded clip for scene ${scene.scene_index}`)
      cacheBuster.value = Date.now()
      await loadReview()
    } catch (e: any) {
      showError(e?.message || 'Failed to upload clip')
    } finally {
      animatingId.value = null
    }
  }
  input.click()
}

async function generateAllMissing(): Promise<void> {
  if (!canBulkGenerate.value || reviewJobActive.value) return
  const ep = episodeId.value
  bulkQueuingEpisode.value = ep
  try {
    const r = await post<{ queued: number; skipped: number; reused?: boolean; job_id?: string }>(
      `/projects/${slug.value}/scene-review/${ep}/generate-missing`,
      {
        model: form.value.model,
        aspect_ratio: form.value.aspect_ratio,
        auto_approve_generated: autoApproveGenerated.value,
        ...genStudioImageBody.value,
      },
    )
    success(r.reused
      ? 'Already rendering — reused the existing work instead of submitting duplicate images.'
      : `Queued one render for ${r.queued} missing scene${r.queued === 1 ? '' : 's'} (${r.skipped} skipped).`)
    // Re-load every 4s while images are landing.
    await pollUntilAllPresent(ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue bulk gen')
  } finally {
    if (bulkQueuingEpisode.value === ep) bulkQueuingEpisode.value = null
  }
}

const isContinuity = ref(false)
const renderingEpisode = ref<string | null>(null)
const continuityRendering = computed(() => renderingEpisode.value === episodeId.value)

async function loadContinuityFlag(): Promise<void> {
  const ep = episodeId.value
  continuityPacing.value = null
  try {
    const fmt = await get<{ visualSource?: string }>(`/projects/${slug.value}/effective-format`)
    isContinuity.value = fmt?.visualSource === 'continuity-chain'
    // v1.4.82 — the same continuity read Scene Plan does, so the "Ns long"
    // health flag uses the band the user actually chose instead of a constant.
    if (!isContinuity.value || !ep) return
    const r = await get<{ config?: { pacing?: { min_sec: number; max_sec: number } } }>(
      `/projects/${slug.value}/continuity/${ep}`,
    )
    if (episodeId.value !== ep) return
    continuityPacing.value = r?.config?.pacing || null
  } catch { isContinuity.value = false }
}

async function renderContinuity(opts: { sceneIds?: string[] } = {}): Promise<void> {
  if (reviewJobActive.value) return
  if (!sceneInputsComplete.value) {
    showError('Complete subtitles and repair every missing or duplicated prompt before rendering images.')
    return
  }
  if (!form.value.model) { showError('Pick a model in the Greenlight panel first'); return }
  const selection = opts.sceneIds && opts.sceneIds.length ? opts.sceneIds : undefined
  if (!selection) return
  const ep = episodeId.value
  renderingEpisode.value = ep
  try {
    await post(`/projects/${slug.value}/scene-review/${ep}/continuity-render`, {
      model: form.value.model,
      aspect_ratio: form.value.aspect_ratio,
      force: true,
      scene_ids: selection,
      auto_approve_generated: autoApproveGenerated.value,
      ...genStudioImageBody.value,
    })
    success(`Queued ${selection.length} scene(s) for GenStudio — images land as each finishes.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start render')
  } finally {
    if (renderingEpisode.value === ep) renderingEpisode.value = null
  }
}

// ── Live "generating" state (v1.0.231) ───────────────────────────────────
// Detect the active render job for THIS episode, figure out which scene it's
// on (from its "Scene N/M" log line, falling back to the first image-less
// scene), and auto-refresh the review so finished images appear live.
const { jobs, isJobActiveFor } = useJobs()
// v1.0.307 — also reflect scene_image_generate jobs still queued/running for
// this episode, so the bulk button stays greyed even after a reload (the local
// `bulkQueuing` ref doesn't survive one). See useJobs.isJobActiveFor.
const reviewJobActive = computed(() => isJobActiveFor(episodeId.value, ['scene_image_generate', 'scene_images_batch', 'continuity_render']))
const activeRenderJob = computed(() => resolveActiveSceneRenderJob(episodeId.value, activeRenderJobFromReview.value, jobs.value))
const activeContinuityRenderJob = computed(() => resolveActiveSceneRenderJob(episodeId.value, activeRenderJobFromReview.value, jobs.value, ['continuity_render', 'scene_images_batch']))
const isRenderPaused = computed(() => activeRenderJob.value?.status === 'paused')
const isRendering = computed(() => !!activeRenderJob.value && !isRenderPaused.value)
const renderProgress = computed<number | null>(() => {
  const p = (activeRenderJob.value as any)?.progress
  return typeof p === 'number' ? p : null
})
// Scenes currently staged by the recoverable GenStudio batch.
const batchInFlight = computed<Set<number>>(() => {
  const s = renderStatus.value
  if (!s?.active || s.mode !== 'batch' || !Array.isArray(s.in_flight)) return new Set()
  return new Set(s.in_flight)
})
function isSceneGenerating(scene: ReviewScene): boolean {
  if (isRenderPaused.value) return false
  if (regeneratingId.value === scene.id) return true
  return batchInFlight.value.has(scene.scene_index)
}

const sceneRenderControls = (job: any): any[] => {
  if (!job) return []
  return (job.controls?.length ? job.controls : (job.control ? [job.control] : []))
    .filter((control: any) => control.action === 'pause-submissions'
      || control.action === 'cancel-before-submit' || control.action === 'stop-local' || control.action === 'request-remote-cancel')
}
const hasSettlingProviderWork = computed(() => {
  const job = activeContinuityRenderJob.value as any
  return (job?.genstudio_jobs || []).some((entry: any) => !['done', 'error', 'cancelled', 'succeeded', 'failed'].includes(entry.state) && entry.cancelled !== true)
    || Object.values(job?.remote_cancellations || {}).some((entry: any) => ['queued', 'submitting', 'requested', 'reconciling', 'unknown'].includes(entry.status))
})

async function runSceneRenderControl(job: any, control: any): Promise<void> {
  if (!job?.job_id || !control?.enabled || cancelingRender.value) return
  const isCancellation = control.action === 'cancel-before-submit' || control.action === 'stop-local' || control.action === 'request-remote-cancel'
  const action = control.action === 'pause-submissions' ? 'pause' : (isCancellation ? 'cancel' : null)
  if (!action) return
  if (!await ask({ title: control.label, message: control.reason, confirmLabel: control.label, danger: isCancellation })) return
  cancelingRender.value = true
  try {
    await post(`/projects/${slug.value}/jobs/${job.job_id}/${action}`, {})
    success(`${control.label} requested. ${control.reason}`)
    cacheBuster.value = Date.now()
    await loadReview()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || `Failed to ${control.label.toLowerCase()}`)
  } finally {
    cancelingRender.value = false
  }
}

async function resumeActiveRender(): Promise<void> {
  const job = activeContinuityRenderJob.value as any
  if (!job?.job_id || cancelingRender.value) return
  cancelingRender.value = true
  try {
    await post(`/projects/${slug.value}/jobs/${job.job_id}/resume`, {})
    success('Scene render resumed. Saved files are audited; only missing scenes can be submitted.')
    await loadReview()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to resume scene render')
  } finally {
    cancelingRender.value = false
  }
}

// Auto-refresh while a render is active so images land without a manual reload.
let renderPollTimer: ReturnType<typeof setInterval> | null = null
watch(isRendering, (active) => {
  if (active && !renderPollTimer) {
    renderPollTimer = setInterval(() => { cacheBuster.value = Date.now(); void loadReview() }, 3500)
  } else if (!active && renderPollTimer) {
    clearInterval(renderPollTimer)
    renderPollTimer = null
    cacheBuster.value = Date.now()
    void loadReview()  // final refresh to pick up the last image
  }
}, { immediate: true })
onBeforeUnmount(() => { if (renderPollTimer) clearInterval(renderPollTimer) })

async function pollUntilImageReady(sceneId: string, ep: string): Promise<void> {
  const start = Date.now()
  const timeoutMs = 120_000
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000))
    if (episodeId.value !== ep) return  // switched away — stop; don't reload another episode
    await loadReview()
    const found = scenes.value.find(s => s.id === sceneId)
    if (found?.image_filename) {
      cacheBuster.value = Date.now()  // force img reload
      return
    }
  }
}
async function pollUntilAllPresent(ep: string): Promise<void> {
  const start = Date.now()
  const timeoutMs = 300_000  // 5 min for bulk
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 4000))
    if (episodeId.value !== ep) return  // switched away — stop
    await loadReview()
    if (activeRenderJob.value?.status === 'paused') return
    cacheBuster.value = Date.now()
    if (stats.value && stats.value.with_image >= stats.value.total_scenes) return
  }
}

/**
 * Approval is persisted in scene_plan.json, while Pending-only selectors read
 * the shared episode-status cache. Publish the server-confirmed result first
 * so every mounted selector updates synchronously, then reconcile with the
 * authoritative episode endpoint without blocking the approval interaction.
 */
function publishReviewCompletion(episodeCode: string, reviewStats: ReviewStats): void {
  updateCachedEpisode(episodeCode, episode => ({
    ...episode,
    status: {
      ...episode.status,
      scene_review: reviewStats.all_approved,
    },
  }))
  void revalidateAfterMutation(episodeCode).catch((e: any) => {
    showError(
      e?.data?.detail
      || e?.message
      || `Approval was saved for ${episodeCode}, but the pending list could not be refreshed.`,
    )
  })
}

async function approveOne(scene: ReviewScene, approved: boolean): Promise<void> {
  approvingId.value = scene.id
  try {
    const r = await put<{ stats: ReviewStats }>(
      `/projects/${slug.value}/scene-review/${episodeId.value}/approve`,
      { scene_id: scene.id, approved },
    )
    scene.approved = approved
    if (r.stats) {
      stats.value = r.stats
      publishReviewCompletion(episodeId.value, r.stats)
    }
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to update approval')
  } finally {
    approvingId.value = null
  }
}
async function approveAll(approved: boolean): Promise<void> {
  approvingAll.value = true
  try {
    const r = await put<{ changed: number; stats: ReviewStats }>(
      `/projects/${slug.value}/scene-review/${episodeId.value}/approve`,
      { all: approved },
    )
    stats.value = r.stats
    publishReviewCompletion(episodeId.value, r.stats)
    success(`${approved ? 'Approved' : 'Reset'} ${r.changed} scene${r.changed === 1 ? '' : 's'}`)
    await loadReview()
  } catch (e: any) {
    showError(e?.data?.detail || 'Bulk approve failed')
  } finally {
    approvingAll.value = false
  }
}

// The dashboard owns the scroll container, so the page must watch it rather
// than window. Keeping this local avoids page-wide scroll listeners.
const showBackToTop = ref(false)
const SCROLL_THRESHOLD = 560
function getScrollContainer(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector('.main-content') as HTMLElement | null
}
function onScroll(): void {
  const el = getScrollContainer()
  if (el) showBackToTop.value = el.scrollTop > SCROLL_THRESHOLD
}
function scrollToTop(): void {
  const el = getScrollContainer()
  if (el) el.scrollTo({ top: 0, behavior: 'smooth' })
}

onMounted(() => {
  // loadContinuityFlag() runs from the episodeId watcher below (immediate),
  // which also re-reads it on every episode switch.
  void refreshGenStudioImageModels()
  void srPresets.load()   // auto-applies the last render preset (model, aspect, pool)
  if (typeof window !== 'undefined') window.addEventListener('keydown', onPreviewKey)
  const el = getScrollContainer()
  if (el) {
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }
  if (typeof IntersectionObserver !== 'undefined') {
    sceneLoadObserver = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreScenes()
    }, { root: el, rootMargin: '500px 0px' })
    if (sceneLoadSentinel.value) sceneLoadObserver.observe(sceneLoadSentinel.value)
  }
})
watch(sceneLoadSentinel, (next, previous) => {
  if (!sceneLoadObserver) return
  if (previous) sceneLoadObserver.unobserve(previous)
  if (next) sceneLoadObserver.observe(next)
})
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onPreviewKey)
  const el = getScrollContainer()
  if (el) el.removeEventListener('scroll', onScroll)
  sceneLoadObserver?.disconnect()
  sceneLoadObserver = null
})
async function focusPendingScene(): Promise<void> {
  const sceneId = pendingSceneDeepLink.value
  if (!sceneId || !scenes.value.some(scene => scene.id === sceneId)) return
  const { scene_id: _sceneId, ...query } = route.query
  await router.replace({ query })
  await nextTick()
  await jumpToScene(sceneId, { focus: true })
  if (document.activeElement?.id === `sr-scene-${sceneId}`) pendingSceneDeepLink.value = ''
}
watch(() => route.query.episode_id, (episode) => {
  if (typeof episode === 'string' && episode !== episodeId.value) episodeId.value = episode
})
watch(() => route.query.scene_id, (sceneId) => {
  if (typeof sceneId === 'string') {
    pendingSceneDeepLink.value = sceneId
    void focusPendingScene()
  }
})
watch(episodeId, () => {
  renderedSceneLimit.value = SCENE_RENDER_BATCH
  void loadReview()
  // v1.4.82 — the pacing band is per-episode, so re-read it on every switch.
  // Loading it only onMounted left the "Ns long" flag judging episode B against
  // episode A's maximum.
  void loadContinuityFlag()
}, { immediate: true })
</script>

<style scoped>
.review-workspace {
  --review-gold: #f0c66a;
  --review-green: #53c786;
  --review-ink: #101710;
  padding-bottom: 72px;
}
.review-hero-route {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 28px auto 22px 28px auto 22px 28px auto;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
}
.review-hero-route span {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--border-light);
  border-radius: 50%;
  background: color-mix(in srgb, var(--bg-primary) 76%, transparent);
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 800;
}
.review-hero-route span.is-complete { border-color: var(--review-green); background: var(--review-green); color: var(--review-ink); }
.review-hero-route span.is-current { border-color: var(--review-gold); color: var(--review-gold); box-shadow: 0 0 0 4px rgba(240,198,106,.1); }
.review-hero-route b { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 600; }
.review-hero-route i { height: 1px; background: var(--border); }

.review-command-bar :deep(.top-action-bar) {
  display: grid;
  grid-template-columns: minmax(350px, auto) minmax(420px, 1fr) auto;
  align-items: end;
  gap: 16px;
  margin-bottom: 0;
  padding: 16px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-secondary) 92%, var(--review-gold) 8%);
  box-shadow: 0 10px 30px rgba(0,0,0,.1);
}
.review-command-bar :deep(.region-spacer) { display: none; }
.review-command-bar :deep(.preset-region),
.review-command-bar :deep(.episode-region),
.review-command-bar :deep(.generate-region) { align-self: stretch; }
.review-command-bar :deep(.generate-region) { justify-content: flex-end; align-items: flex-end; }
.review-command-bar :deep(.btn-primary-cta) { min-width: 172px; min-height: 38px; border-radius: 9px; white-space: nowrap; }

.back-to-top {
  position: fixed;
  right: 28px;
  bottom: 28px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 0 16px 0 11px;
  border: 1px solid rgba(240, 198, 106, .45);
  border-radius: 999px;
  background: #20281f;
  color: #fff8e9;
  font-size: 12px;
  font-weight: 750;
  cursor: pointer;
  box-shadow: 0 12px 34px rgba(0, 0, 0, .38);
  z-index: 120;
  transition: transform .18s ease, border-color .18s ease, background .18s ease;
}
.back-to-top span { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--review-gold); color: var(--review-ink); font-size: 15px; }
.back-to-top:hover {
  transform: translateY(-3px);
  border-color: var(--review-gold);
  background: #293329;
}
.review-float-enter-active, .review-float-leave-active { transition: opacity .18s ease, transform .18s ease; }
.review-float-enter-from, .review-float-leave-to { opacity: 0; transform: translateY(10px); }

.sr-control-deck { overflow: hidden; padding: 0; border-radius: 16px; }
.sr-greenlight-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 22px 16px;
}
.sr-status-kicker { color: var(--review-gold); font-size: var(--font-xs); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.sr-status-copy h3 { margin: 5px 0 3px; font-size: 20px; letter-spacing: -.02em; }
.sr-status-copy p { margin: 0; color: var(--text-muted); font-size: 12px; }
.sr-status-orb {
  display: grid;
  min-width: 82px;
  min-height: 58px;
  place-content: center;
  border: 1px solid color-mix(in srgb, var(--review-gold) 35%, var(--border));
  border-radius: 13px;
  background: color-mix(in srgb, var(--review-gold) 8%, transparent);
  text-align: center;
}
.sr-status-orb strong { color: var(--review-gold); font-size: 19px; line-height: 1; }
.sr-status-orb span { margin-top: 4px; color: var(--text-muted); font-size: var(--font-xs); letter-spacing: .08em; text-transform: uppercase; }
.sr-status-orb.ready { border-color: color-mix(in srgb, var(--review-green) 55%, var(--border)); background: color-mix(in srgb, var(--review-green) 10%, transparent); }
.sr-status-orb.ready strong { color: var(--review-green); }
.sr-progress-track { height: 4px; margin: 0 22px 2px; overflow: hidden; border-radius: 999px; background: var(--bg-tertiary); }
.sr-progress-track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--review-gold), var(--review-green)); transition: width .35s ease; }
.sr-greenlight-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 22px 2px; }
.sr-greenlight-actions .btn { min-height: 36px; }
.sr-control-section { padding: 17px 22px; border-top: 1px solid var(--border); }
.sr-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 13px; }
.sr-section-heading > div { display: flex; align-items: center; gap: 9px; }
.sr-section-heading span { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 7px; background: color-mix(in srgb, var(--review-gold) 13%, var(--bg-tertiary)); color: var(--review-gold); font-size: var(--font-xs); font-weight: 800; }
.sr-section-heading strong { font-size: 13px; }
.sr-section-heading small { color: var(--text-muted); font-size: var(--font-xs); }
.sr-model-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.sr-model-grid.is-single { grid-template-columns: minmax(0, 1fr); }
.sr-model-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: color-mix(in srgb, var(--bg-secondary) 78%, transparent);
}
.sr-field-heading { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; }
.sr-field-heading small, .sr-model-field > small { color: var(--text-muted); font-size: var(--font-xs); }
.sr-settings-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  align-items: end;
}
.sr-actions-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.sr-actions-grid .btn { min-height: 34px; border-radius: 8px; }

.sr-ratio-pick { display: flex; min-width: 0; flex-direction: column; align-items: stretch; gap: 6px; }
.sr-cost { margin: 8px 0 0; font-size: var(--font-xs); color: var(--text); line-height: 1.4; }
.sr-cost.basis-unpublished { color: var(--warning, #d97706); }
.sr-cost.basis-free { color: var(--success, #16a34a); }
.sr-static-control {
  display: flex;
  min-height: 42px;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
}
.sr-static-control strong { overflow: hidden; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.sr-static-control small { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }
.sr-auto-approve {
  display: flex;
  min-width: 0;
  width: fit-content;
  max-width: 100%;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  margin-top: 12px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--review-gold) 5%, var(--bg-tertiary));
  cursor: pointer;
}
.sr-auto-approve input { flex: 0 0 auto; }
.sr-auto-approve span { display: grid; gap: 3px; min-width: 0; }
.sr-auto-approve strong { color: var(--text-primary); font-size: 12px; }
.sr-auto-approve small { color: var(--text-muted); font-size: var(--font-xs); }
.sr-ratio-label {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 750;
  text-transform: uppercase;
  letter-spacing: .07em;
}
.sr-ratio-select { width: 100%; min-width: 0; }

/* ── Click-to-preview lightbox (v1.0.241) ──────────────────────────── */
.sr-lightbox {
  position: fixed; inset: 0; z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.82);
  padding: 32px 56px;
  animation: sr-fade 0.12s ease-out;
}
@keyframes sr-fade { from { opacity: 0; } to { opacity: 1; } }
.sr-lb-figure {
  margin: 0; display: flex; flex-direction: column; gap: 10px;
  max-width: 100%; max-height: 100%; align-items: center;
}
.sr-lb-img {
  max-width: 100%;
  /* Leaves room for the meta row + the editable prompt + the action row below. */
  max-height: calc(100vh - 300px);
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  background: var(--bg-secondary);
}
.sr-lb-cap {
  display: flex; flex-direction: column; gap: 10px;
  width: min(900px, 92vw);
  color: #fff; font-size: 13px;
}
.sr-lb-cap .text-muted { color: rgba(255, 255, 255, 0.6); }
.sr-lb-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center; }
.sr-lb-approved { color: #5bb37c; font-weight: 600; }
.sr-lb-dirty { color: #e0b15a; font-weight: 600; }

/* v1.0.359 — stale-image flags + the in-preview keyboard hint + Select-stale button. */
.sr-lb-stale { color: #e0843a; font-weight: 600; }
.sr-lb-kbd {
  margin-left: 6px;
  padding: 0 5px;
  font-size: var(--font-xs);
  line-height: 1.4;
  border: 1px solid currentColor;
  border-radius: 3px;
  opacity: 0.7;
}
/* Row-head badge + thumbnail corner flag. */
.review-stale-badge {
  font-size: var(--font-xs);
  font-weight: 600;
  color: #e0843a;
  border: 1px solid color-mix(in srgb, #e0843a 50%, transparent);
  border-radius: 4px;
  padding: 0 5px;
}
.review-thumb-stale {
  position: absolute;
  top: 5px;
  left: 5px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  border-radius: 50%;
  background: #e0843a;
  color: #1a1205;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  z-index: 2;
}
/* v1.0.470 — animated-clip badge (bottom-right of the thumbnail). */
.review-thumb-clip {
  position: absolute;
  bottom: 5px;
  right: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1px 5px;
  font-size: 12px;
  border-radius: 10px;
  background: rgba(20, 20, 28, 0.82);
  color: #cfe3ff;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  z-index: 2;
}
.review-thumb-clip:hover { background: rgba(40, 40, 56, 0.95); }
.sr-lb-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.btn-warn {
  background: color-mix(in srgb, #e0843a 22%, transparent);
  border-color: #e0843a;
  color: var(--text-primary);
}
.btn-warn:hover { background: color-mix(in srgb, #e0843a 38%, transparent); }

.sr-lb-prompt { display: flex; flex-direction: column; gap: 4px; }
.sr-lb-prompt-label { font-size: var(--font-xs); color: rgba(255, 255, 255, 0.55); }
.sr-lb-prompt-input {
  width: 100%; resize: vertical; font: inherit; font-size: 12px; line-height: 1.45;
  padding: 8px 10px; border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(0, 0, 0, 0.35); color: #fff;
}
.sr-lb-prompt-input:focus { outline: none; border-color: #6aa9ff; }
.sr-lb-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.sr-lb-close {
  position: absolute; top: 16px; right: 20px;
  width: 38px; height: 38px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.12); border: 0; color: #fff;
  font-size: 18px; cursor: pointer; line-height: 1;
}
.sr-lb-close:hover { background: rgba(255, 255, 255, 0.25); }
.sr-lb-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 48px; height: 72px; border: 0; border-radius: 8px;
  background: rgba(255, 255, 255, 0.10); color: #fff;
  font-size: 34px; line-height: 1; cursor: pointer;
}
.sr-lb-nav:hover { background: rgba(255, 255, 255, 0.22); }
.sr-lb-prev { left: 12px; }
.sr-lb-next { right: 12px; }

/* ── Live render / generating state (v1.0.231) ─────────────────────── */
.review-thumb-cell { position: relative; }
.review-thumb-cell.is-previewable { cursor: pointer; border-radius: var(--radius-sm, 6px); }
.review-thumb-cell.is-previewable:focus-visible {
  outline: 2px solid var(--accent, #f0b429);
  outline-offset: 3px;
}
@keyframes sr-spin { to { transform: rotate(360deg); } }
.review-spinner {
  display: inline-block;
  width: 22px; height: 22px;
  border: 2.5px solid rgba(255, 255, 255, 0.25);
  border-top-color: var(--accent, #f0b429);
  border-radius: 50%;
  animation: sr-spin 0.8s linear infinite;
  flex-shrink: 0;
}
.review-thumb-generating {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  width: 100%; height: 100%; min-height: 64px;
  border-radius: var(--radius-sm, 6px);
  background: rgba(240, 180, 41, 0.10);
  border: 1px dashed rgba(240, 180, 41, 0.5);
  color: var(--text-secondary);
}
.review-thumb-generating small { font-size: var(--font-xs); }
.review-thumb-overlay {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: var(--radius-sm, 6px);
  color: #fff;
  pointer-events: none;
}
.review-thumb-overlay small { font-size: var(--font-xs); }
.review-render-banner {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 14px;
  background: rgba(240, 180, 41, 0.10);
  border: 1px solid rgba(240, 180, 41, 0.4);
  border-radius: var(--radius-md, 8px);
  font-size: 13px;
}
.review-render-bar {
  flex: 1 1 160px; min-width: 120px; height: 6px;
  background: var(--bg-tertiary); border-radius: 999px; overflow: hidden;
}
.review-render-fill { display: block; height: 100%; background: var(--accent, #f0b429); transition: width 0.4s ease; }
.review-stop-btn {
  margin-left: auto;
  background: rgba(220, 80, 80, 0.16);
  border: 1px solid rgba(220, 80, 80, 0.55);
  border-radius: 6px;
  color: #ffb3b3;
  padding: 3px 10px;
  font-size: var(--font-xs);
  cursor: pointer;
}
.review-stop-btn:hover:not(:disabled) { background: rgba(220, 80, 80, 0.26); color: #ffd0d0; }
.review-stop-btn:disabled { opacity: 0.6; cursor: default; }

/* v1.0.245 — Plan-health banner + flagged rows. */
.sr-health {
  padding: 10px 12px;
  border: 1px solid rgba(224, 162, 58, 0.4);
  border-left: 3px solid #e0a23a;
  background: rgba(224, 162, 58, 0.08);
  border-radius: 8px;
}
.sr-health-head { font-size: 13px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.sr-health-link { color: var(--accent); text-decoration: none; font-weight: 500; font-size: 12px; }
.sr-health-link:hover { text-decoration: underline; }
.sr-health-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.sr-health-chip {
  font-size: var(--font-xs); padding: 3px 9px; border-radius: 999px;
  border: 1px solid rgba(224, 162, 58, 0.45); background: rgba(224, 162, 58, 0.1);
  color: var(--text-primary); cursor: pointer;
}
.sr-health-chip:hover { border-color: #e0a23a; background: rgba(224, 162, 58, 0.2); }
.sr-health-why { color: var(--text-muted); }
.sr-blocking-warning {
  border: 1px solid rgba(232, 91, 91, 0.55);
  border-left: 4px solid #e85b5b;
  border-radius: 10px;
  background: rgba(232, 91, 91, 0.09);
  padding: 11px 13px;
  color: var(--text-secondary);
  font-size: 13px;
}
.sr-blocking-warning strong { color: var(--text-primary); margin-right: 4px; }
.sr-legacy-note {
  border: 1px solid rgba(224, 162, 58, 0.35);
  border-radius: 10px;
  background: rgba(224, 162, 58, 0.08);
  padding: 10px 13px;
  color: var(--text-muted);
  font-size: 12px;
}
.sr-row-problem { border-left: 3px solid #e0a23a; }
.sr-row-flash { animation: sr-row-flash-kf 1.4s ease; }
@keyframes sr-row-flash-kf {
  0%, 100% { box-shadow: 0 0 0 0 rgba(240, 180, 41, 0); }
  20% { box-shadow: 0 0 0 3px rgba(240, 180, 41, 0.55); }
}

.is-greenlit {
  border: 2px solid #5bb37c;
  background: rgba(91, 179, 124, 0.06);
}
.is-greenlit h3 { color: #5bb37c; }

.review-audio { width: 100%; margin-bottom: 8px; }

.review-scene-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.review-scene-row {
  display: grid;
  grid-template-columns: 160px 1fr auto;
  gap: 12px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  align-items: start;
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}
.review-list-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 14px;
  color: var(--text-muted);
  font-size: 12px;
}
.review-scene-row.is-approved { border-left: 3px solid #5bb37c; }
.review-scene-row.is-missing { opacity: 0.75; }
.review-scene-row.is-current {
  background: rgba(108, 143, 255, 0.10);
  border-color: var(--accent);
}

.review-thumb-cell { width: 160px; }
.review-thumb {
  width: 160px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid var(--border);
}
.review-thumb-empty {
  width: 160px;
  aspect-ratio: 16 / 9;
  border: 2px dashed var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: var(--font-xs);
  cursor: pointer;
  text-align: center;
  padding: 4px;
}
.review-thumb-empty:hover { border-color: var(--accent); color: var(--accent); }
.review-thumb-empty.is-disabled { cursor: not-allowed; opacity: .58; }
.review-thumb-empty.is-disabled:hover { border-color: var(--border); color: var(--text-muted); }

.review-body-cell { min-width: 0; }
.review-row-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
/* v1.0.344 — per-scene select checkbox for parallel batch re-render. */
.review-select { width: 15px; height: 15px; cursor: pointer; accent-color: #6aa9ff; align-self: center; }
.review-time-btn {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.review-time-btn:hover { text-decoration: underline; }
.review-transcript {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.5;
}
.review-prompt-details { margin-top: 4px; }
.review-prompt-details summary { cursor: pointer; }
.review-prompt {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.45;
}

.review-actions-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
  min-width: 110px;
}

.text-accent { color: var(--accent); }

/* Refined scene ledger: clearer grouping without increasing row height. */
.review-workspace > .card:last-of-type { border-radius: 16px; }
.review-audio { height: 42px; border-radius: 10px; }
.review-scene-list { gap: 9px; }
.review-scene-row {
  grid-template-columns: 176px minmax(0, 1fr) 132px;
  gap: 15px;
  padding: 11px;
  border-radius: 11px;
  box-shadow: 0 4px 16px rgba(0,0,0,.06);
  transition: border-color .18s ease, background .18s ease, transform .18s ease;
}
.review-scene-row:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--review-gold) 30%, var(--border)); }
.review-thumb-cell, .review-thumb, .review-thumb-empty { width: 176px; }
.review-thumb, .review-thumb-empty { border-radius: 8px; }
.review-row-head strong { display: inline-grid; min-width: 27px; min-height: 24px; place-items: center; border-radius: 7px; background: var(--bg-tertiary); }
.review-transcript { margin: 7px 0; color: var(--text-secondary); }
.review-actions-cell { gap: 6px; min-width: 132px; }
.review-actions-cell .btn { justify-content: flex-start; min-height: 31px; border-radius: 7px; }

@media (max-width: 1400px) {
  .review-command-bar :deep(.top-action-bar) {
    grid-template-columns: minmax(0, .85fr) minmax(0, 1.4fr);
    align-items: stretch;
  }
  .review-command-bar :deep(.generate-region) {
    grid-column: 1 / -1;
  }
  .review-command-bar :deep(.generate-region) { justify-content: flex-start; }
  .sr-settings-grid { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
}
@media (max-width: 900px) {
  .review-hero-route { display: none; }
  .sr-model-grid, .sr-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .review-scene-row { grid-template-columns: 150px minmax(0, 1fr); }
  .review-thumb-cell, .review-thumb, .review-thumb-empty { width: 150px; }
  .review-actions-cell { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; }
  .review-actions-cell .btn { justify-content: center; }
}
@media (max-width: 640px) {
  .review-command-bar :deep(.top-action-bar) {
    grid-template-columns: 1fr;
    padding: 12px;
  }
  .sr-greenlight-head, .sr-section-heading { align-items: flex-start; flex-direction: column; }
  .sr-status-orb { width: 100%; min-height: 48px; }
  .sr-model-grid, .sr-settings-grid { grid-template-columns: 1fr; }
  .review-scene-row { grid-template-columns: 1fr; }
  .review-thumb-cell, .review-thumb, .review-thumb-empty { width: 100%; }
  .back-to-top { right: 16px; bottom: 16px; }
}
</style>
