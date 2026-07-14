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
  <div class="review-workspace">
    <div class="review-hero">
      <div class="review-hero-copy">
        <Breadcrumb />
        <span class="review-eyebrow">Image quality gate</span>
        <h1>Scene Review</h1>
        <p>Review every planned image against its narration, repair gaps, and approve the final visual sequence before assembly.</p>
      </div>
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
    </div>

    <div class="review-command-bar">
      <TopActionBar
        :project-slug="slug"
        v-model:episode-id="episodeId"
        filter-field="scene_review"
        :presets="srPresets"
        generate-label="Generate all missing"
        loading-label="Queuing…"
        :generate-loading="bulkQueuing || reviewJobActive || isRendering"
        :generate-disabled="!canBulkGenerate"
        :generate-status="bulkStatus"
        @generate="generateAllMissing"
      />
    </div>

    <div v-if="subtitleIntegrity && !subtitleIntegrity.complete" class="sr-blocking-warning mt-2">
      <strong>Scene rendering paused: subtitle narration is incomplete.</strong>
      Missing: {{ subtitleIntegrity.missing_sections.join(', ') }}.
      <NuxtLink :to="`/projects/${slug}/subtitles`" class="sr-health-link">Complete transcription and stitch again →</NuxtLink>
    </div>
    <div v-if="promptIntegrity && !promptIntegrity.complete" class="sr-blocking-warning mt-2">
      <strong>Scene rendering paused: prompts are not ready.</strong>
      {{ promptIntegrity.empty_ids.length }} missing and {{ promptIntegrity.duplicate_ids.length }} duplicated.
      <NuxtLink :to="`/projects/${slug}/scene-plan`" class="sr-health-link">Run All pending on Scene Plan →</NuxtLink>
    </div>
    <div v-if="stats?.legacy_unmapped_images" class="sr-legacy-note mt-2">
      {{ stats.legacy_unmapped_images }} older numbered image{{ stats.legacy_unmapped_images === 1 ? '' : 's' }} belong to a previous timeline and are intentionally not counted. They cannot be safely assigned to these stable scene IDs.
    </div>

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

      <div class="sr-control-section">
        <div class="sr-section-heading">
          <div><span>01</span><strong>Render settings</strong></div>
          <small>Controls used for missing images and re-renders</small>
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
          <!-- v1.0.241 — parallel-mode pool size. Only relevant to "⚡ Render in
               parallel"; sequential mode ignores it. -->
          <div v-if="isContinuity" class="sr-ratio-pick" title="How many scenes the parallel (⚡) render works on at once. Auto = match the number of online Image Studio servers (1 Mac → ×1, 3 Macs → ×3). Or pick a fixed count; local modals may prefer 2–3 per Mac.">
            <label class="sr-ratio-label" for="sr-concurrency">Parallel</label>
            <select id="sr-concurrency" v-model="form.concurrency" class="select sr-ratio-select sr-conc-select">
              <option value="auto">Auto</option>
              <option value="2">×2</option>
              <option value="3">×3</option>
              <option value="4">×4</option>
              <option value="6">×6</option>
              <option value="8">×8</option>
              <option value="12">×12</option>
              <option value="16">×16</option>
              <option value="24">×24</option>
              <option value="50">×50</option>
            </select>
          </div>
          <!-- v1.0.254 — render mode for continuity projects: img2img (references)
               vs text2img (prompt only, no references). -->
          <div v-if="isContinuity" class="sr-ratio-pick" title="References = img2img (character sheet + style + characters anchor every scene). Prompt only = text2img: no references sent, each scene rendered from its text prompt alone — cheaper/faster on local, but consistency rides entirely on the prompt + Style Bible.">
            <label class="sr-ratio-label" for="sr-mode">Mode</label>
            <select id="sr-mode" v-model="form.render_mode" class="select sr-ratio-select">
              <option value="refs">References (img2img)</option>
              <option value="prompt">Prompt only (text2img)</option>
            </select>
          </div>
          <!-- v1.0.261 — render-size tier for LOCAL Image Studio models. Smaller
               = far less GPU memory (fewer OOM crashes), faster, smaller files.
               Hidden for cloud models (they use the aspect string, not pixels). -->
          <div v-if="isLocalModel" class="sr-ratio-pick" title="Output resolution for the local model. Smaller cuts GPU/VAE memory (fewer out-of-memory crashes), renders faster, and writes smaller files. Cloud models ignore this and use the aspect ratio. Shows the exact pixels sent.">
            <label class="sr-ratio-label" for="sr-size">Size</label>
            <select id="sr-size" v-model.number="form.render_scale" class="select sr-ratio-select sr-size-select">
              <option v-for="rs in renderSizes" :key="rs.value" :value="rs.value">
                {{ rs.label }} — {{ dimsLabel(rs.value) }}
              </option>
            </select>
          </div>
          <div class="sr-model-pick">
            <ImageModelPicker
              v-model="form.model"
              :project-slug="slug"
              :image-models="config?.image_models || {}"
              :image-mode="promptOnly ? 'text2img' : (isContinuity ? 'img2img' : 'text2img')"
              default-label="Pick an image model…"
            />
          </div>
          <!-- v1.0.360 — LLM model for "Rewrite with AI" (single + bulk). Was
               auto-picked silently; now you choose it. -->
          <div class="sr-llm-pick" title="The text/LLM model used by 'Rewrite with AI' (per-scene and bulk). Separate from the image model on the left.">
            <span class="sr-llm-label">Rewrite LLM</span>
            <select v-model="textModel" class="select sr-llm-select">
              <option value="" disabled>Pick an LLM…</option>
              <option
                v-for="m in textModels"
                :key="m.id"
                :value="m.id"
                :disabled="!m.available || !!m.disabled_reason"
              >{{ m.label || m.id }}{{ (!m.available || m.disabled_reason) ? ' (unavailable)' : '' }}</option>
            </select>
          </div>
        </div>
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
          <!-- v1.0.194 — continuity-chain only: sequential render of every scene. -->
          <button
            v-if="isContinuity"
            class="btn btn-sm btn-secondary"
            :disabled="!sceneInputsComplete || !form.model || continuityRendering || isRendering"
            @click="renderContinuity()"
            title="SEQUENTIAL — render every scene in order, each anchored to the PREVIOUS render + your character sheet/characters. Best frame-to-frame continuity, but slow (one scene at a time). Resumes where it left off. Runs in the Jobs panel."
          >
            🎬 Render sequentially
          </button>
          <button
            v-if="isContinuity && stats.with_image > 0"
            class="btn btn-sm btn-ghost"
            :disabled="!sceneInputsComplete || !form.model || continuityRendering || isRendering"
            @click="renderContinuity({ force: true })"
            title="Re-render ALL scenes sequentially from scratch (discards current renders)."
          >
            ↻ Re-render all
          </button>
          <!-- v1.0.241 — independent / parallel render. Drops the previous-render
               reference so scenes are mutually independent and run concurrently. -->
          <button
            v-if="isContinuity"
            class="btn btn-sm btn-primary"
            :disabled="!sceneInputsComplete || !form.model || continuityRendering || isRendering"
            @click="renderContinuity({ independent: true })"
            title="PARALLEL — render scenes concurrently using ONLY the style image + character sheet/characters (no previous-render reference). Much faster, but loses frame-to-frame continuity. Fills in any scene that's still missing an image."
          >
            ⚡ Render in parallel
          </button>
          <button
            v-if="isContinuity && stats.with_image > 0"
            class="btn btn-sm btn-ghost"
            :disabled="!sceneInputsComplete || !form.model || continuityRendering || isRendering"
            @click="renderContinuity({ independent: true, force: true })"
            title="Re-render ALL scenes in parallel from scratch (style + sheet only, no prev-render). Fast bulk re-roll."
          >
            ⚡↻ Re-render all (parallel)
          </button>
          <!-- v1.0.344 — re-roll a CHOSEN set (checkboxes on the scenes below) or
               all unapproved, as ONE parallel job spread across the Mac pool —
               instead of clicking per-scene Regenerate (which queues serial,
               one-Mac-at-a-time jobs). -->
          <button
            v-if="isContinuity && selectedCount > 0"
            class="btn btn-sm btn-primary"
            :disabled="!form.model || continuityRendering || isRendering || bulkRewriting"
            @click="regenerateSelected"
            title="Re-render the selected scenes in ONE parallel job across the whole Mac pool."
          >
            ⚡ Regenerate selected ({{ selectedCount }})
          </button>
          <!-- v1.0.360 — bulk AI re-prompt of the selected scenes (one at a time;
               rewrite is one job per episode). Images stay until you Regenerate. -->
          <button
            v-if="isContinuity && selectedCount > 0"
            class="btn btn-sm btn-secondary"
            :disabled="!textModel || bulkRewriting || isRendering"
            @click="rewriteSelectedAI"
            :title="!textModel ? 'Pick a Rewrite LLM above first' : 'Re-write every selected scene\'s prompt with the chosen LLM, one at a time. Review, then Regenerate selected.'"
          >
            {{ bulkRewriting ? '⏳ ' + bulkRewriteProgress : `✏️ Rewrite selected with AI (${selectedCount})` }}
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
          <!-- v1.0.359 — stale images: rendered from an older prompt (you
               re-prompted in Scene Plan or edited the prompt here without
               re-rendering). One click ticks them all for a parallel re-render. -->
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
            :disabled="!form.model || continuityRendering || isRendering"
            @click="regenerateUnapproved"
            title="Re-render every not-yet-approved scene in ONE parallel job across the pool."
          >
            ⚡ Regenerate all unapproved
          </button>
        </div>
      </div>
    </section>

    <!-- v1.0.358 — the Render preset (model, aspect ratio, parallel pool size)
         moved to the page-level preset row at the top (TopActionBar), matching
         every other generator tab. Still auto-applies your last preset on load
         via srPresets.load() in onMounted. -->

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
      <div v-if="isRendering" class="review-render-banner mt-2">
        <span class="review-spinner" aria-hidden="true" />
        <span v-if="renderStatus?.mode === 'independent'">
          ⚡ Rendering in parallel<template v-if="renderStatus.concurrency"> (×{{ renderStatus.concurrency }})</template>
          <template v-if="parallelInFlight.size"> — {{ parallelInFlight.size }} scene{{ parallelInFlight.size === 1 ? '' : 's' }} in flight</template>
          <template v-if="renderProgress != null"> · {{ renderProgress }}% done</template>
          <span class="text-muted"> — images appear here as each one finishes.</span>
        </span>
        <span v-else>
          Rendering<template v-if="renderingSceneIndex"> scene {{ renderingSceneIndex }} of {{ scenes.length }}</template>…
          <template v-if="renderProgress != null"> · {{ renderProgress }}% overall</template>
          <span class="text-muted"> — images appear here as each one finishes.</span>
        </span>
        <span v-if="renderProgress != null" class="review-render-bar" aria-hidden="true">
          <span class="review-render-fill" :style="{ width: renderProgress + '%' }" />
        </span>
        <button
          v-if="renderStatus?.active"
          type="button"
          class="review-live-toggle"
          @click="showLivePreview = !showLivePreview"
          :title="showLivePreview ? 'Hide the live reference preview' : 'Show which images are being fed into the model'"
        >{{ showLivePreview ? '👁 Hide preview' : '👁 Show preview' }}</button>
        <button
          v-if="activeContinuityRenderJob"
          type="button"
          class="review-stop-btn"
          :disabled="cancelingRender"
          @click="cancelActiveRender"
          title="Stop the active continuity render. Finished scene images stay on disk; re-run Render sequentially later to resume missing scenes."
        >{{ cancelingRender ? 'Stopping…' : 'Stop render' }}</button>
      </div>

      <!-- v1.0.233 — live "what's being fed in" preview. Shows the exact
           reference images the current scene is sending to the model. -->
      <div
        v-if="isRendering && showLivePreview && renderStatus?.active && renderStatus.references?.length"
        class="review-live-panel mt-2"
      >
        <div class="review-live-head">
          <span class="review-spinner" aria-hidden="true" />
          <strong v-if="renderStatus.mode === 'independent'">
            ⚡ Parallel render — {{ renderStatus.rendered_so_far || 0 }}/{{ renderStatus.to_render || renderStatus.total }} done<template v-if="parallelInFlight.size">, {{ parallelInFlight.size }} in flight</template>
          </strong>
          <strong v-else>Rendering scene {{ renderStatus.scene_index }} of {{ renderStatus.total }}</strong>
          <span class="text-muted">→ {{ renderStatus.model }}
            <em v-if="renderStatus.endpoint">({{ renderStatus.endpoint }})</em>
          </span>
        </div>
        <p v-if="renderStatus.prompt" class="review-live-prompt">“{{ renderStatus.prompt }}”</p>
        <div class="review-live-flow">
          <span class="review-live-label">{{ renderStatus.mode === 'independent' ? 'Shared refs:' : 'Feeding in:' }}</span>
          <figure v-for="(r, i) in renderStatus.references" :key="i" class="review-live-ref" :title="r.label">
            <img :src="r.url" :alt="r.label" loading="lazy" />
            <figcaption>{{ r.label }}</figcaption>
          </figure>
          <span class="review-live-arrow" aria-hidden="true">➜</span>
          <div class="review-live-out">
            <span class="review-spinner" aria-hidden="true" />
            <small v-if="renderStatus.mode === 'independent'">{{ parallelInFlight.size || 1 }} scene{{ parallelInFlight.size === 1 ? '' : 's' }}</small>
            <small v-else>scene {{ renderStatus.scene_index }}</small>
          </div>
        </div>
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
          v-for="scene in scenes"
          :id="`sr-scene-${scene.id}`"
          :key="scene.id"
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
                title="Click to preview full size"
              />
              <!-- Re-render overlay (force / from-here / per-scene regen). -->
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
            <!-- Empty + currently generating (sequential render is on this one). -->
            <div v-else-if="isSceneGenerating(scene)" class="review-thumb-generating" :style="{ aspectRatio: thumbAspect }">
              <span class="review-spinner" aria-hidden="true" />
              <small>Generating…</small>
            </div>
            <div v-else class="review-thumb-empty" :style="{ aspectRatio: thumbAspect }" @click="generateOne(scene)">
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
                title="Select for a parallel re-render (⚡ Regenerate selected)"
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
              :disabled="!form.model || regeneratingId === scene.id"
              @click="generateOne(scene)"
              :title="!form.model ? 'Pick a model in the Greenlight panel first' : (isContinuity ? 'Generate a fresh continuity image for just this scene with its references. Existing images are regenerated from scratch.' : 'Generate / regenerate just this image (resets approval)')"
            >
              {{ regeneratingId === scene.id ? '⏳' : (isContinuity ? '🎬' : '↻') }}
              {{ isContinuity ? (scene.image_filename ? 'Regenerate' : 'Generate (refs)') : 'Regenerate' }}
            </button>
            <button
              v-if="isContinuity && !scene.image_filename"
              class="btn btn-sm btn-ghost"
              :disabled="!form.model || regeneratingId === scene.id"
              @click="repairOne(scene)"
              title="Recover a missing continuity image from an already-submitted provider task first. If nothing is recoverable, queue a single-scene repair render."
            >
              🛠 Repair
            </button>
            <!-- v1.0.232 — set this scene's image from an uploaded file. -->
            <button
              class="btn btn-sm btn-ghost"
              :disabled="regeneratingId === scene.id"
              @click="uploadOne(scene)"
              title="Upload your own image for this scene (e.g. a free image from the web) instead of generating one."
            >
              ⬆ Upload
            </button>
            <!-- v1.0.195 — continuity re-chain from this scene onward. -->
            <button
              v-if="isContinuity"
              class="btn btn-sm btn-ghost"
              :disabled="!form.model || continuityRendering || isRendering"
              @click="renderContinuity({ fromSceneId: scene.id })"
              title="Re-render THIS scene and every scene after it, re-chaining downstream (each anchored to the previous render). Use after editing this scene's prompt, or when the look drifted from here on."
            >
              ⛓ From here
            </button>
            <button
              :class="['btn btn-sm', scene.approved ? 'btn-primary' : 'btn-secondary']"
              :disabled="!scene.image_filename || approvingId === scene.id"
              @click="approveOne(scene, !scene.approved)"
              :title="scene.image_filename ? 'Toggle approval' : 'Generate an image first'"
            >
              {{ approvingId === scene.id ? '⏳' : (scene.approved ? '✓ Approved' : 'Approve') }}
            </button>
          </div>
        </li>
      </ul>
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
              class="btn btn-sm btn-ghost"
              :disabled="!textModel || rewritingId === previewScene.id || bulkRewriting"
              @click.stop="rewritePromptAI(previewScene)"
              :title="!textModel ? 'Pick a Rewrite LLM in the toolbar first (or set an API key / Chat Studio in Settings → Models)' : `Re-write this scene's prompt with ${textModel} (kept on-style via the episode Style Bible), then Regenerate to apply it`"
            >{{ rewritingId === previewScene.id ? '⏳ Rewriting…' : '✏️ Rewrite with AI' }}</button>
            <button
              v-if="promptDirty"
              class="btn btn-sm btn-secondary"
              :disabled="savingPrompt || !editPrompt.trim()"
              @click.stop="savePromptOnly(previewScene)"
              title="Save the edited prompt (the image stays until you Regenerate)"
            >{{ savingPrompt ? '⏳' : '💾 Save prompt' }}</button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!form.model || regeneratingId === previewScene.id"
              @click.stop="regenerateFromPreview(previewScene)"
              :title="!form.model ? 'Pick a model in the Greenlight panel first' : 'Re-render this image (saves your prompt edit first)'"
            >{{ regeneratingId === previewScene.id ? '⏳ Rendering…' : '🔄 Regenerate' }}</button>
            <!-- v1.0.359 — tick THIS scene for the parallel "Regenerate selected"
                 batch without leaving the preview. Keyboard: Shift+Y. -->
            <button
              v-if="isContinuity"
              :class="['btn btn-sm', previewSelected ? 'btn-primary' : 'btn-ghost']"
              @click.stop="toggleSelected(previewScene.id)"
              title="Mark this scene for a parallel re-render (⚡ Regenerate selected). Keyboard: Shift+Y"
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
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Scene Review')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
// v1.0.229 — image-model catalog for the picker. Scene Review renders IMAGES
// (continuity chain / per-scene regen), so it needs the image-model picker,
// not the LLM ModelSelector that used to be here.
const { config } = useProject()
const { get, post, put, del } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()

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

