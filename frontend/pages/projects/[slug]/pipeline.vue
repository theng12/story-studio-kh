<template>
  <div class="workspace-page pipeline-workspace">
    <WorkspaceHero
      eyebrow="Production orchestration"
      title="Pipeline"
      description="Choose the work once, preflight every episode, and let each production chain advance safely through the queue."
    >
      <template #aside>
        <div class="workspace-metrics">
          <span class="workspace-metric"><strong>{{ selectedEpisodes.size }}</strong> episodes selected</span>
          <span class="workspace-metric"><strong>{{ checkedStepCount }}</strong> steps selected</span>
          <!-- This counts THIS PAGE's setup problems only: no step picked, no
               episode picked, a stage with no active preset. Per-episode
               preflight is a separate, later check that runs when Run Batch is
               pressed. Labelling this one "blockers" let the header read
               "0 blockers" while preflight was reporting eighteen — both
               numbers correct, one word doing two jobs. -->
          <span
            class="workspace-metric"
            :data-tone="blockingIssues.length ? 'warning' : 'success'"
            title="Problems with the choices on this page — steps, episodes, presets. Each episode is checked separately by preflight when you press Run Batch, and anything it finds is reported then."
          >
            <strong>{{ blockingIssues.length }}</strong> setup blockers
          </span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface">
      <TopActionBar
        :project-slug="slug"
        episode-mode="multi"
        :generate-label="runButtonLabel"
        :generate-loading="submitting || preflighting"
        :generate-disabled="!canRun"
        :generate-status="pipelineGenerateStatus"
        @generate="openRunConfirm"
      >
        <template #actions>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="!canRun"
            title="Recover saved provider results first, then repair only missing output in the selected stages."
            @click="openRepairConfirm"
          >Repair Selected Gaps</button>
        </template>
      </TopActionBar>
      <p class="pipeline-command-copy">
        Each episode follows the <strong>{{ chainLabel }}</strong> chain in order while separate episodes share the available queue capacity.
        Preset choices stay pinned to this project, and completed work is skipped unless you explicitly force a re-run.
      </p>
      <p class="pipeline-command-copy pipeline-command-hint">
        <strong>Run Batch</strong> queues the selected steps for the selected episodes and skips anything already finished.
        <strong>Repair selected gaps</strong> first collects results that finished but never saved, then redoes only what is still missing in the selected steps — that part may use credits.
        Both ask before anything starts.
      </p>
      <WorkspaceNotice v-if="formatError" tone="warning" title="Production flow unavailable">
        {{ formatError }} Stage selection and batch actions stay disabled until the project format is available.
      </WorkspaceNotice>
    </div>

    <WorkspaceNotice v-if="lineupNotice" tone="info" title="The LLM lineup is gone" class="lineup-retired-notice">
      Each step now uses one writing model. We kept “{{ lineupNotice.model }}” for
      {{ lineupNotice.steps.length ? `these steps: ${lineupNotice.steps.join(', ')}` : 'any step with no writing model of its own' }}.
      To fall back across several models, make a pool in GatewayKH → Providers → Pools and pick it here.
      <template #actions>
        <button type="button" class="btn btn-sm btn-secondary" @click="dismissLineupNotice">Got It</button>
      </template>
    </WorkspaceNotice>

    <!-- ── Steps to run ─────────────────────────────────────────────────── -->
    <WorkspaceSection
      eyebrow="Stage selection"
      title="Steps to run"
      description="Nothing is selected automatically. Choose stages manually or use a safe shortcut; every selected stage keeps its project-level preset until you change it."
    >
      <template #actions>
        <div class="step-selection-actions" role="group" aria-label="Stage selection shortcuts">
          <span class="step-selection-count">{{ checkedStepCount }} selected</span>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="!visualSource"
            title="Select every required stage in the current production chain. Optional Research and paid Motion Clips stay off. An Introduction is not a choice here — it follows what the channel says."
            @click="selectRequiredSteps"
          >Required Stages</button>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="!visualSource"
            title="Select every available stage in the current production chain, including optional and paid stages."
            @click="selectAllSteps"
          >Select All</button>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            :disabled="checkedStepCount === 0"
            title="Clear every selected stage."
            @click="clearSelectedSteps"
          >Clear</button>
        </div>
      </template>

      <div class="steps-grid mt-2">
        <template v-for="entry in chainEntries" :key="entry.kind === 'step' ? entry.id : entry.key">
          <!-- Batchable step → checkbox tile (enqueued by Run Batch).
               v1.4.73 — "you cannot change this here" and "this will not run"
               are different facts. The Introduction is locked either way, so
               the greyed-out styling is applied only when it will NOT run;
               otherwise the tile would say the wrong one of the two. -->
          <article
            v-if="entry.kind === 'step'"
            class="step-tile"
            :class="{
              selected: stepChecked[entry.id],
              missing: stepChecked[entry.id] && !presetNameFor(entry.id) && !noPresetStep(entry.id) && !musicPresetOptional(entry.id),
              costly: entry.costly,
              disabled: stepDisabled(entry.id) && !stepChecked[entry.id],
              'policy-expanded': modelPolicyExpanded[entry.id],
            }"
            :title="stepDisabledReason(entry.id)"
          >
            <input
              type="checkbox"
              class="step-toggle"
              v-model="stepChecked[entry.id]"
              :disabled="stepDisabled(entry.id)"
              :aria-label="`Run ${entry.label}`"
            />
            <div class="step-body">
              <div class="step-head">
                <span class="step-icon" aria-hidden="true">{{ entry.icon }}</span>
                <strong>{{ entry.label }}</strong>
              </div>
              <div v-if="!noPresetStep(entry.id)" class="step-preset" @click.stop>
                <label class="step-preset-label">Preset</label>
                <select
                  class="step-preset-select"
                  :value="activePresetIdFor(entry.id)"
                  :disabled="presetSaving[entry.id]"
                  :title="presetSelectTooltip(entry.id)"
                  @change="onPresetChange(entry.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">— pick one —</option>
                  <option
                    v-for="p in presetsForStep(entry.id)"
                    :key="p.id"
                    :value="p.id"
                  >{{ p.name }}</option>
                </select>
                <NuxtLink
                  :to="`/projects/${slug}${entry.link}`"
                  class="preset-link"
                  title="Open the per-stage page to edit, save-as, rename or delete this step's presets."
                >Manage →</NuxtLink>
                <span v-if="!activePresetIdFor(entry.id) && musicPresetOptional(entry.id)" class="step-preset-none">Optional — each episode renders with its own music settings; a preset only adds your logo and look.</span>
                <span v-else-if="!activePresetIdFor(entry.id)" class="preset-missing">⚠ no preset selected</span>
              </div>
              <!-- v1.0.363 — preset-free step (e.g. Timestamp final render): runs
                   on the generator's export defaults, configurable on its page. -->
              <div v-else class="step-preset" @click.stop>
                <span class="step-preset-none">{{ noPresetNote(entry.id) }}</span>
                <NuxtLink
                  :to="`/projects/${slug}${entry.link}`"
                  class="preset-link"
                  title="Open the page that owns these settings."
                >Tune →</NuxtLink>
              </div>
              <div v-if="modelPolicyFor(entry.id)" class="step-model-policy" @click.stop>
                <details class="disclosure" @toggle="setModelPolicyExpanded(entry.id, ($event.target as HTMLDetailsElement).open)">
                  <summary>
                    Models for this run
                    <span class="step-model-policy-summary">{{ modelPolicySummary(entry.id) }}</span>
                  </summary>
                  <div class="step-model-policy-body">
                    <label class="step-model-policy-toggle">
                      <input
                        type="checkbox"
                        :checked="modelPolicyFor(entry.id)!.enabled"
                        @change="setModelPolicyEnabled(entry.id, ($event.target as HTMLInputElement).checked)"
                      />
                      Use a different writing model for this run
                    </label>
                    <template v-if="modelPolicyFor(entry.id)!.enabled">
                      <div class="step-model-policy-candidates">
                        <div class="step-model-policy-candidate">
                          <ModelSelector
                            :model-value="modelPolicyFor(entry.id)!.model"
                            :project-slug="slug"
                            label="Writing model"
                            @update:model-value="setModelPolicyModel(entry.id, $event)"
                            @model-meta="setModelPolicyModelMeta(entry.id, $event)"
                          />
                          <p v-if="modelPolicyLimits(entry.id)" class="step-model-policy-limits">
                            {{ modelPolicyLimits(entry.id) }}
                          </p>
                        </div>
                      </div>
                      <p v-if="modelPolicyError(entry.id)" class="step-model-policy-error" role="status">{{ modelPolicyError(entry.id) }}</p>
                    </template>
                  </div>
                </details>
              </div>
              <div v-if="stepDisabled(entry.id)" class="step-warning">{{ stepDisabledReason(entry.id) }}</div>
              <div v-else-if="entry.warning" class="step-warning">⚠ {{ entry.warning }}</div>
            </div>
          </article>
          <!-- External node → read-only "Open page →" card. Not enqueued by
               Run Batch; documents the real chain order + where to run it. -->
          <div
            v-else
            class="step-tile step-tile-external"
            :title="entry.note"
          >
            <span class="external-badge" aria-hidden="true">↗</span>
            <div class="step-body">
              <div class="step-head">
                <span class="step-icon" aria-hidden="true">{{ entry.icon }}</span>
                <strong>{{ entry.label }}</strong>
              </div>
              <div class="step-external-note">{{ entry.note }}</div>
              <NuxtLink :to="`/projects/${slug}${entry.link}`" class="preset-link">Open page →</NuxtLink>
            </div>
          </div>
        </template>
      </div>
      <p class="text-muted text-sm mt-2">
        Showing the <strong>{{ chainLabel }}</strong> chain.
        <span v-if="hasExternalNodes">Steps marked “↗” run from their own page (not part of Run Batch) — they're shown here so the full order is visible.</span>
      </p>

      <!-- v1.4.73 — say what a run will produce BEFORE it starts.
           This behaviour is new: a channel that opens with an Introduction now
           gets one on every episode a batch writes, where before it depended on
           somebody ticking a box. That is the point of the change, but a
           surprise is still a surprise. -->
      <WorkspaceNotice
        v-if="channelIntroEnabled && stepChecked['script-only']"
        tone="info"
        title="Every episode in this run will also get an Introduction"
      >
        This channel is set to open with one, so it is written automatically alongside the chapters —
        there is nothing to tick. It adds a few hundred words per episode and no separate audio charge.
        Change it under <NuxtLink :to="`/projects/${slug}/introduction`">Introduction</NuxtLink>.
      </WorkspaceNotice>

      <WorkspaceNotice
        v-if="channelIntroUnknown"
        tone="warning"
        title="Could not check whether this channel opens with an Introduction"
      >
        The Introduction step follows the channel setting, which Story Studio could not read. It stays
        off for this run rather than being guessed, so an episode the channel wants an opening for
        would be written without one. Confirm the setting before running.
        <template #actions>
          <button type="button" class="btn btn-sm btn-secondary" @click="loadChannelIntroduction">Retry</button>
          <NuxtLink :to="`/projects/${slug}/introduction`" class="btn btn-sm btn-secondary">Open Introduction</NuxtLink>
        </template>
      </WorkspaceNotice>

      <WorkspaceNotice v-if="preflightSummary" tone="success" title="Preflight passed">
        {{ preflightSummary }}
      </WorkspaceNotice>
      <WorkspaceNotice v-if="batchBlocked.length" tone="warning" title="Some selected episodes need attention">
        <span>These episodes remain selected, but no work was started for them. Fix the listed issue, then run the batch again.</span>
        <span v-for="blocked in batchBlocked" :key="blocked.episode_id" class="batch-blocked-reason">
          <strong>{{ blocked.episode_id }}</strong> — {{ blocked.reason }}
        </span>
        <NuxtLink v-if="batchHasJobs" :to="`/projects/${slug}/jobs`" class="btn btn-sm btn-secondary mt-2">
          View Queued Jobs
        </NuxtLink>
      </WorkspaceNotice>
    </WorkspaceSection>

    <!-- ── Episodes to include ──────────────────────────────────────────── -->
    <WorkspaceSection
      eyebrow="Batch scope"
      title="Episodes"
      description="Filter, sort, and select the episodes that should enter this run. Selection remains intact while you move between pages."
    >
      <template #actions>
        <div class="ep-actions-row">
          <!-- Bulk mark/unmark — only visible when there's a selection so
               the row stays uncluttered for the common (no-selection) case.
               Sit at the front because they act on the current selection
               and the user thinks "what do I do with these checked rows?"
               left-to-right. -->
          <template v-if="selectedEpisodes.size > 0">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="bulkMarking"
              :title="`Mark all ${selectedEpisodes.size} selected episode(s) as already done. Asks for confirmation. Reversible.`"
              @click="bulkMarkSelected(true)"
            >
              {{ bulkMarking ? 'Working…' : `✓ Mark ${selectedEpisodes.size} as Done` }}
            </button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="bulkMarking"
              :title="`Unmark all ${selectedEpisodes.size} selected episode(s). Asks for confirmation. Status falls back to file detection.`"
              @click="bulkMarkSelected(false)"
            >
              ↻ Unmark {{ selectedEpisodes.size }}
            </button>
            <span class="ep-actions-divider" aria-hidden="true" />
          </template>

          <!-- Global selection (across all pages, respects current filter) -->
          <button class="btn btn-sm btn-secondary" :title="selectButtonTitle" @click="selectAllPending">Select All Pending</button>
          <button class="btn btn-sm btn-secondary" :title="selectAllTitle" @click="selectAll">Select All</button>

          <span class="ep-actions-divider" aria-hidden="true" />

          <!-- Page-scoped selection — quick way to grab just the visible
               page so you can review + mark-done one page at a time. -->
          <button
            class="btn btn-sm btn-secondary"
            title="Select only the episodes visible on this page (respects current sort + filter)."
            @click="selectAllOnPage"
          >Select Page</button>
          <button
            class="btn btn-sm btn-secondary"
            title="Select only this page's episodes that still need at least one core step. Adds to the existing selection."
            @click="selectAllPendingOnPage"
          >Select Pending on Page</button>

          <span class="ep-actions-divider" aria-hidden="true" />

          <button class="btn btn-sm btn-secondary" @click="selectNone">Clear</button>
          <button class="btn btn-sm btn-ghost" :disabled="epLoading || epRevalidating" @click="onRefreshClick" title="Refresh episode statuses. Shift-click to rebuild every row — slower, use after files change on disk outside the app.">
            {{ (epLoading || epRevalidating) ? '⟳ Refreshing…' : '↻ Refresh' }}
          </button>
        </div>
      </template>

      <p class="text-muted text-sm mt-1 ep-actions-hint">
        <strong>Select all pending</strong> picks every episode still missing a selected step, across all pages;
        <strong>Select all</strong> picks every episode (both follow the Show filter).
        <strong>Select page</strong> and <strong>Select pending on page</strong> only touch the page you are looking at.
        <template v-if="selectedEpisodes.size > 0"><strong>Mark as done</strong> / <strong>Unmark</strong> change the recorded status only — nothing is made or deleted.</template>
      </p>

      <!-- Sort + filter + pagination toolbar. Scales the list to 100+ episodes
           without overwhelming the viewport. Sort + filter are derivations
           on `episodes.value` (no network calls); pagination is a pure
           slice. Selection checkboxes live in a Set keyed by episode_code,
           so selecting across multiple pages or after filter changes keeps
           the user's intent intact. -->
      <div v-if="episodes.length" class="episode-toolbar mt-2">
        <!-- Search by episode code or title. Mirrors the Ideas page's search
             box at the front of its filter row. Empty = no filter. -->
        <div class="toolbar-group toolbar-search">
          <input
            v-model="searchQuery"
            class="input input-sm pipeline-search-input"
            type="search"
            placeholder="Search episode code or title…"
            title="Filter the list to episodes whose code or title contains this text. Combines with the Show filter on the right."
          />
          <button
            v-if="searchQuery"
            type="button"
            class="search-clear-btn"
            title="Clear search"
            aria-label="Clear search"
            @click="searchQuery = ''"
          >✕</button>
        </div>

        <div class="toolbar-group">
          <label class="toolbar-label">Sort</label>
          <select v-model="sortKey" class="select input-sm">
            <option value="code-asc">Episode code · oldest first</option>
            <option value="code-desc">Episode code · newest first</option>
            <option value="title">Title · A → Z</option>
            <option value="missing-desc">Most missing steps first</option>
            <option value="missing-asc">Fewest missing first (nearly done)</option>
          </select>
        </div>

        <div class="toolbar-group">
          <label class="toolbar-label">Show</label>
          <select
            v-model="filterMode"
            class="select input-sm"
            title="Narrow the list to episodes missing a specific pipeline step. Counts reflect how many episodes are missing that step."
          >
            <optgroup label="Overview">
              <option value="all">All episodes ({{ episodes.length }})</option>
              <option value="missing-only">Missing any core component ({{ pendingEpisodesCount }})</option>
            </optgroup>
            <optgroup label="Missing a required stage">
              <option
                v-for="step in requiredFilterSteps"
                :key="`required-${step.id}`"
                :value="filterModeForStep(step.id)"
              >Missing {{ stepFilterLabel(step) }} ({{ missingCountByStep[step.id] ?? 0 }})</option>
            </optgroup>
            <optgroup v-if="optionalFilterSteps.length" label="Missing an optional stage">
              <option
                v-for="step in optionalFilterSteps"
                :key="`optional-${step.id}`"
                :value="filterModeForStep(step.id)"
              >Missing {{ stepFilterLabel(step) }} ({{ missingCountByStep[step.id] ?? 0 }})</option>
            </optgroup>
          </select>
          <span
            v-if="filterMode !== 'all'"
            class="filter-hit-badge"
            :title="`${filteredHitCount} episode(s) match the current filter`"
          >{{ filteredHitCount }} match</span>
        </div>

        <div class="toolbar-group">
          <label class="toolbar-label" for="pipeline-page-size">Rows</label>
          <select id="pipeline-page-size" v-model.number="pageSize" class="select input-sm" title="Episodes shown on each page. Your selected episodes remain selected.">
            <option :value="10">10</option>
            <option :value="25">25</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </div>

        <div class="toolbar-pagination" aria-label="Episode pages">
          <span class="toolbar-count">{{ visibleRangeText }}</span>
          <button class="btn btn-sm btn-secondary pagination-edge" :disabled="currentPage <= 1" @click="goToPage(1)" title="First page" aria-label="First page">«</button>
          <button class="btn btn-sm btn-secondary" :disabled="currentPage <= 1" @click="goToPage(currentPage - 1)">Prev</button>
          <span class="page-indicator">
            Page <strong>{{ currentPage }}</strong> of {{ totalPages }}
          </span>
          <button class="btn btn-sm btn-secondary" :disabled="currentPage >= totalPages" @click="goToPage(currentPage + 1)">Next</button>
          <button class="btn btn-sm btn-secondary pagination-edge" :disabled="currentPage >= totalPages" @click="goToPage(totalPages)" title="Last page" aria-label="Last page">»</button>
        </div>
      </div>

      <div v-if="epLoading && !episodes.length" class="text-muted text-md mt-2">
        <LoadingSpinner size="sm" /> Loading episodes…
      </div>

      <!-- E-06 (DS-09) — a failed read is not "no accepted ideas". -->
      <div v-else-if="!episodes.length && epError" class="text-muted text-md mt-2">
        Could not load this project's accepted ideas. Nothing was changed.
        <button class="btn btn-sm btn-secondary" @click="refreshEpisodes">Retry</button>
      </div>

      <div v-else-if="!episodes.length" class="text-muted text-md mt-2">
        No accepted ideas yet. Go to <NuxtLink :to="`/projects/${slug}/ideas`">Ideas Generator</NuxtLink> and accept some first.
      </div>

      <div v-else-if="!sortedFilteredEpisodes.length" class="text-muted text-md mt-2">
        No episodes match the current filter. Switch "Show" back to All to see everything.
      </div>

      <div v-else class="episode-list mt-2">
        <article
          v-for="ep in paginatedEpisodes"
          :key="ep.episode_code"
          class="episode-row"
          :class="{
            selected: selectedEpisodes.has(ep.episode_code),
            'marked-done': ep.marked_done,
          }"
          @click="toggleEpisode(ep.episode_code)"
        >
          <input type="checkbox" :checked="selectedEpisodes.has(ep.episode_code)" @click.stop @change="toggleEpisode(ep.episode_code)" />
          <div class="ep-main">
            <div class="ep-head">
              <strong>{{ ep.episode_code }}</strong>
              <span class="ep-title">{{ ep.title }}</span>
              <span v-if="localMediaStatusLabel(ep.local_media_status)" class="ep-media-status">{{ localMediaStatusLabel(ep.local_media_status) }}</span>
              <!-- Manual-done pill: visible only when the user explicitly
                   flagged this episode "already done" (e.g. for YouTube
                   imports the pipeline should stop nagging about). The pill
                   is the at-a-glance signal that this row's green pills come
                   from a manual override, not from file detection. -->
              <span
                v-if="ep.marked_done"
                class="manual-done-pill"
                title="This episode was manually marked done — file detection is bypassed. Use the menu (⋮) to revert."
              >✓ Done (manual)</span>
            </div>
            <!-- Per-step completion indicator. One pill per pipeline step,
                 same order + icons as the step-tile list above so the row
                 reads like a progress bar. Done steps are solid green with
                 a ✓ corner marker; missing steps are muted so the gaps are
                 visible at a glance. Done-ness uses the same truth table as
                 the backend's isStepAlreadyDone(), so pills never disagree
                 with the skip logic. -->
            <div class="ep-status">
              <span
                v-for="step in visibleSteps"
                :key="step.id"
                :class="[
                  'ep-pill',
                  !isStepApplicableForEpisode(step.id, ep)
                    ? 'not-applicable'
                    : (isStepDoneForEpisode(step.id, ep.status) ? 'done' : 'missing'),
                  isStepApplicableForEpisode(step.id, ep) && !isStepDoneForEpisode(step.id, ep.status)
                    ? stepJobState(step.id, ep) || ''
                    : '',
                  isStepManualForEpisode(step.id, ep) ? 'manual' : '',
                ]"
                :title="isStepApplicableForEpisode(step.id, ep) ? pillTitle(step, ep) : `${step.label} is not used for this episode’s visual source.`"
              >
                {{ isStepApplicableForEpisode(step.id, ep) ? step.icon : '—' }}
              </span>
            </div>
            <EpisodeVisualSource
              :slug="slug"
              :episode-id="ep.episode_code"
              :source="episodeVisualSource(ep)"
              @changed="onEpisodeVisualSourceChanged(ep.episode_code, $event)"
            />
          </div>
          <!-- Per-episode kebab menu. Wraps in a click.stop'ed div so
               clicking the trigger doesn't toggle the row selection.
               The menu sits in a portal-free absolute popover anchored to
               the button — sufficient for the row count we expect. -->
          <div class="ep-kebab" @click.prevent.stop>
            <button
              class="kebab-trigger"
              :aria-expanded="openKebabFor === ep.episode_code"
              :aria-label="`Actions for ${ep.episode_code}`"
              title="More actions"
              @click="toggleKebab(ep.episode_code, $event)"
            >⋮</button>
            <!-- Teleport to <body> with fixed positioning so the menu can
                 never be clipped by the surrounding scroll container or
                 the page-content overflow. positionKebabFor() computes
                 top/left from the trigger's bounding rect when opening,
                 and auto-flips upward if there's not enough room below. -->
            <Teleport to="body">
              <div
                v-if="openKebabFor === ep.episode_code && kebabPos"
                class="kebab-menu"
                role="menu"
                :style="{
                  top: kebabPos.top + 'px',
                  left: kebabPos.left + 'px',
                  width: kebabPos.width + 'px',
                }"
              >
                <button
                  v-if="!ep.marked_done"
                  class="kebab-item"
                  role="menuitem"
                  @click="onMarkDone(ep, true)"
                >
                  <span class="kebab-icon">✓</span>
                  <div class="kebab-body">
                    <strong>Mark as already done</strong>
                    <span class="kebab-hint">Stop the pipeline from nagging about this episode. Useful for YouTube imports.</span>
                  </div>
                </button>
                <button
                  v-else
                  class="kebab-item"
                  role="menuitem"
                  @click="onMarkDone(ep, false)"
                >
                  <span class="kebab-icon">↻</span>
                  <div class="kebab-body">
                    <strong>Unmark — revert to file detection</strong>
                    <span class="kebab-hint">Drop the manual override. Asset state will reflect what's actually on disk.</span>
                  </div>
                </button>
                <button
                  class="kebab-item"
                  role="menuitem"
                  @click="openImportFor(ep)"
                >
                  <span class="kebab-icon">📥</span>
                  <div class="kebab-body">
                    <strong>Import existing assets…</strong>
                    <span class="kebab-hint">Copy weirdly-named files from disk into the canonical episode folders.</span>
                  </div>
                </button>
                <button
                  class="kebab-item"
                  role="menuitem"
                  @click="openOverridesFor(ep)"
                >
                  <span class="kebab-icon">⚙</span>
                  <div class="kebab-body">
                    <strong>Edit asset overrides…</strong>
                    <span class="kebab-hint">Pin individual asset states (Force ✓ / Force ✗ / Detect) for this episode.</span>
                  </div>
                </button>
              </div>
            </Teleport>
          </div>
        </article>
      </div>

      <!-- Asset import dialog — shared across all rows. importEpisode tracks
           which row the kebab launched it from. -->
      <AssetImportDialog
        v-if="importEpisode"
        :visible="!!importEpisode"
        :slug="slug"
        :episode-code="importEpisode.episode_code"
        :chapter-count="importEpisode.suggested_chapters"
        @close="importEpisode = null"
        @imported="onImported"
      />

      <!-- Per-asset override picker — same shared-instance pattern. -->
      <StatusOverridePicker
        v-if="overrideEpisode"
        :visible="!!overrideEpisode"
        :slug="slug"
        :episode-code="overrideEpisode.episode_code"
        :initial="overrideEpisode.status_overrides as any"
        @close="overrideEpisode = null"
        @saved="onOverridesSaved"
      />

      <p v-if="episodes.length" class="pill-legend text-muted text-sm mt-2">
        Step icons: <span class="ep-pill done legend-pill" aria-hidden="true">✓</span> done ·
        <span class="ep-pill missing legend-pill" aria-hidden="true">○</span> not made yet ·
        <span class="ep-pill missing active legend-pill" aria-hidden="true">○</span> being made now ·
        <span class="ep-pill missing failed legend-pill" aria-hidden="true">○</span> last attempt failed — retry it from
        <NuxtLink :to="`/projects/${slug}/jobs`">Jobs</NuxtLink> or run the batch again (finished steps are skipped).
      </p>

      <div v-if="episodes.length" class="selection-summary mt-2 text-muted text-sm">
        <strong>{{ selectedEpisodes.size }}</strong> of {{ episodes.length }} episode(s) selected · estimated queued stages = {{ selectedApplicableStepCount }}
        <span v-if="selectedEpisodes.size && checkedStepCount">. This reflects each row’s visual source; the run receipt confirms the actual queued jobs after chain expansion and skips.</span>
        <template v-if="filterMode !== 'all' || sortKey !== 'code-asc'">
          · showing <strong>{{ sortedFilteredEpisodes.length }}</strong> after filter/sort
        </template>
      </div>
    </WorkspaceSection>

    <WorkspaceSection
      eyebrow="Optional post-Subtitle review"
      title="Audio quality"
      description="Check saved narration and transcript evidence for the selected episodes. This review is separate from Run Batch and never blocks an ordinary pipeline run."
    >
      <template #actions>
        <div class="pipeline-quality-actions">
          <NuxtLink :to="`/projects/${slug}/settings#production`" class="btn btn-sm btn-secondary">
            Quality Setting
          </NuxtLink>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="pipelineQualityActionDisabled"
            @click="checkSelectedAudioQuality"
          >
            <LoadingSpinner v-if="pipelineQualityChecking" size="sm" />
            {{ pipelineQualityActionLabel }}
          </button>
        </div>
      </template>

      <div class="pipeline-quality-summary">
        <span class="pipeline-quality-mode">{{ pipelineQualityModeLabel }}</span>
        <p>{{ pipelineQualityDescription }}</p>
      </div>
      <p v-if="pipelineQualityMode === 'off'" class="text-muted text-sm mt-2">
        Turn on Flag issues or Check and repair in Project Settings before checking a backlog.
      </p>
      <p v-else class="text-muted text-sm mt-2">
        The check reads completed chapter audio and saved subtitle evidence only. It does not call a provider or spend credits.
        Chapters that need attention open on Audio, where any repair remains a separate quoted and confirmed action.
      </p>

      <ul v-if="pipelineQualityResults.length" class="pipeline-quality-results mt-2" aria-live="polite">
        <li
          v-for="result in pipelineQualityResults"
          :key="result.episode"
          :data-tone="result.error || result.review > 0 ? 'warning' : 'success'"
        >
          <div>
            <strong>{{ result.episode }}</strong>
            <span>{{ pipelineQualityResultText(result) }}</span>
          </div>
          <NuxtLink
            v-if="result.review > 0"
            :to="`/projects/${slug}/audio?episode_id=${encodeURIComponent(result.episode)}`"
            class="btn btn-sm btn-secondary"
          >Review audio</NuxtLink>
        </li>
      </ul>
    </WorkspaceSection>

    <!-- ── Blocking problems summary ────────────────────────────────────── -->
    <WorkspaceNotice v-if="blockingIssues.length" tone="warning" title="This batch is not ready to start">
      <ul class="mt-1 problems-list">
        <li v-for="(msg, i) in blockingIssues" :key="i">{{ msg }}</li>
      </ul>
    </WorkspaceNotice>


    <Modal :visible="!!batchReceipt" size="md" labelledby="batch-result-title" @close="batchReceipt = null">
      <template v-if="batchReceipt">
        <h3 id="batch-result-title">{{ batchReceipt.title }}</h3>
        <ul class="mt-2 problems-list">
          <li v-for="line in batchReceipt.lines" :key="line">{{ line }}</li>
        </ul>
        <p v-if="batchReceipt.jobsUrl" class="text-muted text-sm mt-2">
          Work continues as the queue has capacity. You can stay here or follow its progress in Jobs.
        </p>
        <p v-if="batchBlocked.length" class="text-muted text-sm mt-2">
          Episodes that could not start remain selected. Their reasons are shown on Pipeline.
        </p>
        <div class="flex flex-wrap gap-2 mt-3 justify-end">
          <button class="btn btn-secondary" @click="batchReceipt = null">Stay on Pipeline</button>
          <NuxtLink v-if="batchReceipt.jobsUrl" :to="batchReceipt.jobsUrl" class="btn btn-primary">View Jobs</NuxtLink>
        </div>
      </template>
    </Modal>

    <!-- ── Confirmation modal ───────────────────────────────────────────── -->
    <Modal :visible="showConfirm" size="md" labelledby="batch-confirm-title" @close="closeConfirm()">
      <h3 id="batch-confirm-title">{{ preflighting ? 'Checking selected episodes…' : (repairMode ? 'Repair selected gaps?' : 'Run batch?') }}</h3>
      <p class="text-muted text-md mt-1">
        <template v-if="preflighting">
          Checking <strong>{{ selectedEpisodes.size }}</strong> selected episode(s) and <strong>{{ checkedStepCount }}</strong>
          selected step(s) before anything starts. This does not queue work or spend credits.
        </template>
        <template v-else-if="repairMode">
          Check up to <strong>{{ preflightEligibleCount }}</strong> eligible episode(s) for gaps across
          <strong>{{ checkedStepCount }}</strong> selected step(s).
        </template>
        <template v-else>
          About to queue an estimated <strong>{{ preflightEligibleApplicableStepCount }}</strong> selected stage(s) across
          <strong>{{ preflightEligibleCount }}</strong> eligible episode(s). Each episode uses its own visual source.
        </template>
      </p>
      <p v-if="preflightBlocked.length" class="text-muted text-sm mt-2">
        <strong>{{ preflightBlocked.length }}</strong> selected episode(s) need attention and will not start. They remain selected after this run.
      </p>
      <div class="chain-preview">
        <span v-for="(step, i) in checkedStepsOrdered" :key="step.id" class="chain-step">
          <span class="chain-icon" aria-hidden="true">{{ step.icon }}</span>
          <span>{{ step.label }}</span>
          <span v-if="i < checkedStepsOrdered.length - 1" class="chain-arrow">→</span>
        </span>
      </div>
      <div v-if="batchEstimate && !preflighting" class="batch-estimate text-sm mt-2" data-testid="batch-estimate">
        <strong>Estimated provider cost: {{ batchEstimate.priced.length ? formatUsd(batchEstimate.totalUsd) : 'nothing priced' }}</strong>
        <span class="text-muted"> — an estimate from the prices the providers last published; the finished jobs report the real cost.</span>
        <ul>
          <li v-for="line in batchEstimate.priced" :key="line.id">{{ line.label }}: {{ formatUsd(line.usd) }} ({{ line.detail }})</li>
          <li v-for="line in batchEstimate.free" :key="line.id">{{ line.label }}: free</li>
          <li v-for="line in batchEstimate.notIncluded" :key="line.id" class="text-muted">{{ line.label }}: not included — {{ line.reason }}</li>
        </ul>
      </div>
      <p v-if="repairMode" class="text-muted text-sm mt-2">
        Valid completed outputs are kept. Story Studio reconnects to saved provider work first. For each
        selected item still missing after a confirmed terminal failure or expired artifact, this action
        may use credits for one fresh attempt at the current live price. Active or uncertain requests
        are held without a duplicate submission, and Scene Review approval remains explicit.
      </p>
      <p v-else class="text-muted text-sm mt-2">
        Steps within each episode run in order. Different episodes' steps run
        concurrently when the queue has capacity. An episode chain can expand into dependent jobs and skip completed or inapplicable stages;
        the receipt confirms the actual queued count. If a step fails, only the later steps that need it wait (for example,
        a failed thumbnail does not stop the audio or the video); Retry the failed job in Jobs and the waiting steps continue on their own.
      </p>
      <p v-if="modelPolicyRunSummary.length" class="text-muted text-sm mt-2">
        <template v-for="(line, index) in modelPolicyRunSummary" :key="line">
          <span v-if="index"> </span>{{ line }}
        </template>
      </p>

      <!-- Force re-run toggle: skip-when-done is the default so routine
           runs over partially-complete episodes don't burn tokens on
           regeneration. Opt in here to regenerate regardless of existing
           output. -->
      <label v-if="!repairMode" class="force-rerun" :title="forceRerunTitle">
        <input type="checkbox" v-model="forceRerun" />
        <span class="force-rerun-label">
          Force re-run
          <span class="force-rerun-hint">
            — regenerate selected stages, including intentionally cleaned local sources. Normal prerequisites still apply and provider costs may repeat.
          </span>
        </span>
      </label>

      <div class="flex gap-2 mt-3 justify-end">
        <button class="btn btn-secondary" :disabled="submitting" @click="closeConfirm()">Cancel</button>
        <button class="btn btn-primary" :disabled="submitting || preflighting || preflightEligibleCount === 0" @click="submit">
          <LoadingSpinner v-if="submitting" size="sm" />
          {{ preflighting ? 'Checking…' : (submitting ? 'Queuing…' : (repairMode ? 'Start repair · may use credits' : (forceRerun ? 'Start batch (force)' : 'Start batch'))) }}
        </button>
      </div>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import {
  isFlowStepApplicable,
  visualSourceFromFormat,
  type EpisodeVisualSource,
  type FlowStep,
  type VisualSource,
} from '~/composables/useProjectFlow'
import { localMediaStatusLabel, type LocalMediaCleanupStatus } from '~/composables/useEpisodes'
import { episodeStepJobStates } from '~/utils/episode-step-jobs'
import type { AudioQualityMode, AudioQualityPlan } from '~/types/audio-quality'
import { ESTIMATE_STEPS, estimateBatchUsd, formatUsd, stepQuantity, type EstimateStep } from '~/utils/genstudio-price-usd'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Pipeline')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, patch: patchApi } = useApi()
const { success, error: showError, info: showInfo } = useToast()
const { ask } = useConfirm()
const { config, refreshConfig } = useProject()
const pipelineQualityAction = useFreshGenerationAction()

