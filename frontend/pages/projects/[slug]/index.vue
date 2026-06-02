<template>
  <div>
    <div class="dash-header">
      <h1>{{ project?.name || 'Dashboard' }}</h1>
      <p class="text-muted">Your story production pipeline</p>
    </div>

    <!-- Loading indicator for the dashboard-stats fetch. Visible until the
         first fetch resolves (`statsLoading` flips false). On iCloud-backed
         projects this can run 5-30s on first entry while macOS materialises
         folder metadata from the cloud; the elapsed counter + escalating
         copy makes the wait obvious instead of leaving the panel blank. -->
    <div v-if="statsLoading" class="dash-loading-banner" role="status" aria-live="polite">
      <LoadingSpinner size="sm" />
      <div class="dash-loading-text">
        <strong>Loading project data…</strong>
        <span class="text-muted" style="margin-left: 6px;">{{ statsPhase }}</span>
      </div>
    </div>
    <!-- Partial-scan + dashboard-load-error notices moved into the
         notification center's "Action needed" tab (v1.0.196+) — they're
         transient/retryable, so they live in the bell rather than as
         inline banners. See reportReadiness() in the script. -->

    <!-- Asset-integrity banner: surfaces gaps that survived a folder
         transfer / partial sync. Read-only; nothing is regenerated. See
         services/manifest-audit.ts and the P7 note in Session 05.
         The audit walks every episode's filesystem state, so on large
         projects it can take 60+ seconds. We deliberately DON'T run it
         on mount — the operator clicks "Run audit" when they want it,
         and the result is cached for 30 min so re-visits are free. -->
    <div
      class="audit-banner"
      :class="{ 'audit-banner-idle': !audit, 'audit-banner-clean': auditCleanVisible }"
      role="status"
      aria-live="polite"
    >
      <span class="audit-banner-icon" aria-hidden="true">
        <template v-if="auditBannerVisible">&#9888;</template>
        <template v-else-if="auditCleanVisible">&#10003;</template>
        <template v-else>&#128270;</template>
      </span>
      <div class="audit-banner-text">
        <template v-if="auditRunning">
          <strong>Auditing assets…</strong>
          <span class="text-muted" style="margin-left: 6px;">
            Walking every episode's folder. Slow on large projects (60s+ for 300+ episodes).
          </span>
        </template>
        <template v-else-if="auditBannerVisible">
          <strong>{{ audit.total_missing }} asset{{ audit.total_missing === 1 ? '' : 's' }}
            missing across {{ audit.episodes_with_missing }}
            episode{{ audit.episodes_with_missing === 1 ? '' : 's' }}.</strong>
          <span class="text-muted" style="margin-left: 6px;">
            Likely a partial transfer or interrupted sync.
            The Repair buttons on each asset page can re-download without spending credits.
            <span v-if="auditRanAtLabel" style="margin-left: 4px;">Last scanned {{ auditRanAtLabel }}.</span>
          </span>
        </template>
        <template v-else-if="auditCleanVisible">
          <strong>All assets present.</strong>
          <span class="text-muted" style="margin-left: 6px;">
            Last scanned {{ auditRanAtLabel }}. The audit walks every episode's folder, so we cache the result for 30 min.
          </span>
        </template>
        <template v-else>
          <strong>Asset audit not run yet.</strong>
          <span class="text-muted" style="margin-left: 6px;">
            Walks every episode's folder to find missing files. Skipped on mount because it's slow on large projects.
          </span>
        </template>
      </div>
      <div class="audit-banner-actions">
        <button
          v-if="auditBannerVisible"
          class="btn btn-sm btn-secondary"
          @click="showDialog = true"
        >See what's missing</button>
        <NuxtLink
          v-if="auditBannerVisible"
          class="btn btn-sm btn-primary"
          :to="`/projects/${slug}/assets`"
        >Repair</NuxtLink>
        <button
          class="btn btn-sm"
          :class="auditBannerVisible ? 'btn-ghost' : 'btn-primary'"
          :disabled="auditRunning"
          @click="runAudit"
        >
          <LoadingSpinner v-if="auditRunning" size="sm" />
          <template v-else>{{ audit ? '↻ Re-scan' : 'Run audit' }}</template>
        </button>
      </div>
    </div>
    <MissingAssetsDialog
      v-if="audit"
      :visible="showDialog"
      :slug="slug"
      :report="audit"
      @close="showDialog = false"
    />

    <!-- No-upload-destinations banner (P5 portability hazard). If no
         YouTube channel is bound to this project, publishing will fail
         30+ minutes into a render — surface the gap here so the user
         notices before they burn compute on a video that can't ship. -->
    <NuxtLink
      v-if="uploadAccountCount === 0"
      :to="`/projects/${slug}/upload`"
      class="no-upload-banner"
      :title="'No YouTube channel connected for this project. Click to open Settings → Upload.'"
    >
      <span class="no-upload-icon" aria-hidden="true">&#9888;&#65039;</span>
      <span class="no-upload-text">
        <strong>No upload destinations connected.</strong>
        Connect a YouTube channel before you render — Settings → Upload.
      </span>
      <span class="no-upload-cta">Open &rarr;</span>
    </NuxtLink>

    <!-- (Stats / audit / accounts load errors now surface in the
         notification center's "Action needed" tab with a Retry action —
         see reportReadiness().) -->

    <!-- Hero stats row -->
    <div class="hero-stats mt-3">
      <div class="hero-card">
        <div class="hero-icon">&#10024;</div>
        <div class="hero-number">{{ stats?.ideas?.total || 0 }}</div>
        <div class="hero-label">Ideas Generated</div>
      </div>
      <div class="hero-card accent">
        <div class="hero-icon">&#128218;</div>
        <div class="hero-number">{{ stats?.episodes?.total || 0 }}</div>
        <div class="hero-label">Episodes Accepted</div>
      </div>
      <div class="hero-card success">
        <div class="hero-icon">&#9989;</div>
        <div class="hero-number">{{ stats?.episodes?.ready || 0 }}</div>
        <div class="hero-label">Episodes Ready</div>
      </div>
      <div class="hero-card time-saved">
        <div class="hero-icon">&#9203;</div>
        <div class="hero-number">{{ stats?.time_saved?.hours || 0 }}h</div>
        <div class="hero-label">Time Saved</div>
      </div>
    </div>

    <!-- Assets + Completion -->
    <div class="grid-2 mt-3">
      <!-- Asset breakdown -->
      <div class="card">
        <h3>Assets Generated</h3>
        <div class="asset-grid mt-2">
          <div class="asset-item" v-for="asset in assetItems" :key="asset.label">
            <div class="asset-ring" :style="{ '--pct': asset.pct }">
              <svg viewBox="0 0 36 36" class="ring-svg">
                <path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                <path class="ring-fill" :stroke-dasharray="`${asset.pct}, 100`" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              </svg>
              <span class="ring-text">{{ asset.count }}</span>
            </div>
            <span class="asset-label">{{ asset.label }}</span>
          </div>
        </div>
      </div>

      <!-- Sessions -->
      <div class="card">
        <!-- This Session -->
        <h3>This Session</h3>
        <div class="session-stats mt-1">
          <div class="session-row" v-if="currentSession.ideas_generated">
            <span>Ideas</span><span class="text-accent">{{ currentSession.ideas_generated }}</span>
          </div>
          <div class="session-row" v-if="currentSession.scripts_generated">
            <span>Scripts</span><span class="text-accent">{{ currentSession.scripts_generated }}</span>
          </div>
          <div class="session-row" v-if="currentSession.prompts_generated">
            <span>Image Prompts</span><span class="text-accent">{{ currentSession.prompts_generated }}</span>
          </div>
          <div class="session-row" v-if="currentSession.descriptions_generated">
            <span>Descriptions</span><span class="text-accent">{{ currentSession.descriptions_generated }}</span>
          </div>
          <div class="session-row" v-if="currentSession.images_generated">
            <span>Images</span><span class="text-accent">{{ currentSession.images_generated }}</span>
          </div>
          <div class="session-row" v-if="currentSession.audio_generated">
            <span>Audio</span><span class="text-accent">{{ currentSession.audio_generated }}</span>
          </div>
          <div class="session-row">
            <span>Time Saved</span>
            <span class="text-accent">{{ Math.round(currentSession.time_saved_min / 60 * 10) / 10 }}h</span>
          </div>
          <div class="session-row" v-if="!currentSession.ideas_generated && !currentSession.scripts_generated">
            <span class="text-muted" style="font-style:italic">No generations yet this session</span>
          </div>
        </div>

        <!-- Previous Session -->
        <div v-if="previousSession" class="mt-3">
          <h3>Previous Session</h3>
          <div class="prev-date text-muted">{{ formatSessionDate(previousSession.started_at) }}</div>
          <div class="session-stats mt-1">
            <div class="session-row" v-if="previousSession.ideas_generated">
              <span>Ideas</span><span>{{ previousSession.ideas_generated }}</span>
            </div>
            <div class="session-row" v-if="previousSession.scripts_generated">
              <span>Scripts</span><span>{{ previousSession.scripts_generated }}</span>
            </div>
            <div class="session-row" v-if="previousSession.prompts_generated">
              <span>Image Prompts</span><span>{{ previousSession.prompts_generated }}</span>
            </div>
            <div class="session-row" v-if="previousSession.descriptions_generated">
              <span>Descriptions</span><span>{{ previousSession.descriptions_generated }}</span>
            </div>
            <div class="session-row" v-if="previousSession.images_generated">
              <span>Images</span><span>{{ previousSession.images_generated }}</span>
            </div>
            <div class="session-row" v-if="previousSession.audio_generated">
              <span>Audio</span><span>{{ previousSession.audio_generated }}</span>
            </div>
            <div class="session-row">
              <span>Time Saved</span>
              <span>{{ Math.round(previousSession.time_saved_min / 60 * 10) / 10 }}h</span>
            </div>
          </div>
        </div>

        <!-- All Time -->
        <div class="mt-3">
          <h3>All Time</h3>
          <div class="session-stats mt-1">
            <div class="session-row">
              <span>Total Sessions</span>
              <span class="text-accent">{{ stats?.session?.all_time?.total_sessions || 0 }}</span>
            </div>
            <div class="session-row">
              <span>Total Assets</span>
              <span class="text-accent">{{ stats?.session?.all_time?.total_assets || 0 }}</span>
            </div>
            <div class="session-row">
              <span>Total API Cost</span>
              <span class="text-accent">${{ (stats?.session?.all_time?.total_api_cost || 0).toFixed(2) }}</span>
            </div>
            <div class="session-row highlight">
              <span>Total Time Saved</span>
              <span class="text-accent">{{ stats?.time_saved?.hours || 0 }}h ({{ workDayEquiv }} work days)</span>
            </div>
          </div>
        </div>

        <!-- Job queue mini -->
        <div class="mt-3" v-if="jobStats.total > 0">
          <h3>
            Job Queue
            <span
              v-if="jobsStale"
              class="stale-badge"
              :title="`Job stream refresh has failed repeatedly — counts may be out of date.${lastRefreshError ? ` Last error: ${lastRefreshError}` : ''}`"
            >⚠ data may be stale</span>
          </h3>
          <div class="flex gap-2 mt-1">
            <span class="badge badge-running">{{ jobStats.running }} running</span>
            <span class="badge badge-queued">{{ jobStats.queued }} queued</span>
            <span class="badge badge-done">{{ jobStats.done }} done</span>
            <span v-if="jobStats.error" class="badge badge-error">{{ jobStats.error }} errors</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Workflow -->
    <div class="card mt-3">
      <div class="card-header">
        <h3>Production Workflow</h3>
        <NuxtLink :to="`/projects/${slug}/pipeline`" class="btn btn-sm btn-primary">Open Pipeline →</NuxtLink>
      </div>
      <div class="workflow-vertical mt-1">
        <div v-for="(step, i) in workflowSteps" :key="step.path" class="wf-step" @click="navigateTo(`/projects/${slug}/${step.path}`)">
          <div class="wf-num">{{ i + 1 }}</div>
          <span class="wf-icon">{{ step.icon }}</span>
          <span class="wf-label">{{ step.label }}</span>
          <span class="wf-arrow" v-if="i < workflowSteps.length - 1">↓</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ProjectAudit } from '~/types/audit'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Dashboard')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { project } = useProject()