const episodeId = ref('')

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
}
interface PlanMeta {
  schema_version: 1
  generated_at: string
  planner_model?: string
  total_duration_sec: number
  research_used: boolean
}
// v1.0.233 — live render status (which images are being fed into the model).
interface RenderRef { kind: string; label: string; url: string }
interface RenderStatus {
  active: boolean
  provider?: string
  model?: string
  endpoint?: string
  scene_id?: string
  scene_index?: number
  total?: number
  prompt?: string
  references?: RenderRef[]
  // v1.0.241 — parallel/independent mode fields.
  mode?: 'independent' | string
  concurrency?: number
  to_render?: number
  rendered_so_far?: number
  in_flight?: number[]
}

const plan = ref<PlanMeta | null>(null)
const scenes = ref<ReviewScene[]>([])
const audioPath = ref<string | null>(null)
const stats = ref<ReviewStats | null>(null)
const promptIntegrity = ref<PromptIntegrity | null>(null)
const subtitleIntegrity = ref<SubtitleIntegrity | null>(null)
const loading = ref(false)
const renderStatus = ref<RenderStatus | null>(null)
const activeRenderJobFromReview = ref<any | null>(null)
const cancelingRender = ref(false)
// Live-preview panel toggle — persisted per browser, default on.
const showLivePreview = ref(true)
if (typeof window !== 'undefined') {
  showLivePreview.value = window.localStorage.getItem('sceneReviewLivePreview') !== 'off'
}
watch(showLivePreview, (v) => {
  if (typeof window !== 'undefined') window.localStorage.setItem('sceneReviewLivePreview', v ? 'on' : 'off')
})

