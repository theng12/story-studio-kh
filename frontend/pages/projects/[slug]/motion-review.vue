<template>
  <div class="motion-workspace workspace-page">
    <WorkspaceHero
      eyebrow="Optional review pass"
      title="Motion Review"
      description="Turn approved stills into motion clips only where movement adds value. Untouched scenes remain valid still images through final assembly."
    >
      <template #aside>
        <div class="motion-hero-route" aria-label="Review workflow">
          <span class="is-complete">1</span><b>Plan</b><i />
          <span class="is-complete">2</span><b>Images</b><i />
          <span class="is-current">3</span><b>Motion</b>
        </div>
      </template>
    </WorkspaceHero>

    <div class="motion-command-bar workspace-command-surface">
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
    </div>

    <div class="motion-guide-grid">
      <WorkspaceNotice title="Stills remain the safe default" tone="info">
        Skip motion freely. Choosing a clip only replaces its still inside the same locked timestamp window.
        <template #actions>
          <NuxtLink :to="`/projects/${slug}/scene-review`" class="btn btn-sm btn-secondary">Back to image review</NuxtLink>
        </template>
      </WorkspaceNotice>

      <WorkspaceNotice title="External clips use the same timeline" tone="info">
        Upload an MP4 on the matching scene. Long clips are trimmed, short clips hold their final frame, and narration audio remains in control.
      </WorkspaceNotice>
    </div>

    <WorkspaceSection
      v-if="stats"
      eyebrow="Episode readiness"
      title="Motion decisions"
      description="Choose a clip or keep the approved still for every scene. This pass never changes narration timing."
      class="motion-control-deck"
      :class="{ 'motion-ready': stats.all_motion_reviewed }"
    >
      <div class="motion-summary">
        <div class="motion-summary-copy">
          <span class="motion-summary-kicker">Episode readiness</span>
          <h3>{{ stats.motion_reviewed }} of {{ stats.total_scenes }} motion decisions</h3>
          <p>{{ stats.with_clip }} clips available · {{ stats.total_scenes - stats.motion_reviewed }} decisions remaining</p>
        </div>
        <div class="motion-summary-score" :class="{ ready: stats.all_motion_reviewed }">
          <strong>{{ stats.total_scenes ? Math.round((stats.motion_reviewed / stats.total_scenes) * 100) : 0 }}%</strong>
          <span>decided</span>
        </div>
      </div>
      <div class="motion-progress" aria-hidden="true">
        <span :style="{ width: `${stats.total_scenes ? (stats.motion_reviewed / stats.total_scenes) * 100 : 0}%` }" />
      </div>
      <div class="motion-tool-row">
        <div class="motion-tool-heading">
          <strong>Motion controls</strong>
          <span>Pick a model, then generate or make one decision for every scene.</span>
        </div>
        <div class="motion-tools">
          <label class="model-field">
            <span>Image-to-video model</span>
            <ModelMenu
              v-model="videoModel"
              :options="i2vModels"
              media-type="video"
              title="Choose an image-to-video model"
              placeholder="Pick an image-to-video model…"
              search-placeholder="Search video model or provider…"
              aria-label="Image-to-video model options"
            />
            <!-- Charged capability the assembled episode will not contain.
                 Shown at the point of choosing, next to the model that bills
                 for it, so a customer can pick a picture-only model instead. -->
            <span v-if="selectedVideoModelAudioNotice" class="model-audio-notice">
              {{ selectedVideoModelAudioNotice }}
            </span>
          </label>
          <label class="model-field variant-field">
            <span>Clip variant</span>
            <select v-model="videoVariantKey" class="select" :disabled="!selectedVideoVariants.length" aria-label="Published clip variant">
              <option v-if="!selectedVideoVariants.length" value="">No published length or resolution</option>
              <option v-for="variant in selectedVideoVariants" :key="variantKey(variant)" :value="variantKey(variant)">
                {{ variant.duration_seconds }}s at {{ variant.resolution }} — {{ variant.credits_per_video }} credits (minimum {{ variant.minimum_credits }}, price {{ variant.price_version }})
              </option>
            </select>
          </label>
          <button class="btn btn-sm btn-secondary" :disabled="savingAll || stats.with_clip === 0" @click="approveAllClips">
            Approve all fresh clips
          </button>
          <button class="btn btn-sm btn-ghost" :disabled="savingAll" @click="keepAllStills">Keep all as stills</button>
        </div>
      </div>
    </WorkspaceSection>

    <section v-if="!episodeId" class="card mt-3 empty-state">Pick an episode to review motion.</section>
    <section v-else-if="loading" class="card mt-3 empty-state">Loading motion pass...</section>
    <section v-else-if="!scenes.length" class="card mt-3 empty-state">
      No scene plan is available yet. Complete Scene Plan and Scene Review first.
    </section>

    <ul v-else class="motion-grid mt-3">
      <li v-for="scene in renderedScenes" :key="scene.id" class="motion-card" :class="`choice-${scene.motion_choice || (scene.clip_exists ? 'legacy' : 'pending')}`">
        <div class="media-pair">
          <div class="media-box">
            <span class="media-label">Approved image</span>
            <img v-if="scene.image_filename" :src="imageUrl(scene)" :alt="`Scene ${scene.scene_index}`" />
            <div v-else class="missing-media">Image missing</div>
          </div>
          <div class="media-box">
            <span class="media-label">Motion result</span>
            <video v-if="scene.clip_exists" :src="clipUrl(scene)" controls loop preload="none" />
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
    <div
      v-if="renderedScenes.length < scenes.length"
      ref="sceneLoadSentinel"
      class="motion-list-more"
    >
      <span>{{ renderedScenes.length }} of {{ scenes.length }} scenes loaded</span>
      <button class="btn btn-sm btn-ghost" @click="loadMoreScenes">Load next {{ SCENE_RENDER_BATCH }}</button>
    </div>

    <Transition name="motion-float">
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { selectLiveImageToVideoModel } from '~/utils/genstudio-video-model-selection'
import { genStudioModelLockReason } from '~/utils/live-genstudio-model-selection'
import { describeVideoModelRate } from '~/utils/genstudio-credit-cost'
import { variantsForVideoOperation, videoVariantKey as publishedVideoVariantKey } from '~/utils/genstudio-video-variants'

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
const initialEpisodeId = typeof route.query.episode_id === 'string'
  ? route.query.episode_id
  : typeof route.query.episode === 'string'
    ? route.query.episode
    : ''
