<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Motion Review <span class="optional-badge">Optional</span></h1>
    </div>

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="episodeId"
      filter-field="scene_review"
      :presets="motionPresets"
      generate-label="Generate missing clips"
      loading-label="Queuing clips..."
      :generate-loading="queuing || clipJobsActive"
      :generate-disabled="!canGenerate"
      :generate-status="generateStatus"
      @generate="generateMissing"
    />

    <div class="motion-intro mt-2">
      <div>
        <strong>Optional pass 2: image to video</strong>
        <p>Skip this page when a video should use still images. Scene timing stays locked; choosing a clip only replaces the still inside the same timestamp window.</p>
      </div>
      <NuxtLink :to="`/projects/${slug}/scene-review`" class="btn btn-sm btn-secondary">Back to image review</NuxtLink>
    </div>

    <div class="external-motion-note mt-2">
      <strong>Using an external Chrome extension?</strong>
      Generate the image-to-video result there, then use <b>Upload external MP4</b> on the matching scene below. Story Studio saves it with the correct scene ID for you. Click <b>Use clip</b> after reviewing it; otherwise assembly keeps the still. Long clips are trimmed to the planned scene window, short clips hold their final frame, and clip audio is discarded in favor of narration.
    </div>

    <section v-if="stats" class="card mt-3" :class="{ 'motion-ready': stats.all_motion_reviewed }">
      <div class="motion-summary">
        <div>
          <h3>{{ stats.motion_reviewed }} / {{ stats.total_scenes }} motion decisions</h3>
          <p class="text-muted text-sm">{{ stats.with_clip }} clips available. Every scene can use an approved clip or intentionally remain a still.</p>
        </div>
        <div class="motion-tools">
          <label class="model-field">
            <span>Image-to-video model</span>
            <select v-model="videoModel" class="select">
              <option value="" disabled>Pick an image-to-video model...</option>
              <option v-for="model in i2vModels" :key="model.id" :value="model.id">{{ model.label }}</option>
            </select>
          </label>
          <button class="btn btn-sm btn-secondary" :disabled="savingAll || stats.with_clip === 0" @click="approveAllClips">
            Approve all fresh clips
          </button>
          <button class="btn btn-sm btn-ghost" :disabled="savingAll" @click="keepAllStills">Keep all as stills</button>
        </div>
      </div>
    </section>

    <section v-if="!episodeId" class="card mt-3 empty-state">Pick an episode to review motion.</section>
    <section v-else-if="loading" class="card mt-3 empty-state">Loading motion pass...</section>
    <section v-else-if="!scenes.length" class="card mt-3 empty-state">
      No scene plan is available yet. Complete Scene Plan and Scene Review first.
    </section>

    <ul v-else class="motion-grid mt-3">
      <li v-for="scene in scenes" :key="scene.id" class="motion-card" :class="`choice-${scene.motion_choice || (scene.clip_exists ? 'legacy' : 'pending')}`">
        <div class="media-pair">
          <div class="media-box">
            <span class="media-label">Approved image</span>
            <img v-if="scene.image_filename" :src="imageUrl(scene)" :alt="`Scene ${scene.scene_index}`" />
            <div v-else class="missing-media">Image missing</div>
          </div>
          <div class="media-box">
            <span class="media-label">Motion result</span>
            <video v-if="scene.clip_exists" :src="clipUrl(scene)" controls loop preload="metadata" />
            <div v-else class="missing-media">No clip yet</div>
          </div>
        </div>

        <div class="motion-copy">
          <div class="scene-line">
            <strong>Scene {{ scene.scene_index }}</strong>
            <span>{{ scene.start_sec.toFixed(1) }}s to {{ scene.end_sec.toFixed(1) }}s</span>
            <span class="choice-badge">{{ choiceLabel(scene) }}</span>
          </div>
          <p class="transcript">{{ scene.transcript_segment }}</p>
          <details open>
            <summary>Motion direction</summary>
            <p class="motion-prompt">{{ scene.motion_prompt || 'No motion prompt. Add one in Scene Plan, or keep this scene as a still.' }}</p>
          </details>
          <p v-if="scene.clip_stale" class="stale-note">The motion direction changed after this clip was generated. Re-generate before approval.</p>
        </div>

        <div class="motion-actions">
          <button
            class="btn btn-sm btn-secondary"
            :disabled="uploadingId === scene.id || animatingId === scene.id"
            @click="uploadClipOne(scene)"
          >{{ uploadingId === scene.id ? 'Uploading...' : 'Upload external MP4' }}</button>
          <button
            class="btn btn-sm btn-secondary"
            :disabled="!videoModel || !scene.image_filename || !scene.motion_prompt || animatingId === scene.id"
            @click="generateOne(scene)"
          >{{ animatingId === scene.id ? 'Queuing...' : (scene.clip_exists ? 'Re-generate clip' : 'Generate clip') }}</button>
          <button
            class="btn btn-sm btn-primary"
            :disabled="!scene.clip_exists || scene.clip_stale || savingId === scene.id"
            @click="setChoice(scene, 'clip')"
          >Use clip</button>
          <button class="btn btn-sm btn-ghost" :disabled="savingId === scene.id" @click="setChoice(scene, 'still')">Use still</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Motion Review')

