<template>
  <div class="uc-publish">
    <p v-if="loading" class="hint">Loading this channel’s uploads…</p>
    <div v-else-if="loadError" class="load-failure" role="alert">
      <p class="result err">{{ loadError }}</p>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="refreshingList" @click="refreshList">
        {{ refreshingList ? 'Retrying…' : 'Retry Loading' }}
      </button>
    </div>

    <template v-else>
      <!--
        Rows are EPISODES, not upload records.

        This list used to be `/youtube/operations`, which only exists once an
        upload has happened — so a project that had never uploaded had no rows,
        and metadata review (inside a row) and Upload (under that review) could not be
        reached at all. The page said "Nothing uploaded yet" and offered nothing
        to press. An episode is publishable because it is finished, not because
        it has been published before; the record is overlaid where there is one.
      -->
      <section class="panel uploads">
        <header class="uploads-head">
          <div>
            <h3 id="upload-list-title" ref="uploadListHeading" tabindex="-1">{{ episodes.length === 0 ? 'Nothing ready to publish yet' : `${total} episode${total === 1 ? '' : 's'}` }}</h3>
            <p v-if="episodes.length" class="hint">Local files, upload work, and YouTube publication are shown separately.</p>
            <p v-else class="hint">An episode appears here once it is accepted. Render its final video in Video Assembly before uploading.</p>
          </div>
          <div class="head-actions">
            <span v-if="episodes.length" class="visible-count" aria-live="polite">{{ shownEpisodes.length < sortedEpisodes.length ? `${shownEpisodes.length} of ` : '' }}{{ sortedEpisodes.length }} shown</span>
            <button
              v-if="episodes.length" class="btn btn-ghost btn-sm" type="button"
              :disabled="busy !== '' || !planCandidates.length || !!planBlocked"
              :title="planBlocked || (!planCandidates.length ? 'No visible video needs a planned date.' : '')"
              @click="planUnscheduledVideos()"
            >
              {{ busy === 'plan-batch' ? 'Planning…' : `${planCandidates.some(hasMissedPlan) ? 'Plan Missing or Missed Dates' : 'Plan Unscheduled Videos'} (${planCandidates.length})` }}
            </button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="refreshingList" @click="refreshList">
              {{ refreshingList ? 'Refreshing…' : 'Refresh List' }}
            </button>
          </div>
        </header>

        <div v-if="assignedChannel" class="channel-banner channel-ready" role="status">
          <div>
            <span class="section-kicker">Publishing to</span>
            <strong>{{ assignedChannel.title }}</strong>
            <code>{{ assignedChannel.channel_id }}</code>
          </div>
          <span :class="['state-text', channelStatus === 'connected' ? 'tone-success' : 'tone-danger']">
            {{ channelStatus === 'connected' ? 'Connected' : channelStatus === 'scope_upgrade_required' ? 'Permission upgrade required' : 'Sign-in expired' }}
          </span>
          <NuxtLink v-if="channelStatus && channelStatus !== 'connected'" :to="reconnectLink" class="btn btn-primary btn-sm">Reconnect</NuxtLink>
        </div>
        <div v-else-if="!overviewError" class="channel-banner channel-missing" role="alert">
          <div>
            <strong>No YouTube channel assigned</strong>
            <span>These videos are ready locally, but Story Studio cannot upload them until a YouTube channel is assigned.</span>
          </div>
          <NuxtLink :to="`/projects/${slug}/settings#youtube`" class="btn btn-ghost btn-sm">Assign Channel</NuxtLink>
        </div>
        <p v-if="planResult" :class="['result', planResult.kind]" role="status">
          {{ planResult.message }}
          <NuxtLink v-if="isNoActivePlanMessage(planResult.message)" :to="`/projects/${slug}/upload/plans`" class="inline-action">Open Upload Plans</NuxtLink>
        </p>
        <p v-if="relayoutResult" :class="['result', relayoutResult.kind]" role="status">{{ relayoutResult.message }}</p>

        <div v-if="episodes.length" class="episode-tools">
          <input
            v-model="filter" class="ep-filter" type="search"
            placeholder="Find by episode code or title"
            aria-label="Filter episodes by code or title"
          />
          <label class="sort-control">
            <span>Sort</span>
            <select v-model="sort" aria-label="Sort episodes">
              <option value="episode_newest">Newest episode</option>
              <option value="episode_oldest">Oldest episode</option>
              <option value="schedule_soonest">Schedule date</option>
              <option value="status">Status</option>
            </select>
          </label>
        </div>

        <div v-if="episodes.length" class="status-filters" aria-label="Filter episodes by publishing status">
          <button
            v-for="option in statusOptions" :key="option.key" type="button"
            :class="['status-chip', { active: statusFilter === option.key }]"
            :aria-pressed="statusFilter === option.key"
            @click="statusFilter = option.key"
          >
            {{ option.label }} <span class="status-count">{{ option.count }}</span>
          </button>
        </div>

        <!--
          Bulk actions. Collapsed to one line until a row is ticked (owner,
          2026-10: the always-open panel pushed the list off the first screen);
          then each action shows, disabled with its reason when nothing fits,
          and says whether it changes YouTube or only Story Studio. They act
          only on selected rows the filters match: a row hidden by a filter is
          never touched.
        -->
        <section v-if="episodes.length" :class="['bulk-panel', { collapsed: !bulkOpen }]" aria-labelledby="bulk-panel-title">
          <div class="bulk-selection">
            <h4 id="bulk-panel-title">Bulk actions</h4>
            <span class="bulk-count" aria-live="polite">{{ selectionSummary }}</span>
            <button
              class="btn btn-ghost btn-sm" type="button"
              :disabled="busy !== '' || !sortedEpisodes.length"
              @click="toggleAllMatching"
            >
              {{ allMatchingSelected ? `Unselect These ${sortedEpisodes.length}` : `Select All Matching (${sortedEpisodes.length})` }}
            </button>
            <button v-if="selectedCodes.length" class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="clearSelection">
              Clear Selection
            </button>
          </div>
          <template v-if="bulkOpen">
          <p class="hint">
            Tick rows, or Shift-click a second row to tick everything between. “Select All Matching” ticks every row the
            search and status filters match, including rows further down that are not shown yet. Each action asks first and
            names the exact number of videos.
          </p>
          <p v-if="hiddenSelectedCount" class="hint tone-warn" role="status">
            {{ hiddenSelectedCount }} selected row{{ hiddenSelectedCount === 1 ? ' is' : 's are' }} hidden by the filters and will be left alone.
          </p>
          <p v-if="selectedBelowCount" class="hint" role="status">
            {{ selectedBelowCount }} selected row{{ selectedBelowCount === 1 ? ' is' : 's are' }} further down the list, not shown yet, and included.
          </p>
          <ul class="bulk-actions">
            <li v-for="action in bulkActions" :key="action.key" class="bulk-action">
              <div class="bulk-action-head">
                <button
                  :class="['btn', 'btn-sm', action.key === 'upload' && !action.why ? 'btn-primary' : 'btn-ghost']" type="button"
                  :disabled="busy !== '' || !!action.why"
                  @click="runBulkAction(action.key, $event)"
                >
                  {{ action.key === 'upload' && busy === 'bulk-preview' ? 'Reviewing…' : action.label }}
                </button>
                <span :class="['bulk-where', action.youtube ? 'tone-info' : 'tone-muted']">{{ action.youtube ? 'Changes YouTube' : 'Story Studio only' }}</span>
              </div>
              <small>{{ action.hint }}</small>
              <small v-if="action.why" class="bulk-why">{{ action.why }}</small>
            </li>
          </ul>
          </template>
          <div v-if="bulkRun" class="bulk-progress" role="status" aria-live="polite">
            <p>
              <strong>{{ bulkRun.label }}:</strong>
              {{ bulkRun.done }} of {{ bulkRun.total }} done<template v-if="bulkRun.failed"> · {{ bulkRun.failed }} could not be done (the reason is on each row)</template><template v-if="bulkRun.stopped"> · stopped before the rest</template>.
              {{ bulkRun.note }}
            </p>
            <button
              v-if="!bulkRun.finished && bulkRun.stoppable" class="btn btn-ghost btn-sm" type="button"
              :disabled="bulkRun.stopRequested" @click="bulkRun.stopRequested = true"
            >{{ bulkRun.stopRequested ? 'Stopping After This Row…' : 'Stop After This Row' }}</button>
            <button v-else-if="bulkRun.finished" class="btn btn-ghost btn-sm" type="button" @click="bulkRun = null">Dismiss</button>
          </div>
        </section>

        <p v-if="total && !sortedEpisodes.length" class="empty-filter" role="status">
          No episodes match these filters. <button type="button" class="inline-action" @click="clearFilters">Clear Filters</button>
        </p>
        <div v-if="sortedEpisodes.length" class="episode-columns" aria-hidden="true">
          <span>Episode</span><span>Local video</span><span>Upload</span><span>Publication</span><span>Actions</span>
        </div>
        <ul v-if="sortedEpisodes.length" class="op-list">
          <li v-for="ep in shownEpisodes" :key="ep.episode_code" class="op" :data-episode-code="ep.episode_code">
            <div class="op-id">
              <label class="row-select" :title="`Select ${ep.episode_code}. Shift-click selects every row between this one and the last one you clicked.`">
                <input
                  type="checkbox" :checked="selectedCodes.includes(ep.episode_code)"
                  :disabled="busy !== ''" @click="onRowSelect(ep.episode_code, $event)"
                />
                <span>Select {{ ep.episode_code }}</span>
              </label>
              <strong>{{ ep.episode_code }}</strong>
              <span class="episode-title">{{ ep.title }}</span>
              <code v-if="ep.remote_video_id || ep.operation?.video_id" class="muted">{{ ep.remote_video_id || ep.operation?.video_id }}</code>
            </div>

            <div class="fact">
              <span class="fact-label">Local video</span>
              <span :class="['state-text', stateTone(renderState(ep))]">{{ renderLabel(ep) }}</span>
              <span v-if="renderState(ep) === 'ready' && !assignedChannel" class="fact-note">Ready locally · assign a channel to upload.</span>
              <button v-if="playableVideoUrl(ep)" class="inline-action" type="button" @click="openVideo(ep)">Play Local Video</button>
              <NuxtLink v-else-if="renderState(ep) === 'missing'" class="inline-action" :to="videoAssemblyLink(ep)">Open Video Assembly</NuxtLink>
            </div>

            <div class="fact">
              <span class="fact-label">Upload</span>
              <span :class="['state-text', stateTone(uploadState(ep))]">{{ uploadLabel(ep) }}</span>
              <span v-if="uploadReason(ep)" class="fact-note">{{ uploadReason(ep) }}
                <NuxtLink v-if="needsReconnect(uploadReason(ep))" :to="reconnectLink" class="inline-action">Reconnect</NuxtLink>
              </span>
              <ProgressBar
                v-if="uploadProgress(ep)"
                class="upload-progress"
                :progress="uploadProgress(ep)?.progress"
                :bytes-done="uploadProgress(ep)?.bytes_done"
                :bytes-total="uploadProgress(ep)?.bytes_total"
                :speed-bps="uploadProgress(ep)?.speed_bps"
                :eta-seconds="uploadProgress(ep)?.eta_seconds"
                :indeterminate="uploadProgress(ep)?.progress == null && uploadProgress(ep)?.bytes_total == null"
                :label="isUploadPaused(ep) ? 'Paused' : uploadState(ep) === 'queued' ? 'Waiting to upload' : 'Uploading to YouTube'"
              />
              <NuxtLink v-if="uploadProgress(ep)" class="inline-action" :to="`/projects/${slug}/jobs`">{{ isUploadPaused(ep) ? 'Resume in Jobs' : 'View in Jobs' }}</NuxtLink>
              <span v-if="uploadProgress(ep) && jobsStale" class="fact-note">Progress may be out of date.</span>
            </div>

            <div class="fact publication-fact">
              <span class="fact-label">Publication</span>
              <span :class="['state-text', stateTone(publicationState(ep))]">{{ publicationLabel(ep) }}</span>
              <span v-if="publicationDate(ep)" class="fact-note">{{ publicationDate(ep) }}</span>
              <span v-if="plannedDate(ep)" :class="['fact-note', { 'tone-danger': hasMissedPlan(ep) }]">{{ hasMissedPlan(ep) ? 'Missed plan' : 'Plan' }}: {{ plannedDate(ep) }}</span>
              <button
                v-if="hasMissedPlan(ep) && canPlanEpisode(ep)" class="inline-action" type="button"
                :disabled="busy !== '' || !!planBlocked" :title="planBlocked || ''"
                @click="planUnscheduledVideos([ep.episode_code])"
              >Move Missed Date Forward</button>
              <span v-if="publicationReason(ep)" class="fact-note">{{ publicationReason(ep) }}</span>
              <span v-if="lastCheckedLabel(ep)" class="fact-note">{{ lastCheckedLabel(ep) }}</span>
            </div>

            <div class="op-actions">
              <button
                v-if="ep.operation?.video_id" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== '' || !!remoteBlocked" :title="remoteBlocked || ''"
                @click="refresh(ep.operation)"
              >
                {{ busy === ep.operation.operation_id ? 'Checking…' : 'Check on YouTube' }}
              </button>
              <a
                v-if="associatedVideoId(ep)"
                :href="`https://studio.youtube.com/video/${encodeURIComponent(associatedVideoId(ep))}/edit`"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-ghost btn-sm"
                title="Start a thumbnail test in YouTube Studio"
              >
                Start a thumbnail test in YouTube Studio
              </a>
              <button
                v-if="canScheduleExisting(ep)" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== '' || !!scheduleBlocked" :title="scheduleBlocked || ''"
                @click="preview(ep.episode_code, $event, 'schedule')"
              >
                {{ busy === `preview-${ep.episode_code}` ? 'Preparing…' : 'Schedule Publication' }}
              </button>
              <button
                v-if="renderState(ep) === 'ready'" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== ''" @click="preview(ep.episode_code, $event)"
              >
                {{ busy === `preview-${ep.episode_code}` ? 'Preparing…' : 'Review Upload Details' }}
              </button>
              <button
                v-if="renderState(ep) === 'ready'" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== '' || !!ep.final_check?.running" @click="runFinalCheck(ep)"
                title="Measure the finished video now: its length against the plan, its closing tail, black stretches, silence, picture and sound, captions and size. It runs in the background and takes a few minutes."
              >
                {{ ep.final_check?.running ? 'Checking…' : 'Run Final Check' }}
              </button>
              <NuxtLink
                v-if="renderState(ep) === 'ready' && !assignedChannel"
                :to="`/projects/${slug}/settings#youtube`" class="btn btn-ghost btn-sm"
              >Assign Channel</NuxtLink>
              <NuxtLink
                v-if="uploadState(ep) === 'succeeded'" :to="`/projects/${slug}/settings#free-up-space`"
                class="btn btn-ghost btn-sm" title="Shrink images and move clips, chapter narration and the final video to this channel's _trash"
              >Free Up Space</NuxtLink>
              <button
                v-if="associatedVideoId(ep) && assignedChannel" class="btn btn-ghost btn-sm forget-upload" type="button"
                :disabled="busy !== ''" @click="forgetUpload(ep)"
              >I Deleted This Video on YouTube</button>
            </div>
            <p v-if="ep.final_check" :class="['row-result', ep.final_check.passed ? 'ok' : 'warn']">{{ ep.final_check.summary }}</p>
            <p v-if="ep.auto_schedule_hold" class="row-result warn">{{ ep.auto_schedule_hold.reason }}</p>
            <p v-if="ep.blocked_reason" class="row-result warn">{{ ep.blocked_reason }}</p>
            <p v-if="rowResults[ep.episode_code]" :class="['row-result', rowResults[ep.episode_code].kind]" role="status">
              {{ rowResults[ep.episode_code].message }}
            </p>
          </li>
        </ul>
        <!-- 400 rows at once made the page slow and endless; 50 at a time. -->
        <div v-if="shownEpisodes.length < sortedEpisodes.length" class="show-more">
          <span class="hint">Showing {{ shownEpisodes.length }} of {{ sortedEpisodes.length }}</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="shownCount += PUBLISH_PAGE">
            Show {{ Math.min(PUBLISH_PAGE, sortedEpisodes.length - shownEpisodes.length) }} More
          </button>
        </div>
        <!-- Spec section 17: disable only the REMOTE actions, and say why. The
             local records above stay fully readable either way. -->
        <p v-if="remoteBlocked" class="result warn">{{ remoteBlocked }}
          <NuxtLink v-if="channelStatus === 'reconnect_required'" :to="reconnectLink" class="inline-action">Reconnect</NuxtLink>
        </p>
        <p v-if="overviewError" class="result warn">{{ overviewError }} Local video facts remain available.</p>
        <p class="hint">Story Studio checks unfinished uploads with YouTube every 30 minutes; Check All Uploads on the Upload Center asks about every upload, older ones included. Each check spends a little of this Cloud project’s daily allowance.</p>
      </section>

      <!--
        Queueing continues after the bulk dialog is dismissed. The dialog was
        the only place that said so and the only place with Stop; this strip
        keeps both on the page until the last reviewed row has been queued.
      -->
      <section v-if="bulkQueueInBackground" class="panel bulk-background" role="status" aria-live="polite">
        <p v-if="busy === 'bulk-upload'">
          Queueing reviewed uploads in the background: {{ bulkQueuedCount }} of {{ bulkQueueTotal }} queued.
          Queued uploads continue and appear in Jobs.
        </p>
        <p v-else>
          Queueing stopped after {{ bulkQueuedCount }} of {{ bulkQueueTotal }}. Already queued uploads continue in Jobs; the remaining Reviewed rows can be queued when you are ready.
        </p>
        <div class="bulk-background-actions">
          <button class="btn btn-sm" type="button" @click="reopenBulkReview">Show</button>
          <button
            v-if="busy === 'bulk-upload'"
            class="btn btn-ghost btn-sm" type="button"
            :disabled="bulkQueueStopRequested" @click="bulkQueueStopRequested = true"
          >{{ bulkQueueStopRequested ? 'Stopping After Current…' : 'Stop Queueing' }}</button>
          <button v-else class="btn btn-ghost btn-sm" type="button" @click="closeBulkReview">Dismiss</button>
        </div>
      </section>

      <!--
        The dialog opens on the click, not on the server's answer. Building the
        exact payload hashes the whole rendered video, which took 25 s on a busy
        Mac with an 840 MB final; the page showed nothing for all of it. The
        header and its Close are pinned while the body scrolls, and the primary
        action is pinned at the bottom, so neither needs a scroll to reach.
      -->
      <Modal :visible="!!previewedEpisode" size="lg" labelledby="upload-review-title" dialog-class="modal-flush" @close="closeReview()">
        <section v-if="previewed" class="upload-review">
          <header class="review-head">
            <div>
              <h2 id="upload-review-title" ref="previewHeading" tabindex="-1">What YouTube will receive</h2>
              <p>{{ previewedEpisode }} · exact metadata review before upload</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="closeReview()">Close</button>
          </header>
          <div class="review-body">
          <p v-if="previewed.modifications.length" class="hint">
            {{ previewed.modifications.length }} change{{ previewed.modifications.length === 1 ? '' : 's' }} applied to your metadata:
          </p>
          <p v-else class="hint">Nothing in your metadata needed changing.</p>

        <section v-if="!alreadyPublished || reviewIntent === 'schedule'" class="publishing-review" aria-labelledby="upload-timing-title">
          <div>
            <p class="section-kicker">Publishing</p>
            <h3 id="upload-timing-title">When should this video go public?</h3>
          </div>
          <p v-if="reviewIntent === 'schedule' && scheduleVisibilityUnknown" class="result warn" role="status">
            Story Studio has not confirmed this video’s visibility. YouTube will be checked only after you confirm; public or unlisted videos will not be changed.
          </p>
          <div class="timing-options" role="radiogroup" aria-labelledby="upload-timing-title">
            <label :class="['timing-option', { unavailable: !plannedPublishAt }]">
              <input
                v-model="timingMode" type="radio" value="planned"
                :disabled="busy !== '' || !plannedPublishAt"
                @change="changeTimingMode"
              />
              <span><strong>Use planned date</strong><small>{{ plannedPublishAt ? formatZonedWhen(plannedPublishAt, selectedEpisode?.plan?.timezone) : 'No future planned date is saved for this episode.' }}</small></span>
            </label>
            <label class="timing-option">
              <input v-model="timingMode" type="radio" value="custom" :disabled="busy !== ''" @change="changeTimingMode" />
              <span><strong>Schedule a custom date</strong><small>Choose a future date and time in {{ deviceTimezone }}.</small></span>
            </label>
            <label class="timing-option">
              <input v-model="timingMode" type="radio" value="private" :disabled="busy !== ''" @change="changeTimingMode" />
              <span><strong>Keep private</strong><small>Upload now without a public date. You can schedule it later.</small></span>
            </label>
          </div>
          <div v-if="timingMode === 'custom'" class="custom-timing">
            <label>
              <span>Date and time</span>
              <input
                v-model="customDateTime" type="datetime-local" :min="customMinimum"
                :disabled="busy !== ''" @input="markTimingDirty"
              />
            </label>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== '' || !customDateTime" @click="reviewCustomTiming">
              {{ busy.startsWith('timing-') ? 'Reviewing…' : 'Review This Time' }}
            </button>
          </div>
            <button
              v-if="!plannedPublishAt && reviewIntent === 'upload'"
            class="inline-action" type="button" :disabled="busy !== '' || !!planBlocked"
            @click="useNextPlanSlot"
          >
            Use the Next Date from This Channel’s Upload Plan
          </button>
          <NuxtLink :to="`/projects/${slug}/upload/plans`" class="inline-action">Manage Upload Plans</NuxtLink>
          <p v-if="timingError" class="row-result err" role="alert">
            {{ timingError }}
            <NuxtLink v-if="isNoActivePlanMessage(timingError)" :to="`/projects/${slug}/upload/plans`" class="inline-action">Open Upload Plans</NuxtLink>
          </p>
          <p v-else-if="timingDirty" class="hint" role="status">Review this timing choice to rebuild the exact YouTube payload before continuing.</p>
        </section>

        <ul v-if="previewed.modifications.length" class="changes">
          <li v-for="(change, i) in previewed.modifications" :key="i"><b>{{ change.field }}</b> — {{ change.reason }}</li>
        </ul>
        <ul v-if="previewed.warnings.length" class="warnings">
          <li v-for="(warning, i) in previewed.warnings" :key="i"><b>Warning:</b> {{ warning }}</li>
        </ul>

        <UploadMetadataChecklist :items="previewed.checklist" />

        <section class="thumbnail-review" aria-labelledby="upload-thumbnail-title">
          <div class="thumbnail-review-head">
            <div>
              <p class="section-kicker">Thumbnail</p>
              <h3 id="upload-thumbnail-title">{{ alreadyPublished ? 'Current local thumbnail' : 'Choose the image for this upload' }}</h3>
            </div>
            <span v-if="previewed.thumbnail.options.length" class="thumbnail-count">
              {{ previewed.thumbnail.options.length }} option{{ previewed.thumbnail.options.length === 1 ? '' : 's' }}
            </span>
          </div>
          <template v-if="previewed.thumbnail.state === 'selected'">
            <div :class="['selected-thumbnail', { 'has-candidates': isPostUpload && otherThumbnailCandidates.length > 0 }]">
              <div class="chosen-thumbnail-wrap">
                <span v-if="isPostUpload" class="candidate-tag chosen-tag">✓ Chosen thumbnail</span>
                <img
                  v-if="!thumbnailImageUnavailable"
                  :src="previewed.thumbnail.url"
                  :alt="`Thumbnail selected for ${previewedEpisode}`"
                  @error="thumbnailImageUnavailable = true"
                />
                <div v-else class="thumbnail-unavailable" role="status">
                  This thumbnail file is selected, but its preview is unavailable.
                </div>
                <div class="selected-thumbnail-copy">
                  <strong>{{ previewed.thumbnail.filename }}</strong>
                  <span v-if="alreadyPublished">Current local selection. It does not change the upload already queued or on YouTube.</span>
                  <span v-else>Selected for this upload request. Your saved default is unchanged.</span>
                </div>
              </div>

              <!-- Other 2 candidate thumbnails shown beside the chosen one after an upload -->
              <div v-if="isPostUpload && otherThumbnailCandidates.length > 0" class="other-candidates-wrap" aria-label="Other thumbnail candidates">
                <div
                  v-for="candidate in otherThumbnailCandidates"
                  :key="candidate.filename"
                  class="candidate-thumb-card"
                >
                  <div class="candidate-header">
                    <span class="candidate-tag">Candidate</span>
                    <small v-if="candidate.is_pinned" class="pinned-tag">Saved default</small>
                  </div>
                  <img :src="candidate.url" :alt="`Candidate thumbnail ${candidate.filename}`" />
                  <div class="candidate-copy">
                    <strong>{{ candidate.filename }}</strong>
                    <small>Available for test in YouTube Studio</small>
                  </div>
                </div>
              </div>
            </div>

            <!-- Start thumbnail test link in YouTube Studio -->
            <div v-if="isPostUpload && recordedVideoId" class="thumbnail-test-cta">
              <a
                :href="youtubeStudioVideoUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-primary btn-sm thumbnail-test-link"
              >
                Start a thumbnail test in YouTube Studio ↗
              </a>
              <span class="hint">Opens this video’s page in YouTube Studio to run a thumbnail test across these candidates.</span>
            </div>
          </template>
          <div v-else-if="previewed.thumbnail.state === 'unavailable'" class="thumbnail-unavailable" role="status">
            <strong>{{ previewed.thumbnail.filename }}</strong>
            <span>{{ previewed.thumbnail.reason || 'The selected thumbnail is unavailable.' }}</span>
          </div>
          <div v-else class="thumbnail-unavailable" role="status">
            <strong>No thumbnail is selected for this upload.</strong>
            <span>A thumbnail is required. Choose or generate one before uploading.</span>
          </div>
          <div v-if="previewed.thumbnail.options.length > 1 || previewed.thumbnail.state !== 'selected' || thumbnailImageUnavailable" class="thumbnail-options" aria-label="Choose thumbnail">
            <button
              v-for="option in previewed.thumbnail.options"
              :key="option.filename"
              type="button"
              :class="['thumbnail-option', { selected: option.filename === previewed.thumbnail.filename }]"
              :data-thumbnail-filename="option.filename"
              :aria-pressed="option.filename === previewed.thumbnail.filename"
              :title="option.filename === previewed.thumbnail.filename && thumbnailImageUnavailable ? 'Retry thumbnail preview' : `Use ${option.filename}`"
              :disabled="busy !== '' || !!alreadyPublished"
              @click="selectThumbnail(option.filename, $event)"
            >
              <img :src="option.url" alt="" />
              <span>{{ option.filename }}</span>
              <small v-if="option.filename === previewed.thumbnail.filename">✓ Selected</small>
              <small v-if="option.is_pinned">Saved default</small>
            </button>
          </div>
          <p v-if="thumbnailError" class="row-result err" role="alert">{{ thumbnailError }}</p>
          <div class="thumbnail-review-actions">
            <button
              v-if="thumbnailTextEnabled && previewed.thumbnail.state === 'selected' && previewed.thumbnail.filename"
              type="button"
              class="btn btn-sm btn-secondary"
              :disabled="busy !== '' || !!alreadyPublished"
              title="Add a headline to a copy of this thumbnail"
              @click="openTextEditor"
            >
              Add text
            </button>
            <NuxtLink class="thumbnail-generator-link" :to="thumbnailGeneratorLink(previewedEpisode)">
              Open {{ previewedEpisode }} in Thumbnail Generator
            </NuxtLink>
          </div>
        </section>

        <!-- ── Thumbnail text editor (owner-approved 2026-10-24) ──────────
             Only reachable when this channel switched the text layer on. The
             source is the thumbnail this upload review has actually selected —
             the same file the payload will pin. -->
        <ThumbnailTextEditor
          :visible="textEditorOpen"
          :project-slug="slug"
          :episode-code="previewedEpisode"
          :initial-source="previewed.thumbnail.state === 'selected' ? previewed.thumbnail.filename || '' : ''"
          :sources="previewed.thumbnail.options"
          @close="textEditorOpen = false"
          @applied="onTextApplied"
          @pinned="onTextApplied"
        />

        <dl class="payload">
          <div v-if="previewed.source"><dt>Video file</dt><dd><strong>{{ previewed.source.filename }}</strong><small>Story Studio will stop if this file changes before queueing.</small></dd></div>
          <div class="payload-editable">
            <dt>Title</dt>
            <dd>
              <input
                v-model="draftTitle" type="text" class="edit-input"
                :maxlength="draftTitleLimit || undefined"
                :disabled="busy !== '' || !canEditMetadata"
                aria-label="YouTube title"
              />
              <small v-if="draftTitleInvalid" class="field-error" role="alert">
                {{ !draftTitle.trim()
                  ? 'A title is required.'
                  : `${draftTitle.length}/${draftTitleLimit} characters — YouTube allows at most ${draftTitleLimit}.` }}
              </small>
              <small v-else-if="draftTitleLimit" class="field-counter">{{ draftTitle.length }}/{{ draftTitleLimit }}</small>
            </dd>
          </div>
          <div class="payload-editable">
            <dt>Description</dt>
            <dd>
              <textarea
                v-model="draftDescription" class="edit-textarea pre" rows="6"
                :disabled="busy !== '' || !canEditMetadata"
                aria-label="YouTube description"
              ></textarea>
              <small v-if="draftDescriptionInvalid" class="field-error" role="alert">
                {{ draftDescriptionBytes.toLocaleString() }}/{{ draftDescriptionLimit.toLocaleString() }} bytes —
                over Story Studio's {{ draftDescriptionLimit.toLocaleString() }}-byte working limit for this description
                (YouTube itself allows up to {{ draftDescriptionYouTubeLimit.toLocaleString() }} bytes);
                shorten the description.
              </small>
              <small v-else-if="draftDescriptionLimit" class="field-counter">
                {{ draftDescriptionBytes.toLocaleString() }}/{{ draftDescriptionLimit.toLocaleString() }} bytes
              </small>
              <small v-if="draftDescription === '' && draftSaved" class="field-counter">
                The description is empty and will be sent empty. Clearing it does not bring the generated text back.
              </small>
              <!--
                The generated description is offered as a CHOICE, not imposed.
                The owner may want the script's text back, and only the owner can
                decide that — so the control appears only when the description
                on screen is one they (or a saved edit) put there.

                It also appears only when the metadata can be edited. The
                restore IS a save (it posts an explicit reset), and a save is
                refused for an already-published episode and for a schedule
                review — so offering the control there would be a button that
                does nothing.
              -->
              <button
                v-if="previewed.authored?.description && canEditMetadata"
                class="btn btn-sm draft-restore" type="button"
                :disabled="busy !== ''"
                @click="restoreGeneratedDescription"
              >
                {{ busy?.startsWith('save-draft-') ? 'Saving…' : 'Restore the generated description' }}
              </button>
            </dd>
          </div>
          <div><dt>Tags</dt><dd>{{ (previewed.snippet.tags || []).join(', ') || 'none' }}</dd></div>
          <div><dt>Category</dt><dd>{{ previewed.snippet.categoryId }}</dd></div>
          <div><dt>Privacy</dt><dd>{{ previewed.status.privacyStatus }}</dd></div>
          <div v-if="previewed.status.publishAt">
            <dt>Scheduled for</dt>
            <dd><strong>{{ formatZonedWhen(previewed.status.publishAt, timingTimezone) }}</strong><small>{{ previewed.status.publishAt }}</small></dd>
          </div>
          <div><dt>Marked as AI-generated</dt><dd>{{ previewed.status.containsSyntheticMedia ? 'yes' : 'no' }}</dd></div>
        </dl>
        <div v-if="canEditMetadata" class="draft-actions">
          <button
            class="btn btn-sm" type="button"
            :disabled="busy !== '' || draftSaved || draftTitleInvalid || draftDescriptionInvalid"
            @click="saveDraft"
          >
            {{ busy?.startsWith('save-draft-') ? 'Saving…' : 'Save Changes' }}
          </button>
          <!--
            Three different states, three different sentences. A panel that
            opens by saying "Edits saved" claims an edit nobody made, so the
            opening state says what it is: the payload as it arrived.
          -->
          <span v-if="!draftError && !draftSaved" class="hint tone-warn">Unsaved edits — save before uploading.</span>
          <span v-else-if="!draftError && draftEverSaved" class="hint">Edits saved. The payload above reflects what YouTube will receive.</span>
          <span v-else-if="!draftError" class="hint">This is what YouTube will receive. Change the title or description above, then save.</span>
          <!--
            The corrected text the server would send instead of what was typed.
            It is shown, not swallowed: a refusal that says "this would change"
            and shows nothing leaves the owner to guess what to write instead.
          -->
          <div v-if="draftSuggestion" class="draft-suggestion" role="status">
            <p class="hint">YouTube would show this instead:</p>
            <pre v-if="draftSuggestion.title" class="pre">{{ draftSuggestion.title }}</pre>
            <pre v-if="draftSuggestion.description" class="pre">{{ draftSuggestion.description }}</pre>
            <button class="btn btn-sm" type="button" @click="applySuggestion">Use this text</button>
          </div>
          <p v-if="draftError" class="row-result err draft-error" role="alert">{{ draftError }}</p>
        </div>
        <p v-else-if="reviewIntent === 'schedule'" class="hint">
          This video is already on YouTube. Scheduling changes its publish date — not its title or description.
        </p>
        <p v-else class="hint">This video is already on YouTube. Title and description cannot be edited here.</p>

          </div>
          <footer class="review-foot">
        <!--
          The Upload control sits UNDER the exact payload, because that is the
          thing being agreed to. It appears only when a channel is connected;
          otherwise the reason is on screen instead of a button that refuses.
        -->
        <!--
          `remoteBlocked`, not the raw `channelStatus`. The first version tested
          the enum for truthiness, so a HEALTHY project ('connected') took the
          blocked branch: the button never appeared for anyone who could use it,
          and the word "connected" was printed at the owner as if it were a
          sentence. `remoteBlocked` is empty when the channel is usable and
          carries owner-facing copy when it is not.
        -->
        <div v-if="reviewIntent === 'schedule' && scheduleBlocked" class="hint">{{ scheduleBlocked }}</div>
        <div v-else-if="reviewIntent !== 'schedule' && uploadBlocked" class="hint">{{ uploadBlocked }}</div>
        <!--
          The page must refuse where the route refuses. Uploading an episode
          that is already on YouTube returns 409 ALREADY_IN_FLIGHT, so offering
          the button here would be an invitation to a guaranteed error - and
          YouTube has no replace, so the owner would reasonably read the button
          as a way to correct something.
        -->
        <div v-else-if="alreadyPublished && reviewIntent !== 'schedule'" class="hint">{{ alreadyPublished }}</div>
        <div v-else-if="previewedQueued && reviewIntent !== 'schedule'" class="hint" role="status">Upload queued for {{ previewedEpisode }}. Progress appears in Jobs; closing this review does not stop it.</div>
        <div v-else-if="timingDirty" class="hint">Review the selected timing above before continuing.</div>
        <div v-else-if="reviewIntent === 'schedule' && !previewed.status.publishAt" class="hint">Choose a future planned or custom date to schedule this private video.</div>
        <div v-else-if="reviewIntent === 'schedule'" class="field-row upload-row">
          <button class="btn btn-primary" type="button" :disabled="busy !== ''" @click="scheduleExisting">
            {{ busy === 'schedule' ? 'Scheduling…' : 'Schedule on YouTube' }}
          </button>
          <span class="hint">Updates the existing video after YouTube confirms it is private. It does not upload the video again.</span>
        </div>
        <div v-else-if="thumbnailRequired && (previewed.thumbnail.state !== 'selected' || thumbnailImageUnavailable)" class="hint">
          A thumbnail is required. Choose an available thumbnail before uploading.
        </div>
        <div v-else-if="!previewed.source?.revision" class="hint">Refresh this review so Story Studio can verify the exact video file before uploading.</div>
        <div v-else class="field-row upload-row">
          <!--
            The button stays on screen when the edits are unsaved or invalid:
            it is REFUSED, and the reason is beside it. A button that appears
            and disappears while the owner is typing is a worse answer than a
            disabled one with the reason next to it.
          -->
          <button
            class="btn btn-primary" type="button"
            :disabled="busy !== '' || !draftSaved || draftTitleInvalid || draftDescriptionInvalid"
            @click="upload(previewedEpisode)"
          >
            {{ busy === 'upload' ? 'Uploading…' : 'Upload to YouTube' }}
          </button>
          <span v-if="draftTitleInvalid || draftDescriptionInvalid" class="hint">Fix the title or description above before uploading.</span>
          <span v-else-if="!draftSaved" class="hint">Save your title and description changes before uploading.</span>
          <span v-else class="hint">Uploads {{ previewedEpisode }} to the assigned YouTube channel.</span>
        </div>

        <!--
          Facebook / Instagram / TikTok — strictly OPT-IN. The channel's saved
          choices pre-tick these boxes; nothing is posted unless a box is
          ticked HERE, on this upload. The YouTube upload above is unaffected
          either way, which is why this sits beside it rather than inside it.
        -->
        <section v-if="socialPlatforms.length && !alreadyPublished && reviewIntent !== 'schedule'" class="social-publish" aria-labelledby="social-publish-title">
          <div>
            <p class="section-kicker">Also post to</p>
            <h3 id="social-publish-title">Facebook, Instagram and TikTok</h3>
            <p class="hint">
              Nothing posts unless you tick it. These are separate posts with their own captions; the YouTube upload above happens either way.
            </p>
          </div>
          <ul class="social-platform-list">
            <li v-for="platform in socialPlatforms" :key="platform.platform" class="social-platform-row">
              <label class="social-platform-choice">
                <input
                  type="checkbox" :checked="socialChosen.includes(platform.platform)"
                  :disabled="busy !== '' || !socialReady[platform.platform]"
                  @change="toggleSocialPlatform(platform.platform)"
                />
                <span>
                  <strong>{{ platform.label }}</strong>
                  <small v-if="socialReady[platform.platform]">{{ socialReady[platform.platform] }}</small>
                  <small v-else class="tone-warn">No account connected. <NuxtLink :to="`/projects/${slug}/settings#connections`" class="inline-action">Connect one</NuxtLink></small>
                </span>
              </label>
            </li>
          </ul>
          <p v-if="socialChosen.length && socialNote" class="hint" role="status">{{ socialNote }}</p>
          <p v-if="socialChosen.length && socialState?.receipts.length" class="hint">
            Already posted:
            <span v-for="receipt in socialState.receipts" :key="receipt.platform" class="social-receipt">
              {{ platformLabelFor(receipt.platform) }}
              <a v-if="receipt.permalink" :href="receipt.permalink" target="_blank" rel="noopener noreferrer">{{ receipt.post_id }}</a>
              <code v-else>{{ receipt.post_id }}</code>
            </span>
          </p>
        </section>
        <p v-if="rowResults[previewedEpisode]" :class="['row-result', rowResults[previewedEpisode].kind]" role="status">
          {{ rowResults[previewedEpisode].message }}
        </p>
          </footer>
      </section>
        <section v-else class="upload-review is-loading" aria-busy="true">
          <header class="review-head">
            <div>
              <h2 id="upload-review-title" ref="previewHeading" tabindex="-1">What YouTube will receive</h2>
              <p>{{ previewedEpisode }} · building the exact metadata and checking the video file…</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="closeReview()">Close</button>
          </header>
          <div class="review-body">
            <p class="hint review-loading" role="status">Preparing this upload review. A large video takes a moment to verify.</p>
          </div>
        </section>
      </Modal>

      <Modal :visible="relayoutOpen" size="lg" labelledby="relayout-title" dialog-class="modal-flush" @close="closeRelayout">
        <section class="relayout-review">
          <header class="review-head">
            <div>
              <h2 id="relayout-title" ref="relayoutHeading" tabindex="-1">Edit planned dates</h2>
              <p>{{ selectedUploadEpisodes.length }} selected · re-laid from a start date on the active plan's cadence</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="closeRelayout">Close</button>
          </header>

          <div class="review-body">
            <p class="hint">
              This changes Story Studio's <strong>planned</strong> dates only. YouTube is not edited here,
              so a video that already exists on the channel keeps its real publish time and is listed below as skipped.
            </p>

            <div class="field-row relayout-start">
              <label for="relayout-start-date">Start from</label>
              <input
                id="relayout-start-date" v-model="relayoutStartDate" type="date"
                :disabled="busy !== ''"
              />
              <button
                class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== '' || !relayoutStartDate"
                @click="previewRelayout()"
              >
                {{ busy === 'relayout-preview' ? 'Checking…' : 'Preview Dates' }}
              </button>
            </div>

            <p v-if="relayoutError" class="row-result err" role="alert">
              {{ relayoutError }}
              <NuxtLink v-if="isNoActivePlanMessage(relayoutError)" :to="`/projects/${slug}/upload/plans`" class="inline-action">Open Upload Plans</NuxtLink>
            </p>

            <template v-if="relayoutPreview">
              <p v-if="!relayoutPreview.assignments.length" class="hint" role="status">
                Nothing selected can be re-dated. Every selected video is either already on YouTube or has an upload in progress.
              </p>
              <table v-else class="relayout-table">
                <caption class="relayout-caption">
                  Proposed dates on {{ relayoutPlanName || 'the active plan' }}
                  <span v-if="relayoutPreview.timezone"> · times shown in {{ relayoutPreview.timezone }}</span>
                </caption>
                <thead>
                  <tr><th scope="col">Episode</th><th scope="col">Planned now</th><th scope="col">Proposed</th></tr>
                </thead>
                <tbody>
                  <tr v-for="assignment in relayoutPreview.assignments" :key="assignment.episode_code">
                    <td><strong>{{ assignment.episode_code }}</strong></td>
                    <td>{{ assignment.previous_publish_at ? formatZonedWhen(assignment.previous_publish_at, relayoutPreview.timezone) : 'Not planned' }}</td>
                    <td><strong>{{ formatZonedWhen(assignment.publishAt, relayoutPreview.timezone) }}</strong></td>
                  </tr>
                </tbody>
              </table>

              <p v-if="relayoutPreview.occupied_days.length" class="hint">
                {{ relayoutPreview.occupied_days.length }} day{{ relayoutPreview.occupied_days.length === 1 ? '' : 's' }}
                already held by other episodes {{ relayoutPreview.occupied_days.length === 1 ? 'was' : 'were' }} stepped over,
                so no two videos share a date. The list above already accounts for that.
              </p>

              <div v-if="relayoutPreview.skipped.length" class="relayout-skipped">
                <h3>Left unchanged ({{ relayoutPreview.skipped.length }})</h3>
                <ul>
                  <li v-for="skip in relayoutPreview.skipped" :key="skip.episode_code">{{ skip.reason }}</li>
                </ul>
              </div>

              <div v-if="relayoutPreview.assignments.length" class="field-row upload-row">
                <button class="btn btn-primary" type="button" :disabled="busy !== ''" @click="applyRelayout()">
                  {{ busy === 'relayout-apply' ? 'Saving…' : `Save ${relayoutPreview.assignments.length} Planned Date${relayoutPreview.assignments.length === 1 ? '' : 's'}` }}
                </button>
              </div>
            </template>
          </div>
        </section>
      </Modal>

      <Modal :visible="bulkScheduleOpen" size="lg" labelledby="bulk-schedule-title" dialog-class="modal-flush" @close="bulkScheduleOpen = false">
        <section class="relayout-review">
          <header class="review-head">
            <div>
              <h2 id="bulk-schedule-title" tabindex="-1">Schedule {{ scheduleRows.length }} video{{ scheduleRows.length === 1 ? '' : 's' }} on YouTube</h2>
              <p>Changes YouTube · each video stays private until its time, then YouTube makes it public</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="bulkScheduleOpen = false">Close</button>
          </header>
          <div class="review-body">
            <p class="hint">
              Only uploaded private videos without a publish time are included, in episode order.
              Times are in this computer’s time zone ({{ deviceTimezone }}). Nothing else about the videos changes.
            </p>
            <div class="schedule-fields">
              <label for="bulk-schedule-first">First video goes public
                <input id="bulk-schedule-first" v-model="bulkScheduleFirst" class="input" type="datetime-local" :min="bulkScheduleMin" />
              </label>
              <label for="bulk-schedule-every">then one every
                <span class="every-row">
                  <input id="bulk-schedule-every" v-model.number="bulkScheduleEvery" class="input every-input" type="number" min="1" max="30" step="1" />
                  day{{ bulkScheduleEvery === 1 ? '' : 's' }}
                </span>
              </label>
            </div>
            <p v-if="bulkScheduleError" class="row-result err" role="alert">{{ bulkScheduleError }}</p>
            <table v-else-if="bulkSchedulePlan.length" class="relayout-table">
              <caption class="relayout-caption">Publish times YouTube will receive</caption>
              <thead><tr><th scope="col">Episode</th><th scope="col">Goes public</th></tr></thead>
              <tbody>
                <tr v-for="item in bulkSchedulePlan" :key="item.episode_code">
                  <td><strong>{{ item.episode_code }}</strong></td>
                  <td>{{ formatZonedWhen(item.publish_at) }}</td>
                </tr>
              </tbody>
            </table>
            <div class="field-row upload-row">
              <button class="btn btn-primary" type="button" :disabled="busy !== '' || !!bulkScheduleError || !bulkSchedulePlan.length" @click="confirmBulkSchedule">
                Schedule {{ bulkSchedulePlan.length }} Video{{ bulkSchedulePlan.length === 1 ? '' : 's' }} on YouTube
              </button>
            </div>
          </div>
        </section>
      </Modal>

      <Modal :visible="bulkVisibilityOpen" size="md" labelledby="bulk-visibility-title" dialog-class="modal-flush" @close="bulkVisibilityOpen = false">
        <section class="relayout-review">
          <header class="review-head">
            <div>
              <h2 id="bulk-visibility-title" tabindex="-1">Set visibility for {{ visibilityRows.length }} video{{ visibilityRows.length === 1 ? '' : 's' }}</h2>
              <p>Changes YouTube · {{ visibilityRows.map(ep => ep.episode_code).join(', ') }}</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="bulkVisibilityOpen = false">Close</button>
          </header>
          <div class="review-body">
            <fieldset class="visibility-choices">
              <legend>Make them</legend>
              <label v-for="choice in VISIBILITY_CHOICES" :key="choice.value" class="visibility-choice">
                <input v-model="bulkVisibility" type="radio" name="bulk-visibility" :value="choice.value" />
                <span><strong>{{ choice.label }}</strong><small>{{ choice.hint }}</small></span>
              </label>
            </fieldset>
            <p class="hint">Any scheduled publish time on these videos is cleared. Titles, descriptions and thumbnails are not changed.</p>
            <div class="field-row upload-row">
              <button class="btn btn-primary" type="button" :disabled="busy !== '' || !bulkVisibility" @click="confirmBulkVisibility">
                {{ bulkVisibility ? `Make ${visibilityRows.length} Video${visibilityRows.length === 1 ? '' : 's'} ${visibilityLabel(bulkVisibility)} on YouTube` : 'Choose a Visibility' }}
              </button>
            </div>
          </div>
        </section>
      </Modal>

      <Modal :visible="bulkReviewOpen" size="lg" labelledby="bulk-upload-review-title" dialog-class="modal-flush" @close="closeBulkReview">
        <section class="bulk-upload-review">
          <header class="review-head">
            <div>
              <h2 id="bulk-upload-review-title" ref="bulkReviewHeading" tabindex="-1">Review selected uploads</h2>
              <p>{{ bulkReviews.length }} selected · each video keeps its own exact file, thumbnail, metadata, and timing</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="closeBulkReview">Close</button>
          </header>

          <p v-if="busy === 'bulk-preview'" class="hint" role="status">Reviewing each selected upload…</p>
          <ul class="bulk-review-list">
            <li v-for="item in bulkReviews" :key="item.episode_code" class="bulk-review-item">
              <header>
                <div>
                  <strong>{{ item.episode_code }}</strong>
                  <span>{{ item.title }}</span>
                </div>
                <span :class="['state-text', item.state === 'queued' || item.state === 'reviewed' ? 'tone-success' : item.state === 'error' ? 'tone-danger' : 'tone-info']">
                  {{ bulkReviewStateLabel(item) }}
                </span>
              </header>
              <p v-if="item.error" class="row-result err" role="alert">{{ item.error }}</p>
              <template v-if="item.preview">
                <div class="bulk-review-details">
                  <div class="bulk-thumbnail">
                    <img
                      v-if="item.preview.thumbnail.state === 'selected' && item.preview.thumbnail.url"
                      :src="item.preview.thumbnail.url" :alt="`Thumbnail selected for ${item.episode_code}`"
                      @load="bulkThumbnailLoaded(item)" @error="bulkThumbnailUnavailable(item)"
                    />
                    <span v-else>{{ item.preview.thumbnail.state === 'none' ? 'No thumbnail selected' : 'Thumbnail unavailable' }}</span>
                    <small>{{ item.preview.thumbnail.filename || 'No thumbnail' }}</small>
                  </div>
                  <dl>
                    <div><dt>Video file</dt><dd>{{ item.preview.source?.filename || 'Unavailable' }}</dd></div>
                    <div><dt>YouTube title</dt><dd><strong>{{ item.preview.snippet.title }}</strong><small :class="{ 'tone-warn': item.preview.warnings.length > 0 }">{{ metadataReadiness(item.preview) }}</small></dd></div>
                    <div><dt>Channel</dt><dd>{{ item.channel_title }} · {{ item.channel_id }}</dd></div>
                    <div><dt>Publishing</dt><dd>{{ bulkTimingLabel(item) }}<small v-if="item.preview.status.publishAt">{{ item.preview.status.publishAt }}</small></dd></div>
                  </dl>
                </div>
                <UploadMetadataChecklist :items="item.preview.checklist" />
                <details class="bulk-metadata disclosure">
                  <summary>Review Metadata</summary>
                  <dl>
                    <div><dt>Title</dt><dd>{{ item.preview.snippet.title }}</dd></div>
                    <div><dt>Description</dt><dd class="pre">{{ item.preview.snippet.description || 'none' }}</dd></div>
                    <div><dt>Tags</dt><dd>{{ (item.preview.snippet.tags || []).join(', ') || 'none' }}</dd></div>
                  </dl>
                </details>
                <ul v-if="item.preview.warnings.length" class="warnings">
                  <li v-for="(warning, index) in item.preview.warnings" :key="index"><b>Warning:</b> {{ warning }}</li>
                </ul>
              </template>
            </li>
          </ul>

          <div class="bulk-review-footer">
            <p class="hint">Files and metadata are checked again before queueing. Refused rows stay here and are not retried automatically. Closing this review does not stop queueing.</p>
            <p v-if="bulkQueueWasStopped" class="result warn" role="status">Queueing stopped. Already queued uploads continue; the remaining Reviewed rows can be queued when you are ready.</p>
            <button
              v-if="busy === 'bulk-upload'" class="btn btn-ghost" type="button"
              :disabled="bulkQueueStopRequested" @click="bulkQueueStopRequested = true"
            >{{ bulkQueueStopRequested ? 'Stopping After Current…' : 'Stop Queueing' }}</button>
            <button
              v-else
              class="btn btn-primary" type="button"
              :disabled="busy !== '' || !queueableBulkReviews.length"
              @click="queueReviewedUploads"
            >
              {{ busy === 'bulk-upload' ? 'Queueing…' : `Queue Reviewed Uploads (${queueableBulkReviews.length})` }}
            </button>
          </div>
        </section>
      </Modal>

      <Modal :visible="!!videoEpisode" size="lg" labelledby="local-video-title" @close="closeVideo">
        <section v-if="videoEpisode" class="video-review">
          <header class="review-head">
            <div>
              <h2 id="local-video-title">Local video</h2>
              <p>{{ videoEpisode.episode_code }} · {{ videoEpisode.title }}</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="closeVideo">Close</button>
          </header>
          <video
            :src="playableVideoUrl(videoEpisode)" controls preload="metadata"
            @loadedmetadata="videoError = ''"
            @error="videoError = 'Story Studio could not play this local video. Refresh the list, or open Video Assembly to check the render.'"
          >This video cannot play in your browser.</video>
          <p v-if="videoError" class="row-result err" role="alert">{{ videoError }}</p>
          <NuxtLink v-if="videoError" class="inline-action" :to="videoAssemblyLink(videoEpisode)">Open Video Assembly</NuxtLink>
          <p class="hint">This is the final video stored by Story Studio. Reviewing upload details is a separate YouTube metadata check.</p>
        </section>
      </Modal>
    </template>
  </div>
