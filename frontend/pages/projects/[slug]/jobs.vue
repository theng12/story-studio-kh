<template>
  <div>
    <!-- Header -->
    <div class="jobs-header">
      <h1>Job Queue</h1>
      <div class="header-actions">
        <span class="badge badge-running">{{ stats.running }} running</span>
        <span class="badge badge-queued">{{ stats.queued }} queued</span>
        <span class="badge badge-done">{{ stats.done }} done</span>
        <span v-if="stats.error" class="badge badge-error">{{ stats.error }} errors</span>
        <NuxtLink
          :to="`/projects/${slug}/board?repair=1`"
          class="btn btn-sm btn-secondary"
          title="After a bulk pipeline run, open Repair (on the Production Board) to one-click recover any provider-completed output that didn't persist locally (no credits consumed)."
        >
          🗂 Repair assets
        </NuxtLink>
        <button
          v-if="finishedCount > 0"
          class="btn btn-sm btn-ghost"
          @click="clearFinished"
        >
          Clear finished ({{ finishedCount }})
        </button>
      </div>
    </div>

    <!-- v1.0.190 — paused-queue banner. The queue only pauses when the local
         job engine is unreachable; without this, a parked "Queued" job looks
         broken with no explanation. Offers a one-click Resume + re-probe. -->
    <div v-if="queuePaused" class="queue-paused-banner">
      <span class="qpb-icon" aria-hidden="true">⏸</span>
      <span class="qpb-text">
        <strong>Job queue is paused — new jobs are waiting.</strong>
        This happens when the app engine isn't reachable. {{ stats.queued }}
        job{{ stats.queued === 1 ? '' : 's' }} queued. If you're connected,
        click Resume to start them.
      </span>
      <button class="btn btn-xs btn-primary" :disabled="resumingQueue" @click="resumeQueue">
        {{ resumingQueue ? 'Resuming…' : 'Resume now' }}
      </button>
    </div>

    <!-- Restart-recovery banner: surfaces when one or more jobs got
         marked as "Interrupted by app restart" (job-queue.ts boots running
         jobs into 'error' state with that exact message). v1.0.114 — this
         banner now calls Repair (download already-completed provider work)
         only, never Retry. After the bulk Repair finishes the user can
         dismiss individual jobs or click Retry on any whose chunks are
         still missing. The previous "Repair & Retry all" path could
         duplicate-submit when Repair failed mid-flight. -->
    <div
      v-if="!restartBannerDismissed && interruptedJobs.length > 0"
      class="restart-recovery-banner"
    >
      <span class="rrb-icon" aria-hidden="true">↻</span>
      <span class="rrb-text">
        <strong>{{ interruptedJobs.length }} job{{ interruptedJobs.length === 1 ? '' : 's' }} interrupted by app restart.</strong>
        Tasks already submitted to the provider may be recoverable for free —
        Repair polls them and downloads completed results. After it finishes,
        click Retry on any job whose chunks are still missing.
      </span>
      <button
        class="btn btn-xs btn-primary"
        :disabled="repairingAllInterrupted"
        @click="repairAllInterrupted"
      >
        {{ repairingAllInterrupted ? 'Repairing…' : `Repair all (${interruptedJobsRepairable.length})` }}
      </button>
      <button
        class="rrb-dismiss"
        title="Dismiss for this session"
        aria-label="Dismiss restart-recovery banner"
        @click="restartBannerDismissed = true"
      >✕</button>
    </div>

    <!-- Post-bulk summary banner: surfaces once a bulk pipeline run settles.
         Dismissal is session-only — reloading re-derives the summary from
         `jobs.json` via pipeline_batch_id, so the operator sees it again
         on every return visit until the batch drops out of history. -->
    <div
      v-if="showBulkFinishedBanner && batchSummary"
      class="bulk-finished-banner"
      :class="{ 'has-failures': batchSummary.failed > 0 }"
    >
      <div class="bbf-header">
        <span class="bbf-icon" aria-hidden="true">{{ batchSummary.failed > 0 ? '⚠️' : '✅' }}</span>
        <span class="bbf-headline">
          <strong>Pipeline finished</strong>
          ({{ batchSummary.success }}/{{ batchSummary.total }} episodes,
           {{ formatElapsed(batchSummary.elapsed_ms) }})
          <span v-if="batchSummary.cancelled > 0" class="bbf-cancelled">
            · {{ batchSummary.cancelled }} cancelled
          </span>
        </span>
        <button
          class="bbf-dismiss"
          title="Dismiss for this session — will reappear on reload"
          @click="bulkBannerDismissed = true"
        >✕</button>
      </div>

      <!-- Failure summary: top grouped reasons.
           Grouping logic lives in composables/useBatchSummary.ts — the
           normalizer folds "fal.ai TTS status: 429 {body}" across N
           episodes into one row with count N. -->
      <div v-if="batchSummary.failed > 0" class="bbf-failures">
        <div class="bbf-failures-title">
          <strong>{{ batchSummary.failed }} episode{{ batchSummary.failed === 1 ? '' : 's' }} failed</strong>
          <span class="text-muted">— top reasons:</span>
        </div>
        <ul class="bbf-reason-list">
          <li v-for="r in batchSummary.failure_reasons" :key="r.reason">
            <span class="bbf-count">×{{ r.count }}</span>
            <span class="bbf-reason-text">{{ r.reason }}</span>
          </li>
        </ul>
      </div>

      <!-- Per-episode failure details — expand on demand.
           Shows the exact job.error (untruncated, unredacted beyond the
           aggregator's scrub of bearer tokens / UUIDs) so the operator
           has everything they need to decide retry vs. rerun vs. skip. -->
      <details v-if="batchSummary.failed_episodes.length" class="bbf-details">
        <summary>Show all failed episodes ({{ batchSummary.failed_episodes.length }})</summary>
        <div
          v-for="fe in batchSummary.failed_episodes"
          :key="fe.episode_id"
          class="bbf-failed-episode"
        >
          <div class="bbf-failed-episode-head">
            <strong>{{ fe.episode_id }}</strong>
            <span class="text-muted">— failed at step <code>{{ fe.job_type }}</code></span>
          </div>
          <pre class="bbf-failed-episode-error">{{ fe.full_error }}</pre>
        </div>
      </details>

      <!-- Actions row. Two buttons = two different things, spell that out:
           — "Review failures" filters the History list below to the failed
             jobs for retry decisions (operator needs the full error body
             and the retry button each job card already has).
           — "Repair" opens the Production Board's Repair dialog where
             provider-completed outputs that didn't persist locally can
             be re-fetched in one click (no credits consumed). -->
      <div class="bbf-actions">
        <button
          v-if="batchSummary.failed > 0"
          class="btn btn-sm btn-secondary"
          title="Filter the History list below to failed jobs — use this when you need to pick a retry strategy per-episode (the full error body is on each card)."
          @click="reviewFailures"
        >Review failures →</button>
        <NuxtLink
          :to="`/projects/${slug}/board?repair=1`"
          class="btn btn-sm btn-primary"
          title="Open Repair (on the Production Board) — lists provider-completed outputs that didn't land on disk (e.g. network drop after upload). One-click repair does NOT consume credits; it only re-downloads what the provider already produced."
          @click="bulkBannerDismissed = true"
        >Repair →</NuxtLink>
      </div>

      <!-- Inline explainer: what does "needs repair" actually mean and
           when do you click which button. Operator-first — no docs tab. -->
      <div class="bbf-explainer">
        <strong>What "needs repair" means:</strong>
        A provider finished the generation (so you were billed) but the bytes
        didn't land on disk (network drop, kill mid-download, etc.).
        <b>Repair</b> re-fetches those files with no extra credits.
        <b>Review failures</b> is for jobs that truly errored — the provider
        never produced a usable result, so retrying will spend credits again.
      </div>
    </div>

    <!-- Filter Tabs -->
    <div class="filter-tabs">
      <button
        v-for="tab in filterTabs"
        :key="tab.type"
        class="filter-tab"
        :class="{ active: activeFilter === tab.type }"
        @click="activeFilter = tab.type; currentPage = 1"
      >
        {{ tab.label }}
        <span v-if="tab.count > 0" class="tab-count">{{ tab.count }}</span>
      </button>
    </div>

    <!-- Sort Bar -->
    <div class="sort-bar">
      <span class="text-muted sort-label">Sort by:</span>
      <button
        v-for="col in sortColumns"
        :key="col.key"
        class="sort-btn"
        :class="{ active: sortKey === col.key }"
        @click="toggleSort(col.key)"
      >
        {{ col.label }}
        <span v-if="sortKey === col.key" class="sort-arrow">{{ sortDir === 'asc' ? '&#9650;' : '&#9660;' }}</span>
      </button>
    </div>

    <!-- Empty State -->
    <EmptyState
      v-if="activeJobs.length === 0 && historyJobs.length === 0"
      class="mt-2"
      icon="⚙️"
      :title="emptyTitle"
      :message="emptyMessage"
    />

    <!-- Active (running + queued) — always on top, not paginated -->
    <section v-if="activeJobs.length" class="jobs-section mt-2">
      <div class="section-heading">
        <h2>Active</h2>
        <span class="section-count">{{ activeJobs.length }}</span>
        <span v-if="stats.running > 0" class="live-indicator-inline">
          <LoadingSpinner size="sm" />
          <span>auto-refreshing</span>
        </span>
      </div>
      <div class="jobs-list mt-1">
        <div
          v-for="job in activeJobs"
          :key="job.job_id"
          class="job-card card"
          :class="'status-' + job.status"
        >
        <!-- Row 1: Status + Type + Episode + Actions -->
        <div class="job-row-main">
          <div class="flex items-center gap-2">
            <StatusBadge :status="job.status" />
            <span class="job-type">{{ jobDisplayLabel(job) }}</span>
            <span class="job-episode">{{ job.episode_id }}</span>
            <span v-if="job.title" class="text-muted">- {{ job.title }}</span>
          </div>
          <div class="flex items-center gap-1">
            <button
              v-if="job.status === 'queued' || job.status === 'running'"
              class="btn btn-xs btn-danger"
              @click="cancelJob(job)"
              :title="job.status === 'running' ? 'Stops local polling. In-flight provider tasks may still complete and bill — use the Repair button afterward to recover them for free.' : 'Removes from queue before any submit happens. No charge.'"
            >
              {{ job.status === 'running' ? 'Stop' : 'Cancel' }}
            </button>
            <!-- v1.0.114 — Repair / Retry split. Repair (left) is the safe
                 default: polls the provider for already-completed tasks
                 and downloads them. Never re-submits. Retry (right) is
                 the explicit "re-run, charge me again" action. The old
                 combined button caused duplicate provider tasks when
                 users clicked it repeatedly to "make it work". -->
            <button
              v-if="(job.status === 'error' || job.status === 'cancelled') && jobCanBeRepaired(job.type)"
              class="btn btn-xs btn-primary"
              @click="repairJobOnly(job)"
              title="SAFE — Polls the provider for tasks that were submitted but never finished downloading, and pulls them in for free. Never re-submits anything. Click this FIRST when a job timed out — the provider often finished the work on its side. If chunks are still missing afterwards, then click Retry."
            >
              Repair
            </button>
            <button
              v-if="job.status === 'error' || job.status === 'cancelled'"
              class="btn btn-xs btn-secondary"
              @click="retryJob(job)"
              :title="retryTooltip(job)"
            >
              Retry
            </button>
            <button
              v-if="['done', 'error', 'cancelled'].includes(job.status)"
              class="btn-icon"
              @click="removeJob(job.job_id)"
              title="Dismiss"
            >
              &#10005;
            </button>
          </div>
        </div>

        <!-- Row 2: Meta (model, duration, timestamps) -->
        <div class="job-meta">
          <span v-if="job.params?.model" class="meta-tag">
            <span class="meta-label">Model:</span> {{ job.params.model }}
          </span>
          <span class="meta-tag">
            <span class="meta-label">Duration:</span> {{ formatJobDuration(job) }}
          </span>
          <span class="meta-tag">
            <span class="meta-label">Created:</span> {{ formatTime(job.created_at) }}
          </span>
          <span v-if="job.started_at" class="meta-tag">
            <span class="meta-label">Started:</span> {{ formatTime(job.started_at) }}
          </span>
          <span v-if="job.finished_at" class="meta-tag">
            <span class="meta-label">Finished:</span> {{ formatTime(job.finished_at) }}
          </span>
          <span class="meta-tag">
            <span class="meta-label">ID:</span> {{ job.job_id }}
          </span>
        </div>

        <!-- Row 2.5: Account attribution.
             Populated live by the resolver in providers/registry.ts
             whenever ctx.jobId is set. Hidden on jobs that never called a
             provider (local-only jobs) and on older jobs queued before the
             attribution schema shipped. -->
        <div v-if="hasAccountsUsed(job)" class="job-accounts">
          <span class="meta-label">Accounts:</span>
          <span
            v-for="(acc, pid) in job.accounts_used"
            :key="pid"
            class="account-chip"
            :title="`Provider: ${pid} · Account id: ${acc.id}`"
          >
            {{ providerDisplay(pid) }}: <strong>{{ acc.label }}</strong>
          </span>
        </div>

        <!-- Row 3: Running progress / Summary -->
        <div v-if="job.status === 'running' && job.output_lines?.length" class="job-live-output">
          <div class="progress-row">
            <div class="progress-bar"><div class="progress-fill" /></div>
            <span v-if="progressCounter(job)" class="progress-counter">{{ progressCounter(job) }}</span>
          </div>
          <div class="output-scroll" ref="outputScrollRefs">
            <code v-for="(line, i) in job.output_lines" :key="i">{{ line }}</code>
          </div>
        </div>

        <!-- Running but no output lines yet — placeholder so the card doesn't
             look inert. Running generators take a moment to produce their
             first log line; the progress bar + "Starting…" confirms the job
             is alive and the UI is listening. Disappears on the first line. -->
        <div v-else-if="job.status === 'running'" class="job-live-output">
          <div class="progress-row">
            <div class="progress-bar"><div class="progress-fill" /></div>
          </div>
          <div class="output-scroll output-starting">
            <code class="starting-placeholder">
              <LoadingSpinner size="sm" />
              Starting — waiting for first log line…
            </code>
          </div>
        </div>

        <div v-else-if="job.status === 'done' && job.output_lines?.length" class="job-summary">
          <span class="summary-icon">&#10003;</span>
          <span>{{ getSummaryLine(job) }}</span>
          <button
            v-if="getOutputDir(job)"
            class="btn btn-xs btn-secondary job-open-folder-btn"
            @click="openOutputFolder(job)"
            :title="`Reveal in Finder: ${getOutputDir(job)}`"
          >
            Open in Finder
          </button>
        </div>

        <!-- Expandable output for non-running jobs -->
        <div
          v-if="job.status !== 'running' && job.output_lines?.length"
          class="job-expand"
          @click="toggleExpand(job.job_id)"
        >
          {{ expanded === job.job_id ? 'Hide output' : 'Show output' }}
          ({{ job.output_lines.length }} lines)
        </div>

        <div v-if="expanded === job.job_id && job.status !== 'running' && job.output_lines?.length" class="job-output">
          <code v-for="(line, i) in job.output_lines" :key="i">{{ line }}</code>
        </div>

        <!-- Error details -->
        <div v-if="job.status === 'error'" class="job-error-section">
          <div v-if="job.error" class="error-summary">
            <span class="error-label">Error:</span>
            <span class="error-summary-text">{{ firstErrorLine(job.error) }}</span>
          </div>
          <div
            v-if="job.error && hasMoreErrorLines(job.error)"
            class="error-toggle"
            @click="errorExpanded === job.job_id ? errorExpanded = null : errorExpanded = job.job_id"
          >
            {{ errorExpanded === job.job_id ? 'Hide full error' : 'Show full error' }}
          </div>
          <div v-if="errorExpanded === job.job_id && job.error" class="error-details">
            {{ job.error }}
          </div>
        </div>
      </div>
      </div>
    </section>

    <!-- History (done / error / cancelled) — paginated -->
    <section v-if="historyJobs.length" class="jobs-section mt-3">
      <div class="section-heading">
        <h2>History</h2>
        <span class="section-count">{{ historyJobs.length }}</span>
      </div>
      <div class="jobs-list mt-1">
        <div
          v-for="job in paginatedHistory"
          :key="job.job_id"
          class="job-card card"
          :class="'status-' + job.status"
        >
          <div class="job-row-main">
            <div class="flex items-center gap-2">
              <StatusBadge :status="job.status" />
              <span class="job-type">{{ jobDisplayLabel(job) }}</span>
              <span class="job-episode">{{ job.episode_id }}</span>
              <span v-if="job.title" class="text-muted">- {{ job.title }}</span>
            </div>
            <div class="flex items-center gap-1">
              <!-- v1.0.114 — Repair / Retry split (mirror of expanded view above). -->
              <button
                v-if="(job.status === 'error' || job.status === 'cancelled') && jobCanBeRepaired(job.type)"
                class="btn btn-xs btn-primary"
                @click="repairJobOnly(job)"
                title="SAFE — Polls the provider for already-completed tasks and downloads them for free. Never re-submits. Click this FIRST when a job timed out."
              >
                Repair
              </button>
              <button
                v-if="job.status === 'error' || job.status === 'cancelled'"
                class="btn btn-xs btn-secondary"
                @click="retryJob(job)"
                title="CHARGES MAY APPLY — Re-submits a fresh generation. Use when Repair couldn't recover everything OR when the original submit truly failed."
              >
                Retry
              </button>
              <button class="btn-icon" @click="removeJob(job.job_id)" title="Dismiss">&#10005;</button>
            </div>
          </div>

          <div class="job-meta">
            <span v-if="job.params?.model" class="meta-tag">
              <span class="meta-label">Model:</span> {{ job.params.model }}
            </span>
            <span class="meta-tag">
              <span class="meta-label">Duration:</span> {{ formatJobDuration(job) }}
            </span>
            <span class="meta-tag">
              <span class="meta-label">Created:</span> {{ formatTime(job.created_at) }}
            </span>
            <span v-if="job.finished_at" class="meta-tag">
              <span class="meta-label">Finished:</span> {{ formatTime(job.finished_at) }}
            </span>
          </div>

          <div v-if="job.status === 'done' && job.output_lines?.length" class="job-summary">
            <span class="summary-icon">&#10003;</span>
            <span>{{ getSummaryLine(job) }}</span>
            <button
              v-if="getOutputDir(job)"
              class="btn btn-xs btn-secondary job-open-folder-btn"
              @click="openOutputFolder(job)"
              :title="`Reveal in Finder: ${getOutputDir(job)}`"
            >
              Open in Finder
            </button>
          </div>

          <div
            v-if="job.output_lines?.length"
            class="job-expand"
            @click="toggleExpand(job.job_id)"
          >
            {{ expanded === job.job_id ? 'Hide output' : 'Show output' }}
            ({{ job.output_lines.length }} lines)
          </div>

          <div v-if="expanded === job.job_id && job.output_lines?.length" class="job-output">
            <code v-for="(line, i) in job.output_lines" :key="i">{{ line }}</code>
          </div>

          <div v-if="job.status === 'error'" class="job-error-section">
            <div v-if="job.error" class="error-summary">
              <span class="error-label">Error:</span>
              <span class="error-summary-text">{{ firstErrorLine(job.error) }}</span>
            </div>
            <div
              v-if="job.error && hasMoreErrorLines(job.error)"
              class="error-toggle"
              @click="errorExpanded === job.job_id ? errorExpanded = null : errorExpanded = job.job_id"
            >
              {{ errorExpanded === job.job_id ? 'Hide full error' : 'Show full error' }}
            </div>
            <div v-if="errorExpanded === job.job_id && job.error" class="error-details">
              {{ job.error }}
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination (history only) -->
      <div v-if="historyTotalPages > 1" class="pagination">
        <button class="btn btn-xs btn-ghost" :disabled="currentPage <= 1" @click="currentPage--">
          &laquo; Prev
        </button>
        <span class="page-info">Page {{ currentPage }} of {{ historyTotalPages }}</span>
        <button class="btn btn-xs btn-ghost" :disabled="currentPage >= historyTotalPages" @click="currentPage++">
          Next &raquo;
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { DeepReadonly } from 'vue'
import type { Job } from '~/composables/useJobs'
import { PROVIDER_DISPLAY } from '~/composables/useModelGroups'
import { buildLatestBatchSummary, formatElapsed } from '~/composables/useBatchSummary'
type RJob = DeepReadonly<Job>

definePageMeta({ layout: 'dashboard' })
useAppTitle('Jobs')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, del, post } = useApi()
const { jobs, stats } = useJobs()
const { success, error: showError, info } = useToast()

