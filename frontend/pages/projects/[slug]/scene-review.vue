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
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Scene Review</h1>
    </div>

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="episodeId"
      filter-field="script"
      generate-label="Generate all missing"
      loading-label="Queuing…"
      :generate-loading="bulkQueuing"
      :generate-disabled="!canBulkGenerate"
      :generate-status="bulkStatus"
      @generate="generateAllMissing"
    />

    <p class="text-muted mt-1 mb-2">
      Per-scene preview against the transcript + merged audio. Approve
      each scene before final assembly is allowed. Greenlight unlocks
      Video Assembly once every scene has both an image AND your
      approval.
    </p>

    <!-- Greenlight panel -->
    <section v-if="stats" class="card mt-3" :class="{ 'is-greenlit': stats.all_approved }">
      <div class="flex justify-between items-center sr-greenlight-head">
        <div>
          <h3 v-if="stats.all_approved">✅ Greenlit — ready for Video Assembly</h3>
          <h3 v-else>{{ stats.approved }} / {{ stats.total_scenes }} approved
            <span class="text-muted text-sm">
              ({{ stats.with_image }} with images,
              {{ stats.total_scenes - stats.with_image }} missing)
            </span>
          </h3>
        </div>
        <div class="flex gap-2 sr-toolbar">
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
            :disabled="!form.model || continuityRendering"
            @click="renderContinuity()"
            title="SEQUENTIAL — render every scene in order, each anchored to the PREVIOUS render + your character sheet/characters. Best frame-to-frame continuity, but slow (one scene at a time). Resumes where it left off. Runs in the Jobs panel."
          >
            🎬 Render sequentially
          </button>
          <button
            v-if="isContinuity && stats.with_image > 0"
            class="btn btn-sm btn-ghost"
            :disabled="!form.model || continuityRendering"
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
            :disabled="!form.model || continuityRendering"
            @click="renderContinuity({ independent: true })"
            title="PARALLEL — render scenes concurrently using ONLY the style image + character sheet/characters (no previous-render reference). Much faster, but loses frame-to-frame continuity. Fills in any scene that's still missing an image."
          >
            ⚡ Render in parallel
          </button>
          <button
            v-if="isContinuity && stats.with_image > 0"
            class="btn btn-sm btn-ghost"
            :disabled="!form.model || continuityRendering"
            @click="renderContinuity({ independent: true, force: true })"
            title="Re-render ALL scenes in parallel from scratch (style + sheet only, no prev-render). Fast bulk re-roll."
          >
            ⚡↻ Re-render all (parallel)
          </button>
        </div>
      </div>
    </section>

    <!-- v1.0.244 — Scene Review render preset. Remembers the image model +
         aspect ratio + parallel pool size and auto-applies them on load, so you
         don't re-pick the model every visit. -->
    <PresetPicker
      v-if="stats"
      label="Render preset"
      hint="Saves the image model, aspect ratio, and parallel pool size. Auto-applies your last preset on load; Save as… to capture the current pick."
      :presets="srPresets.presets.value"
      :active-id="srPresets.activeId.value"
      :current-machine-label="srPresets.machineLabel.value"
      :show-all-devices="srPresets.showAllDevices.value"
      :cross-device-count="srPresets.crossDeviceCount.value"
      :active-preset-is-cross-device="srPresets.activePresetIsCrossDevice.value"
      :active-preset-machine-label="srPresets.activePresetMachineLabel.value"
      @update:active-id="srPresets.setActive"
      @update:show-all-devices="(v) => srPresets.showAllDevices.value = v"
      @apply="srPresets.applyActive(); success('Render preset applied')"
      @overwrite="srPresets.overwrite(); success('Render preset saved')"
      @save-as="(n) => srPresets.saveAs(n).then(() => success(`Saved: ${n}`))"
      @delete="srPresets.remove(); success('Render preset deleted')"
    />

    <section v-else-if="!plan && !loading" class="card mt-3">
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

      <!-- v1.0.245 — Plan-health banner. Flags broken scenes (no prompt,
           over-long, planner fallback) so you don't scroll hundreds to find
           them. Click to jump; fixing happens on the Scene Plan page (re-plan
           needs an LLM model, which lives there). -->
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
          <div class="review-thumb-cell">
            <template v-if="scene.image_filename">
              <img
                :src="imageUrl(scene)"
                :key="imageKey(scene)"
                :alt="`Scene ${scene.scene_index}`"
                class="review-thumb"
                :style="{ aspectRatio: thumbAspect }"
                title="Click to preview full size"
                @click="openPreview(scene)"
              />
              <!-- Re-render overlay (force / from-here / per-scene regen). -->
              <div v-if="isSceneGenerating(scene)" class="review-thumb-overlay">
                <span class="review-spinner" aria-hidden="true" />
                <small>Rendering…</small>
              </div>
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
              :title="!form.model ? 'Pick a model in the Greenlight panel first' : (isContinuity ? 'Render JUST this scene with its references (character sheet + style + previous render). One click, no re-chaining.' : 'Generate / regenerate just this image (resets approval)')"
            >
              {{ regeneratingId === scene.id ? '⏳' : (isContinuity ? '🎬' : '↻') }}
              {{ isContinuity ? 'Generate (refs)' : 'Regenerate' }}
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
              :disabled="!form.model || continuityRendering"
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
    <div
      v-if="previewScene"
      class="sr-lightbox"
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
          <strong>Scene #{{ previewScene.scene_index }}</strong>
          <span class="text-muted">{{ previewScene.start_sec.toFixed(1) }}s → {{ previewScene.end_sec.toFixed(1) }}s</span>
          <span v-if="previewScene.approved" class="sr-lb-approved">✓ Approved</span>
          <span class="sr-lb-actions">
            <button class="btn btn-sm btn-ghost" @click.stop="seekTo(previewScene.start_sec)" title="Jump the audio player to this scene">▶ Play from here</button>
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
const { get, post, put } = useApi()
const { success, error: showError } = useToast()