type MotionChoice = 'pending' | 'clip' | 'still'
interface MotionScene {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  transcript_segment: string
  motion_prompt?: string
  approved: boolean
  image_filename: string | null
  clip_exists?: boolean
  clip_stale?: boolean
  motion_choice?: MotionChoice
}
interface MotionStats {
  total_scenes: number
  approved: number
  with_image: number
  with_clip: number
  motion_reviewed: number
  all_motion_reviewed: boolean
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const episodeId = ref('')
const { config } = useProject()
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { isJobActiveFor } = useJobs()
const scenes = ref<MotionScene[]>([])
const stats = ref<MotionStats | null>(null)
const loading = ref(false)
const queuing = ref(false)
const savingAll = ref(false)
const savingId = ref<string | null>(null)
const animatingId = ref<string | null>(null)
const uploadingId = ref<string | null>(null)
const videoModel = ref('')
const cacheBuster = ref(Date.now())
const motionPresets = usePresets({
  slug: slug.value,
  configKey: 'motion_review',
  presetType: 'motion-review',
  snapshot: () => ({ model: videoModel.value, aspect_ratio: '16:9' }),
  apply: (data: any) => { if (typeof data?.model === 'string') videoModel.value = data.model },
})

const i2vModels = computed(() => Object.entries((config.value as any)?.video_models || {})
  .filter(([, model]: [string, any]) => Array.isArray(model?.modes) && model.modes.includes('frames'))
  .map(([id, model]: [string, any]) => ({ id, label: model.label || id })))
watch(i2vModels, (models) => {
  if (!videoModel.value && models.length) videoModel.value = models[0]!.id
}, { immediate: true })

const clipJobsActive = computed(() => isJobActiveFor(episodeId.value, ['scene_clip_generate', 'scene_clips_batch']))
const canGenerate = computed(() => !!episodeId.value && !!videoModel.value && scenes.value.some(scene =>
  scene.approved && scene.image_filename && scene.motion_prompt && (!scene.clip_exists || scene.clip_stale),
))
const generateStatus = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!i2vModels.value.length) return 'Add an image-to-video model in Settings first'
  if (!videoModel.value) return 'Pick an image-to-video model'
  if (!canGenerate.value) return 'No approved images are waiting for motion'
  return 'Only approved images are sent to image-to-video'
})

function imageUrl(scene: MotionScene) {
  return `/api/projects/${slug.value}/scene-review/${episodeId.value}/image/${scene.id}?t=${cacheBuster.value}`
}
function clipUrl(scene: MotionScene) {
  return `/api/projects/${slug.value}/scene-review/${episodeId.value}/clip/${scene.id}?t=${cacheBuster.value}`
}
function choiceLabel(scene: MotionScene) {
  if (scene.motion_choice === 'clip') return 'Clip approved'
  if (scene.motion_choice === 'still') return 'Still selected'
  if (scene.clip_exists && scene.motion_choice == null) return 'Legacy clip'
  return scene.clip_exists ? 'Needs review' : 'Waiting for clip'
}

async function loadReview() {
  if (!episodeId.value) { scenes.value = []; stats.value = null; return }
  loading.value = true
  try {
    const result = await get<{ scenes: MotionScene[]; stats: MotionStats | null }>(`/projects/${slug.value}/scene-review/${episodeId.value}`)
    scenes.value = result.scenes || []
    stats.value = result.stats
    cacheBuster.value = Date.now()
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not load Motion Review')
  } finally {
    loading.value = false
  }
}

async function generateOne(scene: MotionScene) {
  if (!videoModel.value) return
  animatingId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-clip`, {
      scene_id: scene.id,
      model: videoModel.value,
      aspect_ratio: '16:9',
    })
    success(`Scene ${scene.scene_index} clip queued.`)
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not queue the clip')
  } finally {
    animatingId.value = null
  }
}

async function generateMissing() {
  if (!videoModel.value) return
  queuing.value = true
  try {
    const result = await post<{ queued: number; skipped: number }>(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-missing-clips`, {
      model: videoModel.value,
      aspect_ratio: '16:9',
    })
    success(`${result.queued || 0} image-to-video clips queued.`)
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not queue motion clips')
  } finally {
    queuing.value = false
  }
}