// ── Active pipeline (format-aware) ──────────────────────────────────────
// The Pipeline reads the project's effective visual source and renders only
// the steps that belong to the active continuity workflow. Timestamp-driven
// projects add Research up front, then Scene Plan / Scene Review / unified
// Video Assembly at the end.
// External (non-batchable) nodes are display-only: they document the real
// chain order but are never enqueued by Run Batch.
// The effective format returns only the active visual-source vocabulary:
// timestamp-driven, continuity-chain, or narrated-scenes. Any unknown saved
// value leaves source-dependent controls unavailable rather than assuming a flow.
type VS = VisualSource
const visualSource = ref<VS | null>(null)
const formatError = ref('')
let formatRequest = 0
async function loadVisualSource(): Promise<void> {
  const projectSlug = slug.value
  const request = ++formatRequest
  visualSource.value = null
  formatError.value = ''
  if (!projectSlug) return
  try {
    const f = await get<{ visualSource?: unknown; musicChannel?: unknown }>(`/projects/${projectSlug}/effective-format`)
    if (request !== formatRequest || projectSlug !== slug.value) return
    const source = visualSourceFromFormat(f)
    if (!source) {
      formatError.value = 'The project returned an unknown production format. Refresh this project before choosing batch work.'
      return
    }
    visualSource.value = source
  } catch (error: any) {
    if (request !== formatRequest || projectSlug !== slug.value) return
    formatError.value = error?.data?.detail || error?.message || 'Could not load this project’s production format.'
  }
}
const isTimestampDriven = computed(() => visualSource.value === 'timestamp-driven')
// Continuity-chain shares the audio-paced chain and adds Character Sheet
// context to each GenStudio text-to-image scene prompt.
const isContinuityChain = computed(() => visualSource.value === 'continuity-chain')
// v1.0.300 — narrated-scenes: transcript-driven scene plan for STORY/fiction
// (sleep stories). It keeps Research available as an explicit optional stage
// and exposes Character Sheet for channels that want a reusable visual anchor.
const isNarratedScenes = computed(() => visualSource.value === 'narrated-scenes')
watch(slug, () => {
  void loadVisualSource()
  // v1.0.368 — pull a FRESH config on entry. The shared useProject() config
  // singleton is populated once at project-entry; a preset saved on a step's
  // page later in the same session (e.g. a new Audio Assembly preset) wasn't
  // reflected here until a full reload, so the step showed "no preset selected"
  // even though the pointer + preset were saved. Refreshing on mount + slug
  // change keeps the preset pickers in sync with what's on disk.
  if (slug.value && slug.value !== 'undefined') void refreshConfig(slug.value)
}, { immediate: true })