const { stats: jobStats, jobsStale, lastRefreshError } = useJobs()
const { get } = useApi()
// Notification center: dashboard pushes its transient/asset readiness items
// into the shared store so they appear in the bell's "Action needed" tab
// instead of as inline banners. See reportReadiness() below.
const notif = useNotifications()

const stats = ref<any>(null)
// Mount-time fetches are one-shot (no retry loop), so a single failure
// already means the data we're showing is stale/empty. Surface that
// rather than rendering "0 episodes" as if the project is empty.
const statsLoadError = ref<string>('')
const auditLoadError = ref<string>('')
const accountsLoadError = ref<string>('')

// Loading-progress UI state. Until `stats.value` resolves, the dashboard
// would otherwise render zeros + a blank panel — which on iCloud-backed
// projects (where the scan can take 30s+ on first entry while macOS
// rematerialises evicted folder metadata) reads as "broken" instead of
// "loading". We surface elapsed time + a phase label so the user sees
// progress; copy escalates after 5s to acknowledge slow projects, and
// after 20s to suggest the iCloud download case.
const statsLoading = ref(true)
const statsElapsedSec = ref(0)
let statsElapsedTimer: ReturnType<typeof setInterval> | null = null
const statsPhase = computed(() => {
  if (statsElapsedSec.value < 5) return 'Scanning episodes…'
  if (statsElapsedSec.value < 20) return `Still scanning (${statsElapsedSec.value}s) — large project, hold tight…`
  return `Still scanning (${statsElapsedSec.value}s) — likely an iCloud download in progress. macOS is materialising files from the cloud; this finishes once and stays fast afterwards.`
})