const form = ref({
  model: '',  // ModelSelector auto-picks first usable
  aspect_ratio: '16:9',
  // v1.0.256 — parallel pool size as a string: 'auto' matches the number of
  // online servers, or '2'..'8' for a fixed count. Auto is the smart default.
  concurrency: 'auto' as string,
  // v1.0.254 — render mode for continuity projects. 'refs' = img2img (sheet +
  // style + characters); 'prompt' = text2img (no references, prompt only —
  // cheaper/faster on local Image Studio, any text2img model).
  render_mode: 'refs' as 'refs' | 'prompt',
  // v1.0.261 — output-size tier for LOCAL Image Studio models (% of the aspect
  // preset). Smaller = far less GPU/VAE memory (fewer OOM crashes), faster,
  // smaller files. Cloud models ignore it (they use the aspect string). 100 =
  // the historical full size, so existing behaviour is unchanged by default.
  render_scale: 100 as number,
})
// v1.0.259 — remember the render settings per-Mac across reloads (an active
// render preset still auto-applies on top; the model picker self-heals a
// removed model).
useRememberedForm('scene-review', slug, form)
const promptOnly = computed(() => isContinuity.value && form.value.render_mode === 'prompt')

// v1.0.244 — Scene Review render presets. Saves the model + aspect ratio +
// parallel pool size and AUTO-APPLIES the last-used preset on load (default
// autoApplyOnLoad), so the chosen model is restored instead of re-picked each
// visit. Uses the same local PresetPicker pattern as the Scene Plan page.
const srPresets = usePresets<{
  model: string
  aspect_ratio: string
  concurrency: string
  render_mode?: 'refs' | 'prompt'
  render_scale?: number
}>({
  slug: slug.value,
  configKey: 'scene_review',
  presetType: 'scene-review',
  snapshot: () => ({
    model: form.value.model,
    aspect_ratio: form.value.aspect_ratio,
    concurrency: form.value.concurrency,
    render_mode: form.value.render_mode,
    render_scale: form.value.render_scale,
  }),
  apply: (data) => { Object.assign(form.value, data) },
})

