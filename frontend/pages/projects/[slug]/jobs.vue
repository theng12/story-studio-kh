<template>
  <div class="workspace-page jobs-workspace">
    <WorkspaceHero
      eyebrow="Management · Operations"
      :title="isUniversal ? 'All Jobs' : 'Project Jobs'"
      :description="isUniversal
        ? 'Monitor and control work across every project from one queue. Filter by project without switching workspaces.'
        : 'Monitor this project’s active work, understand failures, recover output, and manage its history.'"
    >
      <template #aside>
        <div class="jobs-hero-aside">
          <nav class="job-scope-switch" aria-label="Job queue scope">
            <NuxtLink :to="`/projects/${slug}/jobs`" :class="{ active: !isUniversal }">This project</NuxtLink>
            <NuxtLink :to="{ path: `/projects/${slug}/jobs`, query: { scope: 'all' } }" :class="{ active: isUniversal }">All projects</NuxtLink>
          </nav>
          <div class="workspace-metrics" aria-label="Job queue summary">
            <span class="workspace-metric" data-tone="info"><strong>{{ stats.running }}</strong> running</span>
            <span class="workspace-metric" data-tone="warning"><strong>{{ stats.queued }}</strong> waiting locally</span>
            <span v-if="stats.paused" class="workspace-metric" data-tone="warning"><strong>{{ stats.paused }}</strong> paused</span>
            <span class="workspace-metric" data-tone="success"><strong>{{ stats.done }}</strong> done</span>
            <span v-if="stats.error" class="workspace-metric" data-tone="error"><strong>{{ stats.error }}</strong> errors</span>
          </div>
          <div class="genstudio-capacity-summary" aria-label="GenStudio account capacity">
            <span
              v-if="genStudioAdmission?.submissions_blocked"
              class="capacity-error"
              :title="genStudioAdmission.submission_block_reason || undefined"
            >
              <strong>Submissions stopped</strong>
              GenStudio release not ready
            </span>
            <span v-if="genStudioAdmission?.local_waiting">
              <strong>{{ genStudioAdmission.local_waiting }}</strong>
              submissions waiting locally
            </span>
            <template v-if="verifiedGenStudioAdmission && genStudioAdmission">
            <span>
              <strong>{{ genStudioAdmission.paid_active_jobs }} active / {{ genStudioAdmission.paid_concurrency_limit }} standard lanes</strong>
            </span>
            <span
              v-if="genStudioAdmission.burst_concurrency_ceiling && genStudioAdmission.paid_active_jobs > genStudioAdmission.paid_concurrency_limit"
              class="capacity-boost"
            >
              <strong>Temporary boost</strong>
              up to {{ genStudioAdmission.burst_concurrency_ceiling }} jobs when GenStudio has spare capacity — best effort, not guaranteed.
            </span>
            <span v-if="genStudioAdmission.service_tier" class="capacity-tier">
              <strong>{{ genStudioAdmission.service_tier.current.display_name }}</strong>
              standard tier
            </span>
            <span
              v-if="genStudioAdmission.service_tier?.next_tier && genStudioAdmission.service_tier.cents_to_next_tier !== null"
              class="capacity-next-tier"
            >
              {{ formatGenStudioCents(genStudioAdmission.service_tier.cents_to_next_tier) }} more unlocks
              <strong>{{ genStudioAdmission.service_tier.next_tier.display_name }}</strong>:
              {{ genStudioAdmission.service_tier.next_tier.paid_concurrency_limit }} standard lanes,
              {{ genStudioAdmission.service_tier.next_tier.generation_submissions_per_minute }} submissions/min
              Purchase more standard capacity in GenStudio.
            </span>
            <span :class="{ 'capacity-warning': genStudioAdmission.queue_near_capacity }">
              <strong>{{ genStudioAdmission.paid_queued_jobs }}/{{ genStudioAdmission.max_queued_jobs }}</strong>
              GenStudio queued
            </span>
            <span>
              <strong>{{ genStudioAdmission.generation_submissions_per_minute }}</strong>
              submissions/min
            </span>
            </template>
            <span v-else class="capacity-warning capacity-unverified">
              <strong>Account capacity is unverified.</strong>
              Story Studio is scheduling conservatively.
            </span>
          </div>
          <div class="jobs-hero-actions">
            <button
              v-if="!queuePaused"
              class="btn btn-sm btn-secondary"
              :disabled="changingQueueState"
              @click="pauseQueue"
              title="Hold every queued Story job before submission. Running GenStudio jobs stop claiming new items after accepted work is saved."
            >Pause queue</button>
            <!-- v1.4.43 — labelled for what it does. This one really is the
                 whole-library sweep, and it used to be called plain "Repair
                 assets" next to per-job Repair buttons that fix one thing.
                 Choosing the sweep should be a choice. -->
            <NuxtLink
              v-if="!isUniversal"
              :to="`/projects/${slug}/board?repair=1`"
              class="btn btn-sm btn-secondary"
              title="Scans EVERY accepted episode in this project for output the provider already produced but that never landed on disk, then re-downloads it (no credits consumed). To fix one failed job instead, use the buttons on that job's own row below."
            >
              Scan all for repair
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
      </template>
    </WorkspaceHero>

    <!-- Durable Story-side queue hold. Queued work has not been submitted;
         accepted GenStudio items checkpoint before their job pauses. -->
    <WorkspaceNotice v-if="queuePaused" tone="warning" title="Job queue is paused">
      New Story jobs are held before submission. Running GenStudio jobs finish saving already accepted items, then pause safely.
      <template #actions>
        <button class="btn btn-sm btn-primary" :disabled="resumingQueue" @click="resumeQueue">
          {{ resumingQueue ? 'Resuming…' : 'Resume now' }}
        </button>
      </template>
    </WorkspaceNotice>

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
          aria-label="Dismiss pipeline summary"
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
          <pre class="bbf-failed-episode-error">{{ customerSafeJobText(fe.full_error) }}</pre>
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
          :to="batchRepairLink"
          class="btn btn-sm btn-primary"
          :title="batchSummary.failed_episodes.length
            ? `Open Repair for the ${batchSummary.failed_episodes.length} episode(s) that failed in this batch — nothing else is scanned. Re-downloads output the provider already produced and was already paid for; no credits consumed.`
            : 'Open Repair (on the Production Board) — lists provider-completed outputs that didn\'t land on disk (e.g. network drop after upload). One-click repair does NOT consume credits; it only re-downloads what the provider already produced.'"
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
        :aria-pressed="activeFilter === tab.type"
        @click="activeFilter = tab.type; failureBatchFilter = null; currentPage = 1"
      >
        {{ tab.label }}
        <span v-if="tab.count > 0" class="tab-count">{{ tab.count }}</span>
      </button>
    </div>

    <!-- Status Filter + bulk repair -->
    <div class="status-bar">
      <div class="status-filters">
        <button
          v-for="s in statusFilters"
          :key="s.key"
          class="status-chip"
          :class="{ active: statusFilter === s.key, [`sc-${s.key}`]: true }"
          :aria-pressed="statusFilter === s.key"
          @click="statusFilter = s.key; failureBatchFilter = null"
        >
          {{ s.label }}<span v-if="s.count > 0" class="status-count">{{ s.count }}</span>
        </button>
      </div>
      <button
        v-if="repairableFailedJobs.length > 0"
        class="btn btn-sm btn-primary repair-all-btn"
        :disabled="repairingAllFailed"
        title="Recover every failed/cancelled job that CAN be repaired — polls each provider for completed tasks and downloads them for free. Never re-submits (no charge). Genuinely-missing items stay failed for you to Retry."
        @click="repairAllFailed"
      >
        {{ repairingAllFailed ? 'Repairing…' : `🔧 Repair all failed (${repairableFailedJobs.length})` }}
      </button>
      <button
        v-if="failedJobsForRetryAll.length > 0"
        class="btn btn-sm retry-all-btn"
        :disabled="retryingAllFailed"
        :title="retryAllTooltip"
        @click="retryAllFailed"
      >
        {{ retryingAllFailed ? 'Sending…' : `↻ Retry all (${retryAllTriage.retry.length})` }}
      </button>
    </div>

    <!-- Sort Bar -->
    <div class="sort-bar">
      <label v-if="isUniversal" class="project-filter">
        <span>Project</span>
        <select v-model="projectFilter">
          <option value="all">All projects</option>
          <option value="_app_">App tools</option>
          <option v-for="project in projects" :key="project.slug" :value="project.slug">{{ project.name }}</option>
        </select>
      </label>
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
          <div class="job-identity">
            <StatusBadge :status="job.status" />
            <NuxtLink
              v-if="isUniversal && job.project_slug !== '_app_'"
              :to="`/projects/${job.project_slug}/jobs`"
              class="job-project"
              :title="`Open ${projectName(job.project_slug)} jobs`"
            >{{ projectName(job.project_slug) }}</NuxtLink>
            <span v-else-if="isUniversal" class="job-project">App tools</span>
            <span class="job-type">{{ jobDisplayLabel(job) }}</span>
            <span class="job-episode">{{ job.episode_id }}</span>
            <span v-if="job.title" class="job-title text-muted" :title="job.title">- {{ job.title }}</span>
          </div>
          <div class="job-actions">
            <button
              v-if="job.status === 'paused'"
              class="btn btn-xs btn-primary"
              @click="resumeJob(job)"
              title="Verify saved output and accepted work, then continue only missing work."
            >Resume</button>
            <button
              v-else-if="primaryJobControl(job)"
              class="btn btn-xs btn-secondary"
              :class="{ 'job-control-primary': primaryJobControl(job)?.enabled }"
              :disabled="!primaryJobControl(job)?.enabled || controlBusy.has(job.job_id)"
              :title="primaryJobControl(job)?.reason"
              @click="runJobControl(job, primaryJobControl(job) || undefined)"
            >
              {{ controlBusy.has(job.job_id) ? 'Working…' : primaryJobControl(job)?.label }}
            </button>
            <details v-if="secondaryJobControls(job).length" class="job-more-actions">
              <summary>More actions</summary>
              <div class="job-more-actions-body">
                <button
                  v-for="control in secondaryJobControls(job)"
                  :key="control.action"
                  class="btn btn-xs btn-secondary"
                  :disabled="!control.enabled || controlBusy.has(job.job_id)"
                  :title="control.reason"
                  @click="runJobControl(job, control)"
                >{{ controlBusy.has(job.job_id) ? 'Working…' : control.label }}</button>
                <p v-for="control in secondaryJobControls(job)" :key="`more-reason-${control.action}`" class="job-control-reason">
                  {{ customerJobText(control.reason, job) }}
                </p>
              </div>
            </details>
            <!-- v1.0.114 — Repair / Retry split. Repair (left) is the safe
                 default: polls the provider for already-completed tasks
                 and downloads them. Never re-submits. Retry (right) is
                 the explicit "re-run, charge me again" action. The old
                 combined button caused duplicate provider tasks when
                 users clicked it repeatedly to "make it work". -->
            <button
              v-if="(job.status === 'error' || job.status === 'cancelled') && jobCanBeRepaired(job) && !job.auto_retry?.eligible"
              class="btn btn-xs btn-primary"
              @click="repairJobOnly(job)"
              title="SAFE — Polls the provider for tasks that were submitted but never finished downloading, and pulls them in for free. Never re-submits anything. Click this FIRST when a job timed out — the provider often finished the work on its side. If chunks are still missing afterwards, then click Retry."
            >
              Repair
            </button>
            <span v-if="repairOutcome[job.job_id]" class="repair-chip" :class="`rc-${repairOutcome[job.job_id].kind}`">
              {{ repairOutcome[job.job_id].text }}
            </span>
            <!-- v1.2.8 — targeted recovery for the job types the per-job
                 Repair above does not cover. Same machinery, one episode:
                 scanning the whole library to fix the episode you are looking
                 at is the wrong shape, and slow enough to be unusable. -->
            <NuxtLink
              v-if="episodeRecoveryLink(job)"
              :to="episodeRecoveryLink(job)!"
              class="btn btn-xs btn-primary"
              title="SAFE — Checks THIS episode only for output the provider already finished but that never landed on disk, and pulls it in for free. No credits consumed, nothing re-submitted, and no other episode is scanned."
            >
              Recover this episode
            </NuxtLink>
            <button
              v-if="job.status === 'error' || job.status === 'cancelled'"
              class="btn btn-xs btn-secondary"
              @click="retryJob(job)"
              :title="retryTooltip(job)"
            >
              Retry
            </button>
          </div>
        </div>

        <!-- Row 2: Meta (model, duration, timestamps) -->
        <div class="job-meta">
          <span
            v-if="job.params?.model"
            class="meta-tag"
            :title="jobModelTitle(job)"
          >
            <span class="meta-label">Model:</span> {{ jobModelDisplay(job) }}
          </span>
          <span
            v-if="job.auto_retry?.eligible"
            class="meta-tag auto-retry-tag"
            :class="autoRetryClass(job)"
            :title="job.auto_retry.reason"
          >
            {{ autoRetryLabel(job) }}
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
          <!-- The raw job id lives in Technical details now. It is an
               8-character hex slice with no meaning to the person asking
               "is my video coming?", and it was the widest thing on the row. -->
        </div>

        <!-- Row 2.5: Account attribution.
             Populated live by the resolver in providers/registry.ts
             whenever ctx.jobId is set. Hidden on jobs that never called a
             provider (local-only jobs) and on older jobs queued before the
             attribution schema shipped. Entries whose provider Story Studio
             may not name are dropped by visibleAccounts() — see there. -->
        <div v-if="hasAccountsUsed(job)" class="job-accounts">
          <span class="meta-label">Accounts:</span>
          <span
            v-for="entry in visibleAccounts(job)"
            :key="entry.providerId"
            class="account-chip"
            :title="entry.label"
          >
            {{ entry.label }}: <strong>{{ entry.account.label }}</strong>
          </span>
        </div>

        <!-- Row 3: the progress tracker. Counts first, in words, because the
             question this card exists to answer is "how much is left" — and
             the wall of one-line-per-scene it replaces answered that only by
             making the reader count. -->
        <div v-if="job.item_progress" class="job-stats">
          <span class="job-stat">
            <strong>{{ jobCounts(job).total.toLocaleString() }}</strong>
            <span class="job-stat-label">total</span>
          </span>
          <span class="job-stat is-inflight">
            <strong>{{ jobCounts(job).inFlight.toLocaleString() }}</strong>
            <span class="job-stat-label">generating right now</span>
          </span>
          <span class="job-stat is-finished">
            <strong>{{ jobCounts(job).finished.toLocaleString() }}</strong>
            <span class="job-stat-label">finished</span>
          </span>
          <span class="job-stat">
            <strong>{{ jobCounts(job).remaining.toLocaleString() }}</strong>
            <span class="job-stat-label">remaining</span>
          </span>
          <span v-if="jobCounts(job).queued" class="job-stat is-muted">
            <strong>{{ jobCounts(job).queued.toLocaleString() }}</strong>
            <span class="job-stat-label">waiting for capacity</span>
          </span>
          <span v-if="jobCounts(job).settling" class="job-stat is-muted">
            <strong>{{ jobCounts(job).settling.toLocaleString() }}</strong>
            <span class="job-stat-label">settling</span>
          </span>
          <!-- Measured, never assumed — see useJobEta.ts. Absent until this
               job's own rate or its class's median can support one. -->
          <span v-if="jobEta(job)" class="job-stat-eta">{{ jobEta(job) }}</span>
          <!-- "when did something last actually happen". A quiet card is the
               reason this page gets opened; silence must be legible. -->
          <span
            v-if="jobFreshness(job)"
            class="job-stat-fresh"
            :class="{ 'is-stale': jobProgressStale(job) }"
          >{{ jobFreshness(job) }}</span>
        </div>

        <!-- Money: three figures, nothing else. The per-item ledger that used
             to sit here is in Technical details. -->
        <template v-if="job.genstudio_jobs?.length">
          <div class="job-money">
            <span class="meta-label">Credits:</span>
            <!-- v1.4.7 — the unit on all three, not just the last. `on hold` already
                 said "credits" while `charged` and `returned` did not, so the same
                 page spelled one fact two ways. -->
            <span class="job-money-figure charged">{{ jobChargedCredits(job).toLocaleString() }} credits charged</span>
            <span class="job-money-figure held">{{ jobHeldCredits(job).toLocaleString() }} credits on hold</span>
            <span class="job-money-figure returned">{{ jobReturnedCredits(job).toLocaleString() }} credits returned</span>
          </div>
          <GenStudioCreditSettlementHint :remote-jobs="job.genstudio_jobs" compact />
        </template>
        <p v-if="genStudioStatusDetail(job)" class="genstudio-status-detail" role="status">
          {{ genStudioStatusDetail(job) }}
        </p>

        <div v-if="job.status === 'running'" class="job-live-output">
          <div class="progress-row">
            <ProgressBar
              :indeterminate="jobProgress(job) == null"
              :progress="jobProgress(job) ?? undefined"
              :bytes-done="job.bytes_done"
              :bytes-total="job.bytes_total"
              :speed-bps="job.speed_bps"
              :eta-seconds="job.eta_seconds"
              :label="job.type === 'youtube_upload' ? youtubeProgressLabel(job) : undefined"
              :label-title="job.type === 'youtube_upload' ? youtubeProgressHelp : undefined"
            />
            <span v-if="jobProgress(job) == null && progressCounter(job)" class="progress-counter">{{ progressCounter(job) }}</span>
          </div>
        </div>

        <!-- Exceptions, one plain-words line each: what failed, what it cost,
             what happens next. Renders only when something actually went
             wrong — a healthy job shows none of this. -->
        <ul v-if="jobExceptions(job).length" class="job-exceptions">
          <li v-for="line in jobExceptions(job)" :key="line.key">{{ line.text }}</li>
        </ul>

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

        <!-- Error details -->
        <div v-if="job.status === 'error'" class="job-error-section">
          <div v-if="job.error" class="error-summary">
            <span class="error-label">Error:</span>
            <span class="error-summary-text">{{ firstErrorLine(customerJobText(job.error, job)) }}</span>
          </div>
          <button
            v-if="job.error && hasMoreErrorLines(job.error)"
            type="button"
            class="error-toggle"
            :aria-expanded="errorExpanded === job.job_id"
            :aria-controls="`job-error-active-${job.job_id}`"
            @click="errorExpanded === job.job_id ? errorExpanded = null : errorExpanded = job.job_id"
          >
            {{ errorExpanded === job.job_id ? 'Hide full error' : 'Show full error' }}
          </button>
          <div :id="`job-error-active-${job.job_id}`" v-if="errorExpanded === job.job_id && job.error" class="error-details">
            {{ customerJobText(job.error, job) }}
          </div>
        </div>

        <!-- Technical details. Everything the default view no longer shows,
             folded rather than deleted: the full item ledger, the per-item
             states, the raw log, the redacted request preview and every id.
             These are what actually solved incidents; only one card's drawer
             is mounted at a time so a page of long logs stays cheap. -->
        <AdvancedDisclosure
          label="Technical details"
          :open="expanded === job.job_id"
          @update:open="setTechnicalOpen(job.job_id, $event)"
        >
          <template v-if="expanded === job.job_id">
            <p v-if="expandSummary(job)" class="technical-summary">{{ expandSummary(job) }}</p>
            <GenStudioBatchLedger v-if="job.genstudio_jobs?.length" :remote-jobs="job.genstudio_jobs" />
            <!--
              What the job is actually working on, item by item. A percentage
              says how far; a long-running step that reports nothing else is
              indistinguishable from a hang, and that ambiguity has already
              produced a wrong diagnosis. `waiting_retry` in particular is a
              job doing exactly what it should and must not read as stuck.
            -->
            <div v-if="job.item_progress" class="job-items">
              <span class="job-items-count">
                {{ job.item_progress.completed }} of {{ job.item_progress.total }} done
              </span>
              <span v-if="job.item_progress.failed" class="job-items-failed">
                · {{ job.item_progress.failed }} failed
              </span>
              <span v-if="job.item_progress.settling" class="job-items-note">
                · {{ job.item_progress.settling }} settling
              </span>
              <span v-if="job.item_progress.cancelled" class="job-items-note">
                · {{ job.item_progress.cancelled }} cancelled by customer
              </span>
              <span v-if="job.item_progress.not_submitted" class="job-items-note">
                · {{ job.item_progress.not_submitted }} not submitted
              </span>
              <span
                v-if="job.item_progress.concurrency === 1 && job.item_progress.total > 1"
                class="job-items-note"
                title="Sent to the provider one request at a time, on purpose — a whole batch at once gets most of it refused."
              >· one at a time</span>
              <span
                v-for="item in job.item_progress.active"
                :key="item.key || item.label"
                class="job-items-active"
                :class="{ waiting: item.state === 'waiting_retry' }"
              >· {{ itemAttemptText(item) }}</span>
            </div>
            <GenStudioRequestPreview v-if="job.genstudio_jobs?.length" :remote-jobs="job.genstudio_jobs" />
            <div v-if="job.output_lines?.length" class="job-output">
              <code v-for="(line, i) in job.output_lines" :key="i">{{ customerJobText(line, job) }}</code>
            </div>
            <div class="job-technical-ids">
              <span v-if="getOutputDir(job)" class="meta-tag"><span class="meta-label">Output folder:</span> {{ getOutputDir(job) }}</span>
            </div>
          </template>
        </AdvancedDisclosure>

        <p
          v-if="primaryJobControl(job)"
          class="job-control-reason"
          :class="`control-${primaryJobControl(job)?.action}`"
          role="status"
        >
          <template v-if="hasPendingCancellation(job) && primaryJobControl(job)?.action === 'request-remote-cancel'">Story Studio is reconciling the cancellation result. </template>
          {{ customerJobText(primaryJobControl(job)?.reason, job) }}
        </p>
      </div>
      </div>
    </section>

    <!-- History (done / error / cancelled) — paginated -->
    <section v-if="historyJobs.length" ref="historySection" class="jobs-section mt-3">
      <div class="section-heading">
        <h2 ref="historyHeading" tabindex="-1">History</h2>
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
            <div class="job-identity">
              <StatusBadge :status="job.status" />
              <NuxtLink
                v-if="isUniversal && job.project_slug !== '_app_'"
                :to="`/projects/${job.project_slug}/jobs`"
                class="job-project"
                :title="`Open ${projectName(job.project_slug)} jobs`"
              >{{ projectName(job.project_slug) }}</NuxtLink>
              <span v-else-if="isUniversal" class="job-project">App tools</span>
              <span class="job-type">{{ jobDisplayLabel(job) }}</span>
              <span class="job-episode">{{ job.episode_id }}</span>
              <span v-if="job.title" class="job-title text-muted" :title="job.title">- {{ job.title }}</span>
            </div>
            <div class="job-actions">
              <button
                v-for="control in jobControls(job)"
                :key="control.action"
                class="btn btn-xs btn-secondary"
                :class="{ 'job-control-primary': control.enabled && control.action === 'clear-history' }"
                :disabled="!control.enabled || controlBusy.has(job.job_id)"
                :title="control.reason"
                @click="runJobControl(job, control)"
              >{{ controlBusy.has(job.job_id) ? 'Working…' : control.label }}</button>
              <!-- v1.0.114 — Repair / Retry split (mirror of expanded view above). -->
              <button
                v-if="(job.status === 'error' || job.status === 'cancelled') && jobCanBeRepaired(job) && !job.auto_retry?.eligible"
                class="btn btn-xs btn-primary"
                @click="repairJobOnly(job)"
                title="SAFE — Polls the provider for already-completed tasks and downloads them for free. Never re-submits. Click this FIRST when a job timed out."
              >
                Repair
              </button>
              <span v-if="repairOutcome[job.job_id]" class="repair-chip" :class="`rc-${repairOutcome[job.job_id].kind}`">
                {{ repairOutcome[job.job_id].text }}
              </span>
              <!-- v1.2.8 — targeted recovery (mirror of the expanded view). -->
              <NuxtLink
                v-if="episodeRecoveryLink(job)"
                :to="episodeRecoveryLink(job)!"
                class="btn btn-xs btn-primary"
                title="SAFE — Checks THIS episode only for output the provider already finished but that never landed on disk, and pulls it in for free. No credits consumed, nothing re-submitted, and no other episode is scanned."
              >
                Recover this episode
              </NuxtLink>
              <button
                v-if="job.status === 'error' || job.status === 'cancelled'"
                class="btn btn-xs btn-secondary"
                @click="retryJob(job)"
                :title="retryTooltip(job)"
              >
                Retry
              </button>
            </div>
          </div>
          <p
            v-for="control in jobControls(job)"
            :key="`reason-${control.action}`"
            class="job-control-reason"
            :class="`control-${control.action}`"
            role="status"
          >
            <template v-if="hasPendingCancellation(job) && control.action === 'request-remote-cancel'">Story Studio is reconciling the cancellation result. </template>
            <template v-else-if="control.action === 'clear-history'">Removing this row does not change its files or billing records. </template>
            {{ customerJobText(control.reason, job) }}
          </p>

          <div class="job-meta">
            <span
              v-if="job.params?.model"
              class="meta-tag"
              :title="jobModelTitle(job)"
            >
              <span class="meta-label">Model:</span> {{ jobModelDisplay(job) }}
            </span>
            <span
              v-if="job.auto_retry?.eligible"
              class="meta-tag auto-retry-tag"
              :class="autoRetryClass(job)"
              :title="job.auto_retry.reason"
            >
              {{ autoRetryLabel(job) }}
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

          <!-- History has no in-flight work and no ETA — its final counts,
               its money, its exceptions, and the same drawer. -->
          <div v-if="job.item_progress" class="job-stats">
            <span class="job-stat">
              <strong>{{ jobCounts(job).total.toLocaleString() }}</strong>
              <span class="job-stat-label">total</span>
            </span>
            <span class="job-stat is-finished">
              <strong>{{ jobCounts(job).finished.toLocaleString() }}</strong>
              <span class="job-stat-label">finished</span>
            </span>
            <span class="job-stat">
              <strong>{{ jobCounts(job).remaining.toLocaleString() }}</strong>
              <span class="job-stat-label">remaining</span>
            </span>
            <span v-if="jobCounts(job).queued" class="job-stat is-muted">
              <strong>{{ jobCounts(job).queued.toLocaleString() }}</strong>
              <span class="job-stat-label">waiting for capacity</span>
            </span>
            <span v-if="jobCounts(job).settling" class="job-stat is-muted">
              <strong>{{ jobCounts(job).settling.toLocaleString() }}</strong>
              <span class="job-stat-label">settling</span>
            </span>
          </div>

          <template v-if="job.genstudio_jobs?.length">
            <div class="job-money">
              <span class="meta-label">Credits:</span>
              <span class="job-money-figure charged">{{ jobChargedCredits(job).toLocaleString() }} credits charged</span>
              <span class="job-money-figure held">{{ jobHeldCredits(job).toLocaleString() }} credits on hold</span>
              <span class="job-money-figure returned">{{ jobReturnedCredits(job).toLocaleString() }} credits returned</span>
            </div>
            <GenStudioCreditSettlementHint :remote-jobs="job.genstudio_jobs" compact />
          </template>
          <p v-if="genStudioStatusDetail(job)" class="genstudio-status-detail" role="status">
            {{ genStudioStatusDetail(job) }}
          </p>

          <ul v-if="jobExceptions(job).length" class="job-exceptions">
            <li v-for="line in jobExceptions(job)" :key="line.key">{{ line.text }}</li>
          </ul>

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

          <!-- Technical details — mirror of the Active card's drawer. -->
          <AdvancedDisclosure
            label="Technical details"
            :open="expanded === job.job_id"
            @update:open="setTechnicalOpen(job.job_id, $event)"
          >
            <template v-if="expanded === job.job_id">
              <p v-if="expandSummary(job)" class="technical-summary">{{ expandSummary(job) }}</p>
              <GenStudioBatchLedger v-if="job.genstudio_jobs?.length" :remote-jobs="job.genstudio_jobs" />
              <div v-if="job.item_progress" class="job-items">
                <span class="job-items-count">
                  {{ job.item_progress.completed }} of {{ job.item_progress.total }} done
                </span>
                <span v-if="job.item_progress.failed" class="job-items-failed">
                  · {{ job.item_progress.failed }} failed
                </span>
                <span v-if="job.item_progress.settling" class="job-items-note">
                  · {{ job.item_progress.settling }} settling
                </span>
                <span v-if="job.item_progress.cancelled" class="job-items-note">
                  · {{ job.item_progress.cancelled }} cancelled by customer
                </span>
                <span v-if="job.item_progress.not_submitted" class="job-items-note">
                  · {{ job.item_progress.not_submitted }} not submitted
                </span>
                <span
                  v-for="item in job.item_progress.active"
                  :key="item.key || item.label"
                  class="job-items-active"
                  :class="{ waiting: item.state === 'waiting_retry' }"
                >· {{ itemAttemptText(item) }}</span>
              </div>
              <GenStudioRequestPreview v-if="job.genstudio_jobs?.length" :remote-jobs="job.genstudio_jobs" />
              <div v-if="job.output_lines?.length" class="job-output">
                <code v-for="(line, i) in job.output_lines" :key="i">{{ customerJobText(line, job) }}</code>
              </div>
              <div class="job-technical-ids">
                <span v-if="getOutputDir(job)" class="meta-tag"><span class="meta-label">Output folder:</span> {{ getOutputDir(job) }}</span>
              </div>
            </template>
          </AdvancedDisclosure>

          <div v-if="job.status === 'error'" class="job-error-section">
            <div v-if="job.error" class="error-summary">
              <span class="error-label">Error:</span>
              <span class="error-summary-text">{{ firstErrorLine(customerJobText(job.error, job)) }}</span>
            </div>
            <button
              v-if="job.error && hasMoreErrorLines(job.error)"
              type="button"
              class="error-toggle"
              :aria-expanded="errorExpanded === job.job_id"
              :aria-controls="`job-error-history-${job.job_id}`"
              @click="errorExpanded === job.job_id ? errorExpanded = null : errorExpanded = job.job_id"
            >
              {{ errorExpanded === job.job_id ? 'Hide full error' : 'Show full error' }}
            </button>
            <div :id="`job-error-history-${job.job_id}`" v-if="errorExpanded === job.job_id && job.error" class="error-details">
              {{ customerJobText(job.error, job) }}
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
import { publicProviderLabel } from '~/composables/useModelGroups'
import { buildLatestBatchSummary, formatElapsed } from '~/composables/useBatchSummary'
import {
  describeCancellation,
  describeFreshness,
  describeJobExceptions,
  estimateSecondsRemaining,
  formatEtaApprox,
  isProgressStale,
  lastProgressAt,
  medianSecondsPerItem,
  recordEtaSample,
  summariseJobItems,
  WAITING_FALLBACK_REASON,
  type EtaSample,
} from '~/composables/useJobEta'
import {
  describeRetryAllTriage,
  normaliseRepairResult,
  triageFailedJobsForRetryAll,
  type RepairRecord,
} from '~/utils/repair-triage'
import {
  customerSafeJobText,
  filterJobsForView,
  isVerifiedLiveCapacity,
  primaryControl,
  secondaryControls,
} from '~/utils/job-presentation'
type RJob = DeepReadonly<Job>

