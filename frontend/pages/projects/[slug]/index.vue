<template>
  <div class="workspace-page dashboard-workspace">
    <WorkspaceHero
      eyebrow="Channel dashboard"
      :title="project?.name || 'Dashboard'"
      description="See where every episode stands, what to do next, and what is holding production up."
    >
      <template #aside>
        <div class="dashboard-hero-summary">
          <div>
            <strong>{{ statusKnown ? readyCount : '—' }}</strong>
            <span>complete</span>
          </div>
          <div>
            <strong>{{ statusKnown ? needsWorkCount : '—' }}</strong>
            <span>need work</span>
          </div>
          <div>
            <strong>{{ activeJobCount }}</strong>
            <span>active jobs</span>
          </div>
        </div>
      </template>
    </WorkspaceHero>

    <!-- v1.4.2 — the episodes folder does not resolve. This sits ABOVE the
         loading and refresh notices deliberately: while it is true, every count
         below reads zero and every episode is missing, and a person who cannot
         see why will go looking for the wrong fault. No auto-repair — the path
         is named and a person decides, because guessing a replacement is how an
         empty sibling folder gets silently adopted. -->
    <WorkspaceNotice
      v-if="outputRootMissing"
      tone="warning"
      title="This project's episodes folder could not be found"
    >
      Story Studio looked for <code>{{ outputRootPath }}</code> and it is not there. Until it is,
      this project will show no episodes — the files are not lost, the app just cannot see where
      they went. This usually means the folder was moved, renamed, or lives on a drive that is not
      mounted.
      <template #actions>
        <NuxtLink :to="`/projects/${slug}/settings#storage`" class="btn btn-sm">Settings → Storage</NuxtLink>
      </template>
    </WorkspaceNotice>

    <WorkspaceNotice v-if="initialLoading" title="Loading project status" tone="info">
      Episodes you have already opened appear straight away while the latest status loads.
    </WorkspaceNotice>
    <WorkspaceNotice v-else-if="loadError" title="Some project information could not be refreshed" tone="warning">
      {{ loadError }}
      <template #actions>
        <button class="btn btn-sm btn-secondary" :disabled="refreshing" @click="retryLoad">Retry</button>
      </template>
    </WorkspaceNotice>

    <section class="dashboard-metrics" aria-label="Project readiness">
      <NuxtLink :to="`/projects/${slug}/board`" class="dashboard-metric dashboard-metric-attention">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Needs work</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ statusKnown ? needsWorkCount : '—' }}</strong>
        <span class="dashboard-metric-detail">{{ !statusKnown ? 'Status has not loaded yet' : `${needsWorkCount === 1 ? 'episode has' : 'episodes have'} at least one required step still to do` }}</span>
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/video-assembly`" class="dashboard-metric dashboard-metric-accent">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Ready for final video</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ statusKnown ? readyToRenderCount : '—' }}</strong>
        <span class="dashboard-metric-detail">{{ statusKnown ? 'Ready for final video: every earlier step is done' : 'Status has not loaded yet' }}</span>
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/upload`" class="dashboard-metric dashboard-metric-success">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Final videos</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ episodesKnown ? finalVideoCount : '—' }}</strong>
        <span class="dashboard-metric-detail">{{ episodesKnown ? 'Finished videos, ready to publish or already published' : 'Status has not loaded yet' }}</span>
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/ideas`" class="dashboard-metric">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Idea library</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ overview?.ideas ? overview.ideas.total : '—' }}</strong>
        <span class="dashboard-metric-detail">{{ overview?.ideas ? `${overview.ideas.new} new ideas waiting for review` : 'Idea counts have not loaded yet' }}</span>
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/board`" class="dashboard-metric" title="Channel cost: paid Gateway charges plus local Mac compute">
        <span class="dashboard-metric-top">
          <span class="dashboard-metric-kicker">Channel cost</span>
          <span class="dashboard-metric-arrow" aria-hidden="true">→</span>
        </span>
        <strong>{{ formatTotal(channelTotal?.total_usd, 'No data') }}</strong>
        <span class="dashboard-metric-detail">{{ channelCostDetail }}</span>
      </NuxtLink>
    </section>

    <p v-if="statusKnown && visualSource && episodes.length" class="dashboard-stages" aria-label="Episodes by state">
      <NuxtLink
        v-for="stage in stageCounts"
        :key="stage.key"
        :to="`/projects/${slug}/board`"
        class="dashboard-stage"
        :data-stage="stage.key"
      ><strong>{{ stage.count }}</strong> {{ stage.label.toLowerCase() }}</NuxtLink>
    </p>

    <WorkspaceSection
      eyebrow="Priority queue"
      title="Focus now"
      description="The most useful next steps, based on each episode's checked status."
    >
      <template #actions>
        <button
          class="btn btn-sm btn-secondary"
          :disabled="refreshing"
          title="Re-reads changed episodes. Shift-click to re-check every episode from disk (slow on a large channel)."
          @click="refreshAll"
        >
          <LoadingSpinner v-if="refreshing" size="sm" />
          <span v-else>Refresh</span>
        </button>
        <span v-if="episodesRefreshing && episodes.length" class="dashboard-updating" role="status">Updating…</span>
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
      <div v-else-if="statusPending" class="dashboard-empty">
        <strong>Checking project status…</strong>
      </div>
      <div v-else-if="!statusKnown" class="dashboard-empty">
        <strong>Can't tell yet — status didn't load.</strong>
        <span>Nothing is being reported as finished until the episode status can be read.</span>
        <div><button class="btn btn-sm btn-secondary" :disabled="refreshing" @click="retryLoad">Retry</button></div>
      </div>
      <div v-else class="dashboard-empty">
        <strong>{{ noAcceptedIdeas ? 'Start with ideas.' : 'Nothing is holding you up.' }}</strong>
        <span v-if="noAcceptedIdeas">Generate and accept an idea to begin tracking this channel’s production workflow.</span>
        <span v-else>Every required step is done for every accepted episode.</span>
      </div>
    </WorkspaceSection>

    <WorkspaceSection
      eyebrow="Progress by step"
      title="Production workflow"
      description="Every count uses the same rules as Pipeline and Production Board. Optional steps are shown but never hold an episode back."
    >
      <template #actions>
        <NuxtLink :to="`/projects/${slug}/pipeline`" class="btn btn-sm btn-primary">Open Pipeline</NuxtLink>
      </template>
      <p v-if="!coverageStages.length" class="text-muted">
        {{ statusPending ? 'Checking project status…' : 'Step progress appears once this project’s status has loaded.' }}
      </p>
      <div v-else class="coverage-grid">
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
            <span class="coverage-count">{{ stage.done }}/{{ stage.eligible }}</span>
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
        title="Queue and delivery"
        description="Live queue, publishing setup, and storage integrity in one place."
      >
        <div class="operations-stack">
          <NuxtLink :to="`/projects/${slug}/jobs`" class="operation-row">
            <span class="operation-mark" data-tone="info" aria-hidden="true">☰</span>
            <div>
              <strong>Job Queue</strong>
              <p v-if="jobsLoading">Checking…</p>
              <p v-else-if="jobStats.total">{{ jobStats.running }} running, {{ jobStats.queued }} queued, {{ jobStats.error }} failed</p>
              <p v-else>No queued or recent jobs.</p>
            </div>
            <span v-if="jobsLoading" class="operation-state">checking</span>
            <span v-else-if="jobsStale" class="operation-state warning">may be stale</span>
            <span v-else-if="activeJobCount" class="operation-state live">working</span>
            <span v-else class="operation-state">idle</span>
          </NuxtLink>

          <NuxtLink :to="`/projects/${slug}/upload`" class="operation-row">
            <span class="operation-mark" data-tone="success" aria-hidden="true">↗</span>
            <div>
              <strong>Publishing</strong>
              <p v-if="uploadAccountCount === 0">No YouTube account is connected yet.</p>
              <p v-else-if="uploadAccountCount === null">Couldn't check the YouTube connection.</p>
              <p v-else>{{ uploadAccountCount }} YouTube account{{ uploadAccountCount === 1 ? '' : 's' }} connected.</p>
            </div>
            <span class="operation-state" :class="uploadAccountCount === 0 ? 'warning' : uploadAccountCount === null ? '' : 'live'">
              {{ uploadAccountCount === 0 ? 'setup needed' : uploadAccountCount === null ? 'unknown' : 'ready' }}
            </span>
          </NuxtLink>

          <div class="operation-row operation-row-static">
            <span class="operation-mark" data-tone="accent" aria-hidden="true">▣</span>
            <div>
              <strong>Files check</strong>
              <p v-if="auditRunning">Checking that every expected file is on disk…</p>
              <p v-else-if="audit && audit.total_missing && hasUnmeasurableAudit">{{ audit.total_missing }} missing across {{ audit.episodes_with_missing }} episodes. Some checks could not be completed; check storage access and check again. {{ auditAgeLabel }}</p>
              <p v-else-if="audit && audit.total_missing">{{ audit.total_missing }} missing across {{ audit.episodes_with_missing }} episodes. {{ auditAgeLabel }}</p>
              <p v-else-if="audit && hasUnmeasurableAudit">Some checks could not be completed. Check that project storage is available, then check again. {{ auditAgeLabel }}</p>
              <p v-else-if="audit">No missing files found. {{ auditAgeLabel }}</p>
              <p v-else>Not checked yet. This is manual so large channels stay fast.</p>
            </div>
            <div class="operation-actions">
              <button v-if="hasAuditDetails" class="btn btn-sm btn-secondary" @click="showDialog = true">Details</button>
              <button class="btn btn-sm" :class="hasAuditDetails ? 'btn-primary' : 'btn-secondary'" :disabled="auditRunning" @click="runAudit">
                {{ audit ? 'Check Again' : 'Check Files' }}
              </button>
            </div>
          </div>
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        eyebrow="Activity"
        title="Recent activity"
        description="A quick look at what has been created. Credit balances and billing are on the Usage page."
      >
        <div class="pulse-grid">
          <div class="pulse-stat">
            <span>This session</span>
            <strong>{{ overview ? currentSessionOutputs : '—' }}</strong>
            <small>items created</small>
          </div>
          <div class="pulse-stat">
            <span>All sessions</span>
            <strong>{{ overview ? (overview.session?.all_time?.total_sessions || 0) : '—' }}</strong>
            <small>times you worked on this</small>
          </div>
          <div class="pulse-stat">
            <span>All outputs</span>
            <strong>{{ overview ? (overview.session?.all_time?.total_assets || 0) : '—' }}</strong>
            <small>created in total</small>
          </div>
          <div class="pulse-stat">
            <span>Accepted episodes</span>
            <strong>{{ episodesKnown ? episodeCount : '—' }}</strong>
            <small>in this project</small>
          </div>
        </div>
        <div class="pulse-note">
          <span>{{ overview ? currentSessionSummary : 'Activity could not be loaded.' }}</span>
          <NuxtLink to="/usage">View usage</NuxtLink>
        </div>
      </WorkspaceSection>
    </div>

    <MissingAssetsDialog
      v-if="audit"
      :visible="showDialog"
      :busy="auditRunning"
      :slug="slug"
      :report="audit"
      @close="showDialog = false"
      @rescan="runAudit"
    />
  </div>