// Account attribution helpers. Populated by the resolver whenever it runs
// under a jobId (see electron/server/providers/registry.ts). Present only
// on jobs that actually called a provider through the resolver.
function hasAccountsUsed(job: RJob): boolean {
  const used = job.accounts_used
  return !!used && Object.keys(used).length > 0
}

function providerDisplay(providerId: string): string {
  return PROVIDER_DISPLAY[providerId] || providerId
}

const expanded = ref<string | null>(null)
const errorExpanded = ref<string | null>(null)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

// v1.0.190 — surface a paused job queue so a stuck "Queued" job is never a
// mystery again. The queue pauses only when the local job engine is
// unreachable; the banner this drives offers a manual Resume + a re-probe.
const net = useNetworkStatus()
const queuePaused = ref(false)
const resumingQueue = ref(false)
let queueTimer: ReturnType<typeof setInterval> | null = null

async function checkQueuePaused(): Promise<void> {
  try {
    const r = await get<{ paused: boolean }>('/system/queue/status')
    queuePaused.value = !!r.paused
  } catch { /* backend unreachable — leave the last-known value */ }
}

async function resumeQueue(): Promise<void> {
  resumingQueue.value = true
  try {
    await post('/system/queue/resume', {})
    await net.refresh()        // re-probe so the indicator + sync state agree
    await checkQueuePaused()
    if (!queuePaused.value) success('Job queue resumed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to resume the queue')
  } finally {
    resumingQueue.value = false
  }
}