definePageMeta({ layout: 'dashboard' })
useAppTitle('Jobs')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, del, post } = useApi()
const projectQueue = useJobs()
const universalQueue = useAllJobs()
const genStudioModels = useGenStudioModelDisplay()
const isUniversal = computed(() => route.query.scope === 'all')
const jobs = computed(() => isUniversal.value ? universalQueue.jobs.value : projectQueue.jobs.value)
const stats = computed(() => isUniversal.value ? universalQueue.stats.value : projectQueue.stats.value)
const { success, error: showError, info } = useToast()

interface ProjectOption { slug: string; name: string }
interface GenStudioServiceTier {
  code: string
  display_name: string
  threshold_cents: number
  paid_concurrency_limit: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
  max_api_keys: number
}
interface GenStudioServiceTierStanding {
  current: GenStudioServiceTier
  ladder: GenStudioServiceTier
  overridden: boolean
  lifetime_paid_cents: number
  next_tier: GenStudioServiceTier | null
  cents_to_next_tier: number | null
}
interface GenStudioAdmissionSnapshot {
  paid_concurrency_limit: number
  paid_active_jobs: number
  paid_queued_jobs: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
  burst_concurrency_ceiling?: number
  service_tier?: GenStudioServiceTierStanding
  local_waiting: number
  submitting: number
  available_paid_slots: number
  submissions_in_window: number
  queue_near_capacity: boolean
  submissions_blocked: boolean
  submission_block_reason: string | null
  retry_after_ms: number
  refreshed_at: string | null
  limitSource: 'account-overview' | 'safe-fallback'
}
function formatGenStudioCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}
const projects = ref<ProjectOption[]>([])
const projectFilter = ref('all')
const projectNames = computed(() => new Map(projects.value.map(project => [project.slug, project.name])))
function projectName(projectSlug: string) {
  return projectNames.value.get(projectSlug) || projectSlug
}