</template>

<script setup lang="ts">
import type { ProjectAudit } from '~/types/audit'
import type { EpisodeRow } from '~/composables/useEpisodes'
import {
  EPISODE_STAGES,
  STEP_STATUS_FIELD,
  episodeStage,
  isEpisodeDone,
  isFlowStepApplicable,
  normalizeEpisodeVisualSource,
  visualSourceFromFormat,
  requiredStatusFields,
  unionFlowForEpisodeSources,
  type EpisodeStage,
  type EpisodeVisualSource,
  type FlowStep,
  type VisualSource,
} from '~/composables/useProjectFlow'
import { useProjectCost, formatTotal } from '~/composables/useProjectCost'

definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })
useAppTitle('Dashboard')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { project } = useProject()

// v1.4.2 — the reachability fact the backend already computed, surfaced. Only an
// explicit `false` counts: an older backend, or a response that predates the
// field, must read as "unknown" and stay silent rather than accusing a healthy
// project of having lost its folder.
//
// Kept deliberately through the removal of the choosable episodes folder.
// Taking away the ability to point a channel somewhere wrong does not make the
// folder certain to be there — a folder moved or renamed in
// Finder, or on an unplugged drive, still goes missing — and the whole point of the Origin Field fix was
// that the app says so instead of rendering an empty channel.
const outputRootMissing = computed(() => project.value?.output_root_exists === false)
// The resolved ABSOLUTE path. The `|| project.output_root` fallback that used
// to sit here read the stored relative './episodes' and would have shown the
// person a path that is not a location.
const outputRootPath = computed(() => project.value?.output_root_resolved || '')
const { get } = useApi()
const { jobs, stats: jobStats, jobsStale, isLoading: jobsLoading } = useJobs()
const {
  episodes,
  isLoading: episodesLoading,
  isRevalidating: episodesRefreshing,
  error: episodesError,
  refresh: refreshEpisodes,
  revalidate: revalidateEpisodes,
} = useEpisodes(slug)
const { channelTotal, load: loadCost } = useProjectCost(slug)
const channelCostDetail = computed(() => {
  const t = channelTotal.value
  if (!t) return 'No cost records yet'
  if (t.total_usd?.state === 'unmeasurable') return 'No Gateway charges or runtime recorded'
  const parts: string[] = []
  if (t.paid.state === 'measured') {
    const usd = t.paid.usd ?? 0
    const cr = t.paid.credits ?? 0
    if (usd > 0) parts.push(`$${usd.toFixed(2)} paid`)
    if (cr > 0) parts.push(`${cr} credits`)
  }
  if (t.local.state === 'measured') {
    parts.push(`${formatMinutes(t.local.mac_minutes ?? 0)} local`)
  }
  if (t.waste.state === 'measured') {
    parts.push(`${t.waste.percent ?? 0}% waste`)
  }
  return parts.join(' · ') || 'Explicit $0'
})
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
const visualSource = ref<VisualSource | null>(null)