// ── Step metadata ──────────────────────────────────────────────────────
// ID matches the BatchStep enum on the backend (routes/pipeline.ts).
//
// `script-only` and `introduction-only` replaced the legacy coupled
// `script` step in M1. They live in separate checkboxes so users can
// run chapters without intros (or vice-versa for retro-fitting intros
// to already-generated scripts via the per-page UI). The intro step is
// gated on the script step in this UI — see `stepDisabled` below.
type StepId =
  | 'research' | 'script-only' | 'introduction-only'
  | 'image_prompts' | 'thumb_images' | 'audio' | 'audio_merge'
  | 'metadata' | 'video_assembly'
  // v1.0.363 — audio-paced format steps, now chained by the batch runner
  // instead of being read-only "Open page →" nodes.
  | 'subtitles' | 'scene_plan' | 'contextual_cues' | 'scene_review' | 'motion_review' | 'character_sheet'
  // Music channels: Episode Builder's draw (when the episode has none yet) + stitch.
  | 'music_build'
interface StepMeta {
  id: StepId
  label: string
  icon: string
  link: string
  /** Absent for a step in NO_PRESET_STEPS, which has no preset to pick. */
  presetList?: string
  presetActive?: string
  /** If true, unchecked by default — user must opt in. For cost-sensitive steps. */
  costly?: boolean
  /** Human-readable warning rendered on the step tile when costly. */
  warning?: string
  /** Opt-in stage that never makes an otherwise finished episode pending. */
  optional?: boolean
}

// v1.0.167 — External chain nodes. These are real steps in the
// timestamp-driven chains that the batch runner does NOT enqueue (Sound Design
// review). We render them inline so the chain reads end-to-end, each with an
// "Open page →" link to the page that actually runs it. They carry no checkbox, no
// preset, and never count toward the batch.
interface ExternalNode {
  kind: 'external'
  key: string
  label: string
  icon: string
  link: string
  /** Short note shown under the node explaining where/why it runs. */
  note: string
}
// A chain entry is either a batchable step or an external (open-the-page) node.
type ChainEntry = ({ kind: 'step' } & StepMeta) | ExternalNode

// Character Sheet, Scene Plan, Scene Review, and Video Assembly
// were promoted from read-only external nodes to real batchable steps.
const EXTERNAL_NODES: Record<string, ExternalNode> = {
  sound_design: {
    kind: 'external', key: 'sound_design', label: 'Sound Design (review)', icon: '🎵', link: '/sound-design',
    note: 'Optional manual review stage. It never blocks Scene Review; when enabled, Final Video requires an approved Sound Design timeline.',
  },
}

// Order in this array is the chain order for each episode's batch run.
// script-only → introduction-only → thumbnail prompts → thumbnails → audio →
// audio_merge → subtitles → YouTube finalizer → scene production → final video.
// Metadata is deliberately late: chapter timestamps need measured assembly
// timing, and subtitle coverage is the final verification layer.
//
// This is the canonical FULL list of batchable steps (keyed by StepId).
// All the preset/status/done helpers below key off it. What the user
// actually SEES is `chainEntries` — a per-format ordered slice of this
// list interleaved with EXTERNAL_NODES (see below).
const stepsMeta: StepMeta[] = [
  { id: 'research',          label: 'Research (optional)', icon: '🔍', link: '/research',      presetList: 'research_presets',        presetActive: 'research_last_preset_research', optional: true },
  { id: 'script-only',       label: 'Script (chapters)', icon: '📝', link: '/scripts',        presetList: 'script_presets',          presetActive: 'script_last_preset_script' },
  // v1.4.73 — no preset pool: the opening's recipe belongs to the channel, and
  // the link points at the page that owns it rather than back at the Script page.
  { id: 'introduction-only', label: 'Introduction', icon: '👋', link: '/introduction', optional: true },
  { id: 'image_prompts',     label: 'Thumbnail Prompts', icon: '🖼', link: '/image-prompts?tab=thumbnails', presetList: 'thumbnail_prompts_presets', presetActive: 'thumbnail_prompts_last_preset' },
  // Pipeline image generation is fully split: Thumbnail Images and Scene
  // Images are separate steps with separate preset pools.
  { id: 'thumb_images',      label: 'Thumbnails',        icon: '📸', link: '/images',         presetList: 'thumbnail_generator_presets', presetActive: 'thumbnail_generator_last_preset' },
  { id: 'audio',             label: 'Audio (TTS)',       icon: '🎙', link: '/audio',          presetList: 'audio_generator_presets', presetActive: 'audio_generator_last_preset' },
  { id: 'audio_merge',       label: 'Audio Assembly',    icon: '🎛', link: '/audio-merge',    presetList: 'audio_merge_presets',     presetActive: 'audio_merge_last_preset' },
  // v1.0.363 — audio-paced format steps. Preset keys mirror each page's
  // usePresets({ configKey, presetType }) call (typed active pointer).
  { id: 'subtitles',         label: 'Subtitles',         icon: '💬', link: '/subtitles',      presetList: 'subtitles_generator_presets', presetActive: 'subtitles_generator_last_preset' },
  { id: 'metadata',          label: 'YouTube Finalizer', icon: '📄', link: '/metadata',       presetList: 'metadata_presets',        presetActive: 'metadata_last_preset' },
  { id: 'character_sheet',   label: 'Character Sheet',   icon: '🎭', link: '/character-sheet', presetList: 'continuity_page_presets', presetActive: 'continuity_page_last_preset_continuity-page' },
  { id: 'scene_plan',        label: 'Scene Plan',        icon: '📚', link: '/scene-plan',     presetList: 'scene_plan_presets',      presetActive: 'scene_plan_last_preset_scene-plan' },
  { id: 'contextual_cues',   label: 'Contextual Cues',   icon: '🏷️', link: '/contextual-cues', presetList: 'contextual_cues_presets', presetActive: 'contextual_cues_last_preset_contextual-cues', optional: true, warning: 'Optional project feature — a review preset pauses Pipeline here; an auto-approve preset continues after validated proposals.' },
  { id: 'scene_review',      label: 'Scene Review (render)', icon: '✅', link: '/scene-review', presetList: 'scene_review_genstudio_presets', presetActive: 'scene_review_genstudio_last_preset_scene-review' },
  { id: 'motion_review',     label: 'Motion Clips (optional image to video)', icon: '🎬', link: '/motion-review', presetList: 'motion_review_presets', presetActive: 'motion_review_last_preset_motion-review', costly: true, optional: true, warning: 'Optional — skip to assemble with still images. Generates one image-to-video clip per ready scene when selected; provider charges apply' },
  { id: 'video_assembly',    label: 'Final Video',       icon: '🎞', link: '/video-assembly', presetList: 'video_bundle_presets',    presetActive: 'video_bundle_last_preset' },
  { id: 'music_build',       label: 'Build Episode (draw + stitch)', icon: '🧩', link: '/episode-builder' },
]

// A music channel's steps read differently: its scenes are made from Episode Builder, and Final
// Video renders with the episode's own music settings (a Video Assembly preset only adds your look).
const MUSIC_STEP_META: Partial<Record<StepId, Partial<StepMeta>>> = {
  scene_review: { label: 'Scene Pictures', link: '/episode-builder' },
  video_assembly: { label: 'Final Video (music settings)' },
  thumb_images: { label: 'Thumbnail' },
}
const stepById = (id: StepId): StepMeta => stepsMeta.find(s => s.id === id)!

// v1.0.363 — steps that run on the generator's built-in defaults (no saved
// preset). Their tiles show a "no preset needed" note instead of the preset
// dropdown, and they're exempt from the "no active preset" blocking check.
// Mirrors NO_PRESET_STEPS in electron/server/routes/pipeline.ts.
// v1.4.73 — the Introduction joins them: its recipe is a channel setting, so
// there is no preset to pick and never should be one.
const NO_PRESET_STEPS = new Set<StepId>(['introduction-only', 'music_build'])
function noPresetStep(id: StepId): boolean { return NO_PRESET_STEPS.has(id) }
function noPresetNote(id: StepId): string {
  if (id === 'music_build') {
    return 'Uses each episode\'s Episode Builder settings: draws songs from the pools when it has none yet (never makes or buys songs), then stitches the mix and tracklist.'
  }
  return id === 'introduction-only'
    ? 'Written from this channel\'s own Introduction settings.'
    : 'Runs with built-in export defaults.'
}

// ── Per-format chains ───────────────────────────────────────────────────
// Each entry is either a batchable StepId (rendered as a checkbox tile) or
// an EXTERNAL_NODES key (rendered as a read-only "Open page →" node). The
// order is the real production chain for that format. Thumbnail Prompts and
// Thumbnail generation remains independent. Story visuals are always created
// later by Scene Plan → Scene Review.
//
type ChainSpec = Array<StepId | { external: keyof typeof EXTERNAL_NODES }>

// Scene Plan, Scene Review, and the unified final renderer are real chain
// steps. Motion remains optional and approved Scene Plan timing is applied by
// Video Assembly automatically.
const CHAIN_TIMESTAMP: ChainSpec = [
  'research',
  'script-only', 'introduction-only',
  'image_prompts', 'thumb_images',
  'audio', 'audio_merge', 'subtitles',
  'metadata',
  'scene_plan', 'contextual_cues', { external: 'sound_design' }, 'scene_review', 'motion_review', 'video_assembly',
]
// Continuity-chain — like timestamp, plus the Character Sheet step before
// planning. Character Sheet is config-only: the batch writes continuity.json
// from your saved whole-page preset, so the planner + renderer see the anchor.
const CHAIN_CONTINUITY: ChainSpec = [
  'research',
  'script-only', 'introduction-only',
  'image_prompts', 'thumb_images',
  'audio', 'audio_merge', 'subtitles',
  'metadata',
  'character_sheet',
  'scene_plan', 'contextual_cues', { external: 'sound_design' }, 'scene_review', 'motion_review', 'video_assembly',
]
// Narrated-scenes (v1.0.300) — the timestamp chain for STORY/fiction. Same
// audio-paced scene planning as continuity; Character Sheet stays available
// (optional) for stories that benefit from a locked anchor. The render differs
// (scenes are NOT hard-locked to the sheet via img2img), but the chain order
// is identical.
const CHAIN_NARRATED_SCENES: ChainSpec = [
  'research',
  'script-only', 'introduction-only',
  'image_prompts', 'thumb_images',
  'audio', 'audio_merge', 'subtitles',
  'metadata',
  'character_sheet',
  'scene_plan', 'contextual_cues', { external: 'sound_design' }, 'scene_review', 'motion_review', 'video_assembly',
]

// Music (SPEC phase 4): Build Episode → Scene Pictures → Final Video → Thumbnail → YouTube Finalizer.
// A failed thumbnail never holds back the Finalizer: each step waits only for what it needs.
const CHAIN_MUSIC: ChainSpec = ['music_build', 'scene_review', 'video_assembly', 'thumb_images', 'metadata']
const isMusic = computed(() => visualSource.value === 'music')
/** A music episode renders with its own settings, so Final Video's preset is optional there. */
function musicPresetOptional(id: StepId): boolean { return isMusic.value && id === 'video_assembly' }