const episodeId = ref(initialEpisodeId)
const { config } = useProject()
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { isJobActiveFor } = useJobs()
const scenes = ref<MotionScene[]>([])
const SCENE_RENDER_BATCH = 24
const renderedSceneLimit = ref(SCENE_RENDER_BATCH)
const renderedScenes = computed(() => scenes.value.slice(0, renderedSceneLimit.value))
const sceneLoadSentinel = ref<HTMLElement | null>(null)
let sceneLoadObserver: IntersectionObserver | null = null
let reviewLoadSequence = 0
function loadMoreScenes(): void {
  renderedSceneLimit.value = Math.min(scenes.value.length, renderedSceneLimit.value + SCENE_RENDER_BATCH)
}
const stats = ref<MotionStats | null>(null)
const loading = ref(false)
const queuing = ref(false)
const savingAll = ref(false)
const savingId = ref<string | null>(null)
const animatingId = ref<string | null>(null)
const uploadingId = ref<string | null>(null)
const videoModel = ref('')
const videoVariantKey = ref('')
const { videoModels: genStudioVideoModels, refresh: refreshGenStudioMediaModels } = useGenStudioMediaModels()
const cacheBuster = ref(Date.now())
const motionPresets = usePresets({
  slug: slug.value,
  configKey: 'motion_review',
  presetType: 'motion-review',
  snapshot: () => ({
    model: videoModel.value,
    aspect_ratio: '16:9',
    operation: selectedVideoVariant.value?.operation,
    duration_seconds: selectedVideoVariant.value?.duration_seconds,
    resolution: selectedVideoVariant.value?.resolution,
  }),
  apply: (data: any) => {
    if (typeof data?.model === 'string') videoModel.value = data.model
    if (Number.isFinite(Number(data?.duration_seconds)) && typeof data?.resolution === 'string' && data.resolution.trim()) {
      videoVariantKey.value = variantKey({
        operation: typeof data?.operation === 'string' && data.operation.trim()
          ? data.operation.trim()
          : STORY_STUDIO_VIDEO_OPERATION,
        duration_seconds: Number(data.duration_seconds),
        resolution: data.resolution.trim(),
      })
    }
  },
})