// Asset audit — lazy + cached. The audit walks every episode's filesystem
// state, which is O(episodes × asset-stages) and easily hits 60+ seconds on
// large projects. We don't fire it on mount; the operator clicks "Run audit"
// when they want it. Result is cached at module scope for 30 min so leaving
// and re-entering the dashboard inside that window is free. Benchmark:
// 102.5s on a 379-episode iCloud-synced project — the previous on-mount
// fetch was the dominant cause of "dashboard takes forever".
const audit = ref<ProjectAudit | null>(null)
const auditRanAt = ref<number>(0)
const auditRunning = ref(false)
const showDialog = ref(false)
const auditBannerVisible = computed(() =>
  !!audit.value && audit.value.total_missing > 0,
)
const auditCleanVisible = computed(() =>
  !!audit.value && !auditRunning.value && audit.value.total_missing === 0,
)
const auditRanAtLabel = computed(() => {
  if (!auditRanAt.value) return ''
  const diff = Date.now() - auditRanAt.value
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  return new Date(auditRanAt.value).toLocaleTimeString()
})

// Module-level cache so navigating away and back doesn't re-run the audit.
// Keyed by slug because separate projects have separate audits. 30-min TTL.
const _auditCacheBySlug = new Map<string, { result: ProjectAudit; ts: number }>()
const AUDIT_TTL_MS = 30 * 60 * 1000


