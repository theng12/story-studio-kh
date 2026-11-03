<template>
  <div class="workspace-page jobs-workspace">
    <WorkspaceHero
      eyebrow="Management · Operations"
      :title="isUniversal ? 'All Jobs' : 'Channel Jobs'"
      :description="isUniversal ? 'Work across every channel in one queue.' : 'This channel’s work, what needs attention, and its history.'"
    >
      <template #aside>
        <div class="jobs-hero-aside">
          <nav class="job-scope-switch" aria-label="Job queue scope">
            <NuxtLink :to="`/projects/${slug}/jobs`" :class="{ active: !isUniversal }">This channel</NuxtLink>
            <NuxtLink :to="{ path: `/projects/${slug}/jobs`, query: { scope: 'all' } }" :class="{ active: isUniversal }">All channels</NuxtLink>
          </nav>
          <div class="workspace-metrics" aria-label="Job queue summary">
            <span class="workspace-metric" data-tone="info"><strong>{{ stats.running }}</strong> running</span>
            <span class="workspace-metric" data-tone="warning"><strong>{{ stats.queued }}</strong> waiting locally</span>
            <span v-if="stats.paused" class="workspace-metric" data-tone="warning"><strong>{{ stats.paused }}</strong> paused</span>
            <span class="workspace-metric" data-tone="success"><strong>{{ stats.done }}</strong> done</span>
            <span v-if="stats.recovered" class="workspace-metric" data-tone="success"><strong>{{ stats.recovered }}</strong> recovered</span>
            <span v-if="stats.error" class="workspace-metric" data-tone="error"><strong>{{ stats.error }}</strong> job{{ stats.error === 1 ? '' : 's' }} need{{ stats.error === 1 ? 's' : '' }} attention</span>
          </div>
          <!-- Owner 2026-10-07: capacity jargon (lanes, tiers, unverified) sits behind
               one plain "Gateway capacity" disclosure; a stop stays visible. -->
          <span
            v-if="freshQueueAdmission && genStudioAdmission?.submissions_blocked"
            class="capacity-error"
            :title="genStudioAdmission.submission_block_reason || undefined"
          >
            <strong>Sending is stopped</strong>
            the Gateway is not ready yet
          </span>
          <details class="genstudio-capacity">
            <summary>Gateway capacity</summary>
            <div class="genstudio-capacity-summary" aria-label="Gateway account capacity">
            <span v-if="freshQueueAdmission && genStudioAdmission?.local_waiting">
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
              up to {{ genStudioAdmission.burst_concurrency_ceiling }} jobs when the Gateway has spare capacity — best effort, not guaranteed.
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
              Gateway queued
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
          </details>

        </div>
      </template>
    </WorkspaceHero>

    <section class="jobs-control-toolbar" aria-label="Job actions">
      <div class="jobs-control-heading">
        <strong>Job actions</strong>
        <span>{{ actionScopeLabel }} · all job types and statuses</span>
        <UpdatedAgo class="jobs-updated-ago" :at="jobsLoadedAt" :busy="refreshingJobs" @refresh="refreshVisibleJobs" />
      </div>
      <div class="jobs-primary-actions" role="group" aria-label="Main job actions">
        <div class="jobs-primary-action">
          <button class="btn btn-primary check-all-btn" :disabled="checkAction.disabled"
            aria-describedby="check-all-hint" @click="checkOnRunningJobs()">{{ checkAction.label }}</button>
          <p id="check-all-hint" class="jobs-action-hint">{{ checkAction.hint }}</p>
        </div>
        <div class="jobs-primary-action">
          <button class="btn btn-primary retry-all-btn" :disabled="redoAction.disabled"
            :title="retryAllTooltip" aria-describedby="redo-all-hint" @click="retryAllFailed()">{{ redoAction.label }}</button>
          <p id="redo-all-hint" class="jobs-action-hint">{{ redoAction.hint }}</p>
        </div>
      </div>
      <!-- Owner rule 2026-10-03: these actions stay visible, never folded. -->
      <div class="jobs-more-actions" role="group" aria-label="Other job actions">
        <div class="jobs-control-groups">
          <div class="jobs-control-group" role="group" aria-label="Collect finished output">
            <span class="jobs-control-label">Collect finished output · free · both already run inside “Check Running Jobs”</span>
            <div class="jobs-more-action">
              <button class="btn btn-sm btn-secondary" :disabled="bulkActionBusy || recoverableEpisodes.length === 0"
                @click="recoverAllEpisodes()">{{ recoveringAllEpisodes ? 'Recovering…' : `Recover All (${recoverableEpisodes.length})` }}</button>
              <small>{{ recoverableEpisodes.length ? MORE_ACTION_HINTS.recover : 'No episodes to recover.' }}</small>
            </div>
            <div class="jobs-more-action">
              <button class="btn btn-sm btn-secondary repair-all-btn" :disabled="bulkActionBusy || repairableFailedJobs.length === 0"
                @click="repairAllFailed()">{{ repairingAllFailed ? 'Repairing…' : `Repair All (${repairableFailedJobs.length})` }}</button>
              <small>{{ repairableFailedJobs.length ? MORE_ACTION_HINTS.repair : 'No failed narration or thumbnail jobs to repair.' }}</small>
            </div>
          </div>
          <div class="jobs-control-group" role="group" aria-label="Queue controls">
            <span class="jobs-control-label">Queue · pause applies to all channels</span>
            <div class="jobs-more-action">
              <button class="btn btn-sm btn-secondary" :disabled="changingQueueState || resumingQueue || queueStateUnknown || (!queuePaused && !hasQueueWork)"
                @click="queuePaused ? resumeQueue() : pauseQueue()">{{ changingQueueState || resumingQueue ? 'Updating Queue…' : queueStateUnknown ? 'Queue State Unknown' : queuePaused ? 'Resume Queue' : 'Pause Queue' }}</button>
              <small>{{ queueStateUnknown ? 'Story Studio cannot read the queue state right now. Refresh to check.' : queuePaused ? 'Releases the hold so waiting work starts again.' : hasQueueWork ? MORE_ACTION_HINTS.queue : 'Nothing is waiting or running.' }}</small>
            </div>
            <div class="jobs-more-action">
              <button class="btn btn-sm btn-secondary resume-paused-btn" :disabled="bulkActionBusy || pausedJobCount === 0"
                @click="resumePausedJobs()">{{ bulkResumeBusy ? `Resuming ${bulkResumeCount}…` : `Resume Paused (${pausedJobCount})` }}</button>
              <small>{{ pausedJobCount ? MORE_ACTION_HINTS.resume : 'No paused jobs.' }}</small>
            </div>
          </div>
          <div class="jobs-control-group" role="group" aria-label="Remove rows from the list">
            <span class="jobs-control-label">Remove From List · keeps files and billing records</span>
            <div class="jobs-more-action">
              <button class="btn btn-sm btn-secondary" :disabled="bulkActionBusy || finishedCount === 0"
                @click="clearFinished()">{{ clearingHistory === 'finished' ? 'Removing…' : `Remove Finished From List (${finishedCount})` }}</button>
              <small>{{ finishedCount ? MORE_ACTION_HINTS.clearFinished : 'No finished rows to remove.' }}</small>
            </div>
            <div class="jobs-more-action">
              <button class="btn btn-sm btn-secondary" :disabled="bulkActionBusy || failedCount === 0"
                @click="clearFailed()">{{ clearingHistory === 'failed' ? 'Removing…' : `Remove Failed From List (${failedCount})` }}</button>
              <small>{{ failedCount ? MORE_ACTION_HINTS.clearFailed : 'No settled failed rows to remove.' }}</small>
            </div>
          </div>
        </div>
      </div>
      <p v-if="retryAllStatusMessage" class="jobs-control-result" role="status">{{ retryAllStatusMessage }}</p>
      <details v-if="retryAllAttentionResults.length" class="retry-all-details disclosure">
        <summary>{{ retryAllAttentionResults.length }} retry action{{ retryAllAttentionResults.length === 1 ? ' needs' : 's need' }} attention</summary>
        <ul>
          <li v-for="result in retryAllAttentionResults" :key="result.key">
            <strong>{{ result.label }}</strong>
            <span>{{ retryAllAttentionLabel(result) }} — {{ result.reason }}</span>
          </li>
        </ul>
      </details>
    </section>

    <!-- Durable Story-side queue hold. Queued work has not been submitted;
         accepted Gateway items checkpoint before their job pauses. -->
    <WorkspaceNotice v-if="queuePaused === true" tone="warning" title="Job queue is paused">
      New Story jobs are held before submission. Running Gateway jobs finish saving already accepted items, then pause safely.

    </WorkspaceNotice>
    <WorkspaceNotice v-if="queueStateUnknown" tone="info" title="Queue state could not be read">
      Story Studio could not confirm whether the queue is paused, so the state is unknown rather than "running". Refresh to check before changing it.
      <button class="btn btn-sm btn-secondary" @click="checkQueuePaused">Refresh Queue State</button>
    </WorkspaceNotice>
    <WorkspaceNotice v-if="jobsStale" tone="warning" title="Jobs may be out of date">
      {{ jobsRefreshMessage }}
      <button class="btn btn-sm btn-secondary" :disabled="refreshingJobs" @click="refreshVisibleJobs">
        {{ refreshingJobs ? 'Refreshing Jobs…' : 'Refresh Jobs' }}
      </button>
    </WorkspaceNotice>
    <WorkspaceNotice v-if="historyError" tone="warning" title="Finished job history could not be loaded">
      {{ historyError }}
      <template #actions>
        <button class="btn btn-sm btn-secondary" @click="loadJobHistory">Retry History</button>
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
        Use Recover or Repair in Job actions above to retrieve available results.
        Retry remains a separate action for unfinished work.
      </span>
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
          <strong>Pipeline run finished</strong>
          ({{ batchSummary.success }} done<span v-if="batchSummary.recovered"> · {{ batchSummary.recovered }} with recovered subtitle work</span> of {{ batchSummary.total }} episodes,
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
          <strong>{{ batchSummary.failed }} episode{{ batchSummary.failed === 1 ? '' : 's' }} need{{ batchSummary.failed === 1 ? 's' : '' }} attention</strong>
          <span class="text-muted">— top reasons:</span>
        </div>
        <ul class="bbf-reason-list">
          <li v-for="r in batchSummary.failure_reasons" :key="r.reason">
            <span class="bbf-count">×{{ r.count }}</span>
            <span class="bbf-reason-text">{{ r.reason }}</span>
          </li>
        </ul>
      </div>

      <!-- Per-episode failure details — expand on demand. The full error is
           kept untruncated but passes through the customer-copy boundary. -->
      <details v-if="batchSummary.failed_episodes.length" class="bbf-details disclosure">
        <summary>Show all episodes needing attention ({{ batchSummary.failed_episodes.length }})</summary>
        <div
          v-for="fe in batchSummary.failed_episodes"
          :key="fe.episode_id"
          class="bbf-failed-episode"
        >
          <div class="bbf-failed-episode-head">
            <strong>{{ fe.episode_id }}</strong>
            <span class="text-muted">— needs attention at step <code>{{ fe.job_type }}</code></span>
          </div>
          <pre class="bbf-failed-episode-error">{{ customerSafeJobText(fe.full_error) }}</pre>
        </div>
      </details>

      <div class="bbf-actions">
        <button
          v-if="batchSummary.failed > 0"
          class="btn btn-sm btn-secondary"
          title="Filter History below to jobs that need attention — use this to review each job’s details and choose whether to Retry."
          @click="reviewFailures"
        >Review Jobs →</button>

      </div>

      <!-- Inline explainer: what does "needs repair" actually mean and
           when do you click which button. Operator-first — no docs tab. -->
      <div class="bbf-explainer">
        <strong>What "needs repair" means:</strong>
        A provider finished the generation (so you were billed) but the bytes
        didn't land on disk (network drop, kill mid-download, etc.).
        <b>Repair</b> re-fetches those files with no extra credits.
        <b>Review jobs</b> is for work that still needs another try — no usable
        result was saved, so retrying may spend credits again.
      </div>
    </div>

    <!-- Status filters do not change the toolbar action scope. -->
    <div class="status-bar">
      <label class="episode-search">
        <span class="sr-only">Search by episode</span>
        <input v-model="episodeSearch" type="search" placeholder="Search episode code or title" autocomplete="off">
      </label>
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
      <div v-if="hiddenJobsInScope.length" class="hidden-jobs" role="status">
        <span v-if="!showHidden && hiddenSettlingCount" class="hidden-settling-count">
          {{ hiddenSettlingCount }} hidden {{ hiddenSettlingCount === 1 ? 'job is' : 'jobs are' }} still settling
        </span>
        <button
          type="button"
          class="btn btn-xs btn-ghost"
          :aria-pressed="showHidden"
          @click="toggleHiddenJobs"
        >{{ showHidden ? 'Hide Hidden' : `Show Hidden (${hiddenJobsInScope.length})` }}</button>
      </div>
    </div>

    <!-- Sort Bar -->
    <div class="sort-bar">
      <!-- Job type: a select rather than a row of 19 tabs, so the first job sits higher (owner 2026-10-07). -->
      <label class="project-filter type-filter">
        <span>Type</span>
        <select :value="activeFilter" @change="activeFilter = ($event.target as HTMLSelectElement).value; failureBatchFilter = null">
          <option v-for="tab in filterTabs" :key="tab.type" :value="tab.type">{{ tab.label }}{{ tab.count ? ` (${tab.count} active)` : '' }}</option>
        </select>
      </label>
      <label v-if="isUniversal" class="project-filter">
        <span>Channel</span>
        <select v-model="projectFilter">
          <option value="all">All channels</option>
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

    <section class="jobs-selection-toolbar" aria-label="Select jobs to abandon and clear">
      <div class="jobs-selection-buttons">
        <strong>{{ selectedCleanupJobs.length }} selected</strong>
        <button class="btn btn-sm btn-secondary" :disabled="bulkActionBusy || !attentionCleanupCount" @click="selectCleanupJobs(true)">Select Needs Attention ({{ attentionCleanupCount }})</button>
        <button class="btn btn-sm btn-secondary" :disabled="bulkActionBusy || !eligibleCleanupJobs.length" @click="selectCleanupJobs(false)">Select All Matching ({{ eligibleCleanupJobs.length }})</button>
        <button class="btn btn-sm btn-ghost" :disabled="bulkActionBusy || !selectedCleanupIds.size" @click="selectedCleanupIds = new Set()">Clear Selection</button>
        <button class="btn btn-sm btn-secondary" :disabled="bulkActionBusy || !selectedCleanupJobs.length" @click="abandonAndClearSelected">{{ clearingSelected ? 'Removing Selected…' : `Abandon and Remove From List (${selectedCleanupJobs.length})` }}</button>
      </div>
      <p v-if="selectedCleanupJobs.length" class="text-muted">Selection includes matching jobs across all filtered pages. Files and billing records stay intact. Abandoning stops local tracking; accepted provider work may still finish.</p>
      <p v-if="cleanupProgress" role="status">{{ cleanupProgress }}</p>
      <details v-if="cleanupFailures.length" class="disclosure">
        <summary>{{ cleanupFailures.length }} selected job{{ cleanupFailures.length === 1 ? ' needs' : 's need' }} attention</summary>
        <ul><li v-for="(failure, index) in cleanupFailures" :key="index"><strong>{{ failure.label }}</strong> — {{ failure.reason }}</li></ul>
      </details>
    </section>

    <WorkspaceNotice v-if="jobsLoading && !jobs.length" tone="info" title="Loading jobs">
      Reading job records{{ isUniversal ? ' from all channels' : '' }}…
    </WorkspaceNotice>
    <WorkspaceNotice v-else-if="jobsRefreshError && !jobs.length" tone="warning" title="Jobs could not be loaded">
      {{ jobsRefreshMessage }}
      <button class="btn btn-sm btn-secondary" :disabled="refreshingJobs" @click="refreshVisibleJobs">Refresh Jobs</button>
    </WorkspaceNotice>
    <!-- Empty State -->
    <EmptyState
      v-else-if="activeJobs.length === 0 && historyJobs.length === 0"
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
          v-for="job in visibleActiveJobs"
          :key="job.job_id"
          class="job-card card"
          :class="'status-' + jobDisplayStatus(job)"
        >
        <!-- Row 1: Status + Type + Episode + Actions -->
        <div class="job-row-main">
          <div class="job-identity">
            <input type="checkbox" :checked="selectedCleanupIds.has(job.job_id)" :disabled="bulkActionBusy || !jobCleanupAction(job) || controlBusy.has(job.job_id)"
              :aria-label="`Select ${projectName(job.project_slug)} ${job.episode_id || job.title || job.type} job`" @change="toggleCleanupJob(job)">
            <StatusBadge :status="jobDisplayStatus(job)" />
            <NuxtLink
              v-if="isUniversal && job.project_slug !== '_app_'"
              :to="`/projects/${job.project_slug}/jobs`"
              class="job-project"
              :title="`Open ${projectName(job.project_slug)} jobs`"
            >{{ projectName(job.project_slug) }}</NuxtLink>
            <span v-else-if="isUniversal" class="job-project">App tools</span>
            <span class="job-type">{{ jobDisplayLabel(job) }}</span>
            <span v-if="job.status === 'queued' && job.queue_position" class="job-queue-position"
              title="Position among queued jobs of this kind; earlier runs first."
            >#{{ job.queue_position }} in its queue</span>
            <span class="job-episode">{{ job.episode_id }}</span>
            <span v-if="job.title" class="job-title text-muted" :title="job.title">- {{ job.title }}</span>
          </div>
          <div class="job-actions">
              <NuxtLink
                v-if="jobWorkspaceLink(job)"
                :to="jobWorkspaceLink(job)!.to"
                class="btn btn-xs btn-ghost"
                :aria-label="jobWorkspaceLink(job)!.ariaLabel"
              >{{ jobWorkspaceLink(job)!.label }}</NuxtLink>
            <template v-if="job.status === 'queued'">
              <button class="btn btn-xs btn-ghost" :disabled="controlBusy.has(job.job_id) || (job.queue_position || 0) <= 1"
                title="Move earlier among queued jobs of this kind" @click="moveInQueue(job, 'up')">Up</button>
              <button class="btn btn-xs btn-ghost" :disabled="controlBusy.has(job.job_id)"
                title="Move later among queued jobs of this kind" @click="moveInQueue(job, 'down')">Down</button>
              <button class="btn btn-xs btn-ghost" :disabled="controlBusy.has(job.job_id) || (job.queue_position || 0) <= 1"
                title="Move to the front among queued jobs of this kind" @click="moveInQueue(job, 'top')">Top</button>
            </template>
            <button
              v-if="canResumeJob(job)"
              class="btn btn-xs btn-primary"
              :disabled="controlBusy.has(job.job_id)"
              @click="resumeJob(job)"
              title="Verify saved output and accepted work, then continue only missing work."
            >{{ controlBusy.has(job.job_id) ? 'Rejoining…' : 'Resume' }}</button>
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
            <span v-if="repairOutcome[job.job_id]" class="repair-chip" :class="`rc-${repairOutcome[job.job_id].kind}`">
              {{ repairOutcome[job.job_id].text }}
            </span>
            <span v-if="failedItemReplacementOutcome(job)" class="repair-chip" :class="`rc-${failedItemReplacementOutcome(job)?.kind}`">
              {{ failedItemReplacementOutcome(job)?.text }}
            </span>
            <span v-if="automaticReplacementOutcome(job)" class="repair-chip" :class="`rc-${automaticReplacementOutcome(job)?.kind}`">
              {{ automaticReplacementOutcome(job)?.text }}
            </span>
          </div>
        </div>

        <EpisodeRecoveryStatus :job="job" :verified-recovered="isVerifiedRecoveredSubtitleJob(job)" />
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
            v-if="autoRetryLabel(job)"
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

        <!-- Row 3: the progress tracker. Now ONE line: the counts, then the
             measured timing readings at the trailing edge.
             The card used to answer "how is it going?" with a stat row, a
             provider status line, a queue line, a money row, a settlement box
             and an exception line — several of which said the same thing in
             different words ("Running", "CheckingProviderStatus", "The
             Gateway is generating", "credit pending", "awaiting settlement").

             Now there is one line of counts, one line about the money, and one
             line per genuine exception. The provider's own wording is still
             available — it lives in Technical details, where diagnostics
             belong.

             NOT a live region. The timing readings at the end of this line
             tick every second, and a `role="status"` region announces its
             whole content whenever any of it changes — so a screen reader
             would repeat the counts, the estimate and the freshness every
             second for as long as the job was fresh. The counts are read on
             demand; the ticking text is not a state change worth announcing. -->
        <p v-if="jobHasSummary(job)" class="job-summary-line">
          <span class="job-summary-counts">
            <template v-if="job.item_progress && !isVerifiedRecoveredSubtitleJob(job)">
              <span class="job-stat">
                <strong>{{ jobCounts(job).finished.toLocaleString() }}</strong> of {{ jobCounts(job).total.toLocaleString() }} done
              </span>
              <span v-if="jobCounts(job).inFlight" class="job-stat is-inflight">
                <strong>{{ jobCounts(job).inFlight.toLocaleString() }}</strong> generating right now
              </span>
              <span v-if="jobCounts(job).remaining" class="job-stat">
                <strong>{{ jobCounts(job).remaining.toLocaleString() }}</strong> left in this run
              </span>
              <span v-if="jobCounts(job).waiting" class="job-stat is-muted">
                <strong>{{ jobCounts(job).waiting.toLocaleString() }}</strong> {{ jobCounts(job).waitingForMac ? 'waiting for a free Mac' : 'waiting to try again' }}
              </span>
              <span v-if="jobCounts(job).failed" class="job-stat is-failed">
                <strong>{{ jobCounts(job).failed.toLocaleString() }}</strong> needs another try
              </span>
              <span v-if="jobCounts(job).queued" class="job-stat is-muted">
                <strong>{{ jobCounts(job).queued.toLocaleString() }}</strong> not sent yet
              </span>
              <span v-if="jobCounts(job).settling" class="job-stat is-muted">
                <strong>{{ jobCounts(job).settling.toLocaleString() }}</strong> settling
              </span>
            </template>
            <!-- A local render has no items and no provider. What it HAS is a
                 state of its own, and it is the only thing worth saying. -->
            <span v-if="finalRenderDetail(job)" class="job-stat">{{ finalRenderDetail(job) }}</span>
            <!-- Measured, never assumed — see useJobEta.ts. Absent until this
                 job's own rate or its class's median can support one. -->
            <span
              v-if="jobEta(job) || jobFreshness(job)"
              class="job-stat-telemetry"
              role="group"
              aria-label="Job timing"
            >
              <span v-if="jobEta(job)" class="job-stat-eta">{{ jobEta(job) }}</span>
              <!-- "when did something last actually happen". A quiet card is the
                   reason this page gets opened; silence must be legible. -->
              <span
                v-if="jobFreshness(job)"
                class="job-stat-fresh"
                :class="{ 'is-stale': jobProgressStale(job) }"
              >{{ jobFreshness(job) }}</span>
            </span>
          </span>
        </p>

        <!-- Money: ONE line. Three figures, the one sentence that explains
             them, and the link to the record. The per-item ledger that used
             to sit here is in Technical details. -->
        <template v-if="job.genstudio_jobs?.length && !isFreeFleetWork(job.genstudio_jobs)">
          <template v-for="summary in [jobCreditSummary(job)]" :key="job.job_id">
            <div class="job-money">
              <span class="meta-label">Credits:</span>
            <!-- v1.4.7 — the unit on all three, not just the last. `on hold` already
                 said "credits" while `charged` and `returned` did not, so the same
                 page spelled one fact two ways. -->
            <template v-if="summary.confirmed && summary.charged === 0">
              <span class="job-money-figure">No credits charged</span>
            </template>
            <template v-else>
              <span v-if="summary.charged" class="job-money-figure charged">{{ summary.charged.toLocaleString() }} credits {{ summary.confirmed ? 'charged' : 'charged so far' }}</span>
              <span v-if="summary.held" class="job-money-figure held">{{ summary.held.toLocaleString() }} credits on hold</span>
              <span v-if="summary.returned" class="job-money-figure returned">{{ summary.returned.toLocaleString() }} credits {{ summary.confirmed ? 'returned' : 'returned so far' }}</span>
              <!-- The one sentence about the money. It used to be three: a
                   settlement box, an exception line about a pending credit
                   outcome, and "Awaiting settlement" in the item panel. -->
              <GenStudioCreditSettlementHint :remote-jobs="summary.remoteJobs" compact inline :link="false" />
              <NuxtLink v-if="!summary.confirmed" class="job-money-figure" to="/usage">Credits &amp; settlement</NuxtLink>
            </template>
            </div>
          </template>
        </template>
        <p v-if="paidImageReplacementAttemptText(job)" class="paid-image-replacement-attempt" role="status">
          {{ paidImageReplacementAttemptText(job) }}
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

        <!-- Technical details. Diagnostic state and customer-safe output stay
             available without exposing structured request identifiers. Only
             one card's drawer is mounted at a time so long histories stay cheap. -->
        <AdvancedDisclosure
          label="Technical details"
          :open="expanded === job.job_id"
          @update:open="setTechnicalOpen(job.job_id, $event)"
        >
          <template v-if="expanded === job.job_id">
            <!-- ONE shared details body. The Active card and the History card
                 used to carry two copies of these blocks, and the copies
                 drifted apart. -->
            <JobCardDetails
              :job="job"
              :remote-jobs="settledRemoteJobs(job)"
              :counts="job.item_progress ? jobCounts(job) : null"
              :provider-status="genStudioStatusDetail(job)"
              :provider-queue="genStudioQueueDetail(job)"
              :now-ms="now"
            />
          </template>
        </AdvancedDisclosure>

        <p
          v-if="primaryJobControl(job)"
          class="job-control-reason"
          :class="`control-${primaryJobControl(job)?.action}`"
          role="status"
        >
          <template v-if="hasPendingCancellation(job) && primaryJobControl(job)?.action === 'request-remote-cancel'">Story Studio is confirming the cancellation with the Gateway. </template>
          {{ customerJobText(primaryJobControl(job)?.reason, job) }}
        </p>
      </div>
      </div>
      <button v-if="activeJobs.length > visibleActiveJobs.length" type="button" class="btn btn-sm btn-secondary show-all-active" @click="showAllActive = true">
        Show All {{ activeJobs.length }}
      </button>
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
          :class="'status-' + jobDisplayStatus(job)"
        >
          <div class="job-row-main">
            <div class="job-identity">
              <input type="checkbox" :checked="selectedCleanupIds.has(job.job_id)" :disabled="bulkActionBusy || !jobCleanupAction(job) || controlBusy.has(job.job_id)"
                :aria-label="`Select ${projectName(job.project_slug)} ${job.episode_id || job.title || job.type} job`" @change="toggleCleanupJob(job)">
              <StatusBadge :status="jobDisplayStatus(job)" />
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
              <NuxtLink
                v-if="jobWorkspaceLink(job)"
                :to="jobWorkspaceLink(job)!.to"
                class="btn btn-xs btn-ghost"
                :aria-label="jobWorkspaceLink(job)!.ariaLabel"
              >{{ jobWorkspaceLink(job)!.label }}</NuxtLink>
              <button
                v-if="primaryJobControl(job)"
                class="btn btn-xs btn-secondary"
                :class="{ 'job-control-primary': primaryJobControl(job)?.enabled }"
                :disabled="!primaryJobControl(job)?.enabled || controlBusy.has(job.job_id)"
                :title="primaryJobControl(job)?.reason"
                @click="runJobControl(job, primaryJobControl(job) || undefined)"
              >{{ controlBusy.has(job.job_id) ? 'Working…' : primaryJobControl(job)?.label }}</button>
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
              <!-- v1.0.114 — Repair / Retry split (mirror of expanded view above). -->
              <button
                v-if="(job.status === 'error' || job.status === 'cancelled') && !isRecoveredFailure(job) && jobCanBeRepaired(job) && !job.auto_retry?.eligible"
                class="btn btn-xs btn-primary"
                :disabled="repairingJobs.has(job.job_id) || episodeRecoveryBusy(job)"
              @click="repairJobOnly(job)"
                title="SAFE — Polls the provider for already-completed tasks and downloads them for free. Never re-submits. Click this FIRST when a job timed out."
              >
                Repair
              </button>
              <span v-if="repairOutcome[job.job_id]" class="repair-chip" :class="`rc-${repairOutcome[job.job_id].kind}`">
                {{ repairOutcome[job.job_id].text }}
              </span>
              <button
                v-if="canReplaceFailedItems(job)"
                class="btn btn-xs btn-primary"
                :disabled="controlBusy.has(job.job_id)"
                title="Checks the saved provider tasks first, then queues only confirmed failed audio sections or writing requests. Existing successful output stays in place; replacement work may use credits."
                @click="replaceFailedItems(job)"
              >{{ failedItemReplacementOutcome(job)?.state === 'checking' ? 'Checking Failed Items…' : 'Replace Failed Items' }}</button>
              <span v-if="failedItemReplacementOutcome(job)" class="repair-chip" :class="`rc-${failedItemReplacementOutcome(job)?.kind}`">
                {{ failedItemReplacementOutcome(job)?.text }}
              </span>
              <span v-if="automaticReplacementOutcome(job)" class="repair-chip" :class="`rc-${automaticReplacementOutcome(job)?.kind}`">
                {{ automaticReplacementOutcome(job)?.text }}
              </span>
              <!-- v1.2.8 — targeted recovery (mirror of the expanded view). -->
              <button
                v-if="canRecoverEpisode(job)"
                :disabled="episodeRecoveryBusy(job)"
                @click="recoverEpisode(job)"
                class="btn btn-xs btn-primary"
                title="SAFE — Checks THIS episode only for output the provider already finished but that never landed on disk, and pulls it in for free. No credits consumed, nothing re-submitted, and no other episode is scanned."
              >
                {{ episodeRecoveryBusy(job) ? 'Recovering…' : 'Recover This Episode' }}
              </button>
              <button
                v-if="(job.status === 'error' || job.status === 'cancelled') && canOfferScenePromptAutoRepair(job)"
                class="btn btn-xs btn-primary prompt-auto-repair-btn"
                :disabled="controlBusy.has(job.job_id)"
                :aria-label="`Auto repair missing prompts for ${job.episode_id}; GenStudio credits may be charged`"
                title="PAID AUTO REPAIR — Keeps every verified prompt and submits each missing or duplicated scene alone. Continues only while verified progress improves. Pause stops new requests after any accepted request settles. GenStudio credits may be charged."
                @click="autoRepairScenePrompts(job)"
              >{{ controlBusy.has(job.job_id) ? 'Starting…' : 'Auto Repair Prompts · Credits' }}</button>
              <button
                v-if="isTerminalContinuityRender(job)"
                class="btn btn-xs btn-primary"
                :disabled="controlBusy.has(job.job_id)"
                title="Queues only missing images. Existing images stay as they are; new generations may use credits."
                @click="finishMissingImages(job)"
              >
                {{ controlBusy.has(job.job_id) ? 'Queuing…' : 'Finish Missing Images' }}
              </button>
              <button
                v-if="canRetryJob(job)"
                class="btn btn-xs btn-secondary"
                :disabled="controlBusy.has(job.job_id) || repairingJobs.has(job.job_id) || episodeRecoveryBusy(job)"
                @click="retryJob(job)"
                :title="retryTooltip(job)"
              >
                Retry
              </button>
              <button
                v-if="showHidden && isJobHidden(job)"
                class="btn btn-xs btn-ghost"
                @click="restoreJob(job)"
              >Restore</button>
              <button
                v-else-if="canHideJob(job)"
                class="btn btn-xs btn-ghost"
                title="Hide this completed card from Jobs. Work, receipts, and settlement checks continue."
                @click="hideJob(job)"
              >Hide From Jobs</button>
            </div>
          </div>
          <EpisodeRecoveryStatus :job="job" :verified-recovered="isVerifiedRecoveredSubtitleJob(job)" />
          <p
            v-if="primaryJobControl(job)"
            class="job-control-reason"
            :class="`control-${primaryJobControl(job)?.action}`"
            role="status"
          >
            <template v-if="hasPendingCancellation(job) && primaryJobControl(job)?.action === 'request-remote-cancel'">Story Studio is confirming the cancellation with the Gateway. </template>
            <template v-else-if="primaryJobControl(job)?.action === 'clear-history'">Removing this row does not change its files or billing records. </template>
            {{ customerJobText(primaryJobControl(job)?.reason, job) }}
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
              v-if="autoRetryLabel(job)"
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

          <!-- History reads exactly like Active: ONE summary line of counts,
               ONE line about the money. Its final counts, its exceptions and
               the same drawer. -->
          <p v-if="jobHasSummary(job)" class="job-summary-line">
            <span class="job-summary-counts">
              <template v-if="job.item_progress && !isVerifiedRecoveredSubtitleJob(job)">
                <span class="job-stat">
                  <strong>{{ jobCounts(job).finished.toLocaleString() }}</strong> of {{ jobCounts(job).total.toLocaleString() }} done
                </span>
                <span v-if="jobCounts(job).inFlight" class="job-stat is-inflight">
                  <strong>{{ jobCounts(job).inFlight.toLocaleString() }}</strong> generating right now
                </span>
                <span v-if="jobCounts(job).remaining" class="job-stat">
                  <strong>{{ jobCounts(job).remaining.toLocaleString() }}</strong> left in this run
                </span>
                <span v-if="jobCounts(job).waiting" class="job-stat is-muted">
                  <strong>{{ jobCounts(job).waiting.toLocaleString() }}</strong> {{ jobCounts(job).waitingForMac ? 'waiting for a free Mac' : 'waiting to try again' }}
                </span>
                <span v-if="jobCounts(job).failed" class="job-stat is-failed">
                  <strong>{{ jobCounts(job).failed.toLocaleString() }}</strong> needs another try
                </span>
                <span v-if="jobCounts(job).queued" class="job-stat is-muted">
                  <strong>{{ jobCounts(job).queued.toLocaleString() }}</strong> not sent yet
                </span>
                <span v-if="jobCounts(job).settling" class="job-stat is-muted">
                  <strong>{{ jobCounts(job).settling.toLocaleString() }}</strong> settling
                </span>
              </template>
              <span v-if="finalRenderDetail(job)" class="job-stat">{{ finalRenderDetail(job) }}</span>
              <span
                v-if="jobEta(job) || jobFreshness(job)"
                class="job-stat-telemetry"
                role="group"
                aria-label="Job timing"
              >
                <span v-if="jobEta(job)" class="job-stat-eta">{{ jobEta(job) }}</span>
                <span
                  v-if="jobFreshness(job)"
                  class="job-stat-fresh"
                  :class="{ 'is-stale': jobProgressStale(job) }"
                >{{ jobFreshness(job) }}</span>
              </span>
            </span>
          </p>

          <!-- Money: ONE line, same as the Active card. -->
          <template v-if="job.genstudio_jobs?.length && !isFreeFleetWork(job.genstudio_jobs)">
            <template v-for="summary in [jobCreditSummary(job)]" :key="job.job_id">
              <div class="job-money">
                <span class="meta-label">Credits:</span>
                <template v-if="summary.confirmed && summary.charged === 0">
                  <span class="job-money-figure">No credits charged</span>
                </template>
                <template v-else>
                  <span v-if="summary.charged" class="job-money-figure charged">{{ summary.charged.toLocaleString() }} credits {{ summary.confirmed ? 'charged' : 'charged so far' }}</span>
                  <span v-if="summary.held" class="job-money-figure held">{{ summary.held.toLocaleString() }} credits on hold</span>
                  <span v-if="summary.returned" class="job-money-figure returned">{{ summary.returned.toLocaleString() }} credits {{ summary.confirmed ? 'returned' : 'returned so far' }}</span>
                  <GenStudioCreditSettlementHint :remote-jobs="summary.remoteJobs" compact inline :link="false" />
                  <NuxtLink v-if="!summary.confirmed" class="job-money-figure" to="/usage">Credits &amp; settlement</NuxtLink>
                </template>
              </div>
            </template>
          </template>
          <p v-if="paidImageReplacementAttemptText(job)" class="paid-image-replacement-attempt" role="status">
            {{ paidImageReplacementAttemptText(job) }}
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
              <!-- The SAME shared details body as the Active card. -->
              <JobCardDetails
                :job="job"
                :remote-jobs="settledRemoteJobs(job)"
                :counts="job.item_progress ? jobCounts(job) : null"
                :provider-status="genStudioStatusDetail(job)"
                :provider-queue="genStudioQueueDetail(job)"
                :now-ms="now"
              />
            </template>
          </AdvancedDisclosure>

          <div v-if="job.status === 'error'" class="job-error-section" :class="{ 'is-original-attempt': isRecoveredFailure(job) }">
            <p v-if="job.resolved" class="error-summary"><span class="error-label">Settled:</span> {{ job.resolved.reason }}</p>
            <p v-if="job.skipped" class="error-summary"><span class="error-label">Skipped:</span> {{ job.skipped.reason }}</p>
            <div v-if="job.error" class="error-summary">
              <span class="error-label">{{ isRecoveredFailure(job) ? 'Original attempt:' : 'What happened:' }}</span>
              <span class="error-summary-text">{{ jobAttentionSummary(job) || firstErrorLine(customerJobText(job.error, job)) }}</span>
            </div>
            <button
              v-if="job.error && (jobAttentionLinks(job).length || hasMoreErrorLines(job.error))"
              type="button"
              class="error-toggle"
              :aria-expanded="errorExpanded === job.job_id"
              :aria-controls="`job-error-history-${job.job_id}`"
              @click="errorExpanded === job.job_id ? errorExpanded = null : errorExpanded = job.job_id"
            >
              {{ errorExpanded === job.job_id ? 'Hide Details' : 'Show Details' }}
            </button>
            <div :id="`job-error-history-${job.job_id}`" v-if="errorExpanded === job.job_id && job.error" class="error-details">
              {{ customerJobText(job.error, job) }}
            </div>
            <p v-if="paidReplacementAttemptMessage(job)" class="text-muted text-xs">{{ paidReplacementAttemptMessage(job) }}</p>
            <div v-if="needsTimelineRebuild(job)" class="job-attention-links">
              <button type="button" class="btn btn-sm btn-primary" :disabled="rebuildingTimelines.has(job.job_id)" @click="rebuildTimeline(job)">
                {{ rebuildingTimelines.has(job.job_id) ? 'Starting…' : 'Rebuild Timeline' }}
              </button>
              <span class="text-muted text-xs">Makes a new scene timeline from the current subtitles and rhythm. Then press Retry here to make the prompts.</span>
            </div>
            <details v-if="jobAttentionLinks(job).length" class="job-attention-details disclosure">
              <summary>{{ jobAttentionLinks(job).length }} affected item{{ jobAttentionLinks(job).length === 1 ? '' : 's' }} · Review affected items</summary>
              <div class="job-attention-links">
                <NuxtLink v-for="link in jobAttentionLinks(job)" :key="`${link.kind}-${link.to}-${link.label}`" :to="link.to" class="inline-link">
                  {{ link.label }} →
                </NuxtLink>
              </div>
            </details>
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
import { useJobDetails } from '~/composables/useJobDetails'
import { useJobHistory } from '~/composables/useJobHistory'
import { createVisibleInterval } from '~/composables/useVisibleInterval'
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
  summariseSettlement,
  summariseJobItems,
  type EtaSample,
} from '~/composables/useJobEta'
import {
  describeRetryAllTriage,
  normaliseRepairResult,
  triageFailedJobsForRetryAll,
  type RepairRecord,
} from '~/utils/repair-triage'
import { checkRunningJobsAction, redoFailedJobsAction, MORE_ACTION_HINTS, providerHoldReason, classifyCheckedJob, describeCheckResult, type HoldReason } from '~/utils/job-actions-bar'
import {
  customerSafeJobText,
  filterJobsForView,
  isVerifiedLiveCapacity,
  jobDisplayLabel,
  jobRequestIds,
  jobsEmptyState,
  jobTypeLabel,
  jobWorkspaceLink,
  primaryControl,
  retryAdmissionAllowed,
  secondaryControls,
} from '~/utils/job-presentation'
import { formatCredits } from '~/utils/genstudio-credit-cost'
import { recoverEpisodeAssets, describeEpisodeAssetRecovery, type EpisodeAssetRecovery } from '~/utils/job-asset-recovery'
import { groupEpisodeRecoveryRetries, isEpisodeRecoveryType, isRecoveredFailure, isSkippedJob, isVerifiedRecoveredSubtitleJob, jobDisplayStatus } from '~/utils/episode-recovery'
import { effectiveGenStudioTaskState, holdsUnknownProviderOutcome, isFreeFleetWork } from '@shared/provider-task-state'
import { bulkConfirmOptions, capList, controlLabel, deriveOutputDir, episodeQueryValue, isMissingJobError, isPaidWork, matchesEpisodeSearch, orderJobsForDisplay, pageCount, pageSlice, rowOutputLineCount, rowProgressCounter, rowSummaryLine } from '~/utils/jobs-list'
type RJob = DeepReadonly<Job>

definePageMeta({ layout: 'dashboard' })
useAppTitle('Jobs')
const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)
const { get, del, post } = useApi()
const projectQueue = useJobs()
const universalQueue = useAllJobs()
const genStudioModels = useGenStudioModelDisplay()
const isUniversal = computed(() => route.query.scope === 'all')
// The live streams carry slim jobs; the cards this page shows get their full Gateway evidence from
// the per-job GET (see useJobDetails). `streamedJobs` is what the stream sent, `jobs` the merged view.
const streamedJobs = computed(() => isUniversal.value ? universalQueue.jobs.value : projectQueue.jobs.value)
// Both scopes stream live work and read finished history separately. History
// returns small summary rows; full logs are loaded only when details are opened.
const history = useJobHistory()
// A failed history read must be visible: an empty list after a successful clear
// otherwise looks like "nothing remains" instead of "the list could not reload".
const historyError = computed(() => history.error.value)
const scopedJobs = computed(() => {
  const seen = new Set(streamedJobs.value.map(job => job.job_id))
  return [...streamedJobs.value, ...history.rows.value.filter(job => !seen.has(job.job_id))]
})
const jobDetails = useJobDetails()
const jobs = computed(() => scopedJobs.value.map(job => jobDetails.withDetail(job)) as typeof streamedJobs.value)
const queueStats = computed(() => isUniversal.value ? universalQueue.stats.value : projectQueue.stats.value)
const jobsStale = computed(() => isUniversal.value ? universalQueue.jobsStale.value : projectQueue.jobsStale.value)
const jobsRefreshError = computed(() => isUniversal.value ? universalQueue.lastRefreshError.value : projectQueue.lastRefreshError.value)
const jobsLoading = computed(() => isUniversal.value ? universalQueue.isLoading.value : projectQueue.isLoading.value)
const { success, error: showError, info, successUndoable } = useToast()

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
  capacity_verified: boolean
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

