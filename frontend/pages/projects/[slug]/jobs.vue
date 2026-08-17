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
          <div
            v-if="genStudioAdmission"
            class="genstudio-capacity-summary"
            aria-label="GenStudio account capacity"
          >
            <span
              v-if="genStudioAdmission.submissions_blocked"
              class="capacity-error"
              :title="genStudioAdmission.submission_block_reason || undefined"
            >
              <strong>Submissions stopped</strong>
              GenStudio release not ready
            </span>
            <span>
              <strong>{{ genStudioAdmission.local_waiting }}</strong>
              submissions waiting locally
            </span>
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
          </div>
          <div class="jobs-hero-actions">
            <button
              v-if="!queuePaused"
              class="btn btn-sm btn-secondary"
              :disabled="changingQueueState"
              @click="pauseQueue"
              title="Hold every queued Story job before submission. Running GenStudio jobs stop claiming new items after accepted work is saved."
            >Pause queue</button>
            <NuxtLink
              v-if="!isUniversal"
              :to="`/projects/${slug}/board?repair=1`"
              class="btn btn-sm btn-secondary"
              title="After a bulk pipeline run, open Repair (on the Production Board) to one-click recover any provider-completed output that didn't persist locally (no credits consumed)."
            >
              Repair assets
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

    <!-- Status Filter + bulk repair -->
    <div class="status-bar">
      <div class="status-filters">
        <button
          v-for="s in statusFilters"
          :key="s.key"
          class="status-chip"
          :class="{ active: statusFilter === s.key, [`sc-${s.key}`]: true }"
          @click="statusFilter = s.key"
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
              v-for="control in jobControls(job)"
              :key="control.action"
              class="btn btn-xs btn-secondary"
              :class="{ 'job-control-primary': control.enabled && control.action === 'pause-submissions' }"
              :disabled="!control.enabled || controlBusy.has(job.job_id)"
              :title="control.reason"
              @click="runJobControl(job, control)"
            >
              {{ controlBusy.has(job.job_id) ? 'Working…' : control.label }}
            </button>
            <button
              v-if="job.status === 'paused'"
              class="btn btn-xs btn-primary"
              @click="resumeJob(job)"
              title="Verify saved output and accepted task IDs, then continue only missing work."
            >Resume</button>
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
          <span class="meta-tag">
            <span class="meta-label">ID:</span> {{ job.job_id }}
          </span>
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
            :title="`${entry.label} · Account id: ${entry.account.id}`"
          >
            {{ entry.label }}: <strong>{{ entry.account.label }}</strong>
          </span>
        </div>

        <GenStudioBatchLedger
          v-if="isLargeGenStudioBatch(job)"
          :remote-jobs="job.genstudio_jobs!"
        />
        <template v-else-if="job.genstudio_jobs?.length">
          <div class="job-accounts genstudio-diagnostics">
            <span class="meta-label">GenStudio:</span>
            <span v-for="remote in job.genstudio_jobs" :key="remote.id" class="account-chip" :title="genStudioJobTitle(remote, job)">
              {{ remote.operation }} · <strong>{{ genStudioQueueLabel(remote) }}</strong>
              <template v-if="genStudioChargedCredits(remote) > 0"> · charged {{ genStudioChargedCredits(remote) }}</template>
              <template v-else-if="genStudioReturnedCredits(remote) > 0"> · returned {{ genStudioReturnedCredits(remote) }}</template>
              <template v-else-if="genStudioHeldCredits(remote) > 0"> · on hold {{ genStudioHeldCredits(remote) }} credits</template>
            </span>
          </div>
          <GenStudioCreditSettlementHint :remote-jobs="job.genstudio_jobs" compact />
        </template>
        <p v-if="genStudioStatusDetail(job)" class="genstudio-status-detail" role="status">
          {{ genStudioStatusDetail(job) }}
        </p>

        <!-- Row 3: Running progress / Summary -->
        <div v-if="job.status === 'running' && job.output_lines?.length" class="job-live-output">
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
          <!--
            What the job is actually working on. A percentage says how far; a
            long-running step that reports nothing else is indistinguishable
            from a hang, and that ambiguity has already produced a wrong
            diagnosis. `waiting_retry` in particular is a job doing exactly
            what it should — waiting out a provider — and must not read as
            stuck.
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
          v-if="job.status !== 'running' && hasExpandableDetail(job)"
          class="job-expand"
          @click="toggleExpand(job.job_id)"
        >
          {{ expanded === job.job_id ? 'Hide output' : 'Show output' }}
          ({{ expandSummary(job) }})
        </div>

        <template v-if="expanded === job.job_id && job.status !== 'running' && hasExpandableDetail(job)">
          <GenStudioRequestPreview v-if="job.genstudio_jobs?.length" :remote-jobs="job.genstudio_jobs" />
          <div v-if="job.output_lines?.length" class="job-output">
            <code v-for="(line, i) in job.output_lines" :key="i">{{ line }}</code>
          </div>
        </template>

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
        <p
          v-for="control in jobControls(job)"
          :key="`reason-${control.action}`"
          class="job-control-reason"
          :class="`control-${control.action}`"
          role="status"
        >
          <template v-if="hasPendingCancellation(job) && control.action === 'request-remote-cancel'">Story Studio is reconciling the cancellation result. </template>
          <template v-else-if="control.action === 'clear-history'">Removing this row does not change its files or billing records. </template>
          {{ control.reason }}
        </p>
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
            {{ control.reason }}
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

          <GenStudioBatchLedger
            v-if="isLargeGenStudioBatch(job)"
            :remote-jobs="job.genstudio_jobs!"
          />
          <template v-else-if="job.genstudio_jobs?.length">
            <div class="job-accounts genstudio-diagnostics">
              <span class="meta-label">GenStudio:</span>
              <span v-for="remote in job.genstudio_jobs" :key="remote.id" class="account-chip" :title="genStudioJobTitle(remote, job)">
                {{ remote.operation }} · <strong>{{ genStudioQueueLabel(remote) }}</strong>
                <template v-if="genStudioChargedCredits(remote) > 0"> · charged {{ genStudioChargedCredits(remote) }}</template>
                <template v-else-if="genStudioReturnedCredits(remote) > 0"> · returned {{ genStudioReturnedCredits(remote) }}</template>
                <template v-else-if="genStudioHeldCredits(remote) > 0"> · on hold {{ genStudioHeldCredits(remote) }} credits</template>
              </span>
            </div>
            <GenStudioCreditSettlementHint :remote-jobs="job.genstudio_jobs" compact />
          </template>
          <p v-if="genStudioStatusDetail(job)" class="genstudio-status-detail" role="status">
            {{ genStudioStatusDetail(job) }}
          </p>

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
            v-if="hasExpandableDetail(job)"
            class="job-expand"
            @click="toggleExpand(job.job_id)"
          >
            {{ expanded === job.job_id ? 'Hide output' : 'Show output' }}
            ({{ expandSummary(job) }})
          </div>

          <template v-if="expanded === job.job_id && hasExpandableDetail(job)">
            <GenStudioRequestPreview v-if="job.genstudio_jobs?.length" :remote-jobs="job.genstudio_jobs" />
            <div v-if="job.output_lines?.length" class="job-output">
              <code v-for="(line, i) in job.output_lines" :key="i">{{ line }}</code>
            </div>
          </template>

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
import { publicProviderLabel } from '~/composables/useModelGroups'
import { buildLatestBatchSummary, formatElapsed } from '~/composables/useBatchSummary'
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