// Aspect-ratio choices for scene renders. 16:9 is the default video frame;
// the rest are offered for non-standard cuts. The picked value is sent to
// every generate/continuity endpoint and drives the live thumbnail shape.
const aspectRatios = [
  { value: '16:9', label: 'Landscape (YouTube)' },
  { value: '21:9', label: 'Ultrawide' },
  { value: '4:3',  label: 'Standard' },
  { value: '1:1',  label: 'Square' },
  { value: '9:16', label: 'Portrait' },
]
// CSS aspect-ratio string ("16:9" → "16 / 9") so the thumbnail boxes re-shape
// to whatever ratio is selected — making the enforced frame visible.
const thumbAspect = computed(() => form.value.aspect_ratio.replace(':', ' / '))

// ── v1.0.261 — render-size tier (LOCAL Image Studio models only) ─────────
// A local model id is `imagestudio:<repo>`. Cloud models take an aspect string,
// not pixels, so the Size control is hidden + not sent for them.
const isLocalModel = computed(() => form.value.model.startsWith('imagestudio:'))
// Mirror of the provider's ASPECT_PRESETS (electron/.../providers/image/
// imagestudio.ts). The selected tier scales these; result is rounded to /16.
const LOCAL_ASPECT_PRESETS: Record<string, [number, number]> = {
  '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344],
  '4:3': [1152, 864], '3:4': [864, 1152], '21:9': [1536, 640],
  '3:2': [1216, 832], '2:3': [832, 1216],
}
const round16 = (n: number) => Math.max(256, Math.round(n / 16) * 16)
function dimsForScale(scale: number): { width: number; height: number } {
  const base = LOCAL_ASPECT_PRESETS[form.value.aspect_ratio] ?? [1024, 1024]
  const s = (scale || 100) / 100
  return { width: round16(base[0]! * s), height: round16(base[1]! * s) }
}
function dimsLabel(scale: number): string {
  const d = dimsForScale(scale)
  return `${d.width}×${d.height}`
}
const renderSizes = [
  { value: 100, label: 'Full' },
  { value: 75, label: 'Balanced' },
  { value: 50, label: 'Light' },
]
const renderDims = computed(() => dimsForScale(form.value.render_scale))
// Spread into every local render request so the size is explicit ("what you see
// is what's sent"); empty for cloud models so they fall back to the aspect.
const localSizeBody = computed(() =>
  isLocalModel.value ? { width: renderDims.value.width, height: renderDims.value.height } : {})

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
const OVERLONG_SEC = 20
const duplicatePromptIds = computed(() => new Set(promptIntegrity.value?.duplicate_ids || []))
const problemScenes = computed(() => {
  const list: Array<{ scene: ReviewScene; index: number; reasons: string[] }> = []
  scenes.value.forEach((s, i) => {
    const reasons: string[] = []
    const dur = s.end_sec - s.start_sec
    if (!s.visual_prompt || !s.visual_prompt.trim()) reasons.push('no prompt')
    else if (duplicatePromptIds.value.has(s.id)) reasons.push('duplicate prompt')
    if (dur > OVERLONG_SEC) reasons.push(`${dur.toFixed(0)}s long`)
    if (reasons.length) list.push({ scene: s, index: s.scene_index ?? i + 1, reasons })
  })
  return list
})
const problemIds = computed(() => new Set(problemScenes.value.map(p => p.scene.id)))
const sceneInputsComplete = computed(() =>
  promptIntegrity.value?.complete === true && subtitleIntegrity.value?.complete === true,
)
function jumpToScene(id: string): void {
  if (typeof document === 'undefined') return
  const el = document.getElementById(`sr-scene-${id}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
  return `${missing} scene${missing === 1 ? '' : 's'} missing — queue ${missing} job${missing === 1 ? '' : 's'}`
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
const rewritingId = ref<string | null>(null)
// v1.0.343 — "Rewrite with AI" is an LLM task, so it needs a TEXT model — NOT
// the image model in `form.model` (passing that timed out as "Unsupported
// model"). Resolve the first usable text model the same way ModelSelector does.
// v1.0.360 — the LLM used for "Rewrite with AI" (single + bulk). Previously
// auto-picked the first available model silently ("some model I don't
// remember"); now the user can choose it from a picker. We keep the full list
// and only auto-fill a default when nothing is chosen yet — a reload / episode
// switch won't clobber the user's pick.
const textModel = ref('')
const textModels = ref<Array<{ id: string; label?: string; available?: boolean; disabled_reason?: string }>>([])
const IMAGE_MODEL_RE = /^(imagestudio|kie|fal|runware|replicate):/i
async function loadTextModel(): Promise<void> {
  try {
    const models = await get<Array<{ id: string; label?: string; available?: boolean; disabled_reason?: string }>>(`/models?project=${slug.value}`)
    // Rewrite is an LLM task — drop image models (the route rejects them anyway).
    textModels.value = (models || []).filter(m => !IMAGE_MODEL_RE.test(m.id))
    if (!textModel.value) {
      textModel.value = textModels.value.find(m => m.available && !m.disabled_reason)?.id || ''
    }
  } catch { textModels.value = []; textModel.value = '' }
}

// v1.0.344 — multi-select to re-roll a CHOSEN set of scenes in ONE parallel job
// across the Mac pool (instead of N serial single-scene jobs that run one Mac
// at a time). Selection is by scene id and survives reloads.
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
/** Re-render the checked scenes as ONE parallel pool job. */
async function regenerateSelected(): Promise<void> {
  const ids = scenes.value.filter(s => selectedIds.value.has(s.id) && s.visual_prompt).map(s => s.id)
  if (!ids.length) { showError('Select at least one scene that has a prompt'); return }
  await renderContinuity({ sceneIds: ids })
  clearSelection()
}
/** Re-render every not-yet-approved scene as ONE parallel pool job. */
async function regenerateUnapproved(): Promise<void> {
  const ids = scenes.value.filter(s => !s.approved && s.visual_prompt).map(s => s.id)
  if (!ids.length) { showError('No unapproved scenes to regenerate'); return }
  if (!await ask({ title: 'Re-render unapproved scenes?', message: `Re-render all ${ids.length} unapproved scene(s) in parallel? Existing images for those scenes are replaced.`, confirmLabel: `Re-render ${ids.length}`, danger: true })) return
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

/** Ask the LLM to re-write this scene's prompt (the original generation issue).
 *  Runs as a scene-plan job; poll the plan until the prompt changes, then load
 *  it into the editor for review before the user re-renders. */
// Core: queue ONE scene's prompt rewrite and poll until the plan reflects the
// new prompt (the regenerate-prompt job shares the one-per-episode lane, so
// callers run these serially). Returns true on success. Shared by the single
// "Rewrite with AI" button and the bulk "Rewrite selected" loop.
async function rewriteOneAndWait(scene: ReviewScene): Promise<boolean> {
  const before = scene.visual_prompt
  const ep = episodeId.value
  try {
    await post(`/projects/${slug.value}/scene-plan/${episodeId.value}/regenerate-prompt`, {
      scene_id: scene.id,
      model: textModel.value,   // LLM model — NOT the image model (form.model)
    })
  } catch (e: any) {
    showError(e?.data?.detail || `Failed to start rewrite for scene ${scene.scene_index}`)
    return false
  }
  for (let i = 0; i < 40 && episodeId.value === ep; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    await loadReview()
    const fresh = scenes.value.find((s) => s.id === scene.id)
    if (fresh?.visual_prompt && fresh.visual_prompt !== before) {
      return true
    }
  }
  return false
}

async function rewritePromptAI(scene: ReviewScene): Promise<void> {
  if (!textModel.value) {
    showError('No rewrite model selected — pick one from the LLM dropdown (or set an API key / Chat Studio in Settings → Models).')
    return
  }
  rewritingId.value = scene.id
  try {
    const ok = await rewriteOneAndWait(scene)
    if (ok) {
      const fresh = scenes.value.find((s) => s.id === scene.id)
      if (fresh) editPrompt.value = fresh.visual_prompt
      success(`Prompt re-written for scene ${scene.scene_index} — review it, then Regenerate.`)
    } else {
      showError('Prompt rewrite is taking a while — check the Jobs panel; it\'ll update here when done.')
    }
  } finally {
    rewritingId.value = null
  }
}

// v1.0.360 — bulk: re-write the prompts for every SELECTED scene with the
// chosen LLM, one at a time (the rewrite job is one-per-episode). Lets the user
// fix a batch of stale/off scenes without opening each. Images are untouched —
// re-review then ⚡ Regenerate selected.
const bulkRewriting = ref(false)
const bulkRewriteProgress = ref('')
async function rewriteSelectedAI(): Promise<void> {
  if (!textModel.value) {
    showError('No rewrite model selected — pick one from the LLM dropdown first.')
    return
  }
  const targets = scenes.value.filter(s => selectedIds.value.has(s.id) && s.visual_prompt)
  if (!targets.length) { showError('Select at least one scene that has a prompt'); return }
  if (!await ask({ title: 'Rewrite selected prompts?', message: `Rewrite ${targets.length} selected scene prompt(s) with "${textModel.value}"? Existing prompts are replaced and provider usage may be charged. Images remain until regenerated.`, confirmLabel: `Rewrite ${targets.length}`, danger: true })) return
  bulkRewriting.value = true
  let done = 0
  try {
    for (const scene of targets) {
      if (!bulkRewriting.value) break   // user cancelled
      bulkRewriteProgress.value = `Rewriting ${done + 1}/${targets.length} — scene #${scene.scene_index}…`
      rewritingId.value = scene.id
      const ok = await rewriteOneAndWait(scene)
      rewritingId.value = null
      if (ok) done++
    }
    success(`Re-wrote ${done}/${targets.length} prompt(s) — review them, then ⚡ Regenerate selected.`)
  } finally {
    bulkRewriting.value = false
    bulkRewriteProgress.value = ''
    rewritingId.value = null
  }
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
  if (!episodeId.value) {
    plan.value = null
    scenes.value = []
    audioPath.value = null
    stats.value = null
    promptIntegrity.value = null
    subtitleIntegrity.value = null
    return
  }
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
    const r = await get<ReviewResponse>(`/projects/${slug.value}/scene-review/${episodeId.value}`)
    plan.value = r.scene_plan
    scenes.value = r.scenes
    audioPath.value = r.audio_path
    stats.value = r.stats
    promptIntegrity.value = r.prompt_integrity || null
    subtitleIntegrity.value = r.subtitle_integrity || null
    renderStatus.value = r.render_status || null
    activeRenderJobFromReview.value = r.active_render_job || null
  } catch (e: any) {
    if (e?.__slugRace) return
  } finally {
    loading.value = false
  }
}