</template>

<script setup lang="ts">
import { applyRowSelection, spreadPublishTimes } from '~/utils/upload-bulk'
import { secureOperationId } from '~/composables/useFreshGenerationAction'
import { PUBLISH_PAGE, finalChecksRunning, readPublishView, writePublishView, type PublishSort, type PublishStatus } from '~/utils/publish-view'
import { sameQuery } from '~/utils/route-query-state'
import { thumbnailTextEnabled as thumbnailTextEnabledFor } from '~/utils/thumbnail-text'

interface Channel { channel_id: string; title: string; status: string }

interface Operation {
  operation_id: string
  episode_code: string
  lifecycle: string
  video_id?: string
  processing?: { checked_at: string; provider_status?: string; failure_reason?: string; rejection_reason?: string }
}
type RenderState = 'ready' | 'missing' | 'unknown'
type UploadState = 'none' | 'queued' | 'running' | 'failed' | 'succeeded' | 'unknown'
type PublicationState = 'unpublished' | 'uploaded' | 'processing' | 'published' | 'scheduled' | 'failed' | 'rejected' | 'unknown'
type StatusFilter = PublishStatus
type SortMode = PublishSort
type ReviewIntent = 'upload' | 'schedule'
type TimingMode = 'planned' | 'custom' | 'private'