// Cheapest is only the first default. The selected published pair is what
// the generator submits, and it remains live-derived rather than cached.
const STORY_STUDIO_VIDEO_OPERATION = 'image-to-video'
type VideoVariant = {
  operation: string
  duration_seconds: number
  resolution: string
  credits_per_video: number
  minimum_credits: number
  price_version: string
}
function cheapestVariant(variants: readonly VideoVariant[]) {
  if (!variants.length) return null
  return [...variants].sort((a, b) => (
    a.credits_per_video - b.credits_per_video
    || a.minimum_credits - b.minimum_credits
    || a.duration_seconds - b.duration_seconds
    || a.resolution.localeCompare(b.resolution)
  ))[0]!
}
function variantKey(variant: Pick<VideoVariant, 'operation' | 'duration_seconds' | 'resolution'>): string {
  return publishedVideoVariantKey(variant)
}

/**
 * What the customer is told when the selected model bills for a soundtrack
 * Story Studio's assembly will not use.
 *
 * This is DISCLOSURE, not a toggle. Video assembly builds one episode-wide
 * audio timeline (narration + optional music + optional ambience) and every
 * clip enters it as picture only; clips are looped, trimmed, cross-faded,
 * chunked and stream-copy concatenated, so there is no per-clip audio lane a
 * generated track could honestly be placed in. Offering a "keep the generated
 * audio" switch would be a switch that does nothing on the assembly path,
 * which is worse than saying so plainly.
 */
const GENERATED_AUDIO_DISCLOSURE =
  'This model also generates its own audio track, and you are charged for it. '
  + 'Story Studio composes your narration mix over the picture, so the generated audio is not in the '
  + 'assembled episode — it is kept only in the downloaded clip file. Choose a picture-only model if '
  + 'you do not want to pay for a soundtrack the episode will not use.'

const i2vModels = computed(() => {
  const discovered = genStudioVideoModels.value
    // Story Studio submits image-to-video only. The catalogue carries every
    // published mode; the restriction is applied here, at the picker.
    .filter(model => model.modes.includes(STORY_STUDIO_VIDEO_OPERATION))
    .map((model) => {
      const variants = variantsForVideoOperation(model.variants, STORY_STUDIO_VIDEO_OPERATION)
      const variant = cheapestVariant(variants)
      const rate = describeVideoModelRate({ ...model, variants })
      // An enforced limit has to be visible at the point of choosing.
      const noVariant = 'No published length or resolution'
      // Only a published `true` is disclosed. `false` and `null` (GenStudio
      // said nothing) both say nothing here — a silent model needs no warning,
      // and an unpublished field is not evidence of one either way.
      const generatesAudio = model.generates_audio === true
      return {
        id: `genstudio-video:${model.id}`,
        label: model.display_name,
        // Named once, by the group heading. `VideoModelResponse` publishes no
        // provider, so no `provider` is set and none is guessed from the id.
        group: 'GenStudio KH',
        price: rate.text,
        priceTitle: rate.title,
        meta: variant
          ? `${variant.duration_seconds}s at ${variant.resolution} — ${variant.credits_per_video} credits`
          : noVariant,
        description: (variant
          ? `The cheapest published option is selected first (${variant.duration_seconds}s at ${variant.resolution}). `
            + 'Choose a published length and resolution; that selected option is what the clip will use.'
          : 'GenStudio publishes no priced length or resolution for this model, so Story Studio '
            + 'cannot generate a clip with it.')
          + (generatesAudio ? ` ${GENERATED_AUDIO_DISCLOSURE}` : ''),
        disabled: !model.available || model.locked === true || !variant,
        disabledReason: genStudioModelLockReason(model) || (!model.available
          ? 'This video model is not currently available.'
          : !variant
            ? 'GenStudio publishes no priced length or resolution for this model.'
            : undefined),
        badges: generatesAudio ? [{ label: 'Generates audio', tone: 'warning' as const }] : [],
        costTier: model.cost_tier,
      }
    })
  return discovered
})

/** The selected model's audio disclosure, or empty when there is nothing to
 *  disclose. Re-derived from the live catalogue on every model change. */