// ── Actions ─────────────────────────────────────────────────────────
async function generateOne(scene: ReviewScene): Promise<void> {
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
        prompt_only: promptOnly.value,
        ...localSizeBody.value,
      })
      success(`${scene.image_filename ? 'Regeneration' : 'Generation'} queued for scene ${scene.scene_index} — it'll update above.`)
    } else {
      await post(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-image`, {
        scene_id: scene.id,
        model: form.value.model,
        aspect_ratio: form.value.aspect_ratio,
        ...localSizeBody.value,
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

async function repairOne(scene: ReviewScene): Promise<void> {
  if (!form.value.model) {
    showError('Pick a model in the Greenlight panel before repairing')
    return
  }
  regeneratingId.value = scene.id
  try {
    const r = await post<{ recovered?: boolean; queued?: boolean }>(`/projects/${slug.value}/scene-review/${episodeId.value}/repair-image/${scene.id}`, {
      model: form.value.model,
      aspect_ratio: form.value.aspect_ratio,
      prompt_only: promptOnly.value,
      ...localSizeBody.value,
    })
    if (r.recovered) {
      success(`Recovered scene ${scene.scene_index} from the existing provider task.`)
      cacheBuster.value = Date.now()
      await loadReview()
    } else {
      success(`Repair queued for scene ${scene.scene_index} — it'll update above.`)
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to repair scene image')
  } finally {
    regeneratingId.value = null
  }
}

