<!--
  Image Pool (slideshow) selection. Picks still images from an Image Pool
  (random, sized to narration, cross-episode no-repeat) and freezes the
  selection sidecar for Video Assembly. The editor then handles
  motion/overlays/logo/effects/subtitles/export and the standard final render.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Image Pool</h1>
    </div>

    <div class="card mt-2">
      <label class="ip-label">Episode</label>
      <EpisodeSelector v-model="episodeId" :project-slug="slug" filter-field="video_assembly" />
    </div>

    <p class="text-muted mt-2 mb-2" style="font-size: 13px;">
      Loads random images from your <strong>Image Pool</strong> (sized to the narration, no image
      reused within the pool's no-repeat window) as this episode's <strong>scenes</strong> — then
      you finish in the <strong>Video Assembly</strong> tab with the full editor (Ken Burns, transitions,
      overlays, logo, effects, subtitles, export). Audio is your merged narration + intro music.
    </p>

    <!-- 1. Pool subscription -->
    <section class="card mt-3">
      <h3>1. Image pool</h3>
      <p v-if="poolsError" class="ip-warn mt-2" role="alert">
        Could not load your image pools: {{ poolsError }}
        <button type="button" class="btn btn-sm btn-ghost" :disabled="poolsLoading" @click="loadPools">
          {{ poolsLoading ? 'Retrying…' : 'Retry' }}
        </button>
      </p>
      <p v-else-if="poolsLoading && !imagePools.length" class="text-muted text-sm mt-2">Loading image pools…</p>
      <template v-else-if="imagePools.length">
        <div class="ip-row mt-2">
          <select v-model="poolId" class="select" @change="saveSubscription">
            <option value="" disabled>Pick an image pool…</option>
            <option v-for="p in imagePools" :key="p.id" :value="p.id">
              {{ p.name }}{{ p.online ? '' : ' (offline)' }}
            </option>
          </select>
          <span v-if="selectedPool" class="text-muted text-sm">
            {{ poolImageCount == null ? '…' : `${poolImageCount} image(s)` }}
            · {{ selectedPool.online ? '● online' : '○ offline' }}
            · {{ selectedPool.slideshow?.seconds_per_image ?? 8 }}s default
            · no-repeat {{ selectedPool.slideshow?.dedup_lookback ?? 20 }} eps
          </span>
        </div>
        <p v-if="selectedPool && !selectedPool.online" class="ip-warn mt-1">
          🔌 Pool folder offline — connect it before picking.
        </p>
      </template>
      <p v-else class="text-muted text-sm mt-2">
        No image pools yet. Create one in the
        <NuxtLink :to="{ path: '/broll-library', query: { project: slug } }" class="text-accent">B-Roll Library</NuxtLink>
        (＋ Register pool → 🖼 Still images), point it at your image folder, then Re-scan.
      </p>
    </section>

    <!-- 2. Freeze a selection for Video Assembly -->
    <section v-if="poolId && episodeId" class="card mt-3">
      <h3>2. Pick images for this episode</h3>
      <p class="text-muted text-sm mt-1">
        Saves a new image sequence (replacing any earlier pick) and makes Image Pool the visual source for this episode.
        Then open the <strong>🎞 Video Assembly</strong> tab to add motion, overlays, logo, effects,
        subtitles, and export settings.
      </p>
      <div class="ip-row mt-2">
        <label class="ip-inline-label" title="Drives how many stills are frozen into this episode (narration ÷ this).">
          Seconds / image
          <input type="number" min="1" max="60" step="1" class="input ip-num" v-model.number="secondsPerImage" />
        </label>
        <label class="ip-inline-label" title="Avoid reusing an image used within this many recent episodes.">
          No-repeat window
          <input type="number" min="0" max="200" step="1" class="input ip-num" v-model.number="dedupLookback" />
        </label>
      </div>
      <div class="ip-actions mt-3">
        <button class="btn btn-primary" :disabled="pickingImages || !selectedPool?.online" @click="pickImagesForEpisode">
          {{ pickingImages ? 'Picking…' : '🖼 Use these images for this episode' }}
        </button>
        <span v-if="lastLoad" class="text-muted text-sm">
          ✓ Saved {{ lastLoad.count }} image(s) (~{{ Math.round(lastLoad.target_duration) }}s of narration).
          <NuxtLink :to="{ path: `/projects/${slug}/video-assembly`, query: { episode_id: episodeId } }" class="text-accent">Open the Video Assembly tab →</NuxtLink>
        </span>
      </div>
      <p class="text-muted text-xs mt-2">
        Need narration first? Run <NuxtLink :to="`/projects/${slug}/audio`" class="text-accent">Audio</NuxtLink>
        (+ <NuxtLink :to="`/projects/${slug}/audio-merge`" class="text-accent">Assembly</NuxtLink> if multi-part),
        then <NuxtLink :to="`/projects/${slug}/subtitles`" class="text-accent">Subtitles</NuxtLink>. The count is sized to the narration.
      </p>
    </section>

    <!-- 4. Grow the pool by generating images (optional) -->
    <section v-if="poolId" class="card mt-3">
      <h3 class="ip-grow-head" @click="showGrow = !showGrow">
        <span>3. Grow this pool — generate images (optional)</span>
        <span class="text-muted text-sm ds-chevron" aria-hidden="true" :class="{ 'is-open': showGrow }" />
      </h3>
      <template v-if="showGrow">
        <p class="text-muted text-sm mt-1">
          Generate new images straight into <strong>{{ selectedPool?.name }}</strong> and index them —
          a fast way to expand the pool. Uses your project's image model + key.
        </p>

        <!-- Optional: LLM-suggest prompts from a topic -->
        <div class="ip-grow-sub mt-2">
          <label class="ip-label">Suggest prompts from a topic (optional)</label>
          <div class="ip-row mt-1">
            <input v-model="suggestTopic" class="input ip-topic" placeholder="e.g. a capybara doing everyday human chores" />
            <input type="number" min="1" max="50" step="1" class="input ip-num" v-model.number="suggestCount" title="How many prompts to suggest" />
            <div class="ip-model-pick"><ModelSelector v-model="suggestModel" :project-slug="slug" /></div>
            <button class="btn btn-secondary btn-sm" :disabled="suggesting || !suggestTopic.trim() || !suggestModel" @click="suggestPrompts">
              {{ suggesting ? 'Thinking…' : '💡 Suggest' }}
            </button>
          </div>
        </div>

        <!-- Prompts -->
        <div class="mt-3">
          <label class="ip-label">Prompts — one per line</label>
          <textarea v-model="genPrompts" class="input ip-prompts mt-1" rows="6" placeholder="One image prompt per line…"></textarea>
          <span class="text-muted text-xs">{{ promptLines.length }} prompt(s) × {{ genVariants }} = {{ promptLines.length * genVariants }} image(s)</span>
        </div>

        <!-- Image model + variants + go -->
        <div class="ip-row mt-2">
          <div class="ip-model-pick">
            <ImageModelPicker
              v-model="genModel"
              :project-slug="slug"
              image-mode="text2img"
              default-label="Pick an image model…"
            />
          </div>
          <label class="ip-inline-label" title="Images to generate per prompt.">
            Variants
            <input type="number" min="1" max="4" step="1" class="input ip-num" v-model.number="genVariants" />
          </label>
        </div>
        <div v-if="selectedGenStudioModel" class="ip-genstudio-controls mt-2">
          <label class="ip-inline-label">
            Ratio
            <select v-model="genAspectRatio" class="select">
              <option v-for="ratio in selectedGenStudioModel.aspect_ratios" :key="ratio" :value="ratio">{{ ratio }}</option>
            </select>
          </label>
          <!-- No quality/steps control: The Gateway publishes no step contract
               and its image request has no `steps` field. -->
          <label v-if="selectedGenStudioModel.supports_seed !== false" class="ip-inline-label">
            Seed
            <input v-model.number="genSeed" class="input ip-seed" type="number" min="0" max="2147483647" placeholder="Random" />
          </label>
        </div>
        <!-- Published `(resolution, aspect_ratio)` rows for this model, each
             priced by the Gateway. Renders nothing when the model publishes none. -->
        <ImageOutputOptionPicker
          v-if="selectedGenStudioModel"
          v-model="genOutputOption"
          :model="selectedGenStudioModel"
          @switched="onOutputOptionSwitched"
        />
        <p v-if="selectedGenStudioModel" class="ip-cost" :class="`basis-${genBatchCost.basis}`" :title="genBatchCost.title">
          {{ CREDIT_BASIS_LABEL[genBatchCost.basis] }}: {{ genBatchCost.text }} <PriceDetails :cost="genBatchCost" />
        </p>
        <div class="ip-actions mt-3">
          <button class="btn btn-primary" :disabled="generating || !genModel || !promptLines.length || !selectedPool?.online" @click="generateIntoPool">
            {{ generating ? 'Queuing…' : `✨ Generate ${promptLines.length * genVariants || ''} into pool` }}
          </button>
          <span class="text-muted text-sm">
            Runs in the background — images land in the pool and the count above updates when it finishes. Watch the
            <NuxtLink :to="`/projects/${slug}/jobs`" class="text-accent">Jobs</NuxtLink> panel, then pick again.
          </span>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { findOutputOption, outputOptionsForRatio, type OutputOptionChoice } from '../../../utils/genstudio-output-options.js'
import { CREDIT_BASIS_LABEL, describeImageBatchEstimate } from '../../../utils/genstudio-credit-cost.js'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Image Pool')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, put } = useApi()
const { success, error: showError, info: showInfo } = useToast()
const broll = useBrollPools()
const { config, refreshConfig } = useProject()
const { jobs } = useJobs()
const { ask } = useConfirm()

const initialEpisodeId = typeof route.query.episode_id === 'string'
  ? route.query.episode_id
  : typeof route.query.episode === 'string'
    ? route.query.episode
    : ''
const episodeId = ref(initialEpisodeId)
const poolId = ref('')
const secondsPerImage = ref<number>(8)
const dedupLookback = ref<number>(20)
const poolImageCount = ref<number | null>(null)
const pickingImages = ref(false)
const lastLoad = ref<{ count: number; target_duration: number } | null>(null)

// v1.0.410 — "Grow this pool" (generate images into the pool).
const showGrow = ref(false)
const genPrompts = ref('')
const genModel = ref('')
const genVariants = ref<number>(1)
const genAspectRatio = ref('16:9')
const genSeed = ref<number | ''>('')
const generating = ref(false)
const suggestTopic = ref('')
const suggestCount = ref<number>(10)
const suggestModel = ref('')
const suggesting = ref(false)
const promptLines = computed(() => genPrompts.value.split('\n').map(l => l.trim()).filter(Boolean))
const { models: genStudioModels, refresh: refreshGenStudioModels } = useGenStudioImageModels()
const selectedGenStudioModel = computed(() => genStudioModels.value.find(model => model.id === genModel.value))
watch([genModel, () => genStudioModels.value.length], () => {
  const model = selectedGenStudioModel.value
  if (!model) return
  if (!model.aspect_ratios.includes(genAspectRatio.value)) genAspectRatio.value = model.default_aspect_ratio
})

/**
 * The published output row this pool run submits. `null` = the selected model
 * publishes no `output_options[]`, so no resolution is sent and GenStudio
 * applies its own default — the behaviour this page has always had.
 */
const genOutputOption = ref<OutputOptionChoice | null>(null)
/** A model switch that moved the pick is announced, never applied silently. */
function onOutputOptionSwitched(notice: string): void { showInfo(notice) }
// The chosen row owns the ratio, because the row IS the (resolution, ratio)
// pair GenStudio published. Keeping the ratio select in step means the run
// submits exactly the combination on screen.
watch(genOutputOption, (choice) => {
  if (choice?.aspect_ratio) genAspectRatio.value = choice.aspect_ratio
})
// ...and a ratio picked by hand moves the row with it: same size at the new
// ratio when published, otherwise no row (so no stale resolution is sent).
watch(genAspectRatio, (ratio) => {
  const current = genOutputOption.value
  if (!current || current.aspect_ratio === ratio) return
  const same = outputOptionsForRatio(selectedGenStudioModel.value, ratio).find(row => row.resolution === current.resolution)
  genOutputOption.value = same ? { resolution: same.resolution, aspect_ratio: same.aspect_ratio } : null
})
const genBatchCost = computed(() => describeImageBatchEstimate(
  selectedGenStudioModel.value,
  findOutputOption(selectedGenStudioModel.value, genOutputOption.value),
  promptLines.value.length * genVariants.value,
))

const imagePools = computed(() => (broll.pools.value || []).filter((p: any) => p.media === 'image'))
const selectedPool = computed(() => imagePools.value.find((p: any) => p.id === poolId.value) || null)
let imagePoolScopeSequence = 0

// Seed seconds/dedup from the selected pool's defaults whenever it changes.
watch(selectedPool, (p) => {
  if (p?.slideshow) {
    secondsPerImage.value = p.slideshow.seconds_per_image ?? 8
    dedupLookback.value = p.slideshow.dedup_lookback ?? 20
  }
  void loadPoolCount()
})

async function loadPoolCount(): Promise<void> {
  const requestedPoolId = poolId.value
  const project = slug.value
  const scope = imagePoolScopeSequence
  const current = () => scope === imagePoolScopeSequence && project === slug.value && poolId.value === requestedPoolId
  poolImageCount.value = null
  if (!requestedPoolId || !selectedPool.value?.online) return
  try {
    const r = await broll.listClips(requestedPoolId)
    if (!current()) return
    poolImageCount.value = (r.clips || []).filter((c: any) => !c.missing).length
  } catch {
    if (!current()) return
    poolImageCount.value = null
  }
}

async function saveSubscription(): Promise<void> {
  if (!poolId.value) return
  try {
    await put(`/projects/${slug.value}/settings/config`, { image_pool_id: poolId.value })
    success('Image pool saved for this project.')
    await loadPoolCount()
    await refreshConfig(slug.value).catch(() => {})
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save pool subscription')
  }
}

async function pickImagesForEpisode(): Promise<void> {
  if (!poolId.value || !episodeId.value || pickingImages.value) return
  if (!await ask({
    title: `Pick new images for ${episodeId.value}?`,
    message: `This saves a new random set from ${selectedPool.value?.name || 'this pool'}, replacing any images picked earlier for ${episodeId.value}, and switches its Video Assembly visuals to Image Pool (instead of scene images).`,
    confirmLabel: 'Use these images',
  })) return
  const request = ++imagePoolScopeSequence
  const project = slug.value
  const episode = episodeId.value
  const pool = poolId.value
  const current = () => request === imagePoolScopeSequence
    && project === slug.value && episode === episodeId.value && pool === poolId.value
  pickingImages.value = true
  try {
    const r = await post<{ selection?: any[]; images?: number; target_duration?: number; warnings?: string[] }>(
      `/projects/${slug.value}/image-pool/pick`,
      {
        episode_id: episodeId.value,
        pool_id: poolId.value,
        seconds_per_image: secondsPerImage.value,
        dedup_lookback: dedupLookback.value,
      },
    )
    if (!current()) return
    const count = Number(r.images ?? r.selection?.length ?? 0)
    for (const warning of r.warnings || []) showError(warning)
    await put(`/projects/${slug.value}/video-editor/visual-source/${encodeURIComponent(episodeId.value)}`, { source: 'image_pool' })
    if (!current()) return
    lastLoad.value = { count, target_duration: Number(r.target_duration || 0) }
    success(`Saved ${count} image(s) for ${episodeId.value} — Image Pool is now active in Video Assembly.`)
  } catch (e: any) {
    if (current()) showError(e?.data?.detail || e?.message || 'Failed to pick images')
  } finally {
    if (current()) pickingImages.value = false
  }
}

async function suggestPrompts(): Promise<void> {
  if (!suggestTopic.value.trim() || !suggestModel.value) return
  suggesting.value = true
  try {
    const r = await post<{ prompts: string[] }>(`/projects/${slug.value}/image-pool/suggest-prompts`, {
      topic: suggestTopic.value.trim(),
      count: suggestCount.value,
      model: suggestModel.value,
    })
    const lines = (r.prompts || []).join('\n')
    // Append to whatever's already there rather than clobbering.
    genPrompts.value = genPrompts.value.trim() ? `${genPrompts.value.trim()}\n${lines}` : lines
    success(`Added ${r.prompts.length} suggested prompt(s) — edit before generating.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to suggest prompts')
  } finally {
    suggesting.value = false
  }
}

async function generateIntoPool(): Promise<void> {
  if (!poolId.value || !genModel.value || !promptLines.value.length) return
  const total = promptLines.value.length * genVariants.value
  if (!await ask({
    title: `Generate ${total} image${total === 1 ? '' : 's'} into ${selectedPool.value?.name || 'this pool'}?`,
    message: `${CREDIT_BASIS_LABEL[genBatchCost.value.basis]}: ${genBatchCost.value.text}. The images are added to the pool folder.`,
    confirmLabel: 'Generate',
  })) return
  generating.value = true
  try {
    const job = await post<{ job_id?: string }>(`/projects/${slug.value}/image-pool/generate`, {
      pool_id: poolId.value,
      prompts: promptLines.value,
      model: genModel.value,
      aspect_ratio: selectedGenStudioModel.value ? genAspectRatio.value : '16:9',
      // Sent only when the customer picked a published row, so a model with no
      // output options keeps submitting exactly what it did before.
      resolution: genOutputOption.value?.resolution || undefined,
      seed: selectedGenStudioModel.value && selectedGenStudioModel.value.supports_seed !== false
        && typeof genSeed.value === 'number'
        ? genSeed.value
        : undefined,
      variants: genVariants.value,
    })
    growJobId.value = job?.job_id || ''
    success(`Queued generation of ${total} image(s) → watch the Jobs panel.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue generation')
  } finally {
    generating.value = false
  }
}

// When a "Grow this pool" job ends, re-count the pool so the new images show.
const growJobId = ref('')
watch(() => jobs.value.find(j => j.job_id === growJobId.value)?.status, (status) => {
  if (status !== 'done' && status !== 'error' && status !== 'cancelled') return
  growJobId.value = ''
  void loadPoolCount()
})

// A failed pool read is not "no pools": say so and offer Retry.
const poolsError = ref('')
const poolsLoading = ref(false)
async function loadPools(): Promise<void> {
  poolsLoading.value = true
  poolsError.value = ''
  try {
    await broll.loadPools()
    if (!poolId.value) {
      // Default the pool from the saved project subscription, else the only image pool.
      const saved = (config.value as any)?.image_pool_id
      if (saved && imagePools.value.some((p: any) => p.id === saved)) poolId.value = saved
      else if (imagePools.value.length === 1) poolId.value = imagePools.value[0].id
    }
  } catch (e: any) {
    poolsError.value = e?.data?.detail || e?.message || 'unknown error'
  } finally {
    poolsLoading.value = false
  }
}

// Project and episode changes invalidate the pool's transient selection state.
watch([slug, episodeId, poolId], () => {
  imagePoolScopeSequence++
  lastLoad.value = null
  pickingImages.value = false
}, { flush: 'sync' })

onMounted(async () => {
  void refreshGenStudioModels()
  await loadPools()
  await loadPoolCount()
})
</script>

<style scoped>
.ip-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; display: block; margin-bottom: 6px; }
.ip-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ip-row .select { min-width: 240px; max-width: 360px; }
.ip-inline-label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.ip-num { width: 80px; }
.ip-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ip-warn { color: #c97a4a; font-size: 13px; }
.text-accent { color: var(--accent); }
/* Grow-pool panel */
.ip-grow-head { display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; margin: 0; }
.ip-grow-sub { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-tertiary); }
.ip-topic { flex: 1 1 280px; min-width: 200px; }
.ip-prompts { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; resize: vertical; }
.ip-model-pick { min-width: 220px; max-width: 340px; flex: 0 1 300px; }
.ip-genstudio-controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.ip-genstudio-controls .select { min-width: 120px; }
.ip-cost { margin: 8px 0 0; font-size: var(--font-xs); color: var(--text); line-height: 1.4; }
.ip-cost.basis-unpublished { color: var(--warning, #d97706); }
.ip-cost.basis-free { color: var(--success, #16a34a); }
.ip-seed { width: 150px; }
</style>