// v1.4.82 — this page kept a private copy of the step → status-field map, and
// that copy had drifted: it was missing Research and Introduction entirely, so
// both stages read as zero-progress here while the Board counted them. The map
// now lives once, in useProjectFlow, beside the flow it describes.
const STATUS_FIELD = STEP_STATUS_FIELD as Record<string, keyof EpisodeRow['status']>

function episodeVisualSource(ep: EpisodeRow): EpisodeVisualSource {
  return normalizeEpisodeVisualSource((ep.status as Record<string, unknown>)?.visual_source)
}

const steps = computed(() => visualSource.value
  ? unionFlowForEpisodeSources(visualSource.value, episodes.value.map(episodeVisualSource))
  : [])
const episodeCount = computed(() => episodes.value.length)
// "No episodes" is only a fact once the episode read actually succeeded
// (AGENTS §6): a failed read, a missing folder or a first load all look like an
// empty list, and none of them may read as "nothing to do".
const episodesKnown = computed(() => !episodesError.value && !outputRootMissing.value && !initialLoading.value)
const statusKnown = computed(() => episodesKnown.value && !!visualSource.value)
const statusPending = computed(() => initialLoading.value || (overviewLoading.value && !visualSource.value))
const noAcceptedIdeas = computed(() => overview.value?.ideas?.accepted === 0 && episodeCount.value === 0 && episodesKnown.value)