onMounted(() => {
  timer = setInterval(() => now.value = Date.now(), 1000)
  void checkQueuePaused()
  queueTimer = setInterval(checkQueuePaused, 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (queueTimer) clearInterval(queueTimer)
})

// Post-bulk banner: show when a pipeline batch has completed (all its
// jobs settled into done/error/cancelled) and there are no more pipeline
// chain jobs running. Dismissed for the session once the user clicks ✕
// or navigates to Assets — dismissal is in-memory only, so a reload
// re-derives the summary from jobs.json and shows it again.
const bulkBannerDismissed = ref(false)

// ── Restart-recovery banner ───────────────────────────────────────────────
// Detects jobs that the boot process marked as "Interrupted by app restart"
// (job-queue.ts:279). Surfaces a session-dismissible info banner with a
// fan-out "Repair & Retry all" button — each click delegates to the
// existing per-job retryJob, which already triggers the auto-recovery
// (manifest task_id polled before any fresh submit, no double-charge).
const restartBannerDismissed = ref(false)
const repairingAllInterrupted = ref(false)
const INTERRUPTED_ERROR_TEXT = 'Interrupted by app restart'
const interruptedJobs = computed(() =>
  jobs.value.filter((j: RJob) => j.status === 'error' && j.error === INTERRUPTED_ERROR_TEXT)
)
// v1.0.114 — Only the repairable subset gets fanned out by the bulk
// "Repair all" button. Non-repairable interrupted jobs (script-only /
// metadata / etc.) stay visible — the user can Retry them individually
// after reviewing whether they want to spend money to re-run.
const interruptedJobsRepairable = computed(() =>
  interruptedJobs.value.filter((j: RJob) => jobCanBeRepaired(j.type))
)
async function repairAllInterrupted() {
  // v1.0.114 — fan out to repairJobOnly instead of retryJob. Same
  // concurrency cap (3) as before. Repairing in parallel is safe because
  // each call only polls the provider + downloads, no charges.
  const snapshot = [...interruptedJobsRepairable.value]
  if (snapshot.length === 0) return
  repairingAllInterrupted.value = true
  try {
    const CONCURRENCY = 3
    let cursor = 0
    async function worker() {
      while (cursor < snapshot.length) {
        const idx = cursor++
        if (idx >= snapshot.length) return
        try {
          await repairJobOnly(snapshot[idx]!)
        } catch (e: any) {
          // repairJobOnly already surfaces toasts on individual failures;
          // catch here so one bad apple doesn't abort the rest of the
          // bulk run.
          console.warn('[bulk-repair] repair failed:', e?.message || e)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, snapshot.length) }, () => worker()),
    )
  } finally {
    repairingAllInterrupted.value = false
  }
}