const refreshingJobs = ref(false)
// When the job list last arrived (stream update or Refresh), for the "Updated N min ago" caption.
const jobsLoadedAt = ref<number | null>(null)
watch(streamedJobs, () => { if (!jobsLoading.value) jobsLoadedAt.value = Date.now() }, { immediate: true })
const jobsRefreshMessage = computed(() => jobsRefreshError.value || 'Live updates are unavailable. Refresh to get the latest queue state.')
async function refreshVisibleJobs() {
  if (refreshingJobs.value) return
  refreshingJobs.value = true
  try {
    if (isUniversal.value) await universalQueue.refresh()
    else await projectQueue.fetchJobs(slug.value)
    jobsLoadedAt.value = Date.now()
  } catch (error: any) {
    showError(error?.data?.detail || error?.message || 'Could not refresh jobs')
  } finally {
    refreshingJobs.value = false
  }
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

// ── The finished half of the universal list ──────────────────────────────
// One read per scope, not per filter: the page's own type/status/batch/search
// filters still run over these rows, so changing one needs no round trip.
// Narrowing to one channel DOES send the scope, because that is the difference
// between a fleet's history and one channel's.
let historyReload: ReturnType<typeof setTimeout> | null = null
async function loadJobHistory() {
  if (isUniversal.value) {
    await history.load('/jobs/all/history', projectFilter.value === 'all' ? {} : { project: projectFilter.value })
  } else {
    await history.load(`/projects/${slug.value}/jobs/history`)
  }
}
function scheduleHistoryRefresh(delay: number) {
  if (historyReload) clearTimeout(historyReload)
  historyReload = setTimeout(() => { historyReload = null; void loadJobHistory() }, delay)
}
watch([isUniversal, projectFilter, slug], () => {
  history.reset()
  void loadJobHistory()
}, { immediate: true })
// A terminal update leaves the live-only stream and joins history; watching
// its row identities avoids re-reading history for every progress frame.
watch(() => projectQueue.jobs.value.map(job => `${job.job_id}:${job.status}`).join('|'), () => {
  if (!isUniversal.value) scheduleHistoryRefresh(500)
})
watch(() => universalQueue.jobs.value.map(job => `${job.job_id}:${job.status}`).join('|'), () => {
  if (isUniversal.value) scheduleHistoryRefresh(500)
})
onUnmounted(() => { if (historyReload) clearTimeout(historyReload) })

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

function jobModelProvider(job: RJob): string {
  // §2 — the provider the catalogue published for this model, display only.
  return genStudioModels.providerName(job.params?.model)
}

function jobModelDisplay(job: RJob): string {
  const name = genStudioModels.displayName(job.params?.model)
  const provider = jobModelProvider(job)
  return provider ? `${name} · ${provider}` : name
}

function jobModelTitle(job: RJob): string {
  const name = genStudioModels.displayName(job.params?.model)
  const provider = jobModelProvider(job)
  return provider ? `${name} — served by ${provider}` : name
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
function latestActiveGenStudioRequest(job: RJob) {
  const active = (job.genstudio_jobs || []).map((item, index) => ({ item, index })).filter(({ item }) => {
    const state = effectiveGenStudioTaskState(item)
    return item.cancelled !== true && !['succeeded', 'failed', 'cancelled', 'not_created'].includes(state)
  })
  const timestamped = active.filter(({ item }) => Number.isFinite(Date.parse(String(item.updated_at || ''))))
  const pool = timestamped.length ? timestamped : active
  return pool.sort((a, b) => {
    const aTime = Date.parse(String(a.item.updated_at || ''))
    const bTime = Date.parse(String(b.item.updated_at || ''))
    return (Number.isFinite(bTime) ? bTime : b.index) - (Number.isFinite(aTime) ? aTime : a.index)
  })[0]?.item
}

function genStudioStatusDetail(job: RJob): string {
  // Terminal child diagnostics belong in Technical details. The default card
  // reports completion and the next customer action instead of remote attempts.
  const remote = latestActiveGenStudioRequest(job)
  if (!remote || !(remote.status_detail || remote.failure_detail)) return ''
  const detail = customerJobText(remote.status_detail || remote.failure_detail || '', job)
  if (remote.retry_at) return `${detail} Retry ${formatTime(remote.retry_at)}.`
  if (remote.retry_after_seconds === 0) return `${detail} Retry is available now.`
  if (typeof remote.retry_after_seconds === 'number' && remote.retry_after_seconds > 0) {
    return `${detail} Retry in ${Math.ceil(remote.retry_after_seconds)} seconds.`
  }
  if (remote.stall_recovery_at) return `${detail} the Gateway will step in ${formatTime(remote.stall_recovery_at)}.`
  return detail
}

function formatGenStudioQueueEta(seconds: number): string {
  if (seconds < 60) return 'less than a minute'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `about ${hours} hour${hours === 1 ? '' : 's'}${remainder ? ` ${remainder} min` : ''}`
}

/** Private fleet setting as last read; null when unknown, so nothing is claimed from it. */
const privateFleetEnabled = ref<boolean | null>(null)

/**
 * Where a private-fleet final render is, from the backend's public final_render_wait only. With the
 * setting off, sending and importing wait for it, so those say so instead of looking busy.
 */
function finalRenderDetail(job: RJob): string {
  const wait = (job as { final_render_wait?: { state?: string; cancellation_requested?: boolean } }).final_render_wait
  const state = wait?.state
  if (!state) return ''
  const sending = state === 'intent_staged' || state === 'request_persisted'
  const importing = ['output_ready', 'importing', 'imported', 'acknowledged'].includes(state)
  if ((sending || importing) && privateFleetEnabled.value === false && !wait?.cancellation_requested) return 'Needs recovery'
  // A paused queue holds sending and importing (not cancellation) until it resumes.
  if (queuePaused.value === true && !wait?.cancellation_requested) {
    if (sending) return 'Paused — will send when the queue resumes'
    if (importing) return 'Paused — will import when the queue resumes'
  }
  if (sending) return 'Sending to the fleet'
  if (state === 'send_may_start' || state === 'send_unknown') return 'Checking whether the fleet received it'
  if (state === 'remote_wait') return 'Rendering on another Mac'
  if (importing) return 'Importing the finished video'
  return 'Needs recovery'
}

async function refreshPrivateFleetSetting(): Promise<void> {
  if (!projectScopedJobs.value.some((job: RJob) => (job as { final_render_wait?: unknown }).final_render_wait)) return
  try {
    const setting = await get<{ enabled: boolean }>('/app-settings/private-final-render')
    privateFleetEnabled.value = typeof setting?.enabled === 'boolean' ? setting.enabled : null
  } catch {
    privateFleetEnabled.value = null
  }
}
// Its own visible-window poll: a setting changed in Settings shows here without a reload.
const privateFleetPoll = createVisibleInterval(() => { void refreshPrivateFleetSetting() }, 5000)
onMounted(() => privateFleetPoll.start())
onUnmounted(() => privateFleetPoll.stop())

/**
 * Provider queue evidence belongs to the newest active GenStudio request.
 * Story Studio's own queue position is a separate local fact and is not a
 * substitute when the provider did not publish one.
 */
function genStudioQueueDetail(job: RJob): string {
  const quotaRetryAt = job.params?.quota_retry_at
  if (job.status === 'queued' && typeof quotaRetryAt === 'string' && Number.isFinite(Date.parse(quotaRetryAt))) {
    return `The writing model has used up its allowance for now. Story Studio will try again ${new Date(quotaRetryAt).toLocaleString()}. Nothing was charged and finished work is kept.`
  }
  const remote = latestActiveGenStudioRequest(job)
  if (!remote) return ''
  const activeRequestCount = (job.genstudio_jobs || []).filter(item => {
    const itemState = effectiveGenStudioTaskState(item)
    return item.cancelled !== true && !['succeeded', 'failed', 'cancelled', 'not_created'].includes(itemState)
  }).length

  const state = effectiveGenStudioTaskState(remote)
  const hasProviderQueuePosition = typeof remote.queue_position === 'number' && remote.queue_position > 0
  // The gateway is running this job but no Mac has started it: say so, and when it tries again.
  const waiting = remote.waiting
  const nextTry = waiting?.next_try_at && Number.isFinite(Date.parse(waiting.next_try_at))
    ? new Date(waiting.next_try_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''
  const waitingPhase = waiting
    ? `Waiting for a free Mac${nextTry ? ` — next try ${nextTry}` : ''}${waiting.reason ? ` (${waiting.reason})` : ''}.`
    : ''
  const phase = waitingPhase || (hasProviderQueuePosition ? 'Waiting in the Gateway queue.' : ({
    waiting_local: 'Waiting in Story Studio before it is sent.',
    submitting: 'Sending to the Gateway.',
    accepted: 'The Gateway accepted it; it is waiting its turn.',
    waiting_account_capacity: 'Waiting for a free slot at the Gateway.',
    waiting_credits: 'Waiting for GenStudio credits.',
    running: 'The Gateway is generating.',
    completing: 'The Gateway is finishing the result.',
  } as Record<string, string>)[state] || '')
  const facts: string[] = []
  if (hasProviderQueuePosition) {
    facts.push(`Gateway provider queue position ${remote.queue_position}.`)
  }
  if (typeof remote.queue_eta_seconds === 'number' && remote.queue_eta_seconds > 0) {
    // queue_eta_seconds is when the gateway retries, not a prediction of the provider finishing.
    facts.push(`Checking again in ${formatGenStudioQueueEta(remote.queue_eta_seconds)}.`)
  }
  if (remote.queue_reason === 'provider_pace') facts.push('The Gateway is pacing new requests.')
  return [activeRequestCount > 1 ? `Latest request: ${phase}` : phase, ...facts].filter(Boolean).join(' ')
}

function paidImageReplacementAttemptText(job: RJob): string {
  const attempt = job.paid_image_replacement_attempt
  if (!attempt) return ''
  const quote = attempt.quoted_credits === undefined ? ''
    : ` ${formatCredits(attempt.quoted_credits)} at published price version ${attempt.price_version || 'not stated'}.`
  const settled = attempt.actual_settled_credits === undefined ? ''
    : ` Actual settled credits: ${formatCredits(attempt.actual_settled_credits)}.`
  if (attempt.state === 'waiting') return `Paid image replacement is waiting until ${formatTime(attempt.eligible_at)}.`
  if (attempt.state === 'committed') return `Paid image replacement was committed${attempt.replacement_committed_at ? ` ${formatTime(attempt.replacement_committed_at)}` : ''}.${quote}`
  if (attempt.state === 'blocked') {
    return attempt.reason === 'automatic_replacement_unavailable'
      ? 'Paid image replacement was blocked: Automatic replacement was not available.'
      : 'Paid image replacement was blocked before a replacement was submitted.'
  }
  if (attempt.state === 'submitted') return `Paid image replacement was submitted.${quote}${settled}`
  return `Paid image replacement ${attempt.state}.${settled}`
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
  return summariseJobItems(job.item_progress, job.genstudio_jobs, job.music_results_awaiting_import?.length)
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
  // A job waiting for a free Mac is quiet by design; that is not a hang.
  if (latestActiveGenStudioRequest(job)?.waiting || jobCounts(job).waitingForMac) return false
  return isProgressStale(jobLastProgressAt(job), now.value, jobCadenceSeconds(job))
}

function jobExceptions(job: RJob) {
  // Every exception comes from the one derivation. The recovered-subtitle case
  // used to filter out a "gap" line here, but the derivation no longer
  // produces that key — the failed count lives on the card's one summary line
  // instead — so there is nothing left to filter, and a filter for a key that
  // cannot arrive reads as if the key still can.
  return describeJobExceptions({ ...job, genstudio_jobs: settledRemoteJobs(job) }, now.value)
}

/**
 * Is there anything on this card worth saying in ONE line?
 *
 * A card with nothing to report says nothing — an empty summary line is
 * better than a line that repeats the status badge above it. The line carries
 * counts (when the job works through items), the local render's own state
 * (when it has no provider at all), a measured ETA and a freshness reading.
 */
function jobHasSummary(job: RJob): boolean {
  if (job.item_progress && !isVerifiedRecoveredSubtitleJob(job)) return true
  if (finalRenderDetail(job)) return true
  return !!(jobEta(job) || jobFreshness(job))
}

// ── Money, summarised ─────────────────────────────────────────────────────
// Three figures across the whole job. The per-item breakdown lives in the
// ledger inside Technical details.
function settledRemoteJobs(job: RJob) {
  return (job.genstudio_jobs || []).map(remote => ({ ...remote, ...genStudioSettled(remote) }))
}
function jobCreditSummary(job: RJob) {
  const remoteJobs = settledRemoteJobs(job)
  return { ...summariseSettlement(remoteJobs), remoteJobs }
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
const replacementOutcome = ref<Record<string, {
  state: 'checking' | 'queued' | 'blocked' | 'complete'
  text: string
  kind: string
}>>({})
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
const clock = createVisibleInterval(() => { now.value = Date.now() }, 1000)

// Surface the durable Story-side queue hold and keep its status synchronized
// across project and universal Jobs views.
const net = useNetworkStatus()
// `null` is the honest "could not read" state. It is deliberately NOT `false`:
// a two-valued ref fed by a `catch` that keeps the last value renders an
// unreadable queue as "running", which is the §6 zero-that-means-two-things
// defect. See `queueStateUnknown` and the notice below.
const queuePaused = ref<boolean | null>(null)
const queueStateUnknown = computed(() => queuePaused.value === null)
const globalQueueWork = ref<boolean | null>(null)
const resumingQueue = ref(false)
const changingQueueState = ref(false)
const queuePoll = createVisibleInterval(() => { void checkQueuePaused() }, 5000)
let capacityTimer: ReturnType<typeof setInterval> | null = null
const genStudioAdmission = ref<GenStudioAdmissionSnapshot | null>(null)
const capacityReceivedAt = ref<number | null>(null)
const freshQueueAdmission = computed(() => capacityReceivedAt.value !== null
  && now.value - capacityReceivedAt.value >= 0 && now.value - capacityReceivedAt.value <= 30_000)
const verifiedGenStudioAdmission = computed(() => isVerifiedLiveCapacity(genStudioAdmission.value, now.value))
let genStudioCapacityRequest: Promise<void> | null = null

async function checkQueuePaused(): Promise<void> {
  try {
    const r = await get<{ paused: boolean; stats: { queued: number; running: number } }>('/system/queue/status')
    queuePaused.value = !!r.paused
    globalQueueWork.value = r.stats ? r.stats.queued + r.stats.running > 0 : null
  } catch {
    // Backend unreachable: the state is UNKNOWN, not the last answer. Keeping
    // the previous value here is how a failed read silently read as "running".
    queuePaused.value = null
    globalQueueWork.value = null
  }
}

async function refreshGenStudioCapacity(): Promise<void> {
  if (genStudioCapacityRequest) return genStudioCapacityRequest
  genStudioCapacityRequest = (async () => {
    try {
      genStudioAdmission.value = await get<GenStudioAdmissionSnapshot>('/app-settings/genstudio/admission')
      capacityReceivedAt.value = Date.now()
    } catch {
      // Generation remains safe: the backend scheduler uses its conservative
      // fallback while the last visible account snapshot stays on screen.
    }
  })()
  try {
    await genStudioCapacityRequest
  } finally {
    genStudioCapacityRequest = null
  }
}

function refreshVisibleCapacity(): void {
  if (document.visibilityState !== 'hidden') void refreshGenStudioCapacity()
}

async function resumeQueue(): Promise<void> {
  resumingQueue.value = true
  try {
    await post('/system/queue/resume', {})
    await net.refresh()        // re-probe so the indicator + sync state agree
    await checkQueuePaused()
    void refreshGenStudioCapacity()
    if (queuePaused.value === false) success('Job queue resumed')
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
    void refreshGenStudioCapacity()
    success('Queue paused. Waiting jobs will not be submitted.')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to pause the queue')
  } finally {
    changingQueueState.value = false
  }
}

onMounted(() => {
  void genStudioModels.refresh()
  clock.start()
  void checkQueuePaused()
  refreshVisibleCapacity()
  queuePoll.start()
  // Capacity is advisory (the scheduler verifies admission at submission).
  // Keep it within the existing 30s display freshness window without asking
  // GenStudio on every local queue tick, or while this window is hidden.
  capacityTimer = setInterval(refreshVisibleCapacity, 15_000)
  document.addEventListener('visibilitychange', refreshVisibleCapacity)
})
onUnmounted(() => {
  if (isUniversal.value) universalQueue.stop()
  clock.stop()
  queuePoll.stop()
  if (capacityTimer) clearInterval(capacityTimer)
  document.removeEventListener('visibilitychange', refreshVisibleCapacity)
})

// Post-bulk banner: show when a pipeline batch has completed (all its
// jobs settled into done/error/cancelled) and there are no more pipeline
// chain jobs running. Dismissed for the session once the user clicks ✕
// or navigates to Assets — dismissal is in-memory only, so a reload
// re-derives the summary from jobs.json and shows it again.
const bulkBannerDismissed = ref(false)

// Restart notices are informational; actions always live in the toolbar.
const restartBannerDismissed = ref(false)
const INTERRUPTED_ERROR_TEXT = 'Interrupted by app restart'
const interruptedJobs = computed(() =>
  projectScopedJobs.value.filter((j: RJob) => j.status === 'error' && j.error === INTERRUPTED_ERROR_TEXT)
)

// v1.0.x — bulk "Repair all failed": every failed/cancelled job whose type has
// a repair path (audio/images/video). Free (poll + download only, never
// re-submits), so it's the safe "recover everything the providers already
// finished" one-click. Genuinely-missing items stay failed for a later Retry.
const repairingAllFailed = ref(false)
const repairableFailedJobs = computed(() =>
  projectScopedJobs.value.filter((j: RJob) => (jobDisplayStatus(j) === 'error' || j.status === 'cancelled') && jobCanBeRepaired(j))
)
async function repairAllFailed(chained = false, only?: RJob[]) {
  if (bulkActionBusy.value && !chained) return
  const snapshot = only || [...repairableFailedJobs.value]
  if (snapshot.length === 0) return
  if (!chained && !await useConfirm().ask(bulkConfirmOptions('repair', snapshot.length))) return
  repairingAllFailed.value = true
  let failed = 0
  try {
    const CONCURRENCY = 3
    let cursor = 0
    async function worker() {
      while (cursor < snapshot.length) {
        const idx = cursor++
        if (idx >= snapshot.length) return
        try { if (await withinCheckTime(repairJobOnly(snapshot[idx]!, false)) !== true) failed++ }
        catch { failed++ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, snapshot.length) }, () => worker()))
    if (!chained) {
      bulkActionMessage.value = `Checked ${snapshot.length} job(s); ${failed} checks could not finish. Cards show each result. Retry remains a separate action.`
      info(bulkActionMessage.value)
    }
  } finally {
    repairingAllFailed.value = false
  }
}
// Each step of a bulk check gets a fixed time; the work itself carries on in
// the background and its card updates when it lands. Never an unbounded spin.
const CHECK_STEP_TIMEOUT_MS = 45_000
function withinCheckTime<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), CHECK_STEP_TIMEOUT_MS) })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
// A repairable job the check has not got an answer for yet (no record, or the
// last repair could not finish). Measured/inconclusive ones are settled facts.
function needsRepairCheck(job: RJob): boolean {
  const record = repairState.value[job.job_id]
  return !record || record.outcome === 'failed'
}