const selectedVideoModelAudioNotice = computed(() => {
  const raw = videoModel.value.startsWith('genstudio-video:')
    ? videoModel.value.slice('genstudio-video:'.length)
    : videoModel.value
  const model = genStudioVideoModels.value.find(item => item.id === raw)
  return model?.generates_audio === true ? GENERATED_AUDIO_DISCLOSURE : ''
})
const selectedVideoModel = computed(() => {
  const raw = videoModel.value.startsWith('genstudio-video:')
    ? videoModel.value.slice('genstudio-video:'.length)
    : videoModel.value
  return genStudioVideoModels.value.find(item => item.id === raw) || null
})
const selectedVideoVariants = computed<VideoVariant[]>(() => (
  variantsForVideoOperation(selectedVideoModel.value?.variants, STORY_STUDIO_VIDEO_OPERATION)
))
const selectedVideoVariant = computed(() => selectedVideoVariants.value.find(variant => variantKey(variant) === videoVariantKey.value) || null)
watch(selectedVideoVariants, (variants) => {
  if (!variants.length) { videoVariantKey.value = ''; return }
  if (!variants.some(variant => variantKey(variant) === videoVariantKey.value)) {
    videoVariantKey.value = variantKey(cheapestVariant(variants)!)
  }
}, { immediate: true })
watch(i2vModels, (models) => {
  if (!models.length) return
  const raw = videoModel.value.startsWith('genstudio-video:') ? videoModel.value.slice('genstudio-video:'.length) : videoModel.value
  const selected = selectLiveImageToVideoModel(raw, genStudioVideoModels.value)
  if (selected) videoModel.value = `genstudio-video:${selected.id}`
}, { immediate: true })

const clipJobsActive = computed(() => isJobActiveFor(episodeId.value, ['scene_clip_generate', 'scene_clips_batch']))
const canGenerate = computed(() => !!episodeId.value && !!videoModel.value && !!selectedVideoVariant.value && scenes.value.some(scene =>
  !i2vModels.value.find(model => model.id === videoModel.value)?.disabled
    && scene.approved && scene.image_filename && scene.motion_prompt && (!scene.clip_exists || scene.clip_stale),
))
const generateStatus = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!i2vModels.value.length) return 'GenStudio has no image-to-video models available'
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
  const ep = episodeId.value
  const requestSequence = ++reviewLoadSequence
  if (!ep) { scenes.value = []; stats.value = null; return }
  loading.value = true
  try {
    const result = await get<{ scenes: MotionScene[]; stats: MotionStats | null }>(`/projects/${slug.value}/scene-review/${ep}`)
    if (requestSequence !== reviewLoadSequence || episodeId.value !== ep) return
    scenes.value = result.scenes || []
    stats.value = result.stats
    cacheBuster.value = Date.now()
  } catch (error: any) {
    if (requestSequence !== reviewLoadSequence || episodeId.value !== ep) return
    showError(error?.data?.detail || error?.message || 'Could not load Motion Review')
  } finally {
    if (requestSequence === reviewLoadSequence && episodeId.value === ep) loading.value = false
  }
}

async function generateOne(scene: MotionScene) {
  if (!videoModel.value || !selectedVideoVariant.value) return
  animatingId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-clip`, {
      scene_id: scene.id,
      model: videoModel.value,
      aspect_ratio: '16:9',
      duration_seconds: selectedVideoVariant.value.duration_seconds,
      resolution: selectedVideoVariant.value.resolution,
    })
    success(`Scene ${scene.scene_index} clip queued.`)
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not queue the clip')
  } finally {
    animatingId.value = null
  }
}

async function generateMissing() {
  if (!videoModel.value || !selectedVideoVariant.value) return
  queuing.value = true
  try {
    const result = await post<{ queued: number; skipped: number }>(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-missing-clips`, {
      model: videoModel.value,
      aspect_ratio: '16:9',
      duration_seconds: selectedVideoVariant.value.duration_seconds,
      resolution: selectedVideoVariant.value.resolution,
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
  getScrollContainer()?.scrollTo({ top: 0, behavior: 'smooth' })
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refreshGenStudioMediaModels()
  refreshTimer = setInterval(() => {
    if (clipJobsActive.value && !loading.value) void loadReview()
  }, 3000)
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
  if (refreshTimer) clearInterval(refreshTimer)
  getScrollContainer()?.removeEventListener('scroll', onScroll)
  sceneLoadObserver?.disconnect()
  sceneLoadObserver = null
})
watch(episodeId, () => {
  renderedSceneLimit.value = SCENE_RENDER_BATCH
  void loadReview()
}, { immediate: true })
</script>

