<!--
  Per-project B-Roll picker — only relevant for projects whose format
  declares visualSource: 'broll' (prayer / devotional / narration-over-
  stock formats). Mounted at /projects/:slug/broll, accessible via the
  format-aware sidebar entry. v1.0.89+.

  Surfaces:
   1. Pool subscription — which app-level B-Roll pool this project uses
   2. Episode selection — pick which episode this B-Roll selection feeds
   3. Selection mode — random / tag-filtered / themed / manual
   4. Pacing — timed segments (N sec each) vs rotate-on-end
   5. Transitions + B-Roll volume (mute / duck / full)
   6. Repeat avoidance — within-episode always on; cross-episode lookback
   7. Generated sequence preview + "Assemble video" trigger

  Phase 2 ships subscription + episode selection only; full selection
  + render fires in Phase 3.
-->
<template>
  <div class="broll-page">
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">🎬 B-Roll Picker</h1>
    </div>

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="form.episode_id"
      filter-field="video"
      generate-label="Pick B-Roll for this episode"
      :generate-loading="picking"
      :generate-disabled="!subscribedPool || !form.episode_id || picking"
      :generate-status="picking ? `Selecting clips for ${form.episode_id}…` : ''"
      @generate="pickClips"
    />

    <p class="text-muted text-sm mt-2">
      This project uses the <strong>B-Roll Narration</strong> format. Scene Prompts / Scene
      Generator pages are hidden — the video's visual layer comes from your subscribed app-level
      B-Roll pool instead.
    </p>

    <!-- ── Pool subscription ─────────────────────────────────────── -->
    <section class="card mt-3">
      <h3>1. Pool subscription</h3>
      <div v-if="loadingPools" class="text-muted text-sm">Loading pools…</div>
      <div v-else-if="!pools.length" class="empty">
        No B-Roll pools registered on this Mac yet.
        <NuxtLink to="/broll-library">Open the B-Roll Library</NuxtLink> to register a pool first.
      </div>
      <div v-else class="pool-picker">
        <label>Pool for this project:</label>
        <select v-model="subscribedPoolId" class="select" @change="saveSubscription">
          <option value="">— pick a pool —</option>
          <option v-for="p in pools" :key="p.id" :value="p.id">
            {{ p.name }}{{ !p.online ? ' (offline)' : '' }}
          </option>
        </select>
        <NuxtLink to="/broll-library" class="text-sm">Manage pools →</NuxtLink>
      </div>
      <div v-if="subscribedPool && !subscribedPool.online" class="offline-banner mt-2">
        🔌 The pool's SSD isn't connected. Plug in <code>{{ subscribedPool.folder_path }}</code>
        before generating a selection.
      </div>
    </section>

    <!-- ── Selection settings ─────────────────────────────────────── -->
    <section v-if="subscribedPool" class="card mt-3">
      <h3>2. Selection settings</h3>
      <div class="grid-2">
        <div class="form-group">
          <label>Selection mode</label>
          <select v-model="form.selection_mode" class="select">
            <option value="random">Random — shuffle the whole pool</option>
            <option value="tagged">Tag-filtered — pool clips matching ANY of the selected tags</option>
            <option value="themed">Themed — pool clips matching ALL of the selected tags</option>
            <option value="manual">Manual — pick clips and order yourself (Phase 3)</option>
          </select>
          <span class="hint">
            Random ignores tags entirely. Tagged matches any of the picked tags (broader pool).
            Themed requires every selected tag (narrower pool — best for episode-specific themes
            like "sunrise + nature + water").
          </span>
        </div>

        <div v-if="form.selection_mode === 'tagged' || form.selection_mode === 'themed'" class="form-group">
          <label>Tags to match</label>
          <ChipInput
            v-model="form.tags"
            :suggestions="availableTags"
            placeholder="add a tag…"
            allow-custom
          />
          <span class="hint">
            Tags pulled from the pool. <strong>{{ matchingClipCount }}</strong> clip(s) match the
            current filter.
          </span>
        </div>
      </div>

      <div class="grid-2 mt-2">
        <div class="form-group">
          <label>Pacing</label>
          <div class="radio-row">
            <label><input type="radio" value="timed" v-model="form.pacing_mode" /> Timed segments</label>
            <label><input type="radio" value="rotate" v-model="form.pacing_mode" /> Rotate on clip end</label>
          </div>
          <div v-if="form.pacing_mode === 'timed'" class="mt-1">
            <label class="text-xs text-muted">Segment length (seconds)</label>
            <input v-model.number="form.segment_seconds" type="number" min="2" max="60" class="input input-sm" />
          </div>
          <span class="hint">
            <strong>Timed</strong> = each clip plays for N seconds regardless of native length.
            Clips shorter than N loop; longer clips are truncated.
            <strong>Rotate</strong> = each clip plays to its natural end, then switches.
            More natural pacing but unpredictable cut frequency.
          </span>
        </div>

        <div class="form-group">
          <label>B-Roll audio volume</label>
          <div class="volume-row">
            <input v-model.number="form.broll_volume" type="range" min="0" max="100" class="volume-slider" />
            <span class="volume-value">{{ form.broll_volume }}%</span>
            <button class="btn btn-ghost btn-sm" @click="form.broll_volume = 0" :title="'Strip B-Roll audio entirely'">
              🔇 Mute
            </button>
          </div>
          <span class="hint">
            0% = silence (recommended for prayer / devotional). 10–20% = ducked ambient texture.
            100% = unmuted. Narration mixed on top regardless.
          </span>
        </div>
      </div>

      <div class="form-group mt-2">
        <label>Repeat avoidance</label>
        <div class="checkbox-row">
          <label><input type="checkbox" checked disabled /> Within episode (always on)</label>
          <label>
            <input type="checkbox" :checked="form.broll_lookback > 0" @change="(e: any) => form.broll_lookback = e.target.checked ? 10 : 0" />
            Across recent episodes — last
            <input
              v-model.number="form.broll_lookback"
              type="number"
              min="0"
              max="100"
              class="input input-sm input-inline"
              :disabled="form.broll_lookback === 0"
            />
            uploads from this channel
          </label>
        </div>
        <span class="hint">
          A clip used in any of the last N uploads is excluded from the candidate pool for this
          episode. Set to 0 to allow repeats freely (useful when your pool is small).
        </span>
      </div>
    </section>

    <!-- ── Selected sequence preview ──────────────────────────────── -->
    <section v-if="selection.length" class="card mt-3">
      <h3>3. Selected sequence ({{ selection.length }} clips · {{ formatDuration(selectionDuration) }})</h3>
      <div class="sequence-row">
        <div v-for="(s, idx) in selection" :key="idx" class="seq-tile" :title="`${s.filename} · ${formatDuration(s.target_duration)}`">
          <img :src="thumbnailUrl(s.pool_id, s.filename)" :alt="s.filename" class="seq-thumb" />
          <span class="seq-idx">{{ idx + 1 }}</span>
          <span class="seq-duration">{{ formatDuration(s.target_duration) }}</span>
        </div>
      </div>
      <div class="seq-actions mt-2">
        <button
          class="btn btn-primary"
          :disabled="!form.episode_id || assembling"
          @click="assembleVideo"
        >
          <LoadingSpinner v-if="assembling" size="sm" />
          🎞 Assemble video
        </button>
        <button class="btn btn-ghost" @click="pickClips" :disabled="picking">
          ↻ Re-pick (different shuffle)
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, reactive } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('B-Roll Picker')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const broll = useBrollPools()