// ── Retry all ─────────────────────────────────────────────────────────────
// v1.4.32 — the owner's design, agreed 2026-08-22: two buttons he presses
// himself rather than one that chains. The chain is the thing that already
// burned him — v1.0.114 removed "Repair & Retry all" after its repair half
// failing and its retry half firing anyway produced real duplicate charges.
//
// This button never repairs. It sorts what is
// failed into three piles and requeues only the pile whose state is
// definitely known. Continuity rows use their explicit Finish action; everything it declines is named, with the reason, so
// declining is visible rather than silent.
//
// Rejected on the way here: a global grey-out until a repair has run (wrong for
// the 32 job types that have no repair path at all, subtitles among them). A
// confirmation was rejected too, then approved by the owner on 2026-10-07: it
// states the count and whether paid work is included; the triage still decides.
interface RetryAllAction {
  index: number
  key: string
  label: string
  projectSlug: string
  episodeId: string
  sourceJobIds?: string[]
  job?: RJob
}
interface RetryAllResult {
  index: number
  key: string
  label: string
  kind: 'sent' | 'already-complete' | 'needs-attention'
  status: string
  reason: string
}

const retryingAllFailed = ref(false)
const retryAllRun = ref<{
  total: number
  completed: number
  current: Array<{ key: string; label: string }>
  results: RetryAllResult[]
} | null>(null)
function isTerminalContinuityRender(job: RJob): boolean {
  return job.type === 'continuity_render'
    && !!job.episode_id
    && (job.status === 'error' || job.status === 'cancelled')
}
// A finished job whose provider work GenStudio has not confirmed as settled.
// The backend refuses its Retry with a 409 ("unsettled provider evidence"), so
// Retry Failed Jobs leaves it for "Check Running Jobs" instead of counting a dead end.
function waitsForProviderCheck(job: RJob): boolean {
  return ['done', 'error', 'cancelled'].includes(job.status)
    && jobControls(job).some(control => control.action === 'recheck-provider-status' || control.action === 'return-later')
}
const failedJobsForRetryAll = computed(() =>
  projectScopedJobs.value.filter((j: RJob) =>
    (j.status === 'error' || j.status === 'cancelled')
    && !isRecoveredFailure(j)
    // A step the channel's own settings switch off is skipped, not failed
    // (AGENTS.md §8): retrying it would only skip it again, so Retry Failed
    // Jobs must not count it.
    && !isSkippedJob(j)
    && j.params?.auto_repair_missing_prompts !== true
    // Q-06 — bulk Retry must apply the same admission filter as the per-row
    // button and the backend, or it counts jobs it can only 409 on.
    && retryAdmissionAllowed(j)
    && (!j.params?.jobs_replace_failed_items || canRetryManualFailedItemExactly(j))
    && !waitsForProviderCheck(j))
)
const failedWaitingForCheck = computed(() => projectScopedJobs.value.filter((j: RJob) =>
  (j.status === 'error' || j.status === 'cancelled') && waitsForProviderCheck(j)))
