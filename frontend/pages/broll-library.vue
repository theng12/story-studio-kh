<!--
  B-Roll Library — app-level page (not per-project).

  Two main surfaces:
   1. Pool list (left rail): pick which registered pool to view, or add
      a new one. Each pool shows online state — the SSD might not be
      plugged in, in which case clip thumbnails still render from the
      per-Mac thumbnail cache but tags/scan are disabled.
   2. Clip grid (main): every clip in the selected pool, with thumbnail,
      duration, resolution, fps, and editable tag chips. Buttons for
      re-scan, normalize-all, and per-clip normalize.
-->
<template>
  <div class="broll-page">
    <header class="page-header">
      <div>
        <h1>B-Roll Library</h1>
        <p class="text-muted">
          App-level pool of stock footage shared across every project on this machine. Register a
          folder (typically your portable SSD) once; the app indexes clips, generates thumbnails,
          and optionally normalises everything to 1080p so video assembly stays fast.
        </p>
      </div>
      <button class="btn btn-primary" @click="openCreateModal()">+ Register pool</button>
    </header>

    <div v-if="loading" class="muted">Loading pools…</div>

    <div v-else-if="!pools.length" class="empty">
      No pools yet. Click <strong>+ Register pool</strong> and point at the folder on your SSD that
      holds the clips. Tags + indexing metadata live in a JSON sidecar inside that folder, so they
      travel with the SSD across Macs.
    </div>

    <div v-else class="broll-layout">
      <!-- Pool list (left rail) -->
      <aside class="pool-rail">
        <button
          v-for="p in pools"
          :key="p.id"
          :class="['pool-card', { active: p.id === selectedPoolId }]"
          @click="selectPool(p.id)"
        >
          <div class="pool-card-name">{{ p.name }}</div>
          <div class="pool-card-meta">
            <span :class="['pool-online', p.online ? 'is-online' : 'is-offline']">
              {{ p.online ? '● online' : '○ offline' }}
            </span>
            <span class="text-muted text-xs">{{ p.fps_target }}fps · 1080p</span>
          </div>
          <div class="pool-card-path" :title="p.folder_path">{{ p.folder_path }}</div>
        </button>
      </aside>

      <!-- Selected pool: scan controls + clip grid -->
      <section v-if="selectedPool" class="pool-main">
        <div class="pool-header">
          <div>
            <h2>{{ selectedPool.name }}</h2>
            <div class="text-muted text-xs">
              {{ selectedPool.folder_path }} ·
              auto-normalize <strong>{{ selectedPool.auto_normalize ? 'ON' : 'OFF' }}</strong> ·
              target <strong>{{ selectedPool.fps_target }}fps · 1080p</strong>
            </div>
          </div>
          <div class="pool-actions">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!selectedPool.online || scanning"
              :title="!selectedPool.online ? 'Pool offline — plug in the SSD first' : 'Re-scan the folder for new / changed / removed clips'"
              @click="runScan"
            >
              <LoadingSpinner v-if="scanning" size="sm" />
              <span v-else>↻</span>
              {{ scanning ? 'Scanning…' : 'Re-scan' }}
            </button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!selectedPool.online || normalizingAll || !unnormalizedCount"
              :title="!selectedPool.online ? 'Pool offline' : !unnormalizedCount ? 'All clips already normalised' : `Queue normalize jobs for the ${unnormalizedCount} clip(s) that haven't been re-encoded to 1080p ${selectedPool.fps_target}fps yet.`"
              @click="runNormalizeAll"
            >
              ⚡ Normalize all{{ unnormalizedCount ? ` (${unnormalizedCount})` : '' }}
            </button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!selectedPool.online || autotagging || !untaggedCount"
              :title="!selectedPool.online ? 'Pool offline' : !untaggedCount ? 'Every clip already has at least one tag' : `Queue vision-LLM auto-tag jobs for the ${untaggedCount} clip(s) with no tags yet. ~$0.002/clip on GPT-4o-mini.`"
              @click="runAutotagUntagged"
            >
              ✨ Auto-tag untagged{{ untaggedCount ? ` (${untaggedCount})` : '' }}
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :title="'Toggle auto-normalize on new clips for this pool. When on, the next scan auto-queues normalize jobs for clips it newly indexed. Turn off if you want manual control or your SSD is slow.'"
              @click="toggleAutoNormalize"
            >
              auto-normalize: {{ selectedPool.auto_normalize ? 'ON' : 'OFF' }}
            </button>
            <button class="btn btn-ghost btn-sm danger" @click="confirmDeletePool">✕ Unregister</button>
          </div>
        </div>

        <div v-if="!selectedPool.online" class="offline-banner">
          🔌 SSD not connected — connect <code>{{ selectedPool.folder_path }}</code> to scan or edit tags.
          Indexed clip metadata is preserved.
        </div>

        <div v-if="scanResult" class="scan-result">
          <strong>Scan complete</strong> —
          <span v-if="scanResult.added.length">+{{ scanResult.added.length }} new</span>
          <span v-if="scanResult.updated.length"> · {{ scanResult.updated.length }} updated</span>
          <span v-if="scanResult.unchanged.length"> · {{ scanResult.unchanged.length }} unchanged</span>
          <span v-if="scanResult.missing.length" class="text-warn"> · {{ scanResult.missing.length }} missing</span>
          <span v-if="scanResult.errors.length" class="text-danger"> · {{ scanResult.errors.length }} errors</span>
        </div>

        <!-- ── Pool jobs panel ─────────────────────────────────────────
             B-Roll normalize + auto-tag jobs are app-level (project_slug
             '_app_'), so they never showed up in any project's Jobs
             tab. v1.0.91+: inline panel here streams those jobs via
             /api/jobs/app/stream so the user sees normalize / autotag
             progress without leaving the page. Auto-collapses to the
             count when nothing is in flight; expands to a live list
             with progress lines when work is queued. -->
        <div v-if="visibleJobs.length || activeJobsCount > 0" class="pool-jobs">
          <button class="pool-jobs-header" type="button" @click="poolJobsExpanded = !poolJobsExpanded">
            <span class="pool-jobs-title">
              <span aria-hidden="true">⚙</span>
              Pool jobs
              <span class="pool-jobs-stats">
                <template v-if="activeJobsCount > 0">{{ activeJobsCount }} in progress</template>
                <template v-else>{{ visibleJobs.length }} recent</template>
              </span>
            </span>
            <span aria-hidden="true">{{ poolJobsExpanded ? '▾' : '▸' }}</span>
          </button>

          <div v-if="poolJobsExpanded" class="pool-jobs-list">
            <div v-for="job in visibleJobs" :key="job.job_id" :class="['pool-job-row', `is-${job.status}`]">
              <span class="pool-job-badge">{{ jobBadge(job) }}</span>
              <div class="pool-job-body">
                <div class="pool-job-title">{{ job.title || job.type }}</div>
                <div v-if="lastProgressLine(job)" class="pool-job-progress">{{ lastProgressLine(job) }}</div>
                <div v-if="job.status === 'error' && job.error" class="pool-job-error" :title="job.error">⚠ {{ job.error.slice(0, 200) }}</div>
              </div>
              <span class="pool-job-when">{{ relativeTime(job.finished_at || job.created_at) }}</span>
            </div>
            <div v-if="!visibleJobs.length" class="pool-jobs-empty">
              No recent pool jobs. Drop new clips into the folder + ↻ Re-scan to queue normalize jobs;
              click ✨ Auto-tag untagged to queue tag jobs.
            </div>
          </div>
        </div>

        <div v-if="clipsLoading" class="muted">Loading clips…</div>

        <div v-else-if="!clips.length" class="empty">
          No clips indexed yet. Drop video files into <code>{{ selectedPool.folder_path }}</code> via
          Finder and click <strong>↻ Re-scan</strong>.
        </div>

        <div v-else class="clip-grid">
          <article v-for="clip in clips" :key="clip.filename" :class="['clip-card', { 'is-missing': clip.missing }]">
            <div class="clip-thumb-wrap">
              <img
                :src="thumbnailUrl(selectedPoolId!, clip.filename)"
                :alt="clip.filename"
                class="clip-thumb"
                loading="lazy"
                @error="onThumbError"
              />
              <span class="clip-duration">{{ formatDuration(clip.duration) }}</span>
              <span v-if="clip.normalized" class="clip-normalized" :title="`Normalized to ${selectedPool.fps_target}fps 1080p`">✓ {{ selectedPool.fps_target }}fps</span>
              <span v-if="clip.missing" class="clip-missing-badge">missing</span>
            </div>
            <div class="clip-body">
              <div class="clip-filename" :title="clip.filename">{{ clip.filename }}</div>
              <div class="clip-meta text-muted text-xs">
                {{ clip.width }}×{{ clip.height }} · {{ clip.fps }}fps · {{ formatBytes(clip.size_bytes) }}
              </div>
              <ChipInput
                :model-value="clip.tags"
                placeholder="add tags…"
                allow-custom
                :disabled="!selectedPool.online"
                @update:model-value="(tags: string[]) => saveTags(clip.filename, tags)"
              />
              <div class="clip-actions">
                <button
                  v-if="!clip.normalized"
                  class="btn btn-ghost btn-sm"
                  :disabled="!selectedPool.online"
                  :title="'Re-encode this clip to ' + selectedPool.fps_target + 'fps 1080p H.264. Runs as a queued job — see Jobs panel.'"
                  @click="normalizeOne(clip.filename)"
                >
                  ⚡ Normalize
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="!selectedPool.online"
                  :title="'Vision-LLM tag suggestion from this clip thumbnail. Unioned with existing tags. ~$0.002 per call.'"
                  @click="autotagOne(clip.filename)"
                >
                  ✨ Auto-tag
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>

    <!-- Create pool modal -->
    <div v-if="createModalOpen" class="modal-overlay" @click.self="createModalOpen = false">
      <div class="create-modal">
        <h3>Register a B-Roll pool</h3>
        <p class="text-muted text-sm">
          Point at the folder on your SSD that holds the clips. The app writes a small JSON sidecar
          inside the folder for tags + index — that file travels with the SSD across Macs.
        </p>
        <div class="form-group">
          <label>Pool name <span class="req">*</span></label>
          <input
            v-model="createDraft.name"
            class="input"
            placeholder="e.g. Prayer B-Roll, Nature stock, City timelapses"
            autofocus
          />
        </div>
        <div class="form-group">
          <label>Folder path <span class="req">*</span></label>
          <div class="path-input-row">
            <input
              v-model="createDraft.folder_path"
              class="input"
              placeholder="/Volumes/SSD/prayer-broll"
            />
          </div>
          <span class="hint">
            Full absolute path. Tip: open the folder in Finder, right-click → Get Info, copy the
            "Where:" value.
          </span>
        </div>
        <div class="form-group">
          <label>Normalize target fps</label>
          <div class="radio-row">
            <label><input type="radio" :value="24" v-model="createDraft.fps_target" /> 24 fps (cinematic, default)</label>
            <label><input type="radio" :value="30" v-model="createDraft.fps_target" /> 30 fps (YouTube-native)</label>
          </div>
        </div>
        <div class="form-group">
          <label>
            <input type="checkbox" v-model="createDraft.auto_normalize" />
            Auto-normalize new clips on import (recommended)
          </label>
          <span class="hint">
            When on, every newly-indexed clip gets a queued normalize job to re-encode to 1080p at
            the target fps. Turn off if you want to control re-encodes manually (saves CPU on a
            slow drive).
          </span>
        </div>
        <div v-if="createError" class="create-error">⚠ {{ createError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="createModalOpen = false">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="!createDraft.name.trim() || !createDraft.folder_path.trim() || creating"
            @click="submitCreate"
          >
            {{ creating ? 'Registering…' : 'Register pool' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('B-Roll Library')

const broll = useBrollPools()
const { ask } = useConfirm()
const { success, error: showError } = useToast()

// Live app-level jobs (broll_normalize + broll_autotag). The standard
// /projects/:slug/jobs feed filters by project_slug, so app-level
// jobs (project_slug='_app_') never show there — this composable
// streams them separately. v1.0.91+.
const appJobs = useAppJobs()

const pools = broll.pools
const loading = broll.loading

const selectedPoolId = ref<string>('')
const selectedPool = computed(() => pools.value.find(p => p.id === selectedPoolId.value) || null)

const clips = ref<any[]>([])
const clipsLoading = ref(false)
const scanning = ref(false)
const scanResult = ref<any | null>(null)
const normalizingAll = ref(false)

const unnormalizedCount = computed(() =>
  clips.value.filter(c => !c.normalized && !c.missing).length,
)
const untaggedCount = computed(() =>
  clips.value.filter(c => !c.missing && !(c.tags && c.tags.length)).length,
)
const autotagging = ref(false)

// ── Pool jobs panel + auto-refresh ────────────────────────────────────
const poolJobsExpanded = ref(true)

/**
 * Filter app-level jobs down to the ones relevant to THIS pool. Both
 * broll_normalize and broll_autotag stash the pool_id in their params
 * (and we also use episode_id=pool.id as a secondary handle so older
 * code that filters by episode still works). Show running + queued
 * always; show the last 6 done/error/cancelled for trail context.
 */
const visibleJobs = computed(() => {
  if (!selectedPoolId.value) return []
  const matchesPool = (j: any) =>
    j.type === 'broll_normalize' || j.type === 'broll_autotag'
      ? (j.params?.pool_id === selectedPoolId.value || j.episode_id === selectedPoolId.value)
      : false
  const active = appJobs.jobs.value.filter(j => matchesPool(j) && (j.status === 'queued' || j.status === 'running'))
  const recent = appJobs.jobs.value
    .filter(j => matchesPool(j) && (j.status === 'done' || j.status === 'error' || j.status === 'cancelled'))
    .slice(0, 6)
  return [...active, ...recent]
})
const activeJobsCount = computed(() =>
  visibleJobs.value.filter(j => j.status === 'queued' || j.status === 'running').length,
)

function jobBadge(job: any): string {
  if (job.status === 'queued')    return '… queued'
  if (job.status === 'running')   return job.type === 'broll_normalize' ? '⚡ normalizing' : '✨ tagging'
  if (job.status === 'done')      return '✓ done'
  if (job.status === 'error')     return '⚠ error'
  if (job.status === 'cancelled') return '○ cancelled'
  return job.status
}
function lastProgressLine(job: any): string {
  const lines = job.output_lines || []
  if (!lines.length) return ''
  // Prefer the most informative recent line: progress lines refresh in
  // place, so the latest one is the live indicator. For done jobs the
  // final line is "Done → …" which is the right summary.
  return String(lines[lines.length - 1]).slice(0, 180)
}
function relativeTime(iso?: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const diff = (Date.now() - d.getTime()) / 1000
    if (diff < 30) return 'just now'
    if (diff < 60) return `${Math.round(diff)}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return d.toLocaleDateString()
  } catch { return '' }
}

// Auto-refresh the clip grid when any normalize / autotag job for the
// selected pool transitions to done — the sidecar's normalized flag and
// tags array have just changed and the UI should reflect it without
// a manual ↻ click.
let unsubDone: (() => void) | null = null
onMounted(() => {
  unsubDone = appJobs.onJobDone((job: any) => {
    if (job.status !== 'done') return
    if (job.type !== 'broll_normalize' && job.type !== 'broll_autotag') return
    const poolId = job.params?.pool_id || job.episode_id
    if (poolId && poolId === selectedPoolId.value) {
      void refreshClipsAfterJob()
    }
  })
})
onBeforeUnmount(() => { if (unsubDone) unsubDone() })

async function refreshClipsAfterJob(): Promise<void> {
  if (!selectedPoolId.value) return
  try {
    const r = await broll.listClips(selectedPoolId.value)
    clips.value = r.clips
  } catch { /* tolerate */ }
}

// ── Pool selection ─────────────────────────────────────────────────────

async function loadAndSelect(): Promise<void> {
  await broll.loadPools()
  if (!selectedPoolId.value && pools.value.length) {
    selectedPoolId.value = pools.value[0]!.id
  }
}

async function selectPool(id: string): Promise<void> {
  selectedPoolId.value = id
}

watch(selectedPoolId, async (id) => {
  if (!id) return
  scanResult.value = null
  clipsLoading.value = true
  try {
    const r = await broll.listClips(id)
    clips.value = r.clips
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to load clips')
    clips.value = []
  } finally {
    clipsLoading.value = false
  }
}, { immediate: false })

watch(() => null, loadAndSelect, { immediate: true })

// ── Scan / normalize ──────────────────────────────────────────────────

async function runScan(): Promise<void> {
  if (!selectedPoolId.value || scanning.value) return
  scanning.value = true
  scanResult.value = null
  try {
    const r = await broll.scanPool(selectedPoolId.value)
    scanResult.value = r
    // Refresh the clip grid so newly-indexed clips show up.
    const fresh = await broll.listClips(selectedPoolId.value)
    clips.value = fresh.clips
    success(`Scan complete — +${r.added.length} new, ${r.updated.length} updated`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Scan failed')
  } finally {
    scanning.value = false
  }
}

async function runNormalizeAll(): Promise<void> {
  if (!selectedPoolId.value || normalizingAll.value) return
  normalizingAll.value = true
  try {
    const r = await broll.normalizeAll(selectedPoolId.value)
    success(`Queued ${r.queued} normalize job(s). Watch progress in the Jobs panel.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue normalize')
  } finally {
    normalizingAll.value = false
  }
}

async function normalizeOne(filename: string): Promise<void> {
  if (!selectedPoolId.value) return
  try {
    await broll.normalizeClip(selectedPoolId.value, filename)
    success(`Queued normalize for ${filename}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue normalize')
  }
}

async function autotagOne(filename: string): Promise<void> {
  if (!selectedPoolId.value) return
  try {
    await broll.autotagClip(selectedPoolId.value, filename)
    success(`Queued auto-tag for ${filename}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue auto-tag')
  }
}

async function runAutotagUntagged(): Promise<void> {
  if (!selectedPoolId.value || autotagging.value) return
  autotagging.value = true
  try {
    const r = await broll.autotagUntagged(selectedPoolId.value)
    success(`Queued ${r.queued} auto-tag job(s) (${r.total_targets} candidate clips).`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to queue bulk auto-tag')
  } finally {
    autotagging.value = false
  }
}

async function toggleAutoNormalize(): Promise<void> {
  if (!selectedPool.value) return
  try {
    await broll.updatePool(selectedPool.value.id, {
      auto_normalize: !selectedPool.value.auto_normalize,
    })
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Update failed')
  }
}

async function confirmDeletePool(): Promise<void> {
  if (!selectedPool.value) return
  const ok = await ask({
    title: `Unregister pool "${selectedPool.value.name}"?`,
    body: 'Removes the pool from the app registry. Clip files and the on-folder sidecar JSON stay on disk — you can re-register the same folder later and tags will be intact.',
    confirmLabel: 'Unregister',
    danger: true,
  })
  if (!ok) return
  try {
    await broll.deletePool(selectedPool.value.id)
    selectedPoolId.value = pools.value[0]?.id || ''
    success('Pool unregistered')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}

// ── Clip tags ─────────────────────────────────────────────────────────

async function saveTags(filename: string, tags: string[]): Promise<void> {
  if (!selectedPoolId.value) return
  try {
    const updated = await broll.setClipTags(selectedPoolId.value, filename, tags)
    const idx = clips.value.findIndex(c => c.filename === filename)
    if (idx >= 0) clips.value[idx] = updated
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save tags')
  }
}

// ── Create modal ──────────────────────────────────────────────────────

const createModalOpen = ref(false)
const createDraft = ref({
  name: '',
  folder_path: '',
  fps_target: 24 as 24 | 30,
  auto_normalize: true,
})
const creating = ref(false)
const createError = ref('')

function openCreateModal(): void {
  createDraft.value = { name: '', folder_path: '', fps_target: 24, auto_normalize: true }
  createError.value = ''
  createModalOpen.value = true
}

async function submitCreate(): Promise<void> {
  creating.value = true
  createError.value = ''
  try {
    const created = await broll.createPool({
      name: createDraft.value.name.trim(),
      folder_path: createDraft.value.folder_path.trim(),
      fps_target: createDraft.value.fps_target,
      auto_normalize: createDraft.value.auto_normalize,
    })
    createModalOpen.value = false
    selectedPoolId.value = created.id
    success(`Pool "${created.name}" registered. Click Re-scan to index clips.`)
  } catch (e: any) {
    createError.value = e?.data?.detail || e?.message || 'Failed to register pool'
  } finally {
    creating.value = false
  }
}

// ── URL + format helpers ──────────────────────────────────────────────

function thumbnailUrl(poolId: string, filename: string): string {
  return broll.thumbnailUrl(poolId, filename)
}

function formatDuration(sec: number): string {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

function formatBytes(bytes: number): string {
  if (!bytes) return ''
  const mb = bytes / 1024 / 1024
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`
}

function onThumbError(e: Event): void {
  // Thumbnail not yet generated — leave the broken-image placeholder
  // intact; the user can re-scan to regenerate.
  (e.target as HTMLImageElement).style.opacity = '0.3'
}
</script>

<style scoped>
.broll-page { display: flex; flex-direction: column; gap: 16px; padding: 8px 0; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.page-header h1 { margin: 0 0 4px; font-size: 20px; }
.page-header .text-muted { font-size: 12px; line-height: 1.5; max-width: 720px; }
.empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary); border-radius: 6px; }

.broll-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
}

.pool-rail { display: flex; flex-direction: column; gap: 8px; }
.pool-card {
  text-align: left;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.pool-card:hover { border-color: var(--accent, #6c8fff); }
.pool-card.active { border-color: var(--accent, #6c8fff); background: rgba(108,143,255,0.06); }
.pool-card-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.pool-card-meta { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 4px; }
.pool-online.is-online { color: rgb(34, 197, 94); }
.pool-online.is-offline { color: var(--text-muted); }
.pool-card-path { font-family: var(--font-mono, monospace); font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pool-main { display: flex; flex-direction: column; gap: 12px; }
.pool-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pool-header h2 { margin: 0 0 4px; font-size: 16px; }
.pool-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.btn.danger { color: var(--error, #e25c5c); }
.btn.danger:hover { background: rgba(226, 92, 92, 0.08); }

.offline-banner {
  padding: 10px 14px;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.30);
  color: rgb(180, 120, 8);
  border-radius: 4px;
  font-size: 12px;
}
.offline-banner code { background: rgba(0,0,0,0.10); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono, monospace); }

.scan-result {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary);
}
.text-warn { color: rgb(180, 120, 8); }
.text-danger { color: var(--error, #e25c5c); }

.clip-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.clip-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.clip-card.is-missing { opacity: 0.55; }
.clip-thumb-wrap {
  position: relative;
  aspect-ratio: 16 / 9;
  background: var(--bg-tertiary);
}
.clip-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
.clip-duration {
  position: absolute; bottom: 6px; right: 6px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-family: var(--font-mono, monospace);
}
.clip-normalized {
  position: absolute; top: 6px; right: 6px;
  background: rgba(34, 197, 94, 0.85);
  color: #fff;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
}
.clip-missing-badge {
  position: absolute; top: 6px; left: 6px;
  background: rgba(226, 92, 92, 0.85);
  color: #fff;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
}
.clip-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.clip-filename {
  font-size: 12px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.clip-actions { display: flex; gap: 4px; }

/* Create modal */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 200; padding: 24px;
}
.create-modal {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px 22px;
  width: min(560px, 96vw);
  display: flex; flex-direction: column; gap: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
}
.create-modal h3 { margin: 0; font-size: 16px; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--text-primary); }
.form-group .hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
.req { color: var(--error, #e25c5c); font-weight: bold; }
.radio-row { display: flex; gap: 16px; font-size: 12px; }
.create-error {
  padding: 6px 10px;
  background: rgba(226, 92, 92, 0.10);
  color: var(--error, #e25c5c);
  border-radius: 4px;
  font-size: 12px;
}
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }

/* ── Pool jobs panel ──────────────────────────────────────────────────
   Inline panel that surfaces app-level B-Roll jobs (normalize / autotag)
   for the active pool. SSE-driven via useAppJobs; collapsible. */
.pool-jobs {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
}
.pool-jobs-header {
  width: 100%;
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: none; cursor: pointer;
  font: inherit; color: inherit;
  font-size: 12px;
}
.pool-jobs-header:hover { background: var(--bg-hover, var(--bg-tertiary)); }
.pool-jobs-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.pool-jobs-stats {
  font-weight: 400; font-size: 11px; color: var(--text-muted);
  padding: 1px 6px; border-radius: 8px; background: var(--bg-secondary);
}
.pool-jobs-list {
  display: flex; flex-direction: column;
  max-height: 320px; overflow-y: auto;
}
.pool-job-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.pool-job-badge {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-family: var(--font-mono, monospace);
  font-weight: 600;
}
.pool-job-row.is-running .pool-job-badge { background: rgba(108, 143, 255, 0.16); color: var(--accent, #6c8fff); }
.pool-job-row.is-queued .pool-job-badge { background: var(--bg-tertiary); color: var(--text-muted); }
.pool-job-row.is-done .pool-job-badge { background: rgba(34, 197, 94, 0.16); color: rgb(21, 128, 61); }
.pool-job-row.is-error .pool-job-badge { background: rgba(220, 38, 38, 0.16); color: rgb(185, 28, 28); }
.pool-job-row.is-cancelled .pool-job-badge { background: var(--bg-tertiary); color: var(--text-muted); }
.pool-job-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pool-job-title {
  font-weight: 500; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pool-job-progress {
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pool-job-error {
  font-size: 11px; color: rgb(185, 28, 28);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pool-job-when {
  flex: 0 0 auto;
  font-size: 11px; color: var(--text-muted);
  font-family: var(--font-mono, monospace);
}
.pool-jobs-empty {
  padding: 12px;
  text-align: center;
  font-size: 12px; color: var(--text-muted);
}
</style>