function routeForStep(step: FlowStep): string {
  const base = `/projects/${slug.value}${step.path}`
  return step.tab ? `${base}?tab=${step.tab}` : base
}

function statusDone(ep: EpisodeRow, field: keyof EpisodeRow['status']): boolean {
  return ep.status?.[field] === true
}

// Only steps the episode status actually reports on get a card. Ideas, Contextual
// Cues and Sound Design have no status field, so a card for them could only
// invent a number; Ideas has its own metric above.
const coverageStages = computed(() => steps.value.filter(step => STATUS_FIELD[step.key]).map((step, index) => {
  const field = STATUS_FIELD[step.key]
  const eligible = episodes.value.filter(ep => isFlowStepApplicable(step, episodeVisualSource(ep)))
  const done = eligible.filter(ep => statusDone(ep, field)).length
  const pct = eligible.length ? Math.round((done / eligible.length) * 100) : 0
  return {
    ...step,
    order: String(index + 1).padStart(2, '0'),
    done,
    eligible: eligible.length,
    missing: Math.max(0, eligible.length - done),
    pct,
    field,
    to: routeForStep(step),
  }
}))

// v1.4.82 — the same done-test the Production Board and the episode selector's
// Steps chip use, so the three surfaces cannot disagree about one episode.
function isComplete(ep: EpisodeRow): boolean {
  return !!visualSource.value && isEpisodeDone(ep?.status as Record<string, unknown>, visualSource.value)
}