const episodeId = ref('')

interface ReviewScene {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  transcript_segment: string
  visual_prompt: string
  approved: boolean
  image_filename: string | null
  boundary_reason?: string
}
interface ReviewStats {
  total_scenes: number
  approved: number
  with_image: number
  all_approved: boolean
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
const loading = ref(false)
const renderStatus = ref<RenderStatus | null>(null)
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
// visit. Device-aware, same PresetPicker pattern as the Scene Plan page.
const srPresets = usePresets<{ model: string; aspect_ratio: string; concurrency: number }>({
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
  const base = LOCAL_ASPECT_PRESETS[form.value.aspect_ratio] || LOCAL_ASPECT_PRESETS['1:1']
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

// ── v1.0.245 — Plan health detection (same rules as the Scene Plan page) ──
// Surface broken scenes so they're findable without scrolling: no visual
// prompt, suspiciously long (normal scenes are ≤8–12s), or a planner fallback.
const OVERLONG_SEC = 20
const problemScenes = computed(() => {
  const list: Array<{ scene: ReviewScene; index: number; reasons: string[] }> = []
  scenes.value.forEach((s, i) => {
    const reasons: string[] = []
    const dur = s.end_sec - s.start_sec
    if (!s.visual_prompt || !s.visual_prompt.trim()) reasons.push('no prompt')
    if (dur > OVERLONG_SEC) reasons.push(`${dur.toFixed(0)}s long`)
    if (s.boundary_reason && /^auto-(filled|split)/.test(s.boundary_reason)) reasons.push('planner fallback')
    if (reasons.length) list.push({ scene: s, index: s.scene_index ?? i + 1, reasons })
  })
  return list
})
const problemIds = computed(() => new Set(problemScenes.value.map(p => p.scene.id)))
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
  return stats.value.total_scenes > stats.value.with_image
})
const bulkStatus = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!form.value.model) return 'Pick a model'
  if (!stats.value) return ''
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
  if (e.key === 'Escape') { closePreview(); e.preventDefault() }
  else if (e.key === 'ArrowLeft') { stepPreview(-1); e.preventDefault() }
  else if (e.key === 'ArrowRight') { stepPreview(1); e.preventDefault() }
}
// Keep the open preview pointed at the freshest scene object after reloads
// (e.g. when its approval flips or a parallel render lands its image).
watch(scenes, (list) => {
  if (!previewScene.value) return
  const fresh = list.find(s => s.id === previewScene.value!.id)
  if (fresh) previewScene.value = fresh
})

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
    }
    const r = await get<ReviewResponse>(`/projects/${slug.value}/scene-review/${episodeId.value}`)
    plan.value = r.scene_plan
    scenes.value = r.scenes
    audioPath.value = r.audio_path
    stats.value = r.stats
    renderStatus.value = r.render_status || null
  } catch (e: any) {
    if (e?.__slugRace) return
  } finally {
    loading.value = false
  }
}

