<!--
  v1.0.145+ — Final assembly page for the timestamp-driven pipeline.
  Mirrors the broll.vue page's shape: episode selector + status panel +
  Assemble button. The greenlight gate (computed from /scene-review/:ep
  stats) disables Assemble until every scene is approved.

  Output: <output_dir>/<code>_timestamp.mp4 where output_dir respects
  external_final_video_root (v1.0.130 pattern). Job log in the Jobs
  panel surfaces the final path.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Video Assembly</h1>
    </div>

    <VideoPipelineTabs />

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="episodeId"
      filter-field="video"
      generate-label="🎞 Assemble video"
      loading-label="Queuing…"
      :generate-loading="assembling"
      :generate-disabled="!canAssemble"
      :generate-status="assembleStatusText"
      @generate="assembleVideo"
    />

    <p class="text-muted mt-1 mb-2">
      This project uses the <strong>timestamp-driven</strong> pipeline.
      Final assembly renders each approved scene image across its
      planned <code>[start_sec, end_sec]</code> window with the merged
      audio underneath and the stitched subtitle burned in (when one
      exists).
    </p>

    <!-- Greenlight summary -->
    <section v-if="stats" class="card mt-3" :class="{ 'is-greenlit': stats.all_approved }">
      <h3 v-if="stats.all_approved">✅ Greenlit — every scene approved</h3>
      <h3 v-else>{{ stats.approved }} / {{ stats.total_scenes }} scenes approved
        <span class="text-muted text-sm">
          ({{ stats.with_image }} with images,
          {{ stats.total_scenes - stats.with_image }} missing images)
        </span>
      </h3>
      <p v-if="!stats.all_approved" class="text-muted text-sm mt-1">
        Open <NuxtLink :to="`/projects/${slug}/scene-review`" class="text-accent">Scene Review</NuxtLink>
        to generate any missing images and approve each scene.
        Assembly is gated on every scene being approved.
      </p>
    </section>

    <section v-else-if="!loading" class="card mt-3">
      <p class="text-muted text-sm">
        <strong>No scene plan yet.</strong>
        Open the <NuxtLink :to="`/projects/${slug}/scene-plan`" class="text-accent">Scene Plan</NuxtLink>
        page first (stitch subtitles + run the planner).
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Video Assembly (timestamp)')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { success, error: showError } = useToast()

const episodeId = ref('')

interface ReviewStats {
  total_scenes: number
  approved: number
  with_image: number
  all_approved: boolean
}
const stats = ref<ReviewStats | null>(null)
const loading = ref(false)
const assembling = ref(false)

const canAssemble = computed(() => {
  if (!episodeId.value) return false
  if (!stats.value) return false
  return stats.value.all_approved
})

const assembleStatusText = computed(() => {
  if (assembling.value) return `Queuing assembly for ${episodeId.value}…`
  if (!episodeId.value) return 'Pick an episode first'
  if (!stats.value) return 'No scene plan yet'
  if (!stats.value.all_approved) {
    const pending = stats.value.total_scenes - stats.value.approved
    return `${pending} scene${pending === 1 ? '' : 's'} not approved — open Scene Review`
  }
  return ''
})

async function loadStats(): Promise<void> {
  if (!episodeId.value) {
    stats.value = null
    return
  }
  loading.value = true
  try {
    const r = await get<{ stats: ReviewStats | null }>(`/projects/${slug.value}/scene-review/${episodeId.value}`)
    stats.value = r.stats
  } catch (e: any) {
    if (e?.__slugRace) return
  } finally {
    loading.value = false
  }
}

async function assembleVideo(): Promise<void> {
  if (!canAssemble.value) return
  assembling.value = true
  try {
    await post(`/projects/${slug.value}/scene-review/${episodeId.value}/assemble`, {})
    success('Timestamp video queued — watch the Jobs panel for ffmpeg progress.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue assembly')
  } finally {
    assembling.value = false
  }
}

onMounted(loadStats)
watch(episodeId, () => { void loadStats() })
</script>

<style scoped>
.is-greenlit {
  border: 2px solid #5bb37c;
  background: rgba(91, 179, 124, 0.06);
}
.is-greenlit h3 { color: #5bb37c; }
.text-accent { color: var(--accent); }
</style>