const pools = broll.pools
const loadingPools = broll.loading

const subscribedPoolId = ref<string>('')
const subscribedPool = computed(() => pools.value.find(p => p.id === subscribedPoolId.value) || null)

const clipsInPool = ref<any[]>([])
const availableTags = ref<string[]>([])

const form = reactive({
  episode_id: '',
  selection_mode: 'random' as 'random' | 'tagged' | 'themed' | 'manual',
  tags: [] as string[],
  pacing_mode: 'rotate' as 'timed' | 'rotate',
  segment_seconds: 8,
  broll_volume: 0,
  broll_lookback: 10,
})

const matchingClipCount = computed(() => {
  if (form.selection_mode === 'random' || form.selection_mode === 'manual') return clipsInPool.value.length
  const tagSet = new Set(form.tags.map(t => t.toLowerCase()))
  if (!tagSet.size) return 0
  return clipsInPool.value.filter(c => {
    const clipTags = new Set((c.tags || []).map((t: string) => t.toLowerCase()))
    if (form.selection_mode === 'tagged') {
      // ANY match
      for (const t of tagSet) if (clipTags.has(t)) return true
      return false
    }
    // themed = ALL match
    for (const t of tagSet) if (!clipTags.has(t)) return false
    return true
  }).length
})

const selection = ref<Array<{ pool_id: string; filename: string; target_duration: number }>>([])
const selectionDuration = computed(() => selection.value.reduce((s, c) => s + c.target_duration, 0))

const picking = ref(false)
const assembling = ref(false)

// ── Init ───────────────────────────────────────────────────────────────

async function loadConfig(): Promise<void> {
  try {
    const cfg = await get<any>(`/projects/${slug.value}/settings/config`)
    subscribedPoolId.value = cfg?.broll_pool_id || ''
    form.broll_lookback = cfg?.broll_lookback ?? 10
  } catch { /* tolerate */ }
}