const activeChainSpec = computed<ChainSpec>(() => {
  if (isMusic.value) return CHAIN_MUSIC
  if (isTimestampDriven.value) return CHAIN_TIMESTAMP
  if (isContinuityChain.value) return CHAIN_CONTINUITY
  if (isNarratedScenes.value) return CHAIN_NARRATED_SCENES
  return []
})

// The full ordered display list (steps + external nodes) for the template.
const chainEntries = computed<ChainEntry[]>(() =>
  activeChainSpec.value.map((e): ChainEntry => {
    if (typeof e !== 'string') return EXTERNAL_NODES[e.external]!
    const meta = stepById(e)
    return { kind: 'step', ...meta, ...(isMusic.value ? MUSIC_STEP_META[e] || {} : {}) }
  }),
)

// Just the batchable steps for the active format, in chain order. This
// REPLACES the old `stepsMeta` everywhere the UI iterates "the steps the
// user can run" (tiles, pills, pending logic, counts).
const visibleSteps = computed<StepMeta[]>(() =>
  chainEntries.value.filter((e): e is { kind: 'step' } & StepMeta => e.kind === 'step'),
)

const chainLabel = computed(() => {
  if (isMusic.value) return 'Music episodes (Episode Builder → video → thumbnail → Finalizer)'
  if (isTimestampDriven.value) return 'Scenes — sentence-timed (transcript-driven)'
  if (isContinuityChain.value) return 'Continuity (character-locked, live-paced)'
  if (isNarratedScenes.value) return 'Scenes — sentence-timed (audio-paced)'
  return 'production flow unavailable'
})
const hasExternalNodes = computed(() => chainEntries.value.some(e => e.kind === 'external'))
const stepChecked = reactive<Record<StepId, boolean>>({
  // Pipeline always opens with an empty stage selection. Starting work is an
  // explicit decision; shortcuts below provide safe required-only or full-chain
  // selection without reviving the old surprise "everything on" behavior.
  research: false,
  'script-only': false,
  'introduction-only': false,
  image_prompts: false,
  thumb_images: false,
  audio: false,
  audio_merge: false,
  metadata: false,
  subtitles: false,
  character_sheet: false,
  scene_plan: false,
  contextual_cues: false,
  scene_review: false,
  motion_review: false,
  video_assembly: false,
  music_build: false,
})

// The retired LLM lineup's one-time notice (2026-10-03): what Story Studio kept,
// shown until the owner closes it. Model names come from this browser's catalogue memory.
const modelNames = useGenStudioModelDisplay()
modelNames.hydrate()
const chatModels = useGenStudioChatModels()
const lineupNoticeClosed = ref(false)
watch(slug, () => { lineupNoticeClosed.value = false })
const lineupNotice = computed(() => {
  const record = (config.value as any)?.llm_lineup_migration
  if (!record?.model || record.notice_dismissed_at || lineupNoticeClosed.value) return null
  return {
    model: chatModels.find(record.model)?.display_name || modelNames.knownName(record.model) || record.model,
    steps: Array.isArray(record.steps) ? record.steps as string[] : [],
  }
})
watch(() => (config.value as any)?.llm_lineup_migration?.model, model => { if (model) void chatModels.refresh() }, { immediate: true })
async function dismissLineupNotice(): Promise<void> {
  lineupNoticeClosed.value = true
  try {
    await post(`/projects/${slug.value}/settings/llm-lineup-notice/dismiss`, {})
  } catch { /* closed for this visit; it comes back next time if the save failed */ }
}

type EligibleModelPolicyStep = Extract<StepId,
  'script-only' | 'introduction-only' | 'research' | 'metadata' | 'image_prompts' | 'scene_plan' | 'contextual_cues'>
/** One writing model per step for this run (a Gateway pool counts as one). */
interface ModelPolicyDraft {
  enabled: boolean
  model: string
}
interface ModelPolicyModelMeta {
  id: string
  context_window_tokens?: number
  context_limit_tokens?: number
  max_output_tokens?: number
}

const MODEL_POLICY_STEPS = new Set<EligibleModelPolicyStep>([
  'script-only', 'introduction-only', 'research', 'metadata', 'image_prompts', 'scene_plan', 'contextual_cues',
])
const modelPolicies = reactive<Record<EligibleModelPolicyStep, ModelPolicyDraft>>({
  research: { enabled: false, model: '' },
  'script-only': { enabled: false, model: '' },
  'introduction-only': { enabled: false, model: '' },
  image_prompts: { enabled: false, model: '' },
  metadata: { enabled: false, model: '' },
  scene_plan: { enabled: false, model: '' },
  contextual_cues: { enabled: false, model: '' },
})
const modelPolicyModelMeta = reactive<Record<EligibleModelPolicyStep, ModelPolicyModelMeta | null>>({
  research: null,
  'script-only': null,
  'introduction-only': null,
  image_prompts: null,
  metadata: null,
  scene_plan: null,
  contextual_cues: null,
})
const modelPolicyExpanded = reactive<Record<StepId, boolean>>({
  research: false, 'script-only': false, 'introduction-only': false,
  image_prompts: false, thumb_images: false, audio: false, audio_merge: false,
  metadata: false, subtitles: false, character_sheet: false, scene_plan: false,
  contextual_cues: false, scene_review: false, motion_review: false, video_assembly: false,
  music_build: false,
})

function modelPolicyFor(stepId: StepId): ModelPolicyDraft | null {
  return MODEL_POLICY_STEPS.has(stepId as EligibleModelPolicyStep)
    ? modelPolicies[stepId as EligibleModelPolicyStep]
    : null
}
function resetModelPolicies(): void {
  for (const stepId of MODEL_POLICY_STEPS) {
    modelPolicies[stepId].enabled = false
    modelPolicies[stepId].model = ''
    modelPolicyModelMeta[stepId] = null
    modelPolicyExpanded[stepId] = false
  }
}
function setModelPolicyEnabled(stepId: StepId, enabled: boolean): void {
  const policy = modelPolicyFor(stepId)
  if (policy) policy.enabled = enabled
}
function setModelPolicyExpanded(stepId: StepId, expanded: boolean): void {
  modelPolicyExpanded[stepId] = expanded
}
function setModelPolicyModel(stepId: StepId, modelId: string): void {
  const policy = modelPolicyFor(stepId)
  if (!policy) return
  policy.model = modelId
  modelPolicyModelMeta[stepId as EligibleModelPolicyStep] = null
}
function setModelPolicyModelMeta(stepId: StepId, model: ModelPolicyModelMeta | null): void {
  const policy = modelPolicyFor(stepId)
  if (policy && model?.id === policy.model) {
    modelPolicyModelMeta[stepId as EligibleModelPolicyStep] = model
  }
}
function modelPolicyLimits(stepId: StepId): string {
  const model = modelPolicyModelMeta[stepId as EligibleModelPolicyStep]
  if (!model || model.id !== modelPolicyFor(stepId)?.model) return ''
  const context = model.context_window_tokens ?? model.context_limit_tokens
  const output = model.max_output_tokens
  const facts: string[] = []
  if (typeof context === 'number' && context > 0) facts.push(`Context window: ${context.toLocaleString()} tokens.`)
  if (typeof output === 'number' && output > 0) facts.push(`Max output: ${output.toLocaleString()} tokens.`)
  if (typeof context === 'number' && context > 0 && typeof output === 'number' && output > 0) {
    facts.push(`Input capacity estimate at this output: ${Math.max(0, context - output).toLocaleString()} tokens. The Gateway validates the exact prompt fit.`)
  }
  return facts.join(' ')
}
function modelPolicyError(stepId: StepId): string {
  const policy = modelPolicyFor(stepId)
  return policy?.enabled && !policy.model ? 'Choose a writing model, or untick this to use the preset\'s model.' : ''
}
function modelPolicySummary(stepId: StepId): string {
  const policy = modelPolicyFor(stepId)
  if (!policy?.enabled) return 'Preset\'s model'
  return policy.model ? 'Different model for this run' : 'Choose a model'
}
type RunModelPolicy = { mode: 'single'; models: string[] }
function modelPoliciesForRun(): Partial<Record<EligibleModelPolicyStep, RunModelPolicy>> {
  const result: Partial<Record<EligibleModelPolicyStep, RunModelPolicy>> = {}
  for (const step of checkedStepsOrdered.value) {
    const policy = modelPolicyFor(step.id)
    if (policy?.enabled && policy.model) {
      result[step.id as EligibleModelPolicyStep] = { mode: 'single', models: [policy.model] }
    }
  }
  return result
}
const modelPolicyRunSummary = computed(() => Object.keys(modelPoliciesForRun()).map(stepId =>
  `${stepById(stepId as StepId).label} uses the writing model chosen above for this run.`))

// These choices apply only to the current batch. A project change must never
// carry one channel's explicit products into another channel's request.
watch(slug, resetModelPolicies)

// Tri-state (E-03): true = the channel opens with an Introduction, false = it
// does not, null = the read failed. Encoding "could not check" as `false` used
// to drop the Introduction step from a batch without a word and told the user
// their channel had no opening — a confident answer to a question never
// answered (AGENTS.md §6).
const channelIntroEnabled = ref<boolean | null>(null)
const channelIntroUnknown = computed(() => channelIntroEnabled.value === null)
async function loadChannelIntroduction(): Promise<void> {
  try {
    const data = await get<{ segments?: Record<string, { enabled: boolean }> }>(
      `/projects/${slug.value}/segments`)
    channelIntroEnabled.value = data.segments?.introduction?.enabled === true
  } catch {
    channelIntroEnabled.value = null
  }
}
watch(slug, () => { void loadChannelIntroduction() }, { immediate: true })

function clearSelectedSteps(): void {
  for (const step of stepsMeta) stepChecked[step.id] = false
}

/**
 * The Introduction is not a selection — it is what the channel already said.
 * Every bulk helper ends here so no shortcut can leave it disagreeing with
 * the channel setting the run will actually follow.
 */
function syncDerivedSteps(): void {
  stepChecked['introduction-only'] = !!stepChecked['script-only'] && channelIntroEnabled.value === true
}

function selectRequiredSteps(): void {
  clearSelectedSteps()
  for (const step of visibleSteps.value) {
    if (!step.optional) stepChecked[step.id] = true
  }
  syncDerivedSteps()
}

function selectAllSteps(): void {
  clearSelectedSteps()
  for (const step of visibleSteps.value) stepChecked[step.id] = true
  syncDerivedSteps()
}

/**
 * v1.4.73 — the opening is no longer a box that can be forgotten.
 *
 * A channel that says it opens with an Introduction gets one on every episode
 * a batch writes; the server adds the step whether or not this page asked for
 * it (see `applyChannelSegmentIntent` in routes/pipeline.ts). This page shows
 * that rather than pretending there is still a choice here — leaving a live
 * checkbox that the run ignores would be worse than having no checkbox at all.
 *
 * Four episodes reached paid audio with no opening because this box happened
 * not to be ticked on the run that wrote them. Where it is decided is the
 * Introduction page, and it is decided once.
 */
// Intro depends on script context: it introduces chapters, so it cannot run
// without them. It therefore follows the Script step exactly — on when the
// channel wants an opening and chapters are being written, off otherwise.
watch([() => stepChecked['script-only'], channelIntroEnabled], syncDerivedSteps, { immediate: true })
function stepDisabled(stepId: StepId): boolean {
  if (stepId === 'introduction-only') return true
  return false
}
function stepDisabledReason(stepId: StepId): string {
  if (stepId !== 'introduction-only') return ''
  if (channelIntroEnabled.value === null) {
    return 'Story Studio could not check whether this channel opens with an Introduction, so the step stays off rather than being guessed. Open Introduction to confirm, then Retry.'
  }
  if (!channelIntroEnabled.value) {
    return 'This channel does not open with an Introduction. Turn it on under Introduction in the sidebar.'
  }
  if (!stepChecked['script-only']) {
    return 'Runs automatically with the Script step, because the opening introduces the chapters.'
  }
  return 'Runs automatically — this channel opens with an Introduction.'
}

// Only batchable steps that (a) belong to the active format's chain AND
// (b) are checked. visibleSteps is already in chain order, so the batch
// runs in the right sequence. A step checked under one format then hidden
// by a format switch simply drops out — no stale steps get enqueued.
const checkedStepsOrdered = computed(() => visibleSteps.value.filter(s => stepChecked[s.id]))
const checkedStepCount = computed(() => checkedStepsOrdered.value.length)

// Legacy-fallback map. Scripts page uses typed presets (introduced when
// scripts.vue split into scriptPresets + introPresets), but older projects
// still carry the untyped `script_last_preset` key from pre-typing saves.
// Mirrors the fallback chain in electron/server/routes/pipeline.ts.
// v1.4.73 — `introduction-only` is gone from both this map and TYPE_FOR_STEP
// below. It is in NO_PRESET_STEPS, so its preset dropdown is never rendered
// and neither lookup can run; leaving them there described a preset pool the
// Introduction deliberately does not have.
const LEGACY_ACTIVE_KEY: Partial<Record<StepId, string>> = {
  'script-only': 'script_last_preset',
  // v1.0.363 — typed-preset steps: untyped pointer as the legacy fallback.
  scene_plan: 'scene_plan_last_preset',
  motion_review: 'motion_review_last_preset',
  character_sheet: 'continuity_page_last_preset',
}

// Type tag for the type-based last-resort fallback. When neither the typed
// nor legacy active pointer resolves to an existing preset, pick the most
// recently saved preset carrying this `type`. Unblocks the common state
// where the user saved typed presets but the active pointer is stale /
// missing (happens when the active-pointer key is dropped on older saves
// or when the user removed the active preset without re-selecting one).
const TYPE_FOR_STEP: Partial<Record<StepId, string>> = {
  research: 'research',
  'script-only': 'script',
  // v1.0.363 — match each page's usePresets({ presetType }).
  scene_plan: 'scene-plan',
  contextual_cues: 'contextual-cues',
  scene_review: 'scene-review',
  motion_review: 'motion-review',
  character_sheet: 'continuity-page',
}

// A step's preset pool. Split prompt steps each use only their own pool, so
// Pipeline never collapses scene prompts and thumbnail prompts into one.
function listForStep(meta: StepMeta): any[] {
  const cfg = config.value as any
  return Array.isArray(cfg?.[meta.presetList]) ? cfg[meta.presetList] : []
}

function presetNameFor(stepId: StepMeta['id']): string {
  const id = activePresetIdFor(stepId)
  if (!id) return ''
  const meta = stepsMeta.find(s => s.id === stepId)!
  return listForStep(meta).find(x => x.id === id)?.name || ''
}

/** Resolve the preset id the backend will use for this step. Mirrors the
 *  fallback chain in /electron/server/routes/pipeline.ts so the inline picker
 *  shows whichever preset will actually run, not just whichever pointer is set.
 *  Returns '' when nothing resolves. */
function activePresetIdFor(stepId: StepMeta['id']): string {
  const meta = stepsMeta.find(s => s.id === stepId)!
  const cfg = config.value as any
  const list = listForStep(meta)

  // 1. Active pointer — the step's `*_last_preset` key.
  const activeId: string = cfg?.[meta.presetActive] || ''
  if (activeId && list.some(x => x.id === activeId)) return activeId

  // 2. Legacy untyped active pointer (script-only falls back to
  //    `script_last_preset` for pre-typing saves).
  const legacyKey = LEGACY_ACTIVE_KEY[stepId]
  if (legacyKey) {
    const legacy: string = cfg?.[legacyKey] || ''
    if (legacy && list.some(x => x.id === legacy)) return legacy
  }

  // 3. Type-based auto-resolve (last-resort). Save-order in usePresets is
  //    chronological, so the LAST matching entry is the newest.
  const wantedType = TYPE_FOR_STEP[stepId]
  if (wantedType) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.type === wantedType) return list[i].id
    }
  }

  return ''
}

/** Filter the step's preset pool to options that make sense for this step.
 *  Steps with a typed pool (script-only) hide presets belonging to the OTHER
 *  type. Untyped legacy presets are kept since they predate the typing
 *  convention and the legacy fallback above resolves them. */
function presetsForStep(stepId: StepMeta['id']): Array<{ id: string; name: string; type?: string }> {
  const meta = stepsMeta.find(s => s.id === stepId)!
  const list = listForStep(meta)
  const wantedType = TYPE_FOR_STEP[stepId]
  if (!wantedType) return list
  return list.filter(p => !p?.type || p.type === wantedType)
}

/** Tooltip shown on the inline select. Calls out the silent-shift gotcha
 *  when the user is currently relying on the type-based fallback so they
 *  know to pin an explicit choice. */