<style scoped>
.motion-workspace {
  --motion-gold: #f0c66a;
  --motion-blue: #73a8df;
  --motion-green: #53c786;
  --motion-ink: #101710;
  padding-bottom: 72px;
}
.motion-hero-route { position: relative; z-index: 1; display: grid; grid-template-columns: 28px auto 22px 28px auto 22px 28px auto; align-items: center; gap: 7px; flex: 0 0 auto; }
.motion-hero-route span { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid var(--border); border-radius: 50%; color: var(--text-muted); font-size: var(--font-xs); font-weight: 800; }
.motion-hero-route span.is-complete { border-color: var(--motion-green); background: var(--motion-green); color: var(--motion-ink); }
.motion-hero-route span.is-current { border-color: var(--motion-blue); color: var(--motion-blue); box-shadow: 0 0 0 4px rgba(115,168,223,.1); }
.motion-hero-route b { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 600; }
.motion-hero-route i { height: 1px; background: var(--border); }

.motion-command-bar :deep(.top-action-bar) { display: grid; grid-template-columns: minmax(350px, auto) minmax(420px, 1fr) auto; align-items: end; gap: 16px; margin: 0; padding: 0; border: 0; background: transparent; box-shadow: none; }
.motion-command-bar :deep(.region-spacer) { display: none; }
.motion-command-bar :deep(.generate-region) { justify-content: flex-end; align-items: flex-end; }
.motion-command-bar :deep(.btn-primary-cta) { min-width: 180px; min-height: 38px; border-radius: 9px; white-space: nowrap; }

.motion-guide-grid { display: grid; grid-template-columns: 1.05fr .95fr; gap: 12px; margin-top: var(--space-4); }
.motion-guide-grid :deep(.workspace-notice) { margin-top: 0; }