function hasExpandableDetail(job: RJob): boolean {
  return !!job.output_lines?.length || genStudioRequestCount(job) > 0
}

function expandSummary(job: RJob): string {
  const parts: string[] = []
  const lines = job.output_lines?.length || 0
  if (lines) parts.push(`${lines} line${lines === 1 ? '' : 's'}`)
  const requests = genStudioRequestCount(job)
  if (requests) parts.push(`${requests} request${requests === 1 ? '' : 's'}`)
  return parts.join(' + ')
}

const GENSTUDIO_BATCH_THRESHOLD = 12

function isLargeGenStudioBatch(job: RJob): boolean {
  return (job.genstudio_jobs?.length || 0) >= GENSTUDIO_BATCH_THRESHOLD
}

function isTtsJob(job: RJob): boolean {
  return job.type === 'audio'
}

function jobModelDisplay(job: RJob): string {
  return genStudioModels.displayName(job.params?.model)
}

function jobModelTitle(job: RJob): string {
  const label = jobModelDisplay(job)
  const rawId = typeof job.params?.model === 'string' ? job.params.model.trim() : ''
  if (isTtsJob(job) || !rawId || label === rawId) return label
  return `${label} · Internal id: ${rawId}`
}

function genStudioJobTitle(
  remote: NonNullable<RJob['genstudio_jobs']>[number],
  job: RJob,
): string {
  const isTts = remote.operation === 'voice.tts'
  const modelLabel = remote.model_id ? genStudioModels.displayName(remote.model_id) : ''
  return [
    `Remote job: ${remote.id}`,
    modelLabel ? `Model: ${modelLabel}` : '',
    remote.model_id && !isTts && modelLabel !== remote.model_id
      ? `Internal model id: ${remote.model_id}`
      : '',
    remote.remaining_credits !== undefined ? `Balance after: ${remote.remaining_credits}` : '',
    remote.price_version ? `Price version: ${remote.price_version}` : '',
    remote.failure_code ? `Failure: ${remote.failure_code}` : '',
  ].filter(Boolean).join(' · ')
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

function genStudioStatusDetail(job: RJob): string {
  const remote = [...(job.genstudio_jobs || [])].reverse().find(item => item.status_detail || item.failure_detail)
  if (!remote) return ''
  const detail = remote.status_detail || remote.failure_detail || ''
  if (remote.retry_at) return `${detail} Retry ${formatTime(remote.retry_at)}.`
  if (remote.retry_after_seconds === 0) return `${detail} Retry is available now.`
  if (typeof remote.retry_after_seconds === 'number' && remote.retry_after_seconds > 0) {
    return `${detail} Retry in ${Math.ceil(remote.retry_after_seconds)} seconds.`
  }
  if (remote.stall_recovery_at) return `${detail} GenStudio will intervene ${formatTime(remote.stall_recovery_at)}.`
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

const expanded = ref<string | null>(null)
const errorExpanded = ref<string | null>(null)
// Persistent per-job repair result so the user can see WHICH cards they've
// repaired and the outcome (the toast is transient; the card stays red).
const repairOutcome = ref<Record<string, { text: string; kind: string }>>({})
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
  prompt_director: 'Prompt director',
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
  let list = [...projectScopedJobs.value]
  if (activeFilter.value !== 'all') {
    list = list.filter(j => j.type === activeFilter.value)
  }
  if (statusFilter.value !== 'all') {
    list = list.filter(j => j.status === statusFilter.value)
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
  return `${item.label} — ${item.reason || 'provider declined'};`
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

const controlBusy = ref(new Set<string>())

type JobControl = NonNullable<RJob['control']>

function jobControls(job: RJob): JobControl[] {
  return (job.controls?.length ? job.controls : (job.control ? [job.control] : []))
    .filter(control => control.action !== 'none')
}

async function runJobControl(job: RJob, requestedControl?: JobControl) {
  const control = requestedControl || job.control
  if (!control?.enabled || controlBusy.value.has(job.job_id)) return
  controlBusy.value = new Set(controlBusy.value).add(job.job_id)
  try {
    if (control.action === 'cancel-before-submit' || control.action === 'stop-local' || control.action === 'request-remote-cancel') {
      await post(`${jobQueuePath(job)}/cancel`, {})
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
        : refreshed?.reason || control.reason)
      return
    } else {
      return
    }
    success(control.action === 'clear-history' ? 'Removed from history. Files and provider evidence stay intact.' : `${control.label} requested. ${control.reason}`)
  } catch (e: any) {
    showError(e?.data?.detail || `Failed to ${control.label.toLowerCase()}`)
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
    showError(e?.data?.detail || 'Failed to resume job')
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
  images: {
    url: projectSlug => `/projects/${projectSlug}/generate/images-repair`,
    body: { episode_id: '__EPISODE__' },
    mode: 'queued',
  },
  scene_images: {
    url: projectSlug => `/projects/${projectSlug}/generate/images-repair`,
    body: { episode_id: '__EPISODE__' },
    mode: 'queued',
  },
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

  info(`Recovering in-flight ${jobTypeLabel(job.type)} tasks for ${job.episode_id} (no charge)…`)
  repairOutcome.value = { ...repairOutcome.value, [job.job_id]: { text: 'Repairing…', kind: 'busy' } }
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

    // Sync repair returns a useful summary; queued repair returns nothing
    // until we re-fetch the job, so we just say "done" for those.
    const recovered = typeof resp?.recovered === 'number' ? resp.recovered : null
    const missing = typeof resp?.still_missing === 'number' ? resp.still_missing : null
    let chip: { text: string; kind: string }
    if (recovered !== null && missing !== null) {
      if (missing === 0 && recovered > 0) {
        success(
          `Recovered ${recovered} task(s) from the provider. ` +
          `Everything is on disk — you can dismiss this failed job now.`
        )
        chip = { text: `✓ recovered ${recovered} — all present, dismiss`, kind: 'ok' }
      } else if (missing === 0 && recovered === 0) {
        success(
          `Nothing to recover — all assets were already on disk. ` +
          `The original failure was likely transient; you can dismiss this job.`
        )
        chip = { text: '✓ all present — dismiss', kind: 'ok' }
      } else if (missing > 0 && recovered > 0) {
        info(
          `Recovered ${recovered} task(s). ${missing} still missing — ` +
          `click Retry to re-submit only the missing chunks.`
        )
        chip = { text: `recovered ${recovered}, ${missing} left — Retry`, kind: 'warn' }
      } else {
        info(
          `Provider had nothing completed to recover (${missing} chunks still missing). ` +
          `Click Retry to re-submit them.`
        )
        chip = { text: `0 recovered, ${missing} left — Retry`, kind: 'warn' }
      }
    } else {
      success(`Repair complete for ${jobTypeLabel(job.type)} on ${job.episode_id}.`)
      chip = { text: '✓ repaired', kind: 'ok' }
    }
    repairOutcome.value = { ...repairOutcome.value, [job.job_id]: chip }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Repair failed')
    repairOutcome.value = { ...repairOutcome.value, [job.job_id]: { text: 'repair failed', kind: 'warn' } }
  }
}

async function retryJob(job: RJob) {
  const projectSlug = jobProjectSlug(job)
  // These queue-owned jobs must preserve their exact durable request params.
  // Motion jobs without a saved pair are historical jobs: the executor alone
  // may select today's cheapest published option. Reposting through a fresh
  // Motion Review route would reject that legacy shape after deleting history.
  if (job.type === 'expand_chapters' || job.type === 'scene_clip_generate' || job.type === 'scene_clips_batch') {
    try {
      await post(`${jobQueuePath(job)}/retry`, {})
      success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
    } catch (e: any) { showError(e?.data?.detail || e?.message || 'Failed to retry job') }
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
        showError(reason)
        return
      }
      await del(jobQueuePath(job))
      success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
    } catch (e: any) { showError(e?.data?.detail || 'Failed to retry job') }
    return
  }

  const target = endpointMap[job.type]
  if (!target) {
    try {
      await post(projectSlug === '_app_' ? `/jobs/all/${job.job_id}/retry` : `/projects/${projectSlug}/jobs/${job.job_id}/retry`, {})
      success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
    } catch (e: any) {
      showError(e?.data?.detail || e?.message || 'Failed to retry job')
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
  } catch (e: any) { showError(e.data?.detail || 'Failed to retry job') }
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
  throw new Error(`Repair job ${jobId} did not finish within ${timeoutMs / 1000}s — proceeding with retry anyway.`)
}

async function clearFinished() {
  try {
    const result = await del<{ cleared: number }>(isUniversal.value ? '/jobs/all' : `/projects/${slug.value}/jobs`)
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
.output-scroll {
  background: var(--bg-primary); border-radius: var(--radius-sm);
  padding: 10px; margin-top: 6px;
  max-height: 180px; overflow: auto;
  font-size: var(--font-xs);
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

.jobs-section { display: block; min-width: 0; max-width: 100%; }
.section-heading {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 0; margin-top: 6px;
  border-bottom: 1px solid var(--border);
}
.section-heading h2 { font-size: 14px; font-weight: 600; margin: 0; color: var(--text-primary); }
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

/* Expandable output */
.job-expand {
  margin-top: 6px; font-size: var(--font-xs); color: var(--accent); cursor: pointer;
}
.job-expand:hover { text-decoration: underline; }
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
  font-size: var(--font-xs); color: var(--error); cursor: pointer;
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
.btn-xs { padding: 3px 10px; font-size: var(--font-xs); }
.status-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.status-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.status-chip { font-size: 12px; padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border, #333); background: none; color: var(--text-muted, #999); cursor: pointer; }
.status-chip:hover { border-color: var(--accent, #6ab0f3); }
.status-chip.active { background: var(--accent, #6ab0f3); color: #fff; border-color: var(--accent, #6ab0f3); }
.status-chip.active.sc-error { background: #e06c75; border-color: #e06c75; }
.status-count { margin-left: 5px; opacity: 0.8; font-variant-numeric: tabular-nums; }
.repair-all-btn { white-space: nowrap; }
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
