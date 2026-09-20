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
        Upload an MP4 on the matching scene. Long clips are trimmed and short external or legacy clips loop to fill the narration window.
        Clips generated with Follow narration hold their final frame instead when they cannot reach the full scene.
      </WorkspaceNotice>
    </div>

    <WorkspaceSection
      v-if="stats && !usesImagePool"
      eyebrow="Episode readiness"
      title="Motion decisions"
      description="Choose a clip or keep the approved still for the saved scope. This pass never changes narration timing."
      class="motion-control-deck"
      :class="{ 'motion-ready': allScopedMotionReviewed }"
    >
      <div class="motion-scope-summary" aria-live="polite">
        <div>
          <h3>Motion scope: {{ motionScopeLabel }}</h3>
          <p>{{ motionSceneIds.length }} eligible {{ motionSceneIds.length === 1 ? 'scene' : 'scenes' }} in this batch.</p>
          <p v-if="motionCrossingSceneIds.length" class="motion-scope-crossing">
            {{ motionCrossingLabel }} crosses the opening boundary and stays still unless you explicitly include it.
          </p>
          <p v-if="motionScopeError" class="motion-scope-error">{{ motionScopeError }}</p>
        </div>
        <NuxtLink :to="scenePlanMotionLink" class="btn btn-sm btn-secondary">Edit in Scene Plan</NuxtLink>
      </div>
      <div class="motion-summary">
        <div class="motion-summary-copy">
          <span class="motion-summary-kicker">Episode readiness</span>
          <h3 v-if="motionSceneIds.length">{{ scopedMotionReviewed }} of {{ motionSceneIds.length }} motion decisions</h3>
          <h3 v-else>No motion decisions in this scope</h3>
          <p v-if="motionSceneIds.length">{{ scopedClipCount }} clips available · {{ motionSceneIds.length - scopedMotionReviewed }} decisions remaining</p>
          <p v-else>Scenes remain still unless a future saved scope includes them.</p>
        </div>
        <div class="motion-summary-score" :class="{ ready: allScopedMotionReviewed }">
          <strong>{{ motionSceneIds.length ? `${Math.round((scopedMotionReviewed / motionSceneIds.length) * 100)}%` : '—' }}</strong>
          <span>{{ motionSceneIds.length ? 'decided' : 'not applicable' }}</span>
        </div>
      </div>
      <div class="motion-progress" aria-hidden="true">
        <span :style="{ width: `${motionSceneIds.length ? (scopedMotionReviewed / motionSceneIds.length) * 100 : 0}%` }" />
      </div>
      <div class="motion-tool-row">
        <div class="motion-tool-heading">
          <strong>Motion controls</strong>
          <span>Pick a model, then generate or make one decision for each scoped scene.</span>
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
          <label class="model-field resolution-field">
            <span>Resolution</span>
            <select
              class="select"
              :value="selectedResolution"
              :disabled="!availableResolutions.length"
              aria-label="Published resolution"
              @change="chooseResolution"
            >
              <option v-if="!availableResolutions.length" value="">No published resolution</option>
              <option v-for="resolution in availableResolutions" :key="resolution" :value="resolution">
                {{ resolution }}
              </option>
            </select>
          </label>
          <fieldset class="duration-mode" :disabled="!selectedResolutionVariants.length">
            <legend>Clip timing</legend>
            <label>
              <input v-model="durationMode" type="radio" name="duration-mode" value="manual">
              <span><strong>Manual duration</strong><small>Use one listed length for every new clip.</small></span>
            </label>
            <label>
              <input v-model="durationMode" type="radio" name="duration-mode" value="follow_narration">
              <span><strong>Follow narration</strong><small>Round each scene up to its next listed length.</small></span>
            </label>
          </fieldset>
          <div v-if="durationMode === 'manual'" class="manual-duration">
            <div class="manual-duration-heading">
              <label for="manual-clip-length">Manual clip length</label>
              <span v-if="maximumDuration !== null">Maximum {{ maximumDuration }}s</span>
            </div>
            <div class="manual-duration-inputs">
              <input
                aria-label="Manual clip length slider"
                type="range"
                min="0"
                :max="Math.max(0, selectedResolutionVariants.length - 1)"
                step="1"
                :value="manualDurationIndex"
                :aria-valuetext="manualDurationSeconds === null ? undefined : `${manualDurationSeconds} seconds`"
                :disabled="!selectedResolutionVariants.length"
                @input="chooseManualSliderValue"
                @keydown="moveManualDuration"
              >
              <div class="duration-number-wrap">
                <input
                  id="manual-clip-length"
                  class="input duration-number"
                  aria-label="Manual clip length"
                  type="number"
                  inputmode="decimal"
                  step="any"
                  :min="minimumDuration ?? undefined"
                  :max="maximumDuration ?? undefined"
                  :value="manualDurationDraft"
                  :disabled="!selectedResolutionVariants.length"
                  @input="editManualDuration"
                  @blur="commitManualDuration"
                  @keydown.enter="commitManualDuration"
                >
                <span aria-hidden="true">seconds</span>
              </div>
            </div>
            <p class="duration-help">
              Listed lengths: {{ publishedDurationLabels || 'None' }}. Typed values round up; values above the listed maximum use {{ maximumDuration }}s.
            </p>
          </div>
          <div v-else class="follow-duration-note">
            <strong>Each unsent scene is matched separately.</strong>
            <span>Longer clips are trimmed. If narration exceeds the listed maximum, the final frame holds for the visible shortfall.</span>
          </div>
          <div v-if="selectedResolutionVariants.length" class="batch-cost" aria-live="polite">
            <strong>{{ batchPlans.length }} {{ batchPlans.length === 1 ? 'clip' : 'clips' }} · Listed total {{ formatCredits(batchListedTotal) }}</strong>
            <span>The current catalogue rows are shown for planning; the provider quote is authoritative when each request is accepted.</span>
            <span v-if="existingClipCount">Existing clips stay out of this batch.</span>
          </div>
          <button v-if="motionScope.mode === 'all'" class="btn btn-sm btn-secondary" :disabled="savingAll || scopedClipCount === 0" @click="approveAllClips">
            Approve all fresh clips
          </button>
          <button v-if="motionScope.mode === 'all'" class="btn btn-sm btn-ghost" :disabled="savingAll" @click="keepAllStills">Keep all as stills</button>
        </div>
      </div>
    </WorkspaceSection>

    <WorkspaceNotice v-else-if="stats && usesImagePool" title="Motion Review is not used for Image Pool" tone="info">
      This episode assembles its saved Image Pool selection. Scene clips and motion decisions do not apply here.
      <template #actions>
        <NuxtLink :to="`/projects/${slug}/video-assembly?episode_id=${encodeURIComponent(episodeId)}`" class="btn btn-sm btn-secondary">Open Video Assembly</NuxtLink>
      </template>
    </WorkspaceNotice>

    <section v-if="!episodeId" class="card mt-3 empty-state">Pick an episode to review motion.</section>
    <section v-else-if="loading" class="card mt-3 empty-state">Loading motion pass...</section>
    <section v-else-if="usesImagePool" class="card mt-3 empty-state">
      Image Pool is the selected visual source. Motion Review is not used for this episode.
    </section>
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
          <div v-if="scene.duration_plan" class="scene-duration-plan" :class="{ 'has-shortfall': scene.duration_plan.adjustment === 'hold' }">
            <span><small>Narration</small><strong>{{ formatSeconds(scene.duration_plan.narration_seconds) }}</strong></span>
            <span><small>Next request</small><strong>{{ formatSeconds(scene.duration_plan.requested_seconds) }}</strong></span>
            <span><small>Adjustment</small><strong>{{ scene.duration_plan.adjustment_label }}</strong></span>
            <span
              :title="`Minimum ${scene.duration_plan.variant.minimum_credits} credits · price list ${scene.duration_plan.variant.price_version}`"
            ><small>Current listed cost</small><strong>Listed cost {{ formatCredits(scene.duration_plan.variant.credits_per_video) }}</strong></span>
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
            :disabled="!scopedMotionSceneIds.has(scene.id) || !selectionReady || !scene.image_filename || !scene.motion_prompt || animatingId === scene.id"
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
import { describeVideoModelRate, formatCredits } from '~/utils/genstudio-credit-cost'
import { variantsForVideoOperation } from '~/utils/genstudio-video-variants'