const retryAllTriage = computed(() => triageFailedJobsForRetryAll(
  failedJobsForRetryAll.value as RJob[],
  (j: RJob) => jobCanBeRepaired(j),
  (jobId: string) => repairState.value[jobId],
))
const retryAllTooltip = computed(() => describeRetryAllTriage(retryAllTriage.value as any))
const retryAllCurrentEpisodes = computed(() => retryAllRun.value?.current.map(item => item.label) || [])
const retryAllCounts = computed(() => {
  const results = retryAllRun.value?.results || []
  return {
    sent: results.filter(result => result.kind === 'sent').length,
    alreadyComplete: results.filter(result => result.kind === 'already-complete').length,
    needsAttention: results.filter(result => result.kind === 'needs-attention').length,
  }
})
const retryAllAttentionResults = computed(() => (retryAllRun.value?.results || [])
  .filter(result => result.kind === 'needs-attention')
  .sort((a, b) => a.index - b.index))
const retryAllButtonLabel = computed(() => retryingAllFailed.value && retryAllRun.value
  ? `Retrying ${retryAllRun.value.completed}/${retryAllRun.value.total}…`
  : `Retry Failed Jobs (${retryAllTriage.value.retry.length})`)
const retryAllStatusMessage = computed(() => {
  const run = retryAllRun.value
  if (!retryingAllFailed.value || !run) return bulkActionMessage.value
  const current = retryAllCurrentEpisodes.value
  return `Retry Failed Jobs: ${run.completed} of ${run.total} finished${current.length ? ` · working on ${current.join(', ')}.` : '.'}`
})

// ── Check Running Jobs ───────────────────────────────────────────────
// The first of the two main buttons (owner, 2026-10-03). It chains only the
// FREE actions — re-ask GenStudio about finished-but-unsettled jobs, Repair
// (recorded requests) and Recover (episode files) — and never Retry: chaining
// a paid resubmit onto a check is what v1.0.114 removed after duplicate charges.
const recheckingAll = ref(false)
const checkingAll = ref(false)
// Every finished job still waiting on the Gateway — including the ones whose
// automatic check has not answered yet ('return-later'). Redo counts those as
// "waiting for Check Running Jobs", so the check must ask about them too.
const providerCheckJobs = computed(() => projectScopedJobs.value.filter(waitsForProviderCheck))
// Job ids the last check asked about. A job it looked at is never again told to
// "wait for Check Running Jobs" — it gets its own reason.
const checkLookedAt = ref<Set<string>>(new Set())
const checkAction = computed(() => checkRunningJobsAction({
  unsettled: providerCheckJobs.value.length,
  repairable: repairableFailedJobs.value.filter(needsRepairCheck).length,
  episodes: recoverableEpisodes.value.filter(job => !episodesLookedAt.value.has(episodeRecoveryKey(job))).length,
  running: projectScopedJobs.value.filter(job => job.status === 'running').length,
}, { self: checkingAll.value, other: bulkActionBusy.value && !checkingAll.value }))
const redoHolds = computed(() => {
  const reasons: HoldReason[] = [
    ...retryAllTriage.value.blocked.map(({ job, reason }) => reason === 'never_repaired' && !checkLookedAt.value.has(job.job_id)
      ? 'waiting-for-check' as const : 'could-not-check' as const),
    ...failedWaitingForCheck.value.map(job => providerHoldReason(job.history_evidence_check?.state, checkLookedAt.value.has(job.job_id))),
  ]
  return (reason: HoldReason) => reasons.filter(r => r === reason).length
})
const redoAction = computed(() => redoFailedJobsAction({
  redo: retryAllTriage.value.retry.length,
  waitingForCheck: redoHolds.value('waiting-for-check'),
  stillRunning: redoHolds.value('still-running'),
  couldNotCheck: redoHolds.value('could-not-check'),
  alreadyComplete: retryAllTriage.value.alreadyComplete.length,
}, {
  self: retryingAllFailed.value,
  other: bulkActionBusy.value && !retryingAllFailed.value,
  progress: retryingAllFailed.value ? retryAllButtonLabel.value : undefined,
}))

async function recheckAllProviderStatus(snapshot: RJob[]): Promise<void> {
  recheckingAll.value = true
  try {
    let cursor = 0
    async function worker() {
      while (cursor < snapshot.length) {
        const job = snapshot[cursor++]!
        try {
          const response = await withinCheckTime(post<{ job?: RJob }>(`${jobQueuePath(job)}/recheck-provider-status`, {}))
          if (response?.job) { projectQueue.applyUpdate(response.job as Job); universalQueue.applyUpdate(response.job as Job) }
        } catch (e: any) {
          console.warn('[check-all] recheck failed:', e?.data?.detail || e?.message)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, snapshot.length) }, () => worker()))
  } finally { recheckingAll.value = false }
}

/** Settle failed rows whose files were all made later (backend reads disk only). */
async function settleCompletedFailures(): Promise<string[]> {
  const projects = [...new Set(projectScopedJobs.value
    .filter(job => job.status === 'error').map(jobProjectSlug).filter(project => project && project !== '_app_'))]
  const resolved: string[] = []
  for (const project of projects) {
    try {
      const response = await withinCheckTime(post<{ resolved?: string[] }>(`/projects/${project}/jobs/settle-completed`, {}))
      resolved.push(...(response?.resolved || []))
    } catch (e: any) {
      console.warn('[check-all] settle failed:', e?.data?.detail || e?.message)
    }
  }
  return resolved
}

// Collects and settles only — it never starts generation (Redo does that, and
// chaining the two is what v1.0.114 removed after duplicate charges). It ends
// with ONE plain line, and every job it looked at leaves the "waiting for the
// check" pile: settled, redo-able, or held with its own reason.
async function checkOnRunningJobs() {
  if (bulkActionBusy.value || checkAction.value.disabled) return
  checkingAll.value = true
  try {
    const providerJobs = [...providerCheckJobs.value]
    const repairJobs = repairableFailedJobs.value.filter(needsRepairCheck)
    const episodeJobs = recoverableEpisodes.value.filter(job => !episodesLookedAt.value.has(episodeRecoveryKey(job)))
    const episodeKeys = new Set(episodeJobs.map(episodeRecoveryKey))
    const lookedAt = new Set([
      ...providerJobs, ...repairJobs,
      ...projectScopedJobs.value.filter(job => canRecoverEpisode(job) && episodeKeys.has(episodeRecoveryKey(job))),
    ].map(job => job.job_id))
    if (providerJobs.length) await recheckAllProviderStatus(providerJobs)
    if (repairJobs.length) await repairAllFailed(true, repairJobs)
    const imagesQueued = episodeJobs.length ? await recoverAllEpisodes(true, episodeJobs) : 0
    for (const id of await settleCompletedFailures()) lookedAt.add(id)
    await refreshVisibleJobs()
    checkLookedAt.value = new Set([...checkLookedAt.value, ...lookedAt])
    const outcomes = jobs.value.filter(job => lookedAt.has(job.job_id)).map(job => classifyCheckedJob({
      displayStatus: jobDisplayStatus(job),
      hold: waitsForProviderCheck(job) ? providerHoldReason(job.history_evidence_check?.state, true) : undefined,
      repair: repairState.value[job.job_id],
      repairable: jobCanBeRepaired(job) && (job.status === 'error' || job.status === 'cancelled'),
    }))
    bulkActionMessage.value = describeCheckResult(outcomes, imagesQueued)
    info(bulkActionMessage.value)
  } finally { checkingAll.value = false }
}

function retryAllAttentionLabel(result: RetryAllResult): string {
  if (result.status === 'paused') return 'Paused'
  if (result.status === 'blocked') return 'Blocked'
  if (result.status === 'unconfirmed') return 'Result unconfirmed'
  return 'Could not send'
}