function presetSelectTooltip(stepId: StepMeta['id']): string {
  const meta = stepsMeta.find(s => s.id === stepId)!
  const cfg = config.value as any
  const pinned = typeof cfg?.[meta.presetActive] === 'string' && !!cfg[meta.presetActive]
  const legacy: string = LEGACY_ACTIVE_KEY[stepId] ? cfg?.[LEGACY_ACTIVE_KEY[stepId]!] || '' : ''
  if (pinned || legacy) return 'Pick which saved preset this step runs with. Selection is sticky across sessions.'
  if (activePresetIdFor(stepId)) {
    return 'No preset is pinned — Pipeline is auto-using the most recently saved preset of this type. Pick one explicitly to lock it.'
  }
  return 'No preset selected. Pick one to enable this step in the Pipeline run.'
}

// Per-step saving flag so the dropdown can show a brief disabled state
// while the PUT round-trips. Avoids a double-fire if the user mashes the
// dropdown twice fast.
const presetSaving = reactive<Record<StepId, boolean>>({
  research: false,
  'script-only': false, 'introduction-only': false, metadata: false,
  image_prompts: false,
  thumb_images: false,
  audio: false, audio_merge: false, video_assembly: false,
  // v1.0.363 — audio-paced format steps.
  subtitles: false, character_sheet: false, scene_plan: false, contextual_cues: false,
  scene_review: false, motion_review: false, music_build: false,
})

async function onPresetChange(stepId: StepMeta['id'], presetId: string) {
  const meta = stepsMeta.find(s => s.id === stepId)!
  presetSaving[stepId] = true
  try {
    const { put } = useApi()
    // Same partial-update pattern usePresets.persist() uses. Only the
    // typed active-pointer key is touched — the preset list itself is
    // owned by the per-stage page's usePresets() instance.
    await put(`/projects/${slug.value}/settings/config`, {
      [meta.presetActive]: presetId,
    })
    await refreshConfig(slug.value)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || `Failed to set ${meta.label} preset`)
  } finally {
    presetSaving[stepId] = false
  }
}

// ── Episode multi-select ───────────────────────────────────────────────
interface Episode {
  episode_code: string
  title: string
  status: Record<string, unknown>
  visual_source?: unknown
  local_media_status?: LocalMediaCleanupStatus | null
  // Optional provenance + override fields (Pipeline page reads them for
  // the manual-done pill + per-step "(manual)" annotation; back-end may
  // still omit them on stale rows so all are optional).
  batch_id?: string
  marked_done?: boolean
  marked_done_at?: string | null
  status_overrides?: Record<string, boolean> | null
  // Optional metadata used by the asset import dialog (chapter count
  // primes the audio dropdown). Backend includes when available; UI
  // falls back to a generic 1-20 list when missing.
  suggested_chapters?: number
}
const selectedEpisodes = reactive(new Set<string>())

// A route update reuses this page instance. Both a previous channel's episode
// ids and its selected stage list are unsafe to carry into the next channel.
watch(slug, () => {
  clearSelectedSteps()
  selectedEpisodes.clear()
  restoreEpisodeSelection()
})

// The episode selection (not the stage list, which resets on purpose) survives a trip to
// Jobs and back: sessionStorage, per channel. Codes that no longer exist are dropped once
// the episode list is known.
const episodeSelectionKey = () => `pipeline-episodes:${slug.value}`
function restoreEpisodeSelection() {
  try { for (const code of JSON.parse(sessionStorage.getItem(episodeSelectionKey()) || '[]')) selectedEpisodes.add(String(code)) }
  catch { /* no sessionStorage or a corrupt entry: start empty */ }
}
restoreEpisodeSelection()
watch(() => [...selectedEpisodes].sort().join(','), () => {
  try { sessionStorage.setItem(episodeSelectionKey(), JSON.stringify([...selectedEpisodes])) } catch { /* selection just won't persist */ }
})

// Shared SWR cache so navigating away and back to /pipeline is instant.
// Auto-revalidates when any job for this slug completes — selection state
// stays intact because we only touch selectedEpisodes here, not episodes.
const {
  episodes,
  isLoading: epLoading,
  isRevalidating: epRevalidating,
  refresh: refreshEpisodes,
  revalidate: revalidateEpisodes,
  revalidateAfterMutation,
  updateEpisode,
  error: epError,
} = useEpisodes(slug)
watch(episodes, (list) => {
  if (!list.length) return
  const known = new Set(list.map(ep => ep.episode_code))
  for (const code of [...selectedEpisodes]) if (!known.has(code)) selectedEpisodes.delete(code)
})

// Surface the underlying load error in a toast (composable stores it but
// doesn't toast — page decides whether to show).
watch(epError, (e) => {
  if (e) showError((e as any)?.data?.detail || (e as any)?.message || 'Failed to load episodes')
})


// Plain click re-reads what changed; Shift-click keeps the full rebuild of
// every row (`?refresh=1`), as on the Production Board.
async function onRefreshClick(e: MouseEvent) {
  await (e.shiftKey ? refreshEpisodes() : revalidateEpisodes())
}

function toggleEpisode(code: string) {
  if (selectedEpisodes.has(code)) selectedEpisodes.delete(code)
  else selectedEpisodes.add(code)
}

function episodeVisualSource(ep: Episode): EpisodeVisualSource | null {
  const source = ep.visual_source ?? ep.status?.visual_source
  return source === 'scene_plan' || source === 'image_pool' ? source : null
}

function onEpisodeVisualSourceChanged(episodeCode: string, source: EpisodeVisualSource): void {
  updateEpisode(episodeCode, episode => ({
    ...episode,
    visual_source: source,
  }))
}
// "Select all" and "Select all pending" operate on the CURRENT FILTER,
// not the full episode list — otherwise a user who's filtered to "missing
// only" and clicks Select all would silently pull in every done episode
// too, which is the opposite of what the filter signaled they wanted.
function selectAll() {
  for (const ep of sortedFilteredEpisodes.value) selectedEpisodes.add(ep.episode_code)
}
function selectNone() {
  selectedEpisodes.clear()
}

interface PipelineAudioQualityResult {
  episode: string
  checked: number
  review: number
  noIssue: number
  skipped?: string
  error?: string
}

const pipelineQualityChecking = ref(false)
const pipelineQualityCompleted = ref(0)
const pipelineQualityResults = ref<PipelineAudioQualityResult[]>([])
const pipelineQualityMode = computed<AudioQualityMode>(() => {
  const mode = (config.value as any)?.audio_quality?.mode
  return mode === 'flag_issues' || mode === 'check_and_repair' ? mode : 'off'
})
const pipelineQualityModeLabel = computed(() => pipelineQualityMode.value === 'flag_issues'
  ? 'Flag issues'
  : pipelineQualityMode.value === 'check_and_repair'
    ? 'Check and repair'
    : 'Off')
const pipelineQualityDescription = computed(() => pipelineQualityMode.value === 'check_and_repair'
  ? 'Find chapters that need review, then open Audio to choose the current narration model and voice before any quoted repair.'
  : pipelineQualityMode.value === 'flag_issues'
    ? 'Flag chapters whose saved source and transcript evidence needs review.'
    : 'Audio quality review is disabled for this project.')
const selectedEpisodeCodes = computed(() => [...selectedEpisodes].sort())
const selectedEpisodeScopeKey = computed(() => selectedEpisodeCodes.value.join(','))
const pipelineQualityHasRetry = computed(() => selectedEpisodeCodes.value.some(code =>
  pipelineQualityAction.pending.value.has(`pipeline-quality:${code}`)))
const pipelineQualityActionDisabled = computed(() =>
  pipelineQualityChecking.value || pipelineQualityMode.value === 'off' || selectedEpisodes.size === 0)
const pipelineQualityActionLabel = computed(() => {
  if (pipelineQualityChecking.value) {
    return `Checking ${pipelineQualityCompleted.value} of ${selectedEpisodes.size}…`
  }
  if (pipelineQualityMode.value === 'off') return 'Audio quality is off'
  if (!selectedEpisodes.size) return 'Select episodes to check'
  return pipelineQualityHasRetry.value ? 'Retry unfinished checks' : 'Check selected episodes'
})

watch(selectedEpisodeScopeKey, () => {
  pipelineQualityResults.value = []
})

function pipelineQualityResultText(result: PipelineAudioQualityResult): string {
  if (result.error) return result.error
  if (result.skipped) return result.skipped
  if (result.review) {
    return `${result.review} of ${result.checked} checked chapter${result.checked === 1 ? '' : 's'} need review.`
  }
  return `${result.noIssue} checked chapter${result.noIssue === 1 ? '' : 's'} — no issue detected.`
}

async function checkSelectedAudioQuality(): Promise<void> {
  if (pipelineQualityActionDisabled.value) return
  const targetSlug = slug.value
  const episodeCodes = selectedEpisodeCodes.value
  pipelineQualityChecking.value = true
  pipelineQualityCompleted.value = 0
  pipelineQualityResults.value = []
  const results: PipelineAudioQualityResult[] = []
  try {
    // Keep this deliberately sequential. It is a local evidence pass, not a
    // generation batch, and each episode's retained operation remains clear.
    for (const episode of episodeCodes) {
      try {
        const status = await get<{ sections?: Array<{ slug?: string; status?: string }> }>(
          `/projects/${targetSlug}/episodes/${episode}/audio-sections`,
        )
        const sections = (status.sections || [])
          .filter(section => section.status === 'generated' && typeof section.slug === 'string' && !!section.slug)
          .map(section => section.slug!)
        if (!sections.length) {
          results.push({ episode, checked: 0, review: 0, noIssue: 0, skipped: 'No completed chapter audio is available to check.' })
          continue
        }
        const actionTarget = `pipeline-quality:${episode}`
        const scope = { project: targetSlug, episode, sections: [...sections].sort(), analysis_only: true }
        const operationId = pipelineQualityAction.begin(scope, actionTarget)
        const plan = await post<AudioQualityPlan>(
          `/projects/${targetSlug}/episodes/${episode}/audio-quality/check`,
          { operation_id: operationId, sections, analysis_only: true },
        )
        pipelineQualityAction.complete(operationId)
        const review = plan.sections.filter(section =>
          section.quality.state === 'review_needed' || section.quality.state === 'still_needs_review').length
        const noIssue = plan.sections.filter(section =>
          section.quality.state === 'no_issue_detected' || section.quality.state === 'fixed').length
        results.push({ episode, checked: plan.sections.length, review, noIssue })
      } catch (e: any) {
        results.push({
          episode,
          checked: 0,
          review: 0,
          noIssue: 0,
          error: e?.data?.detail || e?.message || 'The saved audio evidence could not be checked.',
        })
      } finally {
        pipelineQualityCompleted.value++
        if (slug.value === targetSlug) pipelineQualityResults.value = [...results]
      }
    }
    if (slug.value !== targetSlug) return
    const reviewCount = results.reduce((total, result) => total + result.review, 0)
    const checkedCount = results.reduce((total, result) => total + result.checked, 0)
    if (results.some(result => result.error)) showError('Some episodes could not be checked. Retry keeps the same unfinished action.')
    else if (reviewCount) showInfo(`${reviewCount} chapter${reviewCount === 1 ? '' : 's'} need review. Open Audio from the results below.`)
    else if (!checkedCount) showInfo('No completed chapter audio was available to check.')
    else success('Audio quality check finished. No issue was detected in the available saved evidence.')
  } finally {
    pipelineQualityChecking.value = false
  }
}

// Page-scoped variants. Identical logic to selectAll / selectAllPending
// but operate on `paginatedEpisodes` (just the visible 10/20/50/100) so
// the user can mark-done one page at a time without dragging in episodes
// they haven't reviewed yet on later pages.
function selectAllOnPage() {
  for (const ep of paginatedEpisodes.value) selectedEpisodes.add(ep.episode_code)
}

// ── Sort + filter + pagination ───────────────────────────────────────────
// All client-side — `episodes.value` is the full list from /episodes,
// these refs derive what's rendered. Designed for projects with 100+
// accepted ideas where the full list would otherwise be unscrollable.
type SortKey = 'code-asc' | 'code-desc' | 'title' | 'missing-desc' | 'missing-asc'
type FilterMode =
  | 'all'
  | 'missing-only'
  | `missing-step:${StepId}`

function filterModeForStep(stepId: StepId): FilterMode {
  return `missing-step:${stepId}`
}

function stepFilterLabel(step: StepMeta): string {
  return step.label
    .replace(/\s*\(optional[^)]*\)/i, '')
    .replace(/\s*\(render\)/i, '')
}

// The filter menu is generated from the same active stage collection as the
// tiles and episode status pills. Adding a future Pipeline stage therefore
// adds its missing-work filter automatically, without another hand-maintained
// dropdown map.
const requiredFilterSteps = computed(() => visibleSteps.value.filter(step => !step.optional))
const optionalFilterSteps = computed(() => visibleSteps.value.filter(step => step.optional))
const filteredStepId = computed<StepId | null>(() => {
  if (!filterMode.value.startsWith('missing-step:')) return null
  const candidate = filterMode.value.slice('missing-step:'.length) as StepId
  return visibleSteps.value.some(step => step.id === candidate) ? candidate : null
})

watch(visibleSteps, () => {
  if (filterMode.value.startsWith('missing-step:') && !filteredStepId.value) {
    filterMode.value = 'all'
  }
})

const sortKey = ref<SortKey>('code-asc')
const filterMode = ref<FilterMode>('all')
const pageSize = ref(10)
const currentPage = ref(1)
// Free-text search across episode_code + title. Mirrors the Ideas page's
// search box. Pure derivation; no network call. Empty string = no filter.
const searchQuery = ref('')

// Count missing CORE steps per episode. Video (AI per-scene generation)
// is opt-in and costly, so it's excluded. video_assembly IS included —
// finishing an episode end-to-end requires the assembled final video,
// and including it here lets "Run all pending" batch the full flow in
// one click (assembly waits for its inputs via the chain mechanism).
// Split image steps drive the missing-core counter. A fresh classic scene
// episode needs both thumbnails and scenes to be considered complete enough
// to assemble; tracking them separately lets a partially-rendered episode
// show up in the right missing-only filter.
// v1.0.167 — CORE steps are now derived from the active format's chain
// rather than hardcoded to the scene-images set. "Core" = every batchable
// step in the chain EXCEPT the opt-in AI `video` clips step. Steps not in the active chain aren't in
// visibleSteps, so they never count toward "missing core".
const CORE_STEP_IDS = computed<StepId[]>(() =>
  visibleSteps.value.filter(s => !s.optional).map(s => s.id),
)

function isStepApplicableForEpisode(stepId: StepId, ep: Episode): boolean {
  const source = episodeVisualSource(ep)
  if (!source) return false
  // Pipeline's persisted batch ids use underscores while the shared flow
  // names the same stages with hyphens. The helper reads only `key`, keeping
  // the two source branches aligned without a second step list here.
  return isFlowStepApplicable({ key: stepId.replaceAll('_', '-') } as FlowStep, source)
}

function selectedApplicableStages(episodeCodes: ReadonlySet<string>): number {
  return episodes.value.reduce((total, ep) => {
    if (!episodeCodes.has(ep.episode_code)) return total
    return total + checkedStepsOrdered.value.filter(step => isStepApplicableForEpisode(step.id, ep)).length
  }, 0)
}

const selectedApplicableStepCount = computed(() => selectedApplicableStages(selectedEpisodes))

function missingCoreSteps(ep: Episode): number {
  let n = 0
  for (const id of CORE_STEP_IDS.value) {
    if (isStepApplicableForEpisode(id, ep) && !isStepDoneForEpisode(id, ep.status)) n++
  }
  return n
}

// Natural sort for episode codes so TN0002 comes before TN0010 (not
// string-sorted "TN0010" < "TN0002" < "TN0011"). Falls back to locale
// compare for anything the regex doesn't match.
function compareEpisodeCodes(a: string, b: string): number {
  const re = /^([A-Za-z]+)(\d+)/
  const ma = a.match(re); const mb = b.match(re)
  const mA1 = ma?.[1], mA2 = ma?.[2], mB1 = mb?.[1], mB2 = mb?.[2]
  if (mA1 && mB1 && mA2 && mB2 && mA1 === mB1) {
    return parseInt(mA2, 10) - parseInt(mB2, 10)
  }
  return a.localeCompare(b)
}