interface UploadProgress {
  progress?: number
  bytes_done?: number
  bytes_total?: number
  speed_bps?: number
  eta_seconds?: number
}

interface PublishableEpisode {
  episode_code: string
  title: string
  has_video?: boolean
  /** Why this episode cannot be uploaded, decided by the route. Absent = it can. */
  blocked_reason?: string
  auto_schedule_hold?: { status: string; reason: string } | null
  /** The final check's stored verdict, read from beside the rendered file it describes. */
  final_check?: {
    summary: string
    passed: boolean
    checked: boolean
    stale: boolean
    /** True while a check is measuring this file in the background. */
    running: boolean
    issues: Array<{ check: string; verdict: string }>
    /** Which check this row is showing; `checked_at` is what an acknowledgement answers about. */
    identity?: { checked_at: string; file_size: number; file_mtime_ms: number } | null
  }
  /** Already on YouTube — from the operation record OR a legacy sidecar. */
  has_remote_video?: boolean
  remote_video_id?: string
  remote_source?: 'operation_record' | 'reconcile_link' | 'legacy_sidecar'
  can_schedule_existing?: boolean
  schedule_blocked_reason?: string
  operation?: Operation
  local?: {
    render: { state: RenderState; video_url?: string }
    upload: { state: UploadState; job_id?: string; reason?: string } & UploadProgress
  }
  publication?: {
    state: PublicationState
    visibility?: string
    published_at?: string
    scheduled_at?: string
    last_checked_at?: string
    reason?: string
  }
  plan?: { scheduled_at?: string; timezone?: string }
}
interface Preview {
  package_revision?: string
  source_sha256?: string
  source?: { filename: string; revision: string } | null
  snippet: { title: string; description?: string; tags?: string[]; categoryId?: string }
  status: { privacyStatus: string; publishAt?: string; containsSyntheticMedia?: boolean }
  video_id?: string | null
  modifications: Array<{ field: string; reason: string }>
  warnings: string[]
  checklist?: Array<{ field: string; label: string; state: 'present' | 'missing' | 'not_checked'; detail?: string }>
  /**
   * What the editor may accept, published by the server that owns the
   * limits. The page does not keep its own copy of these numbers: a second
   * copy is a second answer to the same question, and the two answers drift.
   */
  limits?: {
    title_max_characters?: number
    description_max_bytes?: number
    /** YouTube's own published limit, which is larger than the cap above. */
    description_max_bytes_youtube?: number
  }
  /**
   * Which fields are the OWNER's own text rather than the generated one.
   * Published by the server, because the server is what knows whether the
   * sidecar supplied the text — the page cannot tell an empty description the
   * owner typed from a generated one that happens to be empty.
   */
  authored?: { title?: boolean; description?: boolean }
  thumbnail: {
    state: 'selected' | 'none' | 'unavailable'
    filename?: string
    url?: string
    reason?: string
    options: Array<{ filename: string; url: string; is_pinned?: boolean }>
  }
}
type BulkReviewState = 'pending' | 'reviewed' | 'queueing' | 'queued' | 'error'
interface BulkUploadReview {
  episode_code: string
  title: string
  channel_id: string
  channel_title: string
  timezone: string
  state: BulkReviewState
  preview?: Preview
  error?: string
  job_id?: string
}

function normalizePreview(value: Preview): Preview {
  return {
    ...value,
    thumbnail: value.thumbnail || { state: 'none', options: [] },
  }
}

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { config } = useProject()

// ── Facebook / Instagram / TikTok — strictly opt-in ─────────────────────────
//
// The channel's saved platforms PRE-TICK these boxes; they never post by
// themselves. `socialChosen` is the only thing that decides, and it is reset
// every time the review opens, so an earlier upload's ticks cannot leak into
// this one (AGENTS §4: an episode change replaces the field or blanks it).
interface SocialPlatformEntry { platform: 'facebook' | 'instagram' | 'tiktok'; label: string }
const socialPlatforms = ref<SocialPlatformEntry[]>([])
const socialReady = ref<Record<string, string>>({})
const socialChosen = ref<Array<SocialPlatformEntry['platform']>>([])
const socialNote = ref('')
const socialState = ref<{ receipts: Array<{ platform: string; post_id: string; permalink?: string }> } | null>(null)

function platformLabelFor(platform: string): string {
  return socialPlatforms.value.find(entry => entry.platform === platform)?.label || platform
}

function toggleSocialPlatform(platform: SocialPlatformEntry['platform']): void {
  socialChosen.value = socialChosen.value.includes(platform)
    ? socialChosen.value.filter(entry => entry !== platform)
    : [...socialChosen.value, platform]
  socialNote.value = socialChosen.value.length
    ? `Will also post to ${socialChosen.value.map(platformLabelFor).join(', ')}.`
    : ''
}

/**
 * Load this channel's connected social accounts and saved platform choice.
 * Runs once per page load; a failure leaves the section empty rather than
 * offering a tick box that cannot post.
 */
async function loadSocialChoices(): Promise<void> {
  try {
    const [connections, settings] = await Promise.all([
      get<{ accounts: Array<{ platform: string; remote_name: string; status: string }>; platforms: SocialPlatformEntry[] }>('/social/connections'),
      get<{ platforms: Array<SocialPlatformEntry['platform']> }>(`/projects/${slug.value}/social/settings`),
    ])
    socialPlatforms.value = connections.platforms
    const ready: Record<string, string> = {}
    for (const account of connections.accounts) {
      if (account.status === 'connected') ready[account.platform] = account.remote_name
    }
    socialReady.value = ready
    // Only platforms this channel actually has an account for are pre-ticked:
    // a saved choice for a disconnected platform would be a tick box that
    // cannot post.
    socialChosen.value = settings.platforms.filter(platform => !!ready[platform])
  } catch {
    socialPlatforms.value = []
    socialReady.value = {}
    socialChosen.value = []
  }
}

async function loadSocialState(episodeCode: string): Promise<void> {
  socialState.value = null
  try {
    socialState.value = await get<{ receipts: Array<{ platform: string; post_id: string; permalink?: string }> }>(
      `/projects/${slug.value}/social/episodes/${encodeURIComponent(episodeCode)}`,
    )
  } catch {
    socialState.value = null
  }
}

/**
 * Post this episode to the ticked platforms. Deliberately NOT part of the
 * YouTube upload: a social failure must never make the YouTube upload look
 * failed, and vice versa.
 */
async function postToSocial(episodeCode: string): Promise<void> {
  if (!socialChosen.value.length) return
  try {
    const result = await post<{ job_id: string; platforms: string[] }>(
      `/projects/${slug.value}/social/episodes/${encodeURIComponent(episodeCode)}/publish`,
      { platforms: socialChosen.value },
    )
    rowResults[episodeCode] = {
      kind: 'ok',
      message: `Posting to ${result.platforms.map(platformLabelFor).join(', ')}. Progress appears in Jobs.`,
    }
    void loadSocialState(episodeCode)
  } catch (error: any) {
    rowResults[episodeCode] = {
      kind: 'err',
      message: error?.data?.detail || error?.message || 'Could not start posting to Facebook, Instagram or TikTok.',
    }
  }
}
/** This channel's thumbnail text layer switch (default false). The backend
 *  refuses the endpoints too — this only decides whether to show the button. */
const thumbnailTextEnabled = computed(() => thumbnailTextEnabledFor(config.value))
const textEditorOpen = ref(false)
function openTextEditor() {
  if (!thumbnailTextEnabled.value || !previewedEpisode.value || !previewed.value) return
  if (previewed.value.thumbnail.state !== 'selected' || !previewed.value.thumbnail.filename) return
  textEditorOpen.value = true
}
/** A written variant can become the pin, so rebuild the payload the customer
 *  is about to queue rather than trusting the editor's own report. */
async function onTextApplied() {
  const code = previewedEpisode.value
  if (!code) return
  await preview(code, undefined, reviewIntent.value)
}
/** 1.4.301 — the channel's "Thumbnail present" safety check: only Block (the default) requires one here. */
const thumbnailRequired = ref(true)
watch(slug, async value => {
  thumbnailRequired.value = true
  const data = await get<{ checks: Array<{ id: string; mode: string }> }>(`/projects/${value}/safety-checks`).catch(() => null)
  const mode = data?.checks.find(check => check.id === 'thumbnail_present')?.mode
  if (value === slug.value) thumbnailRequired.value = mode !== 'off' && mode !== 'warn'
}, { immediate: true })
const { ask } = useConfirm()
const { jobs, jobsStale } = useJobs()

const loading = ref(true)
const loadError = ref('')
const busy = ref('')
const episodes = ref<PublishableEpisode[]>([])
const total = ref(0)
// Search, status, sort and shown rows live in the URL (keep place; Overview's
// "Needs you" links open a filtered view).
const initialView = readPublishView(route.query)
const filter = ref(initialView.q)
const statusFilter = ref<StatusFilter>(initialView.status)
const sort = ref<SortMode>(initialView.sort)
const shownCount = ref(initialView.shown)
const rowResults = reactive<Record<string, { kind: 'ok' | 'warn' | 'info' | 'err'; message: string }>>({})
const planResult = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)
const selectedCodes = ref<string[]>([])
const bulkReviewOpen = ref(false)
const bulkReviewHeading = ref<HTMLElement | null>(null)
const bulkReviewOpener = ref<HTMLElement | null>(null)
const uploadListHeading = ref<HTMLElement | null>(null)
const bulkReviews = ref<BulkUploadReview[]>([])
const bulkQueueStopRequested = ref(false)
const bulkQueueWasStopped = ref(false)
/** The bulk dialog was dismissed while its queue loop was still running. */
const bulkReviewDismissedWhileQueueing = ref(false)
/**
 * Episodes this page has queued and not yet seen back from the server. The
 * button is withheld for them until the reloaded list carries the running
 * upload, so a click during a slow reload cannot submit the same episode twice.
 */
const queuedUploadCodes = reactive(new Set<string>())
let loadRevision = 0
let actionRevision = 0

/** Search and status filters never mutate or cap the server's complete list. */
const visibleEpisodes = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  return episodes.value.filter(ep => {
    const searchMatch = !needle || ep.episode_code.toLowerCase().includes(needle)
      || (ep.title || '').toLowerCase().includes(needle)
    return searchMatch && matchesStatus(ep, statusFilter.value)
  })
})
const sortedEpisodes = computed(() => {
  const rows = [...visibleEpisodes.value]
  const direction = sort.value === 'episode_oldest' ? 1 : -1
  if (sort.value === 'episode_newest' || sort.value === 'episode_oldest') {
    return rows.sort((a, b) => direction * (episodeNumber(a) - episodeNumber(b)))
  }
  if (sort.value === 'schedule_soonest') {
    return rows.sort((a, b) => scheduleTime(a) - scheduleTime(b) || episodeNumber(b) - episodeNumber(a))
  }
  return rows.sort((a, b) => publicationLabel(a).localeCompare(publicationLabel(b)) || episodeNumber(b) - episodeNumber(a))
})
/** Rendered rows. Selection and bulk actions still use every matching row. */
const shownEpisodes = computed(() => sortedEpisodes.value.slice(0, shownCount.value))
watch([filter, statusFilter, sort], () => { shownCount.value = PUBLISH_PAGE })
watch([filter, statusFilter, sort, shownCount], () => {
  const query = writePublishView(route.query, { q: filter.value, status: statusFilter.value, sort: sort.value, shown: shownCount.value })
  // Only while this page is the current route: a late watcher must not rewrite the next page's URL.
  if (router.currentRoute.value.path === route.path && !sameQuery(query, route.query)) void router.replace({ query, hash: route.hash })
})
const statusOptions = computed(() => ([
  { key: 'all' as const, label: 'All', count: episodes.value.length },
  { key: 'ready' as const, label: 'Ready to upload', count: countStatus('ready') },
  { key: 'missing' as const, label: 'Missing video', count: countStatus('missing') },
  { key: 'in_progress' as const, label: 'In progress', count: countStatus('in_progress') },
  { key: 'planned' as const, label: 'Planned', count: countStatus('planned') },
  { key: 'missed' as const, label: 'Missed plans', count: countStatus('missed') },
  { key: 'uploaded' as const, label: 'Uploaded', count: countStatus('uploaded') },
  { key: 'scheduled' as const, label: 'Scheduled', count: countStatus('scheduled') },
  { key: 'published' as const, label: 'Published', count: countStatus('published') },
  { key: 'attention' as const, label: 'Needs attention', count: countStatus('attention') },
]))
const previewed = ref<Preview | null>(null)
const channelStatus = ref('')
const assignedChannel = ref<Channel | null>(null)
const quotaExhausted = ref(false)
const uploadQuotaExhausted = ref(false)
const quotaUnavailableReason = ref('')
const previewedEpisode = ref('')
// The text editor belongs to the episode whose review is open. Switching
// reviews (or closing one) replaces the editor's own state, and the editor
// itself blanks the headline/source/variants it was holding — never carries
// one episode's headline into another (AGENTS §4).
watch(previewedEpisode, () => { textEditorOpen.value = false })
const previewHeading = ref<HTMLElement | null>(null)
const reviewOpener = ref<HTMLElement | null>(null)
const thumbnailImageUnavailable = ref(false)
const thumbnailError = ref('')
const draftTitle = ref('')
const draftDescription = ref('')
/** True while the fields hold exactly the payload the server last returned. */
const draftSaved = ref(true)
/**
 * Whether this review has EVER been saved.
 *
 * Without it the panel opens saying "Edits saved" — a claim about an edit
 * nobody made. The opening state is not a saved state: it is the payload as
 * it arrived. The distinction matters because the same word is used for two
 * different promises, and only one of them is true at the start.
 */
const draftEverSaved = ref(false)
const draftError = ref('')
/**
 * The text the server would send instead, when it refused the text that was
 * typed. Held so the corrected text can be put in front of the owner rather
 * than dropped: a refusal that says "this would change" and shows nothing is
 * a puzzle, and the answer is already known.
 */
const draftSuggestion = ref<{ title?: string; description?: string } | null>(null)
const draftDescriptionBytes = computed(() => new TextEncoder().encode(draftDescription.value).length)
// The limits come from the server that owns them. When it has not published
// any (an older server, a preview that failed), the page enforces nothing on
// its own: the save answers with the reason, and a page that keeps its own
// copy of the numbers is a page that can disagree with the server.
const draftTitleLimit = computed(() => previewed.value?.limits?.title_max_characters ?? 0)
const draftDescriptionLimit = computed(() => previewed.value?.limits?.description_max_bytes ?? 0)
const draftDescriptionYouTubeLimit = computed(
  () => previewed.value?.limits?.description_max_bytes_youtube ?? 0,
)
const draftTitleInvalid = computed(() => !draftTitle.value.trim()
  || (draftTitleLimit.value > 0 && draftTitle.value.length > draftTitleLimit.value))