const assetItems = computed(() => {
  if (!stats.value) return []
  const a = stats.value.assets || {}
  const total = stats.value.episodes?.total || 1
  return [
    { label: 'Scripts', count: a.scripts || 0, pct: Math.round(((a.scripts || 0) / total) * 100) },
    { label: 'Scene Prompts', count: a.scene_prompts || 0, pct: Math.round(((a.scene_prompts || 0) / total) * 100) },
    { label: 'Thumb Prompts', count: a.thumb_prompts || 0, pct: Math.round(((a.thumb_prompts || 0) / total) * 100) },
    { label: 'Images', count: a.total_image_files || 0, pct: Math.round(((a.images || 0) / total) * 100) },
    { label: 'Thumbnails', count: a.thumbnails || 0, pct: Math.round(((a.thumbnails || 0) / total) * 100) },
    { label: 'Audio', count: a.total_audio_files || 0, pct: Math.round(((a.audio || 0) / total) * 100) },
    { label: 'Descriptions', count: a.descriptions || 0, pct: Math.round(((a.descriptions || 0) / total) * 100) },
  ]
})

const emptySession = { ideas_generated: 0, scripts_generated: 0, prompts_generated: 0, images_generated: 0, audio_generated: 0, descriptions_generated: 0, time_saved_min: 0, api_calls: 0, api_cost: 0 }
const currentSession = computed(() => stats.value?.session?.current || emptySession)
const previousSession = computed(() => stats.value?.session?.previous || null)