// The aggregator handles "no batch / still mid-flight" by returning null,
// which the banner treats as "don't render". This keeps the template
// trivial and the aggregation logic pure / unit-testable.
const batchSummary = computed(() => buildLatestBatchSummary(jobs.value as readonly Job[]))
const showBulkFinishedBanner = computed(() => {
  if (bulkBannerDismissed.value) return false
  return batchSummary.value !== null
})

// "Review failures" filters the History tab to `error`-status jobs from
// this batch so the operator can scan each failed job's full error body
// and decide on retry. Uses the existing filter/sort machinery further
// down; we just flip activeFilter to a synthetic "errors" bucket and
// rely on historyJobs already listing everything.
function reviewFailures() {
  activeFilter.value = 'all'
  // Sort by status so errors float to the top of the History list.
  sortKey.value = 'status'
  sortDir.value = 'asc'
  currentPage.value = 1
  // Scroll the user down to the History section so they see the jobs
  // they're about to review without having to hunt.
  nextTick(() => {
    const el = document.querySelector('.jobs-section h2')
    if (el && typeof (el as any).scrollIntoView === 'function') {
      ;(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  })
}

// ── Type labels ─────────────────────────────────────────────────────────

// Display label per job type. Every executor registered in
// `electron/server/boot/executors.ts` should appear here — otherwise the
// Jobs page renders the raw type string (e.g. `video_assembly`) which
// reads as a database key, not a feature name.
const JOB_TYPE_LABELS: Record<string, string> = {
  'script-only': 'Script (chapters)',
  'introduction-only': 'Introduction',
  'chapter-only': 'Chapter regen',
  image_prompts: 'Prompts',
  images: 'Images (All)',
  scene_images: 'Scene Images',
  thumb_images: 'Thumbnail Images',
  images_repair: 'Image Repair',
  video_repair: 'Video Repair',
  audio: 'Audio',
  audio_merge: 'Audio Merge',
  metadata: 'Metadata',
  video: 'AI Video',
  video_assembly: 'Video Assembly',
  subtitles_transcribe: 'Subtitles',
}
function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] || type
}
function jobDisplayLabel(job: Pick<RJob, 'type' | 'params'>): string {
  if (job.type === 'image_prompts' && (job.params as any)?.mode === 'thumbnails') {
    return 'Thumbnail Prompts'
  }
  if (job.type === 'image_prompts' && (job.params as any)?.mode === 'scenes') {
    return 'Scene Prompts'
  }
  return jobTypeLabel(job.type)
}

// ── Filter tabs ─────────────────────────────────────────────────────────

const activeFilter = ref('all')

// Filter tabs at the top of the Jobs page. Order matches the production
// pipeline so a user scanning left-to-right sees the same flow as the
// sidebar nav. Every executor in `electron/server/boot/executors.ts`
// must have a tab here — otherwise jobs of that type are reachable only
// via the "All" tab, which makes long video-assembly runs (and other
// slow jobs) hard to track.
const filterTabs = computed(() => {
  const types = [
    { type: 'all',                  label: 'All' },
    { type: 'script-only',          label: 'Scripts' },
    { type: 'introduction-only',    label: 'Introductions' },
    { type: 'chapter-only',         label: 'Chapter Regen' },
    { type: 'metadata',             label: 'Metadata' },
    { type: 'image_prompts',        label: 'Prompts' },
    { type: 'scene_images',         label: 'Scene Images' },
    { type: 'thumb_images',         label: 'Thumb Images' },
    { type: 'images',               label: 'Images (All)' },
    { type: 'images_repair',        label: 'Image Repair' },
    { type: 'video',                label: 'AI Video' },
    { type: 'video_repair',         label: 'Video Repair' },
    { type: 'audio',                label: 'Audio' },
    { type: 'audio_merge',          label: 'Audio Merge' },
    { type: 'video_assembly',       label: 'Video Assembly' },
    { type: 'subtitles_transcribe', label: 'Subtitles' },
  ]
  return types.map(t => ({
    ...t,
    count: t.type === 'all'
      ? jobs.value.filter(j => j.status === 'running' || j.status === 'queued').length
      : jobs.value.filter(j => j.type === t.type && (j.status === 'running' || j.status === 'queued')).length,
  }))
})

const filterLabel = computed(() => filterTabs.value.find(t => t.type === activeFilter.value)?.label || '')

const emptyTitle = computed(() => activeFilter.value === 'all' ? 'No jobs yet' : `No ${filterLabel.value} jobs`)
const emptyMessage = computed(() => activeFilter.value === 'all'
  ? "Start generating scripts, images, or audio to see background jobs here. This page auto-refreshes every 3 seconds while you're on it."
  : 'Try switching to the All tab to see other jobs.')

// Auto-select tab for most recent active type
watch(jobs, (list) => {
  if (activeFilter.value !== 'all') return // user has manually picked a tab
  const activeJob = list.find(j => j.status === 'running' || j.status === 'queued')
  if (activeJob && activeJob.type !== 'all') {
    // Only auto-switch if there's an active job
    // Don't auto-switch, let user control - just default to 'all'
  }
}, { immediate: true })

// ── Sorting ─────────────────────────────────────────────────────────────

const sortKey = ref('created_at')
const sortDir = ref<'asc' | 'desc'>('desc')

const sortColumns = [
  { key: 'status', label: 'Status' },
  { key: 'type', label: 'Type' },
  { key: 'episode_id', label: 'Episode' },
  { key: 'created_at', label: 'Created' },
  { key: 'duration', label: 'Duration' },
]

function toggleSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = key === 'created_at' ? 'desc' : 'asc'
  }
}

// ── Filtered + Sorted + Paginated ───────────────────────────────────────

const filteredJobs = computed(() => {
  let list = [...jobs.value]
  if (activeFilter.value !== 'all') {
    list = list.filter(j => j.type === activeFilter.value)
  }
  return list
})

const sortedJobs = computed(() => {
  const list = [...filteredJobs.value]
  const dir = sortDir.value === 'asc' ? 1 : -1

  list.sort((a, b) => {
    if (sortKey.value === 'duration') {
      return (getJobDurationMs(a) - getJobDurationMs(b)) * dir
    }
    if (sortKey.value === 'status') {
      const order: Record<string, number> = { running: 0, queued: 1, error: 2, done: 3, cancelled: 4 }
      return ((order[a.status] ?? 5) - (order[b.status] ?? 5)) * dir
    }
    const aVal = (a as any)[sortKey.value] || ''
    const bVal = (b as any)[sortKey.value] || ''
    return aVal < bVal ? -dir : aVal > bVal ? dir : 0
  })

  return list
})

const PAGE_SIZE = 10
const currentPage = ref(1)

const activeJobs = computed(() => {
  const list = sortedJobs.value.filter(j => j.status === 'running' || j.status === 'queued')
  // Pin running ahead of queued regardless of the user's sort-column pick.
  // The chosen sort still governs order WITHIN each group (stable sort
  // preserves sortedJobs's relative order for ties). This keeps the Active
  // section reading top-to-bottom as "what's executing now" → "what's next".
  return list.slice().sort((a, b) => {
    const rank = (s: string) => s === 'running' ? 0 : 1
    return rank(a.status) - rank(b.status)
  })
})
const historyJobs = computed(() =>
  sortedJobs.value.filter(j => j.status !== 'running' && j.status !== 'queued')
)
const historyTotalPages = computed(() =>
  Math.max(1, Math.ceil(historyJobs.value.length / PAGE_SIZE))
)
const paginatedHistory = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return historyJobs.value.slice(start, start + PAGE_SIZE)
})