const draftDescriptionInvalid = computed(() => draftDescriptionLimit.value > 0
  && draftDescriptionBytes.value > draftDescriptionLimit.value)
// Editing the text is only meaningful for an upload that has not happened
// yet. A video already on YouTube cannot be re-titled from here, and the
// scheduling flow only moves the publish date — an editable panel there
// would take edits that no request would ever carry.
const canEditMetadata = computed(() => !alreadyPublished.value && reviewIntent.value !== 'schedule')
const reviewIntent = ref<ReviewIntent>('upload')
const timingMode = ref<TimingMode>('private')
const customDateTime = ref('')
const customMinimum = ref('')
const timingDirty = ref(false)
const timingError = ref('')
const timingTimezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || 'your device timezone')
const videoEpisode = ref<PublishableEpisode | null>(null)
const videoError = ref('')
const overviewError = ref('')
const refreshingList = ref(false)

const LIFECYCLE: Record<string, string> = {
  preparing: 'Preparing',
  uploading: 'Uploading',
  accepted: 'Accepted by YouTube',
  processing: 'Processing on YouTube',
  ready: 'Ready',
  failed: 'Upload failed',
  rejected: 'Rejected by YouTube',
  status_unavailable: 'Status could not be checked',
}
function lifecycleLabel(lifecycle: string): string { return LIFECYCLE[lifecycle] ?? lifecycle }

/** YouTube's own words for a refusal, when it gave any. */
function reasonFor(op: Operation): string {
  return op.processing?.rejection_reason || op.processing?.failure_reason || ''
}

const RENDER_LABELS: Record<RenderState, string> = { ready: 'Ready', missing: 'No rendered video yet', unknown: 'Status unknown' }
const UPLOAD_LABELS: Record<UploadState, string> = {
  none: 'Not uploaded', queued: 'Queued', running: 'Uploading', failed: 'Failed', succeeded: 'Uploaded', unknown: 'Status unknown',
}
const PUBLICATION_LABELS: Record<PublicationState, string> = {
  unpublished: 'Not published', uploaded: 'Uploaded', processing: 'Processing', published: 'Published',
  scheduled: 'Scheduled', failed: 'Failed', rejected: 'Rejected', unknown: 'Status unknown',
}

function renderState(ep: PublishableEpisode): RenderState {
  return ep.local?.render.state ?? (ep.has_video === true ? 'ready' : ep.has_video === false ? 'missing' : 'unknown')
}
function liveUploadJob(ep: PublishableEpisode): any | null {
  const jobId = ep.local?.upload.job_id
  return jobId ? jobs.value.find(job => job.job_id === jobId && job.type === 'youtube_upload') || null : null
}
function uploadState(ep: PublishableEpisode): UploadState {
  const live = liveUploadJob(ep)
  if (live?.status === 'queued' || live?.status === 'paused') return 'queued'
  if (live?.status === 'running') return 'running'
  if (live?.status === 'done') return 'succeeded'
  if (live?.status === 'error') return 'failed'
  if (ep.local?.upload.state) return ep.local.upload.state
  if (ep.blocked_reason && !ep.has_remote_video && !ep.operation) return 'unknown'
  const state = ep.operation?.lifecycle
  if (!state) return ep.has_remote_video ? 'succeeded' : 'none'
  if (state === 'preparing') return 'queued'
  if (state === 'uploading') return 'running'
  if (state === 'failed' || state === 'rejected') return 'failed'
  if (['accepted', 'processing', 'ready'].includes(state)) return 'succeeded'
  return 'unknown'
}
function publicationState(ep: PublishableEpisode): PublicationState {
  if (ep.publication?.state) return ep.publication.state
  if (ep.has_remote_video) return ep.operation?.lifecycle === 'processing' ? 'processing' : 'uploaded'
  if (ep.operation?.lifecycle === 'failed') return 'failed'
  if (ep.operation?.lifecycle === 'rejected') return 'rejected'
  return 'unpublished'
}
function renderLabel(ep: PublishableEpisode): string { return RENDER_LABELS[renderState(ep)] }
/** A paused upload job is waiting for the owner, not for the queue. */
function isUploadPaused(ep: PublishableEpisode): boolean {
  const live = liveUploadJob(ep)
  if (live) return live.status === 'paused'
  return uploadState(ep) === 'queued' && ep.local?.upload.reason === 'Upload job is paused.'
}
function uploadLabel(ep: PublishableEpisode): string {
  return isUploadPaused(ep) ? 'Paused — resume it in Jobs' : UPLOAD_LABELS[uploadState(ep)]
}
function publicationLabel(ep: PublishableEpisode): string {
  const state = publicationState(ep)
  const visibility = ep.publication?.visibility
  return `${PUBLICATION_LABELS[state]}${visibility ? ` · ${visibility}` : ''}`
}
/** Settings → This Mac → Connections, where each channel row has its one-click Reconnect. */
const reconnectLink = computed(() => `/projects/${slug.value}/settings#youtube`)
/** Only a refused sign-in (the server says "Reconnect") gets the Reconnect action; a network hiccup does not. */
function needsReconnect(reason: string): boolean { return /\bReconnect\b/.test(reason) }
function uploadReason(ep: PublishableEpisode): string {
  return ep.local?.upload.reason || (ep.operation ? reasonFor(ep.operation) : '')
}
function uploadProgress(ep: PublishableEpisode): UploadProgress | null {
  if (!['queued', 'running'].includes(uploadState(ep))) return null
  const live = liveUploadJob(ep)
  return live || ep.local?.upload || null
}
function publicationReason(ep: PublishableEpisode): string { return ep.publication?.reason || '' }
function playableVideoUrl(ep: PublishableEpisode): string { return renderState(ep) === 'ready' ? ep.local?.render.video_url || '' : '' }
function videoAssemblyLink(ep: PublishableEpisode): string {
  return `/projects/${slug.value}/video-assembly?episode_id=${encodeURIComponent(ep.episode_code)}`
}
function episodeNumber(ep: PublishableEpisode): number {
  const match = ep.episode_code.match(/(\d+)$/)
  return match ? Number(match[1]) : Number.NEGATIVE_INFINITY
}
function scheduleTime(ep: PublishableEpisode): number {
  const value = ep.publication?.scheduled_at || ep.plan?.scheduled_at
  if (!value) return Number.POSITIVE_INFINITY
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}
function formatWhen(value: string | undefined): string {
  if (!value) return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return 'Date unavailable'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  } catch {
    return at.toLocaleString()
  }
}
function formatZonedWhen(value: string | undefined, timezone?: string): string {
  if (!value) return ''
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'your device timezone'
  if (timezone) {
    try {
      return `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value))} · ${timezone}`
    } catch {
      return `${formatWhen(value)} · Device time (${deviceZone}); plan timezone unavailable`
    }
  }
  return `${formatWhen(value)} · Device time (${deviceZone})`
}
const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'your device timezone'

// Refresh date-dependent controls while this page stays open, without network polling.
const planClock = ref(Date.now())
let planClockTimer: ReturnType<typeof setInterval> | undefined
const refreshPlanClock = () => { planClock.value = Date.now() }

// A Final Check is measured in the background — the POST that starts it answers at once — so the
// row's verdict arrives on a later read. Reload the list while any row is still checking, and stop
// the moment none is: the check's verdict is what the row is waiting for, and nothing else is.
const finalChecksStillRunning = computed(() => finalChecksRunning(episodes.value))
let finalCheckTimer: ReturnType<typeof setInterval> | undefined
function syncFinalCheckPoll(): void {
  if (finalChecksStillRunning.value && !finalCheckTimer) {
    finalCheckTimer = setInterval(() => { void load() }, 5_000)
  } else if (!finalChecksStillRunning.value && finalCheckTimer) {
    clearInterval(finalCheckTimer)
    finalCheckTimer = undefined
  }
}
watch(finalChecksStillRunning, syncFinalCheckPoll)

onMounted(() => {
  // The channel's connected social accounts and saved platform choice. Read
  // once; a failure leaves the section empty rather than offering a tick that
  // cannot post.
  void loadSocialChoices()
  planClockTimer = setInterval(refreshPlanClock, 60_000)
  window.addEventListener('focus', refreshPlanClock)
  syncFinalCheckPoll()
})
onUnmounted(() => {
  // Leaving the page ends any in-flight action, including the bulk queue loop
  // (it checks actionIsCurrent before every row). Rows already queued stay queued.
  actionRevision += 1
  bulkQueueStopRequested.value = true
  clearInterval(planClockTimer)
  clearInterval(finalCheckTimer)
  window.removeEventListener('focus', refreshPlanClock)
})

function isFutureIso(value: string | undefined): value is string {
  if (!value) return false
  const at = new Date(value).getTime()
  return Number.isFinite(at) && at > Math.max(planClock.value, Date.now())
}
const selectedEpisode = computed(() => episodes.value.find(ep => ep.episode_code === previewedEpisode.value) || null)
const plannedPublishAt = computed(() => isFutureIso(selectedEpisode.value?.plan?.scheduled_at)
  ? selectedEpisode.value!.plan!.scheduled_at!
  : '')
function canScheduleExisting(ep: PublishableEpisode): boolean {
  return ep.can_schedule_existing === true && publicationState(ep) === 'uploaded'
}
function associatedVideoId(ep: PublishableEpisode): string { return ep.remote_video_id || ep.operation?.video_id || '' }

const recordedVideoId = computed(() => {
  return previewed.value?.video_id
    || (selectedEpisode.value ? associatedVideoId(selectedEpisode.value) : '')
    || ''
})

const isPostUpload = computed(() => {
  if (recordedVideoId.value) return true
  const ep = selectedEpisode.value
  if (ep) {
    if (uploadState(ep) === 'succeeded' || ep.has_remote_video) return true
  }
  return !!alreadyPublished.value && reviewIntent.value !== 'schedule'
})

const youtubeStudioVideoUrl = computed(() => {
  if (!recordedVideoId.value) return ''
  return `https://studio.youtube.com/video/${encodeURIComponent(recordedVideoId.value)}/edit`
})

const otherThumbnailCandidates = computed(() => {
  const options = previewed.value?.thumbnail?.options || []
  const chosenFilename = previewed.value?.thumbnail?.filename
  return options.filter(opt => opt.filename !== chosenFilename)
})
const scheduleVisibilityUnknown = computed(() => reviewIntent.value === 'schedule'
  && !!selectedEpisode.value
  && !selectedEpisode.value.publication?.visibility)
function publicationDate(ep: PublishableEpisode): string {
  if (ep.publication?.published_at) return `Published ${formatZonedWhen(ep.publication.published_at)}`
  if (ep.publication?.scheduled_at) {
    const when = formatZonedWhen(ep.publication.scheduled_at, ep.plan?.timezone)
    // A publishAt YouTube itself accepted IS a schedule, even while the video is
    // still being processed — the two facts are shown together, never one
    // instead of the other.
    return publicationState(ep) === 'processing' ? `Scheduled ${when} · YouTube still processing` : when
  }
  return ''
}
function plannedDate(ep: PublishableEpisode): string {
  if (!ep.plan?.scheduled_at) return ''
  return formatZonedWhen(ep.plan.scheduled_at, ep.plan.timezone)
}
function hasMissedPlan(ep: PublishableEpisode): boolean {
  const at = Date.parse(ep.plan?.scheduled_at || '')
  return Number.isFinite(at) && at <= Math.max(planClock.value, Date.now())
    && !ep.has_remote_video && !associatedVideoId(ep)
    && ['none', 'failed'].includes(uploadState(ep))
    && ['unpublished', 'failed', 'rejected'].includes(publicationState(ep))
}
function lastCheckedLabel(ep: PublishableEpisode): string {
  const checkedAt = ep.publication?.last_checked_at || ep.operation?.processing?.checked_at
  if (checkedAt) return `YouTube checked ${formatWhen(checkedAt)}; cleanup verifies again.`
  return ep.operation || ep.has_remote_video ? 'Not checked with YouTube yet' : ''
}
function stateTone(state: RenderState | UploadState | PublicationState): string {
  if (['ready', 'succeeded', 'published'].includes(state)) return 'tone-success'
  if (['queued', 'running', 'uploaded', 'processing', 'scheduled'].includes(state)) return 'tone-info'
  if (['missing', 'failed', 'rejected'].includes(state)) return 'tone-danger'
  return 'tone-muted'
}
function matchesStatus(ep: PublishableEpisode, key: StatusFilter): boolean {
  if (key === 'all') return true
  if (key === 'missing') return renderState(ep) === 'missing'
  if (key === 'in_progress') return ['queued', 'running'].includes(uploadState(ep))
    || publicationState(ep) === 'processing'
  if (key === 'missed') return hasMissedPlan(ep)
  if (key === 'planned') return !!ep.plan?.scheduled_at && publicationState(ep) !== 'scheduled'
  if (key === 'uploaded') return publicationState(ep) === 'uploaded'
  if (key === 'scheduled') return publicationState(ep) === 'scheduled'
  if (key === 'published') return publicationState(ep) === 'published'
  if (key === 'attention') return renderState(ep) === 'unknown'
    || ['failed', 'unknown'].includes(uploadState(ep))
    || ['failed', 'rejected', 'unknown'].includes(publicationState(ep))
  return isUploadEligible(ep)
}
function countStatus(key: StatusFilter): number { return episodes.value.filter(ep => matchesStatus(ep, key)).length }
function clearFilters(): void { filter.value = ''; statusFilter.value = 'all' }
function openVideo(ep: PublishableEpisode): void { if (playableVideoUrl(ep)) videoEpisode.value = ep }
function closeVideo(): void { videoEpisode.value = null; videoError.value = '' }
function closeReview(restoreFocus = true): void {
  const opener = reviewOpener.value
  reviewOpener.value = null
  // The editor was holding this episode's headline and source. Closing the
  // review drops them with it rather than leaving one episode's draft behind
  // for the next one to inherit (AGENTS §4).
  textEditorOpen.value = false
  // A review still being built is abandoned, not merely hidden: its late
  // answer must not reopen the dialog. Nothing queued is touched here.
  if (previewedEpisode.value && busy.value === `preview-${previewedEpisode.value}`) {
    actionRevision += 1
    busy.value = ''
  }
  previewed.value = null
  previewedEpisode.value = ''
  thumbnailImageUnavailable.value = false
  thumbnailError.value = ''
  reviewIntent.value = 'upload'
  timingMode.value = 'private'
  customDateTime.value = ''
  timingDirty.value = false
  timingError.value = ''
  timingTimezone.value = deviceTimezone
  draftTitle.value = ''
  draftDescription.value = ''
  draftSaved.value = true
  draftEverSaved.value = false
  draftSuggestion.value = null
  draftError.value = ''
  // Social state belongs to the episode being reviewed. Clearing it here is
  // what stops one episode's receipts appearing under another's name.
  socialState.value = null
  socialNote.value = ''
  if (restoreFocus && opener) {
    void nextTick(() => {
      if (opener.isConnected && !(opener as HTMLButtonElement).disabled) opener.focus()
    })
  }
}