async function loadProjects() {
  if (projects.value.length) return
  try { projects.value = await get<ProjectOption[]>('/projects') }
  catch { projects.value = [] }
}

watch(isUniversal, enabled => {
  projectFilter.value = 'all'
  if (enabled) {
    universalQueue.start()
    void loadProjects()
  } else {
    universalQueue.stop()
  }
}, { immediate: true })

// Account attribution helpers. Populated by the resolver whenever it runs
// under a jobId (see electron/server/providers/registry.ts). Present only
// on jobs that actually called a provider through the resolver.
/**
 * The account chips, filtered to providers Story Studio may name.
 *
 * This page renders records written long ago. A job queued before the
 * GenStudio-only migration (v1.0.669) still carries whatever transport served
 * it — an upstream aggregator or a direct-vendor key — as the key of its
 * `accounts_used` map, and that data stays on disk untouched. What changes is
 * the DISPLAY: an entry whose provider has no public label is dropped rather
 * than printed raw, so a private routing identity cannot surface from history.
 * The row hides entirely when nothing is left to show.
 */
function visibleAccounts(job: RJob): Array<{ providerId: string; label: string; account: { id: string; label: string } }> {
  const used = job.accounts_used
  if (!used) return []
  return Object.entries(used).flatMap(([providerId, account]) => {
    const label = publicProviderLabel(providerId)
    return label ? [{ providerId, label, account }] : []
  })
}

function hasAccountsUsed(job: RJob): boolean {
  return visibleAccounts(job).length > 0
}

/**
 * The output expander is also where the redacted GenStudio request preview
 * lives, so a job that recorded a request but produced no log lines (a
 * submission rejected before it ever ran) must still be expandable — that is
 * precisely the case a user opens this page to diagnose.
 */
function genStudioRequestCount(job: RJob): number {
  return job.genstudio_jobs?.filter(remote => !!remote.request).length || 0
}

/** The Technical-details badge: how much is folded away behind the toggle. */
function expandSummary(job: RJob): string {
  const parts: string[] = []
  const lines = job.output_lines?.length || 0
  if (lines) parts.push(`${lines} line${lines === 1 ? '' : 's'}`)
  const requests = genStudioRequestCount(job)
  if (requests) parts.push(`${requests} request${requests === 1 ? '' : 's'}`)
  return parts.join(' + ')
}

function jobModelDisplay(job: RJob): string {
  return genStudioModels.displayName(job.params?.model)
}

function jobModelTitle(job: RJob): string {
  return jobModelDisplay(job)
}

const GENSTUDIO_QUEUE_LABELS: Record<string, string> = {
  waiting_local: 'Waiting locally',
  submitting: 'Submitting to GenStudio',
  accepted: 'Accepted',
  waiting_account_capacity: 'Waiting for account capacity',
  reserved: 'Reserved',
  dispatched: 'Dispatched',
  validating: 'Validating',
  reconciling: 'Reconciling',
  running: 'Running',
  completing: 'Completing',
  succeeded: 'Succeeded',
  failed: 'Failed',
  waiting_credits: 'Waiting for credits',
  cancelled: 'Cancelled',
}

function genStudioQueueLabel(
  remote: NonNullable<RJob['genstudio_jobs']>[number],
): string {
  const state = String(remote.queue_state || remote.state || 'unknown').toLowerCase()
  return GENSTUDIO_QUEUE_LABELS[state] || String(state).replace(/_/g, ' ')
}