// Reset page when filter changes
watch(activeFilter, () => { currentPage.value = 1 })

const finishedCount = computed(() =>
  jobs.value.filter(j => ['done', 'error', 'cancelled'].includes(j.status)).length
)

// ── Duration helpers ────────────────────────────────────────────────────

function getJobDurationMs(job: RJob): number {
  if (!job.started_at) return 0
  const start = new Date(job.started_at).getTime()
  const end = job.finished_at ? new Date(job.finished_at).getTime() : now.value
  return end - start
}

function formatJobDuration(job: RJob): string {
  if (!job.started_at) return job.status === 'queued' ? 'Waiting...' : '-'
  const ms = getJobDurationMs(job)
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function firstErrorLine(err: string): string {
  const line = (err || '').split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
  return line.length > 240 ? line.slice(0, 237) + '…' : line
}

/**
 * Pull the most recent "N / Total" or "Chapter 3/13" style marker from a
 * running job's output lines. Looks at the last lines first so the latest
 * step wins. Returns e.g. "3 / 13" or null if no pattern matches.
 */
function progressCounter(job: RJob): string | null {
  const lines = job.output_lines || []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    const m = line.match(/(\d+)\s*\/\s*(\d+)/)
    if (m && parseInt(m[2]!, 10) > 1) return `${m[1]} / ${m[2]}`
  }
  return null
}

function hasMoreErrorLines(err: string): boolean {
  return (err || '').split('\n').filter(l => l.trim()).length > 1
}

// ── Summary line ────────────────────────────────────────────────────────

function getSummaryLine(job: RJob): string {
  const lines = job.output_lines || []
  // Look for the last meaningful summary line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (line.includes('generated successfully') || line.includes('All images') ||
        line.includes('All audio') || line.includes('saved to') ||
        line.includes('Completed') || line.includes('tagged')) {
      return line
    }
  }
  return `Completed in ${formatJobDuration(job)} (${lines.length} steps)`
}

// ── Open in Finder ──────────────────────────────────────────────────────
//
// Reads `job.output_dir` set by each generator. For legacy jobs persisted
// before that field shipped, falls back to a regex over the output_lines
// log — covers the historical messages every generator wrote ("All audio
// saved to: <dir>", "Output: <file>", "Wrote N cues → <file>", etc.).
// The fallback returns the parent dir for file paths so the user lands
// in a folder they can browse, not a single-file selection.
function getOutputDir(job: RJob): string | null {
  const fromField = (job as any).output_dir
  if (typeof fromField === 'string' && fromField) return fromField

  // Fallback for legacy jobs persisted before Apr 2026 when output_dir
  // was added. Walks the output_lines log from newest to oldest, picks
  // the first line containing an absolute filesystem path. Recognises
  // these patterns the various generators historically wrote:
  //   - "All audio saved to: /path/to/dir"          (audio.ts)
  //   - "Output: /path/to/file.mp3"                 (audio-merge.ts)
  //   - "Full path: /path/to/file.mp4"              (video.ts)
  //   - "All clips saved to: /path/to/dir"          (ai-video.ts)
  //   - "All files saved to: /path/to/dir"          (episode.ts)
  //   - "Wrote N cues → /path/to/file.srt"          (subtitles.ts)
  //   - "No task manifest at /path/to/dir."         (video-reconciler.ts)
  //   - "Saved → file1.json + file2.txt"            (metadata.ts — basenames only, no path)
  // The matcher is intentionally permissive: any line containing an
  // absolute path counts. File paths get folded to their parent dir
  // so the user always lands on a browseable folder.
  const lines = job.output_lines || []
  // Filesystem paths often contain spaces (e.g. ".../Story Studio/...") so
  // we can't terminate the path match on the first space. Two-step extract:
  //   1. Anchor on a known summary prefix or just on the first `/`.
  //   2. Take everything to end-of-line, then strip trailing punctuation
  //      that's clearly sentence terminator, not part of the path.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] || ''
    const colonIdx = line.lastIndexOf(': /')
    const arrowIdx = line.indexOf('→ /')
    const atIdx = line.indexOf(' at /')
    let start = -1
    if (colonIdx >= 0) start = colonIdx + 2
    else if (arrowIdx >= 0) start = arrowIdx + 2
    else if (atIdx >= 0) start = atIdx + 4
    else if (line.startsWith('/')) start = 0
    if (start < 0) continue
    let raw = line.slice(start).trim()
    // Terminate at a sentence boundary (".  " etc.) — handles log lines
    // like "No task manifest at /path/to/dir. Run a fresh generation..."
    // where the path is followed by trailing prose on the same line.
    const sentenceEnd = raw.search(/\.\s+\S/)
    if (sentenceEnd > 0) raw = raw.slice(0, sentenceEnd)
    raw = raw.replace(/[.,;)]+$/, '')
    if (!raw.startsWith('/')) continue
    return /\.[a-z0-9]{1,5}$/i.test(raw)
      ? raw.replace(/\/[^/]+$/, '')
      : raw
  }
  return null
}

async function openOutputFolder(job: RJob) {
  const dir = getOutputDir(job)
  if (!dir) { showError('Could not find output folder for this job'); return }
  const { askSkippable } = useConfirmSkip()
  const ok = await askSkippable({
    skipKey: 'reveal_folder',
    title: 'Open in Finder?',
    message: `This will open the output folder in ${platformFileBrowser()}:\n${dir}`,
    confirmLabel: 'Open',
  })
  if (!ok) return
  try {
    await post('/system/reveal-folder', { path: dir })
    success('Opened in Finder')
  } catch (e: any) {
    showError(e?.data?.detail || 'Could not open folder')
  }
}

function platformFileBrowser(): string {
  if (typeof navigator === 'undefined') return 'your file browser'
  const p = navigator.platform || ''
  if (p.startsWith('Mac')) return 'Finder'
  if (p.startsWith('Win')) return 'File Explorer'
  return 'your file manager'
}

// ── Actions ─────────────────────────────────────────────────────────────

function toggleExpand(jobId: string) {
  expanded.value = expanded.value === jobId ? null : jobId
}

// Job types that can have in-flight provider charges at cancel time. A
// queued cancel (worker hasn't picked up yet) never charges; a running
// cancel of a "free" type (local ffmpeg, YouTube upload) doesn't either.
// This set is used to decide whether to surface the Repair hint
// — over-warning on free jobs would teach users to dismiss the toast.
const COST_INCURRING_TYPES = new Set([
  'script-only', 'introduction-only', 'chapter-only',
  'image_prompts', 'metadata',
  'images', 'scene_images', 'thumb_images',
  'audio',
  'video',
  'subtitles_transcribe',
])

async function cancelJob(job: RJob) {
  const wasRunningWithCost = job.status === 'running' && COST_INCURRING_TYPES.has(job.type)
  try {
    await del(`/projects/${slug.value}/jobs/${job.job_id}`)
    if (wasRunningWithCost) {
      // Multi-line toast — local cancel doesn't signal upstream, so
      // already-submitted provider tasks may complete on their side and
      // bill the account. The new Repair & Retry path can pick them up
      // for free if the user wants to come back to it.
      success(
        'Stopped — in-flight tasks may still complete on the provider. ' +
        'Use the Repair button on this job to download them for free.'
      )
    } else {
      success(job.status === 'queued' ? 'Job cancelled (no charge)' : 'Job stopped')
    }
  } catch (e: any) { showError(e.data?.detail || 'Failed to cancel job') }
}

async function removeJob(jobId: string) {
  try {
    await del(`/projects/${slug.value}/jobs/${jobId}`)
    success('Job removed')
  } catch (e: any) { showError(e.data?.detail || 'Failed to remove job') }
}