function formatSessionDate(d: string) {
  try { return new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  catch { return d }
}

const workDayEquiv = computed(() => {
  const hours = stats.value?.time_saved?.hours || 0
  return Math.round(hours / 8 * 10) / 10
})

const workflowSteps = [
  { icon: '✨', label: 'Ideas', path: 'ideas' },
  { icon: '✏', label: 'Script', path: 'scripts' },
  { icon: '▶', label: 'Description', path: 'youtube' },
  { icon: '🎨', label: 'Image Prompts', path: 'image-prompts' },
  { icon: '📸', label: 'Images', path: 'images' },
  { icon: '🎙', label: 'Audio', path: 'audio' },
  { icon: '🎵', label: 'Audio Editor', path: 'audio-merge' },
]

// Upload-destinations banner: count across all platforms. The endpoint
// returns { accounts: { youtube: [...], tiktok: [...], ... } } keyed by
// platform, so flatten + count. `null` = not yet fetched (banner hidden
// until we know the answer, so it doesn't flash on initial paint).
const uploadAccountCount = ref<number | null>(null)

async function reloadDashboard() {
  // Spin up the elapsed-time ticker so the loading banner can show progress.
  // Reset to 0 on every reload so the user sees the new fetch's elapsed
  // time, not stale state from a prior load.
  statsLoading.value = true
  statsElapsedSec.value = 0
  if (statsElapsedTimer) clearInterval(statsElapsedTimer)
  const startedAt = Date.now()
  statsElapsedTimer = setInterval(() => {
    statsElapsedSec.value = Math.floor((Date.now() - startedAt) / 1000)
  }, 1000)
  // Stats + accounts in parallel — neither is slow, and they're independent.
  // The audit USED to live here too but was the bottleneck (60-100s on large
  // projects); it's now opt-in via runAudit().
  await Promise.all([
    (async () => {
      try {
        stats.value = await get(`/projects/${slug.value}/dashboard-stats`)
        statsLoadError.value = ''
      } catch (e: any) {
        // v1.0.129+ — slug-race rejections from useApi shouldn't surface
        // as a banner; the next valid load will replace this attempt.
        if (e?.__slugRace) return
        statsLoadError.value = e?.data?.detail || e?.message || 'Failed to load dashboard stats'
      } finally {
        statsLoading.value = false
        if (statsElapsedTimer) { clearInterval(statsElapsedTimer); statsElapsedTimer = null }
      }
    })(),
    (async () => {
      try {
        const r = await get<{ accounts: Record<string, any[]> }>(`/projects/${slug.value}/upload/accounts`)
        const total = Object.values(r?.accounts || {}).reduce((n, arr) => n + (arr?.length || 0), 0)
        uploadAccountCount.value = total
        accountsLoadError.value = ''
      } catch (e: any) {
        if (e?.__slugRace) return  // v1.0.129+ — silent on slug-race
        // Treat fetch failure as "unknown" — don't show the missing-destinations
        // banner if we can't confirm the gap (false alarm), but record the
        // error so we render a separate "couldn't check" indicator instead of
        // pretending the project has destinations configured.
        uploadAccountCount.value = null
        accountsLoadError.value = e?.data?.detail || e?.message || 'Could not check upload destinations'
      }
    })(),
  ])
  // Hydrate audit from the module-level cache if we have a fresh entry.
  // No fetch — re-running the audit requires an explicit click.
  const cached = _auditCacheBySlug.get(slug.value)
  if (cached && Date.now() - cached.ts < AUDIT_TTL_MS) {
    audit.value = cached.result
    auditRanAt.value = cached.ts
  } else {
    audit.value = null
    auditRanAt.value = 0
  }
  reportReadiness()
}

/**
 * Push the dashboard's transient + asset readiness state into the
 * notification center (the bell's "Action needed" tab), reconciling each
 * item: report when the condition holds, clear when it's resolved. Replaces
 * the old inline partial-scan / load-error / asset banners. Retry-style
 * fixes pass `onClick: reloadDashboard` since they can't be a plain route.
 */
function reportReadiness() {
  const s = slug.value
  if (!s) return

  // Partial / iCloud-skipped scan.
  const scan = stats.value?.scan
  if (scan?.partial || (scan?.icloud_skipped ?? 0) > 0) {
    const why = scan?.partial
      ? `The folder walk hit the ${Math.round((scan?.duration_ms || 0) / 1000)}s safety timeout — counts shown are partial.`
      : `${scan.icloud_skipped} folder${scan.icloud_skipped === 1 ? '' : 's'} skipped — likely still downloading from iCloud.`
    notif.report(s, {
      key: 'partial-scan',
      severity: 'info',
      title: 'Partial project scan',
      detail: `${why} Wait for iCloud to finish, then retry.`,
      onClick: reloadDashboard,
      actionLabel: 'Retry',
    })
  } else {
    notif.clear(s, 'partial-scan')
  }

  // Dashboard data fetch failures.
  if (statsLoadError.value || auditLoadError.value || accountsLoadError.value) {
    const parts: string[] = []
    if (statsLoadError.value) parts.push(`Stats: ${statsLoadError.value}`)
    if (auditLoadError.value) parts.push(`Asset audit: ${auditLoadError.value}`)
    if (accountsLoadError.value) parts.push(`Upload destinations: ${accountsLoadError.value}`)
    notif.report(s, {
      key: 'load-error',
      severity: 'warning',
      title: "Some dashboard data couldn't be loaded",
      detail: `${parts.join('. ')}.`,
      onClick: reloadDashboard,
      actionLabel: 'Retry',
    })
  } else {
    notif.clear(s, 'load-error')
  }

  // Asset-integrity gaps (only known after the audit has run).
  if (audit.value && audit.value.total_missing > 0) {
    notif.report(s, {
      key: 'assets',
      severity: 'warning',
      title: `${audit.value.total_missing} asset${audit.value.total_missing === 1 ? '' : 's'} missing across ${audit.value.episodes_with_missing} episode${audit.value.episodes_with_missing === 1 ? '' : 's'}`,
      detail: 'Likely a partial transfer or interrupted sync. The Repair buttons on each asset page can re-download without spending credits.',
      to: `/projects/${s}/assets`,
    })
  } else {
    notif.clear(s, 'assets')
  }
}

async function runAudit() {
  if (auditRunning.value) return
  auditRunning.value = true
  auditLoadError.value = ''
  try {
    const result = await get<ProjectAudit>(`/projects/${slug.value}/assets-audit-detail`)
    audit.value = result
    auditRanAt.value = Date.now()
    _auditCacheBySlug.set(slug.value, { result, ts: auditRanAt.value })
  } catch (e: any) {
    auditLoadError.value = e?.data?.detail || e?.message || 'Asset audit failed'
  } finally {
    auditRunning.value = false
    reportReadiness()
  }
}

onMounted(reloadDashboard)
onBeforeUnmount(() => {
  if (statsElapsedTimer) { clearInterval(statsElapsedTimer); statsElapsedTimer = null }
  // Drop the reported items that carry an `onClick: reloadDashboard` closure.
  // Left in place they'd keep this (now torn-down) page's reactive graph alive
  // and, if clicked from the bell, run reloadDashboard against dead refs. They
  // re-report on the next dashboard visit if the condition still holds. The
  // `assets` item is route-based (no closure), so it's fine to leave standing.
  const s = slug.value
  if (s) { notif.clear(s, 'partial-scan'); notif.clear(s, 'load-error') }
})
</script>

<style scoped>
.dash-header h1 { font-size: 28px; }

/* Loading banner — visible while dashboard-stats is in flight on first
 * project entry. Sits between the header and the audit banner so it
 * occupies the spot the user is staring at while waiting. */
.dash-loading-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding: 10px 14px;
  background: rgba(96, 165, 250, 0.08);
  border: 1px solid rgba(96, 165, 250, 0.30);
  border-left: 3px solid #60a5fa;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-secondary);
}
.dash-loading-text { line-height: 1.4; }
.dash-loading-text strong { color: var(--text-primary); }

