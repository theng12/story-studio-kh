<!--
  v1.0.408 — Image Pool (slideshow) project page. The visual step for the
  `image-pool` format: pick still images from an Image Pool (random, sized to
  the narration, cross-episode no-repeat), then assemble the slideshow
  (crop-fill + Ken Burns + crossfade + burned-in subtitles + narration/music).
  Calls the backend's /image-pool/pick + /image-pool/assemble (built in
  v1.0.404 / v1.0.407); the heavy lifting reuses the proven B-Roll assembler.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Image Slideshow</h1>
    </div>

    <div class="card mt-2">
      <label class="ip-label">Episode</label>
      <EpisodeSelector v-model="episodeId" :project-slug="slug" />
    </div>

    <p class="text-muted mt-2 mb-2" style="font-size: 13px;">
      Builds a slideshow from your <strong>Image Pool</strong>: random images sized to the
      narration length, each held a few seconds with a slow Ken-Burns motion + crossfades,
      no image reused within the pool's no-repeat window. Subtitles (from the
      <NuxtLink :to="`/projects/${slug}/subtitles`" class="text-accent">Subtitles</NuxtLink>
      step) are burned in; audio is your merged narration + intro music.
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

    <!-- 2. Slideshow settings + pick -->
    <section v-if="poolId && episodeId" class="card mt-3">
      <h3>2. Pick images</h3>
      <div class="ip-row mt-2">
        <label class="ip-inline-label" title="How long each image holds on screen. Defaults to the pool's setting.">
          Seconds / image
          <input type="number" min="1" max="60" step="1" class="input ip-num" v-model.number="secondsPerImage" />
        </label>
        <label class="ip-inline-label" title="Avoid reusing an image used within this many recent episodes.">
          No-repeat window
          <input type="number" min="0" max="200" step="1" class="input ip-num" v-model.number="dedupLookback" />
        </label>
      </div>
      <div class="ip-actions mt-3">
        <button class="btn btn-primary" :disabled="picking || !selectedPool?.online" @click="pickImages">
          {{ picking ? 'Picking…' : '🎲 Pick images' }}
        </button>
        <span v-if="lastPick" class="text-muted text-sm">
          ✓ {{ lastPick.images }} image(s) · {{ lastPick.seconds_per_image }}s each
          · ~{{ Math.round(lastPick.target_duration) }}s total
          · avoided last {{ lastPick.dedup_lookback }} eps
          <template v-if="lastPick.pool_size_after_filter"> · pool {{ lastPick.pool_size_after_filter }}</template>
        </span>
      </div>
      <ul v-if="lastPick?.warnings?.length" class="ip-warn-list mt-2">
        <li v-for="(w, i) in lastPick.warnings" :key="i">⚠ {{ w }}</li>
      </ul>
    </section>

    <!-- 3. Assemble -->
    <section v-if="poolId && episodeId" class="card mt-3">
      <h3>3. Assemble slideshow</h3>
      <label class="ip-inline-label mt-2" title="Burn the episode's subtitle file (from the Subtitles step) into the video.">
        <input type="checkbox" v-model="burnSubtitles" /> Burn subtitles
      </label>
      <div class="ip-actions mt-3">
        <button class="btn btn-primary" :disabled="assembling || !hasSelection" @click="assemble">
          {{ assembling ? 'Queuing…' : '🎬 Assemble slideshow' }}
        </button>
        <span v-if="!hasSelection" class="text-muted text-sm">Pick images first.</span>
        <span v-else class="text-muted text-sm">
          Renders in the background — watch the
          <NuxtLink :to="`/projects/${slug}/jobs`" class="text-accent">Jobs</NuxtLink> panel.
        </span>
      </div>
      <p class="text-muted text-xs mt-2">
        Need narration first? Run <NuxtLink :to="`/projects/${slug}/audio`" class="text-accent">Audio</NuxtLink>
        (+ <NuxtLink :to="`/projects/${slug}/audio-merge`" class="text-accent">Assembly</NuxtLink> if multi-part),
        then <NuxtLink :to="`/projects/${slug}/subtitles`" class="text-accent">Subtitles</NuxtLink>. The slideshow is sized to the narration.
      </p>
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
const burnSubtitles = ref(true)
const picking = ref(false)
const assembling = ref(false)
const poolImageCount = ref<number | null>(null)
const hasSelection = ref(false)

interface PickResult {
  images: number
  seconds_per_image: number
  dedup_lookback: number
  target_duration: number
  pool_size_after_filter?: number
  warnings?: string[]
}
const lastPick = ref<PickResult | null>(null)

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

async function pickImages(): Promise<void> {
  if (!poolId.value || !episodeId.value) return
  picking.value = true
  try {
    const r = await post<PickResult>(`/projects/${slug.value}/image-pool/pick`, {
      episode_id: episodeId.value,
      pool_id: poolId.value,
      seconds_per_image: secondsPerImage.value,
      dedup_lookback: dedupLookback.value,
    })
    lastPick.value = r
    hasSelection.value = (r.images || 0) > 0
    success(`Picked ${r.images} image(s) for ${episodeId.value}.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to pick images')
  } finally {
    picking.value = false
  }
}

async function assemble(): Promise<void> {
  if (!episodeId.value) return
  assembling.value = true
  try {
    await post(`/projects/${slug.value}/image-pool/assemble`, {
      episode_id: episodeId.value,
      subtitles_enabled: burnSubtitles.value,
    })
    success('Slideshow assembly queued — watch the Jobs panel.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue assembly')
  } finally {
    assembling.value = false
  }
}

// A fresh pick is required per episode (the selection sidecar is per-episode).
watch(episodeId, () => { lastPick.value = null; hasSelection.value = false })

onMounted(async () => {
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
</style>