const sortedFilteredEpisodes = computed<Episode[]>(() => {
  let filtered: Episode[]
  const targetStep = filteredStepId.value
  if (targetStep) {
    filtered = episodes.value.filter(ep =>
      isStepApplicableForEpisode(targetStep, ep) && !isStepDoneForEpisode(targetStep, ep.status))
  } else if (filterMode.value === 'missing-only') {
    filtered = episodes.value.filter(ep => missingCoreSteps(ep) > 0)
  } else {
    filtered = episodes.value.slice()
  }
  // Free-text narrow on episode_code + title. Case-insensitive substring
  // match. Composes after the dropdown filter so "Missing audio" + "TN0042"
  // does what you'd expect.
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    filtered = filtered.filter(ep =>
      (ep.episode_code || '').toLowerCase().includes(q)
      || (ep.title || '').toLowerCase().includes(q),
    )
  }
  const sorted = filtered.slice()
  switch (sortKey.value) {
    case 'code-asc':
      sorted.sort((a, b) => compareEpisodeCodes(a.episode_code, b.episode_code))
      break
    case 'code-desc':
      sorted.sort((a, b) => compareEpisodeCodes(b.episode_code, a.episode_code))
      break
    case 'title':
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      break
    case 'missing-desc':
      sorted.sort((a, b) => missingCoreSteps(b) - missingCoreSteps(a)
        || compareEpisodeCodes(a.episode_code, b.episode_code))
      break
    case 'missing-asc':
      sorted.sort((a, b) => missingCoreSteps(a) - missingCoreSteps(b)
        || compareEpisodeCodes(a.episode_code, b.episode_code))
      break
  }
  return sorted
})

const totalPages = computed(() => Math.max(1, Math.ceil(sortedFilteredEpisodes.value.length / pageSize.value)))

const paginatedEpisodes = computed<Episode[]>(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return sortedFilteredEpisodes.value.slice(start, start + pageSize.value)
})

const pendingEpisodesCount = computed(() => episodes.value.filter(ep => missingCoreSteps(ep) > 0).length)

// Per-step missing counts — drives the count badges in the filter dropdown
// so users see "(4)" next to e.g. "Missing audio" before selecting it.
const missingCountByStep = computed<Partial<Record<StepId, number>>>(() => {
  const ids = visibleSteps.value.map(step => step.id)
  const counts: Partial<Record<StepId, number>> = {}
  for (const id of ids) counts[id] = 0
  for (const ep of episodes.value) {
    for (const id of ids) {
      if (isStepApplicableForEpisode(id, ep) && !isStepDoneForEpisode(id, ep.status)) {
        counts[id] = (counts[id] ?? 0) + 1
      }
    }
  }
  return counts
})

// Active filter's hit count — surfaced as an inline badge next to the
// dropdown so the user immediately sees how narrowly their filter cuts.
const filteredHitCount = computed(() => sortedFilteredEpisodes.value.length)

const visibleRangeText = computed(() => {
  const total = sortedFilteredEpisodes.value.length
  if (total === 0) return '0 of 0'
  const start = (currentPage.value - 1) * pageSize.value + 1
  const end = Math.min(total, currentPage.value * pageSize.value)
  return `Showing ${start}–${end} of ${total}`
})

function goToPage(n: number) {
  const clamped = Math.max(1, Math.min(totalPages.value, Math.floor(n)))
  currentPage.value = clamped
}

// Reset to page 1 whenever filter, sort, or search changes — otherwise
// the user can land on an empty page after the list shrinks.
watch([filterMode, sortKey, searchQuery], () => { currentPage.value = 1 })

// Clamp if the filtered list shrinks below the current page (e.g. episode
// finished and was filtered out of the missing-only view).
watch(totalPages, (tp) => { if (currentPage.value > tp) currentPage.value = tp })

const selectButtonTitle = computed(() => filterMode.value === 'missing-only'
  ? 'Select every episode currently shown (after the missing-only filter) that has a missing checked step'
  : 'Select every episode that has a missing checked step')

const selectAllTitle = computed(() => filterMode.value === 'missing-only'
  ? `Select all ${sortedFilteredEpisodes.value.length} episode(s) matching the current filter`
  : `Select all ${episodes.value.length} episode(s)`)
// Single truth table for "is this step done on this episode?", used by
// both selectAllPending AND the per-step pill indicator on each episode
// row. Mirrors the backend's isStepAlreadyDone() in routes/pipeline.ts
// so the UI pills, the pending selector, and the batch skip logic all
// agree.
//
// video_assembly has no canonical completion marker — treat as "not done"
// so the pill is a reminder rather than a false "✓ done". The skip
// logic on the backend declines to auto-skip video_assembly for the same
// reason.
function isStepDoneForEpisode(stepId: StepId, status: Record<string, unknown> | undefined): boolean {
  const s = status || {}
  switch (stepId) {
    // Research is done once EVIDENCE EXISTS, exactly as the backend skips on
    // it. Claim triage (`research_reviewed`) is separate editorial state and
    // deliberately does NOT gate this pill — an explicitly selected Research
    // stage auto-triages what it finds, so pending claims are not work the
    // Pipeline still has to do. `pillTitle` carries that second fact in words.
    case 'research':           return !!s.research
    case 'script-only':        return !!s.script
    case 'introduction-only':  return !!s.introduction
    case 'image_prompts':      return !!s.thumb_prompts
    case 'thumb_images':       return !!s.thumbnails
    case 'audio':              return !!s.audio
    case 'audio_merge':        return !!s.merged_audio
    case 'metadata':           return !!s.metadata
    // v1.0.363 — audio-paced format steps.
    case 'subtitles':          return !!s.subtitles
    case 'scene_plan':         return !!s.scene_plan
    // Mirrors the backend: an episode with nothing outstanding but nothing
    // proposed either is NOT done — a selected step still has work to do.
    case 'contextual_cues':    return !!s.contextual_cues_generated && !!s.contextual_cues
    case 'scene_review':       return !!s.scene_review
    case 'motion_review':      return !!s.motion_review
    case 'character_sheet':    return !!s.character_sheet
    case 'video_assembly':     return !!s.video_assembly
    case 'music_build':        return s.music_episode === true
  }
  return false
}

// "Pending" = not fully done across every selected step. Reuses the
// truth table above. video / video_assembly are deliberately EXCLUDED
// from the pending check — those are opt-in / costly steps. An episode
// that has the 7 core steps done should not be treated as pending just
// because it has no video.
function selectAllPending() {
  selectedEpisodes.clear()
  // Only AI per-scene video generation stays opt-in — video_assembly is
  // the final packaging step and we WANT the batch to include it so
  // "Run all pending" finishes episodes end-to-end.
  // Operate on the filtered set so "Select all pending" respects the
  // user's current filter choice. When the filter is "all", this is
  // every episode; when "missing-only", it's already the narrower pool.
  for (const ep of sortedFilteredEpisodes.value) {
    const needsAny = checkedStepsOrdered.value.some(step => {
      if (step.optional) return false
      return isStepApplicableForEpisode(step.id, ep) && !isStepDoneForEpisode(step.id, ep.status)
    })
    if (needsAny) selectedEpisodes.add(ep.episode_code)
  }
}

// Page-scoped variant — same pending logic, scoped to just the visible
// page. Doesn't clear existing selection so the user can build a working
// set across pages if they really want to.
function selectAllPendingOnPage() {
  for (const ep of paginatedEpisodes.value) {
    const needsAny = checkedStepsOrdered.value.some(step => {
      if (step.optional) return false
      return isStepApplicableForEpisode(step.id, ep) && !isStepDoneForEpisode(step.id, ep.status)
    })
    if (needsAny) selectedEpisodes.add(ep.episode_code)
  }
}

// ── Mark-done kebab menu ────────────────────────────────────────────────
// Per-episode action menu wired to the new mark-done route. Closes on any
// document click that isn't on a kebab trigger/menu — single global handler
// keeps the close-on-outside-click logic centralized rather than re-binding
// per row.
const openKebabFor = ref<string | null>(null)
const markingDone = ref<Set<string>>(new Set())

// Teleport-to-body coords for the kebab menu. Computed from the trigger
// button's bounding rect when the menu opens. Lets the menu escape the
// scrolling Episodes container (otherwise the menu on the last visible
// row gets clipped by the parent's overflow). Auto-flips upward when
// there's not enough room below the trigger.
const kebabPos = ref<{ top: number; left: number; width: number } | null>(null)
const KEBAB_MENU_WIDTH = 300         // matches min-width below + padding
const KEBAB_MENU_MAX_HEIGHT = 220    // tallest the menu gets with 4 items
const KEBAB_GAP = 4                  // px between trigger and menu

function positionKebabFor(triggerEl: HTMLElement) {
  const r = triggerEl.getBoundingClientRect()
  // Right-align the menu under the trigger by default.
  let left = r.right - KEBAB_MENU_WIDTH
  // Clamp to viewport with an 8px gutter so a narrow window still shows it fully.
  left = Math.max(8, Math.min(left, window.innerWidth - KEBAB_MENU_WIDTH - 8))
  // Auto-flip: if there's not enough space below, position above.
  const spaceBelow = window.innerHeight - r.bottom
  let top: number
  if (spaceBelow < KEBAB_MENU_MAX_HEIGHT + KEBAB_GAP) {
    top = r.top - KEBAB_GAP - KEBAB_MENU_MAX_HEIGHT
    // If above is also tight (extreme tiny window), pin to viewport top.
    if (top < 8) top = 8
  } else {
    top = r.bottom + KEBAB_GAP
  }
  kebabPos.value = { top, left, width: KEBAB_MENU_WIDTH }
}

function toggleKebab(code: string, ev?: MouseEvent) {
  if (openKebabFor.value === code) {
    openKebabFor.value = null
    kebabPos.value = null
    return
  }
  openKebabFor.value = code
  // Position the teleported menu against the actual trigger button. The
  // event target is the <button class="kebab-trigger"> the user clicked.
  const trigger = ev?.currentTarget as HTMLElement | undefined
  if (trigger) positionKebabFor(trigger)
}

function closeKebab() {
  openKebabFor.value = null
  kebabPos.value = null
}

function isStepManualForEpisode(stepId: StepId, ep: Episode): boolean {
  // Marked-done short-circuits everything — every pill is "manual".
  if (ep.marked_done) return true
  const ov = ep.status_overrides
  if (!ov) return false
  // Map step IDs back to the underlying status field(s). If any input
  // field for the step is overridden, the pill carries the (manual) hint.
  switch (stepId) {
    case 'research':          return 'research' in ov
    case 'script-only':       return 'script' in ov
    case 'introduction-only': return 'introduction' in ov
    case 'image_prompts':     return 'thumb_prompts' in ov
    case 'thumb_images':      return 'thumbnails' in ov
    case 'audio':             return 'audio' in ov
    case 'audio_merge':       return 'merged_audio' in ov
    case 'metadata':          return 'metadata' in ov
    // v1.0.363 — audio-paced format steps.
    case 'subtitles':         return 'subtitles' in ov
    case 'scene_plan':        return 'scene_plan' in ov
    case 'contextual_cues':   return 'contextual_cues' in ov
    case 'scene_review':      return 'scene_review' in ov
    case 'motion_review':     return 'motion_review' in ov
    case 'character_sheet':   return 'character_sheet' in ov
    case 'video_assembly':    return 'video_assembly' in ov
    case 'music_build':       return 'music_episode' in ov
  }
  return false
}

/**
 * Research answers TWO questions that one tick cannot carry:
 *   `research`          — evidence exists (what the pill and the Production
 *                          Board's Research column both show)
 *   `research_reviewed` — no claim is left pending
 * A done pill that stayed silent about the second one is how "20 researched"
 * hid seven episodes whose claims nobody had decided on. The pill still means
 * "evidence exists" — the triage state rides in the tooltip instead of
 * being folded into the tick, which would destroy the distinction.
 */
function researchNote(status: Record<string, unknown> | undefined): string {
  const s = status || {}
  if (!s.research) return ''
  if (!s.research_reviewed) return ' — claims still to review'
  // 'human' | 'pipeline-auto' | 'auto-approval'. Never let a machine accept —
  // an unattended batch or the project's automatic-approval setting — read as
  // a person having sat down and read the claims.
  const by = (s as Record<string, unknown>).research_reviewed_by
  const who = by === 'pipeline-auto'
    ? 'claims auto-accepted by the Pipeline, not read by a person'
    : by === 'auto-approval'
      ? 'claims auto-approved by this project’s setting, not read by a person'
      : 'claims reviewed'
  return s.research_has_usable_claims ? ` — ${who}` : ` — ${who}, none kept`
}

// The latest job for an episode step, when it is running now or failed last
// time — the pills otherwise drew a failed step exactly like one never started.
const { jobs: queueJobs } = useJobs()
const stepJobStates = computed(() => episodeStepJobStates(queueJobs.value || []))
const STEP_STATUS_FIELD_BY_ID: Partial<Record<StepId, string>> = {
  research: 'research', 'script-only': 'script', 'introduction-only': 'introduction',
  image_prompts: 'thumb_prompts', thumb_images: 'thumbnails', audio: 'audio', audio_merge: 'merged_audio',
  metadata: 'metadata', subtitles: 'subtitles', scene_plan: 'scene_plan', scene_review: 'scene_review',
  motion_review: 'motion_review', video_assembly: 'video_assembly', music_build: 'music_episode',
}
function stepJobState(stepId: StepId, ep: Episode): 'active' | 'failed' | null {
  const field = STEP_STATUS_FIELD_BY_ID[stepId]
  return field ? stepJobStates.value.get(`${ep.episode_code}:${field}`)?.state || null : null
}

function pillTitle(step: StepMeta, ep: Episode): string {
  const done = isStepDoneForEpisode(step.id, ep.status)
  const manual = isStepManualForEpisode(step.id, ep)
  const jobState = done ? null : stepJobState(step.id, ep)
  const status = done ? '✓ done'
    : jobState === 'active' ? 'being made now'
      : jobState === 'failed' ? 'last attempt failed — retry it from Jobs, or run the batch again'
        : 'missing'
  const note = step.id === 'research' ? researchNote(ep.status) : ''
  if (ep.marked_done) return `${step.label} — ${status}${note} (whole episode marked done manually)`
  if (manual) return `${step.label} — ${status}${note} (manual override)`
  return `${step.label} — ${status}${note}`
}

// Asset import dialog launch state. importEpisode === null when closed;
// otherwise points at the episode the dialog is bound to. We re-use the
// same dialog component for every row (mounted only when open).
const importEpisode = ref<Episode | null>(null)
const overrideEpisode = ref<Episode | null>(null)

function openImportFor(ep: Episode) {
  closeKebab()
  importEpisode.value = ep
}

function openOverridesFor(ep: Episode) {
  closeKebab()
  overrideEpisode.value = ep
}

// One episode changed, so one row is re-read (`?invalidate=CODE`), not the
// whole project (`?refresh=1` recomputed every row of a 400-episode channel).
// Both dialogs emit before `close`, so the bound episode is still set here.
function onImported(_summary: any) {
  // Newly-imported assets show up in the status pills.
  const code = importEpisode.value?.episode_code
  if (code) void revalidateAfterMutation(code).catch(() => { /* error stored on the list */ })
}

function onOverridesSaved(_payload: any) {
  // Per-step pills (and the (manual) annotation) update.
  const code = overrideEpisode.value?.episode_code
  if (code) void revalidateAfterMutation(code).catch(() => { /* error stored on the list */ })
}

async function onMarkDone(ep: Episode, done: boolean) {
  if (markingDone.value.has(ep.episode_code)) return
  markingDone.value.add(ep.episode_code)
  closeKebab()
  // Optimistic toggle — flip the local field immediately so the row
  // re-renders with the manual pill and dimmed pills before the network
  // round-trip completes. If the request fails we roll back via the
  // catch branch.
  const prev = ep.marked_done
  ep.marked_done = done
  try {
    await patchApi(`/projects/${slug.value}/episodes/${ep.episode_code}/mark-done`, { done })
    // Re-read this row — the per-step status fields haven't changed locally
    // (they reflect file detection), so the server's recomputed
    // override-applied status replaces our optimistic copy on the next paint.
    await revalidateAfterMutation(ep.episode_code)
    success(done ? `${ep.episode_code} marked done` : `${ep.episode_code} reverted to file detection`)
  } catch (e: any) {
    ep.marked_done = prev
    showError(e?.data?.detail || 'Failed to update mark-done state')
  } finally {
    markingDone.value.delete(ep.episode_code)
  }
}

// ── Bulk mark/unmark (operates on the current checkbox selection) ──────
// Sequential with a small concurrency cap so we don't fire 100 PATCH
// requests at once if the user selects everything. Per-episode failures
// don't block the rest — we collect counts and surface them in a toast
// at the end.
const bulkMarking = ref(false)