async function retryAllFailed() {
  if (bulkActionBusy.value) return false
  const triage = retryAllTriage.value
  if (triage.retry.length === 0) {
    // Never silently do nothing. If everything is held back, say so and point
    // at the free action that would unblock it.
    if (triage.blocked.length > 0) {
      info(describeRetryAllTriage(triage as any))
    } else if (triage.alreadyComplete.length > 0) {
      success('Nothing to retry — every job needing attention already had its files on disk after a repair. You can dismiss them.')
    } else {
      info('No jobs need another try.')
    }
    return false
  }
  const paid = (triage.retry as RJob[]).filter(isPaidWork).length
  if (!await useConfirm().ask(bulkConfirmOptions('retry', triage.retry.length, paid))) return false
  if (bulkActionBusy.value) return false
  const directContinuityRetries = (triage.retry as RJob[]).filter(isTerminalContinuityRender)
  const grouped = groupEpisodeRecoveryRetries((triage.retry as RJob[]).filter(job => !isTerminalContinuityRender(job)))
  const snapshot = [...directContinuityRetries, ...grouped.other]
  const actions: RetryAllAction[] = [
    ...grouped.episodes.map(episode => ({
      projectSlug: episode.project_slug,
      episodeId: episode.episode_id,
      sourceJobIds: episode.source_job_ids,
      job: undefined,
    })),
    ...snapshot.map(job => ({ projectSlug: jobProjectSlug(job), episodeId: job.episode_id, sourceJobIds: undefined, job })),
  ].map((action, index) => ({
    ...action,
    index,
    key: action.job ? `job:${action.job.job_id}` : `episode:${action.projectSlug}:${action.episodeId}`,
    label: isUniversal.value ? `${projectName(action.projectSlug)} / ${action.episodeId}` : action.episodeId,
  }))
  retryingAllFailed.value = true
  retryAllRun.value = { total: actions.length, completed: 0, current: [], results: [] }
  bulkActionMessage.value = ''
  info(describeRetryAllTriage(triage as any))
  try {
    // Grouped episode plans and ordinary retries share the same request pool.
    // One episode plan still owns all dependent rows for that episode.
    const CONCURRENCY = 3
    let cursor = 0
    async function worker() {
      while (cursor < actions.length) {
        const idx = cursor++
        if (idx >= actions.length) return
        const action = actions[idx]!
        retryAllRun.value!.current.push({ key: action.key, label: action.label })
        const result: RetryAllResult = {
          index: action.index,
          key: action.key,
          label: action.label,
          kind: 'needs-attention',
          status: 'request-failed',
          reason: 'Story Studio could not confirm this retry was queued.',
        }
        try {
          if (action.sourceJobIds) {
            const response = await post<{ plan?: {
              dispatch_status?: 'queued' | 'running' | 'paused' | 'blocked' | 'complete'
              message?: string
            } }>(`/projects/${action.projectSlug}/jobs/recover-episode/${action.episodeId}`, { source_job_ids: action.sourceJobIds })
            const status = response?.plan?.dispatch_status
            result.status = status || 'unconfirmed'
            result.reason = customerSafeJobText(response?.plan?.message, action.sourceJobIds)
              || 'Story Studio accepted the request but did not confirm what happened next.'
            if (status === 'queued' || status === 'running') result.kind = 'sent'
            else if (status === 'complete') result.kind = 'already-complete'
          } else {
            const sent = isTerminalContinuityRender(action.job!)
              ? await finishMissingImages(action.job!, false)
              : await retryJob(action.job!)
            if (sent) {
              result.kind = 'sent'
              result.status = 'queued'
              result.reason = 'Queued.'
            }
          }
        } catch (e: any) {
          const message = e?.data?.detail || e?.message || 'Story Studio could not send this retry.'
          result.reason = action.job
            ? customerJobText(message, action.job)
            : customerSafeJobText(message, action.sourceJobIds || [])
          console.warn('[retry-all] retry failed:', result.reason)
        }
        const run = retryAllRun.value!
        run.current.splice(run.current.findIndex(item => item.key === action.key), 1)
        run.results.push(result)
        run.completed++
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, actions.length) }, () => worker()))
    await refreshVisibleJobs()
    const { sent, alreadyComplete, needsAttention } = retryAllCounts.value
    bulkActionMessage.value = `Retry Failed Jobs finished: ${sent} queued or running; ${alreadyComplete} already complete; ${needsAttention} need attention. Original failed rows may remain in history.`
    if (retryAllCounts.value.needsAttention > 0) showError(bulkActionMessage.value)
    else success(bulkActionMessage.value)
    return true
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
// F-11 — labels come from the ONE authoritative map in
// `~/utils/job-presentation` (`jobTypeLabel` / `jobDisplayLabel`). This page
// used to keep a fourth hand-maintained copy, which is how live types drifted
// into rendering as raw slugs here, in the toasts and in the episode dropdown.

// ── Filter tabs ─────────────────────────────────────────────────────────

const activeFilter = ref('all')
const projectScopedJobs = computed(() => {
  if (!isUniversal.value || projectFilter.value === 'all') return jobs.value
  return jobs.value.filter(job => job.project_slug === projectFilter.value)
})
const HIDDEN_JOBS_KEY = 'story-studio:hidden-jobs:v1'
const showHidden = ref(false)
const hiddenJobIds = ref(new Set(loadHiddenJobIds()))

function loadHiddenJobIds(): string[] {
  try {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(HIDDEN_JOBS_KEY)
    const parsed = saved ? JSON.parse(saved) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}

function saveHiddenJobIds(next: Set<string>) {
  hiddenJobIds.value = next
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(HIDDEN_JOBS_KEY, JSON.stringify([...next]))
  } catch { /* hiding stays local to this visit */ }
}

function isJobHidden(job: RJob): boolean { return hiddenJobIds.value.has(job.job_id) }
function canHideJob(job: RJob): boolean { return ['done', 'recovered', 'skipped'].includes(jobDisplayStatus(job)) }
function restoreJob(job: RJob) {
  const next = new Set(hiddenJobIds.value)
  next.delete(job.job_id)
  saveHiddenJobIds(next)
}
function hideJob(job: RJob) {
  if (isJobHidden(job) || !canHideJob(job)) return
  const next = new Set(hiddenJobIds.value)
  next.add(job.job_id)
  saveHiddenJobIds(next)
  successUndoable({ message: 'Hidden from Jobs.', onUndo: () => restoreJob(job) })
}

/** Hide follows the backend: a Hide for a row that is gone goes with it. */
function forgetHiddenJob(jobId: string) {
  if (!hiddenJobIds.value.has(jobId)) return
  const next = new Set(hiddenJobIds.value)
  next.delete(jobId)
  saveHiddenJobIds(next)
}

/**
 * Drop the Hides for rows the backend no longer holds.
 *
 * Scoped to the rows this page showed for the cleared subset: a Hide for
 * another channel's row is none of this read's business. A row the backend
 * dropped is gone, so its Hide is stale — keeping it would leave the hidden
 * count naming a row that is not there.
 */
function forgetHiddenJobsAbsentFromBackend(candidates: readonly string[]) {
  if (history.error.value || !candidates.length) return
  const known = new Set([...history.rows.value, ...streamedJobs.value].map(job => job.job_id))
  const stale = candidates.filter(jobId => !known.has(jobId))
  if (!stale.length) return
  const next = new Set(hiddenJobIds.value)
  for (const jobId of stale) next.delete(jobId)
  saveHiddenJobIds(next)
}

// A hidden card never hides a new actionable failure. Recovered subtitle
// attempts retain their raw error for diagnostics, so the display status is
// the authority for whether the row needs attention.
function isActionableHiddenFailure(job: RJob): boolean {
  return isJobHidden(job) && jobDisplayStatus(job) === 'error'
}
function restoreActionableFailures(jobIds: readonly string[]) {
  if (!jobIds.length) return
  const next = new Set(hiddenJobIds.value)
  for (const jobId of jobIds) next.delete(jobId)
  saveHiddenJobIds(next)
}
const actionableHiddenFailureIds = computed(() => jobs.value
  .filter(isActionableHiddenFailure)
  .map(job => job.job_id))
watch(actionableHiddenFailureIds, restoreActionableFailures)

const hiddenJobsInScope = computed(() => projectScopedJobs.value.filter(isJobHidden))
const hiddenSettlingCount = computed(() => hiddenJobsInScope.value.filter(job =>
  Boolean(job.genstudio_jobs?.length) && !isFreeFleetWork(job.genstudio_jobs)
    && !summariseSettlement(settledRemoteJobs(job)).confirmed,
).length)
const presentationScopedJobs = computed(() => showHidden.value
  ? projectScopedJobs.value
  : projectScopedJobs.value.filter(job => !isJobHidden(job)))
const stats = computed(() => {
  const scoped = projectScopedJobs.value
  const recovered = scoped.filter(job => jobDisplayStatus(job) === 'recovered').length
  // A skipped optional step is not a failure and needs nothing from the owner
  // (AGENTS.md §8), so it is counted apart from "Needs attention".
  const skipped = scoped.filter(job => jobDisplayStatus(job) === 'skipped').length
  return {
    ...queueStats.value,
    running: scoped.filter(job => job.status === 'running').length,
    queued: scoped.filter(job => job.status === 'queued').length,
    paused: scoped.filter(job => job.status === 'paused').length,
    done: scoped.filter(job => job.status === 'done').length,
    error: scoped.filter(job => jobDisplayStatus(job) === 'error').length,
    total: scoped.length,
    recovered,
    skipped,
  }
})
const typeScopedJobs = computed(() => activeFilter.value === 'all'
  ? presentationScopedJobs.value
  : presentationScopedJobs.value.filter(job => job.type === activeFilter.value))
// v1.0.x — status filter (independent of the type tabs).
const statusFilter = ref<'all' | 'running' | 'queued' | 'paused' | 'error' | 'done' | 'recovered' | 'cancelled' | 'skipped'>('all')
function toggleHiddenJobs() {
  showHidden.value = !showHidden.value
  if (showHidden.value) {
    activeFilter.value = 'all'
    statusFilter.value = 'all'
    failureBatchFilter.value = null
  }
}
const failureBatchFilter = ref<string | null>(null)
const historySection = ref<HTMLElement | null>(null)
const historyHeading = ref<HTMLElement | null>(null)
const STATUS_FILTERS: Array<{ key: typeof statusFilter.value; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'paused', label: 'Paused' },
  { key: 'error', label: 'Needs attention' },
  { key: 'done', label: 'Done' },
  { key: 'recovered', label: 'Recovered' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'cancelled', label: 'Cancelled' },
]
// `?status=error` (the dashboard's "Repair N failed jobs" link) opens the list already filtered.
function statusFromQuery(value: unknown): typeof statusFilter.value | null {
  const key = Array.isArray(value) ? value[0] : value
  return STATUS_FILTERS.some(s => s.key === key) ? key as typeof statusFilter.value : null
}
watch(() => route.query.status, value => {
  const next = statusFromQuery(value)
  if (next) statusFilter.value = next
}, { immediate: true })
// Search by episode code or title. `?episode_id=EP0123` opens it prefilled, and
// typing mirrors back into the URL (replace, not push) so Back and refresh keep it.
const episodeSearch = ref(episodeQueryValue(route.query.episode_id))
watch(() => route.query.episode_id, value => { episodeSearch.value = episodeQueryValue(value) })
watch(episodeSearch, value => {
  currentPage.value = 1
  const next = value.trim() || undefined
  if (next !== (episodeQueryValue(route.query.episode_id) || undefined)) {
    void router.replace({ query: { ...route.query, episode_id: next } })
  }
})
const statusFilters = computed(() => STATUS_FILTERS.map(s => ({
  ...s,
  count: s.key === 'all'
    ? typeScopedJobs.value.length
    : typeScopedJobs.value.filter(j => jobDisplayStatus(j) === s.key).length,
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
    { type: 'introduction-only',    label: 'Introductions' },
    { type: 'chapter-only',         label: 'Chapter Regen' },
    { type: 'research_run',         label: 'Research' },
    { type: 'metadata',             label: 'YouTube Finalizer' },
    { type: 'image_prompts',        label: 'Prompts' },
    { type: 'scene_plan_run',       label: 'Scene Plan' },
    { type: 'contextual_cues',       label: 'Sound & Labels' },
    { type: 'continuity_render',    label: 'Scene Review' },
    { type: 'thumb_images',         label: 'Thumb Images' },
    { type: 'images_repair',        label: 'Image Repair' },
    { type: 'scene_clips_batch',    label: 'Motion Review' },
    { type: 'audio',                label: 'Audio' },
    { type: 'audio_merge',          label: 'Audio Assembly' },
    { type: 'video_assembly',       label: 'Video Assembly' },
    { type: 'subtitles_transcribe', label: 'Subtitles' },
    { type: 'youtube_upload',       label: 'YouTube' },
  ]
  const knownTypes = new Set(types.map(tab => tab.type))
  // Discovered kinds join in a fixed alphabetical order, not in whichever
  // order a live update happened to first mention them.
  const extra: Array<{ type: string, label: string }> = []
  for (const type of projectScopedJobs.value.map(job => job.type)) {
    if (knownTypes.has(type)) continue
    knownTypes.add(type)
    extra.push({ type, label: jobTypeLabel(type) })
  }
  extra.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
  types.push(...extra)
  return types.map(t => ({
    ...t,
    count: t.type === 'all'
      ? projectScopedJobs.value.filter(j => ['running', 'queued', 'paused'].includes(j.status)).length
      : projectScopedJobs.value.filter(j => j.type === t.type && ['running', 'queued', 'paused'].includes(j.status)).length,
  }))
})

const filterLabel = computed(() => filterTabs.value.find(t => t.type === activeFilter.value)?.label || '')

const emptyState = computed(() => jobsEmptyState({
  hiddenInScope: hiddenJobsInScope.value.length,
  showHidden: showHidden.value,
  scopedJobs: presentationScopedJobs.value.length,
  typeFilter: activeFilter.value,
  typeLabel: filterLabel.value,
  statusFilter: statusFilter.value,
  batchFilter: failureBatchFilter.value,
  universal: isUniversal.value,
}))
const emptyTitle = computed(() => emptyState.value.title)
const emptyMessage = computed(() => emptyState.value.message)

// ── Sorting ─────────────────────────────────────────────────────────────

const sortKey = ref('queue')
const sortDir = ref<'asc' | 'desc'>('asc')

const sortColumns = [
  { key: 'queue', label: 'Queue' },
  { key: 'project_slug', label: 'Channel' },
  { key: 'status', label: 'Status' },
  { key: 'type', label: 'Type' },
  { key: 'episode_id', label: 'Episode' },
  { key: 'created_at', label: 'Created' },
]

function toggleSort(key: string) {
  // The queue order is the page's stable default and has no reverse.
  if (key === 'queue') {
    sortKey.value = 'queue'
    sortDir.value = 'asc'
    return
  }
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = key === 'created_at' ? 'desc' : 'asc'
  }
}

// ── Filtered + Sorted + Paginated ───────────────────────────────────────

const filteredJobs = computed(() => {
  return filterJobsForView(typeScopedJobs.value, {
    type: 'all',
    status: statusFilter.value,
    project: 'all',
    batch: failureBatchFilter.value,
  }).filter(job => matchesEpisodeSearch(job, episodeSearch.value))
})

const sortedJobs = computed(() => {
  const list = [...filteredJobs.value]
  // One deterministic default: running, queued in true dispatch order per
  // kind, paused, then finished newest-first. A live update replaces a row;
  // it can never reorder the rows around it.
  if (sortKey.value === 'queue') {
    return orderJobsForDisplay(list, filterTabs.value.map(tab => tab.type))
  }
  const dir = sortDir.value === 'asc' ? 1 : -1

  list.sort((a, b) => {
    if (sortKey.value === 'status') {
      const order: Record<string, number> = { running: 0, paused: 1, queued: 2, error: 3, done: 4, recovered: 5, cancelled: 6 }
      return ((order[jobDisplayStatus(a)] ?? 6) - (order[jobDisplayStatus(b)] ?? 6)) * dir
        || (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0)
    }
    const aVal = (a as any)[sortKey.value] || ''
    const bVal = (b as any)[sortKey.value] || ''
    return (aVal < bVal ? -dir : aVal > bVal ? dir : 0)
      || (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0)
  })

  return list
})

const currentPage = ref(1)

const activeJobs = computed(() => {
  const list = sortedJobs.value.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'paused')
  // Pin running → queued → paused regardless of the user's sort-column pick.
  // The chosen sort still governs order WITHIN each group (stable sort
  // preserves sortedJobs's relative order for ties), so the Active section
  // reads top-to-bottom as "executing now" → "what runs next" → "held".
  return list.slice().sort((a, b) => {
    const rank = (s: string) => s === 'running' ? 0 : s === 'queued' ? 1 : 2
    return rank(a.status) - rank(b.status)
  })
})
const historyJobs = computed(() =>
  sortedJobs.value.filter(j => j.status !== 'running' && j.status !== 'queued' && j.status !== 'paused')
)
const historyTotalPages = computed(() => pageCount(historyJobs.value.length))
const paginatedHistory = computed(() => pageSlice(historyJobs.value, currentPage.value))
// A busy queue can hold hundreds of active rows; show the first 25 until asked.
const showAllActive = ref(false)
const visibleActiveJobs = computed(() => capList(activeJobs.value, showAllActive.value))

// Full records for: the cards on screen, failed rows whose bulk Retry admission reads their
// evidence, and hidden rows that may still be settling (the "N hidden jobs are still settling" count).
const detailJobIds = computed(() => new Set([
  ...visibleActiveJobs.value, ...paginatedHistory.value,
  ...projectScopedJobs.value.filter(job => (job.status === 'error' || job.status === 'cancelled') && job.params?.jobs_replace_failed_items),
  ...hiddenJobsInScope.value.filter(job => job.genstudio_settlement_open || job.genstudio_jobs?.length),
].map(job => job.job_id)))
watch([streamedJobs, detailJobIds], ([list, ids]) => {
  jobDetails.ensure(list.filter(job => ids.has(job.job_id)))
}, { immediate: true })
onUnmounted(() => jobDetails.stop())

// Reset page when either filter changes
watch(activeFilter, () => { currentPage.value = 1 })
watch(statusFilter, () => { currentPage.value = 1 })
watch(projectFilter, () => { currentPage.value = 1 })
watch(historyTotalPages, total => { currentPage.value = Math.min(currentPage.value, total) })

const removableJobs = computed(() => projectScopedJobs.value.filter(job =>
  ['done', 'error', 'cancelled'].includes(job.status)
  && jobControls(job).some(control => control.enabled && control.action === 'clear-history')))
// The same split the server's bulk clear uses (`matchesHistoryClearStatus`), not
// the display badge: a raw error the page reads as "skipped" is removed by the
// Failed action, so the number on the button must be the number that disappears.
const finishedCount = computed(() => removableJobs.value.filter(job =>
  job.status !== 'error' || isRecoveredFailure(job)).length)
const failedCount = computed(() => removableJobs.value.filter(job =>
  job.status === 'error' && !isRecoveredFailure(job)).length)
const actionScopeLabel = computed(() => !isUniversal.value ? projectName(slug.value)
  : projectFilter.value === 'all' ? 'All channels' : projectFilter.value === '_app_' ? 'App tools' : projectName(projectFilter.value))
const hasQueueWork = computed(() => globalQueueWork.value !== false || jobs.value.some(job => ['queued', 'running'].includes(job.status)))
const clearingHistory = ref<'finished' | 'failed' | null>(null)
const bulkActionMessage = ref('')
const bulkActionBusy = computed(() => checkingAll.value || recheckingAll.value || recoveringAllEpisodes.value || recoveringEpisodes.value.size > 0
  || repairingAllFailed.value || repairingJobs.value.size > 0 || retryingAllFailed.value || bulkResumeBusy.value || clearingHistory.value !== null || clearingSelected.value)

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

/**
 * Pull the most recent "N / Total" or "Chapter 3/13" style marker from a
 * running job's output lines. A history row carries the server's answer in
 * `progress_counter` instead of its log; a live row still computes it here.
 */
function progressCounter(job: RJob): string | null {
  return rowProgressCounter(job as any)
}

function hasMoreErrorLines(err: string): boolean {
  return (err || '').split('\n').filter(l => l.trim()).length > 1
}

// ── Summary line ────────────────────────────────────────────────────────