/* Partial-scan warning — surfaces when the backend hit its 25s safety
 * timeout or skipped iCloud-evicted folders. Distinct color from the
 * loading banner (amber) so the user notices it as a state to act on
 * rather than a passive progress indicator. */
.dash-partial-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding: 10px 14px;
  background: rgba(240, 140, 60, 0.10);
  border: 1px solid rgba(240, 140, 60, 0.35);
  border-left: 3px solid #e4903a;
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.dash-partial-icon { font-size: 16px; color: #e4903a; }
.dash-partial-text { flex: 1 1 280px; min-width: 0; line-height: 1.4; }
.dash-partial-text strong { color: var(--text-primary); }

/* Dashboard fetch-failure banner. Distinct from the audit banner: this
   means "we couldn't load the panel data", not "the project itself has
   missing assets". Coloured red-ish so it doesn't blend into the
   amber-toned audit banner. */
.dash-stale-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding: 10px 14px;
  background: rgba(248, 113, 113, 0.10);
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.dash-stale-icon { font-size: 16px; color: #f87171; }
.dash-stale-text { flex: 1 1 280px; min-width: 0; line-height: 1.4; }

/* Inline stale marker next to a section header (used on Job Queue mini). */
.stale-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 500;
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.10);
  border: 1px solid rgba(251, 191, 36, 0.35);
  border-radius: 999px;
  vertical-align: middle;
  cursor: help;
}