async function bulkMarkSelected(done: boolean) {
  if (bulkMarking.value) return
  const codes = Array.from(selectedEpisodes)
  if (!codes.length) return

  // Filter out no-ops (already in target state) so the confirm count and
  // the toast counts both reflect actual work.
  const toUpdate: Episode[] = []
  let alreadyInState = 0
  for (const code of codes) {
    const ep = episodes.value.find(e => e.episode_code === code)
    if (!ep) continue
    if (!!ep.marked_done === done) alreadyInState++
    else toUpdate.push(ep)
  }

  if (!toUpdate.length) {
    success(done
      ? `All ${alreadyInState} selected episode(s) are already marked done.`
      : `None of the ${alreadyInState} selected episode(s) are currently marked done.`,
    )
    return
  }

  // Confirm dialog — same pattern as the existing per-episode flow uses
  // (TopActionBar's preset delete). danger=true gives the destructive-action
  // styling. Spell out exactly what the action does so the user can't be
  // surprised by it.
  const ok = await ask({
    title: done
      ? `Mark ${toUpdate.length} episode(s) as already done?`
      : `Unmark ${toUpdate.length} episode(s)?`,
    message: done
      ? `Stops the pipeline from nagging about ${toUpdate.length} episode${toUpdate.length === 1 ? '' : 's'}. ${alreadyInState ? `(${alreadyInState} already-marked episode${alreadyInState === 1 ? '' : 's'} in the selection will be skipped.)` : ''} No files are deleted — fully reversible from the per-episode menu or with "Unmark selected".`
      : `Drops the manual override on ${toUpdate.length} episode${toUpdate.length === 1 ? '' : 's'} so their status reflects what's actually on disk. ${alreadyInState ? `(${alreadyInState} unmarked episode${alreadyInState === 1 ? '' : 's'} in the selection will be skipped.)` : ''} No files are deleted.`,
    confirmLabel: done ? 'Mark done' : 'Unmark',
    danger: !done,    // unmark feels more destructive (drops an override the user explicitly set)
  })
  if (!ok) return

  bulkMarking.value = true
  let okCount = 0
  let failCount = 0
  const CONCURRENCY = 5
  try {
    // Optimistic flip across the batch first so the UI feels snappy. We
    // roll back failed ones below.
    for (const ep of toUpdate) ep.marked_done = done
    for (const ep of toUpdate) markingDone.value.add(ep.episode_code)

    // Run in chunks of CONCURRENCY at a time. Promise.all per chunk keeps
    // the loop simple without needing a real concurrency-limiter library.
    for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
      const chunk = toUpdate.slice(i, i + CONCURRENCY)
      const results = await Promise.all(chunk.map(async (ep) => {
        try {
          await patchApi(`/projects/${slug.value}/episodes/${ep.episode_code}/mark-done`, { done })
          return { ep, ok: true }
        } catch (e: any) {
          return { ep, ok: false, err: e?.data?.detail || e?.message }
        }
      }))
      for (const r of results) {
        if (r.ok) okCount++
        else { failCount++; r.ep.marked_done = !done /* rollback */ }
      }
    }

    // Pull the server's recomputed override-applied status. Same reasoning
    // as the single-episode handler. Each PATCH already dropped its own row
    // server-side, so one fresh (never joined) read covers the batch; any
    // marked code serves as its key.
    if (okCount) await revalidateAfterMutation(toUpdate[0]!.episode_code).catch(() => { /* error stored on the list */ })

    const verb = done ? 'marked done' : 'unmarked'
    if (failCount === 0) {
      success(`${okCount} episode${okCount === 1 ? '' : 's'} ${verb}${alreadyInState ? ` · ${alreadyInState} skipped (already in state)` : ''}.`)
    } else if (okCount === 0) {
      showError(`Bulk ${verb} failed for all ${failCount} episode(s). Check the network or backend.`)
    } else {
      showError(`${okCount} ${verb}, ${failCount} failed${alreadyInState ? `, ${alreadyInState} skipped` : ''}. Failed rows reverted.`)
    }
  } finally {
    for (const ep of toUpdate) markingDone.value.delete(ep.episode_code)
    bulkMarking.value = false
  }
}

// Outside-click + scroll + key handlers. The menu is teleported to <body>
// with fixed positioning, so:
//   - outside-click test must accept clicks inside .kebab-menu (it's no
//     longer a descendant of .ep-kebab in the DOM tree)
//   - we close on scroll because fixed positioning leaves the menu
//     anchored to the viewport, not the trigger — when the user scrolls
//     the row away, the menu would otherwise float orphaned. Closing is
//     simpler than re-positioning continuously and matches native menus.
if (typeof window !== 'undefined') {
  const onDocClick = (e: MouseEvent) => {
    if (!openKebabFor.value) return
    const t = e.target as HTMLElement | null
    if (t && (t.closest('.ep-kebab') || t.closest('.kebab-menu'))) return
    closeKebab()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeKebab() }
  // Capture phase so we catch scroll events on any ancestor (the
  // <main class="main-content"> scroll container, the window, etc.).
  const onScroll = () => { if (openKebabFor.value) closeKebab() }
  onMounted(() => {
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('scroll', onScroll, true)
  })
}

// ── Validation ─────────────────────────────────────────────────────────
const blockingIssues = computed<string[]>(() => {
  const issues: string[] = []
  if (!visualSource.value) issues.push(formatError.value || 'Loading this project’s production format.')
  if (checkedStepCount.value === 0) issues.push('Pick at least one step to run.')
  if (selectedEpisodes.size === 0) issues.push('Select at least one episode.')
  for (const ep of episodes.value) {
    if (selectedEpisodes.has(ep.episode_code) && !episodeVisualSource(ep)) {
      issues.push(`${ep.episode_code}: visual source is unavailable. Refresh this episode before running it.`)
    }
  }
  for (const step of checkedStepsOrdered.value) {
    const policyError = modelPolicyError(step.id)
    if (policyError) issues.push(`${step.label}: ${policyError}`)
    if (noPresetStep(step.id)) continue   // runs on built-in defaults
    // A music episode renders with its own settings; a Video Assembly preset is optional there.
    if (musicPresetOptional(step.id)) continue
    if (!presetNameFor(step.id)) {
      issues.push(`No active preset for "${step.label}". Open that generator page, apply a preset, then come back.`)
    }
  }
  return issues
})

const canRun = computed(() => blockingIssues.value.length === 0 && !submitting.value && !preflighting.value)
const pipelineGenerateStatus = computed(() => {
  if (preflighting.value) return 'Checking every episode before anything starts…'
  if (submitting.value) return 'Queuing batch…'
  return blockingIssues.value[0] || ''
})
const runButtonLabel = computed(() => {
  if (selectedEpisodes.size === 0 || checkedStepCount.value === 0) return 'Run Batch'
  return `Run Batch (${selectedApplicableStepCount.value} estimated stages)`
})

// ── Submit ─────────────────────────────────────────────────────────────
const submitting = ref(false)
const preflighting = ref(false)
let preflightRequestId = 0
let submitRequestId = 0
const showConfirm = ref(false)
const repairMode = ref(false)
const repairActionId = ref('')
const runActionId = ref('')
const preflightSummary = ref('')
interface BlockedEpisode {
  episode_id: string
  reason: string
  issues?: Array<{ message?: string }>
}
const preflightBlocked = ref<BlockedEpisode[]>([])
const preflightEligibleCount = ref(0)
const preflightEligibleEpisodeIds = ref<string[] | null>(null)
const batchBlocked = ref<BlockedEpisode[]>([])
const batchHasJobs = ref(false)
const batchReceipt = ref<{ title: string; lines: string[]; jobsUrl: string | null } | null>(null)

const preflightEligibleApplicableStepCount = computed(() => {
  const eligible = preflightEligibleEpisodeIds.value
  if (!eligible) return selectedApplicableStepCount.value
  return selectedApplicableStages(new Set(eligible))
})

// ── Cost estimate (Run Batch) ───────────────────────────────────────────
// Prices come from the live catalogue rows already on the page (`price_usd`); no new gateway
// call. The model for each step is the one its active preset names.
const chatCatalog = useGenStudioChatModels()
const imageCatalog = useGenStudioImageModels()
const mediaCatalog = useGenStudioMediaModels()

function presetModelId(stepId: StepId): string {
  const preset = listForStep(stepById(stepId)).find(x => x.id === activePresetIdFor(stepId))
  const data = preset?.data ?? preset
  const model = data?.form?.model ?? data?.model
  return typeof model === 'string' ? model.trim().replace(/^genstudio-video:/, '') : ''
}

const batchEstimate = computed(() => {
  if (repairMode.value) return null
  const eligible = preflightEligibleEpisodeIds.value
  const runEpisodes = episodes.value.filter(ep => eligible ? eligible.includes(ep.episode_code) : selectedEpisodes.has(ep.episode_code))
  const policies = modelPoliciesForRun() as Record<string, unknown>
  const steps: EstimateStep[] = []
  for (const step of checkedStepsOrdered.value) {
    const spec = ESTIMATE_STEPS[step.id]
    if (!spec) continue
    // Only episodes that still have this step to do (Force re-run redoes every one).
    const todo = runEpisodes.filter(ep => isStepApplicableForEpisode(step.id, ep)
      && (forceRerun.value || !isStepDoneForEpisode(step.id, ep.status)))
    if (!todo.length) continue
    const modelId = presetModelId(step.id)
    const model = !modelId ? null
      : spec.catalog === 'chat' ? chatCatalog.find(modelId)
        : spec.catalog === 'image' ? imageCatalog.find(modelId)
          : (spec.catalog === 'tts' ? mediaCatalog.voiceModels.value : mediaCatalog.videoModels.value).find(m => m.id === modelId)
    steps.push({
      id: step.id,
      label: step.label,
      model: model ?? null,
      unit: spec.unit,
      unitNote: spec.unitNote,
      quantity: stepQuantity(step.id, todo.map(ep => ({
        scenesTotal: ep.scene_images?.total ?? 0,
        scenesPresent: ep.scene_images?.present ?? 0,
      })), forceRerun.value),
      ...(policies[step.id] ? { modelOverride: 'this run picks the model from a model policy, not the preset' } : {}),
    })
  }
  const estimate = estimateBatchUsd(steps)
  return estimate.priced.length || estimate.free.length || estimate.notIncluded.length ? estimate : null
})

function blockedEpisodes(value: unknown): BlockedEpisode[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: any) => {
    const episode_id = String(item?.episode_id || '').trim()
    if (!episode_id) return []
    const issueReasons = Array.isArray(item?.issues)
      ? item.issues.map((issue: any) => String(issue?.message || '').trim()).filter(Boolean)
      : []
    return [{
      episode_id,
      reason: String(item?.reason || issueReasons.join(' ') || 'This episode cannot start yet.'),
      issues: item?.issues,
    }]
  })
}

function hasGlobalPreflightIssue(value: unknown): boolean {
  return Array.isArray(value) && value.some((issue: any) => !issue?.episode_id)
}

// A partial 201 resolves every submitted episode except the server's named
// blockers. Keep those checked for the next attempt, while preserving any
// selection the operator changed after this request began.
function removeResolvedSubmittedEpisodes(submittedEpisodeIds: string[], blocked: BlockedEpisode[]): void {
  const blockedIds = new Set(blocked.map(item => item.episode_id))
  for (const episodeId of submittedEpisodeIds) {
    if (!blockedIds.has(episodeId)) selectedEpisodes.delete(episodeId)
  }
}
// Force re-run: opt-in to regenerate every selected step even if its
// output already exists on disk. Off by default so routine batch runs
// don't silently burn tokens on work that's already done.
const forceRerun = ref(false)
const forceRerunTitle = computed(() => forceRerun.value
  ? 'Force re-run is ON — every selected step will run. It may regenerate intentionally removed local sources, repeats provider costs, and still checks prerequisites.'
  : 'Force re-run is OFF — steps whose output already exists will be skipped automatically.')

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}

function closeConfirm(force = false): void {
  if (submitting.value && !force) return
  preflightRequestId += 1
  if (preflighting.value) preflighting.value = false
  showConfirm.value = false
  repairMode.value = false
  repairActionId.value = ''
  runActionId.value = ''
  // "Force re-run" is a PER-RUN choice, but it was never cleared — not when the
  // dialog closed, not when the run finished, and not when the project changed.
  // So one forced run left every later Run Batch in the session, including on a
  // DIFFERENT channel, opening with Force already ticked and the CTA reading
  // "Start batch (force)": pressing Start regenerated every selected stage and
  // repeated the provider charges. The page already resets model policies on a
  // project change for exactly this reason ("a project change must never carry
  // one channel's explicit products into another channel's request").
  forceRerun.value = false
  // NOTE: `preflightSummary` is deliberately NOT cleared here. It reads like
  // stale state, but the frontend suite asserts it survives a successful
  // submission — it is the receipt that says what was queued and links to Jobs,
  // not a leftover from the dialog. Clearing it broke five tests in
  // `pipelineRunReceipt.test.ts`, which is the contract speaking.
}

// Nuxt reuses this page between projects. A preflight belongs to its original
// channel, so close and invalidate it before the new project's state can load.
watch(slug, () => {
  // Navigation never cancels an already-authorized queue request. It only
  // detaches the old page's pending response from this reused component.
  submitRequestId += 1
  submitting.value = false
  closeConfirm(true)
})

function openRunConfirm(): void { void openConfirm(false) }
function openRepairConfirm(): void { void openConfirm(true) }

async function openConfirm(repair: boolean) {
  if (!canRun.value) return
  // The estimate reads prices off the shared catalogue caches; each skips the network while fresh.
  void Promise.allSettled([chatCatalog.refresh(), imageCatalog.refresh(), mediaCatalog.refresh()])
  const requestId = ++preflightRequestId
  const targetSlug = slug.value
  repairMode.value = repair
  if (repair && !repairActionId.value) repairActionId.value = crypto.randomUUID()
  if (!repair && forceRerun.value && !runActionId.value) runActionId.value = crypto.randomUUID()
  preflighting.value = true
  preflightSummary.value = ''
  preflightBlocked.value = []
  preflightEligibleCount.value = 0
  preflightEligibleEpisodeIds.value = null
  batchBlocked.value = []
  batchHasJobs.value = false
  showConfirm.value = true
  try {
    const body = {
      episode_ids: [...selectedEpisodes],
      steps: checkedStepsOrdered.value.map(s => s.id),
      ...(Object.keys(modelPoliciesForRun()).length ? { model_policies: modelPoliciesForRun() } : {}),
      force: repair ? false : forceRerun.value,
      ...(repair ? { repair_missing: true, action_id: repairActionId.value } : {}),
      ...(!repair && forceRerun.value ? { operation_id: runActionId.value || crypto.randomUUID() } : {}),
    }
    const result = await post<any>(`/projects/${targetSlug}/pipeline/preflight`, body)
    if (requestId !== preflightRequestId || slug.value !== targetSlug) return
    const estimated = Number(result?.estimated_bytes || 0)
    const storage = estimated > 0 ? ` Estimated workspace: ${formatFileSize(estimated)}.` : ''
    preflightBlocked.value = blockedEpisodes(result?.blocked)
    preflightEligibleCount.value = Array.isArray(result?.eligible_episode_ids)
      ? result.eligible_episode_ids.length
      : Number(result?.episodes || selectedEpisodes.size)
    preflightEligibleEpisodeIds.value = Array.isArray(result?.eligible_episode_ids)
      ? result.eligible_episode_ids.filter((episodeId: unknown): episodeId is string => typeof episodeId === 'string')
      : null
    preflightSummary.value = `${preflightEligibleCount.value} episode(s) and ${result.steps} step(s) are ready.${storage}`
  } catch (e: any) {
    if (requestId !== preflightRequestId || slug.value !== targetSlug) return
    closeConfirm()
    const blocked = blockedEpisodes(e?.data?.blocked)
    if (blocked.length && !hasGlobalPreflightIssue(e?.data?.issues)) {
      batchBlocked.value = blocked
      showInfo('No selected episodes are ready to start. Their reasons are shown below.')
      return
    }
    const issues = Array.isArray(e?.data?.issues) ? e.data.issues : []
    showError(issues.length ? issues.map((issue: any) => issue.message).join(' ') : (e?.data?.detail || 'Preflight failed'))
  } finally {
    if (requestId === preflightRequestId && slug.value === targetSlug) preflighting.value = false
  }
}