// v1.0.232 — set a scene's image directly from an uploaded file (e.g. a free
// image from the web) instead of generating it.
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
  if (!canBulkGenerate.value) return
  const ep = episodeId.value
  bulkQueuingEpisode.value = ep
  try {
    const r = await post<{ queued: number; skipped: number }>(
      `/projects/${slug.value}/scene-review/${ep}/generate-missing`,
      { model: form.value.model, aspect_ratio: form.value.aspect_ratio, ...localSizeBody.value },
    )
    success(`Queued ${r.queued} job${r.queued === 1 ? '' : 's'} (${r.skipped} skipped)`)
    // Re-load every 4s while images are landing.
    await pollUntilAllPresent(ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue bulk gen')
  } finally {
    if (bulkQueuingEpisode.value === ep) bulkQueuingEpisode.value = null
  }
}

// v1.0.194 — continuity-chain sequential render. The "Render sequentially"
// button only shows for continuity-chain projects.
const isContinuity = ref(false)
const renderingEpisode = ref<string | null>(null)
const continuityRendering = computed(() => renderingEpisode.value === episodeId.value)

async function loadContinuityFlag(): Promise<void> {
  try {
    const fmt = await get<{ visualSource?: string }>(`/projects/${slug.value}/effective-format`)
    isContinuity.value = fmt?.visualSource === 'continuity-chain'
  } catch { isContinuity.value = false }
}

async function renderContinuity(opts: { force?: boolean; fromSceneId?: string; independent?: boolean; sceneIds?: string[] } = {}): Promise<void> {
  if (!sceneInputsComplete.value) {
    showError('Complete subtitles and repair every missing or duplicated prompt before rendering images.')
    return
  }
  if (!form.value.model) { showError('Pick a model in the Greenlight panel first'); return }
  const selection = opts.sceneIds && opts.sceneIds.length ? opts.sceneIds : undefined
  // A full force-re-render of EVERY scene needs a confirm; an explicit selection
  // is already a deliberate choice, so it doesn't.
  if (opts.force && !selection) {
    const msg = opts.independent
      ? 'Re-render EVERY scene in parallel from scratch? This discards the current renders (style + sheet only, no previous-render continuity).'
      : 'Re-render EVERY scene from scratch? This discards the current renders and runs the full sequential chain again.'
    if (!await ask({ title: 'Re-render every scene?', message: msg, confirmLabel: 'Re-render all', danger: true })) return
  }
  const ep = episodeId.value
  renderingEpisode.value = ep
  try {
    await post(`/projects/${slug.value}/scene-review/${ep}/continuity-render`, {
      model: form.value.model,
      aspect_ratio: form.value.aspect_ratio,
      force: !!opts.force,
      from_scene_id: opts.fromSceneId,
      // A selection always renders in parallel (one job across the pool).
      independent: !!opts.independent || !!selection,
      scene_ids: selection,
      concurrency: (opts.independent || selection) ? form.value.concurrency : undefined,
      prompt_only: promptOnly.value,
      ...localSizeBody.value,
    })
    success(selection
      ? `Queued ${selection.length} scene(s) to re-render in parallel across the pool (${form.value.concurrency === 'auto' ? 'auto — matches online Macs' : '×' + form.value.concurrency}) — watch the Jobs panel.`
      : opts.independent
        ? `Parallel render queued (${form.value.concurrency === 'auto' ? 'auto — matches online servers' : '×' + form.value.concurrency})${promptOnly.value ? ', prompt only (text2img)' : ' — using style + character sheet'}. Watch the Jobs panel; images land as each finishes.`
        : opts.fromSceneId
          ? 'Re-rendering from this scene onward — watch the Jobs panel.'
          : 'Continuity render queued — watch the Jobs panel. It renders scene-by-scene and can take a while.')
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
const reviewJobActive = computed(() => isJobActiveFor(episodeId.value, ['scene_image_generate']))
const activeRenderJob = computed(() => {
  const code = episodeId.value
  if (!code) return null
  const fromReview = activeRenderJobFromReview.value
  if (fromReview && fromReview.episode_id === code && (fromReview.status === 'running' || fromReview.status === 'queued')) {
    return fromReview
  }
  return (jobs.value || []).find((j: any) =>
    j.episode_id === code
    && ['continuity_render', 'images', 'scene_images', 'thumb_images'].includes(j.type)
    && (j.status === 'running' || j.status === 'queued'),
  ) || null
})
const activeContinuityRenderJob = computed(() => {
  const code = episodeId.value
  if (!code) return null
  const fromReview = activeRenderJobFromReview.value
  if (fromReview && fromReview.episode_id === code && fromReview.type === 'continuity_render' && (fromReview.status === 'running' || fromReview.status === 'queued')) {
    return fromReview
  }
  return (jobs.value || []).find((j: any) =>
    j.episode_id === code
    && j.type === 'continuity_render'
    && (j.status === 'running' || j.status === 'queued'),
  ) || null
})
const isRendering = computed(() => !!activeRenderJob.value)
const renderProgress = computed<number | null>(() => {
  const p = (activeRenderJob.value as any)?.progress
  return typeof p === 'number' ? p : null
})
/** scene_index the active job is currently rendering, parsed from its log. */
const renderingSceneIndex = computed<number | null>(() => {
  const lines = (activeRenderJob.value as any)?.output_lines as string[] | undefined
  if (!lines?.length) return null
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/Scene\s+(\d+)\s*\/\s*\d+/i)
    if (m) return parseInt(m[1]!, 10)
  }
  return null
})
const renderingSceneId = computed<string | null>(() => {
  if (!isRendering.value) return null
  const idx = renderingSceneIndex.value
  if (idx != null) {
    const s = scenes.value.find(sc => sc.scene_index === idx)
    if (s) return s.id
  }
  // Fallback: the first scene still missing an image (sequential render).
  return scenes.value.find(s => !s.image_filename)?.id ?? null
})
// Scenes currently in-flight in parallel mode (by scene_index from the sidecar).
const parallelInFlight = computed<Set<number>>(() => {
  const s = renderStatus.value
  if (!s?.active || s.mode !== 'independent' || !Array.isArray(s.in_flight)) return new Set()
  return new Set(s.in_flight)
})
function isSceneGenerating(scene: ReviewScene): boolean {
  if (regeneratingId.value === scene.id) return true
  if (parallelInFlight.value.has(scene.scene_index)) return true
  // Sequential mode: only the single chained scene shows the spinner.
  return renderStatus.value?.mode !== 'independent' && renderingSceneId.value === scene.id
}