async function loadPoolClips(): Promise<void> {
  if (!subscribedPoolId.value) {
    clipsInPool.value = []
    availableTags.value = []
    return
  }
  try {
    const r = await broll.listClips(subscribedPoolId.value)
    clipsInPool.value = r.clips.filter((c: any) => !c.missing)
    const allTags = new Set<string>()
    for (const c of clipsInPool.value) for (const t of (c.tags || [])) allTags.add(t)
    availableTags.value = Array.from(allTags).sort()
  } catch {
    clipsInPool.value = []
    availableTags.value = []
  }
}

watch(subscribedPoolId, () => { void loadPoolClips() })

onMounted(async () => {
  await broll.loadPools()
  await loadConfig()
  await loadPoolClips()
})

// ── Pool subscription ──────────────────────────────────────────────────

async function saveSubscription(): Promise<void> {
  try {
    await put(`/projects/${slug.value}/settings/config`, {
      broll_pool_id: subscribedPoolId.value || undefined,
    })
    success(subscribedPoolId.value ? 'Pool subscribed' : 'Pool unsubscribed')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save')
  }
}

// ── Selection (Phase 3 backend) ────────────────────────────────────────

async function pickClips(): Promise<void> {
  if (!subscribedPoolId.value || !form.episode_id || picking.value) return
  picking.value = true
  try {
    const r = await post<{ selection: typeof selection.value }>(`/projects/${slug.value}/broll/pick`, {
      episode_id: form.episode_id,
      pool_id: subscribedPoolId.value,
      selection_mode: form.selection_mode,
      tags: form.tags,
      pacing_mode: form.pacing_mode,
      segment_seconds: form.segment_seconds,
      broll_lookback: form.broll_lookback,
    })
    selection.value = r.selection || []
    success(`Selected ${selection.value.length} clip(s) for ${form.episode_id}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Selection failed')
  } finally {
    picking.value = false
  }
}

// ── Assemble (Phase 3 — fires the existing video_assembly job) ────────

async function assembleVideo(): Promise<void> {
  if (!form.episode_id || assembling.value) return
  assembling.value = true
  try {
    const job = await post<{ job_id: string }>(`/projects/${slug.value}/broll/assemble`, {
      episode_id: form.episode_id,
      pool_id: subscribedPoolId.value,
      broll_volume: form.broll_volume,
    })
    success(`Queued — job ${job.job_id}. Watch progress in the Jobs panel.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Assembly failed to queue')
  } finally {
    assembling.value = false
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function thumbnailUrl(poolId: string, filename: string): string {
  return broll.thumbnailUrl(poolId, filename)
}

function formatDuration(sec: number): string {
  if (!sec) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}
</script>

<style scoped>
.broll-page { display: flex; flex-direction: column; gap: 12px; }
.empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary); border-radius: 6px; }
.empty a { color: var(--accent, #6c8fff); margin-left: 4px; }
.card { padding: 14px 18px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md, 6px); }
.card h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }

.pool-picker { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pool-picker label { font-size: 12px; color: var(--text-muted); }

.offline-banner {
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.30);
  color: rgb(180, 120, 8);
  border-radius: 4px;
  font-size: 12px;
}
.offline-banner code { background: rgba(0,0,0,0.10); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono, monospace); }

.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--text-primary); }
.form-group .hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; }

.radio-row, .checkbox-row { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.checkbox-row label { display: flex; align-items: center; gap: 6px; }
.input-sm { padding: 3px 6px; font-size: 12px; }
.input-inline { display: inline-block; width: 60px; margin: 0 4px; }

.volume-row { display: flex; align-items: center; gap: 8px; }
.volume-slider { flex: 1; }
.volume-value { font-family: var(--font-mono, monospace); font-size: 12px; min-width: 40px; text-align: right; }

.sequence-row {
  display: flex; flex-wrap: wrap; gap: 6px;
}
.seq-tile {
  position: relative;
  width: 120px; height: 67px;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-tertiary);
}
.seq-thumb { width: 100%; height: 100%; object-fit: cover; }
.seq-idx {
  position: absolute; top: 2px; left: 4px;
  background: rgba(0,0,0,0.65); color: #fff;
  padding: 1px 5px; border-radius: 3px; font-size: 10px;
  font-family: var(--font-mono, monospace);
}
.seq-duration {
  position: absolute; bottom: 2px; right: 4px;
  background: rgba(0,0,0,0.65); color: #fff;
  padding: 1px 5px; border-radius: 3px; font-size: 10px;
  font-family: var(--font-mono, monospace);
}

.seq-actions { display: flex; gap: 8px; }
</style>
