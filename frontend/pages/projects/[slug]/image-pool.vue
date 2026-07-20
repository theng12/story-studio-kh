<!--
  v1.0.411 — Image Pool (slideshow) page, now the "load images" front door for
  the unified Video Assembly pivot. Picks still images from an Image Pool
  (random, sized to narration, cross-episode no-repeat) and materializes them as
  the episode's SCENE IMAGES (`POST /image-pool/materialize`), so the full Scenes
  Video Assembly editor handles motion/overlays/logo/effects/subtitles/export and
  the standard video_assembly status. Also hosts "Grow this pool" (generate
  images). The bespoke slideshow assembler (pick/assemble) is retired.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Video Assembly</h1>
    </div>

    <div class="card mt-2">
      <label class="ip-label">Episode</label>
      <EpisodeSelector v-model="episodeId" :project-slug="slug" filter-field="video_assembly" />
    </div>

    <p class="text-muted mt-2 mb-2" style="font-size: 13px;">
      Loads random images from your <strong>Image Pool</strong> (sized to the narration, no image
      reused within the pool's no-repeat window) as this episode's <strong>scenes</strong> — then
      you finish in the <strong>Scenes</strong> tab with the full editor (Ken Burns, transitions,
      overlays, logo, effects, subtitles, export). Audio is your merged narration + intro music.
    </p>

    <!-- 1. Pool subscription -->
    <section class="card mt-3">
      <h3>1. Image pool</h3>
      <template v-if="imagePools.length">
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
        <NuxtLink to="/broll-library" class="text-accent">B-Roll Library</NuxtLink>
        (＋ Register pool → 🖼 Still images), point it at your image folder, then Re-scan.
      </p>
    </section>

    <!-- 2. Load images into Video Assembly (the pivot bridge) -->
    <section v-if="poolId && episodeId" class="card mt-3">
      <h3>2. Load images into Video Assembly</h3>
      <p class="text-muted text-sm mt-1">
        Picks the images and sets them as this episode's <strong>scenes</strong>. Then open the
        <strong>🎞 Scenes</strong> tab above to add motion / overlays / logo / effects / subtitles and render —
        the slideshow gets the full editor (and the standard final video shows on the board + upload).
      </p>
      <div class="ip-row mt-2">
        <label class="ip-inline-label" title="Drives how many images are loaded (narration ÷ this). You set the actual on-screen pacing in the Scenes tab's recycling control.">
          Seconds / image
          <input type="number" min="1" max="60" step="1" class="input ip-num" v-model.number="secondsPerImage" />
        </label>
        <label class="ip-inline-label" title="Avoid reusing an image used within this many recent episodes.">
          No-repeat window
          <input type="number" min="0" max="200" step="1" class="input ip-num" v-model.number="dedupLookback" />
        </label>
      </div>
      <div class="ip-actions mt-3">
        <button class="btn btn-primary" :disabled="loadingScenes || !selectedPool?.online" @click="loadIntoVideoAssembly">
          {{ loadingScenes ? 'Loading…' : '📥 Load images as scenes' }}
        </button>
        <span v-if="lastLoad" class="text-muted text-sm">
          ✓ Loaded {{ lastLoad.count }} image(s) (~{{ Math.round(lastLoad.target_duration) }}s of narration).
          <NuxtLink :to="`/projects/${slug}/video-assembly`" class="text-accent">Open the Scenes tab →</NuxtLink>
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
        <span class="text-muted text-sm">{{ showGrow ? '▾' : '▸' }}</span>
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
              :image-models="config?.image_models || {}"
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
          <label class="ip-inline-label">
            Quality
            <select v-model="genQuality" class="select" @change="applyGenStudioQuality">
              <option value="draft">Draft</option>
              <option value="balanced">Balanced</option>
              <option value="detailed">Detailed</option>
              <option value="maximum">Maximum</option>
              <option value="custom">Custom steps</option>
            </select>
          </label>
          <label class="ip-inline-label">
            Steps
            <input v-model.number="genSteps" class="input ip-num" type="number" :min="selectedGenStudioModel.min_steps" :max="selectedGenStudioModel.max_steps" @input="genQuality = 'custom'" />
          </label>
          <label class="ip-inline-label">
            Seed
            <input v-model.number="genSeed" class="input ip-seed" type="number" min="0" max="2147483647" placeholder="Random" />
          </label>
        </div>
        <div class="ip-actions mt-3">
          <button class="btn btn-primary" :disabled="generating || !genModel || !promptLines.length || !selectedPool?.online" @click="generateIntoPool">
            {{ generating ? 'Queuing…' : `✨ Generate ${promptLines.length * genVariants || ''} into pool` }}
          </button>
          <span class="text-muted text-sm">
            Runs in the background — images land in the pool + get indexed. Watch the
            <NuxtLink :to="`/projects/${slug}/jobs`" class="text-accent">Jobs</NuxtLink> panel, then Re-pick.
          </span>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Image Slideshow')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const broll = useBrollPools()
const { config, reload: reloadConfig } = useProject() as any

const episodeId = ref('')
const poolId = ref('')
const secondsPerImage = ref<number>(8)
const dedupLookback = ref<number>(20)
const poolImageCount = ref<number | null>(null)
const loadingScenes = ref(false)
const lastLoad = ref<{ count: number; target_duration: number } | null>(null)

// v1.0.410 — "Grow this pool" (generate images into the pool).
const showGrow = ref(false)
const genPrompts = ref('')
const genModel = ref('')
const genVariants = ref<number>(1)
const genAspectRatio = ref('16:9')
const genQuality = ref<'draft' | 'balanced' | 'detailed' | 'maximum' | 'custom'>('balanced')
const genSteps = ref(4)
const genSeed = ref<number | ''>('')
const generating = ref(false)
const suggestTopic = ref('')
const suggestCount = ref<number>(10)
const suggestModel = ref('')
const suggesting = ref(false)
const promptLines = computed(() => genPrompts.value.split('\n').map(l => l.trim()).filter(Boolean))
const { models: genStudioModels, refresh: refreshGenStudioModels } = useGenStudioImageModels()
const selectedGenStudioModel = computed(() => genStudioModels.value.find(model => model.id === genModel.value))
const genStudioQualitySteps = computed(() => {
  const model = selectedGenStudioModel.value
  if (!model) return { draft: 2, balanced: 4, detailed: 6, maximum: 8 }
  return {
    draft: model.min_steps,
    balanced: model.default_steps,
    detailed: Math.min(model.max_steps, model.default_steps + 2),
    maximum: model.max_steps,
  }
})

function applyGenStudioQuality(): void {
  if (genQuality.value === 'custom') return
  genSteps.value = genStudioQualitySteps.value[genQuality.value]
}

watch([genModel, () => genStudioModels.value.length], () => {
  const model = selectedGenStudioModel.value
  if (!model) return
  if (!model.aspect_ratios.includes(genAspectRatio.value)) genAspectRatio.value = model.default_aspect_ratio
  genSteps.value = Math.max(model.min_steps, Math.min(model.max_steps, Number(genSteps.value) || model.default_steps))
  if (genQuality.value !== 'custom') applyGenStudioQuality()
})

const imagePools = computed(() => (broll.pools.value || []).filter((p: any) => p.media === 'image'))
const selectedPool = computed(() => imagePools.value.find((p: any) => p.id === poolId.value) || null)

// Seed seconds/dedup from the selected pool's defaults whenever it changes.
watch(selectedPool, (p) => {
  if (p?.slideshow) {
    secondsPerImage.value = p.slideshow.seconds_per_image ?? 8
    dedupLookback.value = p.slideshow.dedup_lookback ?? 20
  }
  void loadPoolCount()
})

async function loadPoolCount(): Promise<void> {
  poolImageCount.value = null
  if (!poolId.value || !selectedPool.value?.online) return
  try {
    const r = await broll.listClips(poolId.value)
    poolImageCount.value = (r.clips || []).filter((c: any) => !c.missing).length
  } catch { poolImageCount.value = null }
}

async function saveSubscription(): Promise<void> {
  if (!poolId.value) return
  try {
    await put(`/projects/${slug.value}/settings/config`, { image_pool_id: poolId.value })
    success('Image pool saved for this project.')
    await loadPoolCount()
    if (reloadConfig) await reloadConfig(slug.value).catch(() => {})
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save pool subscription')
  }
}

async function loadIntoVideoAssembly(): Promise<void> {
  if (!poolId.value || !episodeId.value) return
  loadingScenes.value = true
  try {
    const r = await post<{ count: number; target_duration: number }>(
      `/projects/${slug.value}/image-pool/materialize`,
      {
        episode_id: episodeId.value,
        pool_id: poolId.value,
        seconds_per_image: secondsPerImage.value,
        dedup_lookback: dedupLookback.value,
      },
    )
    lastLoad.value = { count: r.count, target_duration: r.target_duration }
    success(`Loaded ${r.count} image(s) as scenes for ${episodeId.value} — open the Scenes tab to finish.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to load images')
  } finally {
    loadingScenes.value = false
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
  generating.value = true
  try {
    await post(`/projects/${slug.value}/image-pool/generate`, {
      pool_id: poolId.value,
      prompts: promptLines.value,
      model: genModel.value,
      aspect_ratio: selectedGenStudioModel.value ? genAspectRatio.value : '16:9',
      image_steps: selectedGenStudioModel.value ? genSteps.value : undefined,
      seed: selectedGenStudioModel.value && typeof genSeed.value === 'number' ? genSeed.value : undefined,
      variants: genVariants.value,
    })
    success(`Queued generation of ${promptLines.value.length * genVariants.value} image(s) → watch the Jobs panel.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue generation')
  } finally {
    generating.value = false
  }
}

// Per-episode load state resets when the episode changes.
watch(episodeId, () => { lastLoad.value = null })

onMounted(async () => {
  void refreshGenStudioModels()
  await broll.loadPools().catch(() => {})
  // Default the pool from the saved project subscription, else the first image pool.
  const saved = (config?.value as any)?.image_pool_id
  if (saved && imagePools.value.some((p: any) => p.id === saved)) poolId.value = saved
  else if (imagePools.value.length === 1) poolId.value = imagePools.value[0].id
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
.ip-warn-list { margin: 0; padding-left: 18px; color: #c97a4a; font-size: 12px; }
.text-accent { color: var(--accent); }
/* Grow-pool panel */
.ip-grow-head { display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; margin: 0; }
.ip-grow-sub { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-tertiary); }
.ip-topic { flex: 1 1 280px; min-width: 200px; }
.ip-prompts { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; resize: vertical; }
.ip-model-pick { min-width: 220px; max-width: 340px; flex: 0 1 300px; }
.ip-genstudio-controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.ip-genstudio-controls .select { min-width: 120px; }
.ip-seed { width: 150px; }
</style>