// ── Actions ─────────────────────────────────────────────────────────
async function generateOne(scene: ReviewScene): Promise<void> {
  if (!form.value.model) {
    showError('Pick a model in the Greenlight panel before regenerating')
    return
  }
  const ep = episodeId.value
  regeneratingId.value = scene.id
  try {
    if (isContinuity.value) {
      // v1.0.232 — single-scene continuity render: just THIS scene, with the
      // full reference stack (character sheet + style + characters + the
      // previous scene's render). One click, auto-referenced.
      await post(`/projects/${slug.value}/scene-review/${episodeId.value}/continuity-render`, {
        model: form.value.model,
        aspect_ratio: form.value.aspect_ratio,
        single_scene_id: scene.id,
        prompt_only: promptOnly.value,
        ...localSizeBody.value,
      })
      success(`Rendering scene ${scene.scene_index} ${promptOnly.value ? '(prompt only)' : 'with its references'} — it'll update above.`)
      // The active-render auto-refresh picks it up + shows the spinner.
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

async function renderContinuity(opts: { force?: boolean; fromSceneId?: string; independent?: boolean } = {}): Promise<void> {
  if (!form.value.model) { showError('Pick a model in the Greenlight panel first'); return }
  if (opts.force) {
    const msg = opts.independent
      ? 'Re-render EVERY scene in parallel from scratch? This discards the current renders (style + sheet only, no previous-render continuity).'
      : 'Re-render EVERY scene from scratch? This discards the current renders and runs the full sequential chain again.'
    if (!confirm(msg)) return
  }
  const ep = episodeId.value
  renderingEpisode.value = ep
  try {
    await post(`/projects/${slug.value}/scene-review/${ep}/continuity-render`, {
      model: form.value.model,
      aspect_ratio: form.value.aspect_ratio,
      force: !!opts.force,
      from_scene_id: opts.fromSceneId,
      independent: !!opts.independent,
      concurrency: opts.independent ? form.value.concurrency : undefined,
      prompt_only: promptOnly.value,
      ...localSizeBody.value,
    })
    success(opts.independent
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
const { jobs } = useJobs()
const activeRenderJob = computed(() => {
  const code = episodeId.value
  if (!code) return null
  return (jobs.value || []).find((j: any) =>
    j.episode_id === code
    && ['continuity_render', 'images', 'scene_images', 'thumb_images'].includes(j.type)
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

onMounted(() => {
  void loadReview()
  void loadContinuityFlag()
  void srPresets.load()   // auto-applies the last render preset (model, aspect, pool)
  if (typeof window !== 'undefined') window.addEventListener('keydown', onPreviewKey)
})
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onPreviewKey)
})
watch(episodeId, () => { void loadReview() })
</script>

<style scoped>
/* Constrain the image-model picker so it sits inline with the toolbar
   buttons instead of stretching to full width. */
.sr-model-pick { min-width: 220px; max-width: 340px; flex: 0 1 300px; }

/* Inline aspect-ratio picker — sits left of the model picker in the toolbar. */
.sr-ratio-pick { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.sr-ratio-label {
  font-size: 11px; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.sr-ratio-select { width: auto; min-width: 150px; }
.sr-conc-select { min-width: 64px; }
.sr-size-select { min-width: 170px; }
/* v1.0.262 — let the greenlight toolbar wrap instead of overflowing the panel
   when many controls are present (Aspect + Parallel + Mode + Size + model +
   action buttons). The header wraps the controls block below the heading, and
   the controls block wraps its own items, on narrow widths. */
.sr-greenlight-head { flex-wrap: wrap; gap: 12px; }
.sr-toolbar { flex-wrap: wrap; align-items: center; row-gap: 8px; justify-content: flex-end; }

/* ── Click-to-preview lightbox (v1.0.241) ──────────────────────────── */
.sr-lightbox {
  position: fixed; inset: 0; z-index: 1000;
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
  max-height: calc(100vh - 130px);
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  background: var(--bg-secondary);
}
.sr-lb-cap {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center;
  color: #fff; font-size: 13px;
}
.sr-lb-cap .text-muted { color: rgba(255, 255, 255, 0.6); }
.sr-lb-approved { color: #5bb37c; font-weight: 600; }
.sr-lb-actions { display: flex; gap: 8px; margin-left: 6px; }
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
</style>