async function cancelActiveRender(): Promise<void> {
  const job = activeContinuityRenderJob.value as any
  if (!job?.job_id) return
  const label = job.status === 'queued' ? 'queued render' : 'active render'
  if (!await ask({ title: 'Stop scene render?', message: `Stop this ${label}? Finished scene images stay on disk, and you can resume later.`, confirmLabel: 'Stop render', danger: true })) return
  cancelingRender.value = true
  try {
    await del(`/projects/${slug.value}/jobs/${job.job_id}`)
    success('Continuity render stopped. Completed images were kept.')
    activeRenderJobFromReview.value = null
    cacheBuster.value = Date.now()
    await loadReview()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to stop render')
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
    cacheBuster.value = Date.now()
    if (stats.value && stats.value.with_image >= stats.value.total_scenes) return
  }
}

async function approveOne(scene: ReviewScene, approved: boolean): Promise<void> {
  approvingId.value = scene.id
  try {
    const r = await put<{ stats: ReviewStats }>(
      `/projects/${slug.value}/scene-review/${episodeId.value}/approve`,
      { scene_id: scene.id, approved },
    )
    scene.approved = approved
    if (r.stats) stats.value = r.stats
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
  void loadReview()
  void loadContinuityFlag()
  void loadTextModel()    // resolves the LLM model used by "Rewrite with AI"
  void srPresets.load()   // auto-applies the last render preset (model, aspect, pool)
  if (typeof window !== 'undefined') window.addEventListener('keydown', onPreviewKey)
  const el = getScrollContainer()
  if (el) {
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }
})
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onPreviewKey)
  const el = getScrollContainer()
  if (el) el.removeEventListener('scroll', onScroll)
})
watch(episodeId, () => { void loadReview() })
</script>

<style scoped>
.review-workspace {
  --review-gold: #f0c66a;
  --review-green: #53c786;
  --review-ink: #101710;
  padding-bottom: 72px;
}
.review-hero {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin: 14px 0 18px;
  padding: 26px 30px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--review-gold) 30%, var(--border));
  border-radius: 18px;
  background:
    radial-gradient(circle at 88% 15%, rgba(240, 198, 106, .18), transparent 30%),
    linear-gradient(135deg, #17241c 0%, #132019 52%, #1e241b 100%);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .18);
}
.review-hero::after {
  content: '';
  position: absolute;
  width: 240px;
  height: 240px;
  right: -110px;
  bottom: -170px;
  border: 1px solid rgba(240, 198, 106, .22);
  border-radius: 50%;
}
.review-hero-copy { position: relative; z-index: 1; max-width: 760px; }
.review-hero :deep(.breadcrumb) { margin-bottom: 13px; opacity: .7; }
.review-eyebrow {
  display: block;
  margin-bottom: 5px;
  color: var(--review-gold);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .15em;
  text-transform: uppercase;
}
.review-hero h1 { margin: 0; color: #fff8e9; font-size: clamp(28px, 3vw, 42px); letter-spacing: -.035em; }
.review-hero p { margin: 8px 0 0; max-width: 700px; color: rgba(244, 247, 242, .7); font-size: 14px; line-height: 1.55; }
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
  border: 1px solid rgba(255,255,255,.2);
  border-radius: 50%;
  color: rgba(255,255,255,.55);
  font-size: 11px;
  font-weight: 800;
}
.review-hero-route span.is-complete { border-color: var(--review-green); background: var(--review-green); color: var(--review-ink); }
.review-hero-route span.is-current { border-color: var(--review-gold); color: var(--review-gold); box-shadow: 0 0 0 4px rgba(240,198,106,.1); }
.review-hero-route b { color: rgba(255,255,255,.58); font-size: 11px; font-weight: 600; }
.review-hero-route i { height: 1px; background: rgba(255,255,255,.14); }

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
.sr-status-kicker { color: var(--review-gold); font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
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
.sr-status-orb span { margin-top: 4px; color: var(--text-muted); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
.sr-status-orb.ready { border-color: color-mix(in srgb, var(--review-green) 55%, var(--border)); background: color-mix(in srgb, var(--review-green) 10%, transparent); }
.sr-status-orb.ready strong { color: var(--review-green); }
.sr-progress-track { height: 4px; margin: 0 22px 2px; overflow: hidden; border-radius: 999px; background: var(--bg-tertiary); }
.sr-progress-track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--review-gold), var(--review-green)); transition: width .35s ease; }
.sr-control-section { padding: 17px 22px; border-top: 1px solid var(--border); }
.sr-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 13px; }
.sr-section-heading > div { display: flex; align-items: center; gap: 9px; }
.sr-section-heading span { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 7px; background: color-mix(in srgb, var(--review-gold) 13%, var(--bg-tertiary)); color: var(--review-gold); font-size: 9px; font-weight: 800; }
.sr-section-heading strong { font-size: 13px; }
.sr-section-heading small { color: var(--text-muted); font-size: 11px; }
.sr-settings-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(130px, 1fr));
  gap: 12px;
  align-items: end;
}
.sr-actions-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.sr-actions-grid .btn { min-height: 34px; border-radius: 8px; }