.motion-control-deck { overflow: hidden; border-radius: 16px; }
.motion-summary, .motion-tools, .scene-line, .motion-actions { display: flex; align-items: center; gap: 12px; }
.motion-summary { justify-content: space-between; padding-bottom: 16px; }
.motion-summary-kicker { color: var(--motion-blue); font-size: var(--font-xs); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.motion-summary-copy h3 { margin: 5px 0 3px; font-size: 20px; letter-spacing: -.02em; }
.motion-summary-copy p { margin: 0; color: var(--text-muted); font-size: 12px; }
.motion-summary-score { display: grid; min-width: 82px; min-height: 58px; place-content: center; border: 1px solid color-mix(in srgb, var(--motion-blue) 42%, var(--border)); border-radius: 13px; background: color-mix(in srgb, var(--motion-blue) 9%, transparent); text-align: center; }
.motion-summary-score strong { color: var(--motion-blue); font-size: 19px; line-height: 1; }
.motion-summary-score span { margin-top: 4px; color: var(--text-muted); font-size: var(--font-xs); letter-spacing: .08em; text-transform: uppercase; }
.motion-summary-score.ready { border-color: color-mix(in srgb, var(--motion-green) 55%, var(--border)); background: color-mix(in srgb, var(--motion-green) 10%, transparent); }
.motion-summary-score.ready strong { color: var(--motion-green); }
.motion-progress { height: 4px; margin: 0 0 2px; overflow: hidden; border-radius: 999px; background: var(--bg-tertiary); }
.motion-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--motion-blue), var(--motion-green)); transition: width .35s ease; }
.motion-tool-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; padding-top: 17px; border-top: 1px solid var(--border); }
.motion-tool-heading { display: flex; min-width: 190px; flex-direction: column; gap: 3px; }
.motion-tool-heading strong { font-size: 13px; }
.motion-tool-heading span { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.motion-tools { justify-content: flex-end; flex-wrap: wrap; }
.model-field { min-width: 280px; }
.model-field > span, .media-label { display: block; margin-bottom: 6px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
/* Prose, not a field label — override the uppercase caption styling above. */
.model-field > span.model-audio-notice {
  margin: 6px 0 0; max-width: 46ch;
  color: var(--warning, #d97706); font-size: var(--font-xs); font-weight: 500;
  letter-spacing: normal; text-transform: none; line-height: 1.45;
}
.motion-ready { border-color: color-mix(in srgb, var(--motion-green) 65%, var(--border)); }

.motion-grid { display: grid; gap: 14px; padding: 0; list-style: none; }
.motion-list-more { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 14px; color: var(--text-muted); font-size: 12px; }
.motion-card { display: grid; grid-template-columns: minmax(380px, .9fr) minmax(320px, 1.1fr); gap: 18px; padding: 15px; border: 1px solid var(--border); border-left: 4px solid var(--motion-gold); border-radius: 14px; background: var(--bg-secondary); box-shadow: 0 6px 22px rgba(0,0,0,.07); transition: border-color .18s ease, transform .18s ease; content-visibility: auto; contain-intrinsic-size: auto 320px; }
.motion-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--motion-blue) 30%, var(--border)); }
.motion-card.choice-clip, .motion-card.choice-legacy { border-left-color: var(--motion-green); }
.motion-card.choice-still { border-left-color: var(--motion-blue); }
.media-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.media-box img, .media-box video, .missing-media { width: 100%; aspect-ratio: 16 / 9; border-radius: 9px; background: #0b0d0c; object-fit: contain; }
.missing-media { display: grid; place-items: center; border: 1px dashed var(--border); color: var(--text-muted); font-size: 12px; }
.motion-copy { min-width: 0; padding: 4px 2px; }
.scene-line { flex-wrap: wrap; }
.scene-line strong { font-size: 15px; }
.scene-line > span { color: var(--text-muted); font-size: 12px; }
.choice-badge { margin-left: auto; padding: 4px 9px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-primary) !important; font-weight: 650; }
.transcript { margin: 10px 0; color: var(--text-secondary); line-height: 1.55; }
.motion-prompt { margin: 7px 0; color: var(--text-muted); line-height: 1.5; }
.stale-note { color: #d99558; font-weight: 650; }
.motion-actions { grid-column: 1 / -1; justify-content: flex-end; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--border); }
.motion-actions .btn { min-height: 33px; border-radius: 8px; }
.empty-state { padding: 42px; border-radius: 15px; text-align: center; color: var(--text-muted); }

.back-to-top { position: fixed; right: 28px; bottom: 28px; z-index: 120; display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 16px 0 11px; border: 1px solid rgba(115,168,223,.5); border-radius: 999px; background: #20282d; color: #f5f8ff; font-size: 12px; font-weight: 750; cursor: pointer; box-shadow: 0 12px 34px rgba(0,0,0,.38); transition: transform .18s ease, border-color .18s ease, background .18s ease; }
.back-to-top span { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--motion-blue); color: #101722; font-size: 15px; }
.back-to-top:hover { transform: translateY(-3px); border-color: var(--motion-blue); background: #29333a; }
.motion-float-enter-active, .motion-float-leave-active { transition: opacity .18s ease, transform .18s ease; }
.motion-float-enter-from, .motion-float-leave-to { opacity: 0; transform: translateY(10px); }

@media (max-width: 1220px) {
  .motion-command-bar :deep(.top-action-bar) { grid-template-columns: 1fr; align-items: stretch; }
  .motion-command-bar :deep(.generate-region) { justify-content: flex-start; }
  .motion-card { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .motion-hero-route { display: none; }
  .motion-guide-grid { grid-template-columns: 1fr; }
  .motion-tool-row { align-items: stretch; flex-direction: column; }
  .motion-tools { justify-content: flex-start; }
}
@media (max-width: 640px) {
  .motion-summary { align-items: flex-start; flex-direction: column; }
  .motion-summary-score, .model-field { width: 100%; min-width: 0; }
  .motion-tools { align-items: stretch; flex-direction: column; }
  .media-pair { grid-template-columns: 1fr; }
  .motion-actions { justify-content: stretch; }
  .motion-actions .btn { flex: 1 1 100%; }
  .back-to-top { right: 16px; bottom: 16px; }
}
</style>
