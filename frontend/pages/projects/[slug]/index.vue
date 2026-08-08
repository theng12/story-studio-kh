<template>
  <div class="workspace-page dashboard-workspace">
    <WorkspaceHero
      eyebrow="Project command center"
      :title="project?.name || 'Dashboard'"
      description="See verified production readiness, unblock the next episodes, and keep the fleet moving from one calm overview."
    >
      <template #aside>
        <div class="dashboard-hero-summary">
          <div>
            <strong>{{ readyCount }}</strong>
            <span>complete</span>
          </div>
          <div>
            <strong>{{ needsWorkCount }}</strong>
            <span>need work</span>
          </div>
          <div>
            <strong>{{ activeJobCount }}</strong>
            <span>active jobs</span>
          </div>
        </div>
      </template>
    </WorkspaceHero>

    <WorkspaceNotice v-if="initialLoading" title="Loading verified project status" tone="info">
      The cached episode inventory appears immediately on return visits.
    </WorkspaceNotice>
    <WorkspaceNotice v-else-if="loadError" title="Some project information could not be refreshed" tone="warning">
      {{ loadError }}
      <template #actions>
        <button class="btn btn-sm btn-secondary" @click="refreshAll">Retry</button>
      </template>
    </WorkspaceNotice>

    <section class="dashboard-metrics" aria-label="Project readiness">
      <NuxtLink :to="`/projects/${slug}/board`" class="dashboard-metric dashboard-metric-attention">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Needs work</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ needsWorkCount }}</strong>
        <span class="dashboard-metric-detail">{{ needsWorkCount === 1 ? 'episode has' : 'episodes have' }} at least one required stage pending</span>
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/video-assembly`" class="dashboard-metric dashboard-metric-accent">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Ready to render</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ readyToRenderCount }}</strong>
        <span class="dashboard-metric-detail">Verified through Scene Review and waiting for final assembly</span>
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/upload`" class="dashboard-metric dashboard-metric-success">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Final videos</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ finalVideoCount }}</strong>
        <span class="dashboard-metric-detail">Assembled episodes ready for publishing or already delivered</span>
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/ideas`" class="dashboard-metric">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Idea library</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ overview?.ideas?.total || 0 }}</strong>
        <span class="dashboard-metric-detail">{{ overview?.ideas?.new || 0 }} new ideas waiting for review</span>
      </NuxtLink>
    </section>

    <WorkspaceSection
      eyebrow="Priority queue"
      title="Focus now"
      description="The most useful next moves, ranked from current verified status rather than folder guesses."
    >
      <template #actions>
        <button class="btn btn-sm btn-secondary" :disabled="refreshing" @click="refreshAll">
          <LoadingSpinner v-if="refreshing" size="sm" />
          <span v-else>Refresh status</span>
        </button>
      </template>
      <div v-if="focusActions.length" class="focus-grid">
        <NuxtLink v-for="action in focusActions" :key="action.key" :to="action.to" class="focus-card" :data-tone="action.tone">
          <span class="focus-index">{{ action.order }}</span>
          <div>
            <strong>{{ action.title }}</strong>
            <p>{{ action.detail }}</p>
          </div>
          <span class="focus-arrow" aria-hidden="true">&rarr;</span>
        </NuxtLink>
      </div>
      <div v-else class="dashboard-empty">
        <strong>No blockers detected.</strong>
        <span>Your required production stages are complete for every accepted episode.</span>
      </div>
    </WorkspaceSection>

    <WorkspaceSection
      eyebrow="Verified coverage"
      title="Production workflow"
      description="Every count uses the same completion contract as Pipeline and Production Board. Optional stages remain visible but never block completion."
    >
      <template #actions>
        <NuxtLink :to="`/projects/${slug}/pipeline`" class="btn btn-sm btn-primary">Open Pipeline</NuxtLink>
      </template>
      <div class="coverage-grid">
        <NuxtLink
          v-for="stage in coverageStages"
          :key="stage.key"
          :to="stage.to"
          class="coverage-card"
        >
          <div class="coverage-card-head">
            <span class="coverage-step">{{ stage.order }}</span>
            <span class="coverage-icon" aria-hidden="true">{{ stage.icon }}</span>
            <strong>{{ stage.label }}</strong>
            <span v-if="stage.optional" class="coverage-optional">optional</span>
            <span class="coverage-count">{{ stage.done }}/{{ episodeCount }}</span>
          </div>
          <div class="coverage-track" aria-hidden="true">
            <span :style="{ transform: `scaleX(${stage.pct / 100})` }" />
          </div>
          <div class="coverage-card-foot">
            <span>{{ stage.pct }}% complete</span>
            <span v-if="stage.missing">{{ stage.missing }} pending</span>
            <span v-else>clear</span>
          </div>
        </NuxtLink>
      </div>
    </WorkspaceSection>

    <div class="dashboard-lower-grid">
      <WorkspaceSection
        eyebrow="Operations"
        title="Fleet and delivery"
        description="Live queue, publishing setup, and storage integrity in one place."
      >
        <div class="operations-stack">
          <NuxtLink :to="`/projects/${slug}/jobs`" class="operation-row">
            <span class="operation-mark" data-tone="info">Q</span>
            <div>
              <strong>Job Queue</strong>
              <p v-if="jobStats.total">{{ jobStats.running }} running, {{ jobStats.queued }} queued, {{ jobStats.error }} failed</p>
              <p v-else>No queued or recent jobs.</p>
            </div>
            <span v-if="jobsStale" class="operation-state warning">may be stale</span>
            <span v-else-if="activeJobCount" class="operation-state live">working</span>
            <span v-else class="operation-state">idle</span>
          </NuxtLink>

          <NuxtLink :to="`/projects/${slug}/upload`" class="operation-row">
            <span class="operation-mark" data-tone="success">P</span>
            <div>
              <strong>Publishing</strong>
              <p v-if="uploadAccountCount === 0">No YouTube destination is connected yet.</p>
              <p v-else-if="uploadAccountCount === null">Publishing connection could not be checked.</p>
              <p v-else>{{ uploadAccountCount }} connected destination{{ uploadAccountCount === 1 ? '' : 's' }}.</p>
            </div>
            <span class="operation-state" :class="uploadAccountCount === 0 ? 'warning' : uploadAccountCount === null ? '' : 'live'">
              {{ uploadAccountCount === 0 ? 'setup needed' : uploadAccountCount === null ? 'unknown' : 'ready' }}
            </span>
          </NuxtLink>

          <div class="operation-row operation-row-static">
            <span class="operation-mark" data-tone="accent">A</span>
            <div>
              <strong>Asset integrity</strong>
              <p v-if="auditRunning">Checking every expected artifact against disk...</p>
              <p v-else-if="audit && audit.total_missing">{{ audit.total_missing }} missing across {{ audit.episodes_with_missing }} episodes.</p>
              <p v-else-if="audit">Last audit found no missing assets.</p>
              <p v-else>Deep audit is manual so large projects stay fast.</p>
            </div>
            <div class="operation-actions">
              <button v-if="audit?.total_missing" class="btn btn-sm btn-secondary" @click="showDialog = true">Details</button>
              <button class="btn btn-sm" :class="audit?.total_missing ? 'btn-primary' : 'btn-secondary'" :disabled="auditRunning" @click="runAudit">
                {{ audit ? 'Re-scan' : 'Run audit' }}
              </button>
            </div>
          </div>
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        eyebrow="Activity"
        title="Production pulse"
        description="A compact view of tracked output and production activity. Credit balances and settlement live in GenStudio."
      >
        <div class="pulse-grid">
          <div class="pulse-stat">
            <span>This session</span>
            <strong>{{ currentSessionOutputs }}</strong>
            <small>tracked outputs</small>
          </div>
          <div class="pulse-stat">
            <span>All sessions</span>
            <strong>{{ overview?.session?.all_time?.total_sessions || 0 }}</strong>
            <small>production sessions</small>
          </div>
          <div class="pulse-stat">
            <span>All outputs</span>
            <strong>{{ overview?.session?.all_time?.total_assets || 0 }}</strong>
            <small>tracked across sessions</small>
          </div>
          <div class="pulse-stat">
            <span>Accepted episodes</span>
            <strong>{{ episodeCount }}</strong>
            <small>in this project</small>
          </div>
        </div>
        <div class="pulse-note">
          <span>{{ currentSessionSummary }}</span>
          <NuxtLink to="/usage">View usage</NuxtLink>
        </div>
      </WorkspaceSection>
    </div>

    <MissingAssetsDialog
      v-if="audit"
      :visible="showDialog"
      :slug="slug"
      :report="audit"
      @close="showDialog = false"
    />
  </div>
</template>

<script setup lang="ts">
import type { ProjectAudit } from '~/types/audit'
import type { EpisodeRow } from '~/composables/useEpisodes'
import {
  flowForVisualSource,
  normalizeVisualSource,
  type FlowStep,
  type VisualSource,
} from '~/composables/useProjectFlow'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Dashboard')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { project } = useProject()
const { get } = useApi()
const { stats: jobStats, jobsStale } = useJobs()
const {
  episodes,
  isLoading: episodesLoading,
  isRevalidating: episodesRefreshing,
  error: episodesError,
  refresh: refreshEpisodes,
} = useEpisodes(slug)
const notif = useNotifications()

interface DashboardOverview {
  ideas: { total: number; accepted: number; new: number }
  session: {
    current?: Record<string, number>
    previous?: Record<string, number> | null
    all_time?: { total_sessions: number; total_assets: number }
  }
}

const overview = ref<DashboardOverview | null>(null)
const overviewLoading = ref(true)
const overviewError = ref('')
const accountsError = ref('')
const formatError = ref('')
const uploadAccountCount = ref<number | null>(null)
const visualSource = ref<VisualSource>('narrated-scenes')

const STATUS_FIELD: Record<string, keyof EpisodeRow['status']> = {
  script: 'script',
  metadata: 'metadata',
  'thumb-prompts': 'thumb_prompts',
  thumbnails: 'thumbnails',
  audio: 'audio',
  'audio-merge': 'merged_audio',
  subtitles: 'subtitles',
  'character-sheet': 'character_sheet',
  'scene-plan': 'scene_plan',
  'scene-review': 'scene_review',
  'motion-review': 'motion_review',
  'video-assembly': 'video_assembly',
}

const steps = computed(() => flowForVisualSource(visualSource.value))
const episodeCount = computed(() => episodes.value.length)

function routeForStep(step: FlowStep): string {
  const base = `/projects/${slug.value}${step.path}`
  return step.tab ? `${base}?tab=${step.tab}` : base
}

function statusDone(ep: EpisodeRow, field: keyof EpisodeRow['status']): boolean {
  return ep.status?.[field] === true
}

const coverageStages = computed(() => steps.value.map((step, index) => {
  const field = STATUS_FIELD[step.key]
  const done = step.key === 'ideas'
    ? episodeCount.value
    : field
      ? episodes.value.filter(ep => statusDone(ep, field)).length
      : 0
  const pct = episodeCount.value ? Math.round((done / episodeCount.value) * 100) : 0
  return {
    ...step,
    order: String(index + 1).padStart(2, '0'),
    done,
    missing: Math.max(0, episodeCount.value - done),
    pct,
    field,
    to: routeForStep(step),
  }
}))

const requiredFields = computed(() => coverageStages.value
  .filter(stage => !stage.optional && stage.field)
  .map(stage => stage.field as keyof EpisodeRow['status']))

function isComplete(ep: EpisodeRow): boolean {
  return requiredFields.value.every(field => statusDone(ep, field))
}

const readyCount = computed(() => episodes.value.filter(isComplete).length)
const needsWorkCount = computed(() => Math.max(0, episodeCount.value - readyCount.value))
const finalVideoCount = computed(() => episodes.value.filter(ep => statusDone(ep, 'video_assembly')).length)
const preRenderFields = computed(() => requiredFields.value.filter(field => field !== 'video_assembly'))
const readyToRenderCount = computed(() => episodes.value.filter(ep =>
  !statusDone(ep, 'video_assembly') && preRenderFields.value.every(field => statusDone(ep, field)),
).length)
const activeJobCount = computed(() => jobStats.value.running + jobStats.value.queued)

type FocusTone = 'warning' | 'accent' | 'success' | 'neutral'
interface FocusAction { key: string; order: string; title: string; detail: string; to: string; tone: FocusTone }

const focusActions = computed<FocusAction[]>(() => {
  const actions: FocusAction[] = []
  if (jobStats.value.error > 0) {
    actions.push({
      key: 'failed-jobs', order: '01', tone: 'warning',
      title: `Repair ${jobStats.value.error} failed job${jobStats.value.error === 1 ? '' : 's'}`,
      detail: 'Open the queue for the exact missing output and a safe retry path.',
      to: `/projects/${slug.value}/jobs?status=error`,
    })
  }
  if (readyToRenderCount.value > 0) {
    actions.push({
      key: 'ready-render', order: String(actions.length + 1).padStart(2, '0'), tone: 'accent',
      title: `Render ${readyToRenderCount.value} ready episode${readyToRenderCount.value === 1 ? '' : 's'}`,
      detail: 'All required upstream stages are verified; final assembly is the only remaining step.',
      to: `/projects/${slug.value}/video-assembly`,
    })
  }
  const firstPending = coverageStages.value.find(stage => !stage.optional && stage.key !== 'video-assembly' && stage.missing > 0)
  if (firstPending) {
    actions.push({
      key: `pending-${firstPending.key}`, order: String(actions.length + 1).padStart(2, '0'), tone: 'neutral',
      title: `Continue ${firstPending.label}`,
      detail: `${firstPending.missing} episode${firstPending.missing === 1 ? '' : 's'} still need this required stage.`,
      to: firstPending.to,
    })
  }
  if (finalVideoCount.value > 0 && uploadAccountCount.value === 0) {
    actions.push({
      key: 'publishing-setup', order: String(actions.length + 1).padStart(2, '0'), tone: 'warning',
      title: 'Connect a publishing destination',
      detail: 'Final videos exist, but this project has no YouTube destination connected.',
      to: `/projects/${slug.value}/upload`,
    })
  } else if ((overview.value?.ideas?.new || 0) > 0) {
    actions.push({
      key: 'review-ideas', order: String(actions.length + 1).padStart(2, '0'), tone: 'success',
      title: `Review ${overview.value?.ideas?.new} new idea${overview.value?.ideas?.new === 1 ? '' : 's'}`,
      detail: 'Accept the strongest concepts when you are ready to expand the production slate.',
      to: `/projects/${slug.value}/ideas`,
    })
  }
  return actions.slice(0, 4)
})

const emptySession = {
  ideas_generated: 0,
  scripts_generated: 0,
  prompts_generated: 0,
  images_generated: 0,
  audio_generated: 0,
  descriptions_generated: 0,
}
const currentSession = computed(() => ({ ...emptySession, ...(overview.value?.session?.current || {}) }))
const currentSessionOutputs = computed(() => [
  currentSession.value.ideas_generated,
  currentSession.value.scripts_generated,
  currentSession.value.prompts_generated,
  currentSession.value.images_generated,
  currentSession.value.audio_generated,
  currentSession.value.descriptions_generated,
].reduce((sum, value) => sum + Number(value || 0), 0))
const currentSessionSummary = computed(() => {
  const parts = [
    ['ideas', currentSession.value.ideas_generated],
    ['scripts', currentSession.value.scripts_generated],
    ['prompts', currentSession.value.prompts_generated],
    ['images', currentSession.value.images_generated],
    ['audio items', currentSession.value.audio_generated],
  ].filter(([, count]) => Number(count) > 0).map(([label, count]) => `${count} ${label}`)
  return parts.length ? `This session: ${parts.join(' · ')}` : 'No generation output has been tracked in this session yet.'
})

const audit = ref<ProjectAudit | null>(null)
const auditRunning = ref(false)
const auditError = ref('')
const showDialog = ref(false)
const auditCache = useState<Record<string, { result: ProjectAudit; ts: number }>>('dashboard-audit-cache', () => ({}))
const AUDIT_TTL_MS = 30 * 60 * 1000

function hydrateAudit() {
  const cached = auditCache.value[slug.value]
  if (cached && Date.now() - cached.ts < AUDIT_TTL_MS) {
    audit.value = cached.result
  } else {
    audit.value = null
  }
}

async function runAudit() {
  if (auditRunning.value) return
  auditRunning.value = true
  auditError.value = ''
  try {
    const result = await get<ProjectAudit>(`/projects/${slug.value}/assets-audit-detail`)
    audit.value = result
    auditCache.value[slug.value] = { result, ts: Date.now() }
  } catch (error: any) {
    auditError.value = error?.data?.detail || error?.message || 'Asset audit failed'
  } finally {
    auditRunning.value = false
    reportReadiness()
  }
}

async function loadOverview() {
  overviewLoading.value = true
  await Promise.all([
    (async () => {
      try {
        overview.value = await get<DashboardOverview>(`/projects/${slug.value}/dashboard-stats`)
        overviewError.value = ''
      } catch (error: any) {
        if (!error?.__slugRace) overviewError.value = error?.data?.detail || error?.message || 'Dashboard overview failed'
      }
    })(),
    (async () => {
      try {
        const response = await get<{ accounts: Record<string, unknown[]> }>(`/projects/${slug.value}/upload/accounts`)
        uploadAccountCount.value = Object.values(response?.accounts || {}).reduce((sum, accounts) => sum + accounts.length, 0)
        accountsError.value = ''
      } catch (error: any) {
        if (error?.__slugRace) return
        uploadAccountCount.value = null
        accountsError.value = error?.data?.detail || error?.message || 'Publishing connection check failed'
      }
    })(),
    (async () => {
      try {
        const format = await get<{ visualSource?: string; sceneAlignment?: string }>(`/projects/${slug.value}/effective-format`)
        visualSource.value = normalizeVisualSource(format?.visualSource, format?.sceneAlignment)
        formatError.value = ''
      } catch (error: any) {
        if (!error?.__slugRace) formatError.value = error?.data?.detail || error?.message || 'Project workflow check failed'
      }
    })(),
  ])
  overviewLoading.value = false
  reportReadiness()
}

const refreshing = computed(() => episodesRefreshing.value || overviewLoading.value)
const initialLoading = computed(() => (episodesLoading.value || overviewLoading.value) && !episodes.value.length)
const loadError = computed(() => {
  const episodeMessage = episodesError.value instanceof Error ? episodesError.value.message : episodesError.value ? String(episodesError.value) : ''
  return [episodeMessage, overviewError.value, accountsError.value, formatError.value, auditError.value].filter(Boolean).join(' ')
})

async function refreshAll() {
  await Promise.all([refreshEpisodes(), loadOverview()])
  reportReadiness()
}

function reportReadiness() {
  const projectSlug = slug.value
  if (!projectSlug) return
  if (loadError.value) {
    notif.report(projectSlug, {
      key: 'dashboard-load-error',
      severity: 'warning',
      title: 'Some dashboard information could not be refreshed',
      detail: loadError.value,
      onClick: refreshAll,
      actionLabel: 'Retry',
    })
  } else {
    notif.clear(projectSlug, 'dashboard-load-error')
  }
  if (audit.value && audit.value.total_missing > 0) {
    notif.report(projectSlug, {
      key: 'assets',
      severity: 'warning',
      title: `${audit.value.total_missing} missing asset${audit.value.total_missing === 1 ? '' : 's'}`,
      detail: `The gaps affect ${audit.value.episodes_with_missing} episode${audit.value.episodes_with_missing === 1 ? '' : 's'}.`,
      to: `/projects/${projectSlug}/board?repair=1`,
    })
  } else {
    notif.clear(projectSlug, 'assets')
  }
}

watch([episodesError, overviewError, accountsError, formatError], reportReadiness)
onMounted(() => {
  hydrateAudit()
  void loadOverview()
})
onBeforeUnmount(() => {
  const projectSlug = slug.value
  if (projectSlug) notif.clear(projectSlug, 'dashboard-load-error')
})
</script>

<style scoped>
.dashboard-workspace {
  --dashboard-gold: #e8b85d;
  --dashboard-green: #4fd08a;
  --dashboard-blue: #69a8ff;
}

.dashboard-hero-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(84px, 1fr));
  gap: 10px;
}

.dashboard-hero-summary > div {
  min-width: 84px;
  padding: 12px 14px;
  border: 1px solid rgba(232, 184, 93, 0.22);
  border-radius: 14px;
  background: rgba(10, 13, 20, 0.36);
  text-align: center;
}

.dashboard-hero-summary strong,
.dashboard-hero-summary span { display: block; }
.dashboard-hero-summary strong { font: 700 22px/1 var(--font-display); color: #f3cd82; }
.dashboard-hero-summary span { margin-top: 6px; color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; letter-spacing: .09em; }

.dashboard-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1px;
  /* Keep the metric cards clear of the hero border at every workspace width. */
  margin-top: var(--workspace-section-gap);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--border);
}

.dashboard-metric {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 104px;
  padding: 14px 16px;
  flex-direction: column;
  justify-content: flex-start;
  gap: 8px;
  overflow: hidden;
  color: inherit;
  text-decoration: none;
  border: 0;
  border-radius: 0;
  background: var(--bg-secondary);
  transition: background .18s ease;
}

.dashboard-metric:hover { background: var(--bg-hover); }
.dashboard-metric-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.dashboard-metric-kicker { color: var(--text-muted); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.dashboard-metric-arrow { width: 34px; height: 3px; border-radius: 3px; background: var(--text-muted); color: transparent; flex: 0 0 auto; opacity: .5; }
.dashboard-metric-attention .dashboard-metric-arrow { background: var(--dashboard-gold); opacity: 1; }
.dashboard-metric-accent .dashboard-metric-arrow { background: var(--dashboard-blue); opacity: 1; }
.dashboard-metric-success .dashboard-metric-arrow { background: var(--dashboard-green); opacity: 1; }
.dashboard-metric strong { margin: 0; font: 700 28px/1 var(--font-display); color: var(--text-primary); }
.dashboard-metric-detail { display: block; min-width: 0; margin-top: auto; color: var(--text-secondary); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }

.focus-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.focus-card {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 20px;
  gap: 12px;
  align-items: center;
  min-height: 96px;
  padding: 16px;
  color: inherit;
  text-decoration: none;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: rgba(255,255,255,.018);
  transition: border-color .16s ease, background .16s ease;
}
.focus-card:hover { border-color: var(--border-light); background: var(--bg-hover); }
.focus-card:first-child {
  border-color: color-mix(in srgb, var(--dashboard-gold) 38%, var(--border));
  background: color-mix(in srgb, var(--dashboard-gold) 6%, var(--bg-secondary));
}
.focus-index { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 50%; background: var(--bg-tertiary); color: var(--dashboard-gold); font: 700 11px/1 var(--font-mono); }
.focus-card strong { display: block; color: var(--text-primary); font-size: 14px; }
.focus-card p { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
.focus-arrow { color: var(--text-muted); font-size: 18px; }
.dashboard-empty { display: flex; min-height: 88px; padding: 18px; flex-direction: column; justify-content: center; border: 1px dashed rgba(79,208,138,.35); border-radius: 14px; background: rgba(79,208,138,.045); }
.dashboard-empty span { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }

.coverage-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.coverage-card { padding: 13px 14px; color: inherit; text-decoration: none; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,255,255,.014); }
.coverage-card:hover { border-color: rgba(232,184,93,.35); background: rgba(232,184,93,.035); }
.coverage-card-head { display: grid; grid-template-columns: 26px 20px minmax(0, 1fr) auto auto; align-items: center; gap: 8px; }
.coverage-step { color: var(--text-muted); font: 600 10px/1 var(--font-mono); }
.coverage-icon { font-size: 14px; }
.coverage-card-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.coverage-optional { padding: 2px 6px; color: #d8b471; border: 1px solid rgba(216,180,113,.25); border-radius: 999px; font-size: var(--font-xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.coverage-count { color: var(--text-secondary); font: 600 10px/1 var(--font-mono); }
.coverage-track { height: 4px; margin: 11px 0 7px 54px; overflow: hidden; border-radius: 99px; background: var(--bg-tertiary); }
.coverage-track span { display: block; width: 100%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #c88f37, #f0cb78); transform-origin: left; transition: transform .35s ease; }
.coverage-card-foot { display: flex; justify-content: space-between; margin-left: 54px; color: var(--text-muted); font-size: var(--font-xs); }

.dashboard-lower-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(340px, .75fr); gap: 16px; align-items: stretch; }
.dashboard-lower-grid :deep(.workspace-section) { height: 100%; }
.operations-stack { display: flex; flex-direction: column; gap: 8px; }
.operation-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: 12px; align-items: center; min-height: 72px; padding: 12px; color: inherit; text-decoration: none; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,255,255,.014); }
.operation-row:hover { border-color: var(--border-light); background: var(--bg-hover); }
.operation-row-static:hover { border-color: var(--border); background: rgba(255,255,255,.014); }
.operation-mark { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 11px; color: var(--text-primary); background: var(--bg-tertiary); font: 700 12px/1 var(--font-mono); }
.operation-mark[data-tone="info"] { color: #8ebcff; background: rgba(105,168,255,.12); }
.operation-mark[data-tone="success"] { color: #76dfa3; background: rgba(79,208,138,.12); }
.operation-mark[data-tone="accent"] { color: #f0c875; background: rgba(232,184,93,.12); }
.operation-row strong { font-size: 13px; }
.operation-row p { margin: 3px 0 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.4; }
.operation-state { padding: 4px 8px; color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; font-size: var(--font-xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.operation-state.live { color: #65d995; border-color: rgba(79,208,138,.28); background: rgba(79,208,138,.07); }
.operation-state.warning { color: #e5a15e; border-color: rgba(217,139,69,.32); background: rgba(217,139,69,.08); }
.operation-actions { display: flex; gap: 6px; }

.pulse-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.pulse-stat { min-height: 102px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,255,255,.014); }
.pulse-stat span, .pulse-stat small { display: block; color: var(--text-muted); font-size: var(--font-xs); font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.pulse-stat strong { display: block; margin: 10px 0 5px; color: var(--text-primary); font: 700 25px/1 var(--font-display); }
.pulse-stat small { font-size: var(--font-xs); font-weight: 500; }
.pulse-note { display: flex; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 12px 14px; border-radius: 11px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.pulse-note a { flex: 0 0 auto; color: var(--dashboard-gold); }

@media (max-width: 1180px) {
  .dashboard-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dashboard-lower-grid { grid-template-columns: 1fr; }
}

@media (max-width: 760px) {
  .dashboard-hero-summary { grid-template-columns: repeat(3, 1fr); width: 100%; }
  .dashboard-metrics, .focus-grid, .coverage-grid, .pulse-grid { grid-template-columns: 1fr; }
  .dashboard-metric { min-height: 100px; }
  .operation-row { grid-template-columns: 38px minmax(0, 1fr); }
  .operation-state, .operation-actions { grid-column: 2; justify-self: start; }
  .pulse-note { flex-direction: column; }
}

@media (prefers-reduced-motion: reduce) {
  .dashboard-metric, .focus-card, .coverage-track span { transition: none; }
}
</style>