async function submit() {
  if (!canRun.value) return
  const requestId = ++submitRequestId
  const targetSlug = slug.value
  const submittedRepair = repairMode.value
  submitting.value = true
  try {
    if (!submittedRepair && forceRerun.value && !runActionId.value) runActionId.value = crypto.randomUUID()
    const submittedEpisodeIds = [...selectedEpisodes]
    const body = {
      episode_ids: submittedEpisodeIds,
      steps: checkedStepsOrdered.value.map(s => s.id),
      ...(Object.keys(modelPoliciesForRun()).length ? { model_policies: modelPoliciesForRun() } : {}),
      force: submittedRepair ? false : forceRerun.value,
      ...(submittedRepair ? { repair_missing: true, action_id: repairActionId.value } : {}),
      ...(!submittedRepair && forceRerun.value ? { operation_id: runActionId.value } : {}),
    }
    const r = await post<any>(`/projects/${targetSlug}/pipeline/run-batch`, body)
    if (requestId !== submitRequestId || slug.value !== targetSlug) return
    const completedRepair = submittedRepair
    closeConfirm(true)
    const {
      enqueued,
      reused,
      skipped,
      total_jobs_planned,
      steps_skipped_as_done,
      steps_skipped_as_inapplicable,
      character_sheets_applied,
    } = r || {}
    const queuedChains = Number(enqueued || 0)
    const reusedChains = Number(reused || 0)
    const totalJobsPlanned = Number(total_jobs_planned || 0)
    batchBlocked.value = blockedEpisodes(r?.blocked)
    removeResolvedSubmittedEpisodes(submittedEpisodeIds, batchBlocked.value)
    batchHasJobs.value = queuedChains > 0 || reusedChains > 0
    const skipDoneCount = Array.isArray(steps_skipped_as_done) ? steps_skipped_as_done.length : 0
    const skipInapplicableCount = Array.isArray(steps_skipped_as_inapplicable)
      ? steps_skipped_as_inapplicable.length
      : 0
    const parts: string[] = []
    if (queuedChains > 0) parts.push(`Added ${totalJobsPlanned} job(s) to Pipeline across ${queuedChains} episode(s)`)
    if (reusedChains > 0) parts.push(`${reusedChains} existing run(s) continue — no duplicate work queued`)
    // Character Sheet is applied inline (continuity.json written), not queued —
    // surface it separately so the count isn't silently missing from the toast.
    if (character_sheets_applied > 0) parts.push(`${character_sheets_applied} character sheet(s) applied`)
    if (skipDoneCount > 0) parts.push(`${skipDoneCount} step(s) skipped as already complete`)
    if (skipInapplicableCount > 0) parts.push(`${skipInapplicableCount} step(s) skipped because that episode uses Image Pool`)
    if (skipped?.length) parts.push(`${skipped.length} episode(s) skipped`)
    if (batchBlocked.value.length) parts.push(`${batchBlocked.value.length} selected episode(s) need attention`)
    batchReceipt.value = {
      title: queuedChains > 0 ? (completedRepair ? 'Repair queued' : 'Batch queued')
        : reusedChains > 0 ? 'Work already active' : 'Batch checked',
      lines: parts.length ? parts : ['Nothing new was queued.'],
      jobsUrl: batchHasJobs.value ? `/projects/${targetSlug}/jobs` : null,
    }
    // A skipped step queues NO job, so "see Jobs tab" sent the user to a
    // screen that could not explain the skip. The backend already returns a
    // reason per episode — show it. Distinct reasons only: a batch skips the
    // same way for every episode, and twenty copies of one sentence is not
    // more information.
    if (skipped?.length) {
      const reasons = [...new Set(skipped.map((s: any) => String(s?.reason || '')).filter(Boolean))]
      for (const reason of reasons.slice(0, 3)) showInfo(`Skipped — ${reason}`)
      if (reasons.length > 3) showInfo(`…and ${reasons.length - 3} more skip reason(s).`)
    }
  } catch (e: any) {
    if (requestId !== submitRequestId || slug.value !== targetSlug) return
    const blocked = blockedEpisodes(e?.data?.blocked)
    if (blocked.length && !hasGlobalPreflightIssue(e?.data?.issues)) {
      batchBlocked.value = blocked
      batchHasJobs.value = false
      closeConfirm(true)
      showInfo('No selected episodes were queued. Their reasons are shown below.')
      return
    }
    const missing = e?.data?.missing
    if (Array.isArray(missing) && missing.length) {
      showError(missing.map((m: any) => m.reason).join(' '))
    } else {
      showError(e?.data?.detail || 'Batch failed to start')
    }
  } finally {
    if (requestId === submitRequestId && slug.value === targetSlug) submitting.value = false
  }
}
</script>

<style scoped>
.pipeline-workspace :deep(.workspace-command-surface .top-action-bar) {
  margin: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.pipeline-command-copy {
  margin: 0;
  padding: 0 12px 4px;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  line-height: 1.55;
}

.step-selection-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.step-selection-count {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Episodes-card header — wraps onto a second line on narrow viewports
 * with a smaller gap than the rest of the page. */
.episodes-header { gap: 8px; }

.preflight-ok {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--success) 45%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--text-secondary);
  font-size: 13px;
}

/* "Can't start yet" problems list — bullet indent + slightly smaller
 * type than body copy. */
.problems-list { font-size: 13px; padding-left: 18px; }
.batch-blocked-reason { display: block; margin-top: 4px; }

/* ── Steps grid ───────────────────────────────────────────────────────── */
.steps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.step-tile {
  display: flex;
  gap: 10px;
  padding: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color 0.15s, background 0.15s;
}
.step-tile.selected { border-color: var(--accent); background: rgba(240, 198, 116, 0.06); }
.step-tile.missing  { border-color: rgb(180, 83, 9); background: rgba(245, 158, 11, 0.08); }
.step-tile.costly { border-style: dashed; }
.step-tile.policy-expanded { grid-column: 1 / -1; }
.step-tile.disabled { opacity: 0.55; cursor: not-allowed; }
.step-tile.disabled .step-toggle { cursor: not-allowed; }
.step-toggle { align-self: flex-start; flex: 0 0 auto; margin-top: 2px; }
.step-warning { margin-top: 4px; font-size: var(--font-xs); color: rgb(180, 83, 9); }
.step-body { flex: 1; }
.step-head { display: flex; align-items: center; gap: 8px; }
.step-icon { font-size: 16px; }
.step-preset {
  margin-top: 6px;
  font-size: var(--font-xs);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.step-preset-label {
  font-weight: 500;
  color: var(--text-secondary);
}
.step-preset-select {
  flex: 1;
  min-width: 120px;
  max-width: 220px;
  font-size: var(--font-xs);
  padding: 2px 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: inherit;
  cursor: pointer;
}
.step-preset-select:disabled { opacity: 0.6; cursor: progress; }
.preset-name { color: var(--accent); font-weight: 500; }
.preset-missing { color: rgb(180, 83, 9); font-size: var(--font-xs); }
.preset-link { color: var(--accent); text-decoration: underline; font-size: var(--font-xs); }
.step-preset-none { font-size: var(--font-xs); color: var(--text-muted); font-style: italic; }
.step-model-policy { margin-top: 8px; font-size: var(--font-xs); }
.step-model-policy summary { color: var(--text-secondary); cursor: pointer; }
.step-model-policy-summary { color: var(--text-muted); margin-left: 4px; }
.step-model-policy-body { display: grid; gap: 8px; margin-top: 8px; }
.step-model-policy-toggle { display: flex; align-items: flex-start; gap: 6px; color: var(--text-secondary); }
.step-model-policy-candidates { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.step-model-policy-candidate { display: grid; gap: 4px; }
.step-model-policy-candidate :deep(.form-group) { margin: 0; }
.step-model-policy-limits { margin: 0; color: var(--text-muted); line-height: 1.4; }
.step-model-policy-error { margin: 0; color: rgb(180, 83, 9); }

@media (max-width: 560px) {
  .step-model-policy-candidates { grid-template-columns: minmax(0, 1fr); }
}

/* ── Episode list ─────────────────────────────────────────────────────── */
.episode-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: visible;
  padding: 2px;
}
.episode-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.episode-row.selected { border-color: var(--accent); background: rgba(240, 198, 116, 0.06); }
.episode-row:hover { border-color: var(--accent); }
.ep-main { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ep-head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.ep-title { color: var(--text-secondary); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ep-media-status { color: var(--text-muted); font-size: var(--font-xs); white-space: nowrap; }
.ep-status { display: flex; gap: 6px; font-size: 13px; flex-wrap: wrap; }
.ep-pill {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  border-radius: 50%;
  font-size: 12px;
  transition: opacity 0.15s, filter 0.15s, background 0.15s;
  cursor: help;
}

/* Completed step: solid green + small ✓ tick in the corner so a row of 9
   icons reads as an at-a-glance progress bar. */
.ep-pill.done {
  background: rgba(46, 160, 67, 0.18);
  border: 1px solid rgba(46, 160, 67, 0.35);
  color: var(--text-primary);
}
.ep-pill.done::after {
  content: '✓';
  position: absolute;
  right: -2px; bottom: -2px;
  width: 11px; height: 11px;
  line-height: 10px;
  border-radius: 50%;
  background: var(--success, #3fb950);
  color: white;
  font-size: var(--font-xs);
  font-weight: 700;
  text-align: center;
}

/* Missing step: visibly greyed out, no border, low opacity so the eye
   lands on the done ones. Still visible enough to show which icon it is. */
.ep-pill.missing {
  background: var(--bg-primary, rgba(0, 0, 0, 0.2));
  border: 1px dashed var(--border);
  opacity: 0.4;
  filter: grayscale(1);
}
.pill-legend { line-height: 2; }
.ep-pill.legend-pill { width: 18px; height: 18px; font-size: var(--font-xs); vertical-align: middle; cursor: default; }
.ep-pill.failed {
  opacity: 1;
  filter: none;
  box-shadow: inset 0 0 0 2px var(--error);
}
.ep-pill.active {
  opacity: 1;
  filter: none;
  box-shadow: inset 0 0 0 2px var(--accent);
}
.ep-pill.not-applicable {
  background: transparent;
  border: 0;
  color: var(--text-muted);
  opacity: 0.65;
  filter: none;
}

/* Backward-compat aliases for any consumer still using the old classes.
   Remove once we're sure nothing references them. */
.ep-pill.ok { background: rgba(46, 160, 67, 0.18); color: var(--text-primary); }
.ep-pill.pending { opacity: 0.4; filter: grayscale(1); }

.selection-summary { padding: 4px 2px; }

.pipeline-quality-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.pipeline-quality-summary {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}

.pipeline-quality-summary p { margin: 0; color: var(--text-secondary); }
.pipeline-quality-mode {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 600;
}

.pipeline-quality-results {
  display: grid;
  gap: 6px;
  margin-bottom: 0;
  padding: 0;
  list-style: none;
}

.pipeline-quality-results li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}

.pipeline-quality-results li[data-tone='warning'] { border-color: color-mix(in srgb, var(--warning) 40%, var(--border)); }
.pipeline-quality-results li[data-tone='success'] { border-color: color-mix(in srgb, var(--success) 35%, var(--border)); }
.pipeline-quality-results li > div { display: flex; gap: 8px; min-width: 0; }
.pipeline-quality-results li span { color: var(--text-secondary); }

@media (max-width: 560px) {
  .pipeline-quality-actions,
  .pipeline-quality-actions .btn { width: 100%; }
  .pipeline-quality-summary { align-items: flex-start; flex-direction: column; }
  .pipeline-quality-results li { align-items: stretch; flex-direction: column; }
  .pipeline-quality-results li > div { flex-direction: column; gap: 3px; }
  .pipeline-quality-results .btn { width: 100%; }
}

/* ── Episode-list toolbar (sort / filter / page-size) ───────────────── */
.episode-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  font-size: 12px;
}
.toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.toolbar-label {
  color: var(--text-muted);
  font-weight: 500;
}

/* Episode-actions row — same flex layout as the inline `.flex.gap-2` it
   replaced, but with a defined class so we can style the dividers. */
.ep-actions-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* Visual divider between groups (bulk · global · page · clear/refresh).
   Thin vertical bar, slightly muted, just enough to read at a glance. */
.ep-actions-divider {
  display: inline-block;
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 2px;
}

/* Search input + clear button. Sits at the front of the toolbar so it
   reads naturally left-to-right ("find in this list, then sort/filter"). */
.toolbar-search {
  position: relative;
  flex: 1 1 240px;
  max-width: 320px;
}
.pipeline-search-input {
  width: 100%;
  padding-right: 26px;          /* leave room for the ✕ button */
}
.search-clear-btn {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 4px;
}
.search-clear-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.toolbar-count {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 12px;
}
.filter-hit-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  font-size: var(--font-xs);
  font-weight: 500;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
}

/* ── Pagination ───────────────────────────────────────────────────── */
.toolbar-pagination {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}
.toolbar-pagination .btn { min-width: 48px; }
.toolbar-pagination .pagination-edge { min-width: 32px; padding-inline: 8px; }
.page-indicator {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 2px;
  white-space: nowrap;
}

/* ── Problems card ────────────────────────────────────────────────────── */
.problems-card { border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.05); }

/* ── Confirm modal chain preview ──────────────────────────────────────── */
.batch-estimate ul { margin: 4px 0 0; padding-left: 18px; }
.chain-preview {
  display: flex; align-items: center; gap: 4px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.chain-step {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.chain-arrow { margin: 0 4px; color: var(--text-muted); }
.chain-icon { font-size: 14px; }

/* ── Force re-run toggle (confirm modal) ──────────────────────────────── */
.force-rerun {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
}
.force-rerun input[type="checkbox"] {
  margin-top: 2px;
  flex-shrink: 0;
  cursor: pointer;
}
.force-rerun-label {
  color: var(--text-primary);
  font-weight: 500;
}
.force-rerun-hint {
  color: var(--text-muted);
  font-weight: 400;
}

/* ── Manual-done state (mark-done overhaul) ───────────────────────────── */

/* The whole row gets a subtle green wash + slimmed asset pills so the
   "manual" state reads at a glance even when the menu's closed. */
.episode-row.marked-done {
  border-color: rgba(46, 160, 67, 0.45);
  background: rgba(46, 160, 67, 0.04);
}
.episode-row.marked-done .ep-pill {
  /* Done pills already look right; missing pills go invisible since the
     manual-done flag overrides file detection — there's nothing to fix. */
  opacity: 0.7;
}

/* Pill shown next to the title for marked-done rows. Conveys "this state
   came from a user action, not detection". Click the kebab menu to revert. */
.manual-done-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  border-radius: 999px;
  background: rgba(46, 160, 67, 0.18);
  color: var(--success, #3fb950);
  border: 1px solid rgba(46, 160, 67, 0.35);
  white-space: nowrap;
}

/* Per-step pill annotation when an individual override is in play (not the
   whole-episode mark-done). Subtle yellow ring distinguishes "manual" from
   "file-detected" without losing the green/grey done/missing distinction. */
.ep-pill.manual {
  outline: 1px solid rgba(240, 198, 116, 0.6);
  outline-offset: 1px;
}

/* ── Per-row kebab menu ──────────────────────────────────────────────── */
.ep-kebab {
  position: relative;
  flex-shrink: 0;
}
.kebab-trigger {
  width: 28px; height: 28px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.kebab-trigger:hover,
.kebab-trigger[aria-expanded="true"] {
  background: var(--bg-secondary);
  border-color: var(--border);
  color: var(--text-primary);
}
/* Kebab menu pane + items live in the unscoped <style> block at the
   bottom of this file. The menu is teleported to <body>, which puts it
   outside this scoped style scope (no data-v-* attribute on its DOM),
   so the styles need to be global to apply. */

/* v1.0.167 — External chain node: read-only "Open page" tile for steps the
   batch runner does not enqueue (currently Sound Design). Dashed + dimmer so it reads as
   informational, not selectable. */
.step-tile-external {
  cursor: default;
  border-style: dashed;
  opacity: 0.9;
}
.step-tile-external .external-badge {
  font-size: 1rem;
  line-height: 1.4;
  color: var(--text-muted);
  flex: 0 0 auto;
}
.step-external-note {
  font-size: var(--font-xs);
  color: var(--text-muted);
  line-height: 1.4;
  margin: 2px 0 4px;
}
</style>

<!-- Unscoped — applies to the kebab menu after it teleports to <body>.
     Anything still in DOM-tree-scope (.ep-kebab, .kebab-trigger) lives
     above in the scoped block. -->
<style>
.kebab-menu {
  position: fixed;             /* teleported; coords come from kebabPos */
  z-index: 250;
  min-width: 280px;
  padding: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.kebab-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
  font-family: inherit;
  transition: background 0.1s;
}
.kebab-item:hover { background: var(--bg-tertiary); }
.kebab-icon {
  width: 20px;
  flex-shrink: 0;
  font-size: 14px;
  color: var(--accent);
  text-align: center;
  margin-top: 1px;
}
.kebab-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.kebab-body strong { font-size: 13px; font-weight: 600; }
.kebab-hint { font-size: var(--font-xs); color: var(--text-muted); line-height: 1.35; }
</style>