/* Integrity banner */
.audit-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding: 10px 14px;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.audit-banner-icon { font-size: 16px; color: rgb(180, 83, 9); }
.audit-banner-text { flex: 1 1 280px; min-width: 0; line-height: 1.4; }
.audit-banner-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* Idle state — audit hasn't run yet. Calmer colors than the missing-asset
   warning state because there's nothing wrong, the operator just hasn't
   asked to scan. */
.audit-banner.audit-banner-idle {
  background: var(--bg-tertiary);
  border-color: var(--border);
}
.audit-banner.audit-banner-idle .audit-banner-icon { color: var(--text-muted); }

/* Clean state — audit ran and everything's there. Subtle green so it
   reads as "good news" without being loud. */
.audit-banner.audit-banner-clean {
  background: rgba(52, 211, 153, 0.08);
  border-color: rgba(52, 211, 153, 0.35);
}
.audit-banner.audit-banner-clean .audit-banner-icon { color: #34d399; }

/* No-upload-destinations banner — same shape as the audit banner but
   blue/info-toned so it doesn't scream over a genuine missing-asset
   alert. Clickable across its full width. */
.no-upload-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding: 10px 14px;
  background: rgba(96, 165, 250, 0.10);
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: var(--radius-sm);
  font-size: 13px;
  text-decoration: none;
  color: inherit;
  transition: background 0.15s ease;
}
.no-upload-banner:hover { background: rgba(96, 165, 250, 0.18); }
.no-upload-icon { font-size: 16px; }
.no-upload-text { flex: 1 1 280px; min-width: 0; line-height: 1.4; }
.no-upload-cta {
  font-weight: 600;
  color: var(--info, #60a5fa);
  flex-shrink: 0;
}

/* Hero stats */
.hero-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.hero-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px;
  text-align: center;
  transition: all 0.2s;
}

.hero-card:hover { transform: translateY(-2px); border-color: var(--border-light); }
.hero-card.accent { border-color: rgba(240, 198, 116, 0.3); }
.hero-card.success { border-color: rgba(74, 222, 128, 0.3); }
.hero-card.time-saved { border-color: rgba(96, 165, 250, 0.3); }

.hero-icon { font-size: 24px; margin-bottom: 8px; }

.hero-number {
  font-size: 32px;
  font-weight: 700;
  color: var(--accent);
  line-height: 1;
}

.hero-card.success .hero-number { color: var(--success); }
.hero-card.time-saved .hero-number { color: var(--info); }

.hero-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 6px;
}

/* Asset rings */
.asset-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.asset-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.asset-ring {
  position: relative;
  width: 56px;
  height: 56px;
}

.ring-svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.ring-bg {
  fill: none;
  stroke: var(--bg-tertiary);
  stroke-width: 3;
}

.ring-fill {
  fill: none;
  stroke: var(--accent);
  stroke-width: 3;
  stroke-linecap: round;
  transition: stroke-dasharray 0.6s ease;
}

.ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.asset-label {
  font-size: 11px;
  color: var(--text-muted);
}

/* Session stats */
.session-stats {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  color: var(--text-secondary);
}

.session-row.highlight {
  background: var(--accent-dim);
  margin: 4px -8px 0;
  padding: 8px;
  border-radius: var(--radius-sm);
  border-bottom: none;
  font-weight: 500;
}

.prev-date { font-size: 11px; }

/* Workflow vertical */
.workflow-vertical {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.wf-step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
  font-size: 13px;
}
.wf-step:hover { background: var(--bg-hover); }
.wf-num { width: 20px; height: 20px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; flex-shrink: 0; }
.wf-icon { font-size: 13px; }
.wf-label { font-weight: 500; }
.wf-arrow { display: none; }

@media (max-width: 768px) {
  .hero-stats { grid-template-columns: repeat(2, 1fr); }
  .asset-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