// usePresets captures the project slug at setup. Recreate this page for a
// project navigation so controls and scene state cannot carry into another project.
definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })
useAppTitle('Motion Review')

type MotionChoice = 'pending' | 'clip' | 'still'
type MotionScope =
  | { mode: 'off' }
  | { mode: 'opening'; end_sec: number }
  | { mode: 'selected'; scene_ids: string[] }
  | { mode: 'all' }
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
type DurationMode = 'manual' | 'follow_narration'
type DurationPlan = {
  narration_seconds: number
  requested_seconds: number
  adjustment: 'exact' | 'trim' | 'hold' | 'loop'
  adjustment_label: string
  variant: VideoVariant
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const initialEpisodeId = typeof route.query.episode_id === 'string'
  ? route.query.episode_id
  : typeof route.query.episode === 'string'
    ? route.query.episode
    : ''
const episodeId = ref(initialEpisodeId)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { isJobActiveFor } = useJobs()
const scenes = ref<MotionScene[]>([])
const SCENE_RENDER_BATCH = 24
const renderedSceneLimit = ref(SCENE_RENDER_BATCH)
const renderedScenes = computed(() => scenes.value.slice(0, renderedSceneLimit.value).map(scene => ({
  ...scene,
  duration_plan: durationPlanForScene(scene),
})))
const sceneLoadSentinel = ref<HTMLElement | null>(null)
let sceneLoadObserver: IntersectionObserver | null = null
let reviewLoadSequence = 0
function loadMoreScenes(): void {
  renderedSceneLimit.value = Math.min(scenes.value.length, renderedSceneLimit.value + SCENE_RENDER_BATCH)
}
const stats = ref<MotionStats | null>(null)
const motionScope = ref<MotionScope>({ mode: 'off' })
const motionSceneIds = ref<string[]>([])
const motionCrossingSceneIds = ref<string[]>([])
const motionScopeError = ref('')
const visualSource = ref<'scene_plan' | 'image_pool'>('scene_plan')
const animateMinSeconds = ref(0)
const loading = ref(false)
const queuing = ref(false)
const savingAll = ref(false)
const savingId = ref<string | null>(null)
const animatingId = ref<string | null>(null)
const uploadingId = ref<string | null>(null)
const videoModel = ref('')
const selectedResolution = ref('')
const durationMode = ref<DurationMode>('manual')
const manualDurationSeconds = ref<number | null>(null)
const manualDurationDraft = ref('')
const { videoModels: genStudioVideoModels, refresh: refreshGenStudioMediaModels } = useGenStudioMediaModels()
const cacheBuster = ref(Date.now())
const motionPresets = usePresets({
  slug: slug.value,
  configKey: 'motion_review',
  presetType: 'motion-review',
  snapshot: () => ({
    model: videoModel.value,
    aspect_ratio: '16:9',
    operation: STORY_STUDIO_VIDEO_OPERATION,
    duration_seconds: manualDurationSeconds.value ?? undefined,
    resolution: selectedResolution.value || undefined,
    duration_mode: durationMode.value,
  }),
  apply: (data: any) => {
    if (typeof data?.model === 'string') videoModel.value = data.model
    selectedResolution.value = typeof data?.resolution === 'string' ? data.resolution.trim() : ''
    manualDurationSeconds.value = Number.isFinite(Number(data?.duration_seconds)) ? Number(data.duration_seconds) : null
    manualDurationDraft.value = manualDurationSeconds.value === null ? '' : String(manualDurationSeconds.value)
    durationMode.value = data?.duration_mode === 'follow_narration' ? 'follow_narration' : 'manual'
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
            + 'Choose a resolution, then use one published length or match each scene to its narration.'
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
const availableResolutions = computed(() => [...new Set(selectedVideoVariants.value.map(variant => variant.resolution))])
const selectedResolutionVariants = computed(() => selectedVideoVariants.value
  .filter(variant => variant.resolution === selectedResolution.value)
  .sort((a, b) => a.duration_seconds - b.duration_seconds))
const selectedManualVariant = computed(() => selectedResolutionVariants.value
  .find(variant => variant.duration_seconds === manualDurationSeconds.value) || null)
const minimumDuration = computed(() => selectedResolutionVariants.value[0]?.duration_seconds ?? null)
const maximumDuration = computed(() => selectedResolutionVariants.value.at(-1)?.duration_seconds ?? null)
const publishedDurationLabels = computed(() => selectedResolutionVariants.value
  .map(variant => `${variant.duration_seconds}s`).join(', '))
const manualDurationIndex = computed(() => Math.max(0, selectedResolutionVariants.value
  .findIndex(variant => variant.duration_seconds === manualDurationSeconds.value)))

function setManualDuration(duration: number | null): void {
  manualDurationSeconds.value = duration
  manualDurationDraft.value = duration === null ? '' : String(duration)
}

function snappedVariant(requested: number): VideoVariant | null {
  if (!selectedResolutionVariants.value.length || !Number.isFinite(requested)) return null
  return selectedResolutionVariants.value.find(variant => variant.duration_seconds >= requested)
    || selectedResolutionVariants.value.at(-1)!
}

function syncPublishedSelection(variants: readonly VideoVariant[]): void {
  if (!variants.length) {
    selectedResolution.value = ''
    setManualDuration(null)
    return
  }
  if (!variants.some(variant => variant.resolution === selectedResolution.value)) {
    selectedResolution.value = cheapestVariant(variants)!.resolution
  }
  const current = Number(manualDurationSeconds.value)
  const next = selectedResolutionVariants.value.find(variant => variant.duration_seconds === current)
    || (Number.isFinite(current) ? snappedVariant(current) : null)
    || cheapestVariant(selectedResolutionVariants.value)
  setManualDuration(next?.duration_seconds ?? null)
}

watch(selectedVideoVariants, (variants) => {
  syncPublishedSelection(variants)
}, { immediate: true })
watch(i2vModels, (models) => {
  if (!models.length) return
  const raw = videoModel.value.startsWith('genstudio-video:') ? videoModel.value.slice('genstudio-video:'.length) : videoModel.value
  const selected = selectLiveImageToVideoModel(raw, genStudioVideoModels.value)
  if (selected) videoModel.value = `genstudio-video:${selected.id}`
}, { immediate: true })

function chooseResolution(event: Event): void {
  const requested = manualDurationSeconds.value
  selectedResolution.value = (event.target as HTMLSelectElement).value
  const selected = requested === null ? null : snappedVariant(requested)
  setManualDuration(selected?.duration_seconds ?? cheapestVariant(selectedResolutionVariants.value)?.duration_seconds ?? null)
}

function chooseManualSliderValue(event: Event): void {
  const index = Number((event.target as HTMLInputElement).value)
  setManualDuration(selectedResolutionVariants.value[index]?.duration_seconds ?? null)
}

function editManualDuration(event: Event): void {
  manualDurationDraft.value = (event.target as HTMLInputElement).value
}

function commitManualDuration(): void {
  const selected = snappedVariant(Number(manualDurationDraft.value))
  setManualDuration(selected?.duration_seconds ?? manualDurationSeconds.value)
}

function moveManualDuration(event: KeyboardEvent): void {
  const movement = event.key === 'ArrowRight' || event.key === 'ArrowUp'
    ? 1
    : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
      ? -1
      : 0
  if (!movement) return
  event.preventDefault()
  const index = Math.min(
    selectedResolutionVariants.value.length - 1,
    Math.max(0, manualDurationIndex.value + movement),
  )
  setManualDuration(selectedResolutionVariants.value[index]?.duration_seconds ?? null)
}

function formatSeconds(seconds: number): string {
  return `${Math.round(seconds * 10) / 10}s`
}

function durationPlanForScene(scene: MotionScene): DurationPlan | null {
  const narration = Math.max(0, scene.end_sec - scene.start_sec)
  const variant = durationMode.value === 'follow_narration'
    ? snappedVariant(narration)
    : selectedManualVariant.value
  if (!variant) return null
  const difference = Math.round((variant.duration_seconds - narration) * 10) / 10
  if (difference > 0) return {
    narration_seconds: narration,
    requested_seconds: variant.duration_seconds,
    adjustment: 'trim',
    adjustment_label: `Trim ${formatSeconds(difference)}`,
    variant,
  }
  if (difference < 0) {
    const shortfall = formatSeconds(Math.abs(difference))
    return {
      narration_seconds: narration,
      requested_seconds: variant.duration_seconds,
      adjustment: durationMode.value === 'follow_narration' ? 'hold' : 'loop',
      adjustment_label: durationMode.value === 'follow_narration'
        ? `Hold final frame ${shortfall}`
        : `Loop clip for ${shortfall}`,
      variant,
    }
  }
  return {
    narration_seconds: narration,
    requested_seconds: variant.duration_seconds,
    adjustment: 'exact',
    adjustment_label: 'No adjustment',
    variant,
  }
}

function batchEligible(scene: MotionScene): boolean {
  return !usesImagePool.value
    && scopedMotionSceneIds.value.has(scene.id)
    && scene.approved
    && !!scene.image_filename
    && !!scene.motion_prompt?.trim()
    && !scene.clip_exists
    && scene.motion_choice !== 'still'
    && scene.end_sec - scene.start_sec >= animateMinSeconds.value
}
const batchPlans = computed(() => scenes.value.filter(batchEligible)
  .map(durationPlanForScene)
  .filter((plan): plan is DurationPlan => plan !== null))
const batchListedTotal = computed(() => batchPlans.value
  .reduce((total, plan) => total + plan.variant.credits_per_video, 0))
const existingClipCount = computed(() => scenes.value.filter(scene => scene.clip_exists).length)
const usesImagePool = computed(() => visualSource.value === 'image_pool')
const scopedMotionSceneIds = computed(() => new Set(motionSceneIds.value))
const motionScopeLabel = computed(() => {
  if (motionScope.value.mode === 'opening') return `Opening · first ${formatSeconds(motionScope.value.end_sec)}`
  if (motionScope.value.mode === 'selected') return 'Selected scenes'
  if (motionScope.value.mode === 'all') return 'Whole episode'
  return 'Off'
})
const motionCrossingLabel = computed(() => {
  const scenesAtBoundary = scenes.value.filter(scene => motionCrossingSceneIds.value.includes(scene.id))
  if (scenesAtBoundary.length === 1) return `Scene ${scenesAtBoundary[0]!.scene_index}`
  return `${scenesAtBoundary.length} scenes`
})
const scopedMotionScenes = computed(() => scenes.value.filter(scene => scopedMotionSceneIds.value.has(scene.id)))
const scopedClipCount = computed(() => scopedMotionScenes.value.filter(scene => scene.clip_exists).length)
const scopedMotionReviewed = computed(() => scopedMotionScenes.value.filter(scene => (
  scene.motion_choice === 'still'
  || (scene.clip_exists && !scene.clip_stale && (scene.motion_choice === 'clip' || scene.motion_choice == null))
)).length)
const allScopedMotionReviewed = computed(() => motionSceneIds.value.length > 0
  && scopedMotionReviewed.value === motionSceneIds.value.length)
const scenePlanMotionLink = computed(() => `/projects/${slug.value}/scene-plan?episode_id=${encodeURIComponent(episodeId.value)}#visual-timing`)

const clipJobsActive = computed(() => isJobActiveFor(episodeId.value, ['scene_clip_generate', 'scene_clips_batch']))
const selectionReady = computed(() => !!selectedResolution.value
  && !!selectedResolutionVariants.value.length
  && (durationMode.value === 'follow_narration' || !!selectedManualVariant.value)
  && !i2vModels.value.find(model => model.id === videoModel.value)?.disabled)
const canGenerate = computed(() => !usesImagePool.value && !!episodeId.value && !!videoModel.value
  && selectionReady.value && batchPlans.value.length > 0)
const generateStatus = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (usesImagePool.value) return 'Motion Review is not used for Image Pool episodes'
  if (!i2vModels.value.length) return 'GenStudio has no image-to-video models available'
  if (!videoModel.value) return 'Pick an image-to-video model'
  if (!selectedResolutionVariants.value.length) return 'Choose a published resolution'
  if (!canGenerate.value) return 'No approved missing clips are waiting for motion'
  return `${batchPlans.value.length} approved missing ${batchPlans.value.length === 1 ? 'clip is' : 'clips are'} ready`
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
  if (!ep) {
    resetEpisodeScopedMotionState()
    return
  }
  loading.value = true
  try {
    const result = await get<{
      scenes: MotionScene[]
      stats: MotionStats | null
      animate_min_seconds?: number
      motion_scope?: MotionScope
      motion_scene_ids?: string[]
      motion_crossing_scene_ids?: string[]
      motion_scope_error?: string
      visual_source?: 'scene_plan' | 'image_pool'
    }>(`/projects/${slug.value}/scene-review/${ep}`)
    if (requestSequence !== reviewLoadSequence || episodeId.value !== ep) return
    scenes.value = result.scenes || []
    stats.value = result.stats
    animateMinSeconds.value = Math.max(0, Number(result.animate_min_seconds) || 0)
    motionScope.value = result.motion_scope || { mode: 'off' }
    motionSceneIds.value = Array.isArray(result.motion_scene_ids) ? result.motion_scene_ids : []
    motionCrossingSceneIds.value = Array.isArray(result.motion_crossing_scene_ids) ? result.motion_crossing_scene_ids : []
    motionScopeError.value = typeof result.motion_scope_error === 'string' ? result.motion_scope_error : ''
    visualSource.value = result.visual_source === 'image_pool' ? 'image_pool' : 'scene_plan'
    cacheBuster.value = Date.now()
  } catch (error: any) {
    if (requestSequence !== reviewLoadSequence || episodeId.value !== ep) return
    showError(error?.data?.detail || error?.message || 'Could not load Motion Review')
  } finally {
    if (requestSequence === reviewLoadSequence && episodeId.value === ep) loading.value = false
  }
}

function generationPayload(): Record<string, string | number> | null {
  if (!videoModel.value || !selectionReady.value) return null
  return {
    model: videoModel.value,
    aspect_ratio: '16:9',
    operation: STORY_STUDIO_VIDEO_OPERATION,
    duration_mode: durationMode.value,
    resolution: selectedResolution.value,
    ...(durationMode.value === 'manual' && selectedManualVariant.value
      ? { duration_seconds: selectedManualVariant.value.duration_seconds }
      : {}),
  }
}

async function generateOne(scene: MotionScene) {
  if (usesImagePool.value || !scopedMotionSceneIds.value.has(scene.id)) return
  const payload = generationPayload()
  if (!payload) return
  animatingId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-clip`, {
      scene_id: scene.id,
      ...payload,
    })
    success(`Scene ${scene.scene_index} clip queued.`)
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not queue the clip')
  } finally {
    animatingId.value = null
  }
}

async function generateMissing() {
  const payload = generationPayload()
  if (!payload || !batchPlans.value.length) return
  queuing.value = true
  try {
    const result = await post<{ queued: number; skipped: number }>(`/projects/${slug.value}/scene-review/${episodeId.value}/generate-missing-clips`, {
      ...payload,
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
/**
 * v1.4.194 — episode-scoped state must not survive an episode change.
 *
 * `loadReview` only ever REPLACED these on a successful load, so switching
 * episodes left the previous episode's scenes, stats, motion scope and checked
 * ids on screen for the whole of the new load — and permanently if the new load
 * failed, with an error banner as the only sign anything was wrong. The image
 * URLs were stale too: `cacheBuster` was bumped only on success, so every
 * `.../image/${scene.id}?t=...` kept resolving to the PREVIOUS episode's cached
 * thumbnails at the previous episode's ids.
 *
 * AGENTS.md §4: an episode change REPLACES the field, or blanks it. This blanks
 * it, and announces nothing because there is nothing yet to announce — the load
 * that follows either fills it or reports its own failure.
 */
function resetEpisodeScopedMotionState() {
  scenes.value = []
  stats.value = null
  animateMinSeconds.value = 0
  motionScope.value = { mode: 'off' }
  motionSceneIds.value = []
  motionCrossingSceneIds.value = []
  motionScopeError.value = ''
  visualSource.value = 'scene_plan'
  cacheBuster.value = Date.now()
}

watch(episodeId, () => {
  renderedSceneLimit.value = SCENE_RENDER_BATCH
  resetEpisodeScopedMotionState()
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
.motion-scope-summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.motion-scope-summary h3 { margin: 0 0 4px; font-size: 16px; letter-spacing: -.015em; }
.motion-scope-summary p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.motion-scope-summary .motion-scope-crossing { margin-top: 5px; color: var(--warning, #d99558); }
.motion-scope-summary .motion-scope-error { margin-top: 5px; color: var(--danger, #d96a6a); }
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
.motion-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--motion-blue), var(--motion-green)); }
.motion-tool-row { display: grid; gap: 12px; padding-top: 17px; border-top: 1px solid var(--border); }
.motion-tool-heading { display: flex; flex-direction: column; gap: 3px; }
.motion-tool-heading strong { font-size: 13px; }
.motion-tool-heading span { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.motion-tools { display: grid; grid-template-columns: minmax(300px, 1.2fr) minmax(140px, .45fr) minmax(420px, 1.4fr) max-content max-content; align-items: end; justify-content: stretch; }
.model-field { min-width: 280px; }
.model-field > span, .media-label { display: block; margin-bottom: 6px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
.resolution-field { min-width: 150px; }
.duration-mode { display: flex; min-width: 360px; margin: 0; padding: 0; border: 0; gap: 7px; }
.duration-mode legend, .manual-duration-heading label { margin-bottom: 6px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
.duration-mode label { display: flex; flex: 1 1 0; align-items: flex-start; gap: 8px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-tertiary); cursor: pointer; }
.duration-mode label:has(input:checked) { border-color: color-mix(in srgb, var(--motion-blue) 70%, var(--border)); background: color-mix(in srgb, var(--motion-blue) 10%, var(--bg-tertiary)); }
.duration-mode input { margin-top: 2px; accent-color: var(--motion-blue); }
.duration-mode span { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.duration-mode strong { font-size: 12px; }
.duration-mode small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; }
.duration-mode:disabled label { cursor: not-allowed; opacity: .55; }
.manual-duration { grid-column: 1 / -1; grid-row: 2; width: min(100%, 760px); }
.manual-duration-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.manual-duration-heading span { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; }
.manual-duration-inputs { display: grid; grid-template-columns: minmax(150px, 1fr) 130px; align-items: center; gap: 10px; }
.manual-duration-inputs input[type='range'] { width: 100%; accent-color: var(--motion-blue); cursor: pointer; }
.duration-number-wrap { position: relative; }
.duration-number { width: 100%; padding-right: 53px; font-variant-numeric: tabular-nums; }
.duration-number-wrap > span { position: absolute; top: 50%; right: 10px; color: var(--text-muted); font-size: var(--font-xs); pointer-events: none; transform: translateY(-50%); }
.duration-help, .follow-duration-note span, .batch-cost span { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.duration-help { margin: 6px 0 0; }
.follow-duration-note { display: flex; grid-column: 1 / -1; grid-row: 2; max-width: 760px; flex-direction: column; gap: 3px; padding: 9px 11px; border-radius: 10px; background: color-mix(in srgb, var(--motion-blue) 9%, var(--bg-tertiary)); }
.follow-duration-note strong { font-size: 12px; }
.batch-cost { display: flex; grid-column: 1 / 4; grid-row: 3; min-width: 280px; align-items: baseline; justify-content: flex-start; gap: 5px 12px; flex-wrap: wrap; padding-top: 9px; border-top: 1px solid var(--border); text-align: left; }
.batch-cost strong { font-size: 13px; font-variant-numeric: tabular-nums; }
.motion-tools > .btn { grid-row: 3; align-self: center; }
.motion-tools > .btn:first-of-type { grid-column: 4; }
.motion-tools > .btn:last-child { grid-column: 5; }
input:focus-visible, select:focus-visible, .duration-mode label:has(input:focus-visible) { outline: 2px solid var(--motion-blue); outline-offset: 2px; }
/* Prose, not a field label — override the uppercase caption styling above. */
.model-field > span.model-audio-notice {
  margin: 6px 0 0; max-width: 46ch;
  color: var(--warning, #d97706); font-size: var(--font-xs); font-weight: 500;
  letter-spacing: normal; text-transform: none; line-height: 1.45;
}
.motion-ready { border-color: color-mix(in srgb, var(--motion-green) 65%, var(--border)); }

.motion-grid { display: grid; gap: 14px; padding: 0; list-style: none; }
.motion-list-more { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 14px; color: var(--text-muted); font-size: 12px; }
.motion-card { display: grid; grid-template-columns: minmax(380px, .9fr) minmax(320px, 1.1fr); gap: 18px; padding: 15px; border: 1px solid color-mix(in srgb, var(--motion-gold) 55%, var(--border)); border-radius: 14px; background: var(--bg-secondary); box-shadow: 0 6px 22px rgba(0,0,0,.07); transition: border-color .18s ease, transform .18s ease; content-visibility: auto; contain-intrinsic-size: auto 320px; }
.motion-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--motion-blue) 30%, var(--border)); }
.motion-card.choice-clip, .motion-card.choice-legacy { border-color: color-mix(in srgb, var(--motion-green) 55%, var(--border)); }
.motion-card.choice-still { border-color: color-mix(in srgb, var(--motion-blue) 55%, var(--border)); }
.media-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.media-box img, .media-box video, .missing-media { width: 100%; aspect-ratio: 16 / 9; border-radius: 9px; background: #0b0d0c; object-fit: contain; }
.missing-media { display: grid; place-items: center; border: 1px dashed var(--border); color: var(--text-muted); font-size: 12px; }
.motion-copy { min-width: 0; padding: 4px 2px; }
.scene-line { flex-wrap: wrap; }
.scene-line strong { font-size: 15px; }
.scene-line > span { color: var(--text-muted); font-size: 12px; }
.choice-badge { margin-left: auto; padding: 4px 9px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-primary) !important; font-weight: 650; }
.scene-duration-plan { display: grid; grid-template-columns: repeat(4, minmax(105px, 1fr)); gap: 7px; margin-top: 10px; }
.scene-duration-plan > span { display: flex; min-width: 0; flex-direction: column; gap: 2px; padding: 7px 8px; border-radius: 8px; background: var(--bg-tertiary); }
.scene-duration-plan small { color: var(--text-muted); font-size: var(--font-xs); letter-spacing: .04em; text-transform: uppercase; }
.scene-duration-plan strong { overflow-wrap: anywhere; font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
.scene-duration-plan.has-shortfall > span:nth-child(3) { background: color-mix(in srgb, var(--warning, #d97706) 13%, var(--bg-tertiary)); color: var(--warning, #d99558); }
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
  .motion-tools { grid-template-columns: minmax(280px, 1fr) minmax(140px, .45fr); }
  .duration-mode { grid-column: 1 / -1; grid-row: 2; }
  .manual-duration, .follow-duration-note { grid-column: 1 / -1; grid-row: 3; }
  .batch-cost { grid-column: 1 / -1; grid-row: 4; }
  .motion-tools > .btn { grid-row: 5; }
  .motion-tools > .btn:first-of-type { grid-column: 1; justify-self: start; }
  .motion-tools > .btn:last-child { grid-column: 2; justify-self: end; }
  .motion-card { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .motion-hero-route { display: none; }
  .motion-guide-grid { grid-template-columns: 1fr; }
  .motion-tool-row { align-items: stretch; }
}
@media (max-width: 640px) {
  .motion-scope-summary { align-items: stretch; flex-direction: column; }
  .motion-summary { align-items: flex-start; flex-direction: column; }
  .motion-summary-score, .model-field { width: 100%; min-width: 0; }
  .motion-tools { grid-template-columns: 1fr; align-items: stretch; }
  .motion-tools > *, .duration-mode, .manual-duration, .follow-duration-note, .batch-cost,
  .motion-tools > .btn:first-of-type, .motion-tools > .btn:last-child { grid-column: 1; grid-row: auto; justify-self: stretch; }
  .duration-mode { min-width: 0; flex-direction: column; }
  .manual-duration-inputs { grid-template-columns: 1fr; }
  .media-pair { grid-template-columns: 1fr; }
  .scene-duration-plan { grid-template-columns: 1fr 1fr; }
  .motion-actions { justify-content: stretch; }
  .motion-actions .btn { flex: 1 1 100%; }
  .back-to-top { right: 16px; bottom: 16px; }
}
</style>