.sr-model-pick { min-width: 0; grid-column: span 2; }

.sr-ratio-pick, .sr-llm-pick { display: flex; min-width: 0; flex-direction: column; align-items: stretch; gap: 6px; }
.sr-llm-pick { grid-column: span 2; }
.sr-ratio-label {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 750;
  text-transform: uppercase;
  letter-spacing: .07em;
}
.sr-ratio-select, .sr-conc-select, .sr-size-select, .sr-llm-select { width: 100%; min-width: 0; }
.sr-llm-label { color: var(--text-muted); font-size: 10px; font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }

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
  font-size: 10px;
  line-height: 1.4;
  border: 1px solid currentColor;
  border-radius: 3px;
  opacity: 0.7;
}
/* Row-head badge + thumbnail corner flag. */
.review-stale-badge {
  font-size: 11px;
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

/* v1.0.360 — Rewrite-LLM picker in the toolbar. */
.sr-llm-pick { display: inline-flex; align-items: center; gap: 6px; }
.sr-llm-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.sr-llm-select { font-size: 12px; max-width: 220px; }
.sr-lb-prompt { display: flex; flex-direction: column; gap: 4px; }
.sr-lb-prompt-label { font-size: 11px; color: rgba(255, 255, 255, 0.55); }
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
.review-thumb-generating small { font-size: 11px; }
.review-thumb-overlay {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: var(--radius-sm, 6px);
  color: #fff;
  pointer-events: none;
}
.review-thumb-overlay small { font-size: 11px; }
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
.review-live-toggle {
  margin-left: auto;
  background: none; border: 1px solid var(--border); border-radius: 6px;
  padding: 2px 10px; font-size: 11.5px; color: var(--text-secondary); cursor: pointer;
}
.review-live-toggle:hover { color: var(--text-primary); border-color: var(--text-secondary); }
.review-stop-btn {
  background: rgba(220, 80, 80, 0.16);
  border: 1px solid rgba(220, 80, 80, 0.55);
  border-radius: 6px;
  color: #ffb3b3;
  padding: 3px 10px;
  font-size: 11.5px;
  cursor: pointer;
}
.review-stop-btn:hover:not(:disabled) { background: rgba(220, 80, 80, 0.26); color: #ffd0d0; }
.review-stop-btn:disabled { opacity: 0.6; cursor: default; }

/* "Now rendering — these images are feeding in" preview panel */
.review-live-panel {
  padding: 12px 14px;
  border: 1px solid rgba(240, 180, 41, 0.4);
  background: rgba(240, 180, 41, 0.06);
  border-radius: var(--radius-md, 8px);
}
.review-live-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13.5px; }
.review-live-head em { font-style: normal; color: var(--accent, #f0b429); font-weight: 600; }
.review-live-prompt { margin: 8px 0 10px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; font-style: italic; }
.review-live-flow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.review-live-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.review-live-ref {
  margin: 0; width: 84px; display: flex; flex-direction: column; gap: 4px; align-items: center;
}
.review-live-ref img {
  width: 84px; height: 84px; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-tertiary);
  animation: sr-pulse 1.6s ease-in-out infinite;
}
@keyframes sr-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(240,180,41,0.0); } 50% { box-shadow: 0 0 0 3px rgba(240,180,41,0.35); } }
.review-live-ref figcaption { font-size: 10px; color: var(--text-muted); text-align: center; line-height: 1.25; max-width: 84px; }
.review-live-arrow { font-size: 22px; color: var(--accent, #f0b429); }
.review-live-out {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  width: 84px; height: 84px; border-radius: 6px;
  border: 1px dashed rgba(240, 180, 41, 0.6); background: rgba(240, 180, 41, 0.08);
}
.review-live-out small { font-size: 10px; color: var(--text-secondary); }

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
  font-size: 11.5px; padding: 3px 9px; border-radius: 999px;
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
  font-size: 11px;
  cursor: pointer;
  text-align: center;
  padding: 4px;
}
.review-thumb-empty:hover { border-color: var(--accent); color: var(--accent); }

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

@media (max-width: 1220px) {
  .review-command-bar :deep(.top-action-bar) { grid-template-columns: 1fr; align-items: stretch; }
  .review-command-bar :deep(.generate-region) { justify-content: flex-start; }
  .sr-settings-grid { grid-template-columns: repeat(2, minmax(180px, 1fr)); }
}
@media (max-width: 900px) {
  .review-hero { align-items: flex-start; flex-direction: column; padding: 22px; }
  .review-hero-route { display: none; }
  .review-scene-row { grid-template-columns: 150px minmax(0, 1fr); }
  .review-thumb-cell, .review-thumb, .review-thumb-empty { width: 150px; }
  .review-actions-cell { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; }
  .review-actions-cell .btn { justify-content: center; }
}
@media (max-width: 640px) {
  .review-hero { border-radius: 14px; }
  .review-command-bar :deep(.top-action-bar) { padding: 12px; }
  .sr-greenlight-head, .sr-section-heading { align-items: flex-start; flex-direction: column; }
  .sr-status-orb { width: 100%; min-height: 48px; }
  .sr-settings-grid { grid-template-columns: 1fr; }
  .sr-model-pick, .sr-llm-pick { grid-column: auto; }
  .review-scene-row { grid-template-columns: 1fr; }
  .review-thumb-cell, .review-thumb, .review-thumb-empty { width: 100%; }
  .back-to-top { right: 16px; bottom: 16px; }
}
</style>