function localDateTimeValue(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function previewTimingBody(mode: TimingMode): { privacy_status: 'private'; publish_at?: string } | null {
  if (mode === 'private') return { privacy_status: 'private' }
  if (mode === 'planned') {
    if (!plannedPublishAt.value) {
      timingError.value = 'This episode does not have a future planned date. Choose a custom date or keep it private.'
      return null
    }
    return { privacy_status: 'private', publish_at: plannedPublishAt.value }
  }
  const parsed = new Date(customDateTime.value)
  if (!customDateTime.value || !Number.isFinite(parsed.getTime())) {
    timingError.value = 'Choose a valid date and time.'
    return null
  }
  if (parsed.getTime() <= Date.now()) {
    timingError.value = 'Choose a future date and time. Story Studio will not turn a past schedule into an immediate publish.'
    return null
  }
  return { privacy_status: 'private', publish_at: parsed.toISOString() }
}

async function rebuildTimingPreview(mode: TimingMode): Promise<void> {
  if (!previewed.value || !previewedEpisode.value || busy.value) return
  timingError.value = ''
  const timing = previewTimingBody(mode)
  if (!timing) { timingDirty.value = true; return }
  const episodeCode = previewedEpisode.value
  const thumbnailFilename = previewed.value.thumbnail.state === 'selected'
    ? previewed.value.thumbnail.filename
    : undefined
  const action = beginAction(`timing-${episodeCode}`)
  timingDirty.value = true
  try {
    const result = await post<Preview>(`/projects/${action.slug}/youtube/preview`, {
      episode_code: episodeCode,
      ...timing,
      ...(thumbnailFilename ? { thumbnail_filename: thumbnailFilename } : {}),
    })
    if (!actionIsCurrent(action) || previewedEpisode.value !== episodeCode) return
    previewed.value = normalizePreview(result)
    timingMode.value = mode
    timingTimezone.value = mode === 'planned' ? selectedEpisode.value?.plan?.timezone || deviceTimezone : deviceTimezone
    timingDirty.value = false
  } catch (error: any) {
    if (!actionIsCurrent(action) || previewedEpisode.value !== episodeCode) return
    timingError.value = error?.data?.detail || error?.message || 'Could not review that publishing time.'
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

function changeTimingMode(): void {
  timingError.value = ''
  if (timingMode.value === 'custom') {
    timingDirty.value = true
    return
  }
  void rebuildTimingPreview(timingMode.value)
}
function markTimingDirty(): void { timingDirty.value = true; timingError.value = '' }
function reviewCustomTiming(): void { void rebuildTimingPreview('custom') }

const NO_ACTIVE_PLAN_MESSAGE = 'This channel does not have an active upload plan. Create or activate one in the Upload plans tab.'
function isNoActivePlanMessage(message: string): boolean { return message === NO_ACTIVE_PLAN_MESSAGE }

/** A second click on an upload that is already waiting is not a failure. */
function uploadFailure(error: any, episodeCode: string, fallback: string): { kind: 'info' | 'err'; message: string } {
  const detail = String(error?.data?.detail || error?.message || '')
  if (/youtube_upload generation already queued\/running/i.test(detail)) {
    return { kind: 'info', message: `${episodeCode} is already waiting to upload — see Jobs.` }
  }
  return { kind: 'err', message: detail || fallback }
}

interface UploadPlan {
  id: string
  name: string
  platform: string
  account_id: string
  schedule?: { timezone?: string }
}
interface PlanAssignment { episode_code: string; publishAt: string; previous_publish_at?: string }

async function assignPlanDates(episodeCodes: string[], busyLabel: string): Promise<{ assignments: PlanAssignment[]; order_shifted: string[]; timezone: string } | null> {
  const channelId = assignedChannel.value?.channel_id
  if (!episodeCodes.length || !channelId || busy.value) return null
  const action = beginAction(busyLabel)
  try {
    const listed = await get<{ plans: UploadPlan[]; active: Record<string, string> }>(`/projects/${action.slug}/upload/plans`)
    if (!actionIsCurrent(action)) return null
    const planId = listed.active?.[`youtube:registry:${channelId}`]
    const plan = listed.plans.find(candidate => candidate.id === planId)
    if (!plan) throw new Error(NO_ACTIVE_PLAN_MESSAGE)
    const previewResult = await post<{ assignments: PlanAssignment[]; skipped_existing: string[] }>(
      `/projects/${action.slug}/youtube/plan/preview`,
      { plan_id: plan.id, expected_channel_id: channelId, episode_codes: episodeCodes },
    )
    if (!actionIsCurrent(action)) return null
    if (!previewResult.assignments.length || previewResult.assignments.some(item => !isFutureIso(item.publishAt))) {
      throw new Error('The active plan did not produce future dates for these videos. Edit the plan before assigning them.')
    }
    const zone = plan.schedule?.timezone || deviceTimezone
    const proposedDates = previewResult.assignments
      .map(item => {
        const previous = item.previous_publish_at
        const from = previous ? `Previous: ${formatZonedWhen(previous, zone)} (${previous})\n` : ''
        return `${item.episode_code}\n${from}New: ${formatZonedWhen(item.publishAt, zone)} (${item.publishAt})`
      })
      .join('\n')
    const confirmed = await ask({
      title: previewResult.assignments.length === 1 ? `Use the next ${plan.name} date?` : `Review planned dates for ${previewResult.assignments.length} videos?`,
      message: `The plan currently proposes:\n${proposedDates}\n\nDates follow episode order: videos not on YouTube yet share the planned dates lowest episode first, so a later-numbered video can move later. Videos already on YouTube keep their dates. Story Studio will check current claims again before saving. These are local planned dates; each YouTube upload or existing private video still needs its own confirmation.`,
      confirmLabel: previewResult.assignments.length === 1 ? 'Use Planned Date' : 'Save Planned Dates',
    })
    if (!actionIsCurrent(action)) return null
    if (!confirmed) return null
    const applied = await post<{ assignments: PlanAssignment[]; order_shifted?: string[]; skipped_existing: string[] }>(
      `/projects/${action.slug}/youtube/plan/apply`,
      {
        plan_id: plan.id,
        expected_channel_id: channelId,
        episode_codes: episodeCodes,
        confirm: true,
        expected_assignments: previewResult.assignments,
      },
    )
    if (!actionIsCurrent(action)) return null
    if (!applied.assignments.length || applied.assignments.some(item => !isFutureIso(item.publishAt))) {
      throw new Error('The upload plan did not save future dates for these videos.')
    }
    return { assignments: applied.assignments, order_shifted: applied.order_shifted ?? [], timezone: zone }
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

/** One line for the Upload Center when keeping episode order moved dates. */
function orderNote(shifted: string[]): string {
  return shifted.length ? `Dates follow episode order; ${shifted.length} episode${shifted.length === 1 ? '' : 's'} shifted. ` : ''
}

async function useNextPlanSlot(): Promise<void> {
  const episodeCode = previewedEpisode.value
  if (!episodeCode || busy.value || reviewIntent.value !== 'upload') return
  timingError.value = ''
  try {
    const result = await assignPlanDates([episodeCode], `plan-slot-${episodeCode}`)
    if (!result) return
    const saved = result.assignments.find(item => item.episode_code === episodeCode)
    if (!saved) throw new Error('The upload plan did not save a date for this episode.')
    const episode = episodes.value.find(item => item.episode_code === episodeCode)
    if (episode) episode.plan = { scheduled_at: saved.publishAt, timezone: result.timezone }
    const others = result.order_shifted.filter(code => code !== episodeCode)
    if (others.length) planResult.value = { kind: 'ok', message: `${orderNote(others)}Refresh List to see their new dates.` }
    timingMode.value = 'planned'
    await rebuildTimingPreview('planned')
  } catch (error: any) {
    timingError.value = error?.data?.detail || error?.message || 'Could not use the next upload plan date.'
  }
}

function canPlanEpisode(ep: PublishableEpisode): boolean {
  if (isFutureIso(ep.plan?.scheduled_at) || renderState(ep) !== 'ready') return false
  if (canScheduleExisting(ep)) return !ep.plan?.scheduled_at
  const hasRemote = !!(ep.has_remote_video || ep.remote_video_id || ep.operation?.video_id)
  return !hasRemote && !ep.blocked_reason && ['none', 'failed'].includes(uploadState(ep))
    && ['unpublished', 'failed', 'rejected'].includes(publicationState(ep))
}
const planCandidates = computed(() => visibleEpisodes.value.filter(canPlanEpisode))

async function planUnscheduledVideos(episodeCodes?: string[]): Promise<void> {
  const codes = Array.isArray(episodeCodes) ? episodeCodes : [...planCandidates.value]
    .sort((a, b) => episodeNumber(a) - episodeNumber(b))
    .map(ep => ep.episode_code)
  if (!codes.length || busy.value) return
  planResult.value = null
  try {
    const result = await assignPlanDates(codes, 'plan-batch')
    if (!result) return
    await load()
    planResult.value = {
      kind: 'ok',
      message: `Saved local planned dates for ${result.assignments.length} video${result.assignments.length === 1 ? '' : 's'}. ${orderNote(result.order_shifted)}YouTube has not been changed; confirm each upload or private-video schedule separately.`,
    }
  } catch (error: any) {
    planResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not plan those videos.' }
  }
}

// ── Edit planned dates (re-lay) ───────────────────────────────────────────
//
// The gap this closes: `canPlanEpisode` returns false the moment an episode
// holds a FUTURE planned date, and the plan route reports the same episodes as
// `skipped_existing`. That rule is right for "plan what is unscheduled" and left
// the opposite intent unreachable — an episode handed a date it should not have
// kept, because a failed render let the episode behind it take the slot, could
// not be re-dated from ANY surface. Bulk is the point: at 70+ planned episodes
// a one-row-at-a-time fix is not a fix.
//
// Local planned dates only. Nothing here writes to YouTube, so a video that
// already exists on the channel is reported as skipped rather than re-dated
// behind YouTube's back — a local date that disagrees with a live `publishAt`
// would make the row lie about when the video actually goes live.

interface RelayoutSkip { episode_code: string; reason: string }

interface RelayoutPreview {
  plan_id: string
  channel_id: string
  start_date: string
  timezone: string
  ordered_episode_codes: string[]
  assignments: PlanAssignment[]
  skipped: RelayoutSkip[]
  occupied_days: string[]
}

const relayoutOpen = ref(false)
const relayoutHeading = ref<HTMLElement | null>(null)
const relayoutOpener = ref<HTMLElement | null>(null)
const relayoutStartDate = ref('')
const relayoutPreview = ref<RelayoutPreview | null>(null)
const relayoutRequest = ref<{ plan_id: string; expected_channel_id: string; episode_codes: string[]; start_date: string } | null>(null)
const relayoutPlanName = ref('')
const relayoutError = ref('')
const relayoutResult = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)

/** The `YYYY-MM-DD` an instant falls on in `tz` — a `<input type="date">` value. */
function zonedDateInput(iso: string, tz: string): string {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at)
  const year = parts.find(part => part.type === 'year')?.value
  const month = parts.find(part => part.type === 'month')?.value
  const day = parts.find(part => part.type === 'day')?.value
  return year && month && day ? `${year}-${month}-${day}` : ''
}

async function openRelayout(event?: Event): Promise<void> {
  relayoutError.value = ''
  relayoutResult.value = null
  relayoutPreview.value = null
  relayoutRequest.value = null
  relayoutOpener.value = (event?.currentTarget as HTMLElement) || null
  const selected = selectedUploadEpisodes.value
  if (!selected.length) return
  // Default to the earliest date the selection already holds, so the common case
  // — "put this scramble back onto the cadence" — needs no retyping. The date is
  // read in the PLAN's timezone, not the device's, because that is the calendar
  // the slots are laid out on.
  const zone = selected.find(ep => ep.plan?.timezone)?.plan?.timezone || deviceTimezone
  const planned = selected
    .map(ep => ep.plan?.scheduled_at)
    .filter((value): value is string => isFutureIso(value))
    .sort()
  relayoutStartDate.value = zonedDateInput(
    planned[0] ?? new Date(Date.now() + 86_400_000).toISOString(),
    zone,
  )
  relayoutOpen.value = true
  await nextTick()
  relayoutHeading.value?.focus()
}

function closeRelayout(): void {
  invalidateRelayoutPreview()
  relayoutOpen.value = false
  const opener = relayoutOpener.value
  relayoutOpener.value = null
  if (opener) nextTick(() => opener.focus())
}

function invalidateRelayoutPreview(): void {
  // A relayout preview belongs to one date. Its response cannot restore an
  // old proposal after that date changes or the dialog closes.
  actionRevision++
  if (busy.value === 'relayout-preview') busy.value = ''
  relayoutPreview.value = null
  relayoutRequest.value = null
  relayoutError.value = ''
}

watch(relayoutStartDate, () => {
  if (relayoutOpen.value && (relayoutPreview.value || relayoutRequest.value || busy.value === 'relayout-preview')) {
    invalidateRelayoutPreview()
  }
})

async function previewRelayout(): Promise<void> {
  // Production order, not selection order: the checkbox set preserves click
  // order and the list default is newest-first, neither of which may decide
  // which episode receives the earliest date. The route re-sorts too, so this
  // only keeps the request itself stable and readable.
  const codes = [...selectedUploadEpisodes.value]
    .sort((a, b) => episodeNumber(a) - episodeNumber(b))
    .map(ep => ep.episode_code)
  const channelId = assignedChannel.value?.channel_id
  if (!codes.length || !channelId || busy.value || !relayoutStartDate.value) return
  const action = beginAction('relayout-preview')
  relayoutError.value = ''
  relayoutPreview.value = null
  relayoutResult.value = null
  try {
    const listed = await get<{ plans: UploadPlan[]; active: Record<string, string> }>(`/projects/${action.slug}/upload/plans`)
    if (!actionIsCurrent(action)) return
    const planId = listed.active?.[`youtube:registry:${channelId}`]
    const plan = listed.plans.find(candidate => candidate.id === planId)
    if (!plan) throw new Error(NO_ACTIVE_PLAN_MESSAGE)
    const preview = await post<RelayoutPreview>(`/projects/${action.slug}/youtube/plan/relayout/preview`, {
      plan_id: plan.id,
      expected_channel_id: channelId,
      episode_codes: codes,
      start_date: relayoutStartDate.value,
    })
    if (!actionIsCurrent(action)) return
    relayoutPlanName.value = plan.name
    relayoutPreview.value = preview
    // Kept so Apply sends the exact request this preview answered. A preview that
    // cannot be replayed is a preview of a different operation.
    relayoutRequest.value = {
      plan_id: plan.id, expected_channel_id: channelId,
      episode_codes: codes, start_date: relayoutStartDate.value,
    }
  } catch (error: any) {
    relayoutError.value = error?.data?.detail || error?.message || 'Could not preview those dates.'
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

async function applyRelayout(): Promise<void> {
  const preview = relayoutPreview.value
  const request = relayoutRequest.value
  if (!preview || !request || busy.value || !preview.assignments.length) return
  const action = beginAction('relayout-apply')
  relayoutError.value = ''
  try {
    const applied = await post<RelayoutPreview>(`/projects/${action.slug}/youtube/plan/relayout/apply`, {
      ...request, confirm: true, expected_assignments: preview.assignments,
    })
    if (!actionIsCurrent(action)) return
    const saved = applied.assignments.length
    const held = applied.skipped.length
    relayoutResult.value = {
      kind: held ? 'warn' : 'ok',
      message: `Saved ${saved} planned date${saved === 1 ? '' : 's'}`
        + (held ? `, and left ${held} unchanged.` : '.')
        + ' YouTube was not changed — each video still needs its own schedule confirmation.',
    }
    relayoutOpen.value = false
    relayoutPreview.value = null
    relayoutRequest.value = null
    selectedCodes.value = []
    await load()
  } catch (error: any) {
    relayoutError.value = error?.data?.detail || error?.message || 'Could not save those dates.'
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

function thumbnailGeneratorLink(episodeCode: string): string {
  return `/projects/${slug.value}/images?tab=thumbnails&episode_id=${encodeURIComponent(episodeCode)}`
}

/**
 * Why a remote check cannot run right now, or '' when it can. Local records
 * stay readable regardless — losing YouTube costs freshness, never access.
 */
/** Why an UPLOAD cannot run — the route's own preconditions, in the same order. */
const uploadBlocked = computed(() => {
  if (overviewError.value) return 'YouTube connection status is unavailable, so uploads are paused.'
  if (!channelStatus.value) return 'No YouTube channel is assigned yet, so nothing can be uploaded.'
  if (channelStatus.value === 'reconnect_required') return 'Reconnect this channel in Settings before uploading.'
  if (channelStatus.value === 'scope_upgrade_required') return 'This channel needs its permissions upgraded in Settings before Story Studio can upload.'
  if (quotaUnavailableReason.value === 'ledger_unreadable') return 'Uploads and other provider writes are paused until the local allowance record is repaired.'
  if (uploadQuotaExhausted.value) return 'Today’s upload allowance for this Google Cloud project is used up. Uploading resumes after it resets.'
  return ''
})

function uploadEligibilityReason(ep: PublishableEpisode): string {
  if (uploadBlocked.value) return uploadBlocked.value
  if (queuedUploadCodes.has(ep.episode_code)) return `${ep.episode_code} is queued for upload. Progress appears in Jobs.`
  if (renderState(ep) !== 'ready') return `${ep.episode_code} does not have a rendered video.`
  if (ep.blocked_reason) return ep.blocked_reason
  const hasRemoteIdentity = !!(ep.has_remote_video || ep.remote_video_id || ep.operation?.video_id)
  if (hasRemoteIdentity) return `${ep.episode_code} already has a YouTube video association.`
  const localUpload = uploadState(ep)
  if (!['none', 'failed'].includes(localUpload)) return `${ep.episode_code} already has upload work in progress or completed.`
  const publication = publicationState(ep)
  if (publication === 'unpublished') return ''
  if (localUpload === 'failed' && ['failed', 'rejected'].includes(publication)) return ''
  return `${ep.episode_code} is not available for a new upload.`
}
function isUploadEligible(ep: PublishableEpisode): boolean { return uploadEligibilityReason(ep) === '' }

// ── Selection and bulk actions ────────────────────────────────────────────
//
// Any row can be selected; each bulk action then counts the selected rows it
// applies to. Only rows the filters are SHOWING are ever acted on — a row that
// a search or status filter hides stays selected (and the panel says so) but
// is never touched, so nothing happens to a video the owner cannot see.

/** Selected rows that are on screen, in on-screen order. */
const actionableSelection = computed(() => sortedEpisodes.value.filter(ep => selectedCodes.value.includes(ep.episode_code)))
const hiddenSelectedCount = computed(() => selectedCodes.value.length - actionableSelection.value.length)
const selectedBelowCount = computed(() => actionableSelection.value.length
  - shownEpisodes.value.filter(ep => selectedCodes.value.includes(ep.episode_code)).length)
/** The bulk panel opens once a row is ticked, and stays while a run reports. */
const bulkOpen = computed(() => selectedCodes.value.length > 0 || !!bulkRun.value)
const selectedUploadEpisodes = computed(() => actionableSelection.value.filter(isUploadEligible))
const allMatchingSelected = computed(() => sortedEpisodes.value.length > 0
  && sortedEpisodes.value.every(ep => selectedCodes.value.includes(ep.episode_code)))
const selectionSummary = computed(() => {
  const shown = actionableSelection.value.length
  return shown ? `${shown} selected` : bulkOpen.value ? 'Nothing selected' : 'Tick a row to see bulk actions'
})
let selectionAnchor: string | null = null
function onRowSelect(episodeCode: string, event: MouseEvent): void {
  const checked = (event.target as HTMLInputElement).checked
  selectedCodes.value = applyRowSelection(
    selectedCodes.value, sortedEpisodes.value.map(ep => ep.episode_code),
    event.shiftKey ? selectionAnchor : null, episodeCode, checked,
  )
  selectionAnchor = episodeCode
}
function toggleAllMatching(): void {
  const codes = sortedEpisodes.value.map(ep => ep.episode_code)
  selectedCodes.value = allMatchingSelected.value
    ? selectedCodes.value.filter(code => !codes.includes(code))
    : [...new Set([...selectedCodes.value, ...codes])]
  selectionAnchor = null
}
function clearSelection(): void { selectedCodes.value = []; selectionAnchor = null }

/** Uploaded videos on this channel that YouTube can be asked to change. */
function isOnYouTube(ep: PublishableEpisode): boolean {
  return !!associatedVideoId(ep) && ['uploaded', 'scheduled', 'published'].includes(publicationState(ep))
}
/** An upload waiting in the queue: cancelling it sends nothing to YouTube. */
function queuedUploadJob(ep: PublishableEpisode): any | null {
  const live = liveUploadJob(ep)
  return live?.status === 'queued' ? live : null
}
const scheduleRows = computed(() => actionableSelection.value.filter(canScheduleExisting)
  .sort((a, b) => episodeNumber(a) - episodeNumber(b)))
const visibilityRows = computed(() => actionableSelection.value.filter(isOnYouTube))
const dequeueRows = computed(() => actionableSelection.value.filter(ep => !!queuedUploadJob(ep)))

type BulkKey = 'upload' | 'relayout' | 'schedule' | 'visibility' | 'refinalize' | 'dequeue'
const bulkActions = computed(() => {
  const nothing = actionableSelection.value.length ? '' : 'Select rows first.'
  const why = (blocked: string, count: number, none: string) => blocked || nothing || (count ? '' : none)
  const upload = selectedUploadEpisodes.value.length
  const relayout = selectedUploadEpisodes.value.length
  const all = actionableSelection.value.length
  return [
    {
      key: 'upload' as BulkKey, youtube: true, label: `Review Selected Uploads (${upload})`,
      hint: 'Shows each video’s exact file, thumbnail and metadata, then queues them as private uploads. Nothing is sent until you press Queue.',
      why: why(uploadBlocked.value, upload, 'None of the selected rows can be uploaded: each needs a finished video and no upload yet.'),
    },
    {
      key: 'relayout' as BulkKey, youtube: false, label: `Edit Planned Dates (${relayout})`,
      hint: 'Spreads the planned dates of videos not on YouTube yet from a start date, on the active plan’s cadence.',
      why: why(planBlocked.value, relayout, 'None of the selected rows can be re-dated: they are already on YouTube or uploading.'),
    },
    {
      key: 'schedule' as BulkKey, youtube: true, label: `Schedule on YouTube (${scheduleRows.value.length})`,
      hint: 'Gives uploaded private videos a publish time, spread over the days you choose. They stay private until then.',
      why: why(scheduleBlocked.value, scheduleRows.value.length, 'None of the selected rows is an uploaded private video without a publish time.'),
    },
    {
      key: 'visibility' as BulkKey, youtube: true, label: `Set Visibility (${visibilityRows.value.length})`,
      hint: 'Makes videos already on YouTube Public, Unlisted or Private, and clears any scheduled time.',
      why: why(scheduleBlocked.value, visibilityRows.value.length, 'None of the selected rows is on YouTube yet.'),
    },
    {
      key: 'refinalize' as BulkKey, youtube: false, label: `Re-Finalize Metadata (${all})`,
      hint: 'Writes a new title, description and tags with this channel’s YouTube Finalizer preset. Earlier versions are kept.',
      why: why('', all, ''),
    },
    {
      key: 'dequeue' as BulkKey, youtube: false, label: `Remove from Upload Queue (${dequeueRows.value.length})`,
      hint: 'Cancels uploads still waiting to start. Nothing has reached YouTube for these, and they can be queued again.',
      why: why('', dequeueRows.value.length, 'None of the selected rows has an upload waiting in the queue.'),
    },
  ]
})

function runBulkAction(key: BulkKey, event: Event): void {
  if (key === 'upload') void reviewSelectedUploads(event)
  else if (key === 'relayout') void openRelayout(event)
  else if (key === 'schedule') openBulkSchedule()
  else if (key === 'visibility') openBulkVisibility()
  else if (key === 'refinalize') void refinalizeSelected()
  else void removeSelectedFromQueue()
}

interface BulkRun {
  label: string
  total: number
  done: number
  failed: number
  note: string
  stoppable: boolean
  stopRequested: boolean
  stopped: boolean
  finished: boolean
}
const bulkRun = ref<BulkRun | null>(null)

/**
 * One request per row, in order, each row's outcome on the row itself.
 *
 * Leaving the page stops the loop before the next row (onUnmounted moves the
 * action revision on). That is safe for every action using this loop: each
 * row is one complete request, so nothing is ever left half-changed — rows
 * already done stay done and the rest are simply not started. The note on
 * screen says exactly that.
 */
async function runPerRow(
  label: string,
  rows: PublishableEpisode[],
  work: (ep: PublishableEpisode, slug: string) => Promise<string>,
): Promise<void> {
  const action = beginAction('bulk-run')
  const run: BulkRun = {
    label, total: rows.length, done: 0, failed: 0, stoppable: true, stopRequested: false, stopped: false, finished: false,
    note: 'Leaving this page stops after the row in progress. Rows already done stay done; nothing is left half-changed.',
  }
  bulkRun.value = run
  const live = bulkRun.value
  for (const ep of rows) {
    if (!actionIsCurrent(action)) return
    if (live.stopRequested) { live.stopped = true; break }
    try {
      const message = await work(ep, action.slug)
      if (!actionIsCurrent(action)) return
      rowResults[ep.episode_code] = { kind: 'ok', message }
      live.done += 1
    } catch (error: any) {
      if (!actionIsCurrent(action)) return
      rowResults[ep.episode_code] = { kind: 'err', message: `${ep.episode_code}: ${error?.data?.detail || error?.message || 'This row could not be done.'}` }
      live.failed += 1
    }
  }
  live.finished = true
  live.note = ''
  if (actionIsCurrent(action)) {
    busy.value = ''
    await load()
  }
}

// Schedule on YouTube — spread over days.
const bulkScheduleOpen = ref(false)
const bulkScheduleFirst = ref('')
const bulkScheduleEvery = ref(1)
const bulkScheduleMin = computed(() => localDateTimeValue(new Date(Math.max(planClock.value, Date.now()) + 60_000)))
const bulkSchedulePlan = computed(() => {
  const times = spreadPublishTimes(bulkScheduleFirst.value, scheduleRows.value.length, Number(bulkScheduleEvery.value))
  return times.length ? scheduleRows.value.map((ep, index) => ({ episode_code: ep.episode_code, publish_at: times[index]! })) : []
})
const bulkScheduleError = computed(() => {
  if (!bulkScheduleFirst.value) return 'Choose when the first video goes public.'
  const every = Number(bulkScheduleEvery.value)
  if (!Number.isInteger(every) || every < 1 || every > 30) return 'Choose a whole number of days between 1 and 30.'
  if (!bulkSchedulePlan.value.length) return 'Choose a valid date and time.'
  if (!isFutureIso(bulkSchedulePlan.value[0]!.publish_at)) return 'Choose a time in the future. Story Studio never turns a past time into an immediate publish.'
  return ''
})
function openBulkSchedule(): void {
  const tomorrow = new Date(Date.now() + 86_400_000)
  tomorrow.setHours(18, 0, 0, 0)
  bulkScheduleFirst.value = localDateTimeValue(tomorrow)
  bulkScheduleEvery.value = 1
  bulkScheduleOpen.value = true
  void nextTick(() => document.getElementById('bulk-schedule-title')?.focus())
}
async function confirmBulkSchedule(): Promise<void> {
  const channelId = assignedChannel.value?.channel_id
  const plan = [...bulkSchedulePlan.value]
  if (!channelId || bulkScheduleError.value || !plan.length) return
  bulkScheduleOpen.value = false
  const times = new Map(plan.map(item => [item.episode_code, item.publish_at]))
  const rows = scheduleRows.value.filter(ep => times.has(ep.episode_code))
  await runPerRow('Schedule on YouTube', rows, async (ep, requestSlug) => {
    const publishAt = times.get(ep.episode_code)!
    await post(`/projects/${requestSlug}/youtube/episodes/${encodeURIComponent(ep.episode_code)}/schedule`, {
      publish_at: publishAt, confirm: true, expected_channel_id: channelId,
    })
    return `${ep.episode_code} is scheduled on YouTube for ${formatZonedWhen(publishAt)}. It stays private until then.`
  })
}

// Set visibility on YouTube.
type Visibility = 'public' | 'unlisted' | 'private'
const VISIBILITY_CHOICES: Array<{ value: Visibility; label: string; hint: string }> = [
  { value: 'public', label: 'Public', hint: 'Everyone can find and watch them. YouTube may notify subscribers, which cannot be taken back.' },
  { value: 'unlisted', label: 'Unlisted', hint: 'Anyone with the link can watch; they do not appear on the channel or in search.' },
  { value: 'private', label: 'Private', hint: 'Only you can watch them.' },
]
function visibilityLabel(value: Visibility): string { return VISIBILITY_CHOICES.find(choice => choice.value === value)!.label }
const bulkVisibilityOpen = ref(false)
const bulkVisibility = ref<Visibility | ''>('')
function openBulkVisibility(): void {
  bulkVisibility.value = ''
  bulkVisibilityOpen.value = true
  void nextTick(() => document.getElementById('bulk-visibility-title')?.focus())
}
async function confirmBulkVisibility(): Promise<void> {
  const channelId = assignedChannel.value?.channel_id
  const visibility = bulkVisibility.value
  const rows = [...visibilityRows.value]
  if (!channelId || !visibility || !rows.length) return
  bulkVisibilityOpen.value = false
  await runPerRow(`Set visibility to ${visibilityLabel(visibility)}`, rows, async (ep, requestSlug) => {
    await post(`/projects/${requestSlug}/youtube/episodes/${encodeURIComponent(ep.episode_code)}/visibility`, {
      privacy_status: visibility, confirm: true, expected_channel_id: channelId,
    })
    return `${ep.episode_code} is now ${visibilityLabel(visibility)} on YouTube.`
  })
}

// Remove waiting uploads from the queue.
async function removeSelectedFromQueue(): Promise<void> {
  const rows = [...dequeueRows.value]
  if (busy.value || !rows.length) return
  const count = `${rows.length} upload${rows.length === 1 ? '' : 's'}`
  const confirmed = await ask({
    title: `Remove ${count} from the upload queue?`,
    message: `${rows.map(ep => ep.episode_code).join(', ')}. These uploads have not started, so nothing has reached YouTube. `
      + 'The videos stay on this computer and can be queued again later. Uploads that start before their turn here are left running.',
    confirmLabel: `Remove ${rows.length} Upload${rows.length === 1 ? '' : 's'}`,
    danger: true,
  })
  if (!confirmed) return
  await runPerRow('Remove from upload queue', rows, async (ep, requestSlug) => {
    const job = queuedUploadJob(ep)
    if (!job) throw new Error('This upload has already started, so it was left running. Stop it in Jobs if you need to.')
    await post(`/projects/${requestSlug}/jobs/${encodeURIComponent(job.job_id)}/cancel`, {})
    queuedUploadCodes.delete(ep.episode_code)
    return `${ep.episode_code} was removed from the upload queue. Nothing was sent to YouTube.`
  })
}

// Re-finalize metadata through the Pipeline's YouTube Finalizer step.
async function refinalizeSelected(): Promise<void> {
  const rows = [...actionableSelection.value]
  if (busy.value || !rows.length) return
  const count = `${rows.length} episode${rows.length === 1 ? '' : 's'}`
  const confirmed = await ask({
    title: `Re-finalize metadata for ${count}?`,
    message: `${rows.map(ep => ep.episode_code).join(', ')}. Story Studio writes a new title, description and tags for each with this `
      + 'channel’s YouTube Finalizer preset and metadata template. Earlier versions are kept. YouTube is not changed — '
      + 'send a new version from Library with “Update YouTube”. The work runs as jobs and keeps going if you leave this page.',
    confirmLabel: `Re-Finalize ${rows.length} Episode${rows.length === 1 ? '' : 's'}`,
  })
  if (!confirmed) return
  const action = beginAction('bulk-run')
  const run: BulkRun = {
    label: 'Re-finalize metadata', total: rows.length, done: 0, failed: 0, stoppable: false, stopRequested: false, stopped: false, finished: false,
    note: 'Queueing… the jobs keep running in Jobs even if you leave this page.',
  }
  bulkRun.value = run
  const live = bulkRun.value
  const settle = (episodeId: string, kind: 'ok' | 'err', message: string) => {
    rowResults[episodeId] = { kind, message }
    if (kind === 'ok') live.done += 1
    else live.failed += 1
  }
  try {
    const result = await post<{
      jobs?: Array<{ episode_id: string }>
      reused_jobs?: Array<{ episode_id: string }>
      skipped?: Array<{ episode_id: string; reason: string }>
      blocked?: Array<{ episode_id: string; reason: string }>
    }>(`/projects/${action.slug}/pipeline/run-batch`, {
      episode_ids: rows.map(ep => ep.episode_code),
      steps: ['metadata'],
      force: true,
      operation_id: secureOperationId(),
    })
    if (!actionIsCurrent(action)) return
    for (const job of [...(result.jobs || []), ...(result.reused_jobs || [])]) {
      settle(job.episode_id, 'ok', `${job.episode_id}: YouTube Finalizer queued. Follow it in Jobs; the new version appears in YouTube Finalizer.`)
    }
    for (const item of [...(result.skipped || []), ...(result.blocked || [])]) settle(item.episode_id, 'err', `${item.episode_id}: ${item.reason}`)
    live.note = 'Queued work continues in Jobs.'
  } catch (error: any) {
    if (!actionIsCurrent(action)) return
    const blocked: Array<{ episode_id: string; reason: string }> = error?.data?.blocked || []
    for (const item of blocked) settle(item.episode_id, 'err', `${item.episode_id}: ${item.reason}`)
    const detail = error?.data?.detail || error?.message || 'The YouTube Finalizer could not be queued.'
    live.note = /nothing was started/i.test(detail) ? detail : `Nothing was started. ${detail}`
  } finally {
    live.finished = true
    if (actionIsCurrent(action)) busy.value = ''
  }
}

const remoteBlocked = computed(() => {
  if (overviewError.value) return 'YouTube connection status is unavailable, so remote checks are paused.'
  if (!channelStatus.value) return 'No YouTube channel is assigned yet, so nothing can be checked on YouTube.'
  if (channelStatus.value === 'reconnect_required') return 'Reconnect this channel in Settings before checking anything on YouTube.'
  if (channelStatus.value === 'scope_upgrade_required') return 'This channel needs its permissions upgraded in Settings before Story Studio can read from YouTube.'
  if (quotaExhausted.value) return 'Today’s allowance for this Google Cloud project is used up. Checking resumes after it resets.'
  return ''
})

const scheduleBlocked = computed(() => {
  if (overviewError.value) return 'YouTube connection status is unavailable, so scheduling is paused.'
  if (!channelStatus.value) return 'No YouTube channel is assigned yet, so no video can be scheduled.'
  if (channelStatus.value === 'reconnect_required') return 'Reconnect this channel in Settings before scheduling a video.'
  if (channelStatus.value === 'scope_upgrade_required') return 'This channel needs its permissions upgraded in Settings before Story Studio can schedule a video.'
  if (quotaUnavailableReason.value === 'ledger_unreadable') return 'Provider writes are paused until the local allowance record is repaired.'
  if (quotaExhausted.value) return 'Today’s allowance for this Google Cloud project is used up. Scheduling resumes after it resets.'
  return ''
})

const planBlocked = computed(() => {
  if (overviewError.value) return 'YouTube channel assignment is unavailable, so local dates cannot be assigned safely.'
  if (!channelStatus.value || !assignedChannel.value) return 'Assign a YouTube channel before using its upload plan.'
  return ''
})

/**
 * Why this episode cannot be uploaded again, or '' when it can be.
 *
 * Mirrors the route's in-flight refusal exactly: a video id means it exists on
 * YouTube whatever the lifecycle says, and the open lifecycles mean an attempt
 * is still running.
 */
const alreadyPublished = computed(() => {
  // The ROUTE's reason, rendered. The page used to re-derive this ladder in its
  // own order with its own wording, so the two could disagree about both
  // whether to refuse and what to say (tell 7b — one rule, two implementations).
  const episode = episodes.value.find(ep => ep.episode_code === previewedEpisode.value)
  if (!episode) return ''
  if (episode.blocked_reason) return episode.blocked_reason
  const localUpload = uploadState(episode)
  if (localUpload === 'queued') return `${episode.episode_code} already has an upload queued.`
  if (localUpload === 'running') return `${episode.episode_code} is already uploading.`
  if (localUpload === 'unknown') return `Story Studio cannot verify ${episode.episode_code}'s local upload state, so another upload is blocked.`
  if (localUpload === 'succeeded') return `${episode.episode_code} already completed an upload.`
  const publication = publicationState(episode)
  if (publication === 'unknown') return `Story Studio cannot verify ${episode.episode_code}'s YouTube publication state, so another upload is blocked.`
  if (publication === 'failed' || publication === 'rejected') {
    const remoteId = episode.remote_video_id || episode.operation?.video_id
    return episode.has_remote_video || remoteId
      ? `${episode.episode_code} has a ${PUBLICATION_LABELS[publication].toLowerCase()} YouTube record${remoteId ? ` for ${remoteId}` : ''}. Refresh its status before uploading again.`
      : ''
  }
  if (publication !== 'unpublished') return `${episode.episode_code} is already on YouTube (${PUBLICATION_LABELS[publication].toLowerCase()}).`
  return ''
})


async function load(): Promise<void> {
  const requestedSlug = slug.value
  const revision = ++loadRevision
  if (!episodes.value.length) loading.value = true
  loadError.value = ''
  const [opsResult, overviewResult] = await Promise.allSettled([
      get<{ episodes: PublishableEpisode[]; total: number }>(`/projects/${requestedSlug}/youtube/publishable`),
      get<any>(`/projects/${requestedSlug}/youtube/overview`),
  ])
  if (revision !== loadRevision || requestedSlug !== slug.value) return
  try {
    if (opsResult.status === 'rejected') throw opsResult.reason
    const ops = opsResult.value
    episodes.value = ops.episodes
    total.value = ops.total ?? ops.episodes.length
    // A reloaded row that shows the job (or a finished upload) replaces the
    // local marker. A row that does not — job store unreadable, channel
    // changed — keeps it: the server has no queue-time duplicate guard, so
    // this marker is what stands between two clicks and two uploads.
    for (const code of [...queuedUploadCodes]) {
      const row = episodes.value.find(ep => ep.episode_code === code)
      const state = row?.local?.upload?.state
      const known = state === 'queued' || state === 'running' || state === 'succeeded' || state === 'failed'
      if (known || row?.operation || row?.has_remote_video || row?.remote_video_id) queuedUploadCodes.delete(code)
    }
    if (overviewResult.status === 'fulfilled') {
      const overview = overviewResult.value
      overviewError.value = ''
      assignedChannel.value = overview?.assigned_channel ?? null
      channelStatus.value = assignedChannel.value?.status ?? ''
      quotaUnavailableReason.value = overview?.quota_unavailable_reason ?? ''
    // Only the bucket a status check is charged to matters here.
      quotaExhausted.value = (overview?.quota?.buckets?.other_endpoints?.remaining ?? 1) <= 0
    // The upload route checks `video_uploads`, a DIFFERENT bucket with a much
    // smaller limit. Gating Upload on `other_endpoints` meant the page could
    // offer an upload the route was about to refuse, and hide one it would have
    // accepted.
      uploadQuotaExhausted.value = (overview?.quota?.buckets?.video_uploads?.remaining ?? 1) <= 0
    } else {
      const error = overviewResult.reason as any
      overviewError.value = error?.data?.detail || error?.message || 'YouTube connection status could not be loaded.'
      assignedChannel.value = null
      channelStatus.value = ''
      quotaUnavailableReason.value = 'overview_unavailable'
      quotaExhausted.value = false
      uploadQuotaExhausted.value = false
    }
    // A row that left the list leaves the selection; every other selected row
    // stays, and each bulk action re-checks whether it still applies.
    selectedCodes.value = selectedCodes.value.filter(code => episodes.value.some(ep => ep.episode_code === code))
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load this channel’s uploads.'
  } finally {
    if (revision === loadRevision && requestedSlug === slug.value) loading.value = false
  }
}

async function refreshList(): Promise<void> {
  refreshingList.value = true
  try {
    await load()
    // A deliberate refresh is the in-page recovery for a queued marker no
    // reload can confirm (the job was deleted before it wrote anything): the
    // fresh list is the owner's answer, and it is the same list Upload
    // admission will check again server-side.
    queuedUploadCodes.clear()
  } finally { refreshingList.value = false }
}

function beginAction(value: string): { revision: number; slug: string } {
  const revision = ++actionRevision
  busy.value = value
  return { revision, slug: slug.value }
}
function actionIsCurrent(action: { revision: number; slug: string }): boolean {
  return action.revision === actionRevision && action.slug === slug.value
}

async function refresh(op: Operation): Promise<void> {
  const action = beginAction(op.operation_id)
  delete rowResults[op.episode_code]
  try {
    const res = await post<{ state: { lifecycle: string; processing?: { provider_status?: string } }; persisted: boolean }>(
      `/projects/${action.slug}/youtube/operations/${op.operation_id}/refresh`, {},
    )
    if (!actionIsCurrent(action)) return
    // A status we could not get is not a verdict, and the copy says so. An empty
    // answer is not proof of a removal either: a sign-in that cannot see this
    // video answers the same way, so only a word YouTube says about the video
    // (deleted) is reported as one.
    rowResults[op.episode_code] = res.state.processing?.provider_status === 'deleted'
      ? { kind: 'warn', message: `${op.episode_code}: YouTube says this video was deleted or removed.${res.persisted ? '' : ' Its earlier final answer is kept.'}` }
      : res.state.processing?.provider_status === 'not_found'
        ? { kind: 'warn', message: `${op.episode_code}: YouTube answered without this video. That is not proof it is gone; its last confirmed publication is kept. Check again, or look in YouTube Studio.` }
        : res.state.lifecycle === 'status_unavailable'
          ? { kind: 'warn', message: res.state.processing?.provider_status
            ? `${op.episode_code}: YouTube reported a status Story Studio does not recognise (${res.state.processing.provider_status}).`
            : `${op.episode_code}: YouTube did not return this video. Its last known state is kept.` }
          : { kind: 'ok', message: `${op.episode_code}: ${lifecycleLabel(res.state.lifecycle)}.` }
    await load()
  } catch (error: any) {
    if (!actionIsCurrent(action)) return
    rowResults[op.episode_code] = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not check that video.' }
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

async function forgetUpload(ep: PublishableEpisode): Promise<void> {
  const expectedChannelId = assignedChannel.value?.channel_id
  const expectedVideoId = associatedVideoId(ep)
  if (busy.value || !expectedChannelId || !expectedVideoId) return
  const requestedSlug = slug.value
  const confirmationAction = beginAction(`forget-${ep.episode_code}`)
  const confirmed = await ask({
    title: `Allow ${ep.episode_code} to be uploaded again?`,
    message: `Use this only after you deleted ${expectedVideoId} on YouTube and verified it is gone. Story Studio will remove this local upload association; it will not check or delete anything on YouTube. The next upload creates a new YouTube link.`,
    confirmLabel: 'Remove Upload Association',
  })
  if (!actionIsCurrent(confirmationAction)) return
  if (!confirmed) { busy.value = ''; return }
  if (slug.value !== requestedSlug || assignedChannel.value?.channel_id !== expectedChannelId
    || associatedVideoId(ep) !== expectedVideoId) { busy.value = ''; return }
  try {
    await post(`/projects/${requestedSlug}/youtube/episodes/${encodeURIComponent(ep.episode_code)}/forget-upload`, {
      confirm: true,
      expected_channel_id: expectedChannelId,
      expected_video_id: expectedVideoId,
    })
    if (!actionIsCurrent(confirmationAction)) return
    rowResults[ep.episode_code] = {
      kind: 'ok',
      message: `${ep.episode_code}'s local upload association was removed. YouTube was not changed. Review the upload again before queueing.`,
    }
    await load()
  } catch (error: any) {
    if (!actionIsCurrent(confirmationAction)) return
    rowResults[ep.episode_code] = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not remove that upload association.' }
  } finally {
    if (actionIsCurrent(confirmationAction)) busy.value = ''
  }
}

/**
 * Upload. The only control in this product that puts a video on YouTube.
 *
 * Confirmed by name — the episode AND the channel — because the two ways to get
 * this wrong are uploading the wrong episode and uploading to the wrong
 * channel, and neither is undoable: YouTube has no replace.
 */
async function upload(episodeCode: string): Promise<void> {
  // The thumbnail is required (2026-10-07) unless this channel's "Thumbnail present" safety check is
  // Off or Warn (1.4.301); the upload job applies the same switch.
  if (timingDirty.value) return
  if (thumbnailRequired.value && (previewed.value?.thumbnail.state !== 'selected' || thumbnailImageUnavailable.value)) return
  // An unsaved edit is an edit the owner believes is on its way to YouTube.
  // Uploading the reviewed payload instead would send something they did not
  // approve, so the upload stops here rather than quietly dropping it.
  if (canEditMetadata.value && (!draftSaved.value || draftTitleInvalid.value || draftDescriptionInvalid.value)) {
    rowResults[episodeCode] = {
      kind: 'err',
      message: draftTitleInvalid.value || draftDescriptionInvalid.value
        ? 'Fix the title or description before uploading.'
        : 'Save your title and description changes before uploading.',
    }
    return
  }
  const requestedSlug = slug.value
  const expectedChannelId = assignedChannel.value?.channel_id
  const expectedChannelTitle = assignedChannel.value?.title
  const expectedPackageRevision = previewed.value?.package_revision
  const expectedSourceRevision = previewed.value?.source?.revision
  const expectedThumbnailFilename = previewed.value?.thumbnail.state === 'selected'
    ? previewed.value.thumbnail.filename || null
    : null
  const expectedPrivacyStatus = previewed.value?.status.privacyStatus || 'private'
  const expectedPublishAt = previewed.value?.status.publishAt
  if (!expectedPackageRevision || !expectedSourceRevision) {
    rowResults[episodeCode] = { kind: 'err', message: 'Refresh this review so Story Studio can verify the exact metadata and video file.' }
    return
  }
  if (expectedPublishAt && !isFutureIso(expectedPublishAt)) {
    timingDirty.value = true
    timingError.value = 'This scheduled time has passed. Choose and review a new future time before uploading.'
    return
  }
  const timingConfirmation = expectedPublishAt
    ? `Scheduled for ${formatZonedWhen(expectedPublishAt, timingTimezone.value)} (${expectedPublishAt}). `
    : 'This video will stay private until you schedule or publish it. '
  // The social posts are part of the SAME confirmation, because the owner
  // ticked them in the same dialog. Leaving them out of this sentence would
  // make the last thing they read before pressing Upload incomplete.
  const socialConfirmation = socialChosen.value.length
    ? `It will also post to ${socialChosen.value.map(platformLabelFor).join(', ')}. `
    : ''
  const confirmationAction = beginAction('confirm-upload')
  const confirmed = await ask({
    title: `Upload ${episodeCode} to YouTube?`,
    message: `This uploads ${episodeCode} to ${expectedChannelTitle || 'the assigned channel'} (${expectedChannelId || 'unknown'}). `
      + timingConfirmation
      + socialConfirmation
      + `Thumbnail: ${expectedThumbnailFilename || 'none selected'}. `
      + 'A video cannot be replaced once uploaded — only deleted and uploaded again under a new link.',
    confirmLabel: 'Upload',
  })
  if (!actionIsCurrent(confirmationAction)) return
  if (!confirmed) { busy.value = ''; return }
  if (slug.value !== requestedSlug || previewedEpisode.value !== episodeCode
    || previewed.value?.package_revision !== expectedPackageRevision
    || previewed.value?.source?.revision !== expectedSourceRevision
    || previewed.value?.status.privacyStatus !== expectedPrivacyStatus
    || previewed.value?.status.publishAt !== expectedPublishAt
    || (previewed.value?.thumbnail.state === 'selected' ? previewed.value.thumbnail.filename || null : null) !== expectedThumbnailFilename
    || assignedChannel.value?.channel_id !== expectedChannelId) { busy.value = ''; return }
  busy.value = 'upload'
  const action = confirmationAction
  delete rowResults[episodeCode]
  const uploadBody = {
    episode_code: episodeCode,
    confirm: true,
    expected_channel_id: expectedChannelId,
    expected_package_revision: expectedPackageRevision,
    expected_source_revision: expectedSourceRevision,
    thumbnail_filename: expectedThumbnailFilename,
    privacy_status: expectedPrivacyStatus,
    ...(expectedPublishAt ? { publish_at: expectedPublishAt } : {}),
  }
  try {
    const res = await postUploadWithAcknowledgements(requestedSlug, uploadBody, episodeCode)
    if (!actionIsCurrent(action)) return
    rowResults[episodeCode] = {
      kind: 'ok',
      message: `Uploading ${episodeCode} to ${res.channel_id}. Progress appears in Jobs.`
        + (socialChosen.value.length ? ' Posting to social platforms too.' : ''),
    }
    // Separate job, separate receipts, and it starts only after YouTube
    // accepted the upload — so a social failure can never be read as a
    // failed YouTube upload, or the other way round.
    void postToSocial(episodeCode)
    // The job is queued the moment the route answers. The list reload that
    // follows is bookkeeping, and the dialog waited on it — with a large
    // project that was seconds of "Uploading…" after the upload had started.
    queuedUploadCodes.add(episodeCode)
    void load()
  } catch (error: any) {
    if (!actionIsCurrent(action)) return
    rowResults[episodeCode] = uploadFailure(error, episodeCode, 'Failed to start that upload.')
    if (rowResults[episodeCode].kind === 'info') queuedUploadCodes.add(episodeCode)
    // The queue may know something this list does not (e.g. a first click
    // already queued it) — show what is actually there.
    void load()
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

function metadataReadiness(value: Preview): string {
  const changes = value.modifications.length
  const warnings = value.warnings.length
  if (warnings) return `Warnings · ${warnings} warning${warnings === 1 ? '' : 's'}${changes ? ` · ${changes} reviewed change${changes === 1 ? '' : 's'}` : ''}`
  if (!changes) return 'Ready · no changes needed'
  return `Ready · ${changes} reviewed change${changes === 1 ? '' : 's'}`
}
function bulkTimingLabel(item: BulkUploadReview): string {
  const publishAt = item.preview?.status.publishAt
  return publishAt ? formatZonedWhen(publishAt, item.timezone) : 'Keep private'
}
function bulkReviewStateLabel(item: BulkUploadReview): string {
  if (item.state === 'pending') return item.preview ? 'Checking thumbnail' : 'Reviewing'
  if (item.state === 'reviewed') return 'Reviewed'
  if (item.state === 'queueing') return 'Queueing'
  if (item.state === 'queued') return 'Queued'
  return 'Needs attention'
}
const queueableBulkReviews = computed(() => bulkReviews.value.filter(item => item.state === 'reviewed'))
const bulkQueueInBackground = computed(() => !bulkReviewOpen.value && (busy.value === 'bulk-upload' || (bulkQueueWasStopped.value && bulkReviews.value.length > 0)))
const bulkQueuedCount = computed(() => bulkReviews.value.filter(item => item.state === 'queued').length)
const bulkQueueTotal = computed(() => bulkReviews.value.filter(item => item.state !== 'error').length)
const previewedQueued = computed(() => queuedUploadCodes.has(previewedEpisode.value))

function bulkThumbnailLoaded(item: BulkUploadReview): void {
  if (item.state === 'pending' && item.preview?.thumbnail.state === 'selected') item.state = 'reviewed'
}
function bulkThumbnailUnavailable(item: BulkUploadReview): void {
  if (item.state === 'queued' || item.state === 'queueing') return
  item.state = 'error'
  item.error = 'This thumbnail is selected, but its preview is unavailable. Open the individual upload review and choose a viewable image.'
}

function closeBulkReview(): void {
  const opener = bulkReviewOpener.value
  if (busy.value === 'bulk-upload') {
    // Dismiss, don't cancel: the reviewed rows keep queueing (Stop queueing
    // stays on the page) and the rows already queued are jobs by now.
    bulkReviewDismissedWhileQueueing.value = true
    bulkReviewOpen.value = false
    void nextTick(() => {
      if (opener?.isConnected && !(opener as HTMLButtonElement).disabled) opener.focus()
      else uploadListHeading.value?.focus()
    })
    return
  }
  if (busy.value === 'bulk-preview') {
    actionRevision += 1
    busy.value = ''
  }
  bulkReviewOpener.value = null
  bulkReviewOpen.value = false
  bulkReviews.value = []
  bulkReviewDismissedWhileQueueing.value = false
  bulkQueueStopRequested.value = false
  bulkQueueWasStopped.value = false
  void nextTick(() => {
    if (opener?.isConnected && !(opener as HTMLButtonElement).disabled) opener.focus()
    else uploadListHeading.value?.focus()
  })
}

function reopenBulkReview(): void {
  bulkReviewDismissedWhileQueueing.value = false
  bulkReviewOpen.value = true
  void nextTick(() => bulkReviewHeading.value?.focus())
}

async function reviewSelectedUploads(event?: Event): Promise<void> {
  if (busy.value || !selectedUploadEpisodes.value.length || !assignedChannel.value) return
  if (event?.currentTarget instanceof HTMLElement) bulkReviewOpener.value = event.currentTarget
  const channel = { ...assignedChannel.value }
  const selected = [...selectedUploadEpisodes.value].sort((a, b) => episodeNumber(a) - episodeNumber(b))
  bulkReviews.value = selected.map(ep => ({
    episode_code: ep.episode_code,
    title: ep.title,
    channel_id: channel.channel_id,
    channel_title: channel.title,
    timezone: isFutureIso(ep.plan?.scheduled_at) ? ep.plan?.timezone || deviceTimezone : deviceTimezone,
    state: 'pending',
  }))
  bulkReviewOpen.value = true
  await nextTick()
  bulkReviewHeading.value?.focus()
  const action = beginAction('bulk-preview')
  for (const item of bulkReviews.value) {
    if (!actionIsCurrent(action)) return
    const episode = episodes.value.find(ep => ep.episode_code === item.episode_code)
    if (!episode) {
      item.state = 'error'
      item.error = 'This episode is no longer available.'
      continue
    }
    const publishAt = isFutureIso(episode.plan?.scheduled_at) ? episode.plan.scheduled_at : undefined
    try {
      const result = normalizePreview(await post<Preview>(`/projects/${action.slug}/youtube/preview`, {
        episode_code: item.episode_code,
        privacy_status: 'private',
        ...(publishAt ? { publish_at: publishAt } : {}),
      }))
      if (!actionIsCurrent(action)) return
      item.preview = result
      if (!result.package_revision || !result.source?.revision || !result.source.filename) {
        item.state = 'error'
        item.error = 'Story Studio could not verify the exact metadata and video file. Refresh and review this row again.'
      } else if (result.thumbnail.state === 'unavailable') {
        item.state = 'error'
        item.error = result.thumbnail.reason || 'Choose an available thumbnail in the individual upload review.'
      } else if (result.thumbnail.state === 'selected' && !result.thumbnail.url) {
        item.state = 'error'
        item.error = 'This thumbnail is selected, but its preview is unavailable. Open the individual upload review and choose a viewable image.'
      } else if (result.thumbnail.state === 'selected') {
        // A selected filename is not a reviewed image. The native image load
        // event promotes this row to Reviewed; an error keeps it out of Queue.
        item.state = 'pending'
      } else {
        // No thumbnail: the upload job refuses (2026-10-07), so never queue it.
        item.state = 'error'
        item.error = 'A thumbnail is required. Open the individual upload review and choose one.'
      }
    } catch (error: any) {
      if (!actionIsCurrent(action)) return
      item.state = 'error'
      item.error = error?.data?.detail || error?.message || 'Could not review this upload.'
    }
  }
  if (actionIsCurrent(action)) busy.value = ''
}

async function queueReviewedUploads(): Promise<void> {
  if (busy.value || !queueableBulkReviews.value.length) return
  const requestedSlug = slug.value
  const expectedChannelId = assignedChannel.value?.channel_id
  if (!expectedChannelId) return
  bulkQueueStopRequested.value = false
  bulkQueueWasStopped.value = false
  const action = beginAction('bulk-upload')
  const reviewed = [...queueableBulkReviews.value]
  for (const item of reviewed) {
    if (!actionIsCurrent(action)) return
    if (bulkQueueStopRequested.value) { bulkQueueWasStopped.value = true; break }
    const preview = item.preview
    const episode = episodes.value.find(ep => ep.episode_code === item.episode_code)
    if (!preview || !episode || !isUploadEligible(episode) || assignedChannel.value?.channel_id !== item.channel_id) {
      item.state = 'error'
      item.error = 'This row changed after review. Review the selected uploads again.'
      continue
    }
    if (preview.status.publishAt && !isFutureIso(preview.status.publishAt)) {
      item.state = 'error'
      item.error = 'This scheduled time has passed. Review a new future time before uploading.'
      continue
    }
    const expectedPackageRevision = preview.package_revision
    const expectedSourceRevision = preview.source?.revision
    if (!expectedPackageRevision || !expectedSourceRevision) {
      item.state = 'error'
      item.error = 'The reviewed metadata or video-file check is missing. Review this row again.'
      continue
    }
    item.state = 'queueing'
    try {
      const uploadBody = {
        episode_code: item.episode_code,
        confirm: true,
        expected_channel_id: item.channel_id,
        expected_package_revision: expectedPackageRevision,
        expected_source_revision: expectedSourceRevision,
        thumbnail_filename: preview.thumbnail.state === 'selected' ? preview.thumbnail.filename || null : null,
        privacy_status: preview.status.privacyStatus,
        ...(preview.status.publishAt ? { publish_at: preview.status.publishAt } : {}),
      }
      const result = await postUploadWithAcknowledgements(requestedSlug, uploadBody, item.episode_code)
      if (!actionIsCurrent(action)) return
      item.state = 'queued'
      item.job_id = result.job_id
      queuedUploadCodes.add(item.episode_code)
      rowResults[item.episode_code] = { kind: 'ok', message: `Uploading ${item.episode_code} to ${result.channel_id}. Progress appears in Jobs.` }
    } catch (error: any) {
      if (!actionIsCurrent(action)) return
      const failure = uploadFailure(error, item.episode_code, 'Failed to queue this upload.')
      if (failure.kind === 'info') {
        // Already in the queue from an earlier click: that is the outcome we wanted.
        item.state = 'queued'
        queuedUploadCodes.add(item.episode_code)
        rowResults[item.episode_code] = failure
        continue
      }
      item.state = 'error'
      item.error = failure.message
      rowResults[item.episode_code] = failure
    }
  }
  if (actionIsCurrent(action)) {
    busy.value = ''
    selectedCodes.value = selectedCodes.value.filter(code =>
      !bulkReviews.value.some(item => item.episode_code === code && item.state === 'queued'))
    if (bulkReviewDismissedWhileQueueing.value && !bulkQueueWasStopped.value) {
      // The owner already left this review and every reviewed row was queued;
      // the rows live on as row results and Jobs.
      bulkReviewDismissedWhileQueueing.value = false
      bulkReviewOpener.value = null
      bulkReviews.value = []
      bulkQueueStopRequested.value = false
    }
    // Stopped while hidden: the reviews stay so the strip can say so and
    // bring the remaining Reviewed rows back with Show.
    await load()
  }
}

/**
 * The two upload refusals the owner may click through, and the field each is
 * acknowledged by. Anything else returns null and is re-thrown, so a plain
 * failure still reaches the row with its own reason.
 *
 * ONE function rather than a chain of checks, deliberately: the caller's
 * `await` stays exactly one deep, which is what the page's own settle timing
 * was written against.
 *
 *  - Owner decision #7 (2026-09-20): another project has already uploaded this
 *    episode code to this channel. A confirmable warning rather than a refusal,
 *    because two series may legitimately share one channel and both have an
 *    "Episode 1".
 *  - Owner-approved 2026-10-19: this channel is not verified for videos over 15
 *    minutes. YouTube would ACCEPT the upload and then abandon it as "too long"
 *    — Domnak DM0001–DM0003 — so the refusal is a real one; the owner may still
 *    know better (a verification in progress, a video about to be shortened).
 */
/**
 * Post an upload, and when the route asks a confirmable question (episode code claimed elsewhere,
 * channel not verified for long videos, final check failed), ask the owner and resend the SAME
 * reviewed body with every answer given so far. More than one question can apply to one upload,
 * so this keeps asking until the route accepts or the owner declines. Nothing else in the request
 * changes.
 */
async function postUploadWithAcknowledgements(
  projectSlug: string,
  uploadBody: Record<string, unknown>,
  episodeCode: string,
): Promise<{ job_id: string; channel_id: string }> {
  let acknowledged: Record<string, true | string> = {}
  for (let round = 0; ; round++) {
    try {
      return await post<{ job_id: string; channel_id: string }>(
        `/projects/${projectSlug}/youtube/upload`, { ...uploadBody, ...acknowledged },
      )
    } catch (error: any) {
      if (round >= 3) throw error
      const acknowledgement = await confirmableUploadAcknowledgement(error, episodeCode)
      if (!acknowledgement) throw error
      acknowledged = { ...acknowledged, ...acknowledgement }
    }
  }
}

async function confirmableUploadAcknowledgement(
  error: any,
  episodeCode: string,
): Promise<Record<string, true | string> | null> {
  if (error?.data?.code === 'YOUTUBE_EPISODE_CODE_CLAIMED_ELSEWHERE') {
    const confirmed = await ask({
      title: `${episodeCode} is already on this channel`,
      message: String(error.data.detail || 'Another Story Studio channel has already uploaded this episode code to this YouTube channel.'),
      confirmLabel: 'Upload Anyway',
    })
    return confirmed ? { acknowledge_foreign_episode: true } : null
  }
  if (error?.data?.code === 'YOUTUBE_CHANNEL_NOT_VERIFIED_FOR_LONG_VIDEOS') {
    const confirmed = await ask({
      title: `${episodeCode} is longer than this channel can keep`,
      message: String(error.data.detail || 'This channel is not verified for videos over 15 minutes.'),
      confirmLabel: 'Upload Anyway',
    })
    return confirmed ? { acknowledge_unverified_channel: true } : null
  }
  if (await confirmFinalCheck(error, episodeCode)) {
    return { acknowledge_final_check: true, ...reviewedFinalCheckIdentity(error) }
  }
  return null
}

/**
 * The exact check the owner just answered about, so the acknowledgement binds to that verdict about
 * those bytes rather than to whatever verdict is stored when the upload is admitted. The route
 * refuses the answer if it no longer matches — see `YOUTUBE_FINAL_CHECK_CHANGED`.
 */
function reviewedFinalCheckIdentity(error: any): Record<string, string> {
  const checkedAt = error?.data?.final_check?.identity?.checked_at
  return typeof checkedAt === 'string' && checkedAt ? { final_check_checked_at: checkedAt } : {}
}

/**
 * The final check refused this upload. Same click-through as the episode-number claim above: the
 * answer is the owner's, the route records it on the job, and nothing here blocks an upload for good.
 */
async function confirmFinalCheck(error: any, episodeCode: string): Promise<boolean> {
  if (error?.data?.code !== 'YOUTUBE_FINAL_CHECK_FAILED') return false
  return ask({
    title: `${episodeCode} did not pass its final check`,
    message: String(error.data.detail || 'The finished video did not pass its final check.'),
    confirmLabel: 'Upload Anyway',
  })
}

/**
 * Start measuring this episode's finished video now, without rendering it again.
 *
 * The route answers 202 before any ffmpeg work starts — measuring a 2–2.5 h final takes minutes —
 * so nothing here waits for a verdict. The row says "checking…" and picks the result up on a later
 * load (see `syncFinalCheckPoll`).
 */
async function runFinalCheck(ep: PublishableEpisode): Promise<void> {
  const code = ep.episode_code
  const requestedSlug = slug.value
  busy.value = `final-check-${code}`
  delete rowResults[code]
  try {
    const result = await post<{ started: boolean; running: boolean }>(
      `/projects/${requestedSlug}/youtube/final-check`, { episode_code: code },
    )
    if (slug.value !== requestedSlug) return
    rowResults[code] = {
      kind: 'info',
      message: result.started
        ? `Measuring ${code}'s finished video. It takes a few minutes, and the row says so while it runs.`
        : `${code} is already being measured. Its verdict appears on the row when the check finishes.`,
    }
  } catch (error: any) {
    if (slug.value !== requestedSlug) return
    rowResults[code] = uploadFailure(error, code, 'Failed to start the final check.')
  } finally {
    if (slug.value === requestedSlug) busy.value = ''
    void load()
  }
}

async function scheduleExisting(): Promise<void> {
  if (reviewIntent.value !== 'schedule' || timingDirty.value || !previewed.value?.status.publishAt) return
  const episode = selectedEpisode.value
  const publishAt = previewed.value.status.publishAt
  if (!episode || !canScheduleExisting(episode) || !isFutureIso(publishAt)) {
    timingDirty.value = true
    timingError.value = 'Choose and review a future date before scheduling this video.'
    return
  }
  const expectedChannelId = assignedChannel.value?.channel_id
  const expectedChannelTitle = assignedChannel.value?.title
  const requestedSlug = slug.value
  const confirmationAction = beginAction('confirm-schedule')
  const confirmed = await ask({
    title: `Schedule ${episode.episode_code} on YouTube?`,
    message: `This checks and schedules the existing video on ${expectedChannelTitle || 'the assigned channel'} (${expectedChannelId || 'unknown'}) for ${formatZonedWhen(publishAt, timingTimezone.value)} (${publishAt}). YouTube will refuse any video that is not private. It does not upload the video again.`,
    confirmLabel: 'Schedule Video',
  })
  if (!actionIsCurrent(confirmationAction)) return
  if (!confirmed) { busy.value = ''; return }
  if (slug.value !== requestedSlug || previewedEpisode.value !== episode.episode_code
    || previewed.value?.status.publishAt !== publishAt
    || assignedChannel.value?.channel_id !== expectedChannelId) { busy.value = ''; return }
  busy.value = 'schedule'
  delete rowResults[episode.episode_code]
  try {
    const result = await post<{ episode_code: string; video_id: string; scheduled_at: string }>(
      `/projects/${requestedSlug}/youtube/episodes/${encodeURIComponent(episode.episode_code)}/schedule`,
      { confirm: true, expected_channel_id: expectedChannelId, publish_at: publishAt },
    )
    if (!actionIsCurrent(confirmationAction)) return
    rowResults[episode.episode_code] = {
      kind: 'ok',
      message: `${result.episode_code} is scheduled for ${formatZonedWhen(result.scheduled_at, timingTimezone.value)}.`,
    }
    closeReview(false)
    await load()
  } catch (error: any) {
    if (!actionIsCurrent(confirmationAction)) return
    rowResults[episode.episode_code] = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not schedule that video.' }
  } finally {
    if (actionIsCurrent(confirmationAction)) busy.value = ''
  }
}

async function preview(episodeCode: string, event?: Event, intent: ReviewIntent = 'upload'): Promise<void> {
  if (event?.currentTarget instanceof HTMLElement) reviewOpener.value = event.currentTarget
  const action = beginAction(`preview-${episodeCode}`)
  delete rowResults[episodeCode]
  // Drop the previous payload BEFORE asking for the next one. Leaving it up
  // while a different episode's request is in flight — or after it fails —
  // shows one episode's exact payload while the reader believes they asked
  // about another.
  previewed.value = null
  previewedEpisode.value = ''
  thumbnailImageUnavailable.value = false
  thumbnailError.value = ''
  // The draft belongs to the payload that was just dropped. Leaving one
  // episode's edited text in the fields while another episode's review opens
  // is a cross-episode leak of exactly the kind this page has been bitten by.
  draftTitle.value = ''
  draftDescription.value = ''
  draftSaved.value = true
  draftEverSaved.value = false
  draftSuggestion.value = null
  draftError.value = ''
  reviewIntent.value = intent
  customDateTime.value = ''
  customMinimum.value = localDateTimeValue(new Date(Date.now() + 60_000))
  timingError.value = ''
  const episode = episodes.value.find(item => item.episode_code === episodeCode)
  const initialMode: TimingMode = isFutureIso(episode?.plan?.scheduled_at) ? 'planned' : 'private'
  timingMode.value = initialMode
  timingDirty.value = true
  // Open now, in its building state, so the click is acknowledged before the
  // server hashes the video. Close during this abandons the request.
  previewedEpisode.value = episodeCode
  await nextTick()
  if (!actionIsCurrent(action)) return
  previewHeading.value?.focus()
  try {
    const timing = initialMode === 'planned'
      ? { privacy_status: 'private' as const, publish_at: episode!.plan!.scheduled_at }
      : { privacy_status: 'private' as const }
    const result = await post<Preview>(`/projects/${action.slug}/youtube/preview`, {
      // No `mark_as_ai_generated` here. The server resolves it from the
      // project's own setting; sending it was how the preview came to show a
      // disclosure the owner had turned off.
      episode_code: episodeCode, ...timing,
    })
    if (!actionIsCurrent(action)) return
    previewed.value = normalizePreview(result)
    previewedEpisode.value = episodeCode
    draftTitle.value = previewed.value.snippet.title
    draftDescription.value = previewed.value.snippet.description || ''
    draftSaved.value = true
    // A fresh review has not been saved yet: what is on screen is the payload
    // as it arrived, not an edit the owner made and kept.
    draftEverSaved.value = false
    draftSuggestion.value = null
    draftError.value = ''
    timingTimezone.value = initialMode === 'planned' ? episode?.plan?.timezone || deviceTimezone : deviceTimezone
    timingDirty.value = false
    // Receipts belong to THIS episode, so they are read after the payload it
    // belongs to is on screen, not before.
    void loadSocialState(episodeCode)
    await nextTick()
    previewHeading.value?.focus()
  } catch (error: any) {
    if (!actionIsCurrent(action)) return
    // The reason belongs on the episode row, where the retry lives.
    closeReview()
    rowResults[episodeCode] = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not build the upload details.' }
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

async function selectThumbnail(filename: string, event?: Event): Promise<void> {
  if (!previewed.value || !previewedEpisode.value || busy.value || alreadyPublished.value
    || (previewed.value.thumbnail.filename === filename && !thumbnailImageUnavailable.value)) return
  const restoreFocus = event?.currentTarget instanceof HTMLElement && event.currentTarget === document.activeElement
  const episodeCode = previewedEpisode.value
  const action = beginAction(`thumbnail-${episodeCode}`)
  thumbnailError.value = ''
  try {
    const result = await post<Preview>(`/projects/${action.slug}/youtube/preview`, {
      episode_code: episodeCode,
      privacy_status: previewed.value.status.privacyStatus,
      ...(previewed.value.status.publishAt ? { publish_at: previewed.value.status.publishAt } : {}),
      thumbnail_filename: filename,
    })
    if (!actionIsCurrent(action) || previewedEpisode.value !== episodeCode) return
    previewed.value = normalizePreview(result)
    thumbnailImageUnavailable.value = false
  } catch (error: any) {
    if (!actionIsCurrent(action) || previewedEpisode.value !== episodeCode) return
    thumbnailError.value = error?.data?.detail || error?.message || 'Could not select that thumbnail.'
  } finally {
    if (actionIsCurrent(action)) {
      busy.value = ''
      if (restoreFocus) {
        await nextTick()
        const option = [...(previewHeading.value?.closest('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('.thumbnail-option') || [])]
          .find(button => button.dataset.thumbnailFilename === filename)
        ;(option || previewHeading.value)?.focus()
      }
    }
  }
}

/**
 * Send one metadata edit to the server.
 *
 * `patch` says WHICH fields this edit is about. A field that is not in the
 * patch is left exactly as it is on disk; a `description: null` is an EXPLICIT
 * RESET — "put the generated description back" — which is a different thing
 * from an empty description, and the server keeps them apart.
 */
async function submitDraft(patch: { title?: string; description?: string | null }): Promise<void> {
  if (!previewed.value || !previewedEpisode.value || busy.value || !canEditMetadata.value) return
  const episodeCode = previewedEpisode.value
  const action = beginAction(`save-draft-${episodeCode}`)
  draftError.value = ''
  draftSuggestion.value = null
  // What the panel showed before this edit, and what the owner had typed into
  // it. Both are needed afterwards: the answer replaces the fields with the
  // refreshed payload, and a field THIS EDIT DID NOT TOUCH must not lose the
  // owner's typing on the way (a restore of the description must not silently
  // wipe a title they had just rewritten).
  const shownTitle = previewed.value.snippet.title
  const shownDescription = previewed.value.snippet.description || ''
  const typedTitle = draftTitle.value
  const typedDescription = draftDescription.value
  try {
    // The save is a COMPARED write: the server rebuilds the package it
    // reviewed and refuses if anything changed underneath it. The revisions
    // sent here are the ones this review was built from.
    const result = await post<Preview>(`/projects/${action.slug}/youtube/metadata-overrides`, {
      episode_code: episodeCode,
      ...patch,
      privacy_status: previewed.value.status.privacyStatus,
      ...(previewed.value.status.publishAt ? { publish_at: previewed.value.status.publishAt } : {}),
      // Only an explicitly selected thumbnail is re-sent. Omitting the field
      // leaves the server's own auto-pick rule in place; sending `null` would
      // ask for NO thumbnail and change the payload the owner reviewed.
      ...(previewed.value.thumbnail.state === 'selected' && previewed.value.thumbnail.filename
        ? { thumbnail_filename: previewed.value.thumbnail.filename }
        : {}),
      ...(previewed.value.package_revision ? { expected_package_revision: previewed.value.package_revision } : {}),
      ...(previewed.value.source?.revision ? { expected_source_revision: previewed.value.source.revision } : {}),
    })
    if (!actionIsCurrent(action) || previewedEpisode.value !== episodeCode) return
    // The answer carries the REFRESHED package, built from the live sources
    // after the write. The draft is re-seeded from that snippet, so the text
    // on screen is the text YouTube will receive — never the raw draft
    // beside a different payload.
    previewed.value = normalizePreview(result)
    const nextTitle = previewed.value.snippet.title
    const nextDescription = previewed.value.snippet.description || ''
    // A field this edit did not mention keeps the owner's own unsaved typing
    // when there was any — and is then honestly UNSAVED, so the panel says so
    // instead of claiming the edit is done.
    draftTitle.value = patch.title === undefined && typedTitle !== shownTitle ? typedTitle : nextTitle
    draftDescription.value = patch.description === undefined && typedDescription !== shownDescription
      ? typedDescription
      : nextDescription
    draftSaved.value = (draftTitle.value === nextTitle && draftDescription.value === nextDescription)
    draftEverSaved.value = true
    draftError.value = ''
  } catch (error: any) {
    if (!actionIsCurrent(action) || previewedEpisode.value !== episodeCode) return
    draftError.value = error?.data?.detail || error?.message || 'Could not save those edits.'
    const suggestion = error?.data?.suggestion
    draftSuggestion.value = suggestion && typeof suggestion === 'object' ? {
      ...(typeof suggestion.title === 'string' ? { title: suggestion.title } : {}),
      ...(typeof suggestion.description === 'string' ? { description: suggestion.description } : {}),
    } : null
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

/** The Save button: the typed title and description, exactly as typed. */
function saveDraft(): void {
  if (draftTitleInvalid.value || draftDescriptionInvalid.value) return
  void submitDraft({ title: draftTitle.value, description: draftDescription.value })
}

/**
 * Put the GENERATED description back.
 *
 * The owner may want their own description for this upload, or the one the
 * script wrote. Both are legitimate, and the difference has to be the
 * owner's to make — so the generated text is offered as a choice, and
 * choosing it removes the override. An empty description is NOT this: it is
 * an empty description the owner asked for, and it stays that way until the
 * owner says otherwise.
 */
function restoreGeneratedDescription(): void {
  void submitDraft({ description: null })
}

/** Put the server's corrected text into the fields, for the owner to save. */
function applySuggestion(): void {
  const suggestion = draftSuggestion.value
  if (!suggestion) return
  if (typeof suggestion.title === 'string') draftTitle.value = suggestion.title
  if (typeof suggestion.description === 'string') draftDescription.value = suggestion.description
  draftSuggestion.value = null
  draftError.value = ''
}

watch([draftTitle, draftDescription], () => {
  if (previewed.value) {
    draftSaved.value = (draftTitle.value === previewed.value.snippet.title
      && draftDescription.value === (previewed.value.snippet.description || ''))
  }
})

// The shared Jobs stream is the refresh signal. Once a known upload leaves
// the queue, re-read local publishable state so the operation/publication
// receipt replaces transfer progress without any YouTube status request.
watch(
  () => episodes.value
    .map(ep => liveUploadJob(ep))
    .filter(job => job?.status === 'done' || job?.status === 'error')
    .map(job => `${job.job_id}:${job.status}`)
    .sort()
    .join('|'),
  (next, previous) => { if (next && next !== previous) void load() },
)

// A Jobs deep link arriving while the page is open. The page itself drops
// `episode_id` for `q`, and that removal must not clear the search.
watch(() => route.query.episode_id, (episode) => {
  if (typeof episode !== 'string') return
  filter.value = episode
  statusFilter.value = 'all'
})

watch(slug, () => {
  actionRevision += 1
  busy.value = ''
  refreshingList.value = false
  episodes.value = []
  total.value = 0
  assignedChannel.value = null
  channelStatus.value = ''
  overviewError.value = ''
  quotaUnavailableReason.value = ''
  quotaExhausted.value = false
  uploadQuotaExhausted.value = false
  const view = readPublishView(route.query)
  filter.value = view.q
  statusFilter.value = view.status
  sort.value = view.sort
  shownCount.value = view.shown
  planResult.value = null
  // The re-lay dialog names one project's episodes and one project's plan, and
  // its previewed dates were computed against that project. Carrying any of it
  // across a project switch would offer to save dates the new project never
  // previewed.
  relayoutResult.value = null
  relayoutOpen.value = false
  relayoutPreview.value = null
  relayoutRequest.value = null
  relayoutError.value = ''
  selectedCodes.value = []
  selectionAnchor = null
  bulkRun.value = null
  bulkScheduleOpen.value = false
  bulkVisibilityOpen.value = false
  bulkReviewOpen.value = false
  bulkReviews.value = []
  bulkReviewOpener.value = null
  bulkReviewDismissedWhileQueueing.value = false
  bulkQueueStopRequested.value = false
  bulkQueueWasStopped.value = false
  queuedUploadCodes.clear()
  draftTitle.value = ''
  draftDescription.value = ''
  draftSaved.value = true
  draftEverSaved.value = false
  draftSuggestion.value = null
  draftError.value = ''
  closeReview(false)
  closeVideo()
  for (const key of Object.keys(rowResults)) delete rowResults[key]
  void load()
}, { immediate: true })
</script>

<style scoped>
.uc-publish { container-type: inline-size; container-name: uc-publish; display: grid; gap: 14px; min-width: 0; }
.panel { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.panel h3 { margin: 0; font-size: 16px; }
.panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.hint, .muted { color: var(--text-muted); font-size: var(--font-xs); }
.muted { overflow-wrap: anywhere; }
.result, .row-result { font-size: var(--font-xs); }
.result.ok, .row-result.ok { color: var(--success); }
.result.warn, .row-result.warn { color: var(--warning, #d97706); }
.row-result.info { color: var(--text-secondary); }
.result.err, .row-result.err { color: var(--error); }
.load-failure { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.load-failure .result { margin: 0; }

.uploads-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.head-actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; }
.visible-count { color: var(--text-muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
.channel-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 12px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary);
}
.channel-banner > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px 9px; min-width: 0; }
.channel-banner strong { overflow-wrap: anywhere; }
.channel-banner code, .channel-banner > div > span { color: var(--text-muted); font-size: var(--font-xs); }
.channel-ready { border-left: 3px solid var(--success); }
.channel-missing { border-left: 3px solid var(--warning, #d97706); }
.channel-missing > div { display: grid; align-items: start; }
.episode-tools { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 10px; align-items: end; }
.ep-filter, .sort-control select {
  width: 100%; min-height: 36px; box-sizing: border-box; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-primary); color: var(--text-primary); font: inherit; font-size: 12px;
}
.ep-filter { padding: 7px 10px; }
.sort-control { display: grid; gap: 4px; min-width: 160px; color: var(--text-muted); font-size: var(--font-xs); }
.sort-control select { padding: 6px 30px 6px 9px; }
.ep-filter:focus-visible, .sort-control select:focus-visible, .status-chip:focus-visible, .inline-action:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
.status-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.status-chip {
  min-height: 30px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px;
  background: transparent; color: var(--text-muted); cursor: pointer; font: inherit; font-size: var(--font-xs);
}
.status-chip:hover { border-color: var(--accent); color: var(--text-primary); }
.status-chip.active { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
.status-count { margin-left: 4px; font-variant-numeric: tabular-nums; }
.empty-filter { padding: 18px; text-align: center; }
.inline-action {
  width: fit-content; padding: 0; border: 0; background: transparent; color: var(--accent); cursor: pointer;
  font: inherit; font-size: var(--font-xs); text-decoration: underline; text-underline-offset: 3px;
}

.episode-columns, .op {
  display: grid; grid-template-columns: minmax(150px, 1.35fr) minmax(100px, .72fr) minmax(100px, .72fr) minmax(150px, 1fr) minmax(140px, auto);
  gap: 12px;
}
.episode-columns { padding: 0 12px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 700; }
.op-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.op {
  align-items: start; padding: 11px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary);
}
.op > * { min-width: 0; }
.op-id, .fact { display: grid; gap: 3px; }
.fact { position: relative; }
.row-select { display: flex; align-items: center; gap: 6px; width: fit-content; color: var(--text-muted); font-size: var(--font-xs); cursor: pointer; }
.row-select input { margin: 0; accent-color: var(--accent); }
.row-select:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.episode-title { color: var(--text-secondary); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.fact-label {
  position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0);
  white-space: nowrap; border: 0; color: var(--text-muted); font-size: var(--font-xs); font-weight: 700;
}
.state-text { font-size: 12px; font-weight: 700; }
.tone-success { color: var(--success); }
.tone-info { color: var(--text-secondary); }
.tone-danger { color: var(--error); }
.tone-muted { color: var(--text-muted); }
.fact-note.tone-danger { color: var(--error); }
.fact-note { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; overflow-wrap: anywhere; }
.upload-progress { margin-top: 3px; min-width: 120px; }
.op-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.forget-upload { flex-basis: 100%; margin-left: auto; color: var(--text-muted); }
.row-result { grid-column: 1 / -1; margin: 0; padding-top: 7px; border-top: 1px solid var(--border); line-height: 1.5; }

.upload-review, .bulk-upload-review, .video-review, .relayout-review { display: grid; gap: 14px; min-width: 0; }
/*
  The review dialogs paint their own bands (the Modal is passed `modal-flush`):
  the header with Close is pinned to the top of the dialog's own scroll box and
  the action band to its bottom, so both stay reachable while a long payload
  scrolls between them. Sticky positioning needs the dialog's scroll box to be
  the nearest scrolling ancestor, which is exactly what Modal provides.
*/
.upload-review, .bulk-upload-review, .relayout-review { --uc-dialog-pad: 24px; gap: 0; }
.review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.upload-review .review-head, .bulk-upload-review .review-head, .relayout-review .review-head {
  position: sticky; top: 0; z-index: 2;
  padding: var(--uc-dialog-pad) var(--uc-dialog-pad) 12px;
  background: var(--bg-secondary); border-bottom: 1px solid var(--border);
}
.review-body { display: grid; gap: 14px; min-width: 0; padding: 14px var(--uc-dialog-pad); }
.review-foot {
  position: sticky; bottom: 0; z-index: 2; display: grid; gap: 10px;
  padding: 12px var(--uc-dialog-pad) var(--uc-dialog-pad);
  background: var(--bg-secondary); border-top: 1px solid var(--border);
}
.review-foot:empty { display: none; }
.review-loading { margin: 0; }
.bulk-upload-review > .hint, .bulk-upload-review > .bulk-review-list { margin-inline: var(--uc-dialog-pad); }
.bulk-upload-review > .hint { margin-top: 12px; }
.bulk-upload-review > .bulk-review-list { margin-top: 12px; }
.bulk-panel { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); min-width: 0; }
.bulk-panel.collapsed { padding-block: 8px; }
.show-more { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px 12px; }
.bulk-selection { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.bulk-selection h4 { margin: 0; font-size: var(--font-sm); }
.bulk-count { color: var(--text-secondary); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
.bulk-panel .hint { margin: 0; }
.tone-warn { color: var(--warning, #d97706); }
.bulk-actions { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, max(280px, calc((100% - 16px) / 3))), 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.bulk-action { display: grid; align-content: start; gap: 4px; min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-secondary); }
.bulk-action-head { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.bulk-action small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.bulk-action .bulk-why { color: var(--text-secondary); font-style: italic; }
.bulk-where { font-size: var(--font-xs); font-weight: 700; white-space: nowrap; }
.bulk-progress { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 8px 10px; border-left: 3px solid var(--accent); background: var(--bg-secondary); }
.bulk-progress p { margin: 0; font-size: var(--font-xs); }
.schedule-fields { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; }
.schedule-fields label { display: grid; gap: 4px; color: var(--text-muted); font-size: var(--font-xs); }
.every-row { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); }
.every-input { width: 72px; }
.visibility-choices { display: grid; gap: 8px; margin: 0; padding: 0; border: 0; }
.visibility-choices legend { margin-bottom: 6px; color: var(--text-muted); font-size: var(--font-xs); }
.visibility-choice { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.visibility-choice span { display: grid; gap: 2px; }
.visibility-choice small { color: var(--text-muted); font-size: var(--font-xs); }
.bulk-background { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px 14px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.bulk-background p { margin: 0; font-size: 13px; }
.bulk-background-actions { display: flex; gap: 8px; }
.review-head h2 { margin: 0; font-size: 18px; }
.review-head h2:focus { outline: none; }
.review-head p { margin: 4px 0 0; color: var(--text-muted); font-size: var(--font-xs); }
/* Re-lay dialog: a before/after table is the whole point, so the two date
   columns must stay visually distinct from the episode codes beside them. */
.relayout-start { align-items: center; }
.relayout-start label { font-size: var(--font-xs); color: var(--text-muted); }
.relayout-table { width: 100%; border-collapse: collapse; font-size: var(--font-xs); }
.relayout-table caption { margin-bottom: 6px; color: var(--text-muted); text-align: left; }
.relayout-table th {
  padding: 6px 8px; border-bottom: 1px solid var(--border);
  color: var(--text-muted); font-weight: 600; text-align: left;
}
.relayout-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.relayout-table td:last-child { white-space: nowrap; }
.relayout-skipped {
  display: grid; gap: 6px; padding: 12px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary);
}
.relayout-skipped h3 { margin: 0; font-size: 14px; }
.relayout-skipped ul {
  display: grid; gap: 4px; margin: 0; padding-left: 18px;
  color: var(--text-muted); font-size: var(--font-xs);
}
.video-review video { width: 100%; max-height: min(65vh, 560px); border-radius: var(--radius-sm); background: #000; }
.changes, .warnings { display: grid; gap: 4px; margin: 0; padding-left: 18px; font-size: var(--font-xs); }
.warnings { color: var(--warning, #d97706); }
.publishing-review { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.social-publish { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.social-publish h3 { margin: 2px 0 0; font-size: 15px; }
.social-platform-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.social-platform-choice {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: start; padding: 10px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-primary); cursor: pointer;
}
.social-platform-choice:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.social-platform-choice input { margin-top: 2px; accent-color: var(--accent); }
.social-platform-choice span { display: grid; gap: 3px; min-width: 0; }
.social-platform-choice strong { color: var(--text-primary); font-size: 12px; }
.social-platform-choice small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; overflow-wrap: anywhere; }
.social-receipt { display: inline-flex; gap: 4px; margin-right: 10px; }
@container (max-width: 720px) { .social-platform-list { grid-template-columns: 1fr; } }
.publishing-review h3 { margin: 2px 0 0; font-size: 15px; }
.timing-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.timing-option {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: start; padding: 10px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-primary); cursor: pointer;
}
.timing-option:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.timing-option.unavailable { cursor: default; opacity: .68; }
.timing-option input { margin-top: 2px; accent-color: var(--accent); }
.timing-option span { display: grid; gap: 4px; min-width: 0; }
.timing-option strong { color: var(--text-primary); font-size: 12px; }
.timing-option small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
.custom-timing { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
.custom-timing label { display: grid; flex: 1 1 240px; gap: 4px; color: var(--text-muted); font-size: var(--font-xs); }
.custom-timing input {
  min-height: 36px; padding: 6px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-primary); color: var(--text-primary); font: inherit;
}
.custom-timing input:focus-visible, .timing-option:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.thumbnail-review { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.thumbnail-review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.thumbnail-review-head h3 { margin: 2px 0 0; font-size: 15px; }
.section-kicker { margin: 0; color: var(--text-muted); font-size: var(--font-xs); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.thumbnail-count { color: var(--text-muted); font-size: var(--font-xs); }
.selected-thumbnail { display: grid; grid-template-columns: minmax(180px, 280px) minmax(0, 1fr); gap: 12px; align-items: center; }
.selected-thumbnail.has-candidates { grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); gap: 16px; align-items: start; }
.chosen-thumbnail-wrap { display: grid; gap: 6px; }
.chosen-thumbnail-wrap > img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius-sm); background: var(--bg-primary); }
.other-candidates-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.candidate-thumb-card { display: grid; gap: 4px; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-primary); }
.candidate-thumb-card img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: calc(var(--radius-sm) - 2px); background: var(--bg-secondary); }
.candidate-header { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.candidate-tag { font-size: var(--font-xs); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.candidate-tag.chosen-tag { color: var(--accent); }
.candidate-copy { display: grid; gap: 2px; }
.candidate-copy strong { font-size: var(--font-xs); overflow-wrap: anywhere; }
.candidate-copy small, .pinned-tag { color: var(--text-muted); font-size: var(--font-xs); }
.thumbnail-test-cta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-primary); border: 1px solid var(--border); }
.selected-thumbnail > img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius-sm); background: var(--bg-primary); }
.selected-thumbnail-copy { display: grid; gap: 5px; min-width: 0; }
.selected-thumbnail-copy strong, .thumbnail-option span { overflow-wrap: anywhere; }
.selected-thumbnail-copy span, .thumbnail-unavailable span { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.thumbnail-options { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 8px; }
.thumbnail-option { display: grid; grid-template-rows: auto 1fr auto; gap: 5px; min-width: 0; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-secondary); text-align: left; cursor: pointer; }
.thumbnail-option:hover, .thumbnail-option:focus-visible { border-color: var(--accent); }
.thumbnail-option.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); color: var(--text-primary); }
.thumbnail-option:disabled { cursor: wait; opacity: .65; }
.thumbnail-option img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: calc(var(--radius-sm) - 2px); background: var(--bg-secondary); }
.thumbnail-option span { font-size: var(--font-xs); line-height: 1.35; }
.thumbnail-option small { color: var(--accent); font-size: var(--font-xs); }
.thumbnail-unavailable { display: grid; gap: 4px; min-height: 92px; align-content: center; padding: 14px; border: 1px dashed var(--border); border-radius: var(--radius-sm); background: var(--bg-primary); }
.thumbnail-generator-link { width: fit-content; color: var(--accent); font-size: var(--font-xs); }
.payload { display: grid; gap: 6px; margin: 0; max-height: min(55vh, 520px); overflow: auto; }
.payload > div { display: grid; grid-template-columns: minmax(120px, 160px) minmax(0, 1fr); gap: 12px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.payload dt, .payload dd { margin: 0; font-size: var(--font-xs); }
.payload dd { color: var(--text-secondary); overflow-wrap: anywhere; }
.payload dd strong, .payload dd small { display: block; }
.payload dd small { margin-top: 3px; color: var(--text-muted); font-size: var(--font-xs); }
.payload dd.pre { white-space: pre-wrap; }
.payload-editable dd { display: grid; gap: 4px; }
.edit-input, .edit-textarea {
  width: 100%; box-sizing: border-box; padding: 7px 9px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-primary); color: var(--text-primary); font: inherit; font-size: 12px;
}
.edit-textarea { resize: vertical; min-height: 110px; }
.edit-input:focus-visible, .edit-textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.field-counter { color: var(--text-muted); font-size: var(--font-xs); }
.field-error { color: var(--error); font-size: var(--font-xs); }
.draft-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.draft-actions .row-result { flex-basis: 100%; margin: 0; }
/*
  The server's refusals are written as short paragraphs, one per line. Without
  this the newlines collapse and a list of reasons arrives as one run-on
  sentence, which is the opposite of what the refusal is for.
*/
.draft-error { white-space: pre-wrap; }
/*
  The corrected text, offered for the owner to accept. Bounded in height so a
  long description cannot push the rest of the panel off the screen.
*/
.draft-suggestion { flex-basis: 100%; display: grid; gap: 6px; justify-items: start; }
.draft-suggestion .pre {
  max-height: 160px; overflow: auto; width: 100%; box-sizing: border-box; margin: 0;
  padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-primary); color: var(--text-primary); font-size: 12px;
}
.draft-restore { justify-self: start; }

.bulk-review-list { display: grid; gap: 9px; max-height: min(62vh, 620px); margin: 0; padding: 0; overflow: auto; list-style: none; }
.bulk-review-item { display: grid; gap: 10px; padding: 11px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.bulk-review-item > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.bulk-review-item > header > div { display: grid; gap: 3px; min-width: 0; }
.bulk-review-item > header span { color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.bulk-review-details { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr); gap: 12px; }
.bulk-thumbnail { display: grid; align-content: start; gap: 5px; min-width: 0; }
.bulk-thumbnail img, .bulk-thumbnail > span { width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius-sm); background: var(--bg-primary); }
.bulk-thumbnail img { object-fit: cover; }
.bulk-thumbnail > span { display: grid; place-items: center; padding: 8px; box-sizing: border-box; color: var(--text-muted); font-size: var(--font-xs); text-align: center; }
.bulk-thumbnail small { color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.bulk-review-details dl { display: grid; gap: 5px; margin: 0; }
.bulk-review-details dl > div { display: grid; grid-template-columns: minmax(90px, 110px) minmax(0, 1fr); gap: 9px; }
.bulk-review-details dt, .bulk-review-details dd { margin: 0; font-size: var(--font-xs); }
.bulk-review-details dt { color: var(--text-muted); font-weight: 700; }
.bulk-review-details dd { color: var(--text-secondary); overflow-wrap: anywhere; }
.bulk-review-details dd small { display: block; margin-top: 2px; color: var(--text-muted); font-size: var(--font-xs); }
.bulk-metadata { padding-top: 8px; border-top: 1px solid var(--border); }
.bulk-metadata summary { width: fit-content; color: var(--accent); font-size: var(--font-xs); cursor: pointer; }
.bulk-metadata summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bulk-metadata dl { display: grid; gap: 6px; margin: 9px 0 0; }
.bulk-metadata dl > div { display: grid; grid-template-columns: minmax(90px, 110px) minmax(0, 1fr); gap: 9px; }
.bulk-metadata dt, .bulk-metadata dd { margin: 0; font-size: var(--font-xs); }
.bulk-metadata dt { color: var(--text-muted); font-weight: 700; }
.bulk-metadata dd { color: var(--text-secondary); overflow-wrap: anywhere; }
.bulk-metadata dd.pre { max-height: 180px; overflow: auto; white-space: pre-wrap; }
.bulk-review-footer {
  position: sticky; bottom: 0; z-index: 2;
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px 14px;
  margin-top: 12px; padding: 12px var(--uc-dialog-pad) var(--uc-dialog-pad);
  background: var(--bg-secondary); border-top: 1px solid var(--border);
}
.bulk-review-footer .hint { margin: 0; }
.bulk-review-footer .result { grid-column: 1 / -1; margin: 0; }

@container uc-publish (max-width: 880px) {
  .episode-columns { display: none; }
  .op { grid-template-columns: minmax(160px, 1.2fr) repeat(3, minmax(110px, 1fr)); }
  .fact-label { position: static; width: auto; height: auto; overflow: visible; clip: auto; white-space: normal; }
  .op-actions { grid-column: 1 / -1; justify-content: flex-start; }
}
@container uc-publish (max-width: 620px) {
  .uploads-head, .review-head, .channel-banner { align-items: stretch; flex-direction: column; }
  .episode-tools { grid-template-columns: 1fr; }
  .sort-control { min-width: 0; }
  .op { grid-template-columns: 1fr 1fr; }
  .op-id, .publication-fact, .op-actions, .row-result { grid-column: 1 / -1; }
  .op-actions .btn { flex: 1 1 150px; }
  .payload > div { grid-template-columns: 1fr; }
  .timing-options { grid-template-columns: 1fr; }
}
@container uc-publish (max-width: 390px) {
  .panel { padding: 12px; }
  .op { grid-template-columns: 1fr; }
  .op-id, .publication-fact, .op-actions, .row-result { grid-column: auto; }
  .status-chip { flex: 1 1 auto; }
}
@media (max-width: 620px) {
  .upload-review .review-head, .bulk-upload-review .review-head, .video-review .review-head, .relayout-review .review-head { align-items: stretch; flex-direction: column; }
  .upload-review, .bulk-upload-review, .relayout-review { --uc-dialog-pad: 18px; }
  .bulk-background { grid-template-columns: 1fr; }
  .upload-review .payload > div { grid-template-columns: 1fr; }
  .timing-options { grid-template-columns: 1fr; }
  .selected-thumbnail, .selected-thumbnail.has-candidates { grid-template-columns: 1fr; }
  .thumbnail-options { grid-template-columns: 1fr 1fr; }
  .bulk-review-details { grid-template-columns: 1fr; }
  .bulk-thumbnail { max-width: 240px; }
  .bulk-review-footer { grid-template-columns: 1fr; align-items: stretch; }
  .bulk-review-footer .result { grid-column: auto; }
}
@media (max-width: 390px) {
  .thumbnail-review-head { align-items: stretch; flex-direction: column; }
  .thumbnail-options { grid-template-columns: 1fr; }
  .bulk-review-details dl > div { grid-template-columns: 1fr; gap: 2px; }
  .bulk-metadata dl > div { grid-template-columns: 1fr; gap: 2px; }
}
</style>
