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

    <!-- v1.0.265 — Assembly settings. All optional; defaults reproduce the
         prior output. Applied on the next "Assemble video". -->
    <section v-if="stats" class="card mt-3">
      <h3>Assembly settings <span class="text-muted text-sm">— applied on the next assemble</span></h3>

      <div class="ta-grid mt-2">
        <!-- Export -->
        <div class="ta-group">
          <h4>Export</h4>
          <div class="form-group">
            <label>Resolution</label>
            <select v-model="form.resolution" class="select">
              <option value="720p">720p (1280×720)</option>
              <option value="1080p">1080p (1920×1080)</option>
              <option value="1440p">1440p (2560×1440)</option>
              <option value="4k">4K (3840×2160)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Frame rate: <strong>{{ form.fps }} fps</strong></label>
            <select v-model.number="form.fps" class="select">
              <option :value="24">24</option>
              <option :value="25">25</option>
              <option :value="30">30</option>
              <option :value="60">60</option>
            </select>
          </div>
          <div class="form-group">
            <label>Quality (CRF): <strong>{{ form.crf }}</strong> <span class="text-muted text-xs">lower = better/bigger</span></label>
            <input v-model.number="form.crf" type="range" min="14" max="30" step="1" class="ta-range" />
          </div>
        </div>

        <!-- Subtitles -->
        <div class="ta-group">
          <h4>Subtitles</h4>
          <label class="ta-check">
            <input type="checkbox" v-model="form.sub_enabled" /> Burn in subtitles (when a stitched SRT exists)
          </label>
          <template v-if="form.sub_enabled">
            <div class="form-group">
              <label>Placement</label>
              <select v-model="form.sub_position" class="select">
                <option value="bottom">Bottom</option>
                <option value="center">Center</option>
                <option value="top">Top</option>
              </select>
            </div>
            <div class="form-group">
              <label>Font size: <strong>{{ form.sub_font_size }}</strong></label>
              <input v-model.number="form.sub_font_size" type="range" min="12" max="48" step="1" class="ta-range" />
            </div>
            <div class="ta-row">
              <div class="form-group">
                <label>Colour</label>
                <input v-model="form.sub_color" type="color" class="ta-color" />
              </div>
              <div class="form-group">
                <label>Outline: <strong>{{ form.sub_outline }}</strong></label>
                <input v-model.number="form.sub_outline" type="range" min="0" max="5" step="1" class="ta-range" />
              </div>
            </div>
          </template>
        </div>

        <!-- Transitions -->
        <div class="ta-group">
          <h4>Scene transitions</h4>
          <div class="form-group">
            <label>Type</label>
            <select v-model="form.transition_type" class="select">
              <option value="none">None (hard cuts) — fastest</option>
              <option value="crossfade">Crossfade (dissolve)</option>
              <option value="dissolve">Dissolve (pixelate)</option>
              <option value="fadeblack">Fade through black</option>
            </select>
          </div>
          <div v-if="form.transition_type !== 'none'" class="form-group">
            <label>Duration: <strong>{{ form.transition_duration.toFixed(1) }}s</strong></label>
            <input v-model.number="form.transition_duration" type="range" min="0.2" max="2" step="0.1" class="ta-range" />
            <p class="text-muted text-xs mt-1">
              Transitions overlap each scene image and re-encode — slower + heavier than hard cuts, especially on episodes with many scenes. Try a short one first.
            </p>
          </div>
        </div>

        <!-- Background music -->
        <div class="ta-group">
          <h4>Background music <span class="text-muted text-xs">(optional)</span></h4>
          <div class="form-group">
            <label>Audio file path <span class="text-muted text-xs">(.mp3 / .wav / .m4a)</span></label>
            <input v-model="form.music_path" class="input" placeholder="/absolute/path/to/music.mp3" />
          </div>
          <template v-if="form.music_path.trim()">
            <div class="form-group">
              <label>Volume: <strong>{{ Math.round(form.music_volume * 100) }}%</strong></label>
              <input v-model.number="form.music_volume" type="range" min="0" max="1" step="0.01" class="ta-range" />
            </div>
            <div class="form-group">
              <label>Fade in/out: <strong>{{ form.music_fade }}s</strong></label>
              <input v-model.number="form.music_fade" type="range" min="0" max="10" step="1" class="ta-range" />
            </div>
          </template>
        </div>

        <!-- Ambient bed -->
        <div class="ta-group">
          <h4>Ambient sound <span class="text-muted text-xs">(optional)</span></h4>
          <div class="form-group">
            <label>Audio file path <span class="text-muted text-xs">(.mp3 / .wav / .m4a)</span></label>
            <input v-model="form.ambient_path" class="input" placeholder="/absolute/path/to/ambient.mp3" />
          </div>
          <template v-if="form.ambient_path.trim()">
            <div class="form-group">
              <label>Volume: <strong>{{ Math.round(form.ambient_volume * 100) }}%</strong></label>
              <input v-model.number="form.ambient_volume" type="range" min="0" max="1" step="0.01" class="ta-range" />
            </div>
            <div class="form-group">
              <label>Fade in/out: <strong>{{ form.ambient_fade }}s</strong></label>
              <input v-model.number="form.ambient_fade" type="range" min="0" max="10" step="1" class="ta-range" />
            </div>
          </template>
        </div>
      </div>
      <p class="text-muted text-xs mt-2">
        Music + ambient are mixed under the narration at the volumes above (looped + faded to fit). Settings are remembered per-Mac.
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

// v1.0.265 — assembly controls (music/ambient beds, subtitle placement, export,
// transitions). Remembered per-Mac across reloads. Defaults reproduce the prior
// output exactly (no beds, bottom subs, 1080p/30/crf20, hard cuts).
const form = ref({
  resolution: '1080p' as '720p' | '1080p' | '1440p' | '4k',
  fps: 30,
  crf: 20,
  sub_enabled: true,
  sub_position: 'bottom' as 'bottom' | 'center' | 'top',
  sub_font_size: 24,
  sub_color: '#FFFFFF',
  sub_outline: 2,
  music_path: '',
  music_volume: 0.15,
  music_fade: 2,
  ambient_path: '',
  ambient_volume: 0.12,
  ambient_fade: 2,
  transition_type: 'none' as 'none' | 'crossfade' | 'fadeblack' | 'dissolve',
  transition_duration: 0.5,
})
useRememberedForm('timestamp-assemble', slug, form)

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
    const f = form.value
    await post(`/projects/${slug.value}/scene-review/${episodeId.value}/assemble`, {
      export_settings: { resolution: f.resolution, fps: f.fps, crf: f.crf },
      subtitles: {
        enabled: f.sub_enabled,
        position: f.sub_position,
        font_size: f.sub_font_size,
        color: f.sub_color,
        outline: f.sub_outline,
      },
      music: f.music_path.trim() ? { path: f.music_path.trim(), volume: f.music_volume, fade: f.music_fade } : undefined,
      ambient: f.ambient_path.trim() ? { path: f.ambient_path.trim(), volume: f.ambient_volume, fade: f.ambient_fade } : undefined,
      transition: { type: f.transition_type, duration: f.transition_duration },
    })
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

/* v1.0.265 — assembly settings panel */
.ta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 18px;
}
.ta-group { display: flex; flex-direction: column; gap: 8px; }
.ta-group h4 { margin: 0 0 2px; font-size: 13px; }
.ta-row { display: flex; gap: 12px; }
.ta-row .form-group { flex: 1; }
.ta-check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.ta-range { width: 100%; }
.ta-color { width: 48px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: none; cursor: pointer; }
</style>