/**
 * The one sentence a card shows about what GenStudio is doing, and when.
 *
 * ── One deadline, said once (1.4.83) ──
 *
 * This used to print two clocks for the same moment and let them disagree. The
 * server's `status_detail` arrived with "…automatic escalation at 00:00."
 * already baked into it — a time scraped out of GenStudio's own prose by an
 * unanchored pattern, in GenStudio's timezone — and then this function appended
 * a second sentence built from `stall_recovery_at`, the real timestamp for that
 * same deadline, in the reader's timezone. A customer saw both, side by side,
 * hours apart.
 *
 * The scrape is gone (see `customerSafeRemoteDetail`). The deadline is stated
 * here, once, from the timestamp — and `formatTime` is the same helper every
 * other time on this page goes through, so it is in the reader's timezone like
 * all of them. Where there is no timestamp, no time is claimed.
 */
function genStudioStatusDetail(job: RJob): string {
  const remote = [...(job.genstudio_jobs || [])].reverse().find(item => item.status_detail || item.failure_detail)
  if (!remote) return ''
  const detail = customerJobText(remote.status_detail || remote.failure_detail || '', job)
  if (remote.retry_at) return `${detail} Retry ${formatTime(remote.retry_at)}.`
  if (remote.retry_after_seconds === 0) return `${detail} Retry is available now.`
  if (typeof remote.retry_after_seconds === 'number' && remote.retry_after_seconds > 0) {
    return `${detail} Retry in ${Math.ceil(remote.retry_after_seconds)} seconds.`
  }
  if (remote.stall_recovery_at) return `${detail} GenStudio will step in ${formatTime(remote.stall_recovery_at)}.`
  return detail
}

function genStudioNumeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function genStudioCreditState(remote: NonNullable<RJob['genstudio_jobs']>[number]): string {
  return String(remote.queue_state || remote.state || '').toLowerCase()
}

/**
 * Authoritative settlement, merged from GenStudio's own account-jobs history.
 *
 * Account history publishes the full settlement triad. Image and Video jobs
 * can also publish a direct released reservation; never compute one locally.
 */
type GenStudioSettlement = { reserved_credits?: number; settled_credits?: number; released_credits?: number }
const genStudioSettlement = ref<Record<string, GenStudioSettlement>>({})
let settlementFetched = false

function genStudioSettled(
  remote: NonNullable<RJob['genstudio_jobs']>[number],
): GenStudioSettlement {
  const accountJob = genStudioSettlement.value[remote.id]
  const released = remote.released_credits
    ?? accountJob?.released_credits
  return {
    reserved_credits: remote.reserved_credits ?? accountJob?.reserved_credits,
    settled_credits: remote.settled_credits ?? accountJob?.settled_credits,
    ...(released !== undefined ? { released_credits: released } : {}),
  }
}

function genStudioTerminalFailure(remote: NonNullable<RJob['genstudio_jobs']>[number]): boolean {
  const state = genStudioCreditState(remote)
  return state === 'failed' || state === 'cancelled'
}

function genStudioChargedCredits(remote: NonNullable<RJob['genstudio_jobs']>[number]): number {
  return genStudioNumeric(genStudioSettled(remote).settled_credits)
}

function genStudioReturnedCredits(remote: NonNullable<RJob['genstudio_jobs']>[number]): number {
  return genStudioNumeric(genStudioSettled(remote).released_credits)
}

/**
 * Credits genuinely on hold. Only a reservation GenStudio published counts;
 * defaulting to `credit_cost` is what made settled and failed jobs keep
 * reporting "on hold 13 credits" days after GenStudio released them.
 */
function genStudioHeldCredits(remote: NonNullable<RJob['genstudio_jobs']>[number]): number {
  if (genStudioChargedCredits(remote) > 0 || genStudioReturnedCredits(remote) > 0) return 0
  if (genStudioTerminalFailure(remote)) return 0
  return genStudioNumeric(genStudioSettled(remote).reserved_credits)
}

/**
 * One read-only pull of GenStudio's account history so released reservations
 * can be shown as released. Best-effort: no key, no network, or no permission
 * simply leaves the per-job values as GenStudio published them.
 */
async function refreshGenStudioSettlement(): Promise<void> {
  if (settlementFetched) return
  settlementFetched = true
  try {
    const snapshot = await get<{ jobs?: { items?: Array<{ id: string } & GenStudioSettlement> } }>(
      '/app-settings/genstudio/usage',
      { cache: 'no-store' },
    )
    const merged: Record<string, GenStudioSettlement> = {}
    for (const item of snapshot?.jobs?.items || []) {
      if (!item?.id) continue
      merged[item.id] = {
        reserved_credits: item.reserved_credits,
        settled_credits: item.settled_credits,
        released_credits: item.released_credits,
      }
    }
    genStudioSettlement.value = merged
  } catch { /* settlement stays as GenStudio published it per job */ }
}

// Jobs stream in after mount, so pull settlement the first time this view
// actually has remote GenStudio items to explain.
watch(jobs, (list) => {
  if (!settlementFetched && list.some((j: RJob) => j.genstudio_jobs?.length)) {
    void refreshGenStudioSettlement()
  }
}, { immediate: true })

// ── Measured progress speed ───────────────────────────────────────────────
//
// The job contract carries no per-item timestamps and no per-item rate, so
// the only way to know how fast a run is going is to watch it. Every SSE
// update (or poll refresh) replaces the jobs array, which fires this watcher;
// each running job's `completed` count is sampled against the wall clock and
// the window does the arithmetic (see composables/useJobEta.ts).
//
// In memory, for this session only, and deliberately: it is a measurement of a
// run in flight, not a fact about the job worth persisting. A plain Map rather
// than a ref because nothing renders from it directly — the ETA and freshness
// lines are recomputed off the one-second `now` ticker, which is reactive.
const etaSamples = new Map<string, EtaSample[]>()
watch(jobs, (list) => {
  const at = Date.now()
  for (const job of list as RJob[]) {
    if (job.status !== 'running' || !job.item_progress) continue
    etaSamples.set(job.job_id, recordEtaSample(
      etaSamples.get(job.job_id),
      { at, completed: job.item_progress.completed },
    ))
  }
}, { immediate: true })

function jobCounts(job: RJob) {
  return summariseJobItems(job.item_progress)
}

/**
 * Finished multi-item jobs, the only source of a per-item cadence.
 *
 * This is the history the page already holds, not a table: a job type with no
 * finished runs behind it simply has no cadence, and every derived number that
 * depends on one is then withheld rather than invented.
 */
const cadenceHistory = computed(() =>
  jobs.value.filter((j: RJob) => j.status === 'done' && !!j.started_at && !!j.finished_at))

function jobCadenceSeconds(job: RJob): number | null {
  return medianSecondsPerItem(cadenceHistory.value, job.type)
}

/** "~4 min left". Absent whenever the evidence cannot support one. */
function jobEta(job: RJob): string | null {
  if (job.status !== 'running') return null
  return formatEtaApprox(estimateSecondsRemaining({
    remaining: jobCounts(job).remaining,
    nowMs: now.value,
    window: etaSamples.get(job.job_id),
    history: cadenceHistory.value,
    type: job.type,
  }))
}

function jobLastProgressAt(job: RJob): number | null {
  return lastProgressAt(etaSamples.get(job.job_id), job.genstudio_jobs)
}

/** "last progress: 40s ago" — withheld entirely when nothing has happened. */
function jobFreshness(job: RJob): string | null {
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return null
  return describeFreshness(jobLastProgressAt(job), now.value)
}

/**
 * Quiet becomes abnormal at a multiple of the cadence this job class has been
 * MEASURED at — never at a written-down number of minutes. A class with no
 * measured cadence is never called stale.
 */
function jobProgressStale(job: RJob): boolean {
  if (job.status !== 'running') return false
  return isProgressStale(jobLastProgressAt(job), now.value, jobCadenceSeconds(job))
}

function jobExceptions(job: RJob) {
  return describeJobExceptions(job, now.value)
}

// ── Money, summarised ─────────────────────────────────────────────────────
// Three figures across the whole job. The per-item breakdown lives in the
// ledger inside Technical details.
function jobChargedCredits(job: RJob): number {
  return (job.genstudio_jobs || []).reduce((sum, remote) => sum + genStudioChargedCredits(remote), 0)
}
function jobHeldCredits(job: RJob): number {
  return (job.genstudio_jobs || []).reduce((sum, remote) => sum + genStudioHeldCredits(remote), 0)
}
function jobReturnedCredits(job: RJob): number {
  return (job.genstudio_jobs || []).reduce((sum, remote) => sum + genStudioReturnedCredits(remote), 0)
}

// Which card's Technical-details drawer is mounted. One at a time, as the old
// ad-hoc output expander was: `AdvancedDisclosure` renders its slot with
// `v-show`, so leaving every drawer built would keep every job's full log and
// ledger in the DOM on a page that lists ten of them.
const expanded = ref<string | null>(null)
function setTechnicalOpen(jobId: string, open: boolean) {
  if (open) expanded.value = jobId
  else if (expanded.value === jobId) expanded.value = null
}
const errorExpanded = ref<string | null>(null)
// Persistent per-job repair result so the user can see WHICH cards they've
// repaired and the outcome (the toast is transient; the card stays red).
const repairOutcome = ref<Record<string, { text: string; kind: string }>>({})
// v1.4.32 — the same repair, kept as NUMBERS rather than as the sentence above.
// "Retry all" decides from this, and a decision about spending money must not be
// made by parsing a chip string back into a state.
//
// Persisted, deliberately. Left in memory it would be forgotten on every reload,
// and every repairable failed job would then look "never repaired" — safe, but
// it makes the button useless in the ordinary case of repairing a batch, closing
// the app, and coming back. It is the same knowledge either way.
const REPAIR_STATE_KEY = 'story-studio:repair-state:v1'
const repairState = ref<Record<string, RepairRecord>>(loadRepairState())
function loadRepairState(): Record<string, RepairRecord> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(REPAIR_STATE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}
function setRepairState(jobId: string, record: RepairRecord | null) {
  const next = { ...repairState.value }
  if (record) next[jobId] = record
  else delete next[jobId]
  repairState.value = next
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(REPAIR_STATE_KEY, JSON.stringify(next))
  } catch { /* a full or disabled store costs us the persistence, never the run */ }
}
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

// Surface the durable Story-side queue hold and keep its status synchronized
// across project and universal Jobs views.
const net = useNetworkStatus()
const queuePaused = ref(false)
const resumingQueue = ref(false)
const changingQueueState = ref(false)
let queueTimer: ReturnType<typeof setInterval> | null = null
const genStudioAdmission = ref<GenStudioAdmissionSnapshot | null>(null)
const verifiedGenStudioAdmission = computed(() => isVerifiedLiveCapacity(genStudioAdmission.value, now.value))

async function checkQueuePaused(): Promise<void> {
  try {
    const r = await get<{ paused: boolean }>('/system/queue/status')
    queuePaused.value = !!r.paused
  } catch { /* backend unreachable — leave the last-known value */ }
}