// v1.0.114 — The endpoints that recover already-completed work from the
// provider WITHOUT submitting any new tasks. Shared by both:
//   • repairJobOnly() — Repair button on the Jobs page (this file)
//   • retryJob() — the legacy combined Repair-then-Retry path
// Sync repair returns the reconciliation result in the POST response;
// queued repair returns a job_id we must poll until terminal before
// considering the repair "done" (otherwise the retry races it).
const REPAIR_ENDPOINTS: Record<string, { url: string; body: any; mode: 'sync' | 'queued' }> = {
  audio: {
    // Provider-aware since v1.0.504 — the route reconciles every chunk from
    // whatever gateway made it (GenAIPro / kie.ai / fal.ai) via the task-manifest
    // sidecar; no provider hint needed.
    url: `/projects/${slug.value}/episodes/__EPISODE__/audio-repair`,
    body: {},
    mode: 'sync',
  },
  images: {
    url: `/projects/${slug.value}/generate/images-repair`,
    body: { episode_id: '__EPISODE__' },
    mode: 'queued',
  },
  scene_images: {
    url: `/projects/${slug.value}/generate/images-repair`,
    body: { episode_id: '__EPISODE__' },
    mode: 'queued',
  },
  thumb_images: {
    url: `/projects/${slug.value}/generate/images-repair`,
    body: { episode_id: '__EPISODE__' },
    mode: 'queued',
  },
  video: {
    url: `/projects/${slug.value}/generate/video-repair`,
    body: { episode_id: '__EPISODE__' },
    mode: 'queued',
  },
}

function jobCanBeRepaired(jobType: string): boolean {
  return jobType in REPAIR_ENDPOINTS
}

// v1.0.308 — type-aware Retry tooltip so the cost/behaviour is honest per job
// type. image_prompts now does a smart gap-fill; image/audio/video have a free
// Repair to click first; everything else re-runs whole.
function retryTooltip(job: Pick<RJob, 'type' | 'params'>): string {
  const jobType = job.type
  if (jobType === 'image_prompts') {
    const mode = (job.params as any)?.mode
    if (mode === 'thumbnails') {
      return 'SMART RETRY — Regenerates ONLY the missing thumbnail prompts and merges them into the existing file, keeping the prompts that already succeeded. Local models: free. Cloud models: charges only for the missing thumbnails, not all prompts.'
    }
    if (mode === 'scenes') {
      return 'SMART RETRY — Regenerates ONLY the missing scene prompts and merges them into the existing file, keeping the prompts that already succeeded. Local models: free. Cloud models: charges only for the missing scenes, not all prompts.'
    }
    return 'SMART RETRY — Regenerates ONLY missing scene/thumbnail prompts and merges them into the existing files, keeping prompts that already succeeded. Local models: free. Cloud models: charges only for the missing prompts.'
  }
  if (jobCanBeRepaired(jobType)) {
    return 'CHARGES MAY APPLY — Deletes this failed job and re-submits a fresh request. Click Repair FIRST (free — recovers in-flight provider work). The generator skips assets already on disk, so after Repair, Retry only re-submits genuinely-missing items.'
  }
  return 'CHARGES MAY APPLY — Deletes this failed job and re-submits it. Re-runs the whole step (this job type has no partial/repair path).'
}

/**
 * v1.0.114 — Repair-only handler for the Jobs page.
 *
 * Polls the provider for any tasks the original job submitted but didn't
 * finish downloading, then pulls those results down for free. NEVER
 * submits new TTS / image / video generation requests. This is the safe
 * action when a job timed out locally but the provider may have finished
 * on its side.
 *
 * Split out of retryJob() because the combined "Repair & Retry" button
 * had a footgun: if the repair phase failed or timed out, the retry
 * phase still fired and resubmitted = duplicate provider charges. Users
 * who clicked it repeatedly to "make it work" stacked up duplicate TTS
 * jobs on GenAIPro (real bug report). Now Repair is a deliberate solo
 * action; Retry is a deliberate solo action; nothing combines them.
 *
 * The original failed job is NOT removed after repair — the user decides
 * (dismiss if everything came back, click Retry if some chunks are still
 * missing).
 */