const readyCount = computed(() => episodes.value.filter(isComplete).length)
const needsWorkCount = computed(() => Math.max(0, episodeCount.value - readyCount.value))
const finalVideoCount = computed(() => episodes.value.filter(ep => statusDone(ep, 'video_assembly')).length)
// The renderer refuses an episode whose switched-on Contextual Cues or Sound
// Design are not ready (`false` only when the feature is on and unfinished), so
// such an episode is not ready for the final video even though every step
// below is done.
const readyToRenderCount = computed(() => episodes.value.filter(ep =>
  visualSource.value
    && ep.status?.contextual_cues !== false
    && ep.status?.sound_design !== false
    && !statusDone(ep, 'video_assembly')
    && requiredStatusFields(visualSource.value, episodeVisualSource(ep))
      .filter(field => field !== 'video_assembly')
      .every(field => statusDone(ep, field)),
).length)
const activeJobCount = computed(() => jobStats.value.running + jobStats.value.queued)
// R7 — the same derived state the Production Board shows on each row.
const stageCounts = computed(() => {
  const active = new Set((jobs.value || [])
    .filter(job => (job.status === 'queued' || job.status === 'running') && job.project_slug === slug.value && job.episode_id)
    .map(job => job.episode_id))
  const counts = new Map<EpisodeStage, number>()
  if (visualSource.value) {
    for (const ep of episodes.value) {
      const stage = episodeStage(ep as any, visualSource.value, active.has(ep.episode_code))
      counts.set(stage, (counts.get(stage) || 0) + 1)
    }
  }
  return EPISODE_STAGES.map(stage => ({ ...stage, count: counts.get(stage.key) || 0 }))
})

type FocusTone = 'warning' | 'accent' | 'success' | 'neutral'
interface FocusAction { key: string; order: string; title: string; detail: string; to: string; tone: FocusTone }