async function refreshGenStudioCapacity(): Promise<void> {
  try {
    genStudioAdmission.value = await get<GenStudioAdmissionSnapshot>('/app-settings/genstudio/admission')
  } catch {
    // Generation remains safe: the backend scheduler uses its conservative
    // fallback while the last visible account snapshot stays on screen.
  }
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

async function pauseQueue(): Promise<void> {
  changingQueueState.value = true
  try {
    await post('/system/queue/pause', {})
    await checkQueuePaused()
    success('Queue paused. Waiting jobs will not be submitted.')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to pause the queue')
  } finally {
    changingQueueState.value = false
  }
}

onMounted(() => {
  void genStudioModels.refresh()
  timer = setInterval(() => now.value = Date.now(), 1000)
  void checkQueuePaused()
  void refreshGenStudioCapacity()
  queueTimer = setInterval(() => {
    void checkQueuePaused()
    void refreshGenStudioCapacity()
  }, 5000)
})
onUnmounted(() => {
  if (isUniversal.value) universalQueue.stop()
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
  interruptedJobs.value.filter((j: RJob) => jobCanBeRepaired(j))
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

// v1.0.x — bulk "Repair all failed": every failed/cancelled job whose type has
// a repair path (audio/images/video). Free (poll + download only, never
// re-submits), so it's the safe "recover everything the providers already
// finished" one-click. Genuinely-missing items stay failed for a later Retry.
const repairingAllFailed = ref(false)
const repairableFailedJobs = computed(() =>
  jobs.value.filter((j: RJob) => (j.status === 'error' || j.status === 'cancelled') && jobCanBeRepaired(j))
)
async function repairAllFailed() {
  const snapshot = [...repairableFailedJobs.value]
  if (snapshot.length === 0) return
  repairingAllFailed.value = true
  try {
    const CONCURRENCY = 3
    let cursor = 0
    async function worker() {
      while (cursor < snapshot.length) {
        const idx = cursor++
        if (idx >= snapshot.length) return
        try { await repairJobOnly(snapshot[idx]!) }
        catch (e: any) { console.warn('[repair-all-failed] repair failed:', e?.message || e) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, snapshot.length) }, () => worker()))
    success('Repair-all finished. Cards show each result; anything still failed needs a Retry (regenerate).')
  } finally {
    repairingAllFailed.value = false
  }
}

// ── Retry all ─────────────────────────────────────────────────────────────
// v1.4.32 — the owner's design, agreed 2026-08-22: two buttons he presses
// himself rather than one that chains. The chain is the thing that already
// burned him — v1.0.114 removed "Repair & Retry all" after its repair half
// failing and its retry half firing anyway produced real duplicate charges.
//
// So this button is always clickable and never repairs. It sorts what is
// failed into three piles and resubmits only the pile whose state is
// definitely known. Everything it declines is named, with the reason, so
// declining is visible rather than silent.
//
// Rejected on the way here, with reasons: a confirmation popup (gets clicked
// through, and cannot tell "proved missing" from "never checked"); a global
// grey-out until a repair has run (wrong for the 32 job types that have no
// repair path at all, subtitles among them).
const retryingAllFailed = ref(false)
const failedJobsForRetryAll = computed(() =>
  jobs.value.filter((j: RJob) => j.status === 'error' || j.status === 'cancelled')
)
const retryAllTriage = computed(() => triageFailedJobsForRetryAll(
  failedJobsForRetryAll.value as RJob[],
  (j: RJob) => jobCanBeRepaired(j),
  (jobId: string) => repairState.value[jobId],
))
const retryAllTooltip = computed(() => describeRetryAllTriage(retryAllTriage.value as any))

async function retryAllFailed() {
  const triage = retryAllTriage.value
  if (triage.retry.length === 0) {
    // Never silently do nothing. If everything is held back, say so and point
    // at the free action that would unblock it.
    if (triage.blocked.length > 0) {
      info(describeRetryAllTriage(triage as any))
    } else if (triage.alreadyComplete.length > 0) {
      success('Nothing to retry — every failed job already had its files on disk after a repair. You can dismiss them.')
    } else {
      info('Nothing failed that can be retried.')
    }
    return
  }
  const snapshot = [...triage.retry] as RJob[]
  retryingAllFailed.value = true
  info(describeRetryAllTriage(triage as any))
  try {
    // Bounded the same way Repair-all is. Posting is not running — each retry
    // enqueues a job and the queue paces execution (the episode lane is bounded
    // at 2 since 1.4.27, the writing lane at 8), which is what stops a repeat of
    // the 30-episodes-at-once flood of 2026-08-22. This cap only stops us
    // firing thirty HTTP requests in the same tick.
    const CONCURRENCY = 3
    let cursor = 0
    let failures = 0
    async function worker() {
      while (cursor < snapshot.length) {
        const idx = cursor++
        if (idx >= snapshot.length) return
        const target = snapshot[idx]!
        try {
          await retryJob(target)
          // The repair we knew about belonged to the run that just failed. Once
          // it is re-queued that knowledge is stale, so it is dropped rather
          // than left to license a second retry later.
          setRepairState(target.job_id, null)
        } catch (e: any) {
          failures++
          console.warn('[retry-all] retry failed:', e?.message || e)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, snapshot.length) }, () => worker()))
    if (failures > 0) showError(`${failures} of ${snapshot.length} retries could not be sent. The rest went to the queue.`)
    // retryJob surfaces its own per-job errors, so this says what was SENT
    // rather than claiming everything was accepted.
    else success(`Sent ${snapshot.length} job(s) to the queue. It runs them at its own pace; any that were refused say so on their card.`)
  } finally {
    retryingAllFailed.value = false
  }
}

// The aggregator handles "no batch / still mid-flight" by returning null,
// which the banner treats as "don't render". This keeps the template
// trivial and the aggregation logic pure / unit-testable.
const batchSummary = computed(() => buildLatestBatchSummary(jobs.value as readonly Job[]))
const showBulkFinishedBanner = computed(() => {
  if (isUniversal.value || bulkBannerDismissed.value) return false
  return batchSummary.value !== null
})

// "Review failures" filters the History tab to `error`-status jobs from
// this batch so the operator can scan each failed job's full error body
// and decide on retry. Uses the existing filter/sort machinery further
// down; we just flip activeFilter to a synthetic "errors" bucket and
// rely on historyJobs already listing everything.
function reviewFailures() {
  activeFilter.value = 'all'
  statusFilter.value = 'error'
  failureBatchFilter.value = batchSummary.value?.batch_id || null
  currentPage.value = 1
  nextTick(() => {
    historyHeading.value?.focus()
    historySection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

// ── Type labels ─────────────────────────────────────────────────────────

// Display label per job type. Every executor registered in
// `electron/server/boot/executors.ts` should appear here — otherwise the
// Jobs page renders the raw type string (e.g. `video_assembly`) which
// reads as a database key, not a feature name.
const JOB_TYPE_LABELS: Record<string, string> = {
  idea_campaign: 'Idea Campaign',
  'script-only': 'Script (chapters)',
  'introduction-only': 'Introduction',
  'chapter-only': 'Chapter regen',
  outline_only: 'Script outline',
  expand_chapters: 'Chapter expansion',
  image_prompts: 'Prompts',
  images: 'Images (All)',
  scene_images: 'Scene Images',
  thumb_images: 'Thumbnail Images',
  images_repair: 'Image Repair',
  audio: 'Audio',
  audio_merge: 'Audio Merge',
  metadata: 'Metadata',
  video: 'AI Video',
  video_assembly: 'Video Assembly',
  subtitles_transcribe: 'Subtitles',
  research_run: 'Research',
  scene_plan_run: 'Scene Plan prompts',
  contextual_cues: 'Contextual Cues',
  scene_image_generate: 'Scene image',
  scene_images_batch: 'Scene Review images',
  scene_clip_generate: 'Motion clip',
  scene_clips_batch: 'Motion Review clips',
  continuity_render: 'Scene Review images',
  composition_generate: 'Image composition',
  expression_markup: 'Expression markup',
  image_pool_generate: 'Image pool',
  youtube_upload: 'YouTube upload',
  youtube_playlist_update: 'YouTube playlist',
  youtube_thumbnail_refresh: 'YouTube thumbnail',
  broll_normalize: 'B-roll normalize',
  broll_select: 'B-roll selection',
  broll_assemble: 'B-roll assembly',
  broll_autotag: 'B-roll tags',
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
const projectScopedJobs = computed(() => {
  if (!isUniversal.value || projectFilter.value === 'all') return jobs.value
  return jobs.value.filter(job => job.project_slug === projectFilter.value)
})
// v1.0.x — status filter (independent of the type tabs). 'all' | running | queued | error | done | cancelled.
const statusFilter = ref<'all' | 'running' | 'queued' | 'error' | 'done' | 'cancelled'>('all')
const failureBatchFilter = ref<string | null>(null)
const historySection = ref<HTMLElement | null>(null)
const historyHeading = ref<HTMLElement | null>(null)
const STATUS_FILTERS: Array<{ key: typeof statusFilter.value; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'error', label: 'Failed' },
  { key: 'done', label: 'Done' },
  { key: 'cancelled', label: 'Cancelled' },
]
const statusFilters = computed(() => STATUS_FILTERS.map(s => ({
  ...s,
  count: s.key === 'all'
    ? projectScopedJobs.value.length
    : projectScopedJobs.value.filter(j => j.status === s.key).length,
})))

// Filter tabs at the top of the Jobs page. Order matches the production
// pipeline so a user scanning left-to-right sees the same flow as the
// sidebar nav. Every executor in `electron/server/boot/executors.ts`
// must have a tab here — otherwise jobs of that type are reachable only
// via the "All" tab, which makes long video-assembly runs (and other
// slow jobs) hard to track.
const filterTabs = computed(() => {
  const types = [
    { type: 'all',                  label: 'All' },
    { type: 'idea_campaign',        label: 'Ideas' },
    { type: 'script-only',          label: 'Scripts' },
    { type: 'introduction-only',    label: 'Introductions' },
    { type: 'chapter-only',         label: 'Chapter Regen' },
    { type: 'research_run',         label: 'Research' },
    { type: 'metadata',             label: 'Metadata' },
    { type: 'image_prompts',        label: 'Prompts' },
    { type: 'scene_plan_run',       label: 'Scene Plan' },
    { type: 'contextual_cues',       label: 'Contextual Cues' },
    { type: 'scene_images',         label: 'Scene Images' },
    { type: 'continuity_render',    label: 'Scene Review' },
    { type: 'scene_images_batch',   label: 'Scene Review Batch' },
    { type: 'thumb_images',         label: 'Thumb Images' },
    { type: 'images',               label: 'Images (All)' },
    { type: 'images_repair',        label: 'Image Repair' },
    { type: 'video',                label: 'AI Video' },
    { type: 'scene_clips_batch',    label: 'Motion Review' },
    { type: 'audio',                label: 'Audio' },
    { type: 'audio_merge',          label: 'Audio Merge' },
    { type: 'video_assembly',       label: 'Video Assembly' },
    { type: 'subtitles_transcribe', label: 'Subtitles' },
    { type: 'youtube_upload',       label: 'YouTube' },
  ]
  return types.map(t => ({
    ...t,
    count: t.type === 'all'
      ? projectScopedJobs.value.filter(j => j.status === 'running' || j.status === 'queued').length
      : projectScopedJobs.value.filter(j => j.type === t.type && (j.status === 'running' || j.status === 'queued')).length,
  }))
})

const filterLabel = computed(() => filterTabs.value.find(t => t.type === activeFilter.value)?.label || '')

const emptyTitle = computed(() => activeFilter.value === 'all' ? 'No jobs yet' : `No ${filterLabel.value} jobs`)
const emptyMessage = computed(() => activeFilter.value === 'all'
  ? (isUniversal.value
      ? 'Jobs from every project appear here automatically as soon as they are queued.'
      : 'Start generating scripts, images, or audio to see this project’s background jobs here.')
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
  { key: 'project_slug', label: 'Project' },
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
  return filterJobsForView(projectScopedJobs.value, {
    type: activeFilter.value,
    status: statusFilter.value,
    project: 'all',
    batch: failureBatchFilter.value,
  })
})

const sortedJobs = computed(() => {
  const list = [...filteredJobs.value]
  const dir = sortDir.value === 'asc' ? 1 : -1

  list.sort((a, b) => {
    if (sortKey.value === 'duration') {
      return (getJobDurationMs(a) - getJobDurationMs(b)) * dir
    }
    if (sortKey.value === 'status') {
      const order: Record<string, number> = { running: 0, paused: 1, queued: 2, error: 3, done: 4, cancelled: 5 }
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
  const list = sortedJobs.value.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'paused')
  // Pin running ahead of queued regardless of the user's sort-column pick.
  // The chosen sort still governs order WITHIN each group (stable sort
  // preserves sortedJobs's relative order for ties). This keeps the Active
  // section reading top-to-bottom as "what's executing now" → "what's next".
  return list.slice().sort((a, b) => {
    const rank = (s: string) => s === 'running' ? 0 : s === 'paused' ? 1 : 2
    return rank(a.status) - rank(b.status)
  })
})
const historyJobs = computed(() =>
  sortedJobs.value.filter(j => j.status !== 'running' && j.status !== 'queued' && j.status !== 'paused')
)
const historyTotalPages = computed(() =>
  Math.max(1, Math.ceil(historyJobs.value.length / PAGE_SIZE))
)
const paginatedHistory = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return historyJobs.value.slice(start, start + PAGE_SIZE)
})

// Reset page when either filter changes
watch(activeFilter, () => { currentPage.value = 1 })
watch(statusFilter, () => { currentPage.value = 1 })
watch(projectFilter, () => { currentPage.value = 1 })

// v1.2.9 — count what the button will actually clear. `clearFinished` skips a
// finished job whose provider evidence is still unsettled, so counting by
// status alone promised "Clear finished (1)" and then reported clearing zero,
// with the row still sitting there. A job is clearable exactly when the server
// says its history can be removed, and the server already tells us that.
const finishedCount = computed(() =>
  jobs.value.filter(j => ['done', 'error', 'cancelled'].includes(j.status)
    && jobControls(j).some(c => c.enabled && c.action === 'clear-history')).length
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

/**
 * A job timestamp always says WHICH DAY it belongs to.
 *
 * This was `toLocaleTimeString` alone, so yesterday's 09:14 and this morning's
 * 09:14 rendered identically — the list could not be read across a date
 * boundary at all. Today and yesterday get a word (shorter than a date and
 * unambiguous at a glance); anything older gets its real date, with the year
 * once the job is from a different one.
 */
function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const today = new Date(now.value)
  const daysAgo = Math.round((startOfLocalDay(today) - startOfLocalDay(d)) / 86_400_000)
  if (daysAgo === 0) return `Today ${time}`
  if (daysAgo === 1) return `Yesterday ${time}`
  const date = d.toLocaleDateString([], d.getFullYear() === today.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' })
  return `${date} ${time}`
}

function firstErrorLine(err: string): string {
  const line = (err || '').split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
  return line.length > 240 ? line.slice(0, 237) + '…' : line
}

function jobProgress(job: RJob): number | null {
  if (job.progress == null) return null
  const value = Number(job.progress)
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

const youtubeProgressHelp = 'Overall YouTube job progress. Video bytes account for the first 85%; thumbnail, metadata, playlist, and the durable upload record complete the remaining work.'

function youtubeProgressLabel(job: RJob): string {
  const progress = jobProgress(job) ?? 0
  if (job.bytes_total && (job.bytes_done ?? 0) < job.bytes_total) return 'Uploading video to YouTube'
  if (progress < 85) return 'Preparing resumable YouTube upload'
  if (progress < 95) return 'Applying thumbnail and metadata'
  if (progress < 100) return 'Saving YouTube upload record'
  return 'YouTube upload complete'
}

type JobItemAttempt = NonNullable<RJob['item_progress']>['active'][number]

/**
 * One line for one in-flight item. A backoff shows the seconds left so the
 * pause visibly ticks down instead of looking frozen.
 */
function itemAttemptText(item: JobItemAttempt): string {
  if (item.state !== 'waiting_retry') return `${item.label} — running`
  const remaining = item.retry_at
    ? Math.max(0, Math.round((new Date(item.retry_at).getTime() - now.value) / 1000))
    : 0
  return `${item.label}: ${item.reason || WAITING_FALLBACK_REASON};`
    + ` retrying${remaining ? ` in ${remaining}s` : ' now'}`
    + ` (attempt ${item.attempt + 1} of ${item.max_attempts})`
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
  // A run that finished but discarded requested output outranks any success
  // line. Without this a degraded render collapsed to a plain "Completed in
  // 12m" card, so a video missing its cues and subtitles looked identical to
  // a clean one unless the user expanded the full log.
  const degraded = (job as any).result?.degraded
  if (degraded?.dropped?.length) {
    return `⚠ Completed WITHOUT: ${degraded.dropped.join(', ')} — recovered via ${degraded.tier}`
  }
  // Look for the last meaningful summary line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (line.includes('generated successfully') || line.includes('All images') ||
        line.includes('All audio') || line.includes('saved to') ||
        line.includes('Completed') || line.includes('tagged')) {
      return customerJobText(line, job)
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

const controlBusy = ref(new Set<string>())

type JobControl = NonNullable<RJob['control']>

function jobControls(job: RJob): JobControl[] {
  return (job.controls?.length ? job.controls : (job.control ? [job.control] : []))
    .filter(control => control.action !== 'none')
}

function primaryJobControl(job: RJob): JobControl | null {
  return job.status === 'paused' ? null : primaryControl(jobControls(job))
}

function secondaryJobControls(job: RJob): JobControl[] {
  return job.status === 'paused' ? jobControls(job) : secondaryControls(jobControls(job))
}

function jobIdentifiers(job: RJob): string[] {
  return [
    job.job_id,
    ...(job.genstudio_jobs || []).map(remote => remote.id),
    ...Object.values(job.remote_cancellations || {}).map(record => record.provider_job_id),
  ].filter(Boolean)
}

function customerJobText(value: unknown, job: RJob): string {
  return customerSafeJobText(value, jobIdentifiers(job))
}

async function runJobControl(job: RJob, requestedControl?: JobControl) {
  const control = requestedControl || job.control
  if (!control?.enabled || controlBusy.value.has(job.job_id)) return
  // v1.2.8 — the one control on this page that cannot be undone by clicking it
  // again. The dialog is populated from the backend's own wording (the pattern
  // already proven on Scene Review), so what the server promises and what the
  // user agrees to cannot drift apart.
  if (control.action === 'force-abandon') {
    const { ask } = useConfirm()
    if (!await ask({
      title: `Abandon ${job.title || job.type}?`,
      message: control.reason,
      confirmLabel: 'Abandon this job',
    })) return
  }
  controlBusy.value = new Set(controlBusy.value).add(job.job_id)
  try {
    if (control.action === 'force-abandon') {
      await post(`${jobQueuePath(job)}/abandon`, {})
      success('Abandoned. The queue has moved on — use Retry on this row to run the step again.')
      return
    } else if (control.action === 'cancel-before-submit' || control.action === 'stop-local' || control.action === 'request-remote-cancel') {
      await post(`${jobQueuePath(job)}/cancel`, {})
      // Say it in work, not in job states: "Cancelling 16 queued items —
      // credits for unstarted work are released." The action name and the
      // server's own reason are still on the button's tooltip and in the
      // reason line under the card for anyone who wants them.
      success(describeCancellation(job))
      return
    } else if (control.action === 'pause-submissions') {
      await post(`${jobQueuePath(job)}/pause`, {})
    } else if (control.action === 'clear-history') {
      await del(jobQueuePath(job))
    } else if (control.action === 'recheck-provider-status') {
      // v1.2.6 — this button actually asks GenStudio. The refreshed control
      // arrives with the response, so the answer replaces the question rather
      // than leaving the row describing a check that never ran.
      const response = await post<{ job?: RJob }>(`${jobQueuePath(job)}/recheck-provider-status`, {})
      const refreshed = response?.job?.control
      success(refreshed?.action === 'clear-history'
        ? 'GenStudio confirmed this job\'s provider work has finished. This history can now be removed.'
        : customerJobText(refreshed?.reason || control.reason, job))
      return
    } else {
      return
    }
    success(control.action === 'clear-history' ? 'Removed from history. Files and provider evidence stay intact.' : `${control.label} requested. ${customerJobText(control.reason, job)}`)
  } catch (e: any) {
    showError(customerJobText(e?.data?.detail || `Failed to ${control.label.toLowerCase()}`, job))
  } finally {
    const next = new Set(controlBusy.value)
    next.delete(job.job_id)
    controlBusy.value = next
  }
}

async function resumeJob(job: RJob) {
  try {
    await post(`${jobQueuePath(job)}/resume`, {})
    success('Job resumed. Saved and accepted work will be reclaimed first.')
  } catch (e: any) {
    showError(customerJobText(e?.data?.detail || 'Failed to resume job', job))
  }
}

function jobProjectSlug(job: Pick<RJob, 'project_slug'>): string {
  return job.project_slug || slug.value
}

function jobQueuePath(job: Pick<RJob, 'project_slug' | 'job_id'>): string {
  return jobProjectSlug(job) === '_app_'
    ? `/jobs/all/${job.job_id}`
    : `/projects/${jobProjectSlug(job)}/jobs/${job.job_id}`
}

/**
 * The job types for which "Recover this episode" can actually recover
 * something.
 *
 * v1.4.43 — this used to be the inverse: offered on EVERY errored job the
 * per-job Repair did not cover. That made it a button which, on most rows,
 * could only ever navigate away and report "nothing to recover":
 *
 *   • Scene Plan produces TEXT. The repair machinery reads audio chunks and
 *     image files. There has never been anything for it to pull back.
 *   • Scene Review writes `<scene-id>.png` from the scene PLAN. The audit
 *     reads `EPxxxx_SceneNN_v*.png` from the retired scene-prompts document,
 *     so it cannot see a single file Scene Review has ever written.
 *
 * Both of those are the jobs the owner was looking at when he pressed it, and
 * both sent him to a whole-library scan that could not have helped:
 * *"it didn't fix the one error but brings me here and run a channel wide
 * hunt. waste of time."*
 *
 * So it is now an allow-list of the assembly steps that fail BECAUSE an
 * upstream media file is missing — the one case where pulling the episode's
 * already-paid-for output back from provider history is the fix. Everything
 * else keeps Retry, which for Scene Review is itself a free recovery (it
 * replays the task manifest before it re-submits anything).
 */
const EPISODE_RECOVERY_TYPES = new Set(['audio_merge', 'video_assembly'])

function episodeRecoveryLink(job: RJob): string | null {
  if (job.status !== 'error' && job.status !== 'cancelled') return null
  if (jobCanBeRepaired(job)) return null
  if (!EPISODE_RECOVERY_TYPES.has(job.type)) return null
  const project = jobProjectSlug(job)
  if (!project || project === '_app_' || !job.episode_id) return null
  return `/projects/${project}/board?repair=1&episode=${encodeURIComponent(job.episode_id)}`
}

/**
 * The Repair link for the batch-finished banner: scoped to the episodes that
 * actually failed, because the banner already knows every one of them.
 * Falls back to the library-wide scan only when it somehow knows none.
 */
const batchRepairLink = computed(() => {
  const codes = Array.from(new Set(
    (batchSummary.value?.failed_episodes || [])
      .map(fe => fe.episode_id)
      .filter((code): code is string => typeof code === 'string' && !!code),
  ))
  const scope = codes.map(code => `&episode=${encodeURIComponent(code)}`).join('')
  return `/projects/${slug.value}/board?repair=1${scope}`
})

function hasPendingCancellation(job: RJob): boolean {
  return Object.values(job.remote_cancellations || {}).some(record =>
    ['queued', 'submitting', 'requested', 'reconciling', 'unknown'].includes(record.status),
  )
}

// v1.0.114 — The endpoints that recover already-completed work from the
// provider WITHOUT submitting any new tasks. Shared by both:
//   • repairJobOnly() — Repair button on the Jobs page (this file)
//   • retryJob() — the legacy combined Repair-then-Retry path
// Sync repair returns the reconciliation result in the POST response;
// queued repair returns a job_id we must poll until terminal before
// considering the repair "done" (otherwise the retry races it).
const REPAIR_ENDPOINTS: Record<string, { url: (projectSlug: string) => string; body: any; mode: 'sync' | 'queued' }> = {
  audio: {
    // Provider-aware since v1.0.504 — the route reconciles every chunk from
    // whatever gateway made it (GenAIPro / kie.ai / fal.ai) via the task-manifest
    // sidecar; no provider hint needed.
    url: projectSlug => `/projects/${projectSlug}/episodes/__EPISODE__/audio-repair`,
    body: {},
    mode: 'sync',
  },
  // v1.4.43 — `images` and `scene_images` were removed when the scene-image
  // generator was retired in 1.4.41. Keys for job types that can no longer
  // exist made this map look like it covered the image pipeline; it covers
  // narration and thumbnails.
  thumb_images: {
    url: projectSlug => `/projects/${projectSlug}/generate/images-repair`,
    body: { episode_id: '__EPISODE__' },
    mode: 'queued',
  },
}

function jobCanBeRepaired(jobOrType: Pick<RJob, 'type' | 'params'> | string): boolean {
  if (typeof jobOrType === 'string') return jobOrType in REPAIR_ENDPOINTS
  return jobOrType.type in REPAIR_ENDPOINTS
}

// v1.0.308 — type-aware Retry tooltip so the cost/behaviour is honest per job
// type. image_prompts now does a smart gap-fill; image/audio/video have a free
// Repair to click first; everything else re-runs whole.
function retryTooltip(job: Pick<RJob, 'type' | 'params' | 'auto_retry'>): string {
  if (job.auto_retry?.eligible) {
    return 'FREE LOCAL RETRY — The automatic attempts are exhausted or this run was stopped. Starts another bounded local retry cycle and keeps verified files already on disk. No paid API request is made.'
  }
  const jobType = job.type
  if (jobType === 'scene_plan_run') {
    return 'SMART RETRY — Keeps every prompt already verified on disk and sends only missing or duplicated stable scene IDs in bounded GenStudio packs.'
  }
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
  if (jobCanBeRepaired(job)) {
    return 'CHARGES MAY APPLY — Deletes this failed job and re-submits a fresh request. Click Repair FIRST (free — recovers in-flight provider work). The generator skips assets already on disk, so after Repair, Retry only re-submits genuinely-missing items.'
  }
  if (jobType === 'continuity_render') {
    // v1.4.43 — this said "re-runs the whole step, no repair path", which is
    // the opposite of what the generator does: it replays the stored task
    // manifest and pulls back every image the provider already produced for
    // free before it submits anything. Reading the old wording, the free
    // repair looked like the expensive option.
    return 'FREE WHERE POSSIBLE — First pulls back every scene image the provider already produced, at no charge, using the task record saved for each one. Only scenes with no recoverable result are re-submitted, and any image already on disk is left alone.'
  }
  return 'CHARGES MAY APPLY — Deletes this failed job and re-submits it. Re-runs the whole step (this job type has no partial/repair path).'
}

function autoRetryLabel(job: Pick<RJob, 'status' | 'auto_retry'>): string {
  const retry = job.auto_retry
  if (!retry?.eligible) return ''
  const attempt = Math.max(1, retry.attempt || 1)
  if (job.status === 'done' && attempt > 1) return `Recovered locally · attempt ${attempt}/${retry.max_attempts}`
  if (job.status === 'error' || retry.exhausted) return `Local retries exhausted · ${attempt}/${retry.max_attempts}`
  if (retry.next_retry_at) {
    const seconds = Math.max(0, Math.ceil((new Date(retry.next_retry_at).getTime() - now.value) / 1000))
    return `Local auto-retry · attempt ${attempt}/${retry.max_attempts} · next in ${seconds}s`
  }
  return `Local auto-retry · attempt ${attempt}/${retry.max_attempts}`
}

function autoRetryClass(job: Pick<RJob, 'status' | 'auto_retry'>): string {
  if (job.status === 'done') return 'is-recovered'
  if (job.status === 'error' || job.auto_retry?.exhausted) return 'is-exhausted'
  return 'is-active'
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
  const projectSlug = jobProjectSlug(job)
  if (projectSlug === '_app_') {
    showError('App-level jobs do not have episode assets to repair.')
    return
  }
  const url = template.url(projectSlug).replace('__EPISODE__', job.episode_id)
  const body = JSON.parse(
    JSON.stringify(template.body).replace(/__EPISODE__/g, job.episode_id)
  )

  info(`Looking for finished ${jobTypeLabel(job.type)} work for ${job.episode_id} that never arrived (no charge)…`)
  repairOutcome.value = { ...repairOutcome.value, [job.job_id]: { text: 'Looking for finished work…', kind: 'busy' } }
  try {
    const resp = await post<{
      job_id?: string
      recovered?: number
      still_missing?: number
      present_before?: number
      total_expected?: number
    }>(url, body)

    if (template.mode === 'queued' && resp?.job_id) {
      const terminal = await waitForJobTerminal(resp.job_id, 10 * 60_000, projectSlug)
      if (terminal?.result && typeof terminal.result === 'object') Object.assign(resp, terminal.result)
    }

    // v1.4.32 — read BOTH reconciler shapes. This used to look at
    // `still_missing` alone, which the image reconciler does not have: it
    // splits the same number into `needs_fresh_generation` + `unrecoverable`.
    // So for all three image job types this fell through to a bare
    // "✓ repaired" chip and threw away the one number that says whether a
    // retry is needed — the repair knew, and did not say.
    const normalised = normaliseRepairResult(resp)
    setRepairState(job.job_id, normalised
      ? { outcome: 'measured', result: normalised }
      : { outcome: 'inconclusive' })
    const recovered = normalised ? normalised.recovered : null
    const missing = normalised ? normalised.stillMissing : null
    // v1.4.82 — these say what happened to the WORK. "recovered 3 task(s)"
    // and "0 recovered, 4 left" described the recovery machinery; the person
    // reading the card wants to know how many finished pieces they now have
    // and how many are still missing.
    const piece = (n: number) => `${n} finished item${n === 1 ? '' : 's'}`
    let chip: { text: string; kind: string }
    if (recovered !== null && missing !== null) {
      if (missing === 0 && recovered > 0) {
        success(
          `Recovered ${piece(recovered)}. ` +
          `Nothing is missing — you can dismiss this job now.`
        )
        chip = { text: `Recovered ${piece(recovered)}; nothing missing — dismiss`, kind: 'ok' }
      } else if (missing === 0 && recovered === 0) {
        success(
          `Nothing was missing — everything was already saved. ` +
          `The original failure was temporary; you can dismiss this job.`
        )
        chip = { text: 'Nothing was missing — dismiss', kind: 'ok' }
      } else if (missing > 0 && recovered > 0) {
        info(
          `Recovered ${piece(recovered)}. ${missing} still missing — ` +
          `Retry re-makes only those.`
        )
        chip = { text: `Recovered ${piece(recovered)}; ${missing} still missing — Retry`, kind: 'warn' }
      } else {
        info(
          `Nothing was ready to recover; ${missing} item${missing === 1 ? '' : 's'} still missing. ` +
          `Retry re-makes only those.`
        )
        chip = { text: `Nothing to recover yet; ${missing} still missing — Retry`, kind: 'warn' }
      }
    } else {
      success(`Finished checking ${jobTypeLabel(job.type)} for ${job.episode_id}.`)
      chip = { text: 'Recovery finished', kind: 'ok' }
    }
    repairOutcome.value = { ...repairOutcome.value, [job.job_id]: chip }
  } catch (e: any) {
    showError(customerJobText(e?.data?.detail || e?.message || 'Could not check for finished work', job))
    setRepairState(job.job_id, { outcome: 'failed' })
    repairOutcome.value = { ...repairOutcome.value, [job.job_id]: { text: 'could not check — try again', kind: 'warn' } }
  }
}

async function retryJob(job: RJob) {
  // v1.4.32 — whatever a repair found belonged to the run that just failed.
  // Re-running makes it stale, so it is dropped here rather than left behind to
  // license a later Retry all.
  setRepairState(job.job_id, null)
  const projectSlug = jobProjectSlug(job)
  // These queue-owned jobs must preserve their exact durable request params.
  // Motion jobs without a saved pair are historical jobs: the executor alone
  // may select today's cheapest published option. Reposting through a fresh
  // Motion Review route would reject that legacy shape after deleting history.
  if (job.type === 'expand_chapters' || job.type === 'scene_clip_generate' || job.type === 'scene_clips_batch') {
    try {
      await post(`${jobQueuePath(job)}/retry`, {})
      success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
    } catch (e: any) { showError(customerJobText(e?.data?.detail || e?.message || 'Failed to retry job', job)) }
    return
  }
  // Every job type the queue knows about needs an entry here — otherwise
  // a failed 20-minute video-assembly becomes un-retryable with a cryptic
  // "Cannot retry job type: X" toast. When a new generator is added, this
  // map is the one frontend hook to update.
  const endpointMap: Record<string, { url: string; params: any }> = {
    // M1: legacy 'script' job type was removed. Retry now routes the two
    // independent jobs to their respective endpoints.
    'script-only':       { url: `/projects/${projectSlug}/generate/script-only`,       params: job.params },
    'introduction-only': { url: `/projects/${projectSlug}/generate/introduction-only`, params: job.params },
    'chapter-only':      { url: `/projects/${projectSlug}/generate/chapter-only`,      params: job.params },
    outline_only:        { url: `/projects/${projectSlug}/generate/outline-only`,       params: job.params },
    expand_chapters:     { url: `/projects/${projectSlug}/generate/expand-chapters`,    params: job.params },
    // v1.0.308 — image_prompts Retry is now SMART: it routes to the dedicated
    // /generate/image-prompts route with fill_gaps=true, so the generator
    // regenerates ONLY missing prompt entries for the job's mode and merges
    // them into existing files (preserving the ones that already succeeded). Previously this went
    // through pipeline/run-batch which regenerated all N from scratch.
    image_prompts:   { url: `/projects/${projectSlug}/generate/image-prompts`, params: { ...job.params, fill_gaps: true } },
    scene_images:    { url: `/projects/${projectSlug}/generate/images`,  params: { ...job.params, mode: 'scenes' } },
    thumb_images:    { url: `/projects/${projectSlug}/generate/images`,  params: { ...job.params, mode: 'thumbs' } },
    images:          { url: `/projects/${projectSlug}/generate/images`,  params: job.params },
    audio:           { url: `/projects/${projectSlug}/generate/audio`,   params: job.params },
    audio_merge:     { url: `/projects/${projectSlug}/generate/audio-merge`,    params: job.params },
    video:           { url: `/projects/${projectSlug}/generate/video`,         params: job.params },
    video_assembly:  { url: `/projects/${projectSlug}/generate/video-assembly`, params: job.params },
    images_repair:   { url: `/projects/${projectSlug}/generate/images-repair`,  params: { episode_id: job.episode_id } },
    continuity_render: {
      url: `/projects/${projectSlug}/scene-review/${job.episode_id}/continuity-render`,
      params: job.params,
    },
    scene_images_batch: {
      url: `/projects/${projectSlug}/scene-review/${job.episode_id}/continuity-render`,
      params: job.params,
    },
    scene_image_generate: {
      url: `/projects/${projectSlug}/scene-review/${job.episode_id}/generate-image`,
      params: job.params,
    },
    composition_generate: {
      url: `/projects/${projectSlug}/episodes/${job.episode_id}/img2img-references/composition/generate`,
      params: job.params,
    },
    image_pool_generate: {
      url: `/projects/${projectSlug}/image-pool/generate`,
      params: job.params,
    },
    scene_clip_generate: {
      url: `/projects/${projectSlug}/scene-review/${job.episode_id}/generate-clip`,
      params: job.params,
    },
    scene_clips_batch: {
      url: `/projects/${projectSlug}/scene-review/${job.episode_id}/generate-clips-batch`,
      params: job.params,
    },
    // Transcription uses a non-`/generate` URL because the endpoint lives
    // under /video-editor. Always heal old jobs onto the one GenStudio route;
    // preserve the remaining request identity so manual Retry fills only the
    // work that is still missing.
    subtitles_transcribe: {
      url: `/projects/${projectSlug}/video-editor/subtitles/transcribe/${job.episode_id}`,
      params: {
        language: job.params?.language,
        model: job.params?.model,
        engine: 'genstudio',
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
        `/projects/${projectSlug}/pipeline/run-batch`,
        { episode_ids: [job.episode_id], steps: [job.type], force: true },
      )
      if (!resp?.jobs?.length) {
        const reason = resp?.skipped?.[0]?.reason || 'Pipeline did not enqueue the job'
        showError(customerJobText(reason, job))
        return
      }
      await del(jobQueuePath(job))
      success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
    } catch (e: any) { showError(customerJobText(e?.data?.detail || 'Failed to retry job', job)) }
    return
  }

  const target = endpointMap[job.type]
  if (!target) {
    try {
      await post(projectSlug === '_app_' ? `/jobs/all/${job.job_id}/retry` : `/projects/${projectSlug}/jobs/${job.job_id}/retry`, {})
      success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
    } catch (e: any) {
      showError(customerJobText(e?.data?.detail || e?.message || 'Failed to retry job', job))
    }
    return
  }

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
    await del(jobQueuePath(job))
    await post(target.url, target.params)
    success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
  } catch (e: any) { showError(customerJobText(e.data?.detail || 'Failed to retry job', job)) }
}

/**
 * Poll a job until it reaches a terminal state (done / error / cancelled),
 * or the timeout fires. Used to gate retry-after-repair on the actual
 * completion of a queued image-repair job since
 * their POST returns immediately after enqueue, not after the work lands.
 *
 * Polls every 2 s — fast enough that a small repair job (5-10 s) doesn't
 * delay the retry visibly, slow enough that a large repair (a few minutes
 * downloading 100+ images) doesn't hammer the backend. Throws on timeout
 * so the caller's catch surfaces it as a non-fatal warning and continues
 * to the retry.
 */
async function waitForJobTerminal(jobId: string, timeoutMs: number, projectSlug: string): Promise<any | null> {
  const POLL_INTERVAL_MS = 2000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let job: any
    try {
      job = await $fetch(projectSlug === '_app_' ? `/api/jobs/app/${jobId}` : `/api/projects/${projectSlug}/jobs/${jobId}`)
    } catch (e: any) {
      // 404 = job already cleared (rare — would mean another tab's
      // "Clear finished" ran during the wait). Treat as terminal.
      if (e?.response?.status === 404) return null
      throw e
    }
    if (!job) return null
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  // v1.4.32 — this used to end "proceeding with retry anyway", from the
  // combined Repair-then-Retry path removed in v1.0.114. Nothing retries after
  // a repair any more, and a timed-out repair is exactly the state Retry all
  // refuses to act on.
  throw new Error(`Repair job ${jobId} did not finish within ${timeoutMs / 1000}s. Nothing was retried.`)
}

async function clearFinished() {
  // v1.4.81 — what the badge promised, captured before the call, so a clear
  // that removes nothing can say so instead of handing back a receipt for zero.
  // The owner clicked this repeatedly against "Clear finished (6)" and watched
  // six rows stay put; "Cleared 0 finished job(s)" told him nothing he could
  // act on, and nothing at all about why.
  const promised = finishedCount.value
  try {
    const result = await del<{ cleared: number }>(isUniversal.value ? '/jobs/all' : `/projects/${slug.value}/jobs`)
    if (result.cleared === 0) {
      if (promised > 0) {
        showError(
          `Nothing was cleared, though ${promised} row(s) look finished. `
          + 'Open a row and use its own button — its reason says what is still holding it.',
        )
      } else {
        success('No finished jobs to clear.')
      }
      return
    }
    success(`Cleared ${result.cleared} finished job(s)`)
  } catch (e: any) { showError(e.data?.detail || 'Failed to clear jobs') }
}
</script>

<style scoped>
.jobs-workspace { padding-bottom: 32px; }
.jobs-hero-aside {
  display: grid;
  justify-items: end;
  gap: 10px;
}
.jobs-hero-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.job-control-primary { border-color: var(--accent); color: var(--accent); }
.job-control-reason {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.job-control-reason.control-return-later { color: var(--warning); }
.job-more-actions { position: relative; }
.job-more-actions summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  list-style-position: inside;
}
.job-more-actions summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.job-more-actions-body {
  position: absolute;
  z-index: 5;
  right: 0;
  min-width: min(320px, 80vw);
  margin-top: 6px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
}
.job-more-actions-body .btn { margin-right: 4px; }
.technical-summary { margin: 0 0 8px; color: var(--text-muted); font-size: var(--font-xs); }
.genstudio-capacity-summary {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  max-width: min(720px, 100%);
}
.genstudio-capacity-summary span {
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-primary) 82%, transparent);
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.2;
  white-space: nowrap;
}
.genstudio-capacity-summary strong {
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.genstudio-capacity-summary .capacity-warning {
  border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
  color: var(--warning);
}
.genstudio-capacity-summary .capacity-error {
  border-color: color-mix(in srgb, var(--danger) 65%, var(--border));
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-primary));
  color: var(--danger);
}
.genstudio-capacity-summary .capacity-error strong {
  color: var(--danger);
}
.genstudio-capacity-summary .capacity-boost {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  color: var(--accent);
  white-space: normal;
  overflow-wrap: anywhere;
}
.genstudio-capacity-summary .capacity-next-tier {
  white-space: normal;
  overflow-wrap: anywhere;
}
.job-scope-switch {
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-primary);
}
.job-scope-switch a {
  padding: 6px 11px;
  border-radius: 7px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.job-scope-switch a.active {
  color: var(--text-primary);
  background: var(--bg-tertiary);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
}
.project-filter {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-right: 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.project-filter select {
  min-width: 190px;
  height: 31px;
  padding: 0 30px 0 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-secondary);
  color: var(--text-primary);
}
.job-project {
  max-width: 180px;
  padding: 2px 7px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 999px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-project:hover { border-color: var(--accent); }

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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs); font-weight: 700;
  padding: 1px 5px; border-radius: 8px; min-width: 16px; text-align: center;
}

/* Sort Bar */
.sort-bar {
  display: flex; align-items: center; gap: 4px; margin-top: 10px; padding: 4px 0;
}
.sort-label { font-size: var(--font-xs); margin-right: 4px; }
.sort-btn {
  padding: 3px 8px; border-radius: var(--radius-sm);
  font-size: var(--font-xs); background: none; border: 1px solid transparent;
  color: var(--text-muted); cursor: pointer; transition: all 0.15s;
}
.sort-btn:hover { color: var(--text-primary); border-color: var(--border); }
.sort-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.sort-arrow { font-size: var(--font-xs); margin-left: 2px; }

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

.jobs-list { display: flex; flex-direction: column; gap: 8px; min-width: 0; max-width: 100%; }

.job-card {
  padding: 14px 16px;
  transition: border-color 0.2s;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
.job-card.status-running { border-left: 3px solid var(--accent); }
.job-card.status-error { border-left: 3px solid var(--error); }
.job-card.status-done { border-left: 3px solid #22c55e; }
.job-card.status-queued { border-left: 3px solid var(--text-muted); }
.job-card.status-paused { border-left: 3px solid #f5c35b; }
.job-card.status-cancelled { border-left: 3px solid var(--text-muted); opacity: 0.6; }

.job-row-main {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.job-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}
.job-type { flex: 0 0 auto; font-weight: 600; font-size: 13px; color: var(--text-primary); }
.job-episode { flex: 0 0 auto; font-size: 13px; color: var(--accent); font-weight: 500; }
.job-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

/* Meta row */
.job-meta {
  display: flex; flex-wrap: wrap; gap: 4px 10px;
  margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);
}
.meta-tag { font-size: var(--font-xs); color: var(--text-muted); }
.meta-label { color: var(--text-muted); opacity: 0.7; }
.auto-retry-tag {
  padding: 2px 8px;
  border: 1px solid rgba(240, 198, 116, 0.28);
  border-radius: 999px;
  background: rgba(240, 198, 116, 0.08);
  color: var(--accent);
  font-weight: 650;
}
.auto-retry-tag.is-active { border-color: rgba(240, 198, 116, 0.42); }
.auto-retry-tag.is-recovered {
  border-color: rgba(63, 185, 80, 0.34);
  background: rgba(63, 185, 80, 0.1);
  color: var(--success, #3fb950);
}
.auto-retry-tag.is-exhausted {
  border-color: rgba(248, 81, 73, 0.38);
  background: rgba(248, 81, 73, 0.09);
  color: var(--danger, #f85149);
}

/* Account attribution row — which provider accounts this job actually used.
   Sits between the meta row and the live output so it's visible on every
   job state without scrolling. Muted by default; chips use the same green
   as the Keys-tab default indicator so the two surfaces read as one system. */
.job-accounts {
  display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center;
  margin-top: 6px;
  font-size: var(--font-xs);
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

/* The headline counts. Number first, then what it counts, in words — the row
   has to be readable at a glance by someone who is not going to read it
   twice. Tabular figures so the digits do not jump as they tick. */
.job-stats {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px;
  margin-top: 8px;
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
.job-stat { display: inline-flex; align-items: baseline; gap: 5px; color: var(--text-muted); }
.job-stat strong { color: var(--text-primary); font-size: 14px; font-weight: 650; }
.job-stat-label { color: var(--text-muted); }
.job-stat.is-inflight strong { color: var(--accent); }
.job-stat.is-finished strong { color: var(--success, #3fb950); }
.job-stat.is-muted strong { color: var(--text-muted); font-weight: 600; }
.job-stat-eta {
  margin-left: auto;
  padding: 2px 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border));
  border-radius: 999px;
  color: var(--accent);
  font-weight: 600;
  white-space: nowrap;
}
.job-stat-fresh { color: var(--text-muted); white-space: nowrap; }
.job-stat-fresh.is-stale { color: var(--warning, rgb(202, 138, 4)); font-weight: 600; }

/* Money: three figures, always the same three, always in the same order. */
.job-money {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px;
  margin-top: 8px;
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
.job-money-figure.charged { color: var(--success, #3fb950); }
.job-money-figure.held { color: var(--accent); }
.job-money-figure.returned { color: var(--text-secondary); }

/* One line per exception, in sentences. Never a list of codes. */
.job-exceptions {
  margin: 8px 0 0;
  padding: 8px 10px 8px 12px;
  list-style: none;
  border-left: 3px solid color-mix(in srgb, var(--warning, rgb(202, 138, 4)) 70%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning, rgb(202, 138, 4)) 8%, transparent);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.5;
}
.job-exceptions li + li { margin-top: 5px; }

/* Ids, inside Technical details only. */
.job-technical-ids {
  display: flex; flex-wrap: wrap; gap: 4px 12px;
  margin-top: 8px;
  overflow-wrap: anywhere;
}

.jobs-section { display: block; min-width: 0; max-width: 100%; }
.section-heading {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 0; margin-top: 6px;
  border-bottom: 1px solid var(--border);
}
.section-heading h2 { font-size: 14px; font-weight: 600; margin: 0; color: var(--text-primary); }
.section-heading h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.section-count {
  background: var(--bg-tertiary); color: var(--text-muted);
  border-radius: 999px; padding: 1px 8px;
  font-size: var(--font-xs); font-family: 'SF Mono', Monaco, monospace;
}
.live-indicator-inline {
  margin-left: auto; display: flex; align-items: center; gap: 6px;
  font-size: var(--font-xs); color: var(--accent);
}
.progress-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.progress-row > :first-child { flex: 1; min-width: 0; }
.job-items {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 6px;
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.job-items-count { color: var(--text-primary); font-weight: 500; }
.job-items-failed { color: rgb(202, 138, 4); }
.job-items-note { border-bottom: 1px dotted var(--border); cursor: help; }
.job-items-active.waiting { color: rgb(202, 138, 4); }
.genstudio-status-detail {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.45;
}

.progress-counter {
  font-size: var(--font-xs); font-family: 'SF Mono', Monaco, monospace;
  color: var(--accent); font-weight: 600; white-space: nowrap;
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

/* Raw log, inside Technical details */
.job-output {
  margin-top: 6px; background: var(--bg-primary); border-radius: var(--radius-sm);
  padding: 10px; font-size: var(--font-xs); max-height: 250px; overflow-y: auto;
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
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: var(--font-xs); color: var(--error); cursor: pointer;
  margin-top: 4px; display: inline-block;
}
.error-toggle:hover { text-decoration: underline; }
.error-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
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
.btn-xs { padding: 3px 10px; font-size: var(--font-xs); }
.status-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.status-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.status-chip { font-size: 12px; padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border, #333); background: none; color: var(--text-muted, #999); cursor: pointer; }
.status-chip:hover { border-color: var(--accent, #6ab0f3); }
.status-chip.active { background: var(--accent, #6ab0f3); color: #fff; border-color: var(--accent, #6ab0f3); }
.status-chip.active.sc-error { background: #e06c75; border-color: #e06c75; }
.status-count { margin-left: 5px; opacity: 0.8; font-variant-numeric: tabular-nums; }
.repair-all-btn { white-space: nowrap; }
/* Deliberately NOT btn-primary. Repair is free and is the one to reach for
   first; Retry spends money. The visual weight should say which is which. */
.retry-all-btn { white-space: nowrap; }
.repair-chip { font-size: var(--font-xs); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border, #333); white-space: nowrap; }
.repair-chip.rc-ok { color: #98c379; border-color: rgba(152, 195, 121, 0.4); }
.repair-chip.rc-warn { color: #e5c07b; border-color: rgba(229, 192, 123, 0.4); }
.repair-chip.rc-busy { color: var(--text-muted, #888); }
.btn-icon {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 13px; padding: 3px 6px; border-radius: 4px;
}
.btn-icon:hover { color: var(--error); background: rgba(248, 113, 113, 0.1); }

@media (max-width: 760px) {
  .jobs-hero-aside { justify-items: start; }
  .jobs-hero-actions { justify-content: flex-start; }
  .genstudio-capacity-summary { justify-content: flex-start; }
  .job-row-main { align-items: flex-start; flex-wrap: wrap; }
  .job-identity { flex-basis: 100%; }
  .job-actions { margin-left: auto; }
  .project-filter { width: 100%; }
  .project-filter select { min-width: 0; flex: 1; }
}
</style>