async function repairJobOnly(job: RJob) {
  const template = REPAIR_ENDPOINTS[job.type]
  if (!template) {
    showError(`This job type doesn't support repair. Use Retry to re-submit instead.`)
    return
  }
  // Substitute the episode_id into both URL and body templates so the
  // shared REPAIR_ENDPOINTS map stays declarative.
  const url = template.url.replace('__EPISODE__', job.episode_id)
  const body = JSON.parse(
    JSON.stringify(template.body).replace(/__EPISODE__/g, job.episode_id)
  )

  info(`Recovering in-flight ${jobTypeLabel(job.type)} tasks for ${job.episode_id} (no charge)…`)
  try {
    const resp = await post<{
      job_id?: string
      recovered?: number
      still_missing?: number
      present_before?: number
      total_expected?: number
    }>(url, body)

    if (template.mode === 'queued' && resp?.job_id) {
      await waitForJobTerminal(resp.job_id, 10 * 60_000)
    }

    // Sync repair returns a useful summary; queued repair returns nothing
    // until we re-fetch the job, so we just say "done" for those.
    const recovered = typeof resp?.recovered === 'number' ? resp.recovered : null
    const missing = typeof resp?.still_missing === 'number' ? resp.still_missing : null
    if (recovered !== null && missing !== null) {
      if (missing === 0 && recovered > 0) {
        success(
          `Recovered ${recovered} task(s) from the provider. ` +
          `Everything is on disk — you can dismiss this failed job now.`
        )
      } else if (missing === 0 && recovered === 0) {
        success(
          `Nothing to recover — all assets were already on disk. ` +
          `The original failure was likely transient; you can dismiss this job.`
        )
      } else if (missing > 0 && recovered > 0) {
        info(
          `Recovered ${recovered} task(s). ${missing} still missing — ` +
          `click Retry to re-submit only the missing chunks.`
        )
      } else {
        info(
          `Provider had nothing completed to recover (${missing} chunks still missing). ` +
          `Click Retry to re-submit them.`
        )
      }
    } else {
      success(`Repair complete for ${jobTypeLabel(job.type)} on ${job.episode_id}.`)
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Repair failed')
  }
}

async function retryJob(job: RJob) {
  // Every job type the queue knows about needs an entry here — otherwise
  // a failed 20-minute video-assembly becomes un-retryable with a cryptic
  // "Cannot retry job type: X" toast. When a new generator is added, this
  // map is the one frontend hook to update.
  const endpointMap: Record<string, { url: string; params: any }> = {
    // M1: legacy 'script' job type was removed. Retry now routes the two
    // independent jobs to their respective endpoints.
    'script-only':       { url: `/projects/${slug.value}/generate/script-only`,       params: job.params },
    'introduction-only': { url: `/projects/${slug.value}/generate/introduction-only`, params: job.params },
    'chapter-only':      { url: `/projects/${slug.value}/generate/chapter-only`,      params: job.params },
    // v1.0.308 — image_prompts Retry is now SMART: it routes to the dedicated
    // /generate/image-prompts route with fill_gaps=true, so the generator
    // regenerates ONLY missing prompt entries for the job's mode and merges
    // them into existing files (preserving the ones that already succeeded). Previously this went
    // through pipeline/run-batch which regenerated all N from scratch.
    image_prompts:   { url: `/projects/${slug.value}/generate/image-prompts`, params: { ...job.params, fill_gaps: true } },
    scene_images:    { url: `/projects/${slug.value}/generate/images`,  params: { ...job.params, mode: 'scenes' } },
    thumb_images:    { url: `/projects/${slug.value}/generate/images`,  params: { ...job.params, mode: 'thumbs' } },
    images:          { url: `/projects/${slug.value}/generate/images`,  params: job.params },
    audio:           { url: `/projects/${slug.value}/generate/audio`,   params: job.params },
    audio_merge:     { url: `/projects/${slug.value}/generate/audio-merge`,    params: job.params },
    video:           { url: `/projects/${slug.value}/generate/video`,         params: job.params },
    video_assembly:  { url: `/projects/${slug.value}/generate/video-assembly`, params: job.params },
    images_repair:   { url: `/projects/${slug.value}/generate/images-repair`,  params: { episode_id: job.episode_id } },
    video_repair:    { url: `/projects/${slug.value}/generate/video-repair`,   params: { episode_id: job.episode_id } },
    // Whisper transcription uses a non-`/generate` URL because the endpoint
    // lives under /video-editor. The episode id is a path param, not a body
    // field. We MUST forward `engine` and `per_chapter` too: without them the
    // backend route defaults engine→'openai' and per_chapter→false, so
    // retrying a Voice Studio per-chapter job silently became an OpenAI
    // merged-audio job — and since the model stayed a Voice Studio Whisper repo
    // (e.g. mlx-community/whisper-tiny), OpenAI rejected it with
    // "400 invalid model ID". Forward force as well so a retry of a "re-run"
    // job still overwrites instead of skipping the existing SRT.
    subtitles_transcribe: {
      url: `/projects/${slug.value}/video-editor/subtitles/transcribe/${job.episode_id}`,
      params: {
        language: job.params?.language,
        model: job.params?.model,
        engine: job.params?.engine,
        per_chapter: job.params?.per_chapter,
        force: job.params?.force,
      },
    },
  }
  // Batch-only types — `metadata` and `image_prompts` are enqueued exclusively
  // via pipeline.ts (no dedicated `/generate/<type>` queue route exists), so
  // a retry has to go back through the same path. We reuse run-batch with
  // force=true so the pipeline's isStepAlreadyDone gate doesn't filter the
  // step out (the user clicked retry because they want it to run again),
  // and run-batch's preset resolution picks up any preset edits the user
  // made between the failure and the retry.
  // metadata stays batch-only (no partial concept — it's one document, and it
  // has no dedicated /generate route on the retry path). image_prompts moved to
  // the endpointMap above so its Retry can pass fill_gaps=true (see v1.0.308).
  const BATCH_ONLY_TYPES = new Set<string>(['metadata'])
  if (BATCH_ONLY_TYPES.has(job.type)) {
    try {
      const resp = await post<{ jobs: Array<{ job_id: string }>; skipped?: Array<{ reason: string }> }>(
        `/projects/${slug.value}/pipeline/run-batch`,
        { episode_ids: [job.episode_id], steps: [job.type], force: true },
      )
      if (!resp?.jobs?.length) {
        const reason = resp?.skipped?.[0]?.reason || 'Pipeline did not enqueue the job'
        showError(reason)
        return
      }
      await del(`/projects/${slug.value}/jobs/${job.job_id}`)
      success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
    } catch (e: any) { showError(e?.data?.detail || 'Failed to retry job') }
    return
  }

  const target = endpointMap[job.type]
  if (!target) { showError(`Cannot retry job type: ${job.type}`); return }

  // v1.0.114 — Retry is now RESUBMIT-ONLY. The previous Repair-then-Retry
  // combined path was split out into repairJobOnly() above, exposed as
  // its own button on the Jobs page. The Generator's per-chunk skip-when-
  // on-disk guards STILL prevent duplicates IF the user clicked Repair
  // first (recommended for audio/images/video) and any in-flight provider
  // results landed on disk before this retry runs. But Retry no longer
  // auto-invokes Repair, because the combined path had a footgun: if
  // Repair failed/timed out, Retry still fired and resubmitted, causing
  // duplicate provider charges on every "retry until it works" click.
  // Now both actions are deliberate solo clicks; nothing combines them.
  try {
    await del(`/projects/${slug.value}/jobs/${job.job_id}`)
    await post(target.url, target.params)
    success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
  } catch (e: any) { showError(e.data?.detail || 'Failed to retry job') }
}

/**
 * Poll a job until it reaches a terminal state (done / error / cancelled),
 * or the timeout fires. Used to gate retry-after-repair on the actual
 * completion of a queued repair job (images-repair / video-repair) since
 * their POST returns immediately after enqueue, not after the work lands.
 *
 * Polls every 2 s — fast enough that a small repair job (5-10 s) doesn't
 * delay the retry visibly, slow enough that a large repair (a few minutes
 * downloading 100+ images) doesn't hammer the backend. Throws on timeout
 * so the caller's catch surfaces it as a non-fatal warning and continues
 * to the retry.
 */
async function waitForJobTerminal(jobId: string, timeoutMs: number): Promise<void> {
  const POLL_INTERVAL_MS = 2000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let job: any
    try {
      job = await $fetch(`/api/projects/${slug.value}/jobs/${jobId}`)
    } catch (e: any) {
      // 404 = job already cleared (rare — would mean another tab's
      // "Clear finished" ran during the wait). Treat as terminal.
      if (e?.response?.status === 404) return
      throw e
    }
    if (!job) return
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`Repair job ${jobId} did not finish within ${timeoutMs / 1000}s — proceeding with retry anyway.`)
}

async function clearFinished() {
  try {
    const result = await del<{ cleared: number }>(`/projects/${slug.value}/jobs`)
    success(`Cleared ${result.cleared} finished job(s)`)
  } catch (e: any) { showError(e.data?.detail || 'Failed to clear jobs') }
}
</script>

<style scoped>
.jobs-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.header-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* Post-bulk summary banner — surfaces once all pipeline batch jobs settle.
   Layout is a vertical card with a header, optional failure breakdown,
   optional expand-for-details, action row, and an explainer. The card
   re-tints amber when there are failures so the eye catches "something
   needs attention" vs. "all green" without reading the numbers. */
/* Restart-recovery banner: same shape as bulk-finished but in an info
   tone (cyan/blue) since it's actionable but not alarming — interrupted
   jobs are RECOVERABLE, not lost. Layout is single-row so the action
   button sits inline with the explainer. */
.restart-recovery-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 4px;
  padding: 10px 14px;
  background: rgba(99, 145, 200, 0.10);
  border: 1px solid rgba(99, 145, 200, 0.30);
  border-left: 3px solid rgb(99, 145, 200);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-secondary);
}
/* v1.0.190 — paused-queue banner (amber: an attention state the user can act on). */
.queue-paused-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 4px;
  padding: 10px 14px;
  background: rgba(212, 160, 23, 0.10);
  border: 1px solid rgba(212, 160, 23, 0.30);
  border-left: 3px solid rgb(212, 160, 23);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-secondary);
}
.qpb-icon { font-size: 16px; line-height: 1; flex-shrink: 0; }
.qpb-text { flex: 1; line-height: 1.45; }
.qpb-text strong { color: var(--text-primary); }
.rrb-icon {
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
}
.rrb-text {
  flex: 1;
  line-height: 1.45;
}
.rrb-text strong {
  color: var(--text-primary);
}
.rrb-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  flex-shrink: 0;
}
.rrb-dismiss:hover { color: var(--text-primary); }

.bulk-finished-banner {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 12px 0 4px;
  padding: 12px 14px;
  background: rgba(34, 197, 94, 0.08);
  border: 1px solid rgba(34, 197, 94, 0.25);
  border-left: 3px solid rgb(34, 197, 94);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-secondary);
}
.bulk-finished-banner.has-failures {
  background: rgba(250, 189, 47, 0.08);
  border-color: rgba(250, 189, 47, 0.3);
  border-left-color: rgb(250, 189, 47);
}
.bbf-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbf-icon { font-size: 16px; }
.bbf-headline { flex: 1; line-height: 1.45; }
.bbf-headline strong { color: var(--text-primary); }
.bbf-cancelled { color: var(--text-muted); margin-left: 2px; }

.bbf-failures {
  padding: 8px 10px;
  background: rgba(250, 189, 47, 0.06);
  border: 1px solid rgba(250, 189, 47, 0.25);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.bbf-failures-title { margin-bottom: 6px; color: var(--text-primary); }
.bbf-failures-title .text-muted { margin-left: 4px; font-weight: normal; }
.bbf-reason-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 3px;
}
.bbf-reason-list li {
  display: flex; align-items: baseline; gap: 8px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.bbf-count {
  flex-shrink: 0;
  min-width: 28px;
  color: rgb(250, 189, 47);
  font-weight: 700;
}
.bbf-reason-text { word-break: break-word; }

.bbf-details {
  font-size: 12px;
}
.bbf-details summary {
  cursor: pointer;
  color: var(--accent);
  padding: 2px 0;
  user-select: none;
}
.bbf-details summary:hover { text-decoration: underline; }
.bbf-failed-episode {
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
}
.bbf-failed-episode-head { margin-bottom: 4px; font-size: 12px; }
.bbf-failed-episode-head code {
  font-size: 11px;
  padding: 1px 5px;
  background: var(--bg-tertiary);
  border-radius: 3px;
}
.bbf-failed-episode-error {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: rgba(248, 113, 113, 0.08);
  border-left: 2px solid var(--error);
  border-radius: var(--radius-sm);
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 11px;
  color: var(--error);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}

.bbf-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.bbf-explainer {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-muted);
  padding: 8px 10px;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border);
}
.bbf-explainer strong { color: var(--text-secondary); }
.bbf-explainer b { color: var(--text-primary); font-weight: 600; }