async function uploadClipOne(scene: MotionScene) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/mp4,.mp4'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    uploadingId.value = scene.id
    try {
      const response = await fetch(
        `/api/projects/${slug.value}/scene-review/${episodeId.value}/upload-clip/${scene.id}`,
        { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: file },
      )
      if (!response.ok) {
        const detail = await response.json().catch(() => ({} as any))
        throw new Error(detail.detail || `Upload failed (${response.status})`)
      }
      await loadReview()
      success(`External clip uploaded for scene ${scene.scene_index}. Review it, then choose Use clip.`)
    } catch (error: any) {
      showError(error?.message || 'Could not upload the external clip')
    } finally {
      uploadingId.value = null
    }
  }
  input.click()
}

async function setChoice(scene: MotionScene, choice: 'clip' | 'still') {
  savingId.value = scene.id
  try {
    await put(`/projects/${slug.value}/scene-review/${episodeId.value}/motion-choice`, { scene_id: scene.id, choice })
    scene.motion_choice = choice
    await loadReview()
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not save the motion decision')
  } finally {
    savingId.value = null
  }
}

async function setAll(choice: 'clip' | 'still') {
  savingAll.value = true
  try {
    await put(`/projects/${slug.value}/scene-review/${episodeId.value}/motion-choice`, { all: true, choice })
    await loadReview()
    success(choice === 'clip' ? 'All fresh clips approved.' : 'All scenes will use their still images.')
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not save motion decisions')
  } finally {
    savingAll.value = false
  }
}
const approveAllClips = () => setAll('clip')
const keepAllStills = () => setAll('still')

let refreshTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  refreshTimer = setInterval(() => { if (clipJobsActive.value) void loadReview() }, 3000)
})
onBeforeUnmount(() => { if (refreshTimer) clearInterval(refreshTimer) })
watch(episodeId, () => { void loadReview() })
</script>

<style scoped>
.motion-intro, .motion-summary, .motion-tools, .scene-line, .motion-actions { display: flex; align-items: center; gap: 12px; }
.motion-intro { justify-content: space-between; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--accent) 7%, var(--bg-secondary)); }
.motion-intro p { margin: 4px 0 0; color: var(--text-muted); }
.optional-badge { display: inline-block; vertical-align: middle; margin-left: 8px; padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); border-radius: 999px; color: var(--accent); font: 700 10px/1.2 var(--font-sans, sans-serif); letter-spacing: .06em; text-transform: uppercase; }
.external-motion-note { padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-tertiary); color: var(--text-muted); font-size: 13px; line-height: 1.55; }
.external-motion-note strong { color: var(--text-primary); }
.motion-summary { justify-content: space-between; align-items: flex-end; }
.motion-summary h3, .motion-summary p { margin: 0; }
.motion-tools { flex-wrap: wrap; justify-content: flex-end; }
.model-field { min-width: 260px; }
.model-field > span, .media-label { display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.motion-ready { border-color: #5bb37c; }
.motion-grid { display: grid; gap: 14px; padding: 0; list-style: none; }
.motion-card { padding: 14px; border: 1px solid var(--border); border-left: 4px solid #d49b45; border-radius: 12px; background: var(--bg-secondary); }
.motion-card.choice-clip, .motion-card.choice-legacy { border-left-color: #5bb37c; }
.motion-card.choice-still { border-left-color: #6d93c8; }
.media-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.media-box img, .media-box video, .missing-media { width: 100%; aspect-ratio: 16 / 9; border-radius: 8px; background: #111; object-fit: contain; }
.missing-media { display: grid; place-items: center; color: var(--text-muted); }
.motion-copy { padding: 12px 2px 8px; }
.scene-line { flex-wrap: wrap; }
.scene-line > span { color: var(--text-muted); font-size: 12px; }
.choice-badge { margin-left: auto; padding: 3px 8px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-primary) !important; }
.transcript { margin: 8px 0; line-height: 1.5; }
.motion-prompt { margin: 6px 0; color: var(--text-muted); }
.stale-note { color: #d47b45; font-weight: 600; }
.motion-actions { justify-content: flex-end; flex-wrap: wrap; }
.empty-state { padding: 32px; text-align: center; color: var(--text-muted); }
@media (max-width: 760px) {
  .motion-intro, .motion-summary { align-items: stretch; flex-direction: column; }
  .motion-tools { justify-content: stretch; }
  .model-field { min-width: 100%; }
  .media-pair { grid-template-columns: 1fr; }
}
</style>