function getSummaryLine(job: RJob): string {
  // A run that finished but discarded requested output outranks any success
  // line. Without this a degraded render collapsed to a plain "Completed in
  // 12m" card, so a video missing its cues and subtitles looked identical to
  // a clean one unless the user expanded the full log.
  const degraded = (job as any).result?.degraded
  if (degraded?.dropped?.length) {
    return `⚠ Completed WITHOUT: ${degraded.dropped.join(', ')} — recovered via ${degraded.tier}`
  }
  // A history row carries the server's own answer — the same rule over the same
  // log, computed where the log still is — so the page never needs the lines.
  const line = rowSummaryLine(job as any)
  if (line) return customerJobText(line, job)
  return `Completed in ${formatJobDuration(job)} (${rowOutputLineCount(job as any)} steps)`
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
  // A history row's folder is resolved server-side from the same log (and the
  // same legacy-path fallback), so the row does not have to carry the lines.
  return deriveOutputDir(job as any)
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
const bulkResumeBusy = ref(false)
const bulkResumeCount = ref(0)
const selectedCleanupIds = ref(new Set<string>())
const clearingSelected = ref(false)
const cleanupProgress = ref('')
const cleanupFailures = ref<{ label: string; reason: string }[]>([])
const eligibleCleanupJobs = computed(() => filteredJobs.value.filter(job => jobCleanupAction(job) && !controlBusy.value.has(job.job_id)))
const attentionCleanupCount = computed(() => eligibleCleanupJobs.value.filter(job => jobDisplayStatus(job) === 'error').length)
const selectedCleanupJobs = computed(() => eligibleCleanupJobs.value.filter(job => selectedCleanupIds.value.has(job.job_id)))

watch([slug, isUniversal, projectFilter, activeFilter, statusFilter, failureBatchFilter, episodeSearch], () => {
  selectedCleanupIds.value = new Set()
})

function jobCleanupAction(job: RJob): 'clear-history' | 'force-abandon' | null {
  const controls = jobControls(job)
  if (controls.some(control => control.enabled && control.action === 'clear-history')) return 'clear-history'
  return controls.some(control => control.enabled && control.action === 'force-abandon') ? 'force-abandon' : null
}

function selectCleanupJobs(attentionOnly: boolean) {
  if (bulkActionBusy.value) return
  selectedCleanupIds.value = new Set(eligibleCleanupJobs.value
    .filter(job => !attentionOnly || jobDisplayStatus(job) === 'error').map(job => job.job_id))
}

function toggleCleanupJob(job: RJob) {
  if (bulkActionBusy.value || controlBusy.value.has(job.job_id) || !jobCleanupAction(job)) return
  const next = new Set(selectedCleanupIds.value)
  if (next.has(job.job_id)) next.delete(job.job_id)
  else next.add(job.job_id)
  selectedCleanupIds.value = next
}

async function abandonAndClearSelected() {
  if (bulkActionBusy.value || clearingSelected.value || !selectedCleanupJobs.value.length) return
  const selected = [...selectedCleanupJobs.value]
  const scope = actionScopeLabel.value
  const reasons = [...new Set(selected.flatMap(job => jobCleanupAction(job) === 'force-abandon'
    ? jobControls(job).filter(control => control.action === 'force-abandon').map(control => control.reason) : []))]
  clearingSelected.value = true
  try {
    const { ask } = useConfirm()
    if (!await ask({
      title: `Abandon and remove ${selected.length} selected job${selected.length === 1 ? '' : 's'} from the list?`,
      message: `${scope}: only these ${selected.length} selected job rows will be removed. Files and billing records stay intact.${reasons.length ? `\n\n${reasons.join('\n')}` : ''}`,
      confirmLabel: 'Abandon and Remove From List',
    })) return
    cleanupFailures.value = []
    // A history read begun before this bulk clear may still carry rows it removes.
    history.invalidate()
    controlBusy.value = new Set([...controlBusy.value, ...selected.map(job => job.job_id)])
    let cleared = 0
    for (const [index, job] of selected.entries()) {
      const label = `${projectName(jobProjectSlug(job))} · ${job.episode_id || job.title || job.type}`
      cleanupProgress.value = `${scope}: ${index + 1} of ${selected.length} · ${label}`
      try {
        if (jobCleanupAction(job) === 'force-abandon') {
          const response = await post<{ job: Job }>(`${jobQueuePath(job)}/abandon`, {})
          projectQueue.applyUpdate(response.job)
          universalQueue.applyUpdate(response.job)
        }
        await del(jobQueuePath(job))
        projectQueue.removeJobs([job.job_id])
        universalQueue.removeJobs([job.job_id])
        history.removeIds([job.job_id])
        const next = new Set(selectedCleanupIds.value)
        next.delete(job.job_id)
        selectedCleanupIds.value = next
        cleared++
      } catch (error: any) {
        cleanupFailures.value.push({ label, reason: customerJobText(error?.data?.detail || error?.message || 'Could not clear this job.', job) })
      } finally {
        const next = new Set(controlBusy.value)
        next.delete(job.job_id)
        controlBusy.value = next
      }
    }
    cleanupProgress.value = `${scope}: cleared ${cleared} of ${selected.length} selected jobs.${cleanupFailures.value.length ? ` ${cleanupFailures.value.length} could not be cleared; see details below.` : ''}`
    if (cleared) await loadJobHistory()
    info(cleanupProgress.value)
  } finally {
    clearingSelected.value = false
  }
}

type JobControl = NonNullable<RJob['control']>

function jobControls(job: RJob): JobControl[] {
  return (job.controls?.length ? job.controls : (job.control ? [job.control] : []))
    .filter(control => control.action !== 'none')
    .map(control => ({ ...control, label: controlLabel(control) }))
}

function primaryJobControl(job: RJob): JobControl | null {
  return job.status === 'paused' ? null : primaryControl(jobControls(job))
}

function secondaryJobControls(job: RJob): JobControl[] {
  return job.status === 'paused' ? jobControls(job) : secondaryControls(jobControls(job))
}

function canRetryJob(job: RJob): boolean {
  if (!['error', 'cancelled'].includes(job.status)
    || isRecoveredFailure(job)
    || isTerminalContinuityRender(job)
    || job.params?.auto_repair_missing_prompts === true) return false
  // Q-06 — do not offer a Retry the backend always refuses (legacy prompt/image
  // modes). The admission rule mirrors `retryAdmissionError` in routes/jobs.ts.
  if (!retryAdmissionAllowed(job)) return false
  if (job.params?.jobs_replace_failed_items) return canRetryManualFailedItemExactly(job)
  // The queue can replay this saved chat identity without submitting a fresh
  // provider request. Keep Retry available beside Recheck for that exact path.
  const canReplaySavedChat = job.type === 'outline_only' || job.type === 'expand_chapters'
  return canReplaySavedChat || !jobControls(job).some(control =>
    control.action === 'recheck-provider-status' || control.action === 'return-later')
}

function canRetryManualFailedItemExactly(job: RJob): boolean {
  if (!job.params?.jobs_replace_failed_items) return false
  if (job.type !== 'audio') {
    return (job.genstudio_jobs || []).some(entry => entry.operation === 'chat.response')
  }
  const assets = job.params?.genstudio_recovery?.assets
  if (!assets || typeof assets !== 'object') return false
  const current = Object.values(assets as Record<string, any>)
    .filter((entry: any) => entry?.operation === 'tts')
    .map((entry: any) => (job.genstudio_jobs || []).find(evidence => evidence.operation === 'voice.tts'
      && ((entry.job_id && evidence.id === entry.job_id)
        || (entry.idempotency_key && (evidence.request_key === entry.idempotency_key
          || evidence.request?.idempotency_key === entry.idempotency_key)))))
  return current.length > 0 && current.every(entry => !!entry && (entry.state !== 'failed'
    || entry.failure_code === 'CLOUD_SUBMISSION_UNCERTAIN'
    || entry.failure_code === 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN'))
}

function canReplaceFailedItems(job: RJob): boolean {
  if (job.status !== 'error') return false
  // A held result may still be adopted; a paid replacement could buy it twice (Dreamlands 571ec142).
  if ((job.genstudio_jobs || []).some(holdsUnknownProviderOutcome)) return false
  return job.type === 'audio'
    || (job.genstudio_jobs || []).some(entry => entry.operation === 'chat.response')
}

function failedItemReplacementOutcome(job: RJob) {
  const local = replacementOutcome.value[job.job_id]
  if (local?.state === 'checking' || (local?.state === 'blocked' && job.status !== 'done') || (local && job.status !== 'done'
    && job.status !== 'error' && job.status !== 'cancelled')) return local
  if (!job.params?.jobs_replace_failed_items) return null
  if (job.status === 'done') return { state: 'complete' as const, text: 'Replacement complete', kind: 'ok' }
  if (job.status === 'error' || job.status === 'cancelled') {
    return { state: 'blocked' as const, text: 'Replacement blocked', kind: 'warn' }
  }
  return { state: 'queued' as const, text: 'Replacement queued', kind: 'busy' }
}

function automaticReplacementOutcome(job: RJob) {
  const replacement = job.result?.automatic_replacement
  if (!replacement || typeof replacement !== 'object') return null
  const state = typeof replacement.state === 'string' ? replacement.state : ''
  const reason = typeof replacement.reason === 'string'
    ? customerJobText(replacement.reason, job) : ''
  const label = state === 'complete' ? 'Automatic replacement complete'
    : state === 'blocked' ? 'Automatic replacement blocked'
    : state === 'queued' ? 'Automatic replacement queued'
    : state === 'checking' ? 'Checking automatic replacement'
    : 'Automatic replacement update'
  return { text: reason ? `${label}: ${reason}` : label, kind: state === 'complete' ? 'ok' : state === 'blocked' ? 'warn' : 'busy' }
}

function customerJobText(value: unknown, job: RJob): string {
  return customerSafeJobText(value, jobRequestIds(job))
}

async function runJobControl(job: RJob, requestedControl?: JobControl) {
  const control = requestedControl || job.control
  if (!control?.enabled || controlBusy.value.has(job.job_id)) return
  if (clearingSelected.value) return
  // v1.2.8 — the one control on this page that cannot be undone by clicking it
  // again. The dialog is populated from the backend's own wording (the pattern
  // already proven on Scene Review), so what the server promises and what the
  // user agrees to cannot drift apart.
  if (control.action === 'force-abandon') {
    const { ask } = useConfirm()
    if (!await ask({
      title: `Abandon ${job.title || job.type}?`,
      message: control.reason,
      confirmLabel: 'Abandon This Job',
    })) return
  }
  controlBusy.value = new Set(controlBusy.value).add(job.job_id)
  try {
    if (control.action === 'force-abandon') {
      const response = await post<{ job: Job }>(`${jobQueuePath(job)}/abandon`, {})
      projectQueue.applyUpdate(response.job)
      universalQueue.applyUpdate(response.job)
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
      try {
        await del(jobQueuePath(job))
      } catch (error: any) {
        // The row can outlive the job it names. "Job not found" means the job
        // is already gone, so the removal's goal — this row off the list — is
        // already true. Drop the row instead of failing the customer's click.
        if (!isMissingJobError(error)) throw error
      }
      projectQueue.removeJobs([job.job_id])
      universalQueue.removeJobs([job.job_id])
      history.removeIds([job.job_id])
      forgetHiddenJob(job.job_id)
      await loadJobHistory()
    } else if (control.action === 'recheck-provider-status') {
      // v1.2.6 — this button actually asks GenStudio. The refreshed control
      // arrives with the response, so the answer replaces the question rather
      // than leaving the row describing a check that never ran.
      const response = await post<{ job?: RJob }>(`${jobQueuePath(job)}/recheck-provider-status`, {})
      const refreshed = response?.job?.control
      success(refreshed?.action === 'clear-history'
        ? 'The Gateway confirmed this job\'s provider work has finished. This history can now be removed.'
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

/** Paused, or still pausing (work already sent is finishing): either way the
 * owner can change their mind. A pausing job continues on its own once its
 * pause checkpoint is saved. */
function canResumeJob(job: RJob): boolean {
  return job.status === 'paused'
    || (job.status === 'running' && job.pause_requested === true && job.resume_after_pause !== true)
}

async function resumeJob(job: RJob) {
  if (controlBusy.value.has(job.job_id)) return
  controlBusy.value = new Set(controlBusy.value).add(job.job_id)
  const pausing = job.status === 'running'
  try {
    await post(`${jobQueuePath(job)}/resume`, {})
    success(pausing
      ? 'Resume requested. Work already sent finishes and is saved first; then the job continues on its own.'
      : 'Job resumed. Saved and accepted work will be reclaimed first.')
  } catch (e: any) {
    showError(customerJobText(e?.data?.detail || 'Failed to resume job', job))
  } finally {
    const next = new Set(controlBusy.value)
    next.delete(job.job_id)
    controlBusy.value = next
  }
}

const pausedJobCount = computed(() => projectScopedJobs.value.filter(job => job.status === 'paused').length)

/** Reorder one QUEUED job among queued jobs of its own kind. The server owns
 * the lane; it answers with every job in that lane so each row's position
 * badge refreshes together. */
async function moveInQueue(job: RJob, direction: 'up' | 'down' | 'top') {
  if (controlBusy.value.has(job.job_id)) return
  controlBusy.value = new Set(controlBusy.value).add(job.job_id)
  try {
    const response = await post<{ queue?: Job[] }>(`${jobQueuePath(job)}/move`, { direction })
    for (const row of response?.queue || []) {
      projectQueue.applyUpdate(row)
      universalQueue.applyUpdate(row)
    }
  } catch (e: any) {
    showError(customerJobText(e?.data?.detail || 'Failed to move this job in its queue', job))
  } finally {
    const next = new Set(controlBusy.value)
    next.delete(job.job_id)
    controlBusy.value = next
  }
}

async function resumePausedJobs() {
  if (bulkResumeBusy.value || pausedJobCount.value === 0) return
  bulkResumeCount.value = pausedJobCount.value
  bulkResumeBusy.value = true
  const payload: { project_slug?: string; type?: string } = {}
  if (isUniversal.value && projectFilter.value !== 'all') {
    payload.project_slug = projectFilter.value
  }
  const endpoint = isUniversal.value
    ? '/jobs/all/resume-paused'
    : `/projects/${slug.value}/jobs/resume-paused`
  try {
    const result = await post<{ resumed: number; skipped: number }>(endpoint, payload)
    success(`Resumed ${result.resumed}; ${result.skipped} unchanged.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to resume paused work')
  } finally {
    bulkResumeBusy.value = false
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

type JobAttentionLink = { kind: 'subtitle' | 'image' | 'prompt'; label: string; to: string }
type CurrentSubtitleStatus = {
  timeline_integrity?: {
    complete?: boolean
    caption_gap_mode?: 'off' | 'warn' | 'block'
    blocking_cue_gaps?: Array<{ section_slugs?: string[] }>
  }
}
const currentSubtitleAttentionByEpisode = ref<Record<string, JobAttentionLink | null>>({})
const currentSubtitleAttentionChecked = new Set<string>()
const currentSubtitleAttentionLoading = new Set<string>()
const currentSubtitleAttentionQueued = new Map<string, RJob>()
let currentSubtitleAttentionSweepRunning = false

function subtitleAttentionKey(job: RJob): string | null {
  if (job.type !== 'scene_plan_run' || !job.episode_id) return null
  return `${jobProjectSlug(job)}:${job.episode_id}`
}
function subtitleAttentionLink(job: RJob, section?: string, current = false): JobAttentionLink | null {
  if (!job.episode_id) return null
  const suffix = section ? `&section=${encodeURIComponent(section)}` : ''
  const prefix = current ? 'Current subtitle coverage gap' : 'Subtitle coverage gap'
  return {
    kind: 'subtitle',
    label: section ? `${prefix} — open ${section}` : `${prefix} — open Subtitles`,
    to: `/projects/${jobProjectSlug(job)}/subtitles?episode_id=${encodeURIComponent(job.episode_id)}${suffix}`,
  }
}
function currentSubtitleAttention(job: RJob): JobAttentionLink | null {
  const attention = (job.result as any)?.attention
  if (attention?.kind === 'subtitle_coverage_gap' && attention.workspace === 'subtitles') {
    const section = Array.isArray(attention.gaps)
      ? attention.gaps.flatMap((gap: any) => Array.isArray(gap?.section_slugs) ? gap.section_slugs : [])[0]
      : undefined
    return subtitleAttentionLink({ ...job, episode_id: typeof attention.episode_id === 'string' ? attention.episode_id : job.episode_id }, section)
  }
  const key = subtitleAttentionKey(job)
  return key ? currentSubtitleAttentionByEpisode.value[key] || null : null
}
async function loadCurrentSubtitleAttention(job: RJob): Promise<void> {
  const key = subtitleAttentionKey(job)
  const structured = (job.result as any)?.attention
  if (!key || (job.status !== 'error' && job.status !== 'cancelled') || structured?.kind === 'subtitle_coverage_gap'
    || currentSubtitleAttentionChecked.has(key) || currentSubtitleAttentionLoading.has(key)) return
  currentSubtitleAttentionLoading.add(key)
  try {
    const status = await get<CurrentSubtitleStatus>(
      `/projects/${jobProjectSlug(job)}/video-editor/subtitles/timeline-integrity/${encodeURIComponent(job.episode_id!)}`,
    )
    const gaps = status.timeline_integrity?.blocking_cue_gaps || []
    const section = gaps.flatMap(gap => Array.isArray(gap.section_slugs) ? gap.section_slugs : [])[0]
    currentSubtitleAttentionByEpisode.value = {
      ...currentSubtitleAttentionByEpisode.value,
      [key]: status.timeline_integrity?.caption_gap_mode === 'block' && gaps.length
        ? subtitleAttentionLink(job, section, true)
        : null,
    }
    currentSubtitleAttentionChecked.add(key)
  } catch {
    // A transient status failure stays unknown and can be retried on a later refresh.
  } finally {
    currentSubtitleAttentionLoading.delete(key)
  }
}

async function drainCurrentSubtitleAttentionQueue(): Promise<void> {
  if (currentSubtitleAttentionSweepRunning) return
  currentSubtitleAttentionSweepRunning = true
  try {
    while (currentSubtitleAttentionQueued.size) {
      const next = currentSubtitleAttentionQueued.entries().next().value as [string, RJob] | undefined
      if (!next) break
      currentSubtitleAttentionQueued.delete(next[0])
      await loadCurrentSubtitleAttention(next[1])
    }
  } finally {
    currentSubtitleAttentionSweepRunning = false
    if (currentSubtitleAttentionQueued.size) void drainCurrentSubtitleAttentionQueue()
  }
}

function queueCurrentSubtitleAttention(jobs: RJob[]): void {
  for (const job of jobs) {
    const key = subtitleAttentionKey(job)
    if (key && !currentSubtitleAttentionChecked.has(key)) {
      currentSubtitleAttentionQueued.set(key, { ...job, project_slug: jobProjectSlug(job) })
    }
  }
  void drainCurrentSubtitleAttentionQueue()
}
const SAFE_IMAGE_ISSUE_REASONS: Record<string, string> = {
  'generation failed': 'generation failed',
  'not saved': 'output was not saved',
  'missing from scene plan': 'no longer appears in the Scene Plan',
  'corrupt image': 'image file is corrupt',
  'empty image': 'image file is empty',
}
const SAFE_PROMPT_ISSUE_REASONS: Record<string, string> = {
  'missing prompt': 'prompt is missing',
  'duplicate prompt': 'prompt duplicates another scene',
  'empty prompt': 'prompt is empty',
  'missing from scene plan': 'no longer appears in the Scene Plan',
}
const PAID_REPLACEMENT_MESSAGES: Record<string, string> = {
  // Plain words (owner, 2026-10-03): what happened, and which button makes it again.
  original_failure_not_eligible: 'The first try failed in a way Story Studio does not repeat on its own, so nothing new was sent or charged. Press “Retry Failed Jobs” to make it again.',
  replacement_disabled: 'Automatic second tries are off for this job, so nothing new was sent or charged. Press “Retry Failed Jobs” to make it again.',
  not_verified: 'Story Studio could not confirm the image is missing, so nothing new was sent. Press “Check Running Jobs” first.',
  budget_limit: 'A second try would go over this job’s spending limit, so nothing new was sent.',
  automatic_replacement_unavailable: 'An automatic second try was not possible, so nothing new was sent or charged. Press “Retry Failed Jobs” to make it again.',
}
function paidReplacementAttemptMessage(job: RJob): string | null {
  const reason = (job.result as any)?.image_replacement?.reason
    || (job.paid_image_replacement_attempt as any)?.reason
  return typeof reason === 'string' ? PAID_REPLACEMENT_MESSAGES[reason] || null : null
}
function exactLegacyIssue(itemId: unknown, state: 'missing' | 'invalid') {
  return typeof itemId === 'string' && /^[A-Za-z0-9_-]+$/.test(itemId)
    ? { item_id: itemId, state }
    : null
}

// A saved Scene Plan the job cannot continue (e.g. no pacing snapshot): retrying stops at the
// same place, so offer the one fix right here.
const rebuildingTimelines = ref<Set<string>>(new Set())
function needsTimelineRebuild(job: RJob): boolean {
  const attention = (job.result as any)?.attention
  return job.type === 'scene_plan_run' && job.status === 'error' && attention?.kind === 'scene_plan_rebuild' && !!job.episode_id
}
async function rebuildTimeline(job: RJob): Promise<void> {
  const ok = await useConfirm().ask({
    title: `Rebuild ${job.episode_id}'s timeline?`,
    message: 'This replaces every scene with new ones cut from the current subtitles and the episode’s chosen rhythm. Saved prompts and approvals stop being attached to scenes (image files stay on disk).',
    confirmLabel: 'Rebuild Timeline',
    danger: true,
  })
  if (!ok) return
  rebuildingTimelines.value = new Set([...rebuildingTimelines.value, job.job_id])
  try {
    await post(`/projects/${jobProjectSlug(job)}/scene-plan/${encodeURIComponent(job.episode_id!)}/run`, { stage: 'timeline' })
    success(`Rebuilding ${job.episode_id}'s timeline. Press Retry on this job when it finishes.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not start the timeline rebuild')
  } finally {
    const next = new Set(rebuildingTimelines.value)
    next.delete(job.job_id)
    rebuildingTimelines.value = next
  }
}

function jobAttentionSummary(job: RJob): string {
  const count = jobAttentionLinks(job).length
  if (!count) return ''
  const completion = (job.result as any)?.completion
  const completed = completion?.completed
  const expected = completion?.expected
  const verified = job.type === 'scene_plan_run'
    && typeof completed === 'number' && Number.isFinite(completed) && completed >= 0
    && typeof expected === 'number' && Number.isFinite(expected) && expected > 0
    ? `${completed.toLocaleString()} of ${expected.toLocaleString()} prompts verified; `
    : ''
  const nouns = job.type === 'scene_plan_run'
    ? ['Scene Plan prompt', 'Scene Plan prompts']
    : job.type === 'continuity_render'
      ? ['scene image', 'scene images']
      : ['item', 'items']
  const summary = `${verified}${count} ${count === 1 ? nouns[0] : nouns[1]} need attention.`
  const cause = jobAttentionCause(job)
  return `${summary}${cause ? ` ${cause}` : ''}`
}

function jobAttentionCause(job: RJob): string {
  if (job.type !== 'scene_plan_run') return ''
  const submissionUncertain = job.genstudio_jobs?.some(remote => {
    const state = effectiveGenStudioTaskState(remote)
    return remote.operation === 'chat.response'
      && ['failed', 'uncertain'].includes(state)
      && remote.failure_code === 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN'
  })
  return submissionUncertain
    ? 'The Gateway could not confirm the earlier prompt request. Story Studio must confirm it before sending a replacement.'
    : ''
}

function jobAttentionLinks(job: RJob): JobAttentionLink[] {
  const subtitle = currentSubtitleAttention(job)
  if (subtitle) return [subtitle]
  const completion = (job.result as any)?.completion
  const structured = Array.isArray(completion?.issues) ? completion.issues : []
  const legacyMissing = Array.isArray(completion?.missing) ? completion.missing : []
  const legacyInvalid = Array.isArray(completion?.invalid) ? completion.invalid : []
  const legacy = [
    ...legacyMissing.map((item: unknown) => exactLegacyIssue(item, 'missing')),
    ...legacyInvalid.map((item: unknown) => exactLegacyIssue(item, 'invalid')),
  ].filter(Boolean)
  const issues = structured.length ? structured : legacy
  const hasOpaqueLegacyInvalid = !structured.length && legacyInvalid.some((item: unknown) => !exactLegacyIssue(item, 'invalid'))
  if (!job.episode_id || !issues.length) {
    const hasLegacyIssue = legacyMissing.length > 0 || legacyInvalid.length > 0
    return hasLegacyIssue && job.type === 'continuity_render' && job.episode_id
      ? [{ kind: 'image', label: 'Image output needs review — open Scene Review', to: `/projects/${jobProjectSlug(job)}/scene-review?episode_id=${encodeURIComponent(job.episode_id)}` }]
      : []
  }
  const links = issues.flatMap((issue: any): JobAttentionLink[] => {
    if ((issue?.state !== 'missing' && issue?.state !== 'invalid') || typeof issue.item_id !== 'string') return []
    if (job.type === 'continuity_render') {
      const reason = typeof issue.reason === 'string' ? SAFE_IMAGE_ISSUE_REASONS[issue.reason] : undefined
      const detail = reason || (issue.state === 'missing' ? 'missing' : 'invalid')
      return [{
        kind: 'image',
        label: `Scene ${issue.item_id}: ${detail} — open Scene Review`,
        to: `/projects/${jobProjectSlug(job)}/scene-review?episode_id=${encodeURIComponent(job.episode_id)}&scene_id=${encodeURIComponent(issue.item_id)}`,
      }]
    }
    if (job.type === 'scene_plan_run') {
      const reason = typeof issue.reason === 'string' ? SAFE_PROMPT_ISSUE_REASONS[issue.reason] : undefined
      const detail = reason || (issue.state === 'missing' ? 'prompt is missing' : 'prompt needs review')
      return [{
        kind: 'prompt',
        label: `Scene ${issue.item_id}: ${detail} — open Scene Plan`,
        to: `/projects/${jobProjectSlug(job)}/scene-plan?episode_id=${encodeURIComponent(job.episode_id)}`,
      }]
    }
    return []
  })
  if (hasOpaqueLegacyInvalid && job.type === 'continuity_render') {
    links.push({ kind: 'image', label: 'Some historical image output needs review — open Scene Review', to: `/projects/${jobProjectSlug(job)}/scene-review?episode_id=${encodeURIComponent(job.episode_id)}` })
  }
  return links
}

// Older Scene Plan rows predate `result.attention`. Only when a terminal row is
// visible, read current typed subtitle status for that episode; never guess a
// historical cause from error prose.
watch([activeJobs, paginatedHistory], ([active, history]) => {
  queueCurrentSubtitleAttention([...active, ...history])
}, { immediate: true })

// Assembly can be blocked by missing upstream media. Recovery retrieves
// existing files; it never reruns assembly or starts new paid generation.
const EPISODE_RECOVERY_TYPES = new Set(['audio_merge', 'video_assembly'])
const recoveringEpisodes = ref<Set<string>>(new Set())
const recoveringAllEpisodes = ref(false)
const repairingJobs = ref<Set<string>>(new Set())
function episodeRecoveryKey(job: RJob): string { return `${jobProjectSlug(job)}:${job.episode_id}` }
function canRecoverEpisode(job: RJob): boolean {
  const project = job.project_slug || (!isUniversal.value ? slug.value : '')
  return (job.status === 'error' || job.status === 'cancelled')
    && EPISODE_RECOVERY_TYPES.has(job.type)
    && !!project && project !== '_app_' && !!job.episode_id
}
function episodeRecoveryBusy(job: RJob): boolean {
  return recoveringEpisodes.value.has(episodeRecoveryKey(job))
    || jobs.value.some(other => jobProjectSlug(other) === jobProjectSlug(job) && other.episode_id === job.episode_id
      && ((other.type === 'images_repair' && ['queued', 'running', 'paused'].includes(other.status))
        || repairingJobs.value.has(other.job_id)))
}
// Episodes a check (or Recover) already looked at this session — Recover is
// free and idempotent, so re-offering it in the check count only made a loop.
const episodesLookedAt = ref<Set<string>>(new Set())
const recoverableEpisodes = computed(() => {
  const seen = new Set<string>()
  return projectScopedJobs.value.filter(job => {
    if (!canRecoverEpisode(job) || episodeRecoveryBusy(job)) return false
    const key = episodeRecoveryKey(job)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})
async function recoverEpisode(job: RJob, announce = true): Promise<EpisodeAssetRecovery | null> {
  if (!canRecoverEpisode(job) || episodeRecoveryBusy(job)) return null
  const key = episodeRecoveryKey(job)
  recoveringEpisodes.value = new Set(recoveringEpisodes.value).add(key)
  const setOutcome = (text: string, kind: string) => {
    const next = { ...repairOutcome.value }
    for (const row of jobs.value) {
      if (canRecoverEpisode(row) && episodeRecoveryKey(row) === key) next[row.job_id] = { text, kind }
    }
    repairOutcome.value = next
  }
  setOutcome('Checking this episode’s existing audio and images…', 'busy')
  try {
    const result = await recoverEpisodeAssets(jobProjectSlug(job), job.episode_id, post,
      message => setOutcome(message, 'busy'))
    const message = `${job.episode_id}: ${describeEpisodeAssetRecovery(result)}`
    setOutcome(message, result.audioAttempted && (!result.audio || result.audio.stillMissing > 0) ? 'warn' : 'ok')
    if (announce) info(message)
    return result
  } catch (error: any) {
    const message = customerJobText(error?.data?.detail || error?.message || 'Could not recover this episode’s files.', job)
    setOutcome(message, 'warn')
    if (announce) showError(message)
    return null
  } finally {
    const next = new Set(recoveringEpisodes.value)
    next.delete(key)
    recoveringEpisodes.value = next
    // Looked at: "Check Running Jobs" stops counting this episode (no loop).
    episodesLookedAt.value = new Set(episodesLookedAt.value).add(key)
  }
}
/** Returns how many free image recovery jobs were queued. */
async function recoverAllEpisodes(chained = false, only?: RJob[]): Promise<number> {
  if (bulkActionBusy.value && !chained) return 0
  const snapshot = only || [...recoverableEpisodes.value]
  if (!snapshot.length) return 0
  const scope = actionScopeLabel.value
  recoveringAllEpisodes.value = true
  let failed = 0
  let imagesQueued = 0
  try {
    for (const [index, job] of snapshot.entries()) {
      if (!chained) bulkActionMessage.value = `${scope}: checking episode ${index + 1} of ${snapshot.length}…`
      const result = await withinCheckTime(recoverEpisode(job, false))
      if (!result) failed++
      else imagesQueued += result.imagesQueued
    }
    if (!chained) {
      bulkActionMessage.value = `${scope}: checked ${snapshot.length} episode(s); ${failed} could not be recovered. Each row shows its result.${imagesQueued ? ` Started ${imagesQueued} free image recovery job(s).` : ''}`
      info(bulkActionMessage.value)
    }
  } finally { recoveringAllEpisodes.value = false }
  return imagesQueued
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
// Both return the reconciliation result in the POST response.
const REPAIR_ENDPOINTS: Record<string, { url: (projectSlug: string) => string; body: any }> = {
  audio: {
    // Provider-aware since v1.0.504 — the route reconciles every chunk from
    // whatever gateway made it (GenAIPro / kie.ai / fal.ai) via the task-manifest
    // sidecar; no provider hint needed.
    url: projectSlug => `/projects/${projectSlug}/episodes/__EPISODE__/audio-repair`,
    body: {},
  },
  // v1.4.43 — `images` and `scene_images` were removed when the scene-image
  // generator was retired in 1.4.41. Keys for job types that can no longer
  // exist made this map look like it covered the image pipeline; it covers
  // narration and thumbnails.
  // Dreamlands 2026-10-03 — repairs THIS job inline (source_job_id): the result
  // lands in its own log, no second "Image repair" row that fails for the same
  // missing files, and nothing to wait for.
  thumb_images: {
    url: projectSlug => `/projects/${projectSlug}/generate/images-repair`,
    body: { episode_id: '__EPISODE__', pool: 'thumbnails', source_job_id: '__JOB__' },
  },
}

function jobCanBeRepaired(jobOrType: Pick<RJob, 'type' | 'params'> | string): boolean {
  if (typeof jobOrType === 'string') return jobOrType in REPAIR_ENDPOINTS
  return jobOrType.type in REPAIR_ENDPOINTS
}

function canOfferScenePromptAutoRepair(job: Pick<RJob, 'type' | 'params'>): boolean {
  if (job.type !== 'scene_plan_run' || typeof job.params?.model !== 'string' || !job.params.model.trim()) return false
  const wasVisualPromptWork = job.params.stage === 'visual'
    || job.params.regenerate_empty_prompts === true
    || typeof job.params.regenerate_prompt_scene_id === 'string'
    || (job.params.stage == null && Array.isArray(job.params.pipeline_chain))
  return wasVisualPromptWork
    && job.params.stage !== 'timeline'
    && job.params.stage !== 'motion'
    && job.params.model !== 'deterministic-timeline'
    && typeof job.params.replan_scene_id !== 'string'
    && job.params.regenerate_empty_motion_prompts !== true
    && typeof job.params.regenerate_motion_prompt_scene_id !== 'string'
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
    return 'SMART RETRY — Keeps every prompt already verified on disk and sends only missing or duplicated stable scene IDs in bounded Gateway packs.'
  }
  if (jobType === 'image_prompts') {
    const mode = (job.params as any)?.mode
    if (mode === 'thumbnails') {
      return 'SMART RETRY — Regenerates ONLY the missing thumbnail prompts and merges them into the existing file, keeping the prompts that already succeeded. Local models: free. Cloud models: charges only for the missing thumbnails, not all prompts.'
    }
    return 'SMART RETRY — Regenerates ONLY missing scene/thumbnail prompts and merges them into the existing files, keeping prompts that already succeeded. Local models: free. Cloud models: charges only for the missing prompts.'
  }
  if (jobType === 'subtitles_transcribe') {
    // Q-10 — subtitles are not in REPAIR_ENDPOINTS, so no Repair button is
    // rendered for them. The old copy told the user to "Repair first", pointing
    // at a control that does not exist. Describe what Retry actually does.
    return 'CHARGES MAY APPLY — Retry keeps completed SRT files and submits only missing chapters, confirming a fresh quote for each new request.'
  }
  if (jobCanBeRepaired(job)) {
    return 'CHARGES MAY APPLY — Re-submits this job as a fresh request. Click Repair FIRST (free — recovers in-flight provider work). The generator skips assets already on disk, so after Repair, Retry only re-submits genuinely-missing items.'
  }
  return 'CHARGES MAY APPLY — Re-submits this job as a fresh request. Re-runs the whole step (this job type has no partial/repair path).'
}

function autoRetryLabel(job: Pick<RJob, 'status' | 'auto_retry'>): string {
  const retry = job.auto_retry
  // A cancelled job never retries, whatever its saved policy says.
  if (!retry?.eligible || job.status === 'cancelled') return ''
  const attempt = Math.max(1, retry.attempt || 1)
  if (job.status === 'done' && attempt > 1) return `Recovered locally · attempt ${attempt}/${retry.max_attempts}`
  if (job.status === 'error' || retry.exhausted) return `Local retries exhausted · ${attempt}/${retry.max_attempts}`
  if (retry.next_retry_at) {
    const seconds = Math.max(0, Math.ceil((new Date(retry.next_retry_at).getTime() - now.value) / 1000))
    return `Auto-retry · attempt ${attempt}/${retry.max_attempts} · next in ${seconds}s`
  }
  return `Auto-retry · attempt ${attempt}/${retry.max_attempts}`
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
async function repairJobOnly(job: RJob, announce = true) {
  if (repairingJobs.value.has(job.job_id) || recoveringEpisodes.value.has(episodeRecoveryKey(job))) return false
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
    JSON.stringify(template.body).replace(/__EPISODE__/g, job.episode_id).replace(/__JOB__/g, job.job_id)
  )
  // Bulk runs (Repair All, Check Running Jobs) report once; each card keeps its chip.
  const notify = announce ? { success, info } : { success: (_: string) => {}, info: (_: string) => {} }

  repairingJobs.value = new Set(repairingJobs.value).add(job.job_id)
  notify.info(`Looking for finished ${jobTypeLabel(job.type)} work for ${job.episode_id} that never arrived (no charge)…`)
  repairOutcome.value = { ...repairOutcome.value, [job.job_id]: { text: 'Looking for finished work…', kind: 'busy' } }
  try {
    const resp = await post<{
      recovered?: number
      still_missing?: number
      present_before?: number
      total_expected?: number
    }>(url, body)

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
        notify.success(
          `Recovered ${piece(recovered)}. ` +
          `Nothing is missing — you can dismiss this job now.`
        )
        chip = { text: `Recovered ${piece(recovered)}; nothing missing — dismiss`, kind: 'ok' }
      } else if (missing === 0 && recovered === 0) {
        notify.success(
          `Nothing was missing — everything was already saved. ` +
          `The earlier problem was temporary; you can dismiss this job.`
        )
        chip = { text: 'Nothing was missing — dismiss', kind: 'ok' }
      } else if (missing > 0 && recovered > 0) {
        notify.info(
          `Recovered ${piece(recovered)}. ${missing} still missing — ` +
          `Retry re-makes only those.`
        )
        chip = { text: `Recovered ${piece(recovered)}; ${missing} still missing — Retry`, kind: 'warn' }
      } else {
        notify.info(
          `Nothing was ready to recover; ${missing} item${missing === 1 ? '' : 's'} still missing. ` +
          `Retry re-makes only those.`
        )
        chip = { text: `Nothing to recover yet; ${missing} still missing — Retry`, kind: 'warn' }
      }
    } else {
      notify.success(`Finished checking ${jobTypeLabel(job.type)} for ${job.episode_id}.`)
      chip = { text: 'Recovery finished', kind: 'ok' }
    }
    repairOutcome.value = { ...repairOutcome.value, [job.job_id]: chip }
    return true
  } catch (e: any) {
    if (announce) showError(customerJobText(e?.data?.detail || e?.message || 'Could not check for finished work', job))
    setRepairState(job.job_id, { outcome: 'failed' })
    repairOutcome.value = { ...repairOutcome.value, [job.job_id]: { text: 'could not check — try again', kind: 'warn' } }
    return false
  } finally {
    const next = new Set(repairingJobs.value)
    next.delete(job.job_id)
    repairingJobs.value = next
  }
}

async function finishMissingImages(job: RJob, announce = true): Promise<boolean> {
  if (controlBusy.value.has(job.job_id)) return false
  setRepairState(job.job_id, null)
  controlBusy.value = new Set(controlBusy.value).add(job.job_id)
  try {
    const response = await post<{ job: Job }>(`${jobQueuePath(job)}/finish-missing-images`, {})
    const next = response?.job
    if (!next || next.job_id !== job.job_id) throw new Error('Story Studio could not confirm this existing image run was queued.')
    // Queue refs are intentionally readonly. Apply the confirmed same-row
    // response through both stores immediately; SSE may arrive later.
    projectQueue.applyUpdate(next)
    universalQueue.applyUpdate(next)
    failureBatchFilter.value = null
    statusFilter.value = next.status === 'running' ? 'running' : 'queued'
    if (announce) success(`Finish missing images queued for ${job.episode_id}.`)
    return true
  } catch (e: any) {
    showError(customerJobText(e?.data?.detail || e?.message || 'Could not queue the missing images.', job))
    return false
  } finally {
    const next = new Set(controlBusy.value)
    next.delete(job.job_id)
    controlBusy.value = next
  }
}

async function replaceFailedItems(job: RJob): Promise<boolean> {
  if (controlBusy.value.has(job.job_id)) return false
  replacementOutcome.value = {
    ...replacementOutcome.value,
    [job.job_id]: { state: 'checking', text: 'Checking failed items…', kind: 'busy' },
  }
  controlBusy.value = new Set(controlBusy.value).add(job.job_id)
  try {
    const response = await post<{ job?: Job }>(`${jobQueuePath(job)}/replace-failed-items`, {})
    const next = response.job
    const marker = next?.params?.jobs_replace_failed_items
    if (!isConfirmedRetryReplacement(job, next)
      || marker?.source_job_id !== job.job_id
      || !Number.isSafeInteger(marker?.item_count)
      || marker.item_count < 1) {
      throw new Error('Story Studio could not confirm the failed-item replacement scope.')
    }
    const outcomes = { ...replacementOutcome.value }
    delete outcomes[job.job_id]
    outcomes[next.job_id] = { state: 'queued', text: 'Replacement queued', kind: 'ok' }
    replacementOutcome.value = outcomes
    projectQueue.replaceJob(job.job_id, next)
    universalQueue.replaceJob(job.job_id, next)
    failureBatchFilter.value = null
    statusFilter.value = next.status === 'running' ? 'running' : 'queued'
    success(`Replacement queued for ${marker.item_count} confirmed failed item${marker.item_count === 1 ? '' : 's'}.`)
    return true
  } catch (e: any) {
    const detail = customerJobText(e?.data?.detail || e?.message || 'Failed items could not be replaced.', job)
    replacementOutcome.value = {
      ...replacementOutcome.value,
      [job.job_id]: { state: 'blocked', text: `Replacement blocked: ${detail}`, kind: 'warn' },
    }
    showError(detail)
    return false
  } finally {
    const nextBusy = new Set(controlBusy.value)
    nextBusy.delete(job.job_id)
    controlBusy.value = nextBusy
  }
}

function isConfirmedRetryReplacement(job: RJob, next: Job | undefined): next is Job {
  return !!next
    && typeof next.job_id === 'string'
    && !!next.job_id.trim()
    && next.job_id !== job.job_id
    && next.project_slug === jobProjectSlug(job)
    && next.episode_id === job.episode_id
    && next.type === (job.type === 'images' ? 'thumb_images' : job.type)
}

async function retryJob(job: RJob): Promise<boolean> {
  if (controlBusy.value.has(job.job_id) || repairingJobs.value.has(job.job_id) || episodeRecoveryBusy(job)) return false
  // v1.4.32 — whatever a repair found belonged to the run that just failed.
  // Re-running makes it stale, so it is dropped here rather than left behind to
  // license a later Retry all.
  setRepairState(job.job_id, null)
  controlBusy.value = new Set(controlBusy.value).add(job.job_id)
  try {
    const projectSlug = jobProjectSlug(job)
    if (isEpisodeRecoveryType(job.type, job.params)) {
      const response = await post<{ plan: { message: string } }>(`/projects/${projectSlug}/jobs/recover-episode/${job.episode_id}`, { source_job_ids: [job.job_id] })
      info(response.plan.message)
      return true
    }
    const response = await post<{ job?: Job }>(`${jobQueuePath(job)}/retry`, {})
    const next = response.job
    if (!isConfirmedRetryReplacement(job, next)) throw new Error('Story Studio could not confirm this job was re-queued.')
    // The queue creates a fresh history row for Retry. Retire the old terminal
    // row only after its confirmed replacement has the same durable scope.
    projectQueue.replaceJob(job.job_id, next)
    universalQueue.replaceJob(job.job_id, next)
    success(`${jobTypeLabel(job.type)} re-queued for ${job.episode_id}`)
    return true
  } catch (e: any) {
    showError(customerJobText(e?.data?.detail || e?.message || 'Failed to retry job', job))
    return false
  } finally {
    const next = new Set(controlBusy.value)
    next.delete(job.job_id)
    controlBusy.value = next
  }
}

async function autoRepairScenePrompts(job: RJob) {
  const busy = new Set(controlBusy.value)
  busy.add(job.job_id)
  controlBusy.value = busy
  try {
    const response = await post<{ missing_prompts: number }>(
      `/projects/${jobProjectSlug(job)}/jobs/${job.job_id}/auto-repair-scene-prompts`,
      {},
    )
    success(`Auto repair started for ${response.missing_prompts} missing or duplicated prompt${response.missing_prompts === 1 ? '' : 's'}. Each scene is a separate Gateway request; credits may be charged.`)
  } catch (e: any) {
    showError(customerJobText(e?.data?.detail || e?.message || 'Prompt auto-repair could not start.', job))
  } finally {
    const next = new Set(controlBusy.value)
    next.delete(job.job_id)
    controlBusy.value = next
  }
}

async function clearHistory(status: 'finished' | 'failed') {
  if (bulkActionBusy.value) return
  const promised = status === 'finished' ? finishedCount.value : failedCount.value
  if (!promised) return
  // Failed rows are the only place Retry/Recover and the error detail live.
  if (status === 'failed' && !await useConfirm().ask({ title: 'Remove failed jobs from the list?', message: `Remove ${promised} failed job row(s)? Their error details and Retry/Recover actions go with them. Files and billing records are unchanged.`, confirmLabel: 'Remove From List', danger: true })) return
  const project = isUniversal.value ? projectFilter.value : slug.value
  const endpoint = isUniversal.value && project === 'all' ? '/jobs/all'
    : project === '_app_' ? '/jobs/app' : `/projects/${project}/jobs`
  clearingHistory.value = status
  // A history read that began before this delete may still carry a row it removes.
  history.invalidate()
  try {
    const result = await del<{ cleared: number }>(`${endpoint}?status=${status}`)
    bulkActionMessage.value = result.cleared
      ? `Removed ${result.cleared} ${status} row(s) from the list. Files and billing records are unchanged.`
      : 'Nothing was removed. Provider status may have changed; the job’s controls show what is still pending.'
    info(bulkActionMessage.value)
    // This endpoint returns only a count, not the exact ids that survived its
    // provider-settlement gate. The history read is the authority for what
    // remains, so reload it even when nothing was removed — otherwise a zero
    // leaves rows the server's gate held looking removable forever.
    if (isUniversal.value) void refreshVisibleJobs()
    else await refreshVisibleJobs()
    await loadJobHistory()
    // The rows the backend no longer holds are gone from the list, so the
    // Hides for them are stale. The count on the button and the hidden count
    // both follow the backend.
    forgetHiddenJobsAbsentFromBackend()
  } catch (e: any) { showError(e?.data?.detail || `Failed to clear ${status} history`) }
  finally { clearingHistory.value = null }
}
function clearFinished() { return clearHistory('finished') }
function clearFailed() { return clearHistory('failed') }

</script>

<style scoped>
.jobs-workspace { padding-bottom: 32px; }
.jobs-selection-toolbar { margin: 6px 0 10px; }
.jobs-selection-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.jobs-selection-buttons .btn { min-height: 32px; white-space: normal; }
.jobs-selection-buttons .btn:disabled { color: var(--text-muted); background: var(--bg-tertiary); border-color: var(--border); cursor: not-allowed; opacity: .65; }
.episode-search { flex: 0 1 240px; }
.episode-search input {
  width: 100%;
  min-height: 31px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-sm);
}
.episode-search input::placeholder { color: var(--text-muted); }
.episode-search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
.show-all-active { margin-top: 8px; }
.jobs-selection-toolbar p { margin: 8px 0 0; font-size: var(--font-sm); }
.jobs-selection-toolbar li { overflow-wrap: anywhere; }
.job-identity input[type="checkbox"] { flex: 0 0 auto; width: 18px; height: 18px; accent-color: var(--accent); }
.jobs-hero-aside {
  display: grid;
  justify-items: end;
  gap: 10px;
}
.jobs-control-toolbar { padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary); }
.jobs-control-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 10px; }
.jobs-updated-ago { margin-left: auto; }
.jobs-control-heading span, .jobs-control-label { color: var(--text-secondary); font-size: var(--font-xs); }
.jobs-primary-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.jobs-primary-action { min-width: 0; }
.jobs-primary-action .btn { width: 100%; min-height: 40px; font-size: var(--font-md, 15px); font-weight: 600; white-space: normal; }
.jobs-primary-action .btn:disabled { color: var(--text-muted); background: var(--bg-tertiary); border-color: var(--border); cursor: not-allowed; opacity: .7; }
.jobs-action-hint { margin: 6px 2px 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.jobs-more-actions { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
.jobs-more-action { display: grid; grid-template-columns: minmax(130px, auto) 1fr; align-items: center; gap: 4px 10px; margin-bottom: 8px; }
.jobs-more-action .btn { min-height: 36px; white-space: normal; }
.jobs-more-action .btn:disabled { color: var(--text-muted); background: var(--bg-tertiary); border-color: var(--border); cursor: not-allowed; opacity: .65; }
.jobs-more-action small { color: var(--text-muted, var(--text-secondary)); font-size: var(--font-xs); line-height: 1.4; }
.jobs-control-groups { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.jobs-control-group { min-width: 0; }
.jobs-control-label { display: block; margin-bottom: 8px; }
.jobs-control-result { margin: 8px 0 0; font-size: var(--font-sm); overflow-wrap: anywhere; }
.retry-all-details { margin-top: 8px; font-size: var(--font-xs); }
.retry-all-details summary { color: var(--text-secondary); cursor: pointer; }
.retry-all-details ul { display: grid; gap: 6px; margin: 8px 0 0; padding-left: 20px; }
.retry-all-details li span { display: block; color: var(--text-secondary); overflow-wrap: anywhere; }
@media (max-width: 1000px) { .jobs-control-groups { grid-template-columns: 1fr; gap: 16px; } }
@media (max-width: 1280px) { .jobs-more-action { grid-template-columns: 1fr; } .jobs-more-action .btn { justify-self: start; } }
@media (max-width: 720px) { .jobs-primary-actions { grid-template-columns: 1fr; } }
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
  /* The menu grows with its reasons, so bound it and let it scroll rather than
     letting a long set of controls run off the bottom of the window. */
  max-height: min(70vh, 480px);
  overflow-y: auto;
}
.job-more-actions-body .btn { margin-right: 4px; }
.paid-image-replacement-attempt { margin: 8px 0 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; overflow-wrap: anywhere; }
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
.genstudio-capacity-summary .capacity-unverified {
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
.capacity-error {
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--danger) 65%, var(--border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-primary));
  color: var(--danger);
  font-size: var(--font-xs);
}
.capacity-error strong { color: var(--danger); }
.genstudio-capacity { display: grid; justify-items: end; gap: 6px; max-width: min(720px, 100%); }
.genstudio-capacity > summary {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.genstudio-capacity > summary:hover { color: var(--text-primary); }
.genstudio-capacity > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
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

/* Sort Bar */
.sort-bar {
  display: flex; align-items: center; gap: 4px; margin-top: 10px; padding: 4px 0;
}
.sort-label { font-size: var(--font-xs); margin-right: 4px; white-space: nowrap; }
.sort-btn { white-space: nowrap; }
.type-filter select { min-width: 150px; }
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
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
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
  /* NO `overflow: hidden` here. The "More actions" <details> at :413/:816 is a
     descendant of this card, and its absolutely-positioned body holds one
     button plus a full-reason paragraph per secondary control — Cancel, Stop
     local work, Pause new submissions, Clear history, force-abandon. `hidden`
     clipped that menu at the card's padding box, and no ancestor scrolls, so
     the trailing controls could not be clicked at all: the only way to stop
     running work was unreachable. Nothing inside the card needs the clip. */
}
.job-card.status-running { border-left: 3px solid var(--accent); }
.job-card.status-error { border-left: 3px solid var(--error); }
.job-card.status-done { border-left: 3px solid var(--success); }
.job-card.status-recovered { border-left: 3px solid var(--success); }
.job-card.status-queued { border-left: 3px solid var(--text-muted); }
.job-card.status-paused { border-left: 3px solid var(--warning); }
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
.job-queue-position { flex: 0 0 auto; font-size: 12px; color: var(--text-muted); }
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
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
  max-width: 100%;
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
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent);
  font-weight: 650;
}
.auto-retry-tag.is-active { border-color: color-mix(in srgb, var(--accent) 42%, transparent); }
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

/* THE summary line. One line of counts, in words, number first. The card
   used to answer "how is it going?" with a stat row, a provider status line, a
   queue line, a money row and a settlement box; the card now says it once.
   Tabular figures so the digits do not jump as they tick. */
.job-summary-line {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
.job-summary-counts {
  display: flex; flex: 1 1 auto; flex-wrap: wrap; align-items: baseline; gap: 4px 12px;
  min-width: 0;
}
/* One count, number first, then what it counts, in words. */
.job-stat { display: inline-flex; align-items: baseline; gap: 5px; color: var(--text-muted); }
.job-stat strong { color: var(--text-primary); font-size: 14px; font-weight: 650; }
.job-stat.is-inflight strong { color: var(--accent); }
.job-stat.is-failed strong { color: var(--error); }
.job-stat.is-muted strong { color: var(--text-muted); font-weight: 600; }
/* The measured timing readings, kept in one labelled group at the trailing
   edge so the counts keep the leading edge. */
.job-stat-telemetry {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  margin-left: auto;
}
.job-stat-eta {
  padding: 2px 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border));
  border-radius: 999px;
  color: var(--accent);
  font-weight: 600;
  white-space: nowrap;
}
.job-stat-fresh {
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--text-secondary) 20%, var(--border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-secondary) 7%, transparent);
  color: var(--text-secondary);
  font-weight: 600;
  white-space: nowrap;
}
.job-stat-fresh.is-stale {
  border: 1px solid color-mix(in srgb, var(--warning, rgb(202, 138, 4)) 42%, var(--border));
  background: color-mix(in srgb, var(--warning, rgb(202, 138, 4)) 12%, transparent);
  color: var(--warning, rgb(202, 138, 4));
}

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

/* Error section */
.job-error-section { margin-top: 8px; }
.job-error-section.is-original-attempt .error-summary {
  background: var(--bg-secondary);
  border-left-color: var(--border);
  color: var(--text-muted);
}
.job-error-section.is-original-attempt .error-toggle { color: var(--text-muted); }
.job-error-section.is-original-attempt .error-details {
  background: var(--bg-secondary);
  color: var(--text-muted);
}
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
.job-attention-details { margin-top: 8px; font-size: var(--font-xs); }
.job-attention-details summary { color: var(--text-secondary); cursor: pointer; }
.job-attention-details summary:hover { color: var(--text-primary); }
.job-attention-details summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.job-attention-links { display: grid; gap: 4px; margin-top: 8px; }
.job-attention-links .inline-link { width: fit-content; }

/* Pagination */
.pagination {
  display: flex; justify-content: center; align-items: center; gap: 12px;
  margin-top: 16px; padding: 12px 0;
}
.page-info { font-size: 12px; color: var(--text-muted); }

/* Button sizes */
.btn-xs { padding: 3px 10px; font-size: var(--font-xs); }
.status-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 0 8px; }
.status-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.hidden-jobs { margin-left: auto; display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--font-xs); color: var(--text-muted); }
.hidden-settling-count { overflow-wrap: anywhere; }
.status-chip { font-size: 12px; padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border, #333); background: none; color: var(--text-muted, #999); cursor: pointer; }
.status-chip:hover { border-color: var(--accent, #6ab0f3); }
.status-chip.active { background: var(--accent); color: var(--accent-on); border-color: var(--accent); }
.status-chip.active.sc-error { background: #e06c75; border-color: #e06c75; }
.status-count { margin-left: 5px; opacity: 0.8; font-variant-numeric: tabular-nums; }
.resume-paused-btn { white-space: nowrap; }
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
  .genstudio-capacity-summary { justify-content: flex-start; }
  .job-row-main { align-items: flex-start; flex-wrap: wrap; }
  .job-identity { flex-basis: 100%; flex-wrap: wrap; }
  .job-project { flex-shrink: 0; }
  .job-title { flex-basis: 100%; }
  .job-actions { margin-left: 0; width: 100%; justify-content: flex-start; }
  .project-filter { width: 100%; }
  .project-filter select { min-width: 0; flex: 1; }
  .sort-bar { flex-wrap: wrap; min-width: 0; }
  .episode-search { flex: 1 1 100%; margin-right: 0; }
  .jobs-updated-ago { margin-left: 0; }
  .sort-label { flex: 1 1 100%; margin-right: 0; }
  .status-filters { flex: 1 1 100%; min-width: 0; }
  .status-bar > .btn { flex: 1 1 auto; }
  .job-stat-telemetry {
    flex-basis: 100%;
    width: 100%;
    max-width: 100%;
    justify-content: flex-end;
  }
}

@media (max-width: 260px) {
  .job-stat-fresh {
    box-sizing: border-box;
    max-width: 100%;
    white-space: normal;
    text-align: right;
    line-height: 1.35;
  }
}
</style>