const focusActions = computed<FocusAction[]>(() => {
  const actions: FocusAction[] = []
  if (noAcceptedIdeas.value) {
    actions.push({
      key: 'start-ideas', order: '01', tone: 'accent',
      title: 'Start with ideas',
      detail: 'Generate and accept an idea to begin this channel’s production workflow.',
      to: `/projects/${slug.value}/ideas`,
    })
  }
  if (jobStats.value.error > 0) {
    actions.push({
      key: 'failed-jobs', order: String(actions.length + 1).padStart(2, '0'), tone: 'warning',
      title: `Repair ${jobStats.value.error} failed job${jobStats.value.error === 1 ? '' : 's'}`,
      detail: 'Open the queue to see exactly what is missing and retry safely.',
      to: `/projects/${slug.value}/jobs?status=error`,
    })
  }
  if (readyToRenderCount.value > 0) {
    actions.push({
      key: 'ready-render', order: String(actions.length + 1).padStart(2, '0'), tone: 'accent',
      title: `Make the final video for ${readyToRenderCount.value} ready episode${readyToRenderCount.value === 1 ? '' : 's'}`,
      detail: 'Every earlier required step is done; the final video is the only step left.',
      to: `/projects/${slug.value}/video-assembly`,
    })
  }
  const firstPending = coverageStages.value.find(stage => !stage.optional && stage.key !== 'video-assembly' && stage.missing > 0)
  if (firstPending) {
    actions.push({
      key: `pending-${firstPending.key}`, order: String(actions.length + 1).padStart(2, '0'), tone: 'neutral',
      title: `Continue ${firstPending.label}`,
      detail: `${firstPending.missing} episode${firstPending.missing === 1 ? '' : 's'} still need this required step.`,
      to: firstPending.to,
    })
  }
  if (finalVideoCount.value > 0 && uploadAccountCount.value === 0) {
    actions.push({
      key: 'publishing-setup', order: String(actions.length + 1).padStart(2, '0'), tone: 'warning',
      title: 'Connect a YouTube account',
      detail: 'Final videos exist, but this project has no YouTube account connected.',
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
  return parts.length ? `This session: ${parts.join(' · ')}` : 'Nothing has been created in this session yet.'
})

const audit = ref<ProjectAudit | null>(null)
const auditRunning = ref(false)
const auditError = ref('')
const showDialog = ref(false)
const auditCheckedAt = ref<number | null>(null)
const auditCache = useState<Record<string, { result: ProjectAudit; ts: number }>>('dashboard-audit-cache', () => ({}))
const AUDIT_TTL_MS = 30 * 60 * 1000
const hasUnmeasurableAudit = computed(() => audit.value?.episodes.some(episode =>
  episode.stages.some(stage => stage.outcome === 'unmeasurable'),
) || false)
const hasAuditDetails = computed(() => !!audit.value && (audit.value.total_missing > 0 || hasUnmeasurableAudit.value))

function hydrateAudit() {
  const cached = auditCache.value[slug.value]
  if (cached && Date.now() - cached.ts < AUDIT_TTL_MS) {
    audit.value = cached.result
    auditCheckedAt.value = cached.ts
  } else {
    audit.value = null
    auditCheckedAt.value = null
  }
}

// A cached result can be up to 30 minutes old, so say how old it is.
const auditAgeLabel = computed(() => {
  if (auditCheckedAt.value === null) return ''
  const minutes = Math.floor((Date.now() - auditCheckedAt.value) / 60000)
  if (minutes < 1) return 'Checked just now.'
  return `Checked ${minutes} min ago.`
})

async function runAudit() {
  if (auditRunning.value) return
  // Capture the project before awaiting: the route can move on while the check
  // runs, and project A's result must never be written under project B.
  const requestSlug = slug.value
  auditRunning.value = true
  auditError.value = ''
  try {
    const result = await get<ProjectAudit>(`/projects/${requestSlug}/assets-audit-detail`)
    const ts = Date.now()
    auditCache.value[requestSlug] = { result, ts }
    if (slug.value === requestSlug) {
      audit.value = result
      auditCheckedAt.value = ts
    }
  } catch (error: any) {
    if (slug.value === requestSlug) auditError.value = error?.data?.detail || error?.message || 'File check failed'
  } finally {
    auditRunning.value = false
    if (slug.value === requestSlug) reportReadiness()
  }
}

let visualSourceSlug = ''

async function loadOverview() {
  // Capture the project before any await (AGENTS §4): every write below is
  // dropped if the route has moved to another project in the meantime.
  const requestSlug = slug.value
  const current = () => slug.value === requestSlug
  overviewLoading.value = true
  // Keep the last known format while refreshing so the numbers and the workflow
  // grid do not vanish on every refresh; blank it only on a project change.
  if (visualSourceSlug !== requestSlug) visualSource.value = null
  formatError.value = ''
  await Promise.all([
    (async () => {
      try {
        const result = await get<DashboardOverview>(`/projects/${requestSlug}/dashboard-stats`)
        if (!current()) return
        overview.value = result
        overviewError.value = ''
      } catch (error: any) {
        if (!error?.__slugRace && current()) overviewError.value = error?.data?.detail || error?.message || 'Dashboard overview failed'
      }
    })(),
    (async () => {
      try {
        const response = await get<{ accounts?: { youtube?: unknown } }>(`/projects/${requestSlug}/upload/accounts`)
        if (!current()) return
        // The copy on this row is about YouTube, so count YouTube accounts only
        // (the response also lists TikTok and Facebook). A missing list is
        // "could not tell", never zero.
        const youtube = response?.accounts?.youtube
        uploadAccountCount.value = Array.isArray(youtube) ? youtube.length : null
        accountsError.value = ''
      } catch (error: any) {
        if (error?.__slugRace || !current()) return
        uploadAccountCount.value = null
        accountsError.value = error?.data?.detail || error?.message || 'Publishing connection check failed'
      }
    })(),
    (async () => {
      try {
        const format = await get<{ visualSource?: unknown; musicChannel?: unknown }>(`/projects/${requestSlug}/effective-format`)
        if (!current()) return
        const source = visualSourceFromFormat(format)
        if (!source) {
          visualSource.value = null
          formatError.value = 'The project returned an unknown production format. Refresh this project before using dashboard workflow actions.'
          return
        }
        visualSource.value = source
        visualSourceSlug = requestSlug
      } catch (error: any) {
        if (!error?.__slugRace && current()) formatError.value = error?.data?.detail || error?.message || 'Project workflow check failed'
      }
    })(),
  ])
  if (!current()) return
  overviewLoading.value = false
  reportReadiness()
}

const refreshing = computed(() => episodesRefreshing.value || overviewLoading.value)
const initialLoading = computed(() => (episodesLoading.value || overviewLoading.value) && !episodes.value.length)
const loadError = computed(() => {
  const episodeMessage = episodesError.value instanceof Error ? episodesError.value.message : episodesError.value ? String(episodesError.value) : ''
  return [episodeMessage, overviewError.value, accountsError.value, formatError.value, auditError.value].filter(Boolean).join(' ')
})

// Plain click: the paced re-read. Shift-click: the explicit, slow path that
// re-reads every episode from disk.
async function refreshAll(event?: MouseEvent) {
  const requestSlug = slug.value
  await Promise.all([event?.shiftKey ? refreshEpisodes() : revalidateEpisodes(), loadOverview()])
  if (slug.value === requestSlug) reportReadiness()
}

// Retry after a failed load uses the light re-read (no full project recompute).
async function retryLoad() {
  const requestSlug = slug.value
  await Promise.all([revalidateEpisodes(), loadOverview()])
  if (slug.value === requestSlug) reportReadiness()
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
      onClick: retryLoad,
      actionLabel: 'Retry',
    })
  } else {
    notif.clear(projectSlug, 'dashboard-load-error')
  }
  if (audit.value && hasUnmeasurableAudit.value) {
    notif.report(projectSlug, {
      key: 'assets',
      severity: 'warning',
      title: audit.value.total_missing
        ? `${audit.value.total_missing} missing file${audit.value.total_missing === 1 ? '' : 's'}; some checks incomplete`
        : 'Some file checks could not be completed',
      detail: 'Check that project storage is connected and readable, then check again.',
      onClick: runAudit,
      actionLabel: 'Check files again',
    })
  } else if (audit.value && audit.value.total_missing > 0) {
    notif.report(projectSlug, {
      key: 'assets',
      severity: 'warning',
      title: `${audit.value.total_missing} missing file${audit.value.total_missing === 1 ? '' : 's'}`,
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
  void loadCost()
})
onBeforeUnmount(() => {
  const projectSlug = slug.value
  if (projectSlug) notif.clear(projectSlug, 'dashboard-load-error')
})
</script>

<style scoped>
.dashboard-updating { align-self: center; font-size: 12px; color: var(--text-muted); }

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
.dashboard-stages {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 0 0 16px;
  font-size: var(--font-sm, 13px);
}
.dashboard-stage { color: var(--text-secondary, inherit); text-decoration: none; }
.dashboard-stage strong { color: var(--text-primary, inherit); }
.dashboard-stage[data-stage="waiting_for_you"] strong { color: var(--warning, #b7791f); }
</style>