.bbf-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  margin-left: auto;
}
.bbf-dismiss:hover { background: var(--bg-hover); color: var(--text-primary); }

/* Filter Tabs */
.filter-tabs {
  display: flex; gap: 2px; margin-top: 16px;
  background: var(--bg-secondary); border-radius: var(--radius); padding: 3px;
  overflow-x: auto;
}
.filter-tab {
  padding: 6px 14px; border-radius: var(--radius-sm);
  font-size: 12px; font-weight: 500;
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; transition: all 0.15s; white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
}
.filter-tab:hover { color: var(--text-primary); background: var(--bg-hover); }
.filter-tab.active { background: var(--accent-dim); color: var(--accent); }
.tab-count {
  background: var(--accent); color: #0f1117;
  font-size: 10px; font-weight: 700;
  padding: 1px 5px; border-radius: 8px; min-width: 16px; text-align: center;
}

/* Sort Bar */
.sort-bar {
  display: flex; align-items: center; gap: 4px; margin-top: 10px; padding: 4px 0;
}
.sort-label { font-size: 11px; margin-right: 4px; }
.sort-btn {
  padding: 3px 8px; border-radius: var(--radius-sm);
  font-size: 11px; background: none; border: 1px solid transparent;
  color: var(--text-muted); cursor: pointer; transition: all 0.15s;
}
.sort-btn:hover { color: var(--text-primary); border-color: var(--border); }
.sort-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.sort-arrow { font-size: 8px; margin-left: 2px; }

/* Job Cards */
.live-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--accent-dim);
  border: 1px solid rgba(240, 198, 116, 0.25);
  border-radius: var(--radius-sm);
  color: var(--accent);
  font-size: 12px;
}

.jobs-list { display: flex; flex-direction: column; gap: 8px; }

.job-card { padding: 14px 16px; transition: border-color 0.2s; }
.job-card.status-running { border-left: 3px solid var(--accent); }
.job-card.status-error { border-left: 3px solid var(--error); }
.job-card.status-done { border-left: 3px solid #22c55e; }
.job-card.status-queued { border-left: 3px solid var(--text-muted); }
.job-card.status-cancelled { border-left: 3px solid var(--text-muted); opacity: 0.6; }

.job-row-main { display: flex; justify-content: space-between; align-items: center; }
.job-type { font-weight: 600; font-size: 13px; color: var(--text-primary); }
.job-episode { font-size: 13px; color: var(--accent); font-weight: 500; }

/* Meta row */
.job-meta {
  display: flex; flex-wrap: wrap; gap: 4px 10px;
  margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);
}
.meta-tag { font-size: 11px; color: var(--text-muted); }
.meta-label { color: var(--text-muted); opacity: 0.7; }

/* Account attribution row — which provider accounts this job actually used.
   Sits between the meta row and the live output so it's visible on every
   job state without scrolling. Muted by default; chips use the same green
   as the Keys-tab default indicator so the two surfaces read as one system. */
.job-accounts {
  display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}
.account-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(46, 160, 67, 0.1);
  color: var(--success, #3fb950);
  border: 1px solid rgba(46, 160, 67, 0.25);
  white-space: nowrap;
}
.account-chip strong { font-weight: 600; margin-left: 2px; }

/* Live output for running jobs */
.job-live-output { margin-top: 10px; }
.output-scroll {
  background: var(--bg-primary); border-radius: var(--radius-sm);
  padding: 10px; margin-top: 6px;
  max-height: 180px; overflow-y: auto;
  font-size: 11px;
}
.output-scroll code {
  display: block; color: var(--text-secondary);
  font-family: 'SF Mono', Monaco, monospace; line-height: 1.6;
}

/* "Starting…" placeholder — shows for a running job before the first log
   line arrives, so the card doesn't look inert. Replaced by real output
   as soon as emitUpdate ships the first push. */
.output-scroll.output-starting { padding: 6px 10px; }
.starting-placeholder {
  display: flex !important;
  align-items: center;
  gap: 8px;
  color: var(--text-muted) !important;
  font-style: italic;
  font-family: inherit !important;
}

.jobs-section { display: block; }
.section-heading {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 0; margin-top: 6px;
  border-bottom: 1px solid var(--border);
}
.section-heading h2 { font-size: 14px; font-weight: 600; margin: 0; color: var(--text-primary); }
.section-count {
  background: var(--bg-tertiary); color: var(--text-muted);
  border-radius: 999px; padding: 1px 8px;
  font-size: 11px; font-family: 'SF Mono', Monaco, monospace;
}
.live-indicator-inline {
  margin-left: auto; display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--accent);
}
.progress-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.progress-bar { flex: 1; height: 3px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; animation: progressIndeterminate 1.5s ease-in-out infinite; }
.progress-counter {
  font-size: 11px; font-family: 'SF Mono', Monaco, monospace;
  color: var(--accent); font-weight: 600; white-space: nowrap;
}
@keyframes progressIndeterminate {
  0% { width: 0%; margin-left: 0; }
  50% { width: 60%; margin-left: 20%; }
  100% { width: 0%; margin-left: 100%; }
}

/* Summary for done jobs */
.job-summary {
  margin-top: 8px; font-size: 12px; color: #22c55e;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.summary-icon { font-weight: bold; }
/* Open-in-Finder sits on the right of the summary line. margin-left: auto
   pushes it to the trailing edge so the green ✓ + summary text get the
   reading flow and the action button is visually distinct. */
.job-open-folder-btn {
  margin-left: auto;
  flex-shrink: 0;
}

/* Expandable output */
.job-expand {
  margin-top: 6px; font-size: 11px; color: var(--accent); cursor: pointer;
}
.job-expand:hover { text-decoration: underline; }
.job-output {
  margin-top: 6px; background: var(--bg-primary); border-radius: var(--radius-sm);
  padding: 10px; font-size: 11px; max-height: 250px; overflow-y: auto;
}
.job-output code {
  display: block; color: var(--text-secondary);
  font-family: 'SF Mono', Monaco, monospace; line-height: 1.6;
}

/* Error section */
.job-error-section { margin-top: 8px; }
.error-summary {
  display: flex; gap: 6px; align-items: flex-start;
  padding: 8px 10px;
  background: rgba(248, 113, 113, 0.10); border-left: 3px solid var(--error);
  border-radius: var(--radius-sm);
  font-size: 12px; color: var(--error);
}
.error-label { font-weight: 600; flex-shrink: 0; }
.error-summary-text { word-break: break-word; }
.error-toggle {
  font-size: 11px; color: var(--error); cursor: pointer;
  margin-top: 4px; display: inline-block;
}
.error-toggle:hover { text-decoration: underline; }
.error-details {
  margin-top: 6px; padding: 10px;
  background: rgba(248, 113, 113, 0.08); border-radius: var(--radius-sm);
  font-size: 12px; color: var(--error); font-family: 'SF Mono', Monaco, monospace;
  white-space: pre-wrap; word-break: break-word;
}

/* Pagination */
.pagination {
  display: flex; justify-content: center; align-items: center; gap: 12px;
  margin-top: 16px; padding: 12px 0;
}
.page-info { font-size: 12px; color: var(--text-muted); }

/* Button sizes */
.btn-xs { padding: 3px 10px; font-size: 11px; }
.btn-icon {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 13px; padding: 3px 6px; border-radius: 4px;
}
.btn-icon:hover { color: var(--error); background: rgba(248, 113, 113, 0.1); }
</style>
