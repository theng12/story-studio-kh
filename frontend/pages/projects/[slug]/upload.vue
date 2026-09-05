<template>
  <div class="upload-center workspace-page">
    <WorkspaceHero
      eyebrow="Publishing desk"
      title="YouTube Upload"
      description="Review finished episodes, organize the queue, and hand publishing to YouTube with a schedule you can verify before it goes live."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Publishing status">
          <span class="workspace-metric" :data-tone="youtubeAccounts.length ? 'success' : 'warning'">
            <strong>{{ youtubeAccounts.length ? youtubeAccounts[0]?.remote_title || 'Connected' : 'Not connected' }}</strong> channel
          </span>
          <span class="workspace-metric" data-tone="success"><strong>{{ queueCounts.ready }}</strong> ready now</span>
          <span class="workspace-metric"><strong>{{ queueCounts.uploaded_local + queueCounts.uploaded_freed }}</strong> published</span>
          <span class="workspace-metric"><strong>{{ plans.length }}</strong> plans</span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface upload-command-surface">
      <div class="upload-header-right">
        <div
          v-if="quota"
          class="quota-chip"
          :class="{ warn: quotaPct >= 80 && quotaPct < 95, danger: quotaPct >= 95, stale: quota.stale }"
          :title="quotaTooltip"
        >
          <span class="chip-icon">◔</span>
          <span class="chip-text">
            {{ quota.used.toLocaleString() }} / {{ quota.ceiling.toLocaleString() }}<span class="chip-divider"> · </span><template v-if="quotaResetSeconds > 0">resets in {{ formatTimecode(quotaResetSeconds) }}</template><template v-else>resetting…</template><template v-if="quota.stale"> · stale</template>
          </span>
        </div>
        <button
          class="btn btn-sm btn-ghost"
          :disabled="loading"
          title="Reload assigned accounts and playlists across all tabs. Use after changing the YouTube connection in Settings or if a tab looks stale. Doesn't refresh the upload queue rows — use the Refresh queue button inside the queue for that."
          @click="refreshAll"
        >
          <LoadingSpinner v-if="loading" size="sm" />
          {{ loading ? 'Refreshing…' : 'Refresh connections' }}
        </button>
      </div>

      <!-- Tab strip -->
      <div class="upload-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="upload-tab"
          :class="{ active: activeTab === tab.id }"
          :disabled="tab.disabled"
          :title="tab.hint"
          @click="!tab.disabled && (activeTab = tab.id)"
        >
          <span class="upload-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
          <span class="upload-tab-copy">
            <strong>{{ tab.label }}</strong>
            <small>{{ tab.short }}</small>
          </span>
          <span v-if="tab.disabled" class="tab-soon">Phase {{ tab.phase }}</span>
        </button>
      </div>
    </div>

    <!-- v1.0.501 — ONE banner for an expired/revoked YouTube token, instead of
         six identical raw-stack error toasts from every panel that touches the
         API. Visible on every tab until reconnected or dismissed. -->
    <WorkspaceNotice v-if="ytAuthBroken" tone="error" title="YouTube session expired">
      Google expired or revoked this account's token. Sync, playlists, scheduling, and uploads will fail until you reconnect it in Accounts, then retry.
      <template #actions>
        <button class="btn btn-sm btn-primary" @click="activeTab = 'accounts'">Open Accounts</button>
        <button class="btn btn-sm btn-secondary" @click="retryAfterReconnect">I've reconnected — retry</button>
        <button class="btn-icon" title="Dismiss (it will reappear on the next failed call)" @click="ytAuthBroken = false">✕</button>
      </template>
    </WorkspaceNotice>

    <!-- v1.0.501 — operation report: the persistent per-episode receipt for the
         last plan Apply / Apply+Upload. Failures sort first and carry a Retry. -->
    <div v-if="opReport" class="op-report card mt-2">
      <div class="op-report-head">
        <strong>Last operation</strong>
        <span class="op-report-title">{{ opReport.title }}</span>
        <span class="text-muted text-xs">{{ opReport.at }}</span>
        <span v-if="opReportFailCount" class="op-report-failchip">{{ opReportFailCount }} need attention</span>
        <span class="op-report-spacer" />
        <button class="btn-icon" title="Dismiss report" @click="opReport = null">✕</button>
      </div>
      <div class="op-report-rows">
        <div v-for="row in opReport.rows" :key="row.episode_code + row.action" class="op-report-row" :class="{ bad: !row.ok }">
          <span class="op-mark" aria-hidden="true">{{ row.ok ? '✓' : '⚠' }}</span>
          <span class="op-code">{{ row.episode_code }}</span>
          <span class="op-action">{{ row.action }}</span>
          <span class="op-detail" :title="row.detail">{{ row.detail }}</span>
          <button
            v-if="row.retry"
            class="btn btn-sm btn-secondary op-retry"
            :disabled="row.busy"
            :title="row.retry === 'patch' ? 'Retry the YouTube schedule update for this episode' : 'Retry queueing this upload'"
            @click="retryOpRow(row)"
          >{{ row.busy ? 'Retrying…' : 'Retry' }}</button>
        </div>
      </div>
    </div>

    <!-- ── Accounts tab ─────────────────────────────────────────────── -->
    <div v-if="activeTab === 'accounts'" class="card workspace-section upload-tab-panel">
      <h3 style="margin: 0">Platforms & Connected Accounts</h3>
      <p class="text-muted" style="font-size: 12px; margin: 4px 0 12px;">
        YouTube connections and this project's channel assignment are managed in Settings.
        OAuth credentials are encrypted on this Mac; published-video records remain with each episode.
      </p>

      <!-- YouTube -->
      <section class="platform-block">
        <div class="platform-head">
          <div>
            <h4>▶ YouTube</h4>
            <span v-if="youtubeAccounts.length" class="state-pill state-set">Connected</span>
            <span v-else class="state-pill state-empty">Not connected</span>
          </div>
          <p class="text-muted" style="font-size: 12px;">
            One project publishes to one assigned YouTube channel. Settings shows every connected channel,
            connection health, and the explicit replacement controls.
          </p>
        </div>

        <div class="connect-row">
          <NuxtLink :to="`/projects/${slug}/settings#youtube`" class="btn btn-primary">
            Manage YouTube connection
          </NuxtLink>
        </div>

        <!-- Schedule mode — private-first vs apply-plan -->
        <div class="mode-row" :class="{ active: uploadMode === 'private' }">
          <strong>Schedule mode:</strong>
          <label :class="{ chosen: uploadMode === 'apply-plan' }" title="Our saved Plans write publishAt on YouTube. Best when you want Story Studio to drive cadence.">
            <input type="radio" value="apply-plan" :checked="uploadMode === 'apply-plan'" @change="doSetUploadMode('apply-plan')" />
            Apply-plan (default)
          </label>
          <label :class="{ chosen: uploadMode === 'private' }" title="Upload every video as private with no publishAt. You schedule inside YouTube Studio. Our Plans tab Apply button becomes a no-op in this mode.">
            <input type="radio" value="private" :checked="uploadMode === 'private'" @change="doSetUploadMode('private')" />
            Upload private, schedule in YouTube Studio
          </label>
        </div>
        <!-- Plain-language clarifier — closes the common misconception
             that scheduling is "internal" and requires Story Studio
             running. publishAt is a YouTube-side primitive; once an
             upload completes with it set, YouTube auto-publishes server-
             side regardless of whether the app is open. -->
        <p class="text-muted mt-1" style="font-size: var(--font-xs);">
          {{ uploadMode === 'private'
            ? 'In private mode, every video uploads as private with no publishAt. You schedule each one inside YouTube Studio.'
            : 'In Apply-plan mode, scheduled publishing is handled by YouTube server-side via publishAt — Story Studio doesn\'t need to be running at the publish moment.' }}
        </p>

        <!-- Connected account card (single) -->
        <div v-if="youtubeAccounts[0]" class="connected-account mt-2">
          <div
            class="channel-avatar-lg"
            role="img"
            :aria-label="`${youtubeAccounts[0].remote_title} channel icon`"
          >
            <img
              v-if="youtubeAccounts[0].thumbnail_url && !channelAvatarFailed"
              :src="channelAvatarUrl"
              alt=""
              class="channel-thumb-lg"
              @error="channelAvatarFailed = true"
            />
            <span v-else>{{ channelInitials }}</span>
          </div>
          <div style="flex: 1; min-width: 0;">
            <strong style="display: block;">{{ youtubeAccounts[0].remote_title }}</strong>
            <div class="text-muted" style="font-size: var(--font-xs);">
              <code>{{ youtubeAccounts[0].remote_id }}</code>
              <span v-if="youtubeAccounts[0].custom_url"> · {{ youtubeAccounts[0].custom_url }}</span>
            </div>
            <div class="text-muted" style="font-size: var(--font-xs);">
              Connected {{ formatDate(youtubeAccounts[0].connected_at) }}
            </div>
          </div>
          <NuxtLink
            :to="`/projects/${slug}/settings#youtube`"
            class="btn btn-sm btn-secondary"
            title="Manage this local connection and project assignment in Settings. Videos already published stay on YouTube."
          >Manage</NuxtLink>
        </div>
      </section>

    </div>

    <!-- ── Queue tab ─────────────────────────────────────────────────── -->
    <div v-else-if="activeTab === 'queue'" class="card workspace-section upload-tab-panel">
      <div class="queue-command-strip">
        <div class="queue-command-copy">
          <span>Publishing queue</span>
          <strong>{{ queueCounts.ready }} episode{{ queueCounts.ready === 1 ? '' : 's' }} ready for review</strong>
          <small>Choose a thumbnail and verify metadata before each upload, or apply a checked schedule in bulk.</small>
        </div>
        <div class="queue-command-metrics">
          <div><strong>{{ queueCounts.ready }}</strong><span>Ready</span></div>
          <div><strong>{{ queueCounts.uploaded_local + queueCounts.uploaded_freed }}</strong><span>Uploaded</span></div>
          <div><strong>{{ queueCounts.imports }}</strong><span>Imports</span></div>
          <div><strong>{{ selectedQueueIds.size }}</strong><span>Selected</span></div>
        </div>
      </div>
      <!-- Default-playlist banner — surfaces the project default that's set
           in the Playlists tab. New uploads auto-add to it (per-row dropdown
           "Default" option resolves to this value at upload time). The user
           kept asking why uploads weren't going to a playlist; the default
           was set but invisible from the Queue tab. Now it's right at top. -->
      <div class="default-playlist-banner" :class="{ unset: !defaultPlaylistId }">
        <span class="dpb-icon" aria-hidden="true">📂</span>
        <span class="dpb-text">
          <template v-if="defaultPlaylistId">
            <strong>Default playlist:</strong>
            "{{ playlists.find((p: any) => p.id === defaultPlaylistId)?.title || defaultPlaylistId }}"
            — new uploads auto-add to it.
          </template>
          <template v-else>
            <strong>No default playlist set.</strong>
            New uploads aren't auto-added to any playlist.
          </template>
        </span>
        <button
          class="btn btn-sm btn-ghost"
          title="Open the Playlists tab to pick (or change) the default playlist."
          @click="activeTab = 'playlists'"
        >
          {{ defaultPlaylistId ? 'Change' : 'Set default' }} →
        </button>
      </div>

      <!-- Match-unlinked banner — only renders when a background scan
           surfaced channel videos that look like they match local episodes
           (and aren't linked yet). One click opens the Match unlinked tab
           pre-loaded with the cached preview so you can link them before
           uploading and avoid creating duplicates. -->
      <div
        v-if="showReconcileBanner"
        class="reconcile-banner"
        :title="'These videos exist on your YouTube channel but no local sidecar links them to an episode yet. Linking writes the sidecar so the queue marks them as uploaded — then you can use Edit schedule to publish private ones, and re-uploads will only PATCH metadata instead of duplicating.'"
      >
        <span class="rb-icon" aria-hidden="true">🔗</span>
        <span class="rb-text">
          <strong>{{ actionableReconcileMatches.length }} video{{ actionableReconcileMatches.length === 1 ? '' : 's' }}</strong>
          on your channel look like {{ actionableReconcileMatches.length === 1 ? 'it matches' : 'they match' }} local episode{{ actionableReconcileMatches.length === 1 ? '' : 's' }} — review &amp; link before uploading to avoid duplicates.
        </span>
        <button
          class="btn btn-sm btn-primary"
          title="Open the Match unlinked tab with the matches pre-loaded. You confirm each link, then the queue marks those episodes as uploaded."
          @click="gotoReconcileTab"
        >Review &amp; link →</button>
        <button
          class="btn btn-sm btn-ghost"
          title="Hide this banner. It will reappear if a different set of channel videos starts matching."
          @click="dismissReconcileBanner"
        >Dismiss</button>
      </div>

      <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 10px;">
        <div>
          <h3 style="margin: 0">Upload Queue — YouTube</h3>
          <p class="text-muted" style="font-size: 12px; margin: 4px 0 0;">
            Every episode whose final video is on disk <strong>plus</strong> any non-episode files
            (trailers, bumpers, shorts) dropped into the project's <code>Upload Queue/</code> folder.
            Click <strong>Upload</strong> to queue a job; re-uploading an already-uploaded episode
            updates its metadata in place — video content is never replaced.
          </p>
        </div>
        <div class="flex gap-2" style="flex-wrap: wrap;">
          <button
            v-if="uploadMode !== 'private' && queueItems.some((i: any) => i.scheduled_for)"
            class="btn btn-sm btn-ghost"
            :disabled="bulkClearing"
            :title="'Remove every scheduled publish time from the queue. You can choose to also PATCH already-uploaded YouTube videos back to private.'"
            @click="doBulkClear(true)"
          >
            <LoadingSpinner v-if="bulkClearing" size="sm" />
            {{ bulkClearing ? 'Clearing…' : '🗑 Clear schedules (YT sync)' }}
          </button>
          <button
            class="btn btn-sm btn-secondary"
            :disabled="scanning"
            :title="`Walk {project}/Upload Queue/ and register any new video files in the queue. Files that disappear from disk are flagged but not auto-removed.${importsFolder ? '\n\nFolder: ' + importsFolder : ''}`"
            @click="doScan"
          >
            <LoadingSpinner v-if="scanning" size="sm" />
            {{ scanning ? 'Scanning…' : '📂 Scan imports' }}
          </button>
          <button
            class="btn btn-sm btn-ghost"
            :disabled="queueLoading"
            title="Re-scan local files and reload these queue rows. Local-only — fast, no quota cost. Doesn't ask YouTube for current privacy/schedule state; use the Sync from YouTube button next to it for that."
            @click="loadQueue({ nocache: true, page: queuePage })"
          >
            <LoadingSpinner v-if="queueLoading" size="sm" />
            {{ queueLoading ? 'Loading…' : '↻ Refresh (local)' }}
          </button>
          <button
            class="btn btn-sm btn-ghost"
            :disabled="ytSyncing || queueLoading"
            title="Pull current privacy + schedule from YouTube for every uploaded row in this queue, and rewrite the local sidecar(s) to match. Fixes drift when a video auto-publishes, gets edited in YT Studio, or shows up here as private when it's actually public. Costs ~1 YouTube quota unit per 50 videos."
            @click="doSyncFromYoutube()"
          >
            <LoadingSpinner v-if="ytSyncing" size="sm" />
            {{ ytSyncing ? 'Syncing…' : '☁ Sync from YouTube' }}
          </button>
          <button
            class="btn btn-sm btn-ghost"
            :disabled="thumbBackfilling || queueLoading"
            title="Set thumbnails on already-uploaded videos that are missing one — no re-upload. Fixes thumbnails that were skipped on upload (too large, title-drift, or the video was still processing). Downscales oversized images automatically. Quota-paced (~50 units each) and resumable across days."
            @click="doBackfillThumbnails"
          >
            <LoadingSpinner v-if="thumbBackfilling" size="sm" />
            {{ thumbBackfilling ? 'Checking…' : '🖼 Backfill thumbnails' }}
          </button>
        </div>
      </div>
      <p v-if="importsFolder" class="text-muted" style="font-size: var(--font-xs); margin: 4px 0 0;">
        Import folder: <code>{{ importsFolder }}</code>
      </p>

      <!-- Quick views (v1.0.390): plain-English intents that one-click set the
           right filter, so you don't have to reason about the 8 Show chips
           below. "Ready to upload" hides the already-uploaded back catalogue
           (the years-old episodes); "Needs a video" jumps to the tab where
           episodes with no final render live. The fine-grained Show chips
           stay below for power tweaks. -->
      <div class="quick-views mt-2" role="group" aria-label="Quick views">
        <span class="quick-views-label">I want to see</span>
        <button
          v-for="qv in QUICK_VIEWS"
          :key="qv.id"
          type="button"
          class="quick-view"
          :class="{ 'is-active': activeQuickView === qv.id, 'quick-view--jump': qv.id === 'missing' }"
          :title="qv.tooltip"
          @click="applyQuickView(qv.id)"
        >
          <span class="quick-view-icon" aria-hidden="true">{{ qv.icon }}</span>
          <span class="quick-view-text">{{ qv.label }}</span>
          <span v-if="qv.count() !== null" class="quick-view-count">{{ qv.count() }}</span>
          <span v-if="qv.id === 'missing'" class="quick-view-arrow" aria-hidden="true">→</span>
        </button>
      </div>

      <!-- Filter + sort + pagination toolbar. All three feed the same
           server-side paged request — switching filter or sort jumps to
           page 1 automatically. The default filter is "Not uploaded"
           because the dominant use case is "show me what's left to do". -->
      <div class="queue-toolbar mt-2">
        <!-- Multi-select filter chip strip — the fine-tune layer under the
             Quick Views above. Tick any combination of state chips (Ready /
             Uploaded·local kept / Uploaded·local freed / Imports) plus the
             Scheduled overlay. Cold-start default is "Ready" only (see
             FILTER_DEFAULT) so what's left to publish isn't buried under the
             already-uploaded back catalogue. -->
        <div class="qt-group qt-filter-group">
          <label class="qt-label" title="Fine-tune the Quick Views above: tick which categories of rows to include. State chips combine; the Scheduled/Public chips narrow further.">Or fine-tune</label>
          <div class="filter-chips">
            <button
              v-for="chip in QUEUE_FILTER_CHIPS"
              :key="chip.id"
              type="button"
              :class="['filter-chip', `filter-chip--${chip.kind}`, { 'is-active': isQueueFilterActive(chip) }]"
              :title="chip.tooltip"
              @click="toggleQueueFilter(chip)"
            >
              <span class="filter-chip-icon" aria-hidden="true">{{ chip.icon }}</span>
              {{ chip.label }}
            </button>
            <button
              v-if="queueStateFilters.size !== FILTER_DEFAULT.length || queueOverlayFilters.size > 0 || ![...queueStateFilters].every(s => (FILTER_DEFAULT as string[]).includes(s)) || queueSearch.trim() !== ''"
              type="button"
              class="filter-chip-reset"
              title="Reset filters + search to default (Ready to upload, no search)"
              @click="clearQueueFilters"
            >Reset</button>
          </div>
        </div>
        <div class="qt-group">
          <label class="qt-label" for="queue-search">Search</label>
          <input
            id="queue-search"
            v-model="queueSearch"
            type="search"
            class="input input-sm"
            placeholder="Code, title, filename…"
            title="Filter the queue by episode code, title, or import filename. Searches the full project — debounced 200 ms."
            style="min-width: 14rem"
          >
        </div>
        <div class="qt-group">
          <label class="qt-label">Sort</label>
          <select v-model="queueSort" class="select select-sm">
            <option value="code_asc">Episode code · oldest first</option>
            <option value="code_desc">Episode code · newest first</option>
            <option value="unscheduled_first">Not yet scheduled · then code</option>
            <option value="scheduled_asc">Scheduled · soonest first</option>
          </select>
        </div>
        <div class="qt-group">
          <label class="qt-label">Per page</label>
          <select v-model.number="queuePageSize" class="select select-sm">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </div>
        <div class="qt-spacer" />
        <div class="qt-group">
          <!-- Quick-apply path: opens a modal showing the active plan + the
               same Apply / Upload / Unapply scope picker that lives on the
               Plans tab. Saves a tab switch for the dominant workflow
               ("apply the plan to the queue I'm looking at"). The Plans
               tab still owns CRUD (create / edit / delete / activate). -->
          <button
            class="btn btn-sm btn-primary"
            :disabled="!plans.length"
            :title="plans.length ? 'Apply the active upload plan to the queue without leaving this tab' : 'Create a plan on the Plans tab first'"
            @click="openUploadPlanModal"
          >
            📅 Upload Plan ▾
          </button>
        </div>
        <div class="qt-group qt-pager">
          <button class="btn btn-sm btn-secondary" :disabled="queuePage <= 1 || queueLoading" @click="goToQueuePage(1)" title="First page">«</button>
          <button class="btn btn-sm btn-secondary" :disabled="queuePage <= 1 || queueLoading" @click="goToQueuePage(queuePage - 1)">← Prev</button>
          <span class="page-indicator">
            Page <strong>{{ queuePage }}</strong> of {{ queueTotalPages }}
            <span class="text-muted">· {{ queueTotal }} match{{ queueTotal === 1 ? '' : 'es' }}</span>
          </span>
          <button class="btn btn-sm btn-secondary" :disabled="queuePage >= queueTotalPages || queueLoading" @click="goToQueuePage(queuePage + 1)">Next →</button>
          <button class="btn btn-sm btn-secondary" :disabled="queuePage >= queueTotalPages || queueLoading" @click="goToQueuePage(queueTotalPages)" title="Last page">»</button>
        </div>
      </div>

      <div v-if="queueLoading && !queueItems.length" class="text-muted mt-2" style="font-size: 13px;">
        <LoadingSpinner size="sm" />
        Scanning episodes for final videos…
      </div>
      <div v-else-if="!queueTotalUnfiltered" class="text-muted mt-2" style="font-size: 13px;">
        No episodes with a final video yet. Run Video Assembly or drop a rendered file into an episode's folder, then refresh.
      </div>
      <div v-else-if="!queueItems.length" class="text-muted mt-2" style="font-size: 13px;">
        No items match the current filter. Try switching to "All" above.
      </div>

      <table v-if="queueItems.length" class="queue-table mt-2">
        <thead>
          <tr>
            <th class="col-select">
              <input
                type="checkbox"
                :checked="allEpisodesOnPageSelected"
                :indeterminate.prop="someEpisodesOnPageSelected && !allEpisodesOnPageSelected"
                :title="allEpisodesOnPageSelected ? 'Deselect all episodes on this page' : 'Select all episode rows on this page'"
                @change="toggleAllOnPage"
              />
            </th>
            <th>Type</th>
            <th>Identifier</th>
            <th>Title</th>
            <th>Metadata</th>
            <th>Status</th>
            <th>Scheduled</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in displayedQueueItems" :key="item.id" :class="{ 'row-selected': item.type === 'episode' && selectedQueueIds.has(item.episode_code) }">
            <td class="col-select">
              <input
                v-if="item.type === 'episode'"
                type="checkbox"
                :checked="selectedQueueIds.has(item.episode_code)"
                :title="`Select ${item.episode_code} for bulk actions`"
                @change="toggleQueueSelect(item.episode_code)"
              />
            </td>
            <td>
              <span :class="['type-chip', item.type]" :title="item.type === 'episode'
                ? 'Episode — sourced from accepted ideas with a final assembled video.'
                : 'Import — file dropped into the project-level Upload Queue folder.'">
                {{ item.type === 'episode' ? '📼 Episode' : '📦 Import' }}
              </span>
            </td>
            <td>
              <strong v-if="item.type === 'episode'">{{ item.episode_code }}</strong>
              <code v-else style="font-size: var(--font-xs);">{{ item.filename }}</code>
            </td>
            <td class="col-title">{{ item.title }}</td>
            <td>
              <span :class="item.has_metadata ? 'meta-pill ok' : 'meta-pill warn'" :title="item.has_metadata
                ? 'Title + description from the YouTube Finalizer output (episodes) or import sidecar.'
                : item.type === 'episode'
                  ? 'No metadata on disk yet — upload will use the episode title only. Run YouTube Finalizer first for best results.'
                  : 'Import has no metadata yet — click Edit to add title / description / tags.'">
                {{ item.has_metadata ? '✓ Ready' : '⚠ Missing' }}
              </span>
              <span v-if="item.has_thumbnail" class="meta-pill ok" title="Highest-version thumbnail will be uploaded after the video.">🖼 Thumb</span>
              <span v-else-if="item.type === 'episode'" class="meta-pill muted" title="No thumbnail file found — YouTube will auto-generate one.">no thumb</span>
              <!-- Playlist chip — resolves the row's effective playlist
                   (per-row override → project default → none) and looks
                   up the title from the loaded playlists list. Surfaces
                   the playlist target the user otherwise can't see
                   without opening the row's actions menu. -->
              <span v-if="item._playlist"
                    class="meta-pill playlist"
                    :title="item._playlist.title">
                🎵 Playlist: {{ item._playlist.label }}
              </span>
              <span v-else-if="item.type === 'episode'"
                    class="meta-pill muted"
                    title="No playlist will be applied to this upload. Open the row actions to override per-row, or set a project default in the Playlists tab.">
                🎵 No playlist
              </span>
            </td>
            <td>
              <template v-if="uploadJobFor(item.episode_code) && uploadJobFor(item.episode_code)!.status === 'queued'">
                <!-- Live job state beats the sidecar display — user sees
                     progress the moment the job starts running. -->
                <span class="progress-pill" title="Queued — waiting for capacity. It starts as soon as the queue reaches it; click Jobs in the sidebar to see queue position.">
                  <span class="progress-dot" />
                  Queued…
                </span>
              </template>
              <template v-else-if="uploadJobFor(item.episode_code) && uploadJobFor(item.episode_code)!.status === 'running'">
                <!-- Running upload: show full ProgressBar with bytes,
                     speed, and ETA. Hover any metric for an inline
                     explanation. -->
                <ProgressBar
                  :progress="uploadJobFor(item.episode_code)!.progress"
                  :bytes-done="uploadJobFor(item.episode_code)!.bytes_done"
                  :bytes-total="uploadJobFor(item.episode_code)!.bytes_total"
                  :speed-bps="uploadJobFor(item.episode_code)!.speed_bps"
                  :eta-seconds="uploadJobFor(item.episode_code)!.eta_seconds"
                  label="Uploading to YouTube"
                  label-title="Live progress for this row's resumable YouTube upload. Bytes, speed, and ETA come straight from the upload PUT — they freeze if the connection drops, and the queue auto-resumes on the next click."
                />
              </template>
              <template v-else-if="uploadJobFor(item.episode_code) && uploadJobFor(item.episode_code)!.status === 'error'">
                <span class="progress-pill err" :title="uploadJobFor(item.episode_code)!.error || 'Upload failed — check Jobs tab for details.'">
                  ⚠ Failed
                </span>
              </template>
              <template v-else-if="item.uploaded && item.deleted_at">
                <!-- Tombstoned: video used to exist on YouTube but is gone now.
                     Distinct from "✓ Uploaded" so the user doesn't think the
                     link is healthy. The video_url still opens YouTube — most
                     of the time it'll 404, which is the right confirmation. -->
                <span class="tombstone-pill"
                      :title="`Was uploaded as ${item.video_id || '?'} (${item.deleted_reason || 'manual'}) — marked deleted upstream ${item.deleted_at ? new Date(item.deleted_at).toLocaleString() : ''}. Bulk-upload skips this row by default. Use “Forget link” in the row menu if you want to re-upload from scratch.`">
                  🪦 Deleted upstream
                </span>
                <div class="row-chip-stack">
                  <span class="text-muted" style="font-size: var(--font-xs);">
                    last seen {{ item.last_sync_at ? formatScheduled(item.last_sync_at) : '?' }}
                  </span>
                </div>
              </template>
              <template v-else-if="item.uploaded">
                <a :href="item.video_url" target="_blank" rel="noopener" class="video-link" :title="`Video id: ${item.video_id} — opens in YouTube. Click Upload again to PATCH metadata only, not replace the video.`">
                  ✓ Uploaded
                </a>
                <!-- Privacy chip on uploaded rows. Same renderer as the
                     not-yet-uploaded branch below, so the user sees
                     consistent language about privacy state. The
                     last-sync timestamp moves to its own muted line so
                     the chip can dominate visually. -->
                <div class="row-chip-stack">
                  <span :class="['privacy-chip', `privacy-chip--${item._privacy.tone}`]">
                    {{ item._privacy.label }}
                  </span>
                </div>
                <span class="text-muted" style="font-size: var(--font-xs); display: block;">
                  last sync {{ formatScheduled(item.last_sync_at) }}
                </span>
              </template>
              <template v-else>
                <span class="text-muted">Not uploaded</span>
                <!-- Privacy chip for not-yet-uploaded rows. Surfaces the
                     fact that all fresh uploads land on YouTube as
                     private (with publishAt set when scheduled, so
                     YouTube auto-publishes). Removes the user's
                     "is there an indicator that this will be private?"
                     blind spot. -->
                <div class="row-chip-stack">
                  <span :class="['privacy-chip', `privacy-chip--${item._privacy.tone}`]"
                        title="Every fresh upload lands on YouTube as private. If a publishAt is scheduled, YouTube auto-flips to public at that time.">
                    {{ item._privacy.label }}
                  </span>
                  <!-- Inline orphan-match hint — shows when an unlinked
                       video on the channel has a title close enough to
                       this row's title that it's probably the same
                       thing. One click opens the Link Video modal pre-
                       focused on the orphan list. -->
                  <button
                    v-if="orphanMatchByCode[item.episode_code]"
                    type="button"
                    class="orphan-match-pill"
                    :title="`A YouTube video on this channel matches this episode's title (${Math.round(orphanMatchByCode[item.episode_code].score * 100)}% match): &quot;${orphanMatchByCode[item.episode_code].title.slice(0, 80)}&quot;. Click to link instead of re-uploading.`"
                    @click="openLinkVideoModal(item)"
                  >🔗 Looks already on YouTube</button>
                  <!-- Item E — "Uploaded elsewhere" pill. Shows on every
                       legacy-flagged row regardless of URL/note (so the
                       user always sees a visible signal that this row
                       was marked manually and isn't part of the upload
                       pipeline). With a URL → click opens it in a new
                       tab; without → click opens the edit modal so the
                       user can paste one in. Tooltip surfaces the note
                       as secondary text under the URL. -->
                  <component
                    v-if="item.legacy_uploaded"
                    :is="item.legacy_external_url ? 'a' : 'button'"
                    type="button"
                    :class="['external-pill', { 'external-pill--no-url': !item.legacy_external_url }]"
                    :href="item.legacy_external_url || undefined"
                    :target="item.legacy_external_url ? '_blank' : undefined"
                    :rel="item.legacy_external_url ? 'noopener' : undefined"
                    :title="legacyExternalTooltip(item)"
                    @click.stop="item.legacy_external_url ? null : openLegacyEditModal(item)"
                  >🔗 External</component>
                </div>
              </template>
            </td>
            <td style="font-size: 12px; color: var(--text-secondary);">
              <template v-if="uploadMode === 'private' && item.uploaded && item.video_id">
                <a :href="`https://studio.youtube.com/video/${item.video_id}/edit`" target="_blank" rel="noopener" class="video-link" title="Open this video's edit page in YouTube Studio to schedule or set publish time.">
                  Schedule in YT Studio →
                </a>
              </template>
              <template v-else-if="uploadMode === 'private'">
                <span class="text-muted" title="Private-first mode is active. After upload, use YouTube Studio to schedule.">Set in YT Studio</span>
              </template>
              <template v-else-if="editingScheduleFor === item.episode_code">
                <!-- Inline date/time picker. datetime-local is rendered in
                     the browser's local tz; we convert to ISO on save. -->
                <div class="schedule-editor">
                  <input
                    v-model="editingScheduleValue"
                    type="datetime-local"
                    class="input input-sm"
                    :min="new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)"
                  />
                  <button class="btn btn-sm btn-primary" @click="saveEditSchedule(item)">Save</button>
                  <button class="btn btn-sm btn-ghost" @click="cancelEditSchedule">Cancel</button>
                </div>
              </template>
              <template v-else>
                <button
                  class="schedule-cell"
                  :title="item.type === 'episode'
                    ? (item.scheduled_for ? `Scheduled for ${formatScheduled(item.scheduled_for)} — click to change.` : 'Click to set a scheduled publish time for this episode.')
                    : ''"
                  :disabled="item.type !== 'episode'"
                  @click="startEditSchedule(item)"
                >
                  <!-- Rich schedule display: weekday + date as the lead
                       line so the user can scan a column of dates at a
                       glance, time + relative ("tomorrow" / "in 3d") on
                       the second line for context. The em-dash dash
                       fallback is rendered as the lead line when no
                       time is set, so empty rows still take the same
                       vertical space and the column doesn't jump. -->
                  <template v-if="item.scheduled_for">
                    <template v-if="item._isStale">
                      <!-- Already public on YouTube — the local schedule is
                           historical noise (sidecar wasn't refreshed after
                           YouTube auto-published). Show a muted, italic
                           note so users don't read it as live state, and
                           point them at the sync button via the tooltip. -->
                      <div class="sched-stale" title="This video is already public on YouTube. The local schedule is leftover from when it was uploaded — click ☁ Sync from YouTube to clear it. You can still re-schedule via Edit (the video will revert to private until the new time).">
                        ⓘ Was scheduled — already public
                      </div>
                    </template>
                    <template v-else>
                      <div class="sched-date">{{ item._sched.date }}</div>
                      <div class="sched-time">
                        {{ item._sched.time }}
                        <span v-if="item._sched.relative" class="sched-relative">
                          · {{ item._sched.relative }}
                        </span>
                      </div>
                    </template>
                  </template>
                  <template v-else>
                    <div class="sched-date">—</div>
                  </template>
                  <span v-if="item.schedule_source === 'planned' && !item._isStale" class="sched-pill" title="Scheduled by an Upload Plan. When you click Upload, this time is pushed to YouTube as publishAt.">📅</span>
                  <span v-else-if="item.schedule_source === 'synced' && !item._isStale" class="sched-pill ok" title="Time is live on YouTube via publishAt.">☁️</span>
                </button>
                <!-- Plain-language clarifier: today the schedule cell only
                     shows emoji pills with the explanation buried in
                     tooltips, so users can't tell from glance who
                     actually drives the publish moment. This chip makes
                     the YouTube-native flow visible: in apply-plan mode,
                     YouTube handles publish via publishAt; in private
                     mode, the user does it from YT Studio. -->
                <div v-if="item.scheduled_for && item.type === 'episode' && !item._isStale" class="sched-explainer">
                  <span v-if="String(uploadMode) === 'private'" class="sched-chip sched-chip--muted">
                    Manual schedule in YouTube Studio
                  </span>
                  <span v-else-if="item.uploaded" class="sched-chip sched-chip--ok">
                    ✓ YouTube auto-publishes at this time
                  </span>
                  <span v-else class="sched-chip sched-chip--pending">
                    YouTube will publish on upload
                  </span>
                </div>
                <div v-if="item.type === 'episode' && (item.scheduled_for || item.uploaded)" class="unschedule-actions">
                  <button
                    class="btn-unschedule"
                    :disabled="unschedulingFor === item.episode_code"
                    title="Edit this row's schedule: pick a new publish time, clear the schedule, or publish now."
                    @click="openSchedulePopover(item)"
                  >📅 Edit</button>
                </div>
              </template>
            </td>
            <td class="col-actions">
              <template v-if="item.type === 'episode'">
                <!-- Final-video size chip — surfaces what's about to fly
                     up to YouTube before the user clicks Upload. Renders
                     an em-dash when the local file isn't found (e.g.
                     sidecar-only rows where the file was deleted post-
                     upload), so the column never goes empty. -->
                <span
                  class="size-chip"
                  :title="item.final_video_bytes != null
                    ? `Final assembled video size — what gets uploaded to YouTube. Local file: ${formatBytes(item.final_video_bytes)}.`
                    : 'No local final-video file found. The video may have been deleted after upload, or the file lives outside the standard locations Story Studio scans.'"
                >📦 {{ formatBytes(item.final_video_bytes) }}</span>
                <!-- Three independent action buttons, smart-disabled per
                     row state. Replaces the previous toggle button (which
                     was overloaded: same click = upload OR metadata
                     update depending on item.uploaded). The split makes
                     intent unambiguous and lets each action fail
                     independently in the Job Queue history. Secondary
                     controls (per-row playlist override, reset upload
                     state) still live in the ⋯ menu — different category
                     of action (config, not execution). -->
                <div class="row-actions">
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="!canUploadRow(item)"
                    :title="uploadButtonTitle(item)"
                    @click="doUpload(item)"
                  >
                    <LoadingSpinner v-if="rowBusy[item.id] === 'upload'" size="sm" />
                    {{ rowBusy[item.id] === 'upload' ? '…' : '📤 Upload' }}
                  </button>
                  <button
                    class="btn btn-sm btn-secondary"
                    :disabled="!canUpdateMetadataRow(item)"
                    :title="metadataButtonTitle(item)"
                    @click="doUpdateMetadata(item)"
                  >
                    <LoadingSpinner v-if="rowBusy[item.id] === 'metadata'" size="sm" />
                    {{ rowBusy[item.id] === 'metadata' ? '…' : '↻ Update YouTube' }}
                  </button>
                  <button
                    class="btn btn-sm btn-secondary"
                    :disabled="!canUpdatePlaylistRow(item)"
                    :title="playlistButtonTitle(item)"
                    @click="doUpdatePlaylist(item)"
                  >
                    <LoadingSpinner v-if="rowBusy[item.id] === 'playlist'" size="sm" />
                    {{ rowBusy[item.id] === 'playlist' ? '…' : '♫ Playlist' }}
                  </button>
                </div>

                <!-- ⋯ menu for everything else. Only renders when there
                     is at least one secondary action available. Same
                     Teleport-to-body pattern as the pipeline page kebab
                     so the menu can never be clipped by the table cell. -->
                <span
                  v-if="(!item.uploaded && playlists.length) || item.uploaded"
                  class="row-kebab"
                  @click.stop
                >
                  <button
                    class="kebab-trigger"
                    :aria-expanded="rowMenuOpenFor === item.id"
                    :aria-label="`More actions for ${item.episode_code || item.filename}`"
                    title="More actions: pick a per-row playlist override, reset upload state, etc."
                    @click="toggleRowMenu(item.id, $event)"
                  >⋮</button>
                  <Teleport to="body">
                    <div
                      v-if="rowMenuOpenFor === item.id && rowMenuPos"
                      class="row-kebab-menu"
                      role="menu"
                      :style="{ top: rowMenuPos.top + 'px', left: rowMenuPos.left + 'px', width: rowMenuPos.width + 'px' }"
                    >
                      <div v-if="!item.uploaded && playlists.length" class="rkm-section">
                        <div class="rkm-section-label">Playlist for this upload</div>
                        <select
                          v-model="playlistOverrides[item.episode_code]"
                          class="select select-sm rkm-playlist-select"
                          title="Default = use the project default (set in Playlists tab). Don't add = upload but skip the playlist for this one row only. Or pick a specific playlist."
                        >
                          <option value="">Default ({{ defaultPlaylistId ? (playlists.find((p: any) => p.id === defaultPlaylistId)?.title || '?') : 'none set' }})</option>
                          <option value="_none_">— Don't add —</option>
                          <option v-for="pl in playlists" :key="pl.id" :value="pl.id">{{ pl.title }}</option>
                        </select>
                      </div>
                      <!-- Ready rows (or any not-uploaded row): offer the
                           "Link existing YouTube video" action so users
                           who uploaded manually elsewhere can connect
                           Story Studio to the live video without leaving
                           the Queue. -->
                      <button
                        v-if="!item.uploaded && item.type === 'episode'"
                        class="rkm-item"
                        role="menuitem"
                        @click="openLinkVideoModal(item); closeRowMenu()"
                      >
                        <span class="rkm-icon">🔗</span>
                        <div class="rkm-body">
                          <strong>Link existing YouTube video…</strong>
                          <span class="rkm-hint">Already uploaded this video manually (e.g. via YouTube Studio while travelling)? Pick the orphan video on your channel and we'll write the sidecar so Story Studio knows they're the same — no re-upload.</span>
                        </div>
                      </button>
                      <!-- Two distinct verbs split out of the old "Reset
                           upload state" — the takedown / "I don't want it
                           back" path got buried under generic "reset"
                           wording. Now each verb does ONE thing and the
                           tooltip tells the user when to pick which. -->
                      <button
                        v-if="item.uploaded && !item.deleted_at"
                        class="rkm-item"
                        role="menuitem"
                        @click="doMarkDeletedUpstream(item); closeRowMenu()"
                      >
                        <span class="rkm-icon">🪦</span>
                        <div class="rkm-body">
                          <strong>Mark as deleted upstream</strong>
                          <span class="rkm-hint">Use when YouTube took this video down or you deleted it and DON'T want it back. The historical link is preserved (so audit / reconcile still works), but bulk-upload skips this row going forward.</span>
                        </div>
                      </button>
                      <!-- Un-mark verb: clears the tombstone WITHOUT touching
                           video_id / account_id / schedule. Counterpart to
                           the heavier "Forget link" which wipes the whole
                           sidecar. Right verb when the user marked deleted
                           by accident or confirmed the video is actually
                           fine — keeps the historical link intact. -->
                      <button
                        v-if="item.uploaded && item.deleted_at"
                        class="rkm-item"
                        role="menuitem"
                        @click="doUnmarkDeletedUpstream(item); closeRowMenu()"
                      >
                        <span class="rkm-icon">↩</span>
                        <div class="rkm-body">
                          <strong>Un-mark deleted (keep link)</strong>
                          <span class="rkm-hint">Clears the 🪦 tombstone without touching video_id / account / schedule. Use when you marked this row deleted by accident, or confirmed the upstream video is actually still there. To re-upload from scratch instead, use "Forget link" below.</span>
                        </div>
                      </button>
                      <button
                        v-if="item.uploaded"
                        class="rkm-item"
                        role="menuitem"
                        @click="doResetUploadState(item); closeRowMenu()"
                      >
                        <span class="rkm-icon">🔗</span>
                        <div class="rkm-body">
                          <strong>{{ item.deleted_at ? 'Restore: forget link' : 'Forget link' }}</strong>
                          <span class="rkm-hint">{{ item.deleted_at
                            ? 'Wipes the tombstone so this episode goes back to Ready. Bulk-upload will then re-upload the local final video as a fresh YouTube video.'
                            : 'Wipes the sidecar so this episode goes back to Ready. Use when you uploaded to the WRONG account by accident — the next bulk-upload will re-upload from scratch.' }}</span>
                        </div>
                      </button>
                    </div>
                  </Teleport>
                </span>
              </template>
              <template v-else>
                <button class="btn btn-sm btn-secondary" title="Edit title / description / tags for this import." @click="startEditImport(item)">Edit</button>
                <button class="btn btn-sm btn-danger" title="Remove from queue AND delete the file from disk." @click="doRemoveImport(item)">✕</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Import metadata editor (modal-ish inline card) -->
      <div v-if="editingImport" class="import-editor mt-3">
        <div class="flex justify-between items-center">
          <strong>Edit import metadata — {{ editingImport.filename }}</strong>
          <button class="btn btn-sm btn-ghost" @click="editingImport = null">Cancel</button>
        </div>
        <div class="form-group mt-2">
          <label>Title</label>
          <input v-model="editingImportMeta.title" class="input input-sm" placeholder="e.g. Channel Trailer 2026" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea v-model="editingImportMeta.description" class="textarea" style="min-height: 80px; font-size: 12px;" />
        </div>
        <div class="form-group">
          <label>Tags <span class="text-muted" style="font-size: var(--font-xs); font-weight: normal;">(comma-separated)</span></label>
          <input v-model="editingImportMeta.tagsStr" class="input input-sm" placeholder="trailer, sleep stories, introduction" />
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" @click="saveImportMetaForm">Save</button>
        </div>
      </div>
    </div>

    <!-- ── Missing Video tab ────────────────────────────────────────────
         Split out from the Queue tab in 2026 — combining the two on one
         page meant a project with 200 missing-video episodes rendered a
         giant table even when the user just wanted to see what was
         ready to upload. Now it's its own tab, paginated, and supports
         marking legacy episodes as already-uploaded (uploaded to YouTube
         years ago, no local video file). -->
    <div v-else-if="activeTab === 'missing'" class="card workspace-section upload-tab-panel">
      <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 10px;">
        <div>
          <h3 style="margin: 0">📥 Missing Video</h3>
          <p class="text-muted" style="font-size: 12px; margin: 4px 0 0; max-width: 720px;">
            Episodes that don't have an assembled final video yet. Three ways to get them off this list:
            <strong>1)</strong> Run Video Assembly, <strong>2)</strong> drop an external render into the episode's
            <code>Imported/</code> folder and click Import + Scan, or <strong>3)</strong> mark as already
            uploaded if the video exists only on YouTube (legacy episodes from before Story Studio).
          </p>
        </div>
        <div class="flex gap-2">
          <button
            class="btn btn-sm btn-ghost"
            :disabled="missingLoading"
            title="Force a full re-scan, bypassing the 5-min server-side cache. Use this when an idea you removed from the Ideas tab is still showing here."
            @click="loadMissingVideoEpisodes({ force: true })"
          >
            <LoadingSpinner v-if="missingLoading" size="sm" />
            {{ missingLoading ? 'Loading…' : '↻ Refresh' }}
          </button>
        </div>
      </div>

      <!-- Search + per-page toolbar. Same shape as the pipeline page so
           the muscle memory carries over. -->
      <div v-if="missingVideoEpisodes.length" class="queue-toolbar mt-2">
        <div class="qt-group qt-search">
          <input
            v-model="missingSearch"
            type="search"
            class="input input-sm"
            placeholder="Search episode code or title…"
            title="Substring match against episode_code + title. Case-insensitive."
          />
          <button
            v-if="missingSearch"
            type="button"
            class="qt-search-clear"
            title="Clear search"
            aria-label="Clear search"
            @click="missingSearch = ''"
          >✕</button>
        </div>
        <div class="qt-group">
          <label class="qt-label">Per page</label>
          <select v-model.number="missingPageSize" class="select select-sm">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </div>
        <div class="qt-spacer" />
        <div class="qt-group qt-pager">
          <button class="btn btn-sm btn-secondary" :disabled="missingPage <= 1" @click="missingPage = 1" title="First page">«</button>
          <button class="btn btn-sm btn-secondary" :disabled="missingPage <= 1" @click="missingPage = missingPage - 1">← Prev</button>
          <span class="page-indicator">
            Page <strong>{{ missingPage }}</strong> of {{ missingTotalPages }}
            <span class="text-muted">· {{ missingFilteredEpisodes.length }} item{{ missingFilteredEpisodes.length === 1 ? '' : 's' }}</span>
          </span>
          <button class="btn btn-sm btn-secondary" :disabled="missingPage >= missingTotalPages" @click="missingPage = missingPage + 1">Next →</button>
          <button class="btn btn-sm btn-secondary" :disabled="missingPage >= missingTotalPages" @click="missingPage = missingTotalPages" title="Last page">»</button>
        </div>
      </div>

      <div v-if="missingLoading && !missingVideoEpisodes.length" class="text-muted mt-2" style="font-size: 13px;">
        Scanning episodes for final videos…
      </div>
      <div v-else-if="!missingVideoEpisodes.length" class="text-muted mt-2" style="font-size: 13px;">
        🎉 Every accepted episode has a final video on disk (or has been marked as already uploaded).
      </div>
      <div v-else-if="!missingFilteredEpisodes.length" class="text-muted mt-2" style="font-size: 13px;">
        No episodes match the current search.
      </div>

      <table v-if="missingPaginatedEpisodes.length" class="queue-table mt-2">
        <thead>
          <tr>
            <th>Episode</th>
            <th>Title</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ep in missingPaginatedEpisodes" :key="ep.episode_code">
            <td><strong>{{ ep.episode_code }}</strong></td>
            <td class="col-title">{{ ep.title }}</td>
            <td class="col-actions">
              <div class="row-actions">
                <button
                  class="btn btn-sm btn-secondary"
                  title="Reveal this episode's Imported/ folder in Finder so you can drop a rendered video file into it."
                  @click="doRevealEpisodeImport(ep)"
                >📂 Open folder</button>
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="episodeScanInFlight === ep.episode_code"
                  :title="`Walk this episode's Imported/ folder. Every video file found will be moved into ${ep.episode_code}'s video/ folder as the canonical final render — Pipeline + Queue stop marking this episode as pending.`"
                  @click="doEpisodeScan(ep)"
                >
                  <LoadingSpinner v-if="episodeScanInFlight === ep.episode_code" size="sm" />
                  {{ episodeScanInFlight === ep.episode_code ? 'Scanning…' : '📥 Import + Scan' }}
                </button>
                <span class="row-actions-divider" aria-hidden="true" />
                <button
                  class="btn btn-sm btn-ghost"
                  title="Mark this episode as uploaded elsewhere (different account, archived link, etc.). Opens a small form where you can record a URL + note. Episode shows up in the Queue with a 🔗 External pill so you don't lose track."
                  @click="doMarkLegacyUploaded(ep)"
                >
                  ✓ Mark as uploaded
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ── Plans tab ──────────────────────────────────────────────────── -->
    <div v-else-if="activeTab === 'plans'" class="card workspace-section upload-tab-panel">
      <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 10px;">
        <div>
          <h3 style="margin: 0">Upload Plans</h3>
          <p class="text-muted" style="font-size: 12px; margin: 4px 0 0;">
            A plan is a reusable schedule (weekdays + time, or monthly on day N, optionally every Nth week).
            Applying a plan distributes queued episodes across upcoming slots, writes each one's
            <code>publishAt</code>, and <strong>PATCHes any already-uploaded video's schedule on YouTube live</strong>.
          </p>
        </div>
        <button class="btn btn-sm btn-primary" @click="startNewPlan">+ New Plan</button>
      </div>

      <!-- Plan editor (shown when `editing` is non-null) -->
      <div v-if="editing" class="plan-editor mt-3">
        <div class="plan-editor-head">
          <strong>{{ editing.id ? `Editing "${editing.name || 'Unnamed'}"` : 'New plan' }}</strong>
          <button class="btn btn-sm btn-ghost" @click="editing = null">Cancel</button>
        </div>

        <div class="plan-grid">
          <div class="form-group">
            <label>Plan name</label>
            <input v-model="editing.name" class="input input-sm" placeholder="e.g. Sleep stories — 3×/week" />
          </div>
          <div class="form-group">
            <label>YouTube account</label>
            <select v-model="editing.account_id" class="select select-sm">
              <option v-for="acc in youtubeAccounts" :key="acc.id" :value="acc.id">{{ acc.remote_title }}</option>
            </select>
            <span v-if="!youtubeAccounts.length" class="text-muted" style="font-size: var(--font-xs)">
              Connect a YouTube account on the Accounts tab first.
            </span>
          </div>
          <div class="form-group">
            <label>Time of day
              <span class="text-muted" style="font-size: var(--font-xs); font-weight:normal">({{ editing.schedule.timezone }})</span>
            </label>
            <!-- Native time picker (R5.2). `step="900"` = 15-min steps
                 on the spin buttons, matching YouTube's publishAt grid.
                 Browsers render this as an OS-native stepper/dial, which
                 is dramatically faster than rendering a 96-option
                 datalist and feels more like a "dial" than a combobox. -->
            <input
              v-model="editing.schedule.time_local"
              type="time"
              step="900"
              class="input input-sm"
            />
            <span class="text-muted" style="font-size: var(--font-xs)">
              24-hour time. Use the arrow keys or the native picker to step in 15-minute increments.
            </span>
          </div>
          <div class="form-group">
            <label>Timezone
              <span class="text-muted" style="font-size: var(--font-xs); font-weight:normal">
                (detected: {{ defaultTz }})
              </span>
            </label>
            <div class="tz-picker-row">
              <select v-model="editing.schedule.timezone" class="select select-sm tz-select">
                <optgroup label="Popular">
                  <option v-for="tz in tzPopular" :key="'p-' + tz.id" :value="tz.id">
                    {{ tz.city }} — {{ tz.id }} ({{ tz.offsetLabel }})
                  </option>
                </optgroup>
                <optgroup v-for="region in tzRegions" :key="region.name" :label="region.name">
                  <option v-for="tz in region.zones" :key="region.name + '-' + tz.id" :value="tz.id">
                    {{ tz.city }} — {{ tz.id }} ({{ tz.offsetLabel }})
                  </option>
                </optgroup>
              </select>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                title="Set the timezone to this computer's local zone."
                @click="editing.schedule.timezone = defaultTz"
              >📍 Use detected</button>
            </div>
            <span class="text-muted" style="font-size: var(--font-xs)">
              {{ tzData.total }} IANA zones bundled offline (source: {{ tzData.source }}).
              Offsets shown for January — summer-time zones shift +1h in July.
            </span>
          </div>
          <div class="form-group full-row">
            <label>Weekdays
              <span class="text-muted" style="font-size: var(--font-xs); font-weight:normal">
                (pick any combination — covers daily, weekly, 2–3×/week, etc.)
              </span>
            </label>
            <div class="weekday-row">
              <button
                v-for="(d, i) in WEEKDAY_LABELS"
                :key="i"
                type="button"
                :class="['weekday-btn', { on: editing.schedule.weekdays?.includes(i) }]"
                @click="toggleWeekday(i)"
              >{{ d }}</button>
            </div>
            <!-- Explainer below the weekday pills: tells the user how this
                 composes into daily/weekly/multi-times-per-week behavior. -->
            <div class="explainer">
              <strong>How to use:</strong>
              <ul>
                <li><strong>Daily:</strong> pick all 7 weekdays.</li>
                <li><strong>Weekly on Monday:</strong> pick only Mon.</li>
                <li><strong>3× per week:</strong> pick Mon + Wed + Fri (or any 3 days you want).</li>
                <li><strong>Weekends only:</strong> pick Sat + Sun.</li>
                <li><strong>Bi-weekly (every other week):</strong> pick your weekday(s) + set Interval = "Bi-weekly" below.</li>
                <li><strong>Monthly on the 15th:</strong> leave weekdays empty and fill "monthly on day" with 15.</li>
              </ul>
            </div>
          </div>
          <div class="form-group">
            <label>Interval
              <span class="text-muted" style="font-size: var(--font-xs); font-weight:normal">(every N weeks)</span>
            </label>
            <select v-model.number="editing.schedule.interval_weeks" class="select select-sm">
              <option :value="1">Every week</option>
              <option :value="2">Bi-weekly (every 2 weeks)</option>
              <option :value="3">Every 3 weeks</option>
              <option :value="4">Every 4 weeks</option>
            </select>
          </div>
          <div class="form-group">
            <label>OR monthly on day</label>
            <input
              v-model.number="editing.schedule.monthly_day"
              class="input input-sm"
              type="number"
              min="1" max="31"
              placeholder="(blank = use weekdays)"
            />
            <span class="text-muted" style="font-size: var(--font-xs)">
              When set, weekdays are ignored — e.g. 15 = the 15th of every month.
            </span>
          </div>
          <div class="form-group">
            <label>Start date</label>
            <input v-model="editing.schedule.start_date" class="input input-sm" type="date" />
            <span class="text-muted" style="font-size: var(--font-xs)">
              <strong>What it does:</strong> the first day this plan can fire a slot. Useful when the first
              episode in your queue should publish on a specific future date (e.g. "next Monday" for a season
              launch). <strong>Blank = start from today.</strong>
            </span>
          </div>
          <div class="form-group">
            <label>End date <span class="text-muted" style="font-size: var(--font-xs); font-weight:normal">(optional)</span></label>
            <input v-model="editing.schedule.end_date" class="input input-sm" type="date" />
            <span class="text-muted" style="font-size: var(--font-xs)">
              <strong>What it does:</strong> last day this plan will fire a slot. After this date, Apply
              produces no more times. <strong>Blank = the plan runs indefinitely.</strong>
              Use when you want a bounded campaign (e.g. "stop after the season finale on Oct 31").
            </span>
          </div>
          <div class="form-group">
            <label>Default privacy
              <span class="text-muted" style="font-size: var(--font-xs); font-weight:normal">(applied on upload)</span>
            </label>
            <select v-model="editing.defaults.privacy_status" class="select select-sm">
              <option value="private">Private (scheduled via publishAt)</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public immediately</option>
            </select>
          </div>
        </div>

        <div class="plan-actions">
          <button class="btn btn-primary btn-sm" @click="savePlanForm">Save plan</button>
          <button class="btn btn-sm btn-ghost" :disabled="!editing.id" @click="runPreview" title="Shows the next 10 slots this plan would fire. Save first if you just edited.">
            👁 Preview slots
          </button>
        </div>

        <div v-if="previewSlots.length" class="preview-list">
          <strong style="font-size: 12px;">Next {{ previewSlots.length }} slots</strong>
          <ol>
            <li v-for="(slot, i) in previewSlots" :key="i">
              {{ new Date(slot).toLocaleString() }}
              <span class="text-muted" style="font-size: var(--font-xs)">({{ slot }})</span>
            </li>
          </ol>
        </div>
      </div>

      <!-- Plans table -->
      <div v-if="plansLoading && !plans.length" class="text-muted mt-2" style="font-size:13px">Loading plans…</div>
      <div v-else-if="!plans.length && !editing" class="text-muted mt-3" style="font-size:13px">
        No plans yet. Click <strong>+ New Plan</strong> to create one.
      </div>
      <table v-else-if="plans.length" class="plans-table mt-3">
        <thead>
          <tr>
            <th>Name</th>
            <th>Schedule</th>
            <th>Platform · Account</th>
            <th>Active?</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in displayedPlans" :key="p.id">
            <td><strong>{{ p.name }}</strong></td>
            <td style="font-size: 12px;">
              <template v-if="p.schedule.monthly_day">
                Monthly · day {{ p.schedule.monthly_day }} at {{ p.schedule.time_local }} {{ p.schedule.timezone }}
              </template>
              <template v-else>
                {{ p._weekdayLabel }}
                at {{ p.schedule.time_local }} {{ p.schedule.timezone }}
                <span v-if="p.schedule.interval_weeks && p.schedule.interval_weeks > 1">
                  · every {{ p.schedule.interval_weeks }} weeks
                </span>
              </template>
            </td>
            <td style="font-size: 12px;">
              {{ p.platform }} ·
              {{ youtubeAccounts.find((a: any) => a.id === p.account_id)?.remote_title || p.account_id }}
            </td>
            <td>
              <span v-if="activePlanMap[`${p.platform}:${p.account_id}`] === p.id" class="meta-pill ok">✓ Active</span>
              <button v-else class="btn btn-sm btn-ghost" @click="doActivatePlan(p)">Make active</button>
            </td>
            <td class="col-actions">
              <div class="row-actions">
              <!-- Apply verb opens a scope picker (Selection / All unuploaded /
                   Next 5 / This page). Replaces the old "Apply to Queue" which
                   only operated on the current page's items. -->
              <button
                class="btn btn-sm btn-primary plan-action-btn"
                :disabled="applying || applyAndUploading || uploadMode === 'private'"
                :title="uploadMode === 'private'
                  ? 'Apply-plan is disabled while Schedule mode is set to \u201CUpload private, schedule in YouTube Studio\u201D. Change mode on the Accounts tab to re-enable.'
                  : 'Pick which episodes this plan should schedule. Writes per-item publishAt + patches any already-uploaded video.'"
                @click="openPlanScopePicker($event, p, 'apply')"
              >
                <LoadingSpinner v-if="applying && scopeBusyPlanId === p.id" size="sm" />
                📅 Apply ▾
              </button>
              <!-- Item H — three split-out verbs:
                     ☁️ Upload only — fan out uploads; assumes schedule
                                       already applied (or you don't care).
                     🚀 Apply + Upload — combo: apply schedule THEN fan
                                          out uploads. The common case.
                   Both quota-capped. Each opens the scope picker so the
                   action targets exactly what the user means. -->
              <button
                class="btn btn-sm btn-primary plan-action-btn"
                :disabled="applying || applyAndUploading || uploadMode === 'private'"
                :title="uploadMode === 'private'
                  ? 'Upload-with-plan is disabled in private mode. Switch to Apply-plan mode on the Accounts tab.'
                  : 'Fan out actual uploads — assumes the schedule has already been applied. Quota-capped. For one-click apply+upload, use the next button.'"
                @click="openPlanScopePicker($event, p, 'upload')"
              >
                <LoadingSpinner v-if="applyAndUploading && scopeBusyPlanId === p.id" size="sm" />
                ☁️ Upload only ▾
              </button>
              <button
                class="btn btn-sm btn-primary plan-action-btn"
                :disabled="applying || applyAndUploading || uploadMode === 'private'"
                :title="uploadMode === 'private'
                  ? 'Apply + Upload is disabled in private mode. Switch to Apply-plan mode on the Accounts tab.'
                  : 'Apply this plan AND fan out uploads in one click. Quota-capped — uploads stop when today’s quota is spent. The common case.'"
                @click="openPlanScopePicker($event, p, 'apply_upload')"
              >
                <LoadingSpinner v-if="applyAndUploading && scopeBusyPlanId === p.id" size="sm" />
                🚀 Apply + Upload ▾
              </button>
              <button
                class="btn btn-sm btn-ghost plan-action-btn"
                :disabled="applying || applyAndUploading"
                title="Remove per-item schedule entries this plan would have produced for the chosen scope. Useful if you applied the wrong plan and want to undo without deleting it."
                @click="openPlanScopePicker($event, p, 'unapply')"
              >↩ Unapply ▾</button>
              <span class="row-actions-divider" aria-hidden="true" />
              <button class="btn btn-sm btn-ghost" @click="startEditPlan(p)">Edit</button>
              <button class="btn btn-sm btn-danger" @click="doDeletePlan(p)">Delete</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ── Playlists tab (A4) ──────────────────────────────────────── -->
    <div v-else-if="activeTab === 'playlists'" class="card workspace-section upload-tab-panel">
      <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 10px;">
        <div>
          <h3 style="margin: 0">YouTube Playlists</h3>
          <p class="text-muted" style="font-size: 12px; margin: 4px 0 0; max-width: 720px;">
            Playlists on your connected channel. Pick one as your <strong>default</strong> and new uploads are
            auto-added to it (no-op if you deselect). Create a new playlist from here without leaving Story Studio.
            Cached 60s per account to avoid quota waste.
          </p>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-sm btn-primary" :disabled="playlistsLoading" @click="showCreatePlaylist = true">+ New Playlist</button>
          <button class="btn btn-sm btn-ghost" :disabled="playlistsLoading" @click="loadPlaylists(true)">
            <LoadingSpinner v-if="playlistsLoading" size="sm" />
            {{ playlistsLoading ? 'Fetching…' : '↻ Refresh' }}
          </button>
        </div>
      </div>

      <div v-if="showCreatePlaylist" class="create-playlist-card mt-2">
        <strong>New playlist</strong>
        <div class="form-group mt-1">
          <label>Title</label>
          <input v-model="newPlaylistForm.title" class="input input-sm" placeholder="e.g. Sleep Stories 2026" />
        </div>
        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom: 4px;">
            <label style="margin: 0;">Description <span class="text-muted" style="font-size: var(--font-xs); font-weight: normal;">(optional)</span></label>
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              :disabled="!newPlaylistForm.title || generatingPlaylistDesc"
              :title="!newPlaylistForm.title
                ? 'Enter a title first — the LLM reads it for context.'
                : 'Generate a description from the title + your project niche/format'"
              @click="doGeneratePlaylistDescription"
            >
              {{ generatingPlaylistDesc ? 'Writing…' : '✨ Generate with AI' }}
            </button>
          </div>
          <textarea v-model="newPlaylistForm.description" class="textarea" style="min-height: 80px; font-size: 12px;" />
          <p v-if="newPlaylistForm.description" class="text-muted" style="font-size: var(--font-xs); margin-top: 4px;">
            {{ newPlaylistForm.description.length }} chars
            <template v-if="newPlaylistForm.description.length > 5000">
              <strong class="text-warn">— YouTube caps playlist descriptions at 5000.</strong>
            </template>
          </p>
        </div>
        <div class="form-group">
          <label>Privacy</label>
          <select v-model="newPlaylistForm.privacyStatus" class="select select-sm">
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" @click="doCreatePlaylist">Create</button>
          <button class="btn btn-ghost btn-sm" @click="showCreatePlaylist = false">Cancel</button>
        </div>
      </div>

      <div v-if="playlistsError" class="text-danger mt-2" style="font-size: 13px; padding: 10px 12px; background: rgba(248, 81, 73, 0.06); border: 1px solid rgba(248, 81, 73, 0.25); border-radius: var(--radius-sm);">
        ⚠ {{ playlistsError }}
      </div>
      <div v-if="playlistsLoading && !playlists.length" class="text-muted mt-2" style="font-size: 13px;">Loading channel playlists…</div>
      <div v-else-if="!playlists.length && !playlistsError" class="text-muted mt-2" style="font-size: 13px;">
        No playlists on this channel yet. Click <strong>+ New Playlist</strong> to create one.
      </div>
      <table v-else class="plans-table mt-2">
        <thead>
          <tr>
            <th>Default?</th>
            <th>Title</th>
            <th>Privacy</th>
            <th>Videos</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pl in playlists" :key="pl.id" :class="{ 'is-default': defaultPlaylistId === pl.id }">
            <td>
              <span v-if="defaultPlaylistId === pl.id" class="default-badge"
                    :title="'This playlist is the project default. New uploads to this channel will be auto-added.'">
                ✓ DEFAULT
              </span>
              <button v-else
                class="btn btn-sm btn-ghost btn-make-default"
                title="Make this playlist the project default. New uploads will be auto-added."
                @click="doSetDefaultPlaylist(pl.id)"
              >
                Make default
              </button>
              <!-- Old radio kept commented out for reference; the badge +
                   button pair above replaces it because the disabled
                   radio didn't read as "currently active". -->
              <input
                v-if="false"
                type="radio"
                name="default-playlist"
                class="default-radio"
                :checked="defaultPlaylistId === pl.id"
                :disabled="defaultPlaylistId === pl.id"
                :title="`Make \u201C${pl.title}\u201D the default playlist. New uploads will be auto-added.`"
                @change="doSetDefaultPlaylist(pl.id)"
              />
            </td>
            <td>
              <strong>{{ pl.title }}</strong>
              <div v-if="pl.description" class="text-muted" style="font-size: var(--font-xs);">{{ pl.description.slice(0, 120) }}{{ pl.description.length > 120 ? '…' : '' }}</div>
            </td>
            <td>
              <span :class="['meta-pill', pl.privacyStatus === 'public' ? 'ok' : pl.privacyStatus === 'unlisted' ? 'warn' : 'muted']">
                {{ pl.privacyStatus }}
              </span>
            </td>
            <td style="font-size: 12px;">{{ pl.itemCount }}</td>
            <td class="col-actions">
              <div class="row-actions">
                <a :href="`https://www.youtube.com/playlist?list=${pl.id}`" target="_blank" rel="noopener" class="btn btn-sm btn-ghost">Open ↗</a>
                <button
                  v-if="defaultPlaylistId === pl.id"
                  class="btn btn-sm btn-ghost"
                  title="Remove this playlist as the default. New uploads won't be auto-added to any playlist."
                  @click="doSetDefaultPlaylist('')"
                >Clear default</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ── Match unlinked tab (was: Reconcile) ───────────────────────── -->
    <!-- Item A — renamed to make the asymmetry vs. Sync explicit:
         Sync = "is what we already linked still accurate?" (drift detection
                 on rows that already have a sidecar)
         Match unlinked = "are there channel videos we don't know about?"
                          (fuzzy-match scan finding orphans to link)
         Same code, clearer copy. -->
    <div v-else-if="activeTab === 'reconcile'" class="card workspace-section upload-tab-panel">
      <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 10px;">
        <div>
          <h3 style="margin: 0">Match unlinked videos</h3>
          <p class="text-muted" style="font-size: 12px; margin: 4px 0 0; max-width: 720px;">
            Finds channel videos Story Studio doesn't know about yet and proposes which local episode each one is.
            Distinct from <strong>Sync from YouTube</strong> (which only checks already-linked rows for drift) — this scans
            for <strong>missing</strong> links. Fuzzy-matches up to ~400 recent videos against your local episodes; you confirm
            each link, and Story Studio writes the per-episode sidecar so re-uploading from here PATCHes metadata on the
            existing video instead of creating a duplicate. Safe to re-run.
          </p>
        </div>
        <button class="btn btn-sm btn-primary" :disabled="reconcileLoading" @click="runReconcilePreview">
          <LoadingSpinner v-if="reconcileLoading" size="sm" />
          {{ reconcileLoading ? 'Fetching…' : '🔍 Scan channel for matches' }}
        </button>
      </div>

      <div v-if="!reconcileState" class="text-muted mt-2" style="font-size: 13px;">
        Click <strong>Fetch channel + preview</strong> to pull recent videos and propose matches.
      </div>

      <div v-else class="mt-2">
        <!-- Status chips: count of each link state across the WHOLE preview
             (not the filtered view), so the user always knows the full
             scope. The "showing N–M of total" segment shows what's
             currently rendered after filter + pagination. -->
        <div class="reconcile-summary">
          <span class="state-chip linked" :title="'Already confirmed in a previous reconcile run — sidecar exists.'">
            🔗 {{ reconcileStateCounts.linked }} linked
          </span>
          <span class="state-chip suggested" :title="'High-confidence auto-match — verify the dropdown and Save to confirm.'">
            ✅ {{ reconcileStateCounts.suggested }} suggested
          </span>
          <span class="state-chip review" :title="'Lower-confidence title match — verify the dropdown carefully before saving.'">
            ⚠️ {{ reconcileStateCounts.review }} review
          </span>
          <span class="state-chip manual" :title="'No automatic match — pick an episode in the dropdown manually.'">
            ❓ {{ reconcileStateCounts.manual }} manual
          </span>
          <span class="reconcile-shown text-muted">
            <template v-if="reconcileShownRange.total > 0">
              showing {{ reconcileShownRange.from }}–{{ reconcileShownRange.to }} of {{ reconcileShownRange.total }}
            </template>
            <template v-else>no rows match this filter</template>
          </span>
        </div>

        <!-- Filter + sort + page-size controls. Filter defaults to
             "Unlinked only" so re-running reconcile after a confirm
             doesn't surface the rows we just saved. -->
        <div class="reconcile-controls">
          <label class="control-label" title="Filter by YouTube title, video ID, or the episode code currently selected/suggested for the row.">
            Search
            <input
              v-model="reconcileSearch"
              type="search"
              class="input input-sm"
              placeholder="Title, video ID, episode…"
              style="min-width: 14rem"
            >
          </label>
          <label class="control-label" title="Show only the rows you can act on. Switch to All to see everything, or Linked to review what's already confirmed.">
            Filter
            <select v-model="reconcileFilter" class="select select-sm">
              <option value="unlinked">Unlinked only</option>
              <option value="all">All</option>
              <option value="linked">Linked</option>
              <option value="suggested">Suggested</option>
              <option value="review">Needs review</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <label class="control-label" title="Episode-code matches always rank highest, then title-similarity by score.">
            Sort
            <select v-model="reconcileSort" class="select select-sm">
              <option value="confidence_desc">Match confidence</option>
              <option value="episode_asc">Episode code · oldest first</option>
              <option value="episode_desc">Episode code · newest first</option>
              <option value="published_desc">Newest published</option>
              <option value="published_asc">Oldest published</option>
              <option value="title_asc">Title A→Z</option>
              <option value="title_desc">Title Z→A</option>
            </select>
          </label>
          <label class="control-label">
            Per page
            <select v-model.number="reconcilePageSize" class="select select-sm">
              <option :value="10">10</option>
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
            </select>
          </label>
        </div>

        <table class="queue-table mt-2">
          <thead>
            <tr>
              <th>Channel video</th>
              <th>Status</th>
              <th>Link to episode</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in reconcileDisplayRows" :key="row.videoId" :class="{ 'row-linked': row._state === 'linked' }">
              <td>
                <a :href="`https://youtu.be/${row.videoId}`" target="_blank" rel="noopener" class="video-link">
                  {{ row.title || '(untitled)' }}
                </a>
                <div class="text-muted" style="font-size: var(--font-xs);">
                  <code>{{ row.videoId }}</code>
                  <span v-if="row.publishedAt"> · published {{ new Date(row.publishedAt).toLocaleDateString() }}</span>
                  <span v-if="row.privacyStatus"> · {{ row.privacyStatus }}</span>
                </div>
              </td>
              <td>
                <span :class="['meta-pill', row._state]" :title="row._label">
                  {{ row._label }}
                </span>
              </td>
              <td>
                <!-- Searchable typeahead via datalist (Chromium renders
                     it as a popup with substring + prefix matching). The
                     datalist is shared across rows below the table so we
                     don't render N×M options. Picker shows EVERY accepted
                     episode, including ones already linked elsewhere — the
                     ⚠ in the option label warns the user when picking one
                     would override an existing link. -->
                <input
                  v-model="row.selected_episode_code"
                  list="reconcile-episode-list"
                  type="text"
                  class="input input-sm"
                  style="min-width: 200px;"
                  placeholder="Type code or title…"
                  :title="row._state === 'linked' ? 'This video is already linked. Type a different episode code to re-link (you’ll be asked to confirm before saving).' : 'Type to search across every accepted episode (including ones already linked).'"
                >
                <!-- Inline override hint when the picked episode is
                     already bound to a different video. Badge below the
                     input keeps the layout flat without a popover. -->
                <div
                  v-if="reconcileEpisodeOverrideHint(row.selected_episode_code, row.videoId)"
                  class="meta-pill warn"
                  style="margin-top: 4px; font-size: var(--font-xs);"
                  :title="`Saving will replace ${row.selected_episode_code}'s existing link from ${reconcileEpisodeOverrideHint(row.selected_episode_code, row.videoId)} to this video. The other video becomes orphan.`"
                >
                  ⚠ {{ row.selected_episode_code }} currently links to {{ reconcileEpisodeOverrideHint(row.selected_episode_code, row.videoId).slice(0, 8) }}…
                </div>
                <!-- Per-row "Sync title from YouTube" opt-in. When checked
                     AND a code is selected, Save also overwrites the
                     episode's ideas.json title with the YouTube title so
                     the two stay in sync going forward. -->
                <label
                  v-if="row.title"
                  class="text-muted"
                  style="margin-top: 4px; display: inline-flex; gap: 4px; align-items: center; font-size: var(--font-xs);"
                  :title="`On Save, also overwrite ${row.selected_episode_code || 'the episode'}'s title in ideas.json with the YouTube title (“${row.title.slice(0, 60)}${row.title.length > 60 ? '…' : ''}”). Useful when re-linking after a YT-side rename so the two stay aligned.`"
                >
                  <input
                    type="checkbox"
                    v-model="row.apply_remote_title"
                    :disabled="!row.selected_episode_code"
                  >
                  Sync YT title
                </label>
                <!-- Inline "create new episode" escape hatch for Reconcile —
                     saves a trip to the Unlinked Uploads tab when the user
                     realizes this remote video doesn't match any local
                     episode. Bypasses the Save-selected-links flow and
                     adopts the video as a brand-new episode with the code
                     typed here. Hidden for already-linked rows since the
                     video already maps to an episode. -->
                <div v-if="row._state !== 'linked'" style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
                  <input
                    v-model="orphanCodeDraft[row.videoId]"
                    class="input input-sm"
                    style="max-width: 110px; font-size: var(--font-xs);"
                    :placeholder="`or new: TN${String(orphansNextNumber).padStart(4, '0')}`"
                    :title="`Type a new episode code + click Adopt to create a synthetic episode from this video. Use this when the remote video has no matching local episode and you want Story Studio to take over managing it. This is equivalent to the per-row Adopt on the Unlinked Uploads tab.`"
                  />
                  <button
                    class="btn btn-sm btn-secondary"
                    style="padding: 2px 8px; font-size: var(--font-xs);"
                    :disabled="orphanBusy || !orphanCodeDraft[row.videoId]?.trim()"
                    @click="doAdoptSingleOrphan({ videoId: row.videoId, title: row.title, publishedAt: row.publishedAt, privacyStatus: row.privacyStatus })"
                  >Adopt</button>
                </div>
              </td>
              <td class="col-actions">
                <span v-if="row._state === 'linked' && row.selected_episode_code !== reconcileState.linked_videos[row.videoId]"
                      class="meta-pill warn" style="font-size: var(--font-xs);" :title="`Will replace the existing link from ${reconcileState.linked_videos[row.videoId]} to ${row.selected_episode_code}.`">
                  ⚠ re-link
                </span>
                <span v-else-if="row.suggested_episode_code && row.selected_episode_code !== row.suggested_episode_code"
                      class="text-muted" style="font-size: var(--font-xs);" :title="`Matcher suggested ${row.suggested_episode_code}; you changed it.`">
                  ✎ edited
                </span>
              </td>
            </tr>
            <tr v-if="!reconcileDisplayRows.length">
              <td colspan="4" class="text-muted" style="text-align: center; padding: 24px; font-size: 12px;">
                No videos match the current filter. Try switching to <strong>All</strong> or <strong>Unlinked only</strong>, or run preview again.
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Single shared datalist powering the per-row episode picker
             above. Browsers (Chromium-based, including Electron) match
             input value against `value` AND `label`, so typing a title
             keyword finds matches too. The ⚠ prefix on linked-elsewhere
             options is a soft visual cue; the inline override pill in
             the row is the hard one. -->
        <datalist id="reconcile-episode-list">
          <option
            v-for="ep in reconcilePickerOptions"
            :key="ep.episode_code"
            :value="ep.episode_code"
            :label="`${ep.title ? ep.title.slice(0, 60) : ''}${ep.linked_to ? '  ⚠ linked' : ''}`"
          />
        </datalist>

        <!-- Pagination — mirrors the Queue tab pattern. Disabled buttons
             when at the boundary; clamped goToReconcilePage handles edge
             cases. -->
        <div v-if="reconcileTotalPages > 1" class="reconcile-pager mt-2">
          <button class="btn btn-sm btn-secondary" :disabled="reconcilePage <= 1" @click="goToReconcilePage(1)" title="First page">«</button>
          <button class="btn btn-sm btn-secondary" :disabled="reconcilePage <= 1" @click="goToReconcilePage(reconcilePage - 1)">← Prev</button>
          <span class="page-indicator">
            Page <strong>{{ reconcilePage }}</strong> of {{ reconcileTotalPages }}
          </span>
          <button class="btn btn-sm btn-secondary" :disabled="reconcilePage >= reconcileTotalPages" @click="goToReconcilePage(reconcilePage + 1)">Next →</button>
          <button class="btn btn-sm btn-secondary" :disabled="reconcilePage >= reconcileTotalPages" @click="goToReconcilePage(reconcileTotalPages)" title="Last page">»</button>
        </div>

        <div class="flex gap-2 mt-2">
          <button class="btn btn-primary" :disabled="reconcileConfirming" @click="doReconcileConfirm">
            <LoadingSpinner v-if="reconcileConfirming" size="sm" />
            {{ reconcileConfirming ? 'Saving…' : '✓ Save selected links' }}
          </button>
          <button class="btn btn-ghost" @click="reconcileState = null">Close</button>
        </div>
      </div>
    </div>

    <!-- ── Unlinked Uploads tab (#7) ───────────────────────────────── -->
    <div v-else-if="activeTab === 'orphans'" class="card workspace-section upload-tab-panel">
      <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 10px;">
        <div>
          <h3 style="margin: 0">Unlinked Uploads</h3>
          <p class="text-muted" style="font-size: 12px; margin: 4px 0 0; max-width: 720px;">
            Videos on your connected YouTube channel that aren't linked to a local episode. Typical on first use
            if you've been uploading before Story Studio. Adopt them one at a time (with any episode code you like)
            or in bulk (see modes below).
          </p>
        </div>
        <button class="btn btn-sm btn-ghost" :disabled="orphansLoading" @click="loadOrphans">
          <LoadingSpinner v-if="orphansLoading" size="sm" />
          {{ orphansLoading ? 'Fetching…' : '↻ Refresh' }}
        </button>
      </div>

      <!-- Item L — renumber-undo banner. Visible only when a recent
           bulk-renumber wrote a `.renumber-undo.json` sidecar to the
           project root. Lets the user fully revert (orphans removed +
           ideas.json restored + folders renamed back) within 30 days.
           Auto-cleans on Electron boot, but the user can also dismiss
           the safety net early once they're confident. -->
      <div v-if="renumberUndoStatus.available" class="renumber-undo-banner mt-2">
        <div class="renumber-undo-banner-icon" aria-hidden="true">↩</div>
        <div class="renumber-undo-banner-body">
          <strong>A renumber is reversible</strong>
          <div class="text-muted" style="font-size: 12px; margin-top: 2px;">
            On <strong>{{ formatScheduled(renumberUndoStatus.plan?.performed_at || '') }}</strong>,
            this project renumbered <strong>{{ renumberUndoStatus.renamed_count }}</strong>
            existing episode{{ renumberUndoStatus.renamed_count === 1 ? '' : 's' }}
            and adopted <strong>{{ renumberUndoStatus.adopted_count }}</strong>
            channel video{{ renumberUndoStatus.adopted_count === 1 ? '' : 's' }} into the leading slots.
            <br />
            Click <em>Revert</em> to undo every stage (folders renamed back, adopted episodes removed,
            ideas.json restored). The safety net auto-deletes after 30 days, or click <em>Dismiss</em> when you're confident.
          </div>
        </div>
        <div class="renumber-undo-banner-actions">
          <button
            class="btn btn-sm btn-secondary"
            :disabled="renumberUndoBusy"
            title="Open the revert confirmation modal — shows exactly what will be undone before any state changes."
            @click="openRevertRenumberModal"
          >↩ Revert renumber</button>
          <button
            class="btn btn-sm btn-ghost"
            :disabled="renumberUndoBusy"
            title="Delete the .renumber-undo.json sidecar — the project state stays as it is, but a future revert won't be available."
            @click="dismissRenumberUndo"
          >Dismiss</button>
        </div>
      </div>

      <!-- v1.0.45 — reseason-undo banner (sibling to renumber). Visible
           only when a recent Settings → Project → Rebalance wrote a
           `.reseason-undo.json` sidecar. Lets the user move every
           rebalanced folder back to its original Season NNN/ parent
           and restore the previous season_size in one click. Same
           30-day TTL + Dismiss pattern as the renumber banner. -->
      <div v-if="reseasonUndoStatus.available" class="renumber-undo-banner mt-2">
        <div class="renumber-undo-banner-icon" aria-hidden="true">↩</div>
        <div class="renumber-undo-banner-body">
          <strong>A reseason is reversible</strong>
          <div class="text-muted" style="font-size: 12px; margin-top: 2px;">
            On <strong>{{ formatScheduled(reseasonUndoStatus.plan?.performed_at || '') }}</strong>,
            this project rebalanced <strong>{{ reseasonUndoStatus.moves_count }}</strong>
            episode folder{{ reseasonUndoStatus.moves_count === 1 ? '' : 's' }} from
            <strong>{{ reseasonUndoStatus.plan?.previous_season_size }}</strong> →
            <strong>{{ reseasonUndoStatus.plan?.new_season_size }}</strong> per group.
            <br />
            Click <em>Revert</em> to move folders back AND restore the previous group size.
            External-root mirror is reverted in the same step. Auto-deletes after 30 days,
            or click <em>Dismiss</em> when you're confident.
          </div>
        </div>
        <div class="renumber-undo-banner-actions">
          <button
            class="btn btn-sm btn-secondary"
            :disabled="reseasonUndoBusy"
            title="Move every rebalanced folder back to its original Season parent and restore the old season_size."
            @click="openRevertReseasonModal"
          >↩ Revert reseason</button>
          <button
            class="btn btn-sm btn-ghost"
            :disabled="reseasonUndoBusy"
            title="Delete the .reseason-undo.json sidecar. State stays as it is; future revert won't be available."
            @click="dismissReseasonUndo"
          >Dismiss</button>
        </div>
      </div>

      <div v-if="orphansError" class="text-danger mt-2" style="font-size: 13px; padding: 10px 12px; background: rgba(248, 81, 73, 0.06); border: 1px solid rgba(248, 81, 73, 0.25); border-radius: var(--radius-sm);">
        ⚠ {{ orphansError }}
      </div>

      <div v-else-if="orphansLoading && !orphans.length" class="text-muted mt-2" style="font-size: 13px;">
        Fetching channel uploads…
      </div>

      <div v-else-if="!orphans.length" class="text-muted mt-2" style="font-size: 13px;">
        No unlinked videos — every video on your channel is already linked to a local episode. Click Refresh if you
        just uploaded something outside Story Studio.
      </div>

      <template v-else>
        <!-- Bulk action bar -->
        <div class="orphan-bulk-bar mt-3">
          <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
            <label class="text-muted" style="font-size: var(--font-xs);">
              <input type="checkbox" :checked="selectedOrphanIds.size === orphans.length" @change="selectAllOrphans(($event.target as HTMLInputElement).checked)" />
              Select all ({{ orphans.length }})
            </label>
            <strong v-if="selectedOrphanIds.size" style="font-size: 12px;">{{ selectedOrphanIds.size }} selected</strong>
          </div>
          <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
            <label class="text-muted" style="font-size: var(--font-xs);">
              Bulk mode:
              <select v-model="orphanBulkMode" class="select select-sm" style="margin-left: 4px;">
                <option value="continuation">Continuation codes</option>
                <option value="renumber">Renumber (orphans take the lead)</option>
              </select>
            </label>
            <button
              class="btn btn-sm btn-primary"
              :disabled="orphanConfirming || !selectedOrphanIds.size"
              @click="doBulkAdoptOrphans"
            >
              <LoadingSpinner v-if="orphanConfirming" size="sm" />
              {{ orphanConfirming ? 'Adopting…' : `📥 Adopt ${selectedOrphanIds.size || 'selected'}` }}
            </button>
          </div>
        </div>
        <div class="explainer mt-2">
          <strong>Modes:</strong>
          <ul>
            <li><strong>Continuation codes</strong> — orphans are assigned the next available codes starting at <code>TN{{ String(orphansNextNumber).padStart(4, '0') }}</code>. Existing local episodes keep their codes. Non-destructive.</li>
            <li><strong>Renumber</strong> — orphans take the LEADING codes (TN0001, TN0002, …) in chronological order of their YouTube publish date. Every existing accepted episode is shifted forward by the orphan count, and its folder is renamed on disk. Useful when the YouTube content predates Story Studio and should sit at the start of the numbering. <strong>Destructive: double-check before confirming.</strong></li>
          </ul>
        </div>

        <table class="queue-table mt-3">
          <thead>
            <tr>
              <th style="width: 30px;"></th>
              <th>YouTube video</th>
              <th>Published</th>
              <th>Assign episode code</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orphans" :key="o.videoId">
              <td>
                <input
                  type="checkbox"
                  :checked="selectedOrphanIds.has(o.videoId)"
                  @change="toggleOrphanSelected(o.videoId)"
                />
              </td>
              <td>
                <a :href="`https://youtu.be/${o.videoId}`" target="_blank" rel="noopener" class="video-link">
                  {{ o.title || '(untitled)' }}
                </a>
                <div class="text-muted" style="font-size: var(--font-xs);">
                  <code>{{ o.videoId }}</code>
                  <span v-if="o.privacyStatus"> · {{ o.privacyStatus }}</span>
                </div>
              </td>
              <td style="font-size: 12px; color: var(--text-secondary);">
                {{ o.publishedAt ? new Date(o.publishedAt).toLocaleDateString() : '—' }}
              </td>
              <td>
                <input
                  v-model="orphanCodeDraft[o.videoId]"
                  class="input input-sm"
                  style="max-width: 140px;"
                  :placeholder="`e.g. TN${String(orphansNextNumber).padStart(4, '0')}`"
                />
              </td>
              <td class="col-actions">
                <button
                  class="btn btn-sm btn-secondary"
                  :disabled="orphanBusy || !orphanCodeDraft[o.videoId]?.trim()"
                  title="Creates a new accepted episode with this code, folder + sidecar linking to this YouTube video. Existing episodes are untouched."
                  @click="doAdoptSingleOrphan(o)"
                >Adopt</button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>

    <!-- ── Analytics tab (extracted to components/upload/AnalyticsTab.vue, v1.0.341) ── -->
    <AnalyticsTab v-else-if="activeTab === 'analytics'" :slug="slug" @reauth="activeTab = 'accounts'" />
    <!-- ── Comments tab ─────────────────────────────────────────────── -->
    <div v-else-if="activeTab === 'comments'" class="card workspace-section upload-tab-panel">
      <div class="card-header">
        <h3>Comments</h3>
        <div class="flex gap-2 items-center" style="flex-wrap: wrap;">
          <select v-model="commentsVideoSelection" class="input input-sm" style="min-width: 280px;" @change="onCommentsVideoChange">
            <option value="">— Pick an uploaded episode —</option>
            <option v-for="item in commentsVideoOptions" :key="item.video_id" :value="item.video_id">
              {{ item.label }}
            </option>
            <option value="__other__">Other video (paste URL)…</option>
          </select>
          <input
            v-if="commentsVideoSelection === '__other__'"
            v-model="commentsVideoInput"
            class="input input-sm"
            type="text"
            placeholder="Paste YouTube video URL or ID"
            style="min-width: 280px"
            @keydown.enter="loadComments(true)"
          />
          <button class="btn btn-sm btn-primary" :disabled="commentsLoading || !commentsResolvedVideoId" @click="loadComments(true)">
            {{ commentsLoading ? 'Loading…' : 'Load comments' }}
          </button>
        </div>
      </div>
      <p class="text-muted mt-1" style="font-size: 12px">
        Top-level comments on a single video, newest first. AI-drafted replies use the project name and the same language the viewer wrote in.
        Posting a reply costs 50 YouTube quota units.
      </p>

      <div v-if="commentsError" class="error-card mt-2">
        <strong>Couldn't load comments.</strong>
        <p>{{ commentsError }}</p>
      </div>

      <div v-if="commentsResult && !commentsResult.threads.length && !commentsLoading" class="empty-state mt-2">
        <p>No top-level comments on this video yet.</p>
      </div>

      <ul v-if="commentsResult?.threads?.length" class="thread-list mt-2">
        <li v-for="thread in commentsResult.threads" :key="thread.id" class="thread">
          <header class="thread-head">
            <img v-if="thread.top_comment.author_avatar" :src="thread.top_comment.author_avatar" alt="" class="thread-avatar" />
            <div class="thread-meta">
              <strong class="thread-author">{{ thread.top_comment.author }}</strong>
              <span class="text-muted thread-stamp">{{ formatRelativeTime(thread.top_comment.published_at) }} · {{ thread.top_comment.like_count }} like{{ thread.top_comment.like_count === 1 ? '' : 's' }}</span>
            </div>
          </header>
          <p class="thread-text">{{ thread.top_comment.text }}</p>

          <ul v-if="thread.replies.length" class="thread-replies">
            <li v-for="reply in thread.replies" :key="reply.id" class="thread-reply">
              <strong>{{ reply.author }}</strong>
              <span class="text-muted thread-stamp">{{ formatRelativeTime(reply.published_at) }}</span>
              <span class="reply-text">{{ reply.text }}</span>
            </li>
          </ul>
          <p v-if="thread.reply_count > thread.replies.length" class="text-muted thread-more">
            +{{ thread.reply_count - thread.replies.length }} more reply(s) on YouTube
          </p>

          <!-- Reply composer -->
          <div v-if="thread.can_reply" class="reply-composer">
            <textarea
              v-model="replyDrafts[thread.id]"
              class="input"
              rows="2"
              placeholder="Write a reply, or click Draft AI replies for options"
            />
            <div class="reply-actions">
              <button class="btn btn-sm btn-secondary" :disabled="draftingThreadId === thread.id" @click="draftReplies(thread)">
                {{ draftingThreadId === thread.id ? 'Drafting…' : '✨ Draft AI replies' }}
              </button>
              <button class="btn btn-sm btn-primary" :disabled="postingThreadId === thread.id || !replyDrafts[thread.id]?.trim()" @click="postReply(thread)">
                {{ postingThreadId === thread.id ? 'Posting…' : 'Post reply' }}
              </button>
            </div>

            <div v-if="draftCandidates[thread.id]?.length" class="draft-candidates">
              <p class="text-muted draft-hint">Click a draft to put it in the reply box:</p>
              <button
                v-for="(draft, i) in draftCandidates[thread.id]"
                :key="i"
                type="button"
                class="draft-pill"
                :title="draft"
                @click="replyDrafts[thread.id] = draft"
              >
                {{ draft }}
              </button>
            </div>
          </div>
          <p v-else class="text-muted">Replies are disabled on this thread.</p>
        </li>
      </ul>

      <p v-if="commentsResult?.has_more" class="text-muted mt-2" style="font-size: var(--font-xs)">
        Showing the first 50 threads. Older comments aren't paginated yet — open the video on YouTube to see the rest.
      </p>
    </div>

    <!-- Placeholder for not-yet-built tabs so the navigation reads honestly -->
    <div v-else class="card workspace-section upload-tab-panel tab-placeholder">
      <h3>{{ tabs.find(t => t.id === activeTab)?.label }}</h3>
      <p class="text-muted" style="font-size: 13px;">
        This tab arrives in Phase {{ tabs.find(t => t.id === activeTab)?.phase }} of the Upload Center rollout.
      </p>
    </div>

    <!-- Per-row schedule editor — opens when the user clicks "📅 Edit"
         on an uploaded queue row. Teleported to body so the modal isn't
         clipped by the table. Three actions:
           - Apply: PATCH the new publishAt to YouTube + sidecar
           - Clear schedule: DELETE schedule, keep the video private
           - Publish now: DELETE schedule with make='public' (only when
             the video isn't already public — checked from sidecar) -->
    <Teleport to="body">
      <div v-if="schedulePopoverItem" class="sched-modal-backdrop" @click="closeSchedulePopover">
        <div class="sched-modal" @click.stop>
          <div class="sched-modal-header">
            <strong>Edit schedule</strong>
            <span class="text-muted" style="font-size: 12px;">— {{ schedulePopoverItem.episode_code }}</span>
          </div>
          <div class="sched-modal-body">
            <p style="font-size: 12px; margin: 0 0 8px; color: var(--text-secondary);">
              Sets the YouTube <code>publishAt</code> for this video. The video stays
              private until then. Times are interpreted in your local timezone
              ({{ Intl.DateTimeFormat().resolvedOptions().timeZone }}).
            </p>
            <p v-if="schedulePopoverItem.privacy_status === 'public'" class="sched-modal-note">
              ℹ This video is already <strong>public</strong> on YouTube. Setting a
              new publish time will revert it to private until that time.
            </p>
            <p v-if="schedulePopoverItem.scheduled_for" class="sched-modal-note">
              Currently scheduled: <strong>{{ new Date(schedulePopoverItem.scheduled_for).toLocaleString() }}</strong>
            </p>
            <label class="sched-modal-label">
              New publish time
              <input
                v-model="scheduleDraft"
                type="datetime-local"
                class="input"
                :min="scheduleMinLocal"
              />
            </label>
            <p v-if="scheduleApplyError" class="sched-modal-error">{{ scheduleApplyError }}</p>
          </div>
          <div class="sched-modal-actions">
            <button
              class="btn btn-primary"
              :disabled="!scheduleDraft || !!schedulePopoverBusy"
              :title="!scheduleDraft ? 'Pick a date and time first' : 'Push this publishAt to YouTube and update the sidecar'"
              @click="doApplySchedule"
            >
              <LoadingSpinner v-if="schedulePopoverBusy === 'apply'" size="sm" />
              {{ schedulePopoverBusy === 'apply' ? 'Applying…' : '✓ Apply' }}
            </button>
            <button
              v-if="schedulePopoverItem.scheduled_for"
              class="btn btn-secondary"
              :disabled="!!schedulePopoverBusy"
              title="Removes the publishAt from YouTube. The video stays private — schedule it again later or hand off to YT Studio."
              @click="doClearScheduleFromPopover"
            >
              <LoadingSpinner v-if="schedulePopoverBusy === 'clear'" size="sm" />
              {{ schedulePopoverBusy === 'clear' ? 'Clearing…' : '✕ Clear schedule' }}
            </button>
            <button
              v-if="schedulePopoverItem.privacy_status !== 'public'"
              class="btn btn-danger"
              :disabled="!!schedulePopoverBusy"
              title="Flips this video to PUBLIC immediately. Skips the schedule and goes live now."
              @click="doPublishNowFromPopover"
            >
              <LoadingSpinner v-if="schedulePopoverBusy === 'publish'" size="sm" />
              {{ schedulePopoverBusy === 'publish' ? 'Publishing…' : '▶ Publish now' }}
            </button>
            <button class="btn btn-ghost" :disabled="!!schedulePopoverBusy" @click="closeSchedulePopover">Cancel</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Sticky bulk-action bar — appears when at least one queue row is
         ticked. Mirrors the Ideas Generator Accept bar (same Transition,
         same fixed positioning) so users build one mental model for
         "selection toolbar in this app". Each bulk button is enabled
         only when EVERY selected row supports that action — see the
         can*Bulk computeds. We deliberately keep the toolbar visible
         even when all bulk actions are disabled (with a hint) so the
         user understands why the click isn't working without having to
         open a tooltip per row. -->
    <!-- Upload Plan modal — opened by the Queue tab's "📅 Upload Plan ▾"
         button. Surfaces the active plan inline so the user doesn't have
         to leave the queue to apply / upload / unapply. The three verb
         buttons reuse the same scope picker the Plans tab uses. -->
    <Teleport to="body">
      <div v-if="uploadPlanModalOpen" class="upload-plan-modal-backdrop" @click="closeUploadPlanModal" />
      <div v-if="uploadPlanModalOpen" class="upload-plan-modal" role="dialog" aria-label="Upload plan" @click.stop>
        <div class="upload-plan-modal-header">
          <strong>📅 Upload Plan</strong>
          <button class="upload-plan-modal-close" type="button" title="Close" @click="closeUploadPlanModal">✕</button>
        </div>
        <div class="upload-plan-modal-body">
          <p v-if="!plans.length" class="text-muted" style="font-size: 13px;">
            No plans yet. Head over to the Plans tab to create one.
          </p>
          <template v-else>
            <label class="upload-plan-modal-label">
              Plan
              <select v-model="uploadPlanModalPlanId" class="select select-sm">
                <option v-for="p in plans" :key="p.id" :value="p.id">
                  {{ p.name }}{{ activePlanIdsSet.has(p.id) ? ' · active' : '' }}
                </option>
              </select>
            </label>
            <p v-if="uploadPlanModalSelected" class="upload-plan-modal-desc text-muted">
              <span v-if="uploadPlanModalSelected._weekdayLabel">
                {{ uploadPlanModalSelected._weekdayLabel }}
                at {{ uploadPlanModalSelected.schedule.time_local }}
                {{ uploadPlanModalSelected.schedule.timezone }}
              </span>
              <span v-if="uploadPlanModalSelected.schedule.interval_weeks && uploadPlanModalSelected.schedule.interval_weeks > 1">
                · every {{ uploadPlanModalSelected.schedule.interval_weeks }} weeks
              </span>
            </p>
            <div class="upload-plan-modal-actions">
              <button
                class="btn btn-primary plan-action-btn"
                :disabled="applying || applyAndUploading || uploadMode === 'private' || !uploadPlanModalSelected"
                title="Pick which episodes this plan should schedule. Writes per-item publishAt + patches any already-uploaded video."
                @click="openPlanScopePicker($event, uploadPlanModalSelected, 'apply')"
              >📅 Apply ▾</button>
              <button
                class="btn btn-primary plan-action-btn"
                :disabled="applying || applyAndUploading || uploadMode === 'private' || !uploadPlanModalSelected"
                title="Fan out uploads only — assumes the schedule has already been applied. Quota-capped. Use the combo button if you also need to apply the schedule first."
                @click="openPlanScopePicker($event, uploadPlanModalSelected, 'upload')"
              >☁️ Upload only ▾</button>
              <button
                class="btn btn-primary plan-action-btn"
                :disabled="applying || applyAndUploading || uploadMode === 'private' || !uploadPlanModalSelected"
                title="Apply this plan AND fan out uploads in one click. Quota-capped — the common case."
                @click="openPlanScopePicker($event, uploadPlanModalSelected, 'apply_upload')"
              >🚀 Apply + Upload ▾</button>
              <button
                class="btn btn-ghost plan-action-btn"
                :disabled="applying || applyAndUploading || !uploadPlanModalSelected"
                title="Remove per-item schedule entries this plan would have produced for the chosen scope."
                @click="openPlanScopePicker($event, uploadPlanModalSelected, 'unapply')"
              >↩ Unapply ▾</button>
            </div>
          </template>
        </div>
        <div class="upload-plan-modal-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeUploadPlanModal">Close</button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            title="Open the Plans tab to create / edit / delete plans"
            @click="goToPlansTab"
          >Manage plans →</button>
        </div>
      </div>
    </Teleport>

    <!-- Link existing YouTube video modal — opened from the Queue row
         menu on a Ready row. Lists orphans on the channel (fetched fresh
         on open) ranked by title similarity against the episode's local
         title. One click adopts: writes the sidecar so Story Studio
         knows the local episode and the live YouTube video are the
         same. Use case: user uploaded the file manually via YouTube
         Studio while traveling and now wants to reconnect. -->
    <Teleport to="body">
      <div v-if="linkVideoModal.open" class="upload-plan-modal-backdrop" @click="closeLinkVideoModal" />
      <div v-if="linkVideoModal.open" class="upload-plan-modal link-video-modal" role="dialog" aria-label="Link existing YouTube video" @click.stop>
        <div class="upload-plan-modal-header">
          <strong>🔗 Link existing YouTube video</strong>
          <button class="upload-plan-modal-close" type="button" title="Close" @click="closeLinkVideoModal">✕</button>
        </div>
        <div class="upload-plan-modal-body">
          <p class="text-muted" style="font-size: 12px; margin: 0;">
            Linking <strong>{{ linkVideoModal.item?.episode_code }}</strong>
            <template v-if="linkVideoModal.item?.title"> · {{ linkVideoModal.item.title.slice(0, 60) }}</template>
          </p>
          <input
            v-model="linkVideoModal.search"
            type="text"
            class="input input-sm"
            placeholder="Search by title or video id…"
            spellcheck="false"
          />
          <div v-if="linkVideoModal.searching" class="text-muted" style="font-size: 12px; padding: 8px 0;">
            <LoadingSpinner size="sm" /> Loading orphan videos…
          </div>
          <div v-else-if="!linkVideoCandidates.length" class="text-muted" style="font-size: 12px; padding: 8px 0;">
            No unlinked videos on the channel match. Try a search term, or check the Unlinked Uploads tab to refresh from YouTube.
          </div>
          <div v-else class="link-video-list">
            <button
              v-for="{ video, score } in linkVideoCandidates"
              :key="video.videoId"
              type="button"
              class="link-video-row"
              :disabled="!!linkVideoModal.busyVideoId"
              :title="`Link this YouTube video to ${linkVideoModal.item?.episode_code}. Writes the sidecar — no re-upload.`"
              @click="doLinkOrphan(video)"
            >
              <div class="link-video-row-main">
                <div class="link-video-row-title">{{ video.title || '(no title)' }}</div>
                <div class="link-video-row-meta">
                  <code style="font-size: var(--font-xs);">{{ video.videoId }}</code>
                  <span v-if="video.publishedAt" class="text-muted">· {{ new Date(video.publishedAt).toLocaleDateString() }}</span>
                  <span v-if="video.privacyStatus" :class="['privacy-chip', `privacy-chip--${video.privacyStatus === 'public' ? 'public' : video.privacyStatus === 'unlisted' ? 'unlisted' : 'private'}`]">{{ video.privacyStatus }}</span>
                </div>
              </div>
              <div class="link-video-row-score" :class="{ 'high-match': score >= 0.5 }">
                <LoadingSpinner v-if="linkVideoModal.busyVideoId === video.videoId" size="sm" />
                <template v-else>{{ Math.round(score * 100) }}% match</template>
              </div>
            </button>
          </div>
        </div>
        <div class="upload-plan-modal-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeLinkVideoModal">Cancel</button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            title="Open the Unlinked Uploads tab for the full orphan flow (bulk adopt, renumber)"
            @click="activeTab = 'orphans'; closeLinkVideoModal()"
          >See all unlinked →</button>
        </div>
      </div>
    </Teleport>

    <!-- v1.0.41 — Pre-upload preview modal. Shown when the user clicks
         the per-row Upload button. Renders the EXACT title / description /
         tags / thumbnail that will be pushed to YouTube, so a wrong
         thumbnail or stale metadata can be caught before the upload
         lands. Bulk-upload paths (Apply + Upload, scope picker actions)
         skip this modal — the user already opted into "trust the plan,
         just go" by using a bulk verb. -->
    <Teleport to="body">
      <div v-if="uploadPreview.open" class="upload-plan-modal-backdrop" @click="closeUploadPreview" />
      <div v-if="uploadPreview.open" class="upload-plan-modal upload-plan-modal--preview" role="dialog" aria-label="Pre-upload preview" @click.stop>
        <div class="upload-plan-modal-header">
          <strong>{{ uploadPreview.data?.already_uploaded ? '↻ Update metadata preview' : '☁️ Upload preview' }}</strong>
          <button class="upload-plan-modal-close" type="button" title="Close" @click="closeUploadPreview">✕</button>
        </div>
        <div v-if="uploadPreview.loading" class="upload-preview-loading">
          <LoadingSpinner size="sm" /> Gathering thumbnails and upload details…
        </div>
        <div class="upload-plan-modal-body" v-if="uploadPreview.data">
          <p class="text-muted" style="font-size: 12px; margin: 0;">
            <template v-if="uploadPreview.data.already_uploaded">
              <strong>{{ uploadPreview.data.episode_code }}</strong> is already uploaded as <code>{{ uploadPreview.data.video_id }}</code>.
              Confirming will <strong>PATCH</strong> the live YouTube video's title / description / tags / thumbnail in place — no re-upload, ~50 quota units.
            </template>
            <template v-else>
              Fresh upload of <strong>{{ uploadPreview.data.episode_code }}</strong> — about <strong>{{ uploadPreview.data.estimated_quota }}</strong> quota units against today's daily cap.
              Privacy starts as <strong>{{ uploadPreview.data.privacy_status }}</strong>.
              <template v-if="uploadPreview.data.scheduled_for">
                publishAt <strong>{{ formatScheduled(uploadPreview.data.scheduled_for) }}</strong>.
              </template>
            </template>
          </p>

          <section class="upload-preview-thumb-block">
            <div class="upload-preview-section-head">
              <div>
                <span class="upload-preview-kicker">Thumbnail</span>
                <h3>Choose what viewers see first</h3>
              </div>
              <span v-if="uploadPreview.data.thumbnail_options.length" class="upload-preview-count">
                {{ uploadPreview.data.thumbnail_options.length }} option{{ uploadPreview.data.thumbnail_options.length === 1 ? '' : 's' }}
              </span>
            </div>
            <template v-if="uploadPreview.data.thumbnail_options.length">
              <button
                type="button"
                class="upload-preview-featured"
                :title="uploadPreview.thumbExpanded ? 'Shrink preview' : 'Enlarge preview'"
                @click="uploadPreview.thumbExpanded = !uploadPreview.thumbExpanded"
              >
                <img
                  :src="uploadPreviewThumbUrl"
                  :alt="uploadPreview.selectedThumbnailFilename"
                  class="upload-preview-thumb-img"
                  :class="{ 'is-expanded': uploadPreview.thumbExpanded }"
                />
                <span class="upload-preview-featured-caption">
                  <strong>{{ uploadPreview.selectedThumbnailFilename }}</strong>
                  <span>Selected for this {{ uploadPreview.data.already_uploaded ? 'update' : 'upload' }} · click to {{ uploadPreview.thumbExpanded ? 'shrink' : 'inspect' }}</span>
                </span>
              </button>
              <div class="upload-preview-thumb-picker" role="radiogroup" aria-label="Choose thumbnail">
                <button
                  v-for="option in uploadPreview.data.thumbnail_options"
                  :key="option.filename"
                  type="button"
                  class="upload-preview-thumb-option"
                  :class="{ 'is-selected': uploadPreview.selectedThumbnailFilename === option.filename }"
                  role="radio"
                  :aria-checked="uploadPreview.selectedThumbnailFilename === option.filename"
                  :title="`Use ${option.filename}`"
                  @click="selectUploadPreviewThumbnail(option.filename)"
                >
                  <img :src="uploadPreviewThumbnailUrl(option.path)" :alt="option.filename" />
                  <span class="upload-preview-option-name">{{ option.filename }}</span>
                  <span v-if="option.is_pinned" class="upload-preview-pin">Pinned default</span>
                  <span v-if="uploadPreview.selectedThumbnailFilename === option.filename" class="upload-preview-check">✓</span>
                </button>
              </div>
              <p class="upload-preview-choice-note">
                This choice applies to this upload only. Your saved default thumbnail is not changed.
              </p>
            </template>
            <p v-else class="text-danger" style="font-size: 12px; margin: 4px 0 0;">
              ⚠ No thumbnail file found in the episode's thumbnails folder. YouTube will use whatever it auto-generates from the video — usually a low-quality middle frame.
            </p>
          </section>

          <!-- Title -->
          <div class="form-group" style="margin-top: 12px;">
            <h4 style="margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">Title</h4>
            <p style="margin: 0; font-weight: 500;">{{ uploadPreview.data.title || '(empty — YouTube will reject)' }}</p>
          </div>

          <!-- Description (collapsible) -->
          <div class="form-group" style="margin-top: 12px;">
            <h4 style="margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
              Description
              <span v-if="uploadPreview.data.description.length > 200" style="font-weight: normal; text-transform: none; letter-spacing: 0; margin-left: 6px;">
                <button class="link-btn" type="button" @click="uploadPreview.descExpanded = !uploadPreview.descExpanded">
                  {{ uploadPreview.descExpanded ? 'show less' : `show all ${uploadPreview.data.description.length} chars` }}
                </button>
              </span>
            </h4>
            <pre class="upload-preview-desc" :class="{ 'is-collapsed': !uploadPreview.descExpanded }">{{ uploadPreview.data.description || '(empty)' }}</pre>
          </div>

          <!-- Tags -->
          <div class="form-group" style="margin-top: 12px;">
            <h4 style="margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
              Tags
              <span v-if="uploadPreview.data.tags.length" style="font-weight: normal; text-transform: none; letter-spacing: 0; margin-left: 6px; color: var(--text-muted);">
                · {{ uploadPreview.data.tags.length }}
              </span>
            </h4>
            <div v-if="uploadPreview.data.tags.length" class="upload-preview-tags">
              <span v-for="t in uploadPreview.data.tags" :key="t" class="idea-tag">{{ t }}</span>
            </div>
            <p v-else class="text-muted" style="font-size: 12px; margin: 0;">(none)</p>
          </div>
        </div>
        <p v-if="uploadPreview.error" class="text-danger" style="font-size: 12px; margin: 0 16px 8px;">⚠ {{ uploadPreview.error }}</p>
        <div class="upload-plan-modal-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeUploadPreview">Cancel</button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="uploadPreview.busy || !uploadPreview.data"
            @click="confirmUploadPreview"
          >
            <LoadingSpinner v-if="uploadPreview.busy" size="sm" />
            {{ uploadPreview.busy
              ? (uploadPreview.data?.already_uploaded ? 'Updating…' : 'Uploading…')
              : (uploadPreview.data?.already_uploaded ? '↻ Confirm metadata update' : '☁️ Confirm upload') }}
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Item L — Renumber revert confirmation modal. Lists exactly which
         folders will be renamed back + which adopted orphans will be
         removed (idea + sidecar + folder), so the user can audit before
         the (destructive-ish) revert runs. The actual revert is done
         server-side via /upload/renumber-undo/revert. -->
    <Teleport to="body">
      <div v-if="revertRenumberModal.open" class="upload-plan-modal-backdrop" @click="closeRevertRenumberModal" />
      <div v-if="revertRenumberModal.open" class="upload-plan-modal" role="dialog" aria-label="Revert renumber" @click.stop style="max-width: 600px;">
        <div class="upload-plan-modal-header">
          <strong>↩ Revert renumber?</strong>
          <button class="upload-plan-modal-close" type="button" title="Close" @click="closeRevertRenumberModal">✕</button>
        </div>
        <div class="upload-plan-modal-body">
          <p class="text-muted" style="font-size: 12px; margin: 0;">
            Performed <strong>{{ formatScheduled(renumberUndoStatus.plan?.performed_at || '') }}</strong>.
            The revert runs three stages — review the lists below, then click confirm.
          </p>

          <div class="form-group" style="margin-top: 12px;">
            <strong style="font-size: 12px;">1. Adopted channel videos to remove
              ({{ renumberUndoStatus.plan?.adopted?.length || 0 }})</strong>
            <p class="text-muted" style="font-size: var(--font-xs); margin: 2px 0 4px;">
              The synthesised ideas + sidecars + folders will be deleted. The remote YouTube videos stay on your channel — Story Studio just unlinks them.
            </p>
            <div class="renumber-undo-list" v-if="renumberUndoStatus.plan?.adopted?.length">
              <div v-for="a in renumberUndoStatus.plan.adopted.slice(0, 8)" :key="a.video_id" class="renumber-undo-row">
                <code>{{ a.code }}</code>
                <span class="text-muted">·</span>
                <code>{{ a.video_id }}</code>
              </div>
              <div v-if="renumberUndoStatus.plan.adopted.length > 8" class="text-muted" style="font-size: var(--font-xs); padding: 4px 0;">
                + {{ renumberUndoStatus.plan.adopted.length - 8 }} more
              </div>
            </div>
          </div>

          <div class="form-group" style="margin-top: 12px;">
            <strong style="font-size: 12px;">2. Episodes to renumber back
              ({{ renumberUndoStatus.plan?.rename_plan?.length || 0 }})</strong>
            <p class="text-muted" style="font-size: var(--font-xs); margin: 2px 0 4px;">
              ideas.json codes will be reverted and disk folders will be renamed in place.
            </p>
            <div class="renumber-undo-list" v-if="renumberUndoStatus.plan?.rename_plan?.length">
              <div v-for="r in renumberUndoStatus.plan.rename_plan.slice(0, 8)" :key="r.old_code" class="renumber-undo-row">
                <code>{{ r.new_code }}</code>
                <span class="text-muted">→</span>
                <code>{{ r.old_code }}</code>
              </div>
              <div v-if="renumberUndoStatus.plan.rename_plan.length > 8" class="text-muted" style="font-size: var(--font-xs); padding: 4px 0;">
                + {{ renumberUndoStatus.plan.rename_plan.length - 8 }} more
              </div>
            </div>
          </div>

          <p v-if="revertRenumberModal.error" class="text-danger" style="font-size: 12px; margin: 8px 0 0;">
            ⚠ {{ revertRenumberModal.error }}
          </p>
        </div>
        <div class="upload-plan-modal-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeRevertRenumberModal">Cancel</button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="revertRenumberModal.busy"
            @click="confirmRevertRenumber"
          >
            <LoadingSpinner v-if="revertRenumberModal.busy" size="sm" />
            {{ revertRenumberModal.busy ? 'Reverting…' : 'Confirm revert' }}
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Item E — "Mark uploaded elsewhere" modal. Captures the optional
         external URL + note alongside the legacy-uploaded flag. Opens
         from the Missing Video tab "Mark as uploaded" button (with a
         pre-filled empty form for new marks) and from clicking the
         🔗 External pill on a no-URL row (with the existing meta
         pre-loaded so the user can edit / unmark from one place). -->
    <Teleport to="body">
      <div v-if="legacyEditModal.open" class="upload-plan-modal-backdrop" @click="closeLegacyEditModal" />
      <div v-if="legacyEditModal.open" class="upload-plan-modal" role="dialog" aria-label="Mark as uploaded elsewhere" @click.stop style="max-width: 520px;">
        <div class="upload-plan-modal-header">
          <strong>🔗 {{ legacyEditModal.mode === 'edit' ? 'Edit external link' : 'Mark as uploaded elsewhere' }}</strong>
          <button class="upload-plan-modal-close" type="button" title="Close" @click="closeLegacyEditModal">✕</button>
        </div>
        <div class="upload-plan-modal-body">
          <p class="text-muted" style="font-size: 12px; margin: 0;">
            <template v-if="legacyEditModal.mode === 'mark'">
              Removes <strong>{{ legacyEditModal.episodeCode }}</strong> from the Missing Video list. Use this for episodes uploaded to a different account / channel / platform — Story Studio leaves them alone but records where they live.
            </template>
            <template v-else>
              <strong>{{ legacyEditModal.episodeCode }}</strong> is marked as uploaded elsewhere. Edit the link / note below, or click "Unmark" to revert (the episode goes back to the Missing Video list).
            </template>
          </p>

          <div class="form-group" style="margin-top: 12px;">
            <label class="form-label" style="display: flex; align-items: center; gap: 6px;">
              External URL
              <span class="text-muted" style="font-weight: normal; font-size: var(--font-xs);">(optional)</span>
            </label>
            <input
              v-model="legacyEditModal.externalUrl"
              type="url"
              class="input input-sm"
              placeholder="https://youtube.com/watch?v=…"
              spellcheck="false"
              @keydown.enter="saveLegacyEdit"
            />
            <p class="text-muted" style="font-size: var(--font-xs); margin: 4px 0 0;">
              Where this video lives. Pasted into a new tab when you click the 🔗 External pill on the row. Must start with <code>http://</code> or <code>https://</code>; otherwise free-text.
            </p>
            <p v-if="legacyEditModal.error" class="text-danger" style="font-size: 12px; margin: 4px 0 0;">
              ⚠ {{ legacyEditModal.error }}
            </p>
          </div>

          <div class="form-group" style="margin-top: 10px;">
            <label class="form-label" style="display: flex; align-items: center; gap: 6px;">
              Note
              <span class="text-muted" style="font-weight: normal; font-size: var(--font-xs);">(optional)</span>
            </label>
            <input
              v-model="legacyEditModal.note"
              type="text"
              class="input input-sm"
              placeholder="e.g. on Bob's channel, Vimeo backup, archived"
              maxlength="200"
              @keydown.enter="saveLegacyEdit"
            />
            <p class="text-muted" style="font-size: var(--font-xs); margin: 4px 0 0;">
              Free-form annotation. Shown as the secondary line in the pill tooltip so you remember why this episode is on a different account next time you see it.
            </p>
          </div>
        </div>
        <div class="upload-plan-modal-footer" style="justify-content: space-between;">
          <button
            v-if="legacyEditModal.mode === 'edit'"
            type="button"
            class="btn btn-ghost btn-sm"
            title="Remove the legacy-uploaded mark — this episode goes back to the Missing Video list and Story Studio resumes managing it normally."
            :disabled="legacyEditModal.busy"
            @click="unmarkFromLegacyEdit"
          >Unmark</button>
          <span v-else />
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-ghost btn-sm" @click="closeLegacyEditModal">Cancel</button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="legacyEditModal.busy"
              @click="saveLegacyEdit"
            >
              <LoadingSpinner v-if="legacyEditModal.busy" size="sm" />
              {{ legacyEditModal.busy
                ? 'Saving…'
                : (legacyEditModal.mode === 'mark' ? 'Mark uploaded' : 'Save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Plan scope picker — opens from the Apply / Upload / Unapply buttons
         on each plan row OR from inside the Upload Plan modal. Anchored to
         the click-target so it floats next to the button, doesn't take a
         column. Same picker for all three verbs; the verb determines the
         scope counts (Upload caps by remaining quota), the action label
         ("Apply", "Upload N (quota-capped)", "Unapply"), and what runs on
         click. -->
    <Teleport to="body">
      <div
        v-if="scopePicker.open"
        class="scope-popover-backdrop"
        @click="closePlanScopePicker"
      />
      <div
        v-if="scopePicker.open"
        class="scope-popover"
        :class="{ 'scope-popover--preview': scopePicker.previewing }"
        :style="scopePopoverStyle"
        role="dialog"
        aria-label="Pick which episodes the action targets"
        @click.stop
      >
        <div class="scope-popover-head">
          <strong>{{
            scopePicker.verb === 'apply' ? '📅 Apply'
              : scopePicker.verb === 'upload' ? '☁️ Upload only'
              : scopePicker.verb === 'apply_upload' ? '🚀 Apply + Upload'
              : '↩ Unapply'
          }}</strong>
          <span class="text-muted" style="font-size: var(--font-xs); margin-left: 4px;">— {{ scopePicker.plan?.name }}</span>
        </div>

        <!-- Step 1: scope-list (default). User picks Selection / All
             unuploaded / Next 5 / This page. Clicking a scope option
             advances to the preview screen for Apply / Upload verbs;
             Unapply skips preview because it has its own confirm dialog
             that already lists episode codes. -->
        <template v-if="!scopePicker.previewing">
          <div v-if="scopePicker.loading" class="scope-popover-loading">
            <LoadingSpinner size="sm" /> Counting episodes…
          </div>
          <div v-else class="scope-popover-list">
            <button
              v-for="opt in scopeOptions"
              :key="opt.id"
              type="button"
              class="scope-option"
              :disabled="opt.count === 0"
              :title="opt.tooltip"
              @click="pickScope(opt)"
            >
              <span class="scope-option-label">{{ opt.label }}</span>
              <span class="scope-option-count" :class="{ zero: opt.count === 0 }">{{ opt.count }}</span>
            </button>
          </div>
          <div v-if="(scopePicker.verb === 'upload' || scopePicker.verb === 'apply_upload') && quota" class="scope-popover-foot text-muted" style="font-size: var(--font-xs);">
            Today’s YouTube quota: {{ quota.used }} / {{ quota.block_at }} units
            (~{{ Math.max(0, Math.floor((quota.block_at - quota.used) / 1600)) }} uploads left).
          </div>
        </template>

        <!-- Step 2: preview (Item D). Shows the episode → slot mapping the
             plan would produce against the chosen scope, so the user can
             confirm it's the schedule they meant before any state writes
             or YouTube PATCHes happen. computeSlots is the same pure
             function the backend uses, so the preview is exact, not an
             approximation. -->
        <template v-else>
          <div v-if="scopePicker.previewLoading" class="scope-popover-loading">
            <LoadingSpinner size="sm" /> Computing slot mapping…
          </div>
          <template v-else>
            <div class="scope-preview-summary">
              <strong>{{ scopePicker.previewing.count }}</strong> episode{{ scopePicker.previewing.count === 1 ? '' : 's' }}
              <span class="text-muted">· scope: {{ scopePicker.previewing.label }}</span>
            </div>
            <div v-if="scopePicker.previewLatestClaim" class="scope-preview-anchor">
              <span aria-hidden="true">↳</span>
              Continuing after the latest scheduled upload:
              <strong>{{ formatScheduled(scopePicker.previewLatestClaim) }}</strong>
            </div>
            <div v-if="scopePicker.previewError" class="scope-preview-error">
              ⚠ {{ scopePicker.previewError }}
            </div>
            <div v-if="scopePicker.previewPastSlots > 0" class="scope-preview-warn">
              ⚠ {{ scopePicker.previewPastSlots }} slot(s) land in the past — Apply will reject these. Edit the plan’s start_date or skip those episodes.
            </div>
            <!-- v1.0.46 — public-skip transparency. Apply-plan refuses
                 to PATCH already-public videos because that would
                 silently unpublish them (privacyStatus reverts to
                 'private' alongside publishAt). Surface the count
                 here so the user knows N rows in their selection
                 won't actually be touched. -->
            <div v-if="scopePicker.previewPublicSkipCount > 0" class="scope-preview-warn">
              👁 {{ scopePicker.previewPublicSkipCount }} public episode{{ scopePicker.previewPublicSkipCount === 1 ? '' : 's' }} will be skipped by Apply (touching them would unpublish the live videos). Use the
              <strong>🔒 Not yet public</strong> filter chip to scope this to non-public rows only.
            </div>
            <div class="scope-preview-list">
              <div
                v-for="(row, idx) in scopePicker.previewRows"
                :key="row.episode_code + idx"
                class="scope-preview-row"
                :class="{ 'is-past': row.is_past }"
              >
                <span class="scope-preview-code">{{ row.episode_code }}</span>
                <span class="scope-preview-arrow text-muted">→</span>
                <span class="scope-preview-slot">{{ row.slot_label }}</span>
              </div>
            </div>
            <div class="scope-preview-actions">
              <button type="button" class="btn btn-ghost btn-sm" @click="cancelScopePreview">← Back</button>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="!!scopePicker.previewError"
                @click="confirmScopePreview"
              >
                {{
                  scopePicker.verb === 'upload' ? `☁️ Upload ${scopePicker.previewing.count}`
                    : scopePicker.verb === 'apply_upload' ? `🚀 Apply + Upload ${scopePicker.previewing.count}`
                    : `📅 Apply to ${scopePicker.previewing.count}`
                }}
              </button>
            </div>
          </template>
        </template>
      </div>
    </Teleport>

    <Transition name="bulk-bar">
      <div v-if="activeTab === 'queue' && selectedQueueIds.size > 0" class="queue-bulk-bar" role="region" aria-label="Bulk upload actions">
        <span class="queue-bulk-bar-count">{{ selectedQueueIds.size }} selected</span>
        <!-- Item 10 — "View selected" pulls the user's selection (which
             may be spread across pages) into a single enriched page so
             metadata/thumbnail badges are visible for every selected
             row. Toggles back to the normal paginated view via the
             "↺ Show all" button when the view is active. -->
        <button
          v-if="!viewingSelectedOnly"
          class="btn btn-secondary btn-sm"
          title="Pull every selected row into a single page so you can see metadata + thumbnail badges for off-page selections."
          @click="enterViewSelected"
        >👁 View selected</button>
        <button
          v-else
          class="btn btn-secondary btn-sm"
          title="Return to the normal paginated queue view."
          @click="exitViewSelected"
        >↺ Show all</button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="!canBulkUpload"
          :title="bulkUploadTitle"
          @click="doBulkUpload"
        >📤 Upload</button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="!canBulkMetadata"
          :title="bulkMetadataTitle"
          @click="doBulkMetadata"
        >↻ Update YouTube</button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="!canBulkPlaylist"
          :title="bulkPlaylistTitle"
          @click="doBulkPlaylist"
        >♫ Playlist</button>
        <button class="btn btn-ghost btn-sm" @click="selectedQueueIds.clear(); exitViewSelected()">Clear</button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import AnalyticsTab from '~/components/upload/AnalyticsTab.vue'
import { formatNumber, formatMinutes, formatTimecode, formatRelativeTime } from '~/utils/upload-format'
import { selectLiveGenStudioModel, type LiveGenStudioModel } from '~/utils/live-genstudio-model-selection'
import tzData from '~/data/timezones.json'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)

const uploadApi = useUploadAccounts(slug.value)
// useJobs polls / SSE-streams the queue globally; the dashboard layout
// already called startPolling, so reading `jobs` here gives us live state.
const { jobs: allJobs } = useJobs()
const {
  platforms,
  accounts,
  defaults,
  loading,
  youtubeAccounts,
  queueItems,
  queueLoading,
  queueTotal,
  queueTotalUnfiltered,
  queueTotalPages,
  queueCounts,
  queueLastParams,
  markLegacyUploaded,
  markLegacyUploadedBulk,
  loadQueue,
  fetchQueueEpisodeCodes,
  plans,
  activePlanMap,
  plansLoading,
  loadPlans,
  savePlan,
  deletePlan,
  activatePlan,
  previewPlan,
  applyPlan,
  importsFolder,
  loadImportsFolder,
  scanImports,
  saveImportMeta,
  removeImport,
  missingVideoEpisodes,
  loadMissingVideoEpisodes,
  scanEpisodeImports,
  getEpisodeImportFolder,
  revealFolder,
  reconcilePreview,
  reconcileConfirm,
  reconcilePreviewState,
  getCachedReconcilePreview,
  invalidateReconcilePreview,
  quota,
  loadQuota,
  startQuotaPolling,
  stopQuotaPolling,
  uploadMode,
  loadUploadMode,
  setUploadModeFor,
  editSchedule,
  unschedule,
  clearItemSchedule,
  syncQueueFromYoutube,
  resetUploadState,
  markDeletedUpstream,
  unmarkDeletedUpstream,
  orphans,
  orphansNextNumber,
  orphansAlreadyLinked,
  orphansError,
  orphansLoading,
  loadOrphans,
  adoptSingleOrphan,
  linkExistingVideo,
  adoptBulkOrphans,
  getRenumberUndoStatus,
  revertRenumber,
  dismissRenumberUndoSidecar,
  playlists,
  defaultPlaylistId,
  playlistsLoading,
  playlistsError,
  loadPlaylists,
  createPlaylistFor,
  setDefaultPlaylist,
  refreshAll,
  triggerUpload,
  triggerMetadataUpdate,
  triggerPlaylistUpdate,
} = uploadApi

const channelAvatarFailed = ref(false)
const channelAvatarUrl = computed(() => {
  const account = youtubeAccounts.value[0]
  return account?.id
    ? `/api/projects/${encodeURIComponent(slug.value)}/upload/accounts/${encodeURIComponent(account.id)}/avatar`
    : ''
})
const channelInitials = computed(() => {
  const title = youtubeAccounts.value[0]?.remote_title?.trim() || 'YouTube'
  const words = title.split(/\s+/).filter(Boolean)
  return (words.length > 1
    ? `${words[0][0]}${words[words.length - 1][0]}`
    : title.slice(0, 2)).toUpperCase()
})
watch(
  () => [youtubeAccounts.value[0]?.id, youtubeAccounts.value[0]?.thumbnail_url],
  () => { channelAvatarFailed.value = false },
)

const { success, error: showError, show: showToast } = useToast()
const { ask } = useConfirm()

type TabId = 'accounts' | 'queue' | 'missing' | 'plans' | 'playlists' | 'reconcile' | 'orphans' | 'analytics' | 'comments'
const tabs: Array<{ id: TabId; label: string; short: string; icon: string; phase: number; disabled: boolean; hint?: string }> = [
  { id: 'accounts', label: 'Accounts', short: 'Channel access', icon: '◎', phase: 1, disabled: false, hint: 'Connect the YouTube channel for this project (single account).' },
  { id: 'queue', label: 'Upload Queue', short: 'Review and publish', icon: '↑', phase: 2, disabled: false, hint: 'Per-episode queue with per-row upload. Re-running on an uploaded item updates metadata only.' },
  { id: 'missing', label: 'Missing Video', short: 'Needs a final render', icon: '!', phase: 2, disabled: false, hint: 'Episodes whose final video isn’t on disk yet. Render via Video Assembly or import a finished file.' },
  { id: 'plans', label: 'Plans', short: 'Publishing cadence', icon: '▦', phase: 3, disabled: false, hint: 'Saved schedule plans — pick weekdays + time, preview slots, apply to the queue.' },
  { id: 'playlists', label: 'Playlists', short: 'Channel collections', icon: '≡', phase: 3, disabled: false, hint: 'Manage the YouTube playlists on your channel and choose a default.' },
  { id: 'reconcile', label: 'Match unlinked', short: 'Prevent duplicates', icon: '↔', phase: 6, disabled: false, hint: 'Match existing channel videos to local episodes before uploading duplicates.' },
  { id: 'orphans', label: 'Unlinked Uploads', short: 'Adopt channel videos', icon: '◇', phase: 7, disabled: false, hint: 'Channel videos that don’t match any local episode.' },
  { id: 'analytics', label: 'Analytics', short: 'Performance signals', icon: '↗', phase: 7, disabled: false, hint: 'Per-episode views, watch time, retention, and CTR.' },
  { id: 'comments', label: 'Comments', short: 'Audience replies', icon: '◌', phase: 7, disabled: false, hint: 'Read viewer comments and post replies.' },
]
const activeTab = ref<TabId>('accounts')

// ── Queue state (Phase 2) ─────────────────────────────────────────────
const uploadingRow = ref<string | null>(null)
const scanning = ref(false)

// Server-side pagination + filter + sort. The endpoint scans every
// accepted idea for a final video which is the slow part — caching
// the enriched list backend-side for 30s makes pagination/filter/sort
// changes feel instant after the first hit. The Refresh button bypasses
// the cache via `nocache: true`.
//
// Defaults (all configurable via the toolbar):
//   filter = 'ready,uploaded_local' — show what's left to upload + recently
//                                     uploaded items still on disk; hide the
//                                     older private videos whose local copy
//                                     was cleaned up.
//   sort   = 'code_asc'     — natural episode order
//   page   = 1, pageSize = 10
//
// Filter is now multi-select: four mutually-exclusive state chips
// (Ready / Uploaded·local kept / Uploaded·local freed / Imports) plus a
// Scheduled overlay that AND-filters on top. Stored as a Set so toggling
// a chip is O(1) and we can derive the canonical comma-string for the API
// at request time. Default state matches `queueLastParams.filter` in
// useUploadAccounts so a cold reload starts with the same view.
// v1.0.390 — cold-start default is now "Ready to upload" ONLY (was
// Ready + Uploaded·local kept). The dominant intent is "what's left to
// publish?", and including the uploaded back-catalogue surfaced years-old
// TN0001/TN0002 rows on top every time. "Already uploaded" / "Everything"
// are one click away via the Quick Views row.
const FILTER_DEFAULT: Array<'ready' | 'uploaded_local'> = ['ready']
const queueStateFilters = reactive(new Set<string>(FILTER_DEFAULT))
const queueOverlayFilters = reactive(new Set<string>())
const queueSort   = ref<import('~/composables/useUploadAccounts').QueueSort>('code_asc')
const queuePage = ref(1)
const queuePageSize = ref<10 | 20 | 50 | 100>(10)
// Free-text search across episode_code / title / filename. Server-side
// (the queue is server-paginated), debounced 200 ms so each keystroke
// doesn't fire its own backend round-trip.
const queueSearch = ref('')

/** Canonical filter string sent to the backend (`ready,uploaded_local,scheduled`). */
const queueFilterString = computed(() => {
  const parts = [...queueStateFilters, ...queueOverlayFilters]
  return parts.length ? parts.join(',') : 'all'
})

/**
 * Tracks whether the user has explicitly dismissed the 🪦 chip this
 * session. The auto-activate logic (G) won't re-enable the chip while
 * this is true — toggling it back on resets the flag. Avoids the chip
 * fighting the user when they say "yes I see the tombstones, hide them".
 *
 * v1.0.500 — the dismissal now ALSO persists per project in localStorage,
 * keyed by a hash of the current tombstone set. Previously this was a
 * plain session ref that reset on every page mount, so each visit
 * re-activated the chip and merged old uploaded-then-deleted rows into
 * the default "Ready" view (sorted code_asc → ancient codes on top) —
 * the "why does it default to already-uploaded oldest stuff" complaint.
 * Hashing the SET (not a boolean) keeps the safety property: when a NEW
 * takedown appears the hash changes and the chip auto-activates again.
 */
const tombstoneChipManuallyDismissed = ref(false)
const lastTombstoneHash = ref('')
function tombstoneDismissKey(): string { return `uploadTombstoneDismissed:${slug.value}` }
function readDismissedTombstoneHash(): string {
  try { return localStorage.getItem(tombstoneDismissKey()) || '' } catch { return '' }
}
function persistDismissedTombstoneHash(h: string): void {
  try { localStorage.setItem(tombstoneDismissKey(), h) } catch { /* private mode etc. */ }
}
function clearDismissedTombstoneHash(): void {
  try { localStorage.removeItem(tombstoneDismissKey()) } catch { /* ignore */ }
}

/**
 * Auto-activate the 🪦 "Deleted upstream" chip when the project has at
 * least one tombstoned row, UNLESS the user has manually dismissed it
 * this session. This makes takedowns surface immediately after
 * sync-from-youtube auto-tombstones them, instead of hiding behind a
 * default-off filter.
 *
 * We can't just watch queueItems for `.deleted_at` — the default filter
 * (Ready + Uploaded·local kept) excludes tombstoned rows, so they never
 * appear in queueItems to be detected. Instead, do a lightweight
 * `ids_only` fetch with the deleted_upstream filter whenever the queue
 * reloads. Single round-trip, no enrichment cost.
 */
async function detectTombstonedAndAutoActivateChip() {
  if (tombstoneChipManuallyDismissed.value) return
  if (queueStateFilters.has('deleted_upstream')) return
  try {
    const r = await fetchQueueEpisodeCodes({ filter: 'deleted_upstream' })
    const codes = r.episode_codes || []
    if (codes.length > 0) {
      // v1.0.500 — respect a persisted dismissal for this exact tombstone
      // set. A previously-dismissed set stays hidden across visits; any NEW
      // tombstone changes the hash and re-activates the chip.
      const hash = [...codes].sort().join('|')
      lastTombstoneHash.value = hash
      if (readDismissedTombstoneHash() === hash) return
      queueStateFilters.add('deleted_upstream')
    }
  } catch { /* tolerate — chip stays off, user can toggle manually */ }
}
watch(queueItems, () => {
  // Fire-and-forget; the await would loop the watcher.
  void detectTombstonedAndAutoActivateChip()
})

interface FilterChip {
  id: 'ready' | 'uploaded_local' | 'uploaded_freed' | 'deleted_upstream' | 'imports' | 'scheduled' | 'public' | 'not_public'
  kind: 'state' | 'overlay'
  icon: string
  label: string
  tooltip: string
}
const QUEUE_FILTER_CHIPS: FilterChip[] = [
  { id: 'ready',            kind: 'state',   icon: '🟢', label: 'Ready',                  tooltip: 'Has a final video on disk and is not yet uploaded.' },
  { id: 'uploaded_local',   kind: 'state',   icon: '✅', label: 'Uploaded · local kept',  tooltip: 'Already on YouTube AND the local final-video file is still on disk.' },
  { id: 'uploaded_freed',   kind: 'state',   icon: '☁️', label: 'Uploaded · local freed', tooltip: 'On YouTube; the local final has been cleaned up. Older private videos typically live here. Excluded by default so bulk actions don’t target them.' },
  { id: 'deleted_upstream', kind: 'state',   icon: '🪦', label: 'Deleted upstream',       tooltip: 'Was uploaded, then removed from YouTube (takedown, manual delete, or you marked it). Excluded from bulk-upload defaults so it doesn’t come back. Sync from YouTube auto-stamps these when it sees the video is gone.' },
  { id: 'imports',          kind: 'state',   icon: '📦', label: 'Imports',                tooltip: 'Files dropped into the project-level imports folder.' },
  { id: 'scheduled',        kind: 'overlay', icon: '📅', label: 'Scheduled',              tooltip: 'Overlay filter — combine with any state chips above to narrow to scheduled rows only.' },
  { id: 'public',           kind: 'overlay', icon: '👁',  label: 'Public',                 tooltip: 'Overlay filter — only rows whose YouTube video is currently public. Apply-plan REFUSES to touch these (it would silently unpublish them by setting privacyStatus=private + a new publishAt).' },
  { id: 'not_public',       kind: 'overlay', icon: '🔒', label: 'Not yet public',         tooltip: 'Overlay filter — only rows that aren’t public yet (private, unlisted, or not uploaded). The targets you actually want when re-applying a plan.' },
]

function toggleQueueFilter(chip: FilterChip) {
  const set = chip.kind === 'state' ? queueStateFilters : queueOverlayFilters
  if (set.has(chip.id)) {
    set.delete(chip.id)
    // Track manual-off for the tombstone chip so the auto-activate logic
    // (G) doesn't immediately re-enable it after the user explicitly
    // dismissed it. Re-arms when the user manually turns it back on.
    // v1.0.500 — also persist the dismissal (keyed by the tombstone-set
    // hash) so the chip doesn't come back on every page visit.
    if (chip.id === 'deleted_upstream') {
      tombstoneChipManuallyDismissed.value = true
      if (lastTombstoneHash.value) persistDismissedTombstoneHash(lastTombstoneHash.value)
    }
  } else {
    set.add(chip.id)
    if (chip.id === 'deleted_upstream') {
      tombstoneChipManuallyDismissed.value = false
      clearDismissedTombstoneHash()
    }
    // v1.0.46 — `public` and `not_public` are mutually exclusive (a row
    // can't be both at once). Turning one on auto-untoggles the other
    // so the user doesn't accidentally AND them into an empty list.
    if (chip.id === 'public' && queueOverlayFilters.has('not_public')) queueOverlayFilters.delete('not_public')
    if (chip.id === 'not_public' && queueOverlayFilters.has('public')) queueOverlayFilters.delete('public')
  }
}
function isQueueFilterActive(chip: FilterChip): boolean {
  const set = chip.kind === 'state' ? queueStateFilters : queueOverlayFilters
  return set.has(chip.id)
}
function clearQueueFilters() {
  queueStateFilters.clear()
  queueOverlayFilters.clear()
  for (const t of FILTER_DEFAULT) queueStateFilters.add(t)
  queueSearch.value = ''
}

// ── Quick views (v1.0.390) ──────────────────────────────────────────────
// Plain-English intents that one-click set the right chip combination, so the
// user doesn't have to reason about 8 individual state/overlay chips to express
// "what's ready to publish?" vs "what still needs a video?". The granular SHOW
// chips stay below as the fine-tune layer; the active quick view is DERIVED
// from the current chip Set so the two never drift out of sync.
type QuickViewId = 'ready' | 'uploaded' | 'all' | 'missing'
interface QuickView {
  id: QuickViewId
  icon: string
  label: string
  tooltip: string
  /** null = count not known yet (e.g. Missing-Video list not loaded). */
  count: () => number | null
}
const QUICK_VIEWS: QuickView[] = [
  { id: 'ready', icon: '🟢', label: 'Ready to upload',
    tooltip: 'Final video is on disk and it is NOT yet uploaded — your publish list. Hides the already-uploaded back catalogue.',
    count: () => queueCounts.value.ready },
  { id: 'uploaded', icon: '✅', label: 'Already uploaded',
    tooltip: 'Already on YouTube (local copy kept or freed). Your back catalogue.',
    count: () => queueCounts.value.uploaded_local + queueCounts.value.uploaded_freed },
  { id: 'all', icon: '📋', label: 'Everything',
    tooltip: 'Every row in the queue, all states.',
    count: () => queueCounts.value.all },
  { id: 'missing', icon: '🎬', label: 'Needs a video',
    tooltip: 'Episodes with no final video yet — you have to make it. Opens the Missing Video tab.',
    count: () => (missingVideoEpisodes.value.length || null) },
]

/** Which quick view the current chip set corresponds to ('' = a custom mix). */
const activeQuickView = computed<QuickViewId | ''>(() => {
  if (queueOverlayFilters.size > 0) return ''
  const s = queueStateFilters
  if (s.size === 0) return 'all'   // empty state set == "all"
  if (s.size === 1 && s.has('ready')) return 'ready'
  if (s.size === 2 && s.has('uploaded_local') && s.has('uploaded_freed')) return 'uploaded'
  return ''
})

function applyQuickView(id: QuickViewId) {
  // "Needs a video" lives in its own tab (those episodes have no final video,
  // so they're never in the upload queue index). Route there instead of
  // filtering.
  if (id === 'missing') { activeTab.value = 'missing'; return }
  queueOverlayFilters.clear()
  queueStateFilters.clear()
  if (id === 'ready') {
    queueStateFilters.add('ready')
  } else if (id === 'uploaded') {
    queueStateFilters.add('uploaded_local')
    queueStateFilters.add('uploaded_freed')
  }
  // 'all' leaves both sets empty → queueFilterString computes 'all'.
}

function goToQueuePage(n: number) {
  const clamped = Math.max(1, Math.min(queueTotalPages.value, Math.floor(n)))
  queuePage.value = clamped
  loadQueue({ page: clamped })
}

// When filter or sort changes, jump back to page 1 — the prior page
// number probably doesn't make sense in the new filtered list.
watch([queueFilterString, queueSort], () => {
  queuePage.value = 1
  loadQueue({ filter: queueFilterString.value, sort: queueSort.value, page: 1, pageSize: queuePageSize.value, q: queueSearch.value })
})
watch(queuePageSize, (s) => {
  queuePage.value = 1
  loadQueue({ pageSize: s, page: 1 })
})

// Debounced server-side search. 200 ms is below the perceived-lag
// threshold but high enough that mid-word typing doesn't fire a
// roundtrip per keystroke. Reuses the same loadQueue / cache the
// other watchers do.
let queueSearchTimer: ReturnType<typeof setTimeout> | null = null
watch(queueSearch, (next) => {
  if (queueSearchTimer) clearTimeout(queueSearchTimer)
  queueSearchTimer = setTimeout(() => {
    queuePage.value = 1
    loadQueue({ q: next, page: 1 })
  }, 200)
})

// ── Missing Video tab state ──────────────────────────────────────────
// Search + client-side pagination (the missing-video endpoint returns
// the full list — much smaller than the queue's enriched payload, so a
// server-side page split here isn't worth the round-trip cost).
const missingLoading = ref(false)
const missingSearch = ref('')
const missingPage = ref(1)
const missingPageSize = ref<10 | 20 | 50 | 100>(20)

const missingFilteredEpisodes = computed(() => {
  const q = missingSearch.value.trim().toLowerCase()
  if (!q) return missingVideoEpisodes.value
  return missingVideoEpisodes.value.filter(ep =>
    (ep.episode_code || '').toLowerCase().includes(q)
    || (ep.title || '').toLowerCase().includes(q),
  )
})
const missingTotalPages = computed(() => Math.max(1, Math.ceil(missingFilteredEpisodes.value.length / missingPageSize.value)))
const missingPaginatedEpisodes = computed(() => {
  const start = (missingPage.value - 1) * missingPageSize.value
  return missingFilteredEpisodes.value.slice(start, start + missingPageSize.value)
})
watch([missingSearch, missingPageSize], () => { missingPage.value = 1 })
watch(missingTotalPages, (tp) => { if (missingPage.value > tp) missingPage.value = Math.max(1, tp) })

function doMarkLegacyUploaded(ep: { episode_code: string; title: string }) {
  // Item E — open the dedicated modal instead of a plain confirm so the
  // user can capture an external URL + note in the same step. The
  // modal's Save handler runs the API call + refreshes both the
  // missing-video and queue lists (the row may now appear in the queue
  // with a 🔗 External pill).
  openLegacyMarkModal(ep)
}

// Refresh missing-video data when entering the tab so it's never stale
// (the user may have just rendered videos in another window).
watch(activeTab, (t) => {
  if (t === 'missing') {
    missingLoading.value = true
    loadMissingVideoEpisodes().finally(() => { missingLoading.value = false })
  }
})


// ── Comments tab state ────────────────────────────────────────────────
// Free-form video input for v1 — paste a URL or bare video id. Deeper
// integration (dropdown sourced from sidecars) lands in a later pass.

interface CommentReplyShape {
  id: string
  author: string
  author_avatar?: string
  text: string
  like_count: number
  published_at: string
  updated_at: string
}
interface CommentThreadShape {
  id: string
  video_id: string
  top_comment: CommentReplyShape
  reply_count: number
  replies: CommentReplyShape[]
  can_reply: boolean
  is_public: boolean
}
interface CommentsResultShape {
  fetched_at: string
  video_id: string
  threads: CommentThreadShape[]
  has_more: boolean
}

const commentsVideoInput = ref<string>('')
const commentsVideoSelection = ref<string>('')
const commentsLoading = ref(false)

/** Episodes with a sidecar.video_id, eligible for the picker. Source
 *  comes from queueItems which the Queue tab already loads — clicking
 *  Comments without ever touching Queue triggers a one-shot loadQueue. */
const commentsVideoOptions = computed<Array<{ video_id: string; label: string }>>(() => {
  return (queueItems.value || [])
    .filter((i: any) => i?.uploaded && typeof i.video_id === 'string' && i.video_id.length === 11)
    .map((i: any) => {
      const code = i.episode_code || ''
      const title = (i.title || '').trim()
      const display = title.length > 60 ? title.slice(0, 57) + '…' : title
      return {
        video_id: i.video_id,
        label: `${code}${code && display ? ' — ' : ''}${display || `(video ${i.video_id})`}`,
      }
    })
    // Most-recent uploads first — queueItems is sorted by code, but
    // newest episodes typically have the highest codes, so reverse.
    .reverse()
})

/** The video id we'll actually query, factoring the selector + the
 *  free-form override input. */
const commentsResolvedVideoId = computed<string>(() => {
  if (commentsVideoSelection.value === '__other__') {
    return parseVideoIdInput(commentsVideoInput.value)
  }
  return commentsVideoSelection.value
})

function onCommentsVideoChange() {
  // Auto-load when a real episode is picked (skip auto-load for "other"
  // — user still needs to paste).
  if (commentsVideoSelection.value && commentsVideoSelection.value !== '__other__') {
    loadComments(true)
  }
}

// Lazy-load the queue the first time the user opens the Comments tab so
// the dropdown isn't empty if they haven't visited the Queue tab yet.
watch(activeTab, async (t) => {
  if (t === 'comments' && !queueItems.value.length) {
    try { await loadQueue('youtube') } catch { /* non-fatal */ }
  }
})
const commentsError = ref<string | null>(null)
const commentsResult = ref<CommentsResultShape | null>(null)
/** Map of threadId → in-progress reply text. */
const replyDrafts = reactive<Record<string, string>>({})
/** Map of threadId → AI draft candidates (1-3 strings). */
const draftCandidates = reactive<Record<string, string[]>>({})
const draftingThreadId = ref<string | null>(null)
const postingThreadId = ref<string | null>(null)

/** Extract a YouTube video id from a pasted URL or bare id. Returns
 *  the input unchanged when no recognizable URL — let the API surface
 *  "video not found" for bad ids rather than reject up front. */
function parseVideoIdInput(s: string): string {
  const trimmed = s.trim()
  if (!trimmed) return ''
  // youtu.be/<id>
  let m = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{11})/)
  if (m) return m[1]!
  // youtube.com/watch?v=<id>
  m = trimmed.match(/[?&]v=([A-Za-z0-9_-]{11})/)
  if (m) return m[1]!
  // youtube.com/shorts/<id>
  m = trimmed.match(/\/shorts\/([A-Za-z0-9_-]{11})/)
  if (m) return m[1]!
  return trimmed
}

async function loadComments(reset: boolean) {
  const videoId = commentsResolvedVideoId.value
  if (!videoId) return
  commentsLoading.value = true
  commentsError.value = null
  if (reset) commentsResult.value = null
  try {
    const { get: apiGet } = useApi()
    const r = await apiGet<CommentsResultShape>(`/projects/${slug.value}/upload/comments?video_id=${encodeURIComponent(videoId)}&max_results=50`)
    commentsResult.value = r
    // Reset per-thread drafts on a fresh load so old text doesn't linger.
    Object.keys(replyDrafts).forEach(k => delete replyDrafts[k])
    Object.keys(draftCandidates).forEach(k => delete draftCandidates[k])
  } catch (e: any) {
    const data = e?.data || e?.response?._data
    commentsError.value = data?.detail || e?.message || 'Failed to load comments'
  } finally {
    commentsLoading.value = false
  }
}

async function draftReplies(thread: CommentThreadShape) {
  draftingThreadId.value = thread.id
  draftCandidates[thread.id] = []
  try {
    const { post: apiPost } = useApi()
    // Preserve an explicit usable choice or owner-published alias. With no
    // saved choice, auto-select Economy only when the live tier catalog is
    // complete; never silently cross a product or price boundary.
    const cfg = await useApi().get<any>(`/projects/${slug.value}/settings/config`).catch(() => null)
    const savedModel = cfg?.metadata_last_model || cfg?.last_text_model || ''
    const liveModels = await useApi().get<LiveGenStudioModel[]>(`/models?project=${slug.value}`).catch(() => [])
    const model = selectLiveGenStudioModel(savedModel, liveModels)?.id || ''
    if (!model) throw new Error('Choose an available GenStudio text model. Story Studio did not substitute a locked or higher-cost product.')
    // Best-effort: lookup the queue item by video_id to feed the LLM
    // a real video title for context. Falls back to undefined if the
    // user is querying a video outside their queue.
    const queueItem = (queueItems.value || []).find((i: any) => i.video_id === commentsResolvedVideoId.value)
    const r = await apiPost<{ drafts: string[] }>(`/projects/${slug.value}/upload/comments/draft`, {
      comment_id: thread.top_comment.id,
      comment_text: thread.top_comment.text,
      comment_author: thread.top_comment.author,
      video_title: queueItem?.title,
      count: 3,
      model,
    })
    draftCandidates[thread.id] = r.drafts || []
    if (!replyDrafts[thread.id] && draftCandidates[thread.id]!.length) {
      replyDrafts[thread.id] = draftCandidates[thread.id]![0]!
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to draft replies')
  } finally {
    draftingThreadId.value = null
  }
}

async function postReply(thread: CommentThreadShape) {
  const text = (replyDrafts[thread.id] || '').trim()
  if (!text) return
  postingThreadId.value = thread.id
  try {
    const { post: apiPost } = useApi()
    const r = await apiPost<{ ok: boolean; reply: CommentReplyShape }>(`/projects/${slug.value}/upload/comments/reply`, {
      parent_comment_id: thread.top_comment.id,
      text,
    })
    // Optimistic insert into the local thread so the user sees their
    // reply without a refetch.
    if (r?.reply) thread.replies.push(r.reply)
    thread.reply_count += 1
    delete replyDrafts[thread.id]
    delete draftCandidates[thread.id]
    success('Reply posted')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to post reply')
  } finally {
    postingThreadId.value = null
  }
}

// ── Per-row kebab menu ───────────────────────────────────────────────
// Same Teleport-to-body + fixed-positioning pattern as the pipeline page,
// so the menu can never be clipped by the queue table or page-content
// scroll. Auto-flips upward when there isn't space below the trigger.
const rowMenuOpenFor = ref<string | null>(null)
const rowMenuPos = ref<{ top: number; left: number; width: number } | null>(null)
const ROW_MENU_WIDTH = 320
const ROW_MENU_MAX_HEIGHT = 220
const ROW_MENU_GAP = 4

function positionRowMenu(triggerEl: HTMLElement) {
  const r = triggerEl.getBoundingClientRect()
  let left = r.right - ROW_MENU_WIDTH
  left = Math.max(8, Math.min(left, window.innerWidth - ROW_MENU_WIDTH - 8))
  const spaceBelow = window.innerHeight - r.bottom
  let top: number
  if (spaceBelow < ROW_MENU_MAX_HEIGHT + ROW_MENU_GAP) {
    top = r.top - ROW_MENU_GAP - ROW_MENU_MAX_HEIGHT
    if (top < 8) top = 8
  } else {
    top = r.bottom + ROW_MENU_GAP
  }
  rowMenuPos.value = { top, left, width: ROW_MENU_WIDTH }
}
function toggleRowMenu(itemId: string, ev?: MouseEvent) {
  if (rowMenuOpenFor.value === itemId) {
    rowMenuOpenFor.value = null
    rowMenuPos.value = null
    return
  }
  rowMenuOpenFor.value = itemId
  const trigger = ev?.currentTarget as HTMLElement | undefined
  if (trigger) positionRowMenu(trigger)
}
function closeRowMenu() {
  rowMenuOpenFor.value = null
  rowMenuPos.value = null
}

// Outside-click + scroll + Escape handlers for the kebab menu.
if (typeof window !== 'undefined') {
  const onDocClick = (e: MouseEvent) => {
    if (!rowMenuOpenFor.value) return
    const t = e.target as HTMLElement | null
    if (t && (t.closest('.row-kebab') || t.closest('.row-kebab-menu'))) return
    closeRowMenu()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRowMenu() }
  const onScroll = () => { if (rowMenuOpenFor.value) closeRowMenu() }
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

// Build a per-episode snapshot of the most-recent youtube_upload job, so
// the queue table can render live progress without each row making its
// own API call. Keyed by episode_code. Only `youtube_upload` jobs in the
// current project are considered.
const uploadJobByEpisode = computed(() => {
  const map = new Map<string, any>()
  for (const j of (allJobs.value || []) as any[]) {
    if (j.type !== 'youtube_upload') continue
    if (j.project_slug !== slug.value) continue
    const code = j.episode_id
    const prior = map.get(code)
    // Keep the most recent (greatest created_at). Fallback to job_id sort.
    if (!prior || (j.created_at || '') > (prior.created_at || '')) {
      map.set(code, j)
    }
  }
  return map
})

// Helper for template lookups — returns a small shape or null.
function uploadJobFor(episode_code: string): {
  status: string
  progress: number
  error?: string | null
  bytes_done?: number
  bytes_total?: number
  speed_bps?: number
  eta_seconds?: number
} | null {
  const j = uploadJobByEpisode.value.get(episode_code)
  if (!j) return null
  return {
    status: j.status,
    progress: Number(j.progress) || 0,
    error: j.error,
    bytes_done: j.bytes_done,
    bytes_total: j.bytes_total,
    speed_bps: j.speed_bps,
    eta_seconds: j.eta_seconds,
  }
}

// Auto-refresh the queue when any youtube_upload job we were tracking
// transitions to a terminal state. This is what closes the "clicked
// Upload but queue still says Not uploaded" loop — the sidecar file the
// job writes is only visible via re-fetching the queue endpoint.
//
// v1.0.72-followup: was `watch(allJobs, ..., { deep: true })`, which
// fired on every output_lines push from any job in the queue — same
// UI-thread starvation as the earlier panel + composable fixes. Now
// derives a status-only signal of youtube_upload jobs and watches
// THAT, so the callback only fires on real terminal transitions.
const terminalSeen = new Set<string>()
const youtubeUploadStatusSignal = computed(() =>
  (allJobs.value || [])
    .filter((j: any) => j.type === 'youtube_upload' && j.project_slug === slug.value)
    .map((j: any) => `${j.job_id}:${j.status}`)
    .sort()
    .join('|'),
)
watch(youtubeUploadStatusSignal, () => {
  let needsRefresh = false
  for (const j of (allJobs.value || []) as any[]) {
    if (j.type !== 'youtube_upload') continue
    if (j.project_slug !== slug.value) continue
    if (!['done', 'error', 'cancelled'].includes(j.status)) continue
    if (terminalSeen.has(j.job_id)) continue
    terminalSeen.add(j.job_id)
    needsRefresh = true
  }
  if (needsRefresh) {
    loadQueue('youtube')
    loadQuota()
  }
})
watch(activeTab, (tab) => {
  if (tab === 'queue') {
    if (!queueItems.value.length) loadQueue('youtube')
    if (!importsFolder.value) loadImportsFolder()
    loadMissingVideoEpisodes()   // refresh every time; cheap, reflects post-scan state
    // Playlists are needed in the queue too for the per-row override
    // dropdown. Cheap (60s-cached) so no quota concerns.
    if (!playlists.value.length && youtubeAccounts.value.length) loadPlaylists()
    // Plans are needed for the Queue tab's "Upload Plan ▾" quick-apply
    // button — without this, the button stays disabled until the user
    // visits the Plans tab. List is tiny so the prefetch is free.
    if (!plans.value.length) loadPlans()
    // Orphans power the inline "Looks already on YouTube" pill on Ready
    // rows + the Link Video modal. Costs YouTube quota (one channel
    // listing) so we lazy-load once per session, not on every tab
    // switch. The user's "I uploaded this manually" workflow becomes
    // discoverable without leaving the Queue.
    if (!orphans.value.length && !orphansError.value && youtubeAccounts.value.length) {
      loadOrphans()
    }
    // Item F: auto-Sync from YouTube on a 24h cooldown. Catches takedowns
    // / drift / tombstones automatically so the user never sits on stale
    // state. Cooldown stored in localStorage per (project, account) pair
    // so navigating between projects doesn't re-fire constantly. Cost is
    // bounded by sidecar count (one quota unit per linked video).
    autoSyncFromYoutubeIfStale()
  }
  if (tab === 'plans' && !plans.value.length) loadPlans()
  if (tab === 'playlists' && !playlists.value.length) loadPlaylists()
  if (tab === 'orphans') {
    loadOrphans()
    // Item L — refresh the renumber-undo status when the user enters
    // the tab so the banner state matches reality (e.g. another window
    // already dismissed the sidecar, or it expired since last visit).
    loadRenumberUndoStatus()
    // v1.0.45 — same for reseason-undo. Independent file/sidecar so
    // both banners can coexist if both ops are pending revert.
    loadReseasonUndoStatus()
  }
})

// ── Orphan management state (#7) ─────────────────────────────────────────
// `orphanCodeDraft` is per-row typed episode_code (used for the "adopt
// single" action). `selectedOrphanIds` is the set picked for bulk.
const orphanCodeDraft = reactive<Record<string, string>>({})
const selectedOrphanIds = ref<Set<string>>(new Set())
const orphanBulkMode = ref<'continuation' | 'renumber'>('continuation')
const orphanBusy = ref(false)
const orphanConfirming = ref(false)

function toggleOrphanSelected(videoId: string) {
  const s = new Set(selectedOrphanIds.value)
  if (s.has(videoId)) s.delete(videoId); else s.add(videoId)
  selectedOrphanIds.value = s
}
function selectAllOrphans(all: boolean) {
  selectedOrphanIds.value = all ? new Set(orphans.value.map(o => o.videoId)) : new Set()
}

async function doAdoptSingleOrphan(orphan: any) {
  const code = (orphanCodeDraft[orphan.videoId] || '').trim()
  if (!code) {
    showError('Type an episode code first (e.g. TN0042).')
    return
  }
  orphanBusy.value = true
  try {
    const r = await adoptSingleOrphan(orphan, code)
    success(`Adopted ${r.adopted.episode_code}. A fresh episode folder was created + sidecar linked to video ${r.adopted.video_id.slice(0, 11)}…`)
    orphanCodeDraft[orphan.videoId] = ''
    await Promise.all([loadOrphans(), loadQueue('youtube')])
  } catch (e: any) {
    showError(e?.data?.detail || 'Adopt failed')
  } finally {
    orphanBusy.value = false
  }
}

async function doBulkAdoptOrphans() {
  const ids = Array.from(selectedOrphanIds.value)
  if (!ids.length) {
    showError('Select at least one orphan video.')
    return
  }
  const picked = orphans.value.filter((o: any) => selectedOrphanIds.value.has(o.videoId))
  const mode = orphanBulkMode.value

  const msg = mode === 'renumber'
    ? [
      `About to adopt ${picked.length} YouTube video(s) as episodes TN${String(1).padStart(4, '0')}–TN${String(picked.length).padStart(4, '0')}.`,
      '',
      `⚠ This will RENUMBER every existing accepted episode by +${picked.length}. Folders on disk will be renamed accordingly (e.g. TN0001 → TN${String(picked.length + 1).padStart(4, '0')}).`,
      '',
      'This is destructive and slow for large projects. Make sure all in-flight jobs are done and your disk has enough free space for a full copy (cross-filesystem renames fall back to copy+delete).',
      '',
      'Proceed?',
    ].join('\n')
    : [
      `About to adopt ${picked.length} orphan YouTube video(s) into episodes starting at TN${String(orphansNextNumber.value).padStart(4, '0')}.`,
      '',
      'Existing local episodes keep their codes. New folders + sidecars are created for each orphan.',
      '',
      'Proceed?',
    ].join('\n')

  const ok = await ask({
    title: mode === 'renumber' ? 'Renumber + adopt orphans?' : 'Adopt orphans (continuation codes)?',
    message: msg,
    confirmLabel: mode === 'renumber' ? 'Renumber + adopt' : 'Adopt',
    danger: mode === 'renumber',
  })
  if (!ok) return

  orphanConfirming.value = true
  try {
    const r = await adoptBulkOrphans(picked, mode)
    const parts = [`Adopted ${r.adopted.length}`]
    if (r.renamed?.length) parts.push(`renamed ${r.renamed.length} existing episode(s)`)
    if (r.errors?.length) parts.push(`${r.errors.length} error(s)`)
    success(parts.join(' · '))
    selectedOrphanIds.value = new Set()
    await Promise.all([loadOrphans(), loadQueue('youtube')])
    // Item L — bulk-renumber writes a `.renumber-undo.json` sidecar.
    // Refresh status so the banner appears immediately after the
    // operation lands, not just on the next tab visit.
    if (mode === 'renumber') {
      await loadRenumberUndoStatus()
    }
  } catch (e: any) {
    showError(e?.data?.detail || 'Bulk adopt failed')
  } finally {
    orphanConfirming.value = false
  }
}

// ── Item L — Renumber rollback state + handlers ──────────────────────────
// Banner appears on the Unlinked Uploads tab while a `.renumber-undo.json`
// sidecar exists in the project root (any time a bulk-renumber landed in
// the last 30 days, or a future renumber adoption that hasn't been
// dismissed). The actual revert is a destructive-ish operation handled
// by the backend revertRenumber service; the modal here just confirms.
const renumberUndoStatus = ref<{
  available: boolean
  plan?: any
  adopted_count?: number
  renamed_count?: number
  expired?: boolean
}>({ available: false })
const renumberUndoBusy = ref(false)
const revertRenumberModal = reactive<{
  open: boolean
  busy: boolean
  error: string
}>({ open: false, busy: false, error: '' })

async function loadRenumberUndoStatus() {
  try {
    renumberUndoStatus.value = await getRenumberUndoStatus()
  } catch {
    renumberUndoStatus.value = { available: false }
  }
}

function openRevertRenumberModal() {
  if (!renumberUndoStatus.value.available) return
  revertRenumberModal.open = true
  revertRenumberModal.busy = false
  revertRenumberModal.error = ''
}
function closeRevertRenumberModal() {
  if (revertRenumberModal.busy) return
  revertRenumberModal.open = false
}

async function confirmRevertRenumber() {
  if (revertRenumberModal.busy) return
  revertRenumberModal.busy = true
  revertRenumberModal.error = ''
  try {
    const r = await revertRenumber()
    const parts: string[] = []
    if (r.removed_adoptions.length) parts.push(`removed ${r.removed_adoptions.length} adoption(s)`)
    if (r.reverted_renames.length) parts.push(`reverted ${r.reverted_renames.length} rename(s)`)
    if (r.reverted_folders.length) parts.push(`renamed back ${r.reverted_folders.length} folder(s)`)
    if (r.errors.length) parts.push(`${r.errors.length} error(s) — see logs`)
    success('Renumber reverted · ' + (parts.length ? parts.join(', ') : 'no-op'))
    revertRenumberModal.open = false
    // Refresh the related views so the user sees the post-revert state
    // immediately (orphan list + queue + the now-empty undo banner).
    await Promise.all([
      loadRenumberUndoStatus(),
      loadOrphans().catch(() => {}),
      loadQueue('youtube').catch(() => {}),
    ])
  } catch (e: any) {
    revertRenumberModal.error = e?.data?.detail || e?.message || 'Revert failed'
  } finally {
    revertRenumberModal.busy = false
  }
}

async function dismissRenumberUndo() {
  if (renumberUndoBusy.value) return
  const confirmed = await ask({
    title: 'Dismiss the rollback safety net?',
    message: 'Deletes .renumber-undo.json. The project state stays as it is, but you won\'t be able to revert this renumber later. The sidecar would auto-delete after 30 days anyway — dismissing just clears it now.',
    confirmLabel: 'Dismiss',
  })
  if (!confirmed) return
  renumberUndoBusy.value = true
  try {
    await dismissRenumberUndoSidecar()
    success('Renumber-undo sidecar dismissed')
    await loadRenumberUndoStatus()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to dismiss sidecar')
  } finally {
    renumberUndoBusy.value = false
  }
}

// ── Reseason undo (v1.0.45) ─────────────────────────────────────────────
// Sibling to the renumber-undo flow above. Fires when the user has
// rebalanced season folders within the last 30 days.
const reseasonUndoStatus = ref<{
  available: boolean
  plan?: { performed_at: string; previous_season_size: number; new_season_size: number; moves: any[] }
  moves_count?: number
  expired?: boolean
}>({ available: false })
const reseasonUndoBusy = ref(false)

async function loadReseasonUndoStatus() {
  try {
    const { get: apiGet } = useApi()
    reseasonUndoStatus.value = await apiGet(`/projects/${slug.value}/episodes/reseason-undo`)
  } catch {
    reseasonUndoStatus.value = { available: false }
  }
}

async function openRevertReseasonModal() {
  if (!reseasonUndoStatus.value.available || reseasonUndoBusy.value) return
  const confirmed = await ask({
    title: 'Revert reseason?',
    message: `Move every rebalanced folder back to its original ${reseasonUndoStatus.value.plan?.previous_season_size}-per-group parent and restore that as the project's season size. External-root mirror is reverted in the same step. Reversible by re-running Settings → Project → Rebalance.`,
    confirmLabel: 'Revert',
    danger: true,
  })
  if (!confirmed) return
  reseasonUndoBusy.value = true
  try {
    const { post: apiPost } = useApi()
    const r = await apiPost<{
      ok: true
      reverted: any[]
      reverted_external: any[]
      restored_parents: string[]
      errors: any[]
    }>(`/projects/${slug.value}/episodes/reseason-undo/revert`, {})
    const parts: string[] = []
    if (r.reverted.length) parts.push(`${r.reverted.length} folder${r.reverted.length === 1 ? '' : 's'} moved back`)
    if (r.reverted_external.length) parts.push(`${r.reverted_external.length} external`)
    if (r.errors.length) parts.push(`${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`)
    success('Reseason reverted · ' + (parts.length ? parts.join(', ') : 'no-op'))
    await Promise.all([
      loadReseasonUndoStatus(),
      loadQueue('youtube').catch(() => {}),
    ])
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Revert failed')
  } finally {
    reseasonUndoBusy.value = false
  }
}

async function dismissReseasonUndo() {
  if (reseasonUndoBusy.value) return
  const confirmed = await ask({
    title: 'Dismiss the rollback safety net?',
    message: 'Deletes .reseason-undo.json. The rebalanced folders stay where they are; you just won\'t be able to revert this rebalance later. Auto-deletes after 30 days anyway.',
    confirmLabel: 'Dismiss',
  })
  if (!confirmed) return
  reseasonUndoBusy.value = true
  try {
    const { del: apiDel } = useApi()
    await apiDel(`/projects/${slug.value}/episodes/reseason-undo`)
    success('Reseason-undo sidecar dismissed')
    await loadReseasonUndoStatus()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to dismiss sidecar')
  } finally {
    reseasonUndoBusy.value = false
  }
}

// ── Playlists tab state (A4) ─────────────────────────────────────────────
const showCreatePlaylist = ref(false)
const newPlaylistForm = reactive<{ title: string; description: string; privacyStatus: 'public' | 'unlisted' | 'private' }>({
  title: '', description: '', privacyStatus: 'private',
})
// v1.0.108+ — LLM-generated playlist description state.
const generatingPlaylistDesc = ref(false)
async function doGeneratePlaylistDescription() {
  if (!newPlaylistForm.title.trim() || generatingPlaylistDesc.value) return
  generatingPlaylistDesc.value = true
  try {
    const r = await useApi().post<{ description: string; length: number; model_notice?: string }>(
      `/projects/${slug.value}/upload/playlists/generate-description`,
      { title: newPlaylistForm.title.trim() },
    )
    newPlaylistForm.description = r.description
    success(`Generated ${r.length}-char description — review + edit before creating.`)
    // The server healed away from the saved model. Informational, never
    // blocking — the description IS generated and sitting in the field.
    if (r.model_notice) showToast(r.model_notice, 'info', 12000)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to generate description.')
  } finally {
    generatingPlaylistDesc.value = false
  }
}
async function doCreatePlaylist() {
  if (!newPlaylistForm.title.trim()) {
    showError('Playlist title required.')
    return
  }
  try {
    const pl = await createPlaylistFor({
      title: newPlaylistForm.title.trim(),
      description: newPlaylistForm.description,
      privacyStatus: newPlaylistForm.privacyStatus,
    })
    success(`Created playlist "${pl.title}"`)
    showCreatePlaylist.value = false
    newPlaylistForm.title = ''
    newPlaylistForm.description = ''
    newPlaylistForm.privacyStatus = 'private'
  } catch (e: any) {
    const status = e?.response?.status ?? e?.status
    const detail = e?.data?.detail || e?.message || ''
    const msg = status === 404
      ? 'Playlist create endpoint not found. Fully quit + relaunch Electron to pick up the latest code.'
      : `Failed to create playlist${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`
    showError(msg)
  }
}

async function doSetDefaultPlaylist(playlistId: string) {
  try {
    await setDefaultPlaylist(playlistId)
    success(playlistId ? 'Default playlist set.' : 'Default playlist cleared.')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to set default playlist')
  }
}

// ── Per-episode Imported/ (Phase 5) ─────────────────────────────────────
const episodeScanInFlight = ref<string | null>(null)
async function doEpisodeScan(ep: { episode_code: string }) {
  episodeScanInFlight.value = ep.episode_code
  try {
    const r = await scanEpisodeImports(ep.episode_code)
    const moved = r.moved?.length || 0
    if (moved > 0) {
      success(`Imported ${moved} file${moved === 1 ? '' : 's'} → ${ep.episode_code} · Pipeline will now see it as finished.`)
    } else {
      showError(`No videos found in ${ep.episode_code}'s Imported/ folder. Drop a file and scan again.`)
    }
    // Refresh both lists: missing (this episode should drop off) and queue (now includes it).
    await Promise.all([loadMissingVideoEpisodes(), loadQueue('youtube')])
  } catch (e: any) {
    showError(e?.data?.detail || 'Episode scan failed')
  } finally {
    episodeScanInFlight.value = null
  }
}
async function doRevealEpisodeImport(ep: { episode_code: string }) {
  try {
    const folder = await getEpisodeImportFolder(ep.episode_code)
    if (!folder) throw new Error('Folder path not returned')
    await revealFolder(folder)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not open folder')
  }
}

// ── Reconcile (Phase 6) ─────────────────────────────────────────────────
type ReconcileLinkState = 'linked' | 'suggested' | 'review' | 'manual'

const reconcileState = ref<null | {
  account_id: string
  remote_count: number
  local_count: number
  already_linked: string[]
  linked_videos: Record<string, string>
  rows: Array<{
    videoId: string
    title: string
    publishedAt: string
    privacyStatus?: string
    suggested_episode_code: string | null
    selected_episode_code: string    // user-editable; empty = "don't link"
    score: number
    reason: string
    apply_remote_title: boolean
  }>
}>(null)
const reconcileLoading = ref(false)
const reconcileConfirming = ref(false)

// All accepted ideas — backs the per-row episode picker (datalist) so
// the user can search by code or title, INCLUDING episodes that are
// already linked elsewhere. Loaded once per project on tab activation;
// re-fetched after a confirm so newly-linked codes show up correctly
// when the list refreshes.
const acceptedIdeas = ref<Array<{ id: string; episode_code: string; title: string }>>([])
async function loadAcceptedIdeas() {
  try {
    const r = await $fetch<{ ideas: Array<{ id: string; episode_code?: string; title?: string }> }>(
      `/api/projects/${slug}/ideas?status=accepted`,
    )
    acceptedIdeas.value = (r.ideas || [])
      .filter(i => !!i.episode_code)
      .map(i => ({ id: i.id, episode_code: i.episode_code as string, title: i.title || '' }))
  } catch { /* tolerate — picker falls back to its existing partial sources */ }
}

/**
 * Picker options for the reconcile per-row episode dropdown. Includes
 * EVERY accepted episode (so the user can override an existing wrong
 * link by picking the rightful episode), and tags each option with
 * the videoId it's currently bound to (when applicable). The datalist
 * label visualises the linked-elsewhere state with a ⚠ prefix so the
 * user sees the override at type-time.
 */
const reconcilePickerOptions = computed(() => {
  const linkedMap: Record<string, string> = reconcileState.value?.linked_videos || {}
  const reverseLink = new Map<string, string>()
  for (const [vid, code] of Object.entries(linkedMap)) reverseLink.set(code, vid)
  const list = acceptedIdeas.value.map(ep => ({
    episode_code: ep.episode_code,
    title: ep.title,
    linked_to: reverseLink.get(ep.episode_code) || '',
  }))
  // Codes ascending — TN0001 → TN0150. localeCompare with numeric:true
  // handles TN0009 vs TN0010 correctly.
  list.sort((a, b) => a.episode_code.localeCompare(b.episode_code, undefined, { numeric: true }))
  return list
})

/**
 * For a candidate episode code in a given video's row: returns the
 * videoId that the episode is CURRENTLY linked to, but only if that
 * videoId differs from the row's own (a true override). Used both
 * for the inline "⚠ override" badge and the pre-save confirm dialog.
 */
function reconcileEpisodeOverrideHint(epCode: string, currentVideoId: string): string {
  if (!epCode) return ''
  const linkedMap: Record<string, string> = reconcileState.value?.linked_videos || {}
  for (const [vid, code] of Object.entries(linkedMap)) {
    if (code === epCode && vid !== currentVideoId) return vid
  }
  return ''
}

// Filter / sort / pagination state for the Reconcile table. Default filter
// is "unlinked" so the user only sees actionable rows on first load — they
// can switch to "all" or "linked" to see the rest. Mirrors the Queue tab's
// pagination model.
const reconcileFilter = ref<'all' | 'unlinked' | 'linked' | 'suggested' | 'review' | 'manual'>('unlinked')
const reconcileSort = ref<'confidence_desc' | 'published_desc' | 'published_asc' | 'title_asc' | 'title_desc' | 'episode_asc' | 'episode_desc'>('confidence_desc')
const reconcilePage = ref(1)
const reconcilePageSize = ref<10 | 20 | 50 | 100>(10)
// Free-text search across YouTube title, video ID, and the episode
// code currently selected/suggested for the row. Client-side because
// the entire reconcile dataset is already in memory (seedReconcileFromPayload).
const reconcileSearch = ref('')

function seedReconcileFromPayload(p: { account_id: string; remote_count: number; local_count: number; already_linked: string[]; linked_videos?: Record<string, string>; suggestions: any[] }) {
  const linked = p.linked_videos || {}
  reconcileState.value = {
    account_id: p.account_id,
    remote_count: p.remote_count,
    local_count: p.local_count,
    already_linked: p.already_linked,
    linked_videos: linked,
    rows: p.suggestions.map((s: any) => {
      const linkedCode = linked[s.remote.videoId]
      return {
        videoId: s.remote.videoId,
        title: s.remote.title,
        publishedAt: s.remote.publishedAt,
        privacyStatus: s.remote.privacyStatus,
        suggested_episode_code: s.suggested_episode_code,
        // For Linked rows the dropdown reflects the *current* binding so
        // hitting Save without a change is a no-op (rather than overwriting
        // the linked episode with the matcher's suggestion).
        selected_episode_code: linkedCode || s.suggested_episode_code || '',
        score: s.score,
        reason: s.reason,
        // Per-row opt-in for "Sync title from YT" — defaults OFF so
        // we never silently rename an episode the user titled by hand.
        apply_remote_title: false,
      }
    }),
  }
  reconcilePage.value = 1
  // Refresh the picker option list whenever fresh reconcile data
  // lands. Cheap (~one tiny GET); also catches the case where a user
  // accepted ideas in another tab between visits.
  void loadAcceptedIdeas()
}

// Per-row link-state cascade. Linked wins outright (we already confirmed
// this video before); otherwise score/reason determine which badge shows.
function reconcileLinkState(row: { videoId: string; reason: string; score: number }): ReconcileLinkState {
  const s = reconcileState.value
  if (s && s.linked_videos[row.videoId]) return 'linked'
  if (row.reason === 'episode_code') return 'suggested'
  if (row.reason === 'title_similarity' && row.score >= 0.6) return 'suggested'
  if (row.reason === 'title_similarity') return 'review'
  return 'manual'
}

// Tag every row with its computed link-state and badge label *once*. Both
// `reconcileFilteredRows` and `reconcileStateCounts` consume this so we
// don't pay the linkState-cascade twice (and the template doesn't pay
// reconcileBadgeLabel twice via the title + content bindings). For a
// 400-row preview, this halves the per-update workload from ~800 cascade
// evaluations to ~400.
const reconcileTaggedRows = computed(() => {
  const s = reconcileState.value
  if (!s) return [] as Array<typeof s.rows[number] & { _state: ReconcileLinkState; _label: string }>
  return s.rows.map(r => {
    const _state = reconcileLinkState(r)
    return { ...r, _state, _label: reconcileBadgeLabelFor(r, _state) }
  })
})

const reconcileFilteredRows = computed(() => {
  const tagged = reconcileTaggedRows.value
  let out = tagged
  switch (reconcileFilter.value) {
    case 'linked':    out = tagged.filter(r => r._state === 'linked'); break
    case 'unlinked':  out = tagged.filter(r => r._state !== 'linked'); break
    case 'suggested': out = tagged.filter(r => r._state === 'suggested'); break
    case 'review':    out = tagged.filter(r => r._state === 'review'); break
    case 'manual':    out = tagged.filter(r => r._state === 'manual'); break
    case 'all':
    default:          /* no filter */ break
  }
  // Substring search — matches against YouTube title, videoId, and the
  // episode code currently bound or suggested for the row. Lets the
  // user jump straight to "TN0143" or "Painter's Memory" without
  // clicking through pages.
  const qNorm = reconcileSearch.value.trim().toLowerCase()
  if (qNorm) {
    out = out.filter(r =>
      (r.title || '').toLowerCase().includes(qNorm) ||
      (r.videoId || '').toLowerCase().includes(qNorm) ||
      (r.selected_episode_code || '').toLowerCase().includes(qNorm) ||
      (r.suggested_episode_code || '').toLowerCase().includes(qNorm)
    )
  }
  // `numeric: true` in localeCompare so TN0009 sorts before TN0010.
  // Without it the lexicographic comparison would put TN0010 first.
  const cmpEpisode = (a: typeof out[number], b: typeof out[number]) => {
    const ac = a.selected_episode_code || a.suggested_episode_code || ''
    const bc = b.selected_episode_code || b.suggested_episode_code || ''
    // Empty episode codes sink to the bottom regardless of direction —
    // they have nothing to sort by and shouldn't push the codeful rows out.
    if (!ac && bc) return 1
    if (ac && !bc) return -1
    return ac.localeCompare(bc, undefined, { numeric: true })
  }
  switch (reconcileSort.value) {
    case 'published_desc':
      out = [...out].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
      break
    case 'published_asc':
      out = [...out].sort((a, b) => (a.publishedAt || '').localeCompare(b.publishedAt || ''))
      break
    case 'title_asc':
      out = [...out].sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      break
    case 'title_desc':
      out = [...out].sort((a, b) => (b.title || '').localeCompare(a.title || ''))
      break
    case 'episode_asc':
      out = [...out].sort(cmpEpisode)
      break
    case 'episode_desc':
      out = [...out].sort((a, b) => -cmpEpisode(a, b))
      break
    case 'confidence_desc':
    default:
      // Sort: episode_code (1.0) first, then title_similarity by score, then none.
      // Stable on score ties — keep YouTube's natural recency order.
      out = [...out].sort((a, b) => {
        const rank = (r: typeof a) => r.reason === 'episode_code' ? 2 : r.reason === 'title_similarity' ? 1 : 0
        const dr = rank(b) - rank(a)
        if (dr !== 0) return dr
        return (b.score || 0) - (a.score || 0)
      })
      break
  }
  return out
})

const reconcileDisplayRows = computed(() => {
  const all = reconcileFilteredRows.value
  const start = (reconcilePage.value - 1) * reconcilePageSize.value
  return all.slice(start, start + reconcilePageSize.value)
})

const reconcileTotalPages = computed(() => {
  const total = reconcileFilteredRows.value.length
  return Math.max(1, Math.ceil(total / reconcilePageSize.value))
})

const reconcileStateCounts = computed(() => {
  const tagged = reconcileTaggedRows.value
  if (!tagged.length) return { linked: 0, suggested: 0, review: 0, manual: 0, total: 0 }
  let linked = 0, suggested = 0, review = 0, manual = 0
  for (const r of tagged) {
    switch (r._state) {
      case 'linked':    linked++; break
      case 'suggested': suggested++; break
      case 'review':    review++; break
      case 'manual':    manual++; break
    }
  }
  return { linked, suggested, review, manual, total: tagged.length }
})

const reconcileShownRange = computed(() => {
  const total = reconcileFilteredRows.value.length
  if (!total) return { from: 0, to: 0, total: 0 }
  const from = (reconcilePage.value - 1) * reconcilePageSize.value + 1
  const to = Math.min(total, from + reconcilePageSize.value - 1)
  return { from, to, total }
})

function goToReconcilePage(n: number) {
  const clamped = Math.max(1, Math.min(reconcileTotalPages.value, Math.floor(n)))
  reconcilePage.value = clamped
}

// Pure variant that takes the already-computed state to avoid re-running
// the linkState cascade. Used by `reconcileTaggedRows` so each row gets
// `_label` materialised once instead of computing it twice via title +
// content bindings in the template.
function reconcileBadgeLabelFor(row: { reason: string; score: number; videoId: string }, state: ReconcileLinkState): string {
  const linked = reconcileState.value?.linked_videos[row.videoId]
  if (state === 'linked') return `Linked → ${linked}`
  if (state === 'suggested') {
    if (row.reason === 'episode_code') return 'Suggested · code match'
    return `Suggested · score ${row.score.toFixed(2)}`
  }
  if (state === 'review') return `Low confidence · score ${row.score.toFixed(2)}`
  return 'No match — pick manually'
}

watch([reconcileFilter, reconcileSort, reconcilePageSize, reconcileSearch], () => {
  reconcilePage.value = 1
})

async function runReconcilePreview() {
  reconcileLoading.value = true
  try {
    // Manual button always force-refreshes — bypasses the 10-min cache that
    // backs the Queue-tab banner. Auto-fetch from onMounted goes through the
    // cached path so revisiting the page doesn't burn YouTube quota.
    const p = await getCachedReconcilePreview(undefined, { force: true })
    if (!p) { showError('No default YouTube account set. Connect one in the Accounts tab first.'); return }
    seedReconcileFromPayload(p)
    success(`Fetched ${p.remote_count} channel video(s) · ${p.local_count} local episode(s) considered.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Reconcile preview failed')
  } finally {
    reconcileLoading.value = false
  }
}

// Actionable suggestions = ones with a probable local match (score ≥ 0.6
// or episode-code 1.0) where the matched episode isn't already linked to
// some other video. Drives the Queue-tab banner count.
const actionableReconcileMatches = computed(() => {
  const p = reconcilePreviewState.value
  if (!p) return [] as any[]
  return p.suggestions.filter(s =>
    s.suggested_episode_code
    && s.score >= 0.6
    && !p.already_linked.includes(s.suggested_episode_code),
  )
})

// Banner dismissal — keyed per (slug, account). The stored value hashes
// the actionable set so a NEW match resurfaces the banner even if the
// previous one was dismissed.
const reconcileBannerDismissedHash = ref<string | null>(null)
function reconcileBannerKey() {
  const acctId = defaults.value.youtube || ''
  return `upload-reconcile-banner-dismissed:${slug.value}:${acctId}`
}
function currentReconcileBannerHash() {
  return actionableReconcileMatches.value
    .map((s: any) => `${s.remote.videoId}:${s.suggested_episode_code}`)
    .sort()
    .join('|')
}
const showReconcileBanner = computed(() => {
  if (!actionableReconcileMatches.value.length) return false
  return reconcileBannerDismissedHash.value !== currentReconcileBannerHash()
})
function dismissReconcileBanner() {
  try {
    const h = currentReconcileBannerHash()
    localStorage.setItem(reconcileBannerKey(), h)
    reconcileBannerDismissedHash.value = h
  } catch { /* private mode — banner just stays until next match change */ }
}
function gotoReconcileTab() {
  // Seed the editable rows from the cache so the Reconcile tab renders
  // immediately (no second spinner) when the user clicks the banner.
  if (!reconcileState.value && reconcilePreviewState.value) {
    seedReconcileFromPayload(reconcilePreviewState.value)
  }
  activeTab.value = 'reconcile'
}

// Background fetch on page mount — silent, non-blocking. Only runs when
// a default YouTube account is set (otherwise there's nothing to fetch).
async function maybeBackgroundReconcile() {
  const acctId = defaults.value.youtube || ''
  if (!acctId) return
  try { await getCachedReconcilePreview(acctId) } catch { /* silent */ }
}
watch(() => defaults.value.youtube, (id) => {
  if (!id) return
  // Re-read dismissal hash for this account — onMounted ran before
  // loadAccounts populated defaults.youtube, so the key was wrong then.
  try { reconcileBannerDismissedHash.value = localStorage.getItem(reconcileBannerKey()) } catch {}
  maybeBackgroundReconcile()
})

async function doReconcileConfirm() {
  const s = reconcileState.value
  if (!s) return
  const links = s.rows
    .filter((r: any) => r.selected_episode_code)
    .map((r: any) => ({
      episode_code: r.selected_episode_code,
      video_id: r.videoId,
      remote_title: r.title,
      published_at: r.publishedAt,
      apply_remote_title: !!r.apply_remote_title,
    }))
  if (!links.length) {
    showError('No links selected. Pick an episode in at least one row, or leave the tab.')
    return
  }

  // Duplicate-link guard: if the user picked the same episode in multiple
  // rows, only the last write would win. Surface the conflict and require
  // them to resolve it before we touch any sidecars — silent last-write-
  // wins was the concern called out in the production audit.
  const counts = new Map<string, string[]>()
  for (const link of links) {
    const arr = counts.get(link.episode_code) || []
    arr.push(link.video_id)
    counts.set(link.episode_code, arr)
  }
  const conflicts = Array.from(counts.entries()).filter(([, ids]) => ids.length > 1)
  if (conflicts.length) {
    const detail = conflicts
      .map(([code, ids]) => `${code}: ${ids.length} videos (${ids.map(i => i.slice(0, 8) + '…').join(', ')})`)
      .join('\n')
    showError(`Each local episode can link to at most one YouTube video. Conflicts:\n${detail}\n\nChange one of the duplicates to "— don't link —" and try again.`)
    return
  }

  // Re-link guard. Two distinct overrides are possible per save and
  // must both be surfaced to the user before any sidecar is touched:
  //
  //   • video-side: this video was already linked to episode A; the
  //     user is relinking it to episode B. Result: A loses its video.
  //   • episode-side: this episode was already linked to video X;
  //     the user is now linking the same episode to video Y. Result:
  //     X becomes orphan.
  //
  // A single save can produce either, both, or neither per row.
  type ReLink = {
    episode_code: string
    video_id: string
    /** Episode that USED to claim this video and will lose it. */
    video_side_old_episode?: string
    /** Video this episode WAS linked to and will become orphan. */
    episode_side_old_video?: string
  }
  const reLinks: ReLink[] = []
  for (const l of links) {
    const change: ReLink = { episode_code: l.episode_code, video_id: l.video_id }
    const vsidePrev = s.linked_videos[l.video_id]
    if (vsidePrev && vsidePrev !== l.episode_code) change.video_side_old_episode = vsidePrev
    for (const [vid, code] of Object.entries(s.linked_videos)) {
      if (code === l.episode_code && vid !== l.video_id) {
        change.episode_side_old_video = vid
        break
      }
    }
    if (change.video_side_old_episode || change.episode_side_old_video) reLinks.push(change)
  }
  if (reLinks.length) {
    const list = reLinks
      .map(l => {
        const parts: string[] = [`• ${l.episode_code} ↔ ${l.video_id.slice(0, 11)}…`]
        if (l.video_side_old_episode) parts.push(`     (replaces ${l.video_side_old_episode}'s link to this video)`)
        if (l.episode_side_old_video) parts.push(`     (releases ${l.episode_side_old_video.slice(0, 11)}… as orphan)`)
        return parts.join('\n')
      })
      .join('\n')
    const ok = await ask({
      title: reLinks.length === 1 ? 'Replace existing link?' : `Replace ${reLinks.length} existing links?`,
      message:
        `Saving will overwrite ${reLinks.length === 1 ? 'an existing link' : `${reLinks.length} existing links`}:\n\n${list}\n\n` +
        `The previous binding(s) will be lost — affected videos surface as "Unlinked" on the next reconcile.`,
      confirmLabel: 'Replace',
      danger: true,
    })
    if (!ok) return
  }

  reconcileConfirming.value = true
  try {
    const r = await reconcileConfirm(s.account_id, links)
    const errCount = r.errors?.length || 0
    const okCount = r.written?.length || 0
    const syncedCount = r.titles_synced?.length || 0
    const msg = [
      `${okCount} link(s) saved`,
      syncedCount ? `${syncedCount} title(s) synced from YT` : '',
      errCount ? `${errCount} error(s)` : '',
    ].filter(Boolean).join(' · ')
    success(msg)
    // Episodes whose ideas.json title was rewritten — refresh the
    // accepted-ideas cache so the picker labels reflect the new
    // titles immediately. Cheap; one route call.
    if (syncedCount) await loadAcceptedIdeas()
    // Old video-side bindings that were displaced by this save. Their
    // sidecars now point at a different video, so we proactively drop
    // their entry from `linked_videos` to avoid the picker still
    // showing them as "linked elsewhere" until the next preview refresh.
    for (const link of links) {
      if (!r.written.includes(link.episode_code)) continue
      // Episode-side override: clear the OLD video that used to claim
      // this episode (now orphan).
      for (const [vid, code] of Object.entries(s.linked_videos)) {
        if (code === link.episode_code && vid !== link.video_id) {
          delete s.linked_videos[vid]
        }
      }
    }
    // Refresh queue so newly-linked episodes show as uploaded.
    await loadQueue('youtube')
    // Optimistic local update: every row we just wrote becomes "linked"
    // immediately so the badges reflect reality without forcing a full
    // re-fetch. The next backend preview refresh will reconcile.
    for (const link of links) {
      if (r.written.includes(link.episode_code)) {
        s.linked_videos[link.video_id] = link.episode_code
        if (!s.already_linked.includes(link.episode_code)) s.already_linked.push(link.episode_code)
      }
    }
    // Drop from the reconcile table.
    s.rows = s.rows.filter((row: any) => !r.written.includes(row.selected_episode_code))
    // Invalidate the cached preview so the Queue-tab banner reflects the
    // new state on next render. Then re-prime it (cheap if cache fresh,
    // forced if not — and after a confirm it isn't fresh).
    invalidateReconcilePreview(s.account_id)
    maybeBackgroundReconcile()
  } catch (e: any) {
    showError(e?.data?.detail || 'Reconcile confirm failed')
  } finally {
    reconcileConfirming.value = false
  }
}

function reasonLabel(row: any): string {
  if (row.reason === 'episode_code') return 'episode code match'
  if (row.reason === 'title_similarity') return `title ${Math.round(row.score * 100)}%`
  return 'no match'
}

async function doScan() {
  scanning.value = true
  try {
    const r = await scanImports()
    const newCount = (r.discovered || []).filter((d: any) => d.is_new).length
    const missing = r.missing?.length || 0
    const msg = [
      `${r.discovered.length} import${r.discovered.length === 1 ? '' : 's'} found`,
      newCount > 0 ? `${newCount} new` : '',
      missing > 0 ? `${missing} missing from disk` : '',
    ].filter(Boolean).join(' · ')
    success(msg || 'No imports found — drop video files into the Upload Queue folder and scan again.')
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Scan failed')
  } finally {
    scanning.value = false
  }
}

// Inline metadata editor for import rows.
const editingImport = ref<any>(null)
const editingImportMeta = reactive({ title: '', description: '', tagsStr: '' })
function startEditImport(item: any) {
  editingImport.value = item
  editingImportMeta.title = item.title || ''
  editingImportMeta.description = ''
  editingImportMeta.tagsStr = ''
}
async function saveImportMetaForm() {
  if (!editingImport.value) return
  try {
    await saveImportMeta(editingImport.value.filename, {
      title: editingImportMeta.title,
      description: editingImportMeta.description,
      tags: editingImportMeta.tagsStr.split(',').map((t: string) => t.trim()).filter(Boolean),
    })
    editingImport.value = null
    success('Import metadata saved.')
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save metadata')
  }
}

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes; let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const decimals = i >= 2 ? 2 : 0
  return `${v.toFixed(decimals)} ${units[i]}`
}

async function doRemoveImport(item: any) {
  const sizeStr = item.size_bytes ? ` (${humanBytes(item.size_bytes)})` : ''
  const ok = await ask({
    title: `Remove "${item.filename}" from queue?`,
    message: `Removes ${item.filename}${sizeStr} from the queue and deletes it from disk. If the file was already uploaded to YouTube, the upload itself stays.`,
    confirmLabel: 'Remove + delete file',
    danger: true,
  })
  if (!ok) return
  try {
    await removeImport(item.filename, true)
    success('Import removed.')
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove import')
  }
}

// ── Plans state (Phase 3) ─────────────────────────────────────────────
// Plan editor form. `editing` holds either an in-flight edit of an
// existing plan (id set) or a draft for a new plan (id empty). Save upserts.
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Pre-format the plans table's weekday label so the template doesn't run
// `weekdays.map(...).join(...)` on every reactive update. The map+join is
// O(weekday count) per plan per render — small but pointless to repeat.
const displayedPlans = computed(() =>
  (plans.value || []).map((p: any) => ({
    ...p,
    _weekdayLabel: ((p.schedule?.weekdays as number[] | undefined) || []).map((d: number) => WEEKDAY_LABELS[d]).join(', ') || '—',
  })),
)
const editing = ref<any>(null)
const previewSlots = ref<string[]>([])
const applying = ref(false)
// Bulk "Apply + Upload all" gate. Distinct from `applying` so the
// button can show its own progress label and the regular Apply button
// can stay disabled-but-not-busy during the fan-out phase.
const applyAndUploading = ref(false)

// Sensible timezone default — detect from the browser; user can override.
const defaultTz = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
})()

// Bundled IANA timezone database (R5.3). Shipped as a static JSON asset
// at frontend/data/timezones.json so the picker never hits the network
// and we render a compact grouped <select> instead of a 400+ option
// datalist. Regenerate via `node scripts/build-tz-db.mjs` after a Node
// upgrade if the tzdata release changes. Import is hoisted to the top
// of <script setup>.
function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '−'
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m === 0 ? `GMT${sign}${h}` : `GMT${sign}${h}:${String(m).padStart(2, '0')}`
}
function decorate(zone: { id: string; city: string; offset_minutes_jan: number; offset_minutes_jul: number }) {
  return { ...zone, offsetLabel: formatOffset(zone.offset_minutes_jan) }
}
const tzIndex = new Map<string, any>()
for (const region of (tzData as any).regions) {
  for (const z of region.zones) tzIndex.set(z.id, z)
}
const tzPopular = computed(() =>
  (tzData as any).popular
    .map((id: string) => tzIndex.get(id))
    .filter(Boolean)
    .map(decorate))
const tzRegions = computed(() =>
  (tzData as any).regions.map((r: any) => ({
    name: r.name,
    zones: r.zones.map(decorate),
  })))

function startNewPlan() {
  editing.value = {
    id: '',
    name: '',
    platform: 'youtube',
    account_id: defaults.value.youtube || (youtubeAccounts.value[0]?.id || ''),
    schedule: {
      weekdays: [1, 3, 5],  // default Mon/Wed/Fri
      time_local: '18:00',
      timezone: defaultTz,
      interval_weeks: 1,
      monthly_day: null,
      start_date: '',
      end_date: '',
    },
    defaults: {
      privacy_status: 'private',
      language: '',
      made_for_kids: false,
    },
  }
  previewSlots.value = []
}

function startEditPlan(plan: any) {
  editing.value = JSON.parse(JSON.stringify(plan))
  previewSlots.value = []
}

function toggleWeekday(d: number) {
  if (!editing.value) return
  const set = new Set<number>((editing.value.schedule.weekdays || []).map(Number))
  if (set.has(d)) set.delete(d); else set.add(d)
  editing.value.schedule.weekdays = Array.from(set).sort((a, b) => a - b)
}

async function savePlanForm() {
  if (!editing.value) return
  const payload = JSON.parse(JSON.stringify(editing.value))
  // Normalize empty strings — backend treats them as not set.
  if (!payload.schedule.start_date) delete payload.schedule.start_date
  if (!payload.schedule.end_date) delete payload.schedule.end_date
  if (!payload.schedule.monthly_day) delete payload.schedule.monthly_day
  if (!payload.schedule.interval_weeks || payload.schedule.interval_weeks < 2) {
    delete payload.schedule.interval_weeks
  }
  try {
    await savePlan(payload)
    editing.value = null
    success('Plan saved.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save plan')
  }
}

async function runPreview() {
  if (!editing.value?.id) {
    showError('Save the plan first, then preview.')
    return
  }
  try {
    // Standalone "what does this plan look like?" tester — no episode
    // context, so the preview falls back to raw N slots from
    // start_date (no skip-claimed). The scope-picker preview that the
    // user sees on Apply uses the skip-claimed variant — see pickScope.
    const r = await previewPlan(editing.value.id, 10)
    previewSlots.value = r.slots
  } catch (e: any) {
    showError(e?.data?.detail || 'Preview failed')
  }
}

async function doDeletePlan(plan: any) {
  const ok = await ask({
    title: `Delete plan "${plan.name}"?`,
    message: 'The plan is removed from this project. Any per-item schedule it already wrote stays in place — use "Clear schedule" on the Queue if you want that gone too.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await deletePlan(plan.id)
    if (editing.value?.id === plan.id) editing.value = null
    success('Plan deleted.')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to delete plan')
  }
}

async function doActivatePlan(plan: any) {
  try {
    await activatePlan(plan.id)
    success(`"${plan.name}" is now the default plan for this account.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to activate plan')
  }
}

// ── v1.0.501 — YouTube auth-expiry banner ──────────────────────────────
// One expired/revoked token used to surface as SIX independent raw-stack
// error toasts (playlists, orphans, sync, statuses, …) per page visit.
// Detect the signature once (backend tags it code:'youtube_auth_expired'
// via humanizeBackendError) and collapse everything into a single banner
// with a "reconnect" path; individual toasts for this class are suppressed.
const ytAuthBroken = ref(false)
function isYtAuthError(e: any): boolean {
  if (e?.data?.code === 'youtube_auth_expired') return true
  const msg = String(e?.data?.detail || e?.message || '')
  return /youtube_auth_expired|invalid_grant|expired or revoked|YouTube session expired|Token refresh failed/i.test(msg)
}
/** showError, unless it's the auth-expiry class — then raise the banner instead. */
function noteYtError(e: any, fallback: string): void {
  if (isYtAuthError(e)) { ytAuthBroken.value = true; return }
  showError(e?.data?.detail || e?.message || fallback)
}
// The auto-fired panel loaders (orphans / playlists) keep their errors in
// composable refs rather than throwing to a page catch — watch those for
// the same signature so the banner also raises on page load.
watch([() => orphansError.value, () => playlistsError.value], ([o, p]) => {
  const s = `${o || ''} ${p || ''}`
  if (/youtube_auth_expired|invalid_grant|expired or revoked|YouTube session expired|Token refresh failed/i.test(s)) {
    ytAuthBroken.value = true
  }
})
async function retryAfterReconnect(): Promise<void> {
  ytAuthBroken.value = false
  await Promise.all([
    loadQueue('youtube'),
    loadOrphans().catch(() => {}),
    loadPlaylists(true).catch(() => {}),
  ])
  success('Retried — if the banner stays gone, the account is healthy again.')
}

// ── v1.0.501 — operation report ────────────────────────────────────────
// A persistent per-episode outcome card for plan Apply / Apply+Upload,
// replacing vanishing multi-clause toasts as the detailed record: what got
// scheduled, what YouTube accepted, what failed and WHY — with per-row
// retry. Toasts stay as the one-line summary; this card is the receipt.
interface OpRow {
  episode_code: string
  ok: boolean
  action: string
  detail: string
  retry?: 'patch' | 'upload'
  publish_at?: string
  busy?: boolean
}
const opReport = ref<{ title: string; at: string; rows: OpRow[] } | null>(null)
const opReportFailCount = computed(() => (opReport.value?.rows || []).filter(r => !r.ok).length)
function openOpReport(title: string, rows: OpRow[]): void {
  // Failures first so the actionable rows are visible without scrolling.
  const sorted = [...rows].sort((a, b) => Number(a.ok) - Number(b.ok))
  opReport.value = { title, at: new Date().toLocaleTimeString(), rows: sorted }
}
/** Rows for an apply result: assignments × patched × skipped_public. */
function buildApplyReportRows(r: any): OpRow[] {
  const rows: OpRow[] = []
  const patchByCode = new Map((r.patched || []).map((p: any) => [p.episode_code, p]))
  for (const a of (r.assignments || [])) {
    const when = new Date(a.publishAt).toLocaleString()
    const p: any = patchByCode.get(a.episode_code)
    if (p && p.ok === false) {
      rows.push({
        episode_code: a.episode_code, ok: false,
        action: 'YouTube update failed',
        detail: `${p.error || 'unknown error'} — wanted ${when}`,
        retry: 'patch', publish_at: a.publishAt,
      })
    } else if (p) {
      rows.push({ episode_code: a.episode_code, ok: true, action: 'Scheduled on YouTube', detail: when })
    } else {
      rows.push({ episode_code: a.episode_code, ok: true, action: 'Scheduled locally', detail: `${when} — applies when uploaded` })
    }
  }
  for (const s of (r.skipped_public || [])) {
    const code = typeof s === 'string' ? s : s?.episode_code
    if (code) rows.push({ episode_code: code, ok: true, action: 'Skipped', detail: 'Already public — left untouched' })
  }
  return rows
}
async function retryOpRow(row: OpRow): Promise<void> {
  if (row.busy || !row.retry) return
  row.busy = true
  try {
    if (row.retry === 'patch' && row.publish_at) {
      const r = await editSchedule(row.episode_code, row.publish_at)
      if (r.patched) {
        row.ok = true; row.action = 'Scheduled on YouTube'
        row.detail = new Date(row.publish_at).toLocaleString(); row.retry = undefined
      } else {
        row.detail = `${r.patch_error || 'YouTube update failed again'} — wanted ${new Date(row.publish_at).toLocaleString()}`
      }
    } else if (row.retry === 'upload') {
      await triggerUpload({ episode_id: row.episode_code, platform: 'youtube', privacy_status: 'private' })
      row.ok = true; row.action = 'Upload queued'
      row.detail = 'YouTube publishes it at the scheduled time'; row.retry = undefined
    }
    await loadQueue('youtube')
  } catch (e: any) {
    row.detail = e?.data?.detail || e?.message || 'Retry failed'
    if (isYtAuthError(e)) ytAuthBroken.value = true
  } finally {
    row.busy = false
  }
}

/**
 * v1.0.500 — human-readable note for per-item YouTube patch failures.
 * The apply endpoint returns the REAL failure reason per episode in
 * `patched[].error`, but the toasts used to collapse them into an opaque
 * "N patch failure(s)" — the user's "silent error with no reason". Surface
 * the first couple of reasons inline (episode: reason) + an overflow count.
 */
function patchFailureNote(patched: any[]): string {
  const fails = (patched || []).filter((p: any) => p && p.ok === false)
  if (!fails.length) return ''
  const preview = fails.slice(0, 2)
    .map((p: any) => `${p.episode_code}: ${p.error || 'unknown error'}`)
    .join('; ')
  const overflow = fails.length > 2 ? `; +${fails.length - 2} more` : ''
  return `${fails.length} YouTube update failure(s) — ${preview}${overflow}`
}

async function doApplyPlan(plan: any, episode_codes: string[]) {
  if (!episode_codes.length) {
    showError('No episodes in the chosen scope. Pick a different scope or assemble more videos first.')
    return
  }
  applying.value = true
  scopeBusyPlanId.value = plan.id
  try {
    const r = await applyPlan(plan.id, episode_codes)
    const patchedOk = r.patched.filter((p: any) => p.ok).length
    const failNote = patchFailureNote(r.patched)
    const skippedPublic = r.skipped_public?.length || 0
    const msg = [
      `${r.assignments.length - skippedPublic} items scheduled`,
      patchedOk ? `${patchedOk} live video(s) patched` : '',
      failNote,
      skippedPublic ? `${skippedPublic} public video(s) skipped` : '',
    ].filter(Boolean).join(' · ')
    // Partial failures surface as an error toast (with the reasons), not a
    // green success that buries them.
    if (failNote) showError(msg)
    else success(msg)
    // v1.0.501 — persistent per-episode receipt (with retry on failures).
    openOpReport(`Applied "${plan.name}" to ${episode_codes.length} episode(s)`, buildApplyReportRows(r))
    await loadQueue('youtube')
  } catch (e: any) {
    noteYtError(e, 'Failed to apply plan')
  } finally {
    applying.value = false
    scopeBusyPlanId.value = ''
  }
}

/**
 * Apply the plan AND fan out an upload for every not-yet-uploaded
 * episode in it, each carrying its planned publishAt. After this
 * single click, every queued video is on YouTube as private+publishAt
 * and YouTube handles the publish moment server-side — Story Studio
 * doesn't need to be running. The user's stated misconception was
 * that scheduling is "internal" and requires the app on; this surface
 * makes the YouTube-native flow a one-click action.
 *
 * Sequencing:
 *   1. applyPlan() — same as the Apply button. Writes the per-item
 *      schedule map server-side and PATCHes already-uploaded videos
 *      with their new publishAt.
 *   2. Compute notYetUploaded by subtracting the patched.episode_code
 *      set from assignments. Patched = already on YouTube; everything
 *      else needs an upload.
 *   3. Skip episodes that don't pass hasFinalVideoFast (shouldn't
 *      happen if the plan was built from queueItems, but guards
 *      against stale state on the frontend).
 *   4. Cost confirm via the existing dialog so the user sees
 *      N × 1600 = M YouTube quota units before fan-out.
 *   5. Fire triggerUpload() per item sequentially. Backend reads the
 *      per-item publishAt from the schedule map we wrote in step 1
 *      (upload.ts:606-608), so each upload includes its scheduled
 *      time without us re-passing it.
 *   6. Summary toast counts succeeded vs failed. Common failure mode
 *      is 429 quota exceeded mid-batch; uploads that DID succeed
 *      stay queued, so the user keeps the work they paid for.
 */
/**
 * Item H — Upload-only path. Skips the apply step entirely; just fans
 * out triggerUpload for each episode_code. Right verb when the schedule
 * was applied earlier (or doesn't matter — private-mode uploads don't
 * carry a publishAt anyway) and the user just wants to push the actual
 * video files now. The combo "🚀 Apply + Upload" verb is the path that
 * does both in one click.
 */
async function doUploadOnly(plan: any, episode_codes: string[]) {
  if (!episode_codes.length) {
    showError('No episodes in the chosen scope.')
    return
  }
  applyAndUploading.value = true
  scopeBusyPlanId.value = plan.id
  try {
    // Filter to episodes with a local final on disk — the queue pipes
    // can include "uploaded·local freed" rows whose video file is gone,
    // and triggerUpload would fail loudly on those.
    const codeToItem = new Map(queueItems.value.map((i: any) => [i.episode_code, i]))
    const ready = episode_codes.filter(code => {
      const item = codeToItem.get(code) as any
      return item && item.has_local_final && !item.uploaded
    })
    const skipped = episode_codes.length - ready.length

    if (ready.length === 0) {
      success(`Nothing to upload — ${skipped ? `${skipped} skipped (already uploaded or no local final)` : '0 episodes'}.`)
      return
    }

    const ok = await confirmGeneration(slug.value, 'youtube_upload', { count: ready.length })
    if (!ok) {
      success(`Upload cancelled (${ready.length} episode(s) ready).`)
      return
    }

    let uploaded = 0
    let failed = 0
    const failures: string[] = []
    for (const code of ready) {
      try {
        await triggerUpload({ episode_id: code, platform: 'youtube', privacy_status: 'private' })
        uploaded++
      } catch (e: any) {
        failed++
        failures.push(`${code}: ${e?.data?.detail || e?.message || 'unknown error'}`)
      }
    }

    const summary = [
      uploaded ? `☁️ Queued ${uploaded} upload(s)` : '',
      failed ? `⚠ ${failed} failed` : '',
      skipped ? `${skipped} skipped` : '',
    ].filter(Boolean).join(' · ')
    if (failed > 0) {
      const preview = failures.slice(0, 3).join('; ')
      const overflow = failed > 3 ? `; +${failed - 3} more` : ''
      showError(`${summary} — ${preview}${overflow}`)
    } else {
      success(summary)
    }
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Upload failed')
  } finally {
    applyAndUploading.value = false
    scopeBusyPlanId.value = ''
  }
}

async function doApplyAndUpload(plan: any, episode_codes: string[]) {
  if (!episode_codes.length) {
    showError('No episodes in the chosen scope. Pick a different scope or assemble more videos first.')
    return
  }
  applyAndUploading.value = true
  scopeBusyPlanId.value = plan.id
  try {
    // Step 1 — apply schedule + PATCH already-uploaded.
    const r = await applyPlan(plan.id, episode_codes)
    const patchedOk = r.patched.filter((p: any) => p.ok).length
    const failNote = patchFailureNote(r.patched)
    const skippedPublic = r.skipped_public?.length || 0

    // Step 2 — derive the set that needs a fresh upload.
    const patchedSet = new Set(r.patched.map((p: any) => p.episode_code))
    const notYetUploaded = r.assignments.filter((a: any) => !patchedSet.has(a.episode_code))

    // Step 3 — guardrail: only upload episodes that have a final on
    // disk. queueItems already filters to publishable rows.
    const codeToItem = new Map(queueItems.value.map((i: any) => [i.episode_code, i]))
    const ready = notYetUploaded.filter((a: any) => codeToItem.has(a.episode_code))
    const skippedRows = notYetUploaded.filter((a: any) => !codeToItem.has(a.episode_code))
    const skipped = skippedRows.length
    // v1.0.501 — merged per-episode receipt built as the run progresses.
    const reportRows = buildApplyReportRows(r)
    const reportByCode = new Map(reportRows.map(x => [x.episode_code, x]))
    for (const a of skippedRows) {
      const row = reportByCode.get(a.episode_code)
      if (row) { row.ok = false; row.action = 'Skipped'; row.detail = 'No final video on disk — assemble it first' }
    }

    if (ready.length === 0) {
      // Nothing to fan out — surface what just happened so the toast
      // doesn't go silent after a click.
      const parts = [
        `${r.assignments.length - skippedPublic} item(s) scheduled`,
        patchedOk ? `${patchedOk} live video(s) patched` : '',
        failNote,
        skipped ? `${skipped} skipped (no final video on disk)` : '',
        skippedPublic ? `${skippedPublic} public video(s) skipped` : '',
      ].filter(Boolean)
      if (failNote) showError(parts.join(' · '))
      else success(parts.join(' · '))
      openOpReport(`Applied "${plan.name}" — nothing needed uploading`, reportRows)
      await loadQueue('youtube')
      return
    }

    // Step 4 — pre-flight cost confirm. The shared cost dialog gates
    // every cost-incurring action; passing count=N drives the
    // bulk-total figure inside it.
    const ok = await confirmGeneration(slug.value, 'youtube_upload', {
      count: ready.length,
    })
    if (!ok) {
      // Schedule was already applied (PATCHes happened) — surface
      // what's on YouTube even though the user cancelled the bulk
      // upload step.
      const parts = [
        `${r.assignments.length - skippedPublic} item(s) scheduled`,
        patchedOk ? `${patchedOk} live video(s) patched` : '',
        failNote,
        skippedPublic ? `${skippedPublic} public video(s) skipped` : '',
      ].filter(Boolean)
      if (failNote) showError(`${parts.join(' · ')} · upload step cancelled`)
      else success(`${parts.join(' · ')} · upload step cancelled`)
      openOpReport(`Applied "${plan.name}" — upload step cancelled`, reportRows)
      await loadQueue('youtube')
      return
    }

    // Step 5 — fan out uploads sequentially. The job queue is FIFO
    // per-type so even if we awaited concurrently they'd serialise;
    // sequential await keeps the toast count accurate.
    let uploaded = 0
    let failed = 0
    const failures: string[] = []
    for (const a of ready) {
      const row = reportByCode.get(a.episode_code)
      try {
        await triggerUpload({
          episode_id: a.episode_code,
          platform: 'youtube',
          privacy_status: 'private',
        })
        uploaded++
        if (row) {
          row.ok = true
          row.action = 'Scheduled + upload queued'
          row.detail = `${new Date(a.publishAt).toLocaleString()} — YouTube publishes it automatically`
          row.retry = undefined
        }
      } catch (e: any) {
        failed++
        const detail = e?.data?.detail || e?.message || 'unknown error'
        failures.push(`${a.episode_code}: ${detail}`)
        if (row) { row.ok = false; row.action = 'Upload failed'; row.detail = detail; row.retry = 'upload' }
        if (isYtAuthError(e)) ytAuthBroken.value = true
      }
    }

    // Step 6 — summary toast.
    const summaryParts = [
      `📅 Scheduled ${r.assignments.length}`,
      patchedOk ? `↻ Patched ${patchedOk}` : '',
      failNote,
      uploaded ? `☁️ Queued ${uploaded} upload(s) — YouTube will publish at scheduled time` : '',
      failed ? `⚠ ${failed} failed` : '',
      skipped ? `${skipped} skipped` : '',
    ].filter(Boolean).join(' · ')
    if (failed > 0) {
      // Show the first few failures inline so the user knows what to
      // retry, plus a summary if there are more.
      const preview = failures.slice(0, 3).join('; ')
      const overflow = failed > 3 ? `; +${failed - 3} more` : ''
      showError(`${summaryParts} — ${preview}${overflow}`)
    } else if (failNote) {
      showError(summaryParts)
    } else {
      success(summaryParts)
    }
    openOpReport(`Applied + uploaded "${plan.name}" (${episode_codes.length} episode(s))`, reportRows)
    await loadQueue('youtube')
  } catch (e: any) {
    // applyPlan failure (most likely past-slot validation) — abort
    // before any uploads. The detail message from the backend is
    // already actionable ("Edit the plan's start_date to today or later").
    noteYtError(e, 'Failed to apply plan')
  } finally {
    applyAndUploading.value = false
    scopeBusyPlanId.value = ''
  }
}

// Per-row playlist override (A5). Keyed by episode_code; '_none_' sentinel
// overrides the project default to "don't add to any playlist"; empty
// string = fall through to project default.
const playlistOverrides = reactive<Record<string, string>>({})

// ── Per-row action gating ──────────────────────────────────────────────
// Each of the three action buttons is enabled only for rows where the
// underlying YouTube call would actually do something. Quota check is
// only applied to fresh uploads (1600 units each) — metadata + playlist
// are 50 units, well within any reasonable quota cushion.
const { confirmGeneration } = useConfirmation()

// Per-row busy state, keyed by row id with the action that's in flight.
// Lets each button render its own spinner without a shared "uploading"
// flag (which previously made all three light up together).
const rowBusy = reactive<Record<string, 'upload' | 'metadata' | 'playlist' | null>>({})

function isRowBusy(item: any): boolean {
  return !!rowBusy[item.id]
}
function quotaBlocksFreshUpload(): boolean {
  return !!(quota.value && (quota.value as any).used >= (quota.value as any).block_at)
}
function effectivePlaylistFor(item: any): string {
  const override = playlistOverrides[item.episode_code]
  if (override === '_none_') return ''
  if (override) return override
  return defaultPlaylistId.value || ''
}

function canUploadRow(item: any): boolean {
  if (isRowBusy(item)) return false
  if (item.uploaded) return false
  if (quotaBlocksFreshUpload()) return false
  return true
}
function canUpdateMetadataRow(item: any): boolean {
  if (isRowBusy(item)) return false
  return !!item.uploaded
}
function canUpdatePlaylistRow(item: any): boolean {
  if (isRowBusy(item)) return false
  if (!item.uploaded) return false
  return !!effectivePlaylistFor(item)
}

function uploadButtonTitle(item: any): string {
  if (item.uploaded) return 'Already uploaded — use ↻ Update YouTube to push the final title, description, and tags, or ♫ Playlist to add it to a playlist.'
  if (quotaBlocksFreshUpload()) {
    const q = quota.value as any
    return `YouTube API quota nearly exhausted (${q.used}/${q.ceiling}). Wait for midnight Pacific reset, or request higher quota in Google Cloud.`
  }
  return 'Uploads as private with publishAt from the active plan (if any). Use the Plans tab to schedule across the full queue.'
}
function metadataButtonTitle(item: any): string {
  if (!item.uploaded) return 'Only available after the video is uploaded — Metadata updates push title/description/tags via videos.update without re-uploading the file.'
  return 'Pushes title / description / tags / thumbnail to YouTube via the videos.update API. Privacy + schedule on the existing video are preserved.'
}
function playlistButtonTitle(item: any): string {
  if (!item.uploaded) return 'Only available after the video is uploaded — Playlist adds the existing video to your project default (or row override) playlist.'
  if (!effectivePlaylistFor(item)) return 'No target playlist. Set a project default in the Playlists tab, or pick a row-level override in the ⋯ menu.'
  return 'Adds the video to its target playlist. Add-only — never removes from playlists you set up manually in YouTube Studio.'
}

async function doUpload(item: any) {
  if (!canUploadRow(item)) return
  // v1.0.41 — open the pre-upload preview instead of going straight
  // to the cost-confirm dialog. The preview surfaces title /
  // description / tags / thumbnail (the bits that aren't visible from
  // the queue row) AND the quota cost. Cost-confirm becomes redundant
  // since the modal lists the quota explicitly. Bulk paths
  // (doUploadOnly, scope-picker actions) skip this — they're
  // explicitly "trust the plan, just go".
  await openUploadPreview(item)
}

// ── Pre-upload preview modal (v1.0.41) ───────────────────────────────────
interface UploadPreviewData {
  episode_code: string
  title: string
  description: string
  tags: string[]
  thumbnail_filename: string
  thumbnail_pinned: boolean
  thumbnail_path: string
  thumbnail_options: Array<{ filename: string; path: string; is_pinned: boolean }>
  already_uploaded: boolean
  video_id: string
  privacy_status: string
  scheduled_for: string | null
  estimated_quota: number
}
const uploadPreview = reactive<{
  open: boolean
  busy: boolean
  loading: boolean
  data: UploadPreviewData | null
  item: any | null
  thumbExpanded: boolean
  descExpanded: boolean
  selectedThumbnailFilename: string
  error: string
}>({
  open: false,
  busy: false,
  loading: false,
  data: null,
  item: null,
  thumbExpanded: false,
  descExpanded: false,
  selectedThumbnailFilename: '',
  error: '',
})

const uploadPreviewThumbUrl = computed(() => {
  const selected = uploadPreview.data?.thumbnail_options?.find(
    option => option.filename === uploadPreview.selectedThumbnailFilename,
  )
  const selectedPath = selected?.path || uploadPreview.data?.thumbnail_path
  return selectedPath ? uploadPreviewThumbnailUrl(selectedPath) : ''
})

// v1.2.9 — per-visit cache key. Thumbnails are regenerated in place on the
// Thumbnail Generator, so the path alone never changes; without this, coming
// back to Upload after a re-render shows the OLD artwork, because an
// unchanged src is served from the browser's in-memory image cache without
// any request reaching the server (its `no-cache` header and ETag cannot help
// a request that is never made). Nothing rewrites images while this page is
// mounted, so a value fixed at mount is enough — and it keeps the images
// cached for the life of the visit instead of re-reading them per render.
const previewCacheKey = Date.now()

function uploadPreviewThumbnailUrl(filePath: string): string {
  return `/api/projects/${slug.value}/video-editor/preview-image?path=${encodeURIComponent(filePath)}&k=${previewCacheKey}`
}

function selectUploadPreviewThumbnail(filename: string): void {
  uploadPreview.selectedThumbnailFilename = filename
  uploadPreview.thumbExpanded = false
}

async function openUploadPreview(item: any) {
  uploadPreview.item = item
  uploadPreview.loading = true
  uploadPreview.error = ''
  uploadPreview.thumbExpanded = false
  uploadPreview.descExpanded = false
  uploadPreview.selectedThumbnailFilename = ''
  uploadPreview.data = null
  uploadPreview.open = true
  try {
    // upload.vue doesn't destructure `get` at the top of <script setup>
    // — every other handler does an inline `const { get: apiGet } =
    // useApi()`. v1.0.41 missed that pattern here and shipped the bare
    // `get` reference, which threw "get is not defined" at runtime
    // when the user clicked Upload (caught in v1.0.43 beta).
    const { get: apiGet } = useApi()
    uploadPreview.data = await apiGet<UploadPreviewData>(
      `/projects/${slug.value}/upload/queue/${encodeURIComponent(item.episode_code)}/preview?platform=youtube`,
    )
    uploadPreview.selectedThumbnailFilename = uploadPreview.data.thumbnail_filename
      || uploadPreview.data.thumbnail_options?.[0]?.filename
      || ''
  } catch (e: any) {
    uploadPreview.error = e?.data?.detail || e?.message || 'Failed to load preview'
  } finally {
    uploadPreview.loading = false
  }
}

function closeUploadPreview() {
  if (uploadPreview.busy) return
  uploadPreview.open = false
  uploadPreview.data = null
  uploadPreview.item = null
  uploadPreview.selectedThumbnailFilename = ''
}

async function confirmUploadPreview() {
  if (uploadPreview.busy || !uploadPreview.data || !uploadPreview.item) return
  const item = uploadPreview.item
  const isUpdateOnly = uploadPreview.data.already_uploaded
  uploadPreview.busy = true
  rowBusy[item.id] = isUpdateOnly ? 'metadata' : 'upload'
  try {
    if (isUpdateOnly) {
      await triggerMetadataUpdate({
        episode_id: item.episode_code,
        platform: 'youtube',
        thumbnail_filename: uploadPreview.selectedThumbnailFilename || undefined,
      })
      success(`Metadata update queued for ${item.episode_code} — privacy + schedule will stay as they are on YouTube.`)
    } else {
      await triggerUpload({
        episode_id: item.episode_code,
        platform: 'youtube',
        privacy_status: 'private',
        playlist_id: playlistOverrides[item.episode_code] ?? null,
        thumbnail_filename: uploadPreview.selectedThumbnailFilename || undefined,
      })
      success(`Upload job queued for ${item.episode_code}. Watch progress in the Jobs tab.`)
    }
    uploadPreview.open = false
    uploadPreview.data = null
    uploadPreview.item = null
    uploadPreview.selectedThumbnailFilename = ''
    setTimeout(() => { loadQueue('youtube'); loadQuota() }, 2000)
  } catch (e: any) {
    uploadPreview.error = e?.data?.detail || e?.message || 'Failed to queue upload'
  } finally {
    uploadPreview.busy = false
    rowBusy[item.id] = null
  }
}

async function doUpdateMetadata(item: any) {
  if (!canUpdateMetadataRow(item)) return
  // v1.0.59 — open the upload-preview modal first so the user sees
  // the title / description / tags / thumbnail that's about to be
  // PATCHed onto the live YouTube video. The modal auto-detects this
  // is a metadata-only update via `data.already_uploaded` and flips
  // its header, body copy, and confirm-button label to match
  // ("↻ Update metadata preview" → "↻ Confirm metadata update").
  // confirmUploadPreview() then routes to triggerMetadataUpdate(),
  // mirroring what the cost-confirm shortcut path used to do — but
  // with a real diff in front of it. Cost-confirm becomes redundant
  // because the modal already prints "~50 quota units" inline.
  await openUploadPreview(item)
}

async function doUpdatePlaylist(item: any) {
  if (!canUpdatePlaylistRow(item)) return
  const ok = await confirmGeneration(slug.value, 'youtube_playlist_update', {
    episode_id: item.episode_code,
    count: 1,
  })
  if (!ok) return
  rowBusy[item.id] = 'playlist'
  try {
    await triggerPlaylistUpdate({
      episode_id: item.episode_code,
      platform: 'youtube',
      playlist_id: playlistOverrides[item.episode_code] ?? null,
    })
    success(`Playlist update queued for ${item.episode_code}.`)
    setTimeout(() => { loadQueue('youtube'); loadQuota() }, 2000)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue playlist update')
  } finally {
    rowBusy[item.id] = null
  }
}

// ── Bulk-select state + handlers ───────────────────────────────────────
// Selection lives in a Set keyed by episode_code so it survives queue
// pagination + filter changes (the same pattern as the Pipeline page).
// Imports (non-episode rows) aren't selectable — bulk operations only
// make sense on accepted-idea rows that route through our generators.
const selectedQueueIds = reactive(new Set<string>())

function toggleQueueSelect(episodeCode: string) {
  if (selectedQueueIds.has(episodeCode)) selectedQueueIds.delete(episodeCode)
  else selectedQueueIds.add(episodeCode)
}

const episodeRowsOnPage = computed(() =>
  queueItems.value.filter((i: any) => i.type === 'episode'),
)
const allEpisodesOnPageSelected = computed(() =>
  episodeRowsOnPage.value.length > 0 &&
  episodeRowsOnPage.value.every((i: any) => selectedQueueIds.has(i.episode_code)),
)
const someEpisodesOnPageSelected = computed(() =>
  episodeRowsOnPage.value.some((i: any) => selectedQueueIds.has(i.episode_code)),
)

function toggleAllOnPage() {
  if (allEpisodesOnPageSelected.value) {
    for (const i of episodeRowsOnPage.value) selectedQueueIds.delete(i.episode_code)
  } else {
    for (const i of episodeRowsOnPage.value) selectedQueueIds.add(i.episode_code)
  }
}

// Item 10 — "View selected" mode pulls the entire selection into a single
// enriched page so metadata/thumbnail badges are visible for off-page
// rows too. Backed by the new ?episode_codes= query param on /upload/queue.
// `viewingSelectedOnly` is true while the view is active so the bulk bar
// can swap "View selected" for a "↺ Show all" toggle.
const viewingSelectedOnly = ref(false)
async function enterViewSelected() {
  if (selectedQueueIds.size === 0) return
  viewingSelectedOnly.value = true
  // Bump page size up so all selections fit on one page when reasonable.
  // The backend caps at 100 anyway.
  const targetSize = Math.max(queuePageSize.value, Math.min(100, selectedQueueIds.size))
  if (targetSize !== queuePageSize.value) queuePageSize.value = targetSize as 10 | 20 | 50 | 100
  await loadQueue({
    page: 1,
    pageSize: targetSize,
    nocache: false,
    episodeCodes: Array.from(selectedQueueIds),
  })
  queuePage.value = 1
}
function exitViewSelected() {
  if (!viewingSelectedOnly.value) return
  viewingSelectedOnly.value = false
  // Reload without the codes filter — back to normal paginated view.
  loadQueue({ page: 1, episodeCodes: null })
  queuePage.value = 1
}

// ── Plan scope picker ──────────────────────────────────────────────────
// Each plan row's Apply / Upload / Unapply button opens this picker so the
// verb runs against an explicit scope (Selection / All unuploaded / Next 5
// / This page) rather than implicitly the visible page only. `allUnuploadedCodes`
// is fetched lazily via the lightweight ids_only=1 endpoint when the picker
// opens — avoids paying enrichment cost just to count.
const NEXT_BATCH_SIZE = 5
// Item H — four verbs:
//   apply        — write schedule map + PATCH already-uploaded videos
//   upload       — fan out fresh uploads only (assumes schedule already applied)
//   apply_upload — combo: apply, then fan out uploads (the common case)
//   unapply      — clear schedule map entries for the chosen scope
type PlanVerb = 'apply' | 'upload' | 'apply_upload' | 'unapply'
interface ScopeOption {
  id: 'selection' | 'all_unuploaded' | 'next_n' | 'this_page'
  label: string
  count: number
  episodeCodes: string[]
  tooltip: string
}
interface ScopePreviewRow {
  episode_code: string
  slot_iso: string
  slot_label: string
  is_past: boolean
}
const scopePicker = reactive<{
  open: boolean
  plan: any | null
  verb: PlanVerb
  loading: boolean
  allUnuploadedCodes: string[]
  anchor: { left: number; top: number }
  // Item D — preview state. When `previewing` is set, the popover swaps
  // from the scope-list to the preview screen for that scope. `previewRows`
  // is the episode → computed slot mapping, derived from the same
  // computeSlots logic the backend uses (via /upload/plans/:id/preview),
  // so the preview is exact rather than approximate.
  previewing: ScopeOption | null
  previewLoading: boolean
  previewRows: ScopePreviewRow[]
  previewPastSlots: number
  /** v1.0.46 — count of target codes whose YouTube video is already
   *  public. Apply-plan skips these (Layer 2 server guard); preview
   *  surfaces the count up-front so the user knows N rows won't
   *  actually be touched before clicking Confirm. */
  previewPublicSkipCount: number
  previewLatestClaim: string | null
  previewError: string
}>({
  open: false,
  plan: null,
  verb: 'apply',
  loading: false,
  allUnuploadedCodes: [],
  anchor: { left: 0, top: 0 },
  previewing: null,
  previewLoading: false,
  previewRows: [],
  previewPastSlots: 0,
  previewPublicSkipCount: 0,
  previewLatestClaim: null,
  previewError: '',
})
const scopeBusyPlanId = ref('')

// ── Upload Plan modal (Queue-tab quick-apply) ──────────────────────────
// Lets the user run Apply / Upload / Unapply against the active plan
// without leaving the Queue tab. Defaults to the first active plan for
// YouTube (or the first plan period if none is active). The three verb
// buttons reuse openPlanScopePicker, so the popover anchors to whichever
// button was clicked inside the modal.
const uploadPlanModalOpen = ref(false)
const uploadPlanModalPlanId = ref('')

const activePlanIdsSet = computed(() => new Set(Object.values(activePlanMap.value || {}) as string[]))

const uploadPlanModalSelected = computed<any>(() => {
  if (!uploadPlanModalPlanId.value) return null
  return plans.value.find((p: any) => p.id === uploadPlanModalPlanId.value) || null
})

function openUploadPlanModal() {
  // Pick the most useful plan to start with: the active one for YouTube
  // if there is one; otherwise the first plan in the list.
  let initial = ''
  for (const [k, v] of Object.entries(activePlanMap.value || {})) {
    if (k.startsWith('youtube:') && typeof v === 'string') { initial = v; break }
  }
  if (!initial && plans.value.length) initial = plans.value[0].id
  uploadPlanModalPlanId.value = initial
  uploadPlanModalOpen.value = true
}
function closeUploadPlanModal() {
  uploadPlanModalOpen.value = false
}
function goToPlansTab() {
  activeTab.value = 'plans'
  closeUploadPlanModal()
}

const scopePopoverStyle = computed(() => ({
  left: `${scopePicker.anchor.left}px`,
  top: `${scopePicker.anchor.top}px`,
  // v1.0.526 — never let the popover run off the bottom of the screen. Cap it
  // to the space between its anchor and the viewport bottom; the inner list
  // scrolls within that so the preview rows + Back/Apply buttons stay reachable.
  maxHeight: `calc(100vh - ${scopePicker.anchor.top}px - 12px)`,
}))

/**
 * Cap "All unuploaded" / "Next N" counts at the remaining quota for the
 * Upload-firing verbs so the picker doesn't suggest more than YouTube
 * will let us push today. floor((block_at - used) / 1600) — same formula
 * the chip uses. Apply / Unapply are unaffected (no quota cost). Both
 * `upload` (Item H upload-only) and `apply_upload` (Item H combo) fan
 * out actual uploads, so both share the cap.
 */
function uploadCapForCodes(codes: string[]): string[] {
  if (scopePicker.verb !== 'upload' && scopePicker.verb !== 'apply_upload') return codes
  const q = quota.value
  if (!q) return codes
  const remaining = Math.max(0, q.block_at - q.used)
  const slots = Math.floor(remaining / 1600)
  return codes.slice(0, slots)
}

const scopeOptions = computed<ScopeOption[]>(() => {
  const verb = scopePicker.verb
  const allCodes = scopePicker.allUnuploadedCodes
  // For upload-firing verbs, restrict the Selection scope to codes that
  // are actually unuploaded — uploading an already-uploaded episode would
  // PATCH metadata only (likely not what the user meant when picking
  // Selection). For apply / unapply, include the user's literal pick.
  const isUploadFiring = verb === 'upload' || verb === 'apply_upload'
  const selCodes = Array.from(selectedQueueIds).filter(c => allCodes.includes(c) || !isUploadFiring)
  const pageCodes = episodeRowsOnPage.value.map((i: any) => i.episode_code as string)
  const nextCodes = allCodes.slice(0, NEXT_BATCH_SIZE)

  const wrap = (id: ScopeOption['id'], label: string, codes: string[], tooltip: string): ScopeOption => {
    const capped = uploadCapForCodes(codes)
    // v1.0.500 — assign schedule slots in EPISODE order, not click/upload
    // order. The Selection set iterates in check order (and "This page" in
    // list-sort order), so a later episode checked/uploaded first used to
    // grab the earlier slot. WHICH episodes are in scope is decided above
    // (quota cap included); the ORDER they map onto consecutive slots is
    // always natural episode-code order (numeric-aware: EP2 < EP10).
    const ordered = [...capped].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    const isUploadFiring = scopePicker.verb === 'upload' || scopePicker.verb === 'apply_upload'
    const cappedNote = isUploadFiring && capped.length < codes.length
      ? ` (${codes.length - capped.length} skipped to respect today’s quota)`
      : ''
    return {
      id,
      label,
      count: ordered.length,
      episodeCodes: ordered,
      tooltip: tooltip + cappedNote,
    }
  }

  // Item 9 — every scope counts EPISODES only. Imports (rows dropped
  // into the project-level Upload Queue/ folder) are second-class for
  // plan-driven actions: they have no episode_code so they can't ride
  // the schedule map, plan apply, or scope picker. To act on imports,
  // use the per-row Upload button OR select them and use the bulk bar
  // (which works on import ids). The tooltip below makes that explicit
  // so users don't waste time wondering why the "All" count excludes
  // their import rows.
  const importsNote = ' Imports are not included — manage them via the per-row Upload button or the selection bulk bar.'
  return [
    wrap('selection', 'Selection',
      selCodes,
      `Episodes you've checked in the Queue tab. Survives pagination.${importsNote}`),
    wrap('all_unuploaded', 'All unuploaded',
      allCodes,
      `Every episode that has a final video on disk and isn't uploaded yet, across all pages.${importsNote}`),
    wrap('next_n', `Next ${NEXT_BATCH_SIZE} from top`,
      nextCodes,
      `The first ${NEXT_BATCH_SIZE} unuploaded episodes in current sort order — quick batch.${importsNote}`),
    wrap('this_page', 'This page',
      pageCodes,
      `Only the episodes visible on the current page.${importsNote}`),
  ]
})

async function openPlanScopePicker(ev: MouseEvent, plan: any, verb: PlanVerb) {
  // Anchor the popover next to the click target. Prefer button's right edge;
  // clamp to keep it on-screen.
  const target = ev.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const popoverWidth = 260
  const left = Math.max(8, Math.min(window.innerWidth - popoverWidth - 8, rect.left))
  const top = rect.bottom + 6
  scopePicker.anchor = { left, top }
  scopePicker.plan = plan
  scopePicker.verb = verb
  scopePicker.open = true
  scopePicker.loading = true
  scopePicker.allUnuploadedCodes = []
  try {
    // Fetch full not_uploaded list once per open. Cheap thanks to ids_only.
    const r = await fetchQueueEpisodeCodes({ filter: 'not_uploaded' })
    scopePicker.allUnuploadedCodes = r.episode_codes || []
  } catch (e: any) {
    showError(e?.data?.detail || 'Could not load queue counts')
    scopePicker.open = false
  } finally {
    scopePicker.loading = false
  }
}

function resetScopePreview() {
  scopePicker.previewing = null
  scopePicker.previewLoading = false
  scopePicker.previewRows = []
  scopePicker.previewPastSlots = 0
  scopePicker.previewPublicSkipCount = 0
  scopePicker.previewLatestClaim = null
  scopePicker.previewError = ''
}

function closePlanScopePicker() {
  scopePicker.open = false
  scopePicker.plan = null
  resetScopePreview()
}

/**
 * Item D — when a scope is picked, advance to the preview screen for
 * Apply / Upload (so the user sees the exact episode → slot mapping
 * before any state writes / YouTube PATCHes). Unapply skips the preview
 * because its existing confirm dialog already lists episode codes.
 */
async function pickScope(opt: ScopeOption) {
  const plan = scopePicker.plan
  if (!plan || opt.count === 0) return
  if (scopePicker.verb === 'unapply') {
    // Unapply has its own confirm dialog — skip preview.
    runScopedAction(opt)
    return
  }
  scopePicker.previewing = opt
  scopePicker.previewLoading = true
  scopePicker.previewError = ''
  scopePicker.previewRows = []
  scopePicker.previewPastSlots = 0
  scopePicker.previewPublicSkipCount = 0
  scopePicker.previewLatestClaim = null
  try {
    // Pass `opt.episodeCodes` so the preview slots match the
    // continue-after-existing logic Apply uses. Without this, the
    // preview would show "TN0006 → May-4, TN0007 → May-6" while Apply
    // would actually resume past the latest existing scheduled
    // episode (e.g. May-18, May-20) — confusing.
    const r = await previewPlan(plan.id, opt.count, opt.episodeCodes)
    const slots = r.slots
    if (!slots || slots.length < opt.count) {
      // computeSlots can return fewer than `count` if the plan's
      // end_date truncates the slot stream — either from the plan
      // start_date OR (when continuing past existing schedules) from
      // the day after the latest existing scheduled time. Surface
      // both cases clearly so the user sees what would actually
      // happen.
      const fromLatest = r.latest_existing_claim
        ? ` after the latest existing scheduled time (${new Date(r.latest_existing_claim).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })})`
        : ''
      scopePicker.previewError =
        `Plan only produces ${slots?.length ?? 0} slot(s) for ${opt.count} episode(s)${fromLatest}. ` +
        `Extend the plan's end_date, increase slot density, or unschedule existing episodes first.`
    }
    const now = Date.now()
    const rows: ScopePreviewRow[] = []
    let past = 0
    const authoritativeAssignments = r.assignments.length
      ? r.assignments
      : opt.episodeCodes.map((episode_code, index) => ({ episode_code, publishAt: slots[index] || '' }))
    for (const assignment of authoritativeAssignments) {
      const code = assignment.episode_code
      const iso = assignment.publishAt
      if (!iso) {
        rows.push({ episode_code: code, slot_iso: '', slot_label: '— no slot —', is_past: false })
        continue
      }
      const isPast = new Date(iso).getTime() < now - 60_000
      if (isPast) past++
      rows.push({
        episode_code: code,
        slot_iso: iso,
        slot_label: new Date(iso).toLocaleString(undefined, {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        }),
        is_past: isPast,
      })
    }
    scopePicker.previewRows = rows
    scopePicker.previewPastSlots = past
    scopePicker.previewLatestClaim = r.latest_existing_claim
    // v1.0.46 — bring through the count of target codes whose YouTube
    // video is already public. Apply will skip these per the Layer 2
    // guard; the warn line in the modal reads from this value.
    scopePicker.previewPublicSkipCount = r.public_skip_count
  } catch (e: any) {
    scopePicker.previewError = e?.data?.detail || e?.message || 'Could not compute slot mapping'
  } finally {
    scopePicker.previewLoading = false
  }
}

/** Item D — back to the scope list without committing. */
function cancelScopePreview() {
  resetScopePreview()
}

/** Item D — commit the previewed scope. Reuses the existing run path. */
function confirmScopePreview() {
  if (!scopePicker.previewing) return
  const opt = scopePicker.previewing
  // Don't reset state here; runScopedAction calls closePlanScopePicker which
  // resets via the closer, so order doesn't matter.
  runScopedAction(opt)
}

async function runScopedAction(opt: ScopeOption) {
  const plan = scopePicker.plan
  const verb = scopePicker.verb
  if (!plan || opt.count === 0) return
  closePlanScopePicker()
  try {
    if (verb === 'apply') {
      await doApplyPlan(plan, opt.episodeCodes)
    } else if (verb === 'upload') {
      // Item H — Upload-only path. doApplyAndUpload is now the explicit
      // combo verb (apply_upload below); this verb skips re-applying the
      // schedule and just fans out the actual upload jobs.
      await doUploadOnly(plan, opt.episodeCodes)
    } else if (verb === 'apply_upload') {
      // Item H — combo verb: write schedule, PATCH live videos, fan out
      // uploads for the not-yet-uploaded subset. The common case.
      await doApplyAndUpload(plan, opt.episodeCodes)
    } else {
      await doUnapplyPlan(plan, opt.episodeCodes)
    }
  } catch {
    /* the inner functions surface their own toasts */
  }
}

// Resolve the actual queue items for the selected codes — needed by
// the bulk-action gates below so we can ask "is the row uploaded yet?"
// per selection. Rows not visible on the current page (selected on a
// previous page, then paginated away) are skipped; bulk fires only on
// rows we can verify state for.
const selectedQueueRows = computed(() =>
  queueItems.value.filter((i: any) => i.type === 'episode' && selectedQueueIds.has(i.episode_code)),
)

const canBulkUpload = computed(() => {
  if (selectedQueueRows.value.length === 0) return false
  if (quotaBlocksFreshUpload()) return false
  // Bulk upload only valid when EVERY selected row is not-yet-uploaded.
  return selectedQueueRows.value.every((i: any) => !i.uploaded)
})
const canBulkMetadata = computed(() =>
  selectedQueueRows.value.length > 0 &&
  selectedQueueRows.value.every((i: any) => !!i.uploaded),
)
const canBulkPlaylist = computed(() =>
  selectedQueueRows.value.length > 0 &&
  selectedQueueRows.value.every((i: any) => i.uploaded && effectivePlaylistFor(i)),
)

const bulkUploadTitle = computed(() => {
  if (selectedQueueRows.value.length === 0) return 'Select rows first'
  if (quotaBlocksFreshUpload()) return 'YouTube quota near limit — bulk upload disabled'
  if (!canBulkUpload.value) return 'Some selected rows are already uploaded — bulk Upload only works on a selection of not-yet-uploaded rows'
  return `Upload ${selectedQueueRows.value.length} episode${selectedQueueRows.value.length === 1 ? '' : 's'} — each fires its own resumable upload job.`
})
const bulkMetadataTitle = computed(() => {
  if (!canBulkMetadata.value) return 'All selected rows must already be uploaded — bulk Metadata only patches existing YouTube videos'
  return `Update metadata on ${selectedQueueRows.value.length} uploaded video${selectedQueueRows.value.length === 1 ? '' : 's'}. Privacy + schedule preserved.`
})
const bulkPlaylistTitle = computed(() => {
  if (!canBulkPlaylist.value) return 'Each selected row must be uploaded AND have a target playlist (project default or row override)'
  return `Add ${selectedQueueRows.value.length} video${selectedQueueRows.value.length === 1 ? '' : 's'} to their target playlists. Idempotent — no removals.`
})

async function bulkRun(
  type: 'youtube_upload' | 'youtube_metadata_update' | 'youtube_playlist_update',
  rowsGetter: () => any[],
  perItem: (item: any) => Promise<unknown>,
  successPhrase: string,
) {
  const rows = rowsGetter()
  if (rows.length === 0) return
  const ok = await confirmGeneration(slug.value, type, {
    episode_ids: rows.map(r => r.episode_code),
    count: rows.length,
  })
  if (!ok) return
  let succeeded = 0
  let failed = 0
  for (const row of rows) {
    rowBusy[row.id] = type === 'youtube_upload' ? 'upload' : type === 'youtube_metadata_update' ? 'metadata' : 'playlist'
    try {
      await perItem(row)
      succeeded++
    } catch {
      failed++
    } finally {
      rowBusy[row.id] = null
    }
  }
  if (succeeded > 0) {
    const tail = failed > 0 ? ` (${failed} failed to queue)` : ''
    success(`${successPhrase} ${succeeded} episode${succeeded === 1 ? '' : 's'}${tail}.`)
  } else {
    showError(`Failed to queue ${type.replace('youtube_', '').replace('_', ' ')} for any of the ${rows.length} selected rows.`)
  }
  selectedQueueIds.clear()
  setTimeout(() => { loadQueue('youtube'); loadQuota() }, 2000)
}

function doBulkUpload() {
  return bulkRun(
    'youtube_upload',
    () => selectedQueueRows.value.filter((i: any) => !i.uploaded),
    (item) => triggerUpload({
      episode_id: item.episode_code,
      platform: 'youtube',
      privacy_status: 'private',
      playlist_id: playlistOverrides[item.episode_code] ?? null,
    }),
    'Queued upload for',
  )
}
function doBulkMetadata() {
  return bulkRun(
    'youtube_metadata_update',
    () => selectedQueueRows.value.filter((i: any) => !!i.uploaded),
    (item) => triggerMetadataUpdate({ episode_id: item.episode_code, platform: 'youtube' }),
    'Queued metadata update for',
  )
}
function doBulkPlaylist() {
  return bulkRun(
    'youtube_playlist_update',
    () => selectedQueueRows.value.filter((i: any) => i.uploaded && effectivePlaylistFor(i)),
    (item) => triggerPlaylistUpdate({
      episode_id: item.episode_code,
      platform: 'youtube',
      playlist_id: playlistOverrides[item.episode_code] ?? null,
    }),
    'Queued playlist update for',
  )
}
function formatScheduled(iso: string | null): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

/**
 * Richer schedule formatter for the queue's Scheduled cell.
 * Returns a two-line shape:
 *   "Sat, May 3"
 *   "8:00 AM · in 2 days"
 * The weekday + date helps the operator scan a column of uploads at a
 * glance (Tuesdays look different from Wednesdays). The relative
 * suffix calls out anything happening today / tomorrow / overdue,
 * which is otherwise easy to miss in an absolute timestamp.
 */
function formatScheduledRich(iso: string | null): { date: string; time: string; relative: string } {
  if (!iso) return { date: '—', time: '', relative: '' }
  try {
    const d = new Date(iso)
    const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    const diffMs = d.getTime() - Date.now()
    const diffDays = Math.round(diffMs / 86_400_000)
    let relative = ''
    if (diffMs < 0 && diffMs > -3_600_000) relative = 'just now'
    else if (diffMs < 0) relative = `${Math.abs(diffDays)}d overdue`
    else if (diffDays === 0) relative = 'today'
    else if (diffDays === 1) relative = 'tomorrow'
    else if (diffDays < 7) relative = `in ${diffDays}d`
    else if (diffDays < 60) relative = `in ${Math.round(diffDays / 7)}w`
    else relative = `in ${Math.round(diffDays / 30)}mo`
    return { date, time, relative }
  } catch {
    return { date: iso, time: '', relative: '' }
  }
}

/**
 * Privacy chip for the queue Status column. Returns label + tone class
 * so the same renderer covers fresh-upload (will be private) and
 * already-uploaded states. The point: the user wants to see at a
 * glance what privacy a row HAS or WILL HAVE on YouTube.
 */
function privacyChip(item: any): { label: string; tone: 'muted' | 'ok' | 'pending' } {
  if (!item.uploaded) {
    return { label: '🔒 Will upload as Private', tone: 'pending' }
  }
  const p = (item.privacy_status || '').toLowerCase()
  if (p === 'private') {
    // Uploaded private: if there's a publishAt, YouTube auto-publishes.
    return item.scheduled_for
      ? { label: '🔒 Private (auto-publishes)', tone: 'pending' }
      : { label: '🔒 Private', tone: 'muted' }
  }
  if (p === 'unlisted') return { label: '👁 Unlisted', tone: 'muted' }
  if (p === 'public')   return { label: '🌍 Public', tone: 'ok' }
  return { label: `· ${item.privacy_status || 'unknown'}`, tone: 'muted' }
}

/**
 * Playlist chip for the queue Metadata column. Resolves the per-row
 * effective playlist (override → project default → none) and looks
 * up the title from the loaded playlists list. Returns null when
 * no playlist applies, so the chip stays out of the DOM in that case.
 */
function playlistChipFor(item: any): { label: string; title: string } | null {
  if (item.type !== 'episode') return null
  const id = effectivePlaylistFor(item)
  if (!id) return null
  const pl = playlists.value.find((p: any) => p.id === id)
  const title = pl?.title || id
  // Truncate titles past ~18 chars so the "Playlist: " prefix has room
  // — total chip width stays compact alongside the other meta-pills.
  return {
    label: title.length > 18 ? title.slice(0, 17) + '…' : title,
    title: `Playlist: ${title}${pl ? '' : ' (id only — list still loading)'}`,
  }
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

// ── Per-item schedule edit (A2) ──────────────────────────────────────────
// Inline date/time picker: clicking the Scheduled cell on a row flips an
// inline editor on that row. No modal — quicker iteration on "move this
// one 3 hours later". On save we PATCH backend + refresh the queue so
// the column shows the new time immediately.
const editingScheduleFor = ref<string | null>(null)
const editingScheduleValue = ref<string>('')  // datetime-local string
function startEditSchedule(item: any) {
  if (uploadMode.value === 'private') return  // no-op in private mode
  editingScheduleFor.value = item.episode_code
  // Convert ISO → datetime-local (strip seconds + tz for <input type="datetime-local">)
  if (item.scheduled_for) {
    const d = new Date(item.scheduled_for)
    const tzOffsetMs = d.getTimezoneOffset() * 60_000
    editingScheduleValue.value = new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16)
  } else {
    // Default to tomorrow 18:00 local
    const d = new Date(Date.now() + 86_400_000)
    d.setHours(18, 0, 0, 0)
    const tzOffsetMs = d.getTimezoneOffset() * 60_000
    editingScheduleValue.value = new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16)
  }
}
async function saveEditSchedule(item: any) {
  if (!editingScheduleValue.value) return
  try {
    // datetime-local → ISO 8601 (assumes browser local timezone)
    const iso = new Date(editingScheduleValue.value).toISOString()
    const r = await editSchedule(item.episode_code, iso)
    editingScheduleFor.value = null
    if (r.patched) {
      success(`Rescheduled ${item.episode_code} → ${new Date(iso).toLocaleString()}. YouTube updated.`)
    } else if (r.patch_error) {
      showError(`Local schedule saved but YouTube update failed: ${r.patch_error}`)
    } else {
      success(`Scheduled ${item.episode_code} → ${new Date(iso).toLocaleString()}.`)
    }
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save schedule')
  }
}
function cancelEditSchedule() {
  editingScheduleFor.value = null
  editingScheduleValue.value = ''
}

const unschedulingFor = ref<string | null>(null)
async function doUnschedule(item: any, make: 'private' | 'public') {
  const ok = make === 'public' ? await ask({
    title: `Publish "${item.title}" immediately?`,
    message: 'This flips the video to PUBLIC right now on YouTube. The scheduled publish time is cleared.',
    confirmLabel: 'Publish now',
    danger: true,
  }) : await ask({
    title: `Clear schedule for "${item.title}"?`,
    message: 'Drops the publishAt; video stays private on YouTube so you can schedule it via YT Studio.',
    confirmLabel: 'Clear schedule',
  })
  if (!ok) return
  unschedulingFor.value = item.episode_code
  try {
    const r = await unschedule(item.episode_code, make)
    const msg = r.patched
      ? (make === 'public' ? `Published ${item.episode_code}.` : `Cleared schedule; ${item.episode_code} is private.`)
      : `Cleared local schedule for ${item.episode_code}${r.patch_error ? ` (YouTube update failed: ${r.patch_error})` : ''}`
    success(msg)
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Unschedule failed')
  } finally {
    unschedulingFor.value = null
  }
}

// ── Bulk clear + plan unapply (A3) ────────────────────────────────────────
// Stale-schedule detector: a row whose local sidecar still says
// `scheduled_for: <date>` even though YouTube has already flipped the video
// to public. The schedule is historical noise — YouTube auto-published the
// video at the original time and cleared its own publishAt; Story Studio
// just hasn't refreshed the sidecar yet (the ☁ Sync from YouTube button
// fixes it permanently). Used to suppress the bright date, the "auto-
// publishes at this time" badge, and the schedule-source pills, replacing
// them with a muted "ⓘ Was scheduled — already public" note.
function isStalePublicSchedule(item: any): boolean {
  return !!(item?.uploaded && item?.privacy_status === 'public' && item?.scheduled_for)
}

// Pre-enrich queue rows with derived render data so the template can read
// `item._sched.date` / `item._isStale` directly instead of calling
// `formatScheduledRich(item.scheduled_for)` four times per row and
// `isStalePublicSchedule(item)` three times. Naïvely, a 10-row queue page
// re-evaluated 70 cheap-but-not-free function calls per render; with this
// computed, each row's derived state is materialised once when queueItems
// changes and reused on every subsequent render until the next reload.
const displayedQueueItems = computed(() => {
  return queueItems.value.map((item: any) => ({
    ...item,
    _sched: formatScheduledRich(item.scheduled_for),
    _isStale: isStalePublicSchedule(item),
    // _privacy and _playlist are read multiple times per row (once for the
    // class binding, once for the label text, sometimes once more for a
    // tooltip). Materialise them once so the template's :class / {{ }} /
    // :title bindings are O(1) reads instead of re-running the function.
    _privacy: privacyChip(item),
    _playlist: playlistChipFor(item),
  }))
})

// ── Per-row schedule editor (📅 Edit popover) ──────────────────────────
const schedulePopoverItem = ref<any | null>(null)
const scheduleDraft = ref<string>('')   // datetime-local input value (no TZ)
const schedulePopoverBusy = ref<'apply' | 'clear' | 'publish' | null>(null)
const scheduleApplyError = ref<string>('')

// ISO → datetime-local string (`YYYY-MM-DDTHH:MM`) using the browser's
// local TZ, so the value renders in the user's wall-clock time.
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const scheduleMinLocal = computed(() => {
  // Five minutes from now — gives the user a tiny buffer so YouTube doesn't
  // reject the timestamp as in-the-past during the round-trip.
  const d = new Date(Date.now() + 5 * 60_000)
  return isoToLocalInput(d.toISOString())
})

function openSchedulePopover(item: any) {
  schedulePopoverItem.value = item
  scheduleDraft.value = isoToLocalInput(item.scheduled_for)
  scheduleApplyError.value = ''
}
function closeSchedulePopover() {
  if (schedulePopoverBusy.value) return  // don't close mid-API-call
  schedulePopoverItem.value = null
  scheduleDraft.value = ''
  scheduleApplyError.value = ''
}

async function doApplySchedule() {
  const item = schedulePopoverItem.value
  if (!item || !scheduleDraft.value) return
  // Convert the local datetime string back to an ISO instant. `new Date('YYYY-MM-DDTHH:MM')` interprets the string in the local TZ, then toISOString() emits UTC — which is what YouTube wants.
  const iso = new Date(scheduleDraft.value).toISOString()
  if (Date.parse(iso) < Date.now()) {
    scheduleApplyError.value = 'Pick a future time — past timestamps are rejected by YouTube.'
    return
  }
  schedulePopoverBusy.value = 'apply'
  scheduleApplyError.value = ''
  try {
    const r = await editSchedule(item.episode_code, iso)
    // v1.0.500 — a failed YouTube patch is an ERROR toast, not a green
    // success with the reason buried in parentheses.
    if (r.patched) {
      success(`Scheduled ${item.episode_code} for ${new Date(iso).toLocaleString()}.`)
    } else if (r.patch_error) {
      showError(`Local schedule saved for ${item.episode_code}, but the YouTube update failed: ${r.patch_error}`)
    } else {
      success(`Local schedule saved for ${item.episode_code} (applies at upload time).`)
    }
    closeSchedulePopoverForce()
    await loadQueue('youtube')
  } catch (e: any) {
    scheduleApplyError.value = e?.data?.detail || e?.message || 'Apply failed'
  } finally {
    schedulePopoverBusy.value = null
  }
}

async function doClearScheduleFromPopover() {
  const item = schedulePopoverItem.value
  if (!item) return
  schedulePopoverBusy.value = 'clear'
  try {
    const r = await unschedule(item.episode_code, 'private')
    if (r.patched) {
      success(`Cleared schedule; ${item.episode_code} is private on YouTube.`)
    } else if (r.patch_error) {
      showError(`Cleared local schedule for ${item.episode_code}, but the YouTube update failed: ${r.patch_error}`)
    } else {
      success(`Cleared local schedule for ${item.episode_code}.`)
    }
    closeSchedulePopoverForce()
    await loadQueue('youtube')
  } catch (e: any) {
    scheduleApplyError.value = e?.data?.detail || e?.message || 'Clear failed'
  } finally {
    schedulePopoverBusy.value = null
  }
}

async function doPublishNowFromPopover() {
  const item = schedulePopoverItem.value
  if (!item) return
  schedulePopoverBusy.value = 'publish'
  try {
    const r = await unschedule(item.episode_code, 'public')
    if (r.patched) {
      success(`Published ${item.episode_code}.`)
    } else if (r.patch_error) {
      showError(`Local schedule cleared, but the YouTube update failed: ${r.patch_error}`)
    } else {
      success('Local schedule cleared.')
    }
    closeSchedulePopoverForce()
    await loadQueue('youtube')
  } catch (e: any) {
    scheduleApplyError.value = e?.data?.detail || e?.message || 'Publish failed'
  } finally {
    schedulePopoverBusy.value = null
  }
}

// Close even when busy is still set — used after a successful API call.
function closeSchedulePopoverForce() {
  schedulePopoverBusy.value = null
  schedulePopoverItem.value = null
  scheduleDraft.value = ''
  scheduleApplyError.value = ''
}

const ytSyncing = ref(false)

// v1.0.524 — backfill thumbnails onto already-uploaded videos that are missing
// one (a dry-run previews the count; the run is a quota-paced, resumable job).
const thumbBackfilling = ref(false)
async function doBackfillThumbnails() {
  if (thumbBackfilling.value) return
  thumbBackfilling.value = true
  try {
    const { post } = useApi()
    const preview = await post<{ will_fix: number; no_image: number; total_uploaded: number }>(
      `/projects/${slug.value}/upload/refresh-thumbnails`, { mode: 'missing', dry_run: true },
    )
    if (!preview.will_fix) {
      success(preview.no_image
        ? `No thumbnails to backfill — ${preview.no_image} uploaded episode(s) have no thumbnail image on disk (make/pin one first).`
        : `All ${preview.total_uploaded} uploaded episode(s) already have their thumbnail. Nothing to do.`)
      return
    }
    const ok = await ask({
      title: 'Backfill thumbnails on YouTube?',
      message:
        `Will set thumbnails on ${preview.will_fix} already-uploaded video(s) that are missing one` +
        (preview.no_image ? ` (${preview.no_image} more have no image on disk — skipped).` : '.') +
        `\n\nThis pushes to the existing videos (no re-upload). It uses ~${preview.will_fix * 50} YouTube quota units; ` +
        `if that exceeds today's ~10,000 budget it stops and you re-run tomorrow to finish.`,
      confirmLabel: `Backfill ${preview.will_fix}`,
    })
    if (!ok) return
    await post(`/projects/${slug.value}/upload/refresh-thumbnails`, { mode: 'missing' })
    success(`Thumbnail backfill queued for ${preview.will_fix} video(s) — watch the Jobs panel for progress.`)
    loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start thumbnail backfill')
  } finally {
    thumbBackfilling.value = false
  }
}

/**
 * Item F — auto-fire sync-from-YouTube once per 24h per project on Queue
 * tab entry. Skips when:
 *   - the project has no uploaded sidecars (nothing to sync)
 *   - the last auto-sync was less than 24h ago
 *   - the user is currently running a manual sync
 *   - YouTube isn't connected for this project
 *
 * Cooldown lives in localStorage so it survives reloads but doesn't need
 * a backend round-trip. Manual "Sync from YouTube" button clicks (via
 * doSyncFromYoutube) also stamp the cooldown so we don't double-fire.
 */
const AUTO_SYNC_COOLDOWN_MS = 24 * 60 * 60 * 1000   // 24h
function autoSyncStorageKey() { return `upload:lastAutoSync:${slug.value}` }
function readLastAutoSync(): number {
  try { return Number(localStorage.getItem(autoSyncStorageKey()) || '0') || 0 }
  catch { return 0 }
}
function stampLastAutoSync() {
  try { localStorage.setItem(autoSyncStorageKey(), String(Date.now())) } catch { /* private mode etc. */ }
}
function autoSyncFromYoutubeIfStale() {
  if (ytSyncing.value) return
  if (!youtubeAccounts.value.length) return
  if (Date.now() - readLastAutoSync() < AUTO_SYNC_COOLDOWN_MS) return
  // The backend's sync-from-youtube short-circuits when there are no
  // sidecars to check ({ checked: 0, ... }), so we don't pre-filter on
  // queueItems — that filter is page-scoped and can hide uploaded rows
  // (e.g. when the user has only `ready,uploaded_local` chips on but
  // their queue is all `uploaded_freed`). Fire-and-forget; the silent
  // mode keeps no-ops from popping toasts.
  void doSyncFromYoutube({ silent: true })
}

async function doSyncFromYoutube(opts: { silent?: boolean } = {}) {
  // `silent` mode (used by the 24h auto-sync) suppresses no-op toasts
  // ("nothing to sync", "all up to date") so the auto path doesn't nag
  // the user every time they open the Queue tab. Drift updates and
  // tombstones still surface — those are the whole point.
  const silent = !!opts.silent
  ytSyncing.value = true
  try {
    const r = await syncQueueFromYoutube()
    stampLastAutoSync()   // also satisfies the cooldown for manual runs
    if (r.checked === 0) {
      if (!silent) success('No uploaded rows to sync.')
    } else if (r.updated === 0) {
      if (!silent) success(`Checked ${r.checked} row(s) — all up to date.`)
    } else {
      // Build a short human-readable diff list (capped at 3 entries) so the
      // toast tells the user *what* changed without dumping a wall of text.
      const sample = r.drift.slice(0, 3).map(d => {
        const before = d.before.privacy_status + (d.before.scheduled_for ? ` @ ${new Date(d.before.scheduled_for).toLocaleDateString()}` : '')
        const after = d.after.privacy_status + (d.after.scheduled_for ? ` @ ${new Date(d.after.scheduled_for).toLocaleDateString()}` : '')
        return `${d.episode_code}: ${before} → ${after}`
      })
      const more = r.drift.length > 3 ? ` (+${r.drift.length - 3} more)` : ''
      success(`Synced ${r.updated} of ${r.checked} row(s):\n${sample.join('\n')}${more}`)
    }
    if (r.errors?.length) {
      showError(`${r.errors.length} sidecar write(s) failed during sync — check server logs.`)
    }
    if (r.updated > 0 || (r.tombstoned && r.tombstoned.length > 0)) {
      await loadQueue({ nocache: true, page: queuePage.value })
    }
    // Surface tombstones found this run as a separate toast — these are the
    // user's "older private videos that got taken down" and they probably
    // want to know about them rather than have the row silently flip.
    if (r.tombstoned && r.tombstoned.length > 0) {
      const codes = r.tombstoned.map((t: any) => t.episode_code).slice(0, 5).join(', ')
      const more = r.tombstoned.length > 5 ? `, +${r.tombstoned.length - 5} more` : ''
      showError(`🪦 ${r.tombstoned.length} video(s) gone from YouTube and tombstoned: ${codes}${more}. Filter by "Deleted upstream" to review.`)
    }
  } catch (e: any) {
    // v1.0.501 — auth expiry raises the banner even on silent auto-sync
    // (it's the whole reason the sync failed); other errors keep the
    // silent-mode suppression.
    if (isYtAuthError(e)) ytAuthBroken.value = true
    else if (!silent) showError(e?.data?.detail || e?.message || 'Sync from YouTube failed')
  } finally {
    ytSyncing.value = false
  }
}

const bulkClearing = ref(false)
async function doBulkClear(syncYoutube: boolean) {
  const ok = await ask({
    title: 'Clear all scheduled upload times?',
    message: syncYoutube
      ? 'Removes every publishAt from the local queue AND PATCHes already-uploaded YouTube videos back to private (no scheduled publish). You can re-apply a plan or set times per-item afterward.'
      : 'Removes every publishAt from the local queue. YouTube videos keep their current live schedules — re-apply a plan or use per-row Publish-now / Clear to sync them.',
    confirmLabel: 'Clear all',
    danger: true,
  })
  if (!ok) return
  bulkClearing.value = true
  try {
    const r = await clearItemSchedule({ sync_youtube: syncYoutube })
    const parts = [`Cleared ${r.cleared} local schedule(s)`]
    if (syncYoutube) parts.push(`${r.patched} YouTube video(s) updated`)
    if (r.patch_errors?.length) parts.push(`${r.patch_errors.length} patch error(s)`)
    success(parts.join(' · '))
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Bulk clear failed')
  } finally {
    bulkClearing.value = false
  }
}

async function doResetUploadState(item: any) {
  // Phrasing differs based on whether this is a tombstone restore or a
  // fresh-cut wipe. The destructive consequences are different ("about to
  // re-upload" vs. "the video on YouTube is still there but we forget it"),
  // so the confirm dialog text matters.
  const isTombstone = !!item.deleted_at
  const ok = await ask({
    title: isTombstone
      ? `Forget link & re-upload ${item.episode_code}?`
      : `Forget link for ${item.episode_code}?`,
    message: isTombstone
      ? [
          `Removes the tombstone from ${item.episode_code}. The episode goes back to Ready, and the next bulk-upload will re-upload your local final video as a fresh YouTube video.`,
          '',
          'Pick this only if you DO want it back on YouTube — otherwise leave the tombstone in place.',
        ].join('\n')
      : [
          'Clears the local upload record so the next Upload creates a fresh video on your currently-connected YouTube channel.',
          '',
          `Current remote: ${item.video_url || '(no video_id)'} — this video is NOT deleted; remove it manually in YouTube Studio if it's on the wrong account.`,
          '',
          'Use this when you uploaded to the WRONG account by accident. If the video was taken down and you DON\'T want it back, use "🪦 Mark as deleted upstream" instead.',
        ].join('\n'),
    confirmLabel: isTombstone ? 'Forget & restore' : 'Forget link',
    danger: true,
  })
  if (!ok) return
  try {
    const r = await resetUploadState(item.episode_code)
    const parts = [`Reset ${item.episode_code}`]
    if (r.had_sidecar) parts.push(`prior video_id ${r.prior_video_id.slice(0, 11)}… was on account ${r.prior_account_id.slice(0, 8)}…`)
    success(parts.join(' · '))
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Reset failed')
  }
}

/**
 * Tombstone path — set deleted_at on the sidecar so the row stops pretending
 * to be a healthy upload, but the historical link is preserved. Right verb
 * when the video was taken down / removed and the user does NOT want
 * Story Studio to re-upload the local final.
 */
/**
 * Counterpart to doMarkDeletedUpstream — clears the tombstone without
 * touching the rest of the sidecar. The "Forget link" verb wipes the
 * whole sidecar, which is wrong when the user just wants to un-do an
 * accidental tombstone (or when sync-from-youtube tombstoned a row that
 * turned out to be fine after all).
 */
async function doUnmarkDeletedUpstream(item: any) {
  try {
    const r = await unmarkDeletedUpstream(item.episode_code)
    if (r.already_unmarked) {
      success(`${item.episode_code} wasn't tombstoned — no change.`)
    } else {
      success(`↩ Un-marked ${item.episode_code} — link preserved.`)
    }
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Un-mark failed')
  }
}

async function doMarkDeletedUpstream(item: any) {
  const ok = await ask({
    title: `Mark ${item.episode_code} as deleted upstream?`,
    message: [
      `Records that the YouTube video (${item.video_id || '?'}) is gone (takedown, deleted in YT Studio, or you no longer want it).`,
      '',
      'After this:',
      '• Bulk-upload skips this row by default — it won\'t be re-uploaded.',
      '• The historical link (video_id, account_id) is kept for audit.',
      '• Filter by "🪦 Deleted upstream" to review tombstoned rows later.',
      '',
      'If you change your mind later: open the row menu and pick "Forget link" — that wipes the tombstone and the next bulk-upload re-uploads from scratch.',
    ].join('\n'),
    confirmLabel: 'Mark as deleted',
    danger: true,
  })
  if (!ok) return
  try {
    const r = await markDeletedUpstream(item.episode_code)
    if (r.already_marked) {
      success(`${item.episode_code} was already marked deleted upstream — no change.`)
    } else {
      success(`🪦 ${item.episode_code} marked as deleted upstream.`)
    }
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Mark deleted failed')
  }
}

// ── Link existing YouTube video modal ──────────────────────────────────
// Per-row "I uploaded this manually elsewhere, link it" path. Reuses the
// orphan-list endpoint the Unlinked Uploads tab already calls, then ranks
// orphans by how well their YouTube title matches this episode's local
// title. Picking one calls adoptSingleOrphan with the episode_code, which
// writes the sidecar so Story Studio knows they're the same video.
const linkVideoModal = reactive<{
  open: boolean
  item: any | null
  searching: boolean
  search: string
  busyVideoId: string
}>({
  open: false,
  item: null,
  searching: false,
  search: '',
  busyVideoId: '',
})

function openLinkVideoModal(item: any) {
  linkVideoModal.item = item
  linkVideoModal.open = true
  linkVideoModal.search = ''
  linkVideoModal.busyVideoId = ''
  // Refresh orphans every open — channel state can change between visits
  // and a stale list would show false matches.
  linkVideoModal.searching = true
  loadOrphans().finally(() => { linkVideoModal.searching = false })
}
function closeLinkVideoModal() {
  linkVideoModal.open = false
  linkVideoModal.item = null
}

// ── Item E — "Mark uploaded elsewhere" modal state + handlers ─────────────
// `mode` distinguishes the two entry paths so the modal copy + the primary
// CTA wording match what the user is actually doing:
//   - 'mark' from the Missing Video tab (creates the legacy mark + optional
//     annotations in one step).
//   - 'edit' from clicking the 🔗 External pill on a row that has no URL
//     yet, or from a future edit affordance — lets the user fill in / fix
//     the URL or note, or unmark entirely.
const legacyEditModal = reactive<{
  open: boolean
  mode: 'mark' | 'edit'
  episodeCode: string
  title: string
  externalUrl: string
  note: string
  busy: boolean
  error: string
  /** Optional callback fired after the modal closes successfully. */
  onSaved: ((episodeCode: string) => void) | null
}>({
  open: false,
  mode: 'mark',
  episodeCode: '',
  title: '',
  externalUrl: '',
  note: '',
  busy: false,
  error: '',
  onSaved: null,
})

function openLegacyMarkModal(ep: { episode_code: string; title?: string }, onSaved?: (code: string) => void) {
  legacyEditModal.mode = 'mark'
  legacyEditModal.episodeCode = ep.episode_code
  legacyEditModal.title = ep.title || ep.episode_code
  legacyEditModal.externalUrl = ''
  legacyEditModal.note = ''
  legacyEditModal.busy = false
  legacyEditModal.error = ''
  legacyEditModal.onSaved = onSaved || null
  legacyEditModal.open = true
}

function openLegacyEditModal(item: any) {
  legacyEditModal.mode = 'edit'
  legacyEditModal.episodeCode = item.episode_code
  legacyEditModal.title = item.title || item._ideaTitle || item.episode_code
  legacyEditModal.externalUrl = item.legacy_external_url || ''
  legacyEditModal.note = item.legacy_note || ''
  legacyEditModal.busy = false
  legacyEditModal.error = ''
  legacyEditModal.onSaved = null
  legacyEditModal.open = true
}

function closeLegacyEditModal() {
  if (legacyEditModal.busy) return
  legacyEditModal.open = false
}

// Shared tooltip renderer — primary line is "Click pill to open URL" or
// the URL itself, secondary line is the note. Used by the row pill
// `:title` binding so the tooltip carries both pieces without needing a
// custom tooltip component.
function legacyExternalTooltip(item: any): string {
  const url = item.legacy_external_url || ''
  const note = item.legacy_note || ''
  const lines: string[] = []
  if (url) lines.push(url)
  else lines.push('No URL set — click to add one or unmark.')
  if (note) lines.push('— ' + note)
  lines.push('')
  lines.push('Marked as uploaded elsewhere — Story Studio leaves this episode alone.')
  return lines.join('\n')
}

async function saveLegacyEdit() {
  if (legacyEditModal.busy) return
  const url = legacyEditModal.externalUrl.trim()
  if (url && !/^https?:\/\//i.test(url)) {
    legacyEditModal.error = 'URL must start with http:// or https://'
    return
  }
  legacyEditModal.error = ''
  legacyEditModal.busy = true
  try {
    await markLegacyUploaded(legacyEditModal.episodeCode, true, {
      external_url: url,
      note: legacyEditModal.note.trim(),
    })
    success(`${legacyEditModal.episodeCode} ${legacyEditModal.mode === 'mark' ? 'marked as uploaded elsewhere' : 'updated'}`)
    const cb = legacyEditModal.onSaved
    const code = legacyEditModal.episodeCode
    legacyEditModal.open = false
    // Refresh queue + missing-video so the pill / list reflect the new state.
    await Promise.all([
      loadQueue({ nocache: true }).catch(() => {}),
      loadMissingVideoEpisodes().catch(() => {}),
    ])
    if (cb) cb(code)
  } catch (e: any) {
    legacyEditModal.error = e?.data?.detail || e?.message || 'Failed to save'
  } finally {
    legacyEditModal.busy = false
  }
}

async function unmarkFromLegacyEdit() {
  if (legacyEditModal.busy) return
  legacyEditModal.busy = true
  try {
    await markLegacyUploaded(legacyEditModal.episodeCode, false)
    success(`${legacyEditModal.episodeCode} unmarked — back in Missing Video`)
    legacyEditModal.open = false
    await Promise.all([
      loadQueue({ nocache: true }).catch(() => {}),
      loadMissingVideoEpisodes().catch(() => {}),
    ])
  } catch (e: any) {
    legacyEditModal.error = e?.data?.detail || e?.message || 'Failed to unmark'
  } finally {
    legacyEditModal.busy = false
  }
}

/**
 * Crude title-similarity score, 0..1. Tokenises both titles, lowercases,
 * strips non-alphanumerics, and returns Jaccard overlap on the token sets
 * minus a small length-difference penalty. Good enough to sort the obvious
 * matches to the top — perfect ranking would need the full description /
 * publish-date / duration which we don't have at this layer.
 */
function similarityScore(a: string, b: string): number {
  const tok = (s: string) => new Set(
    String(s || '').toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2),
  )
  const sa = tok(a), sb = tok(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  const jaccard = union > 0 ? inter / union : 0
  return jaccard
}

/**
 * For every Ready row in the visible queue, find the best-scoring orphan
 * (if score >= 0.5) so the row can show an inline "Looks like this is on
 * YouTube → Link" pill. Bridges the discoverability gap: today a user can
 * sit on the Queue tab forever wondering why their externally-uploaded
 * video shows as "Ready" — this surfaces the match in-place.
 *
 * Costs: O(rows * orphans). Page size <= 100, orphans typically <= a few
 * hundred; well under what a frame-budget runs on. Only computed when the
 * orphans list is loaded (the Queue tab eagerly loads orphans on entry,
 * but doesn't block the table on it).
 */
const ORPHAN_MATCH_THRESHOLD = 0.5
const orphanMatchByCode = computed<Record<string, { videoId: string; title: string; score: number }>>(() => {
  if (!orphans.value || orphans.value.length === 0) return {}
  const out: Record<string, { videoId: string; title: string; score: number }> = {}
  for (const item of (queueItems.value || [])) {
    if (item.type !== 'episode' || item.uploaded || item.deleted_at) continue
    let best: { videoId: string; title: string; score: number } | null = null
    for (const v of orphans.value) {
      const score = similarityScore(item.title || item._ideaTitle || item.episode_code, v.title || '')
      if (score >= ORPHAN_MATCH_THRESHOLD && (!best || score > best.score)) {
        best = { videoId: v.videoId, title: v.title || '', score }
      }
    }
    if (best) out[item.episode_code] = best
  }
  return out
})

const linkVideoCandidates = computed<Array<{ video: any; score: number }>>(() => {
  if (!linkVideoModal.item) return []
  const targetTitle = linkVideoModal.item.title || linkVideoModal.item._ideaTitle || linkVideoModal.item.episode_code
  const search = linkVideoModal.search.trim().toLowerCase()
  const ranked = (orphans.value || []).map((v: any) => ({
    video: v,
    score: similarityScore(targetTitle, v.title || ''),
  }))
  // If the user typed a search, filter by substring match on title or
  // videoId before ranking — they probably remember a fragment.
  const filtered = search
    ? ranked.filter(({ video }) => (video.title || '').toLowerCase().includes(search) || (video.videoId || '').toLowerCase().includes(search))
    : ranked
  filtered.sort((a, b) => b.score - a.score)
  return filtered.slice(0, 30)  // 30 candidates max — anything past that is noise
})

async function doLinkOrphan(video: any) {
  if (!linkVideoModal.item) return
  const code = linkVideoModal.item.episode_code
  linkVideoModal.busyVideoId = video.videoId
  try {
    // The Queue-tab path links to an EXISTING local episode (the row the
    // user clicked the kebab on). Use the sidecar-write endpoint, NOT
    // adoptSingleOrphan — that path creates a new idea + folder tree and
    // refuses when the episode_code is already in use, which is exactly
    // our case. Adoption is for the Unlinked Uploads tab where you import
    // a YouTube video as a brand-new local episode.
    const r = await linkExistingVideo(code, video)
    const replaced = r.replaced_prior ? ' (replaced prior link)' : ''
    success(`🔗 Linked ${code} → "${video.title?.slice(0, 60) || video.videoId}"${replaced}`)
    closeLinkVideoModal()
    await loadQueue({ nocache: true, page: queuePage.value })
  } catch (e: any) {
    showError(e?.data?.detail || 'Link failed')
  } finally {
    linkVideoModal.busyVideoId = ''
  }
}

async function doUnapplyPlan(plan: any, episode_codes: string[]) {
  if (!episode_codes.length) {
    showError('No episodes in the chosen scope.')
    return
  }
  const previewLine = episode_codes.length <= 6
    ? episode_codes.join(', ')
    : `${episode_codes.slice(0, 6).join(', ')}, +${episode_codes.length - 6} more`
  const ok = await ask({
    title: `Unapply "${plan.name}" from ${episode_codes.length} episode${episode_codes.length === 1 ? '' : 's'}?`,
    message: `Clears the per-item scheduled times for: ${previewLine}.\n\nYouTube videos keep their current live publishAt — use per-row actions if you want YT updated too.`,
    confirmLabel: 'Unapply',
    danger: true,
  })
  if (!ok) return
  scopeBusyPlanId.value = plan.id
  try {
    const r = await clearItemSchedule({ plan_id: plan.id, episode_codes, sync_youtube: false })
    success(`Unapplied "${plan.name}" — ${r.cleared} schedule entry/entries removed.`)
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Unapply failed')
  } finally {
    scopeBusyPlanId.value = ''
  }
}

async function doSetUploadMode(mode: 'apply-plan' | 'private') {
  try {
    await setUploadModeFor('youtube', mode)
    success(mode === 'private'
      ? 'Switched to private-first mode. Uploads will skip publishAt; schedule in YouTube Studio.'
      : 'Switched to Apply-plan mode. Plans + per-item schedules will be pushed to YouTube.')
    await loadQueue('youtube')    // refresh so schedule column reflects mode
  } catch (e: any) {
    // Include HTTP status so stale-Electron (which returns 404 HTML for
    // routes that aren't yet compiled into dist) shows a clear message
    // rather than the generic "Failed to switch mode".
    const status = e?.response?.status ?? e?.status
    const detail = e?.data?.detail || e?.message || ''
    const msg = status === 404
      ? 'Upload-mode endpoint not found. Fully quit + relaunch Electron to pick up the latest code.'
      : `Failed to switch mode${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`
    showError(msg)
  }
}

// Quota chip computeds. Tooltip explains the ledger is a local estimate;
// the chip ticks down a "resets in 7h 41m" countdown by re-deriving from
// `quota.resets_at` on every reactive read (the ref refreshes every 30s
// via the polling loop, which is fine — the digit doesn't need to flip
// every second to be useful).
const quotaPct = computed(() => {
  const q = quota.value
  if (!q || !q.ceiling) return 0
  return Math.round((q.used / q.ceiling) * 100)
})
const quotaResetSeconds = computed(() => {
  const q = quota.value
  if (!q?.resets_at) return 0
  const ms = Date.parse(q.resets_at) - Date.now()
  return Math.max(0, Math.floor(ms / 1000))
})
const quotaTooltip = computed(() => {
  const base = 'Estimated based on local call counts. Authoritative number is in Google Cloud Console → APIs → YouTube Data API → Quotas.'
  const lines: string[] = []
  if (quotaPct.value >= 95) lines.push('Approaching daily limit — uploads may fail.')
  else if (quotaPct.value >= 80) lines.push('Approaching daily limit.')
  if (quota.value?.stale) lines.push('Last ledger write failed — count may be behind what YouTube has billed.')
  lines.push(base)
  return lines.join('\n')
})

onMounted(() => {
  refreshAll()
  startQuotaPolling()
  loadUploadMode()
})

onBeforeUnmount(() => {
  stopQuotaPolling()
})
</script>

<style scoped>
.upload-center {
  --upload-ink: #f4f1e8;
  --upload-gold: #f2c86f;
  --upload-green: #4cc99a;
  padding-bottom: 40px;
}

.upload-command-surface {
  margin-top: var(--space-4);
}

.upload-header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}

.upload-tab-panel {
  margin-top: var(--workspace-section-gap);
}

/* Always-visible YouTube quota chip. Replaces the threshold-gated quota
 * banner — see electron/server/services/upload-quota.ts for the underlying
 * per-account JSONL ledger.
 *
 * Color tiers:
 *   default → neutral, sits in the header without nagging
 *   .warn   → amber at >=80% used
 *   .danger → red at >=95% used; tooltip warns uploads may fail
 *   .stale  → muted yellow when the last ledger write failed
 */
.quota-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  cursor: help;
}
.quota-chip .chip-icon { font-size: 13px; line-height: 1; }
.quota-chip .chip-text { font-variant-numeric: tabular-nums; }
.quota-chip .chip-divider { opacity: 0.55; margin: 0 2px; }
.quota-chip.warn {
  background: rgba(240, 140, 60, 0.12);
  border-color: rgba(240, 140, 60, 0.45);
  color: #e4903a;
}
.quota-chip.danger {
  background: rgba(248, 81, 73, 0.14);
  border-color: rgba(248, 81, 73, 0.55);
  color: #f85149;
}
.quota-chip.stale {
  background: rgba(196, 165, 60, 0.12);
  border-color: rgba(196, 165, 60, 0.45);
  color: #c4a53c;
}

.upload-tabs {
  display: grid;
  grid-auto-columns: minmax(150px, 1fr);
  grid-auto-flow: column;
  gap: 8px;
  margin-top: 0;
  padding: 5px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-secondary) 88%, transparent);
  scrollbar-width: thin;
}
.upload-tab {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.upload-tab:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
.upload-tab.active {
  border-color: rgba(242, 200, 111, 0.3);
  background: linear-gradient(135deg, rgba(242, 200, 111, 0.16), rgba(242, 200, 111, 0.06));
  color: var(--accent);
}
.upload-tab:disabled { cursor: not-allowed; opacity: 0.55; }
.upload-tab-icon {
  display: grid;
  width: 27px;
  height: 27px;
  flex: 0 0 27px;
  place-items: center;
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: 13px;
}
.upload-tab.active .upload-tab-icon { background: var(--accent); color: #17140f; }
.upload-tab-copy { display: flex; min-width: 0; flex-direction: column; }
.upload-tab-copy strong { overflow: hidden; font-size: var(--font-xs); line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
.upload-tab-copy small { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.tab-soon {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: var(--font-xs);
  background: var(--bg-tertiary);
  border-radius: 999px;
  color: var(--text-muted);
}
.queue-command-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin: -4px -4px 14px;
  padding: 16px;
  border: 1px solid rgba(76, 201, 154, 0.18);
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(76, 201, 154, 0.075), rgba(242, 200, 111, 0.045));
}
.queue-command-copy { display: flex; max-width: 620px; flex-direction: column; }
.queue-command-copy > span { color: #62d6a7; font-size: var(--font-xs); font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
.queue-command-copy strong { margin: 3px 0; font-size: 16px; }
.queue-command-copy small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.queue-command-metrics { display: grid; grid-template-columns: repeat(4, minmax(56px, 1fr)); gap: 6px; }
.queue-command-metrics div {
  min-width: 58px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.13);
  text-align: center;
}
.queue-command-metrics strong,
.queue-command-metrics span { display: block; }
.queue-command-metrics strong { color: var(--text-primary); font-size: 15px; }
.queue-command-metrics span { color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; letter-spacing: 0.06em; }

.platform-block {
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.platform-block:last-child { border-bottom: none; }
.platform-block.disabled { opacity: 0.6; }
.platform-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 10px; }
.platform-head h4 { margin: 0; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
.platform-head p { margin: 4px 0 0; max-width: 520px; }

.state-pill {
  display: inline-flex; align-items: center;
  margin-left: 10px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: var(--font-xs); font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.4px;
}
.state-pill.state-set {
  background: rgba(46, 160, 67, 0.15); color: #3fb950;
}
.state-pill.state-empty { background: var(--bg-tertiary); color: var(--text-muted); }
.state-pill.state-warn {
  background: rgba(251, 191, 36, 0.12); color: #fbbf24;
  border: 1px solid rgba(251, 191, 36, 0.35);
  cursor: help;
}
.state-pill.state-coming {
  background: var(--bg-tertiary); color: var(--text-secondary);
  border: 1px dashed var(--border);
}

.connect-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0; }

.mode-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  font-size: 13px;
  margin-top: 12px;
}
.mode-row.active {
  border-color: rgba(240, 198, 116, 0.35);
  background: rgba(240, 198, 116, 0.06);
}
.mode-row label {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.mode-row label:hover { background: var(--bg-hover); }
.mode-row label.chosen { color: var(--accent); font-weight: 500; }
.mode-row label input[type='radio'] { accent-color: var(--accent); cursor: pointer; }

.accounts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.accounts-table th {
  text-align: left;
  font-size: var(--font-xs); font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.accounts-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border-subtle, var(--border));
  vertical-align: middle;
}
.accounts-table tr.is-default td {
  background: rgba(46, 160, 67, 0.08);
}
.col-actions {
  /* Was width:1% + nowrap which crammed every button into one line and
     refused to wrap on narrow viewports. Give it a sensible min-width
     and let the cluster wrap so buttons aren't squeezed shoulder-to-
     shoulder. white-space: normal allows wrapping. */
  min-width: 220px;
  white-space: normal;
  text-align: right;
  padding: 8px 10px;
  vertical-align: middle;
}

/* Per-row action cluster. Right-aligned, generous gap, wraps onto a
   second line on narrow viewports. Buttons get consistent height +
   horizontal padding via .row-actions .btn so a row with two
   different btn-* variants doesn't look ragged. */
.row-actions {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 6px 8px;   /* row-gap × col-gap */
}
.row-actions .btn {
  /* Even out variant heights — primary/secondary/ghost/danger were
     drifting because of mixed icon characters changing the line-height.
     Fixed min-height + uniform padding makes the cluster read as a
     single control group. */
  min-height: 28px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* col-actions content inside the table — wrap any direct-child buttons
   in the same cluster shape so missing-video / plans / playlists rows
   get the same breathing room. The .row-actions class is the
   first-class form, but legacy markup just drops buttons inline; this
   selector catches both. */
td.col-actions > .btn,
td.col-actions > a.btn,
td.col-actions > .btn + .btn,
td.col-actions > .btn + a.btn,
td.col-actions > a.btn + .btn {
  margin-left: 6px;
  vertical-align: middle;
}
td.col-actions > .btn,
td.col-actions > a.btn {
  min-height: 28px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
/* Soft separator between primary actions and destructive ones in the
   plans row — a thin vertical line so Edit/Delete read as their own
   tier without being shouty. Marked via the new .row-actions-divider
   span the template adds where appropriate. */
.row-actions-divider {
  display: inline-block;
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
  vertical-align: middle;
}

/* Selection column — tight, just enough for the checkbox. */
.col-select { width: 32px; text-align: center; padding: 0 4px; }
.col-select input[type="checkbox"] { margin: 0; cursor: pointer; }
.row-selected {
  background: rgba(240, 198, 116, 0.06);
}

/* Sticky bulk-action bar — same recipe as Ideas Generator's accept bar
   so the two surfaces share one visual language. Pinned bottom-center,
   floats above content, fade-in on first selection. z-index sits below
   modal overlays (z=1000) so dialogs still cover it. */
.queue-bulk-bar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  padding: 10px 16px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
  z-index: 50;
}
.queue-bulk-bar-count {
  font-size: 12px; font-weight: 600;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(240, 198, 116, 0.18);
  color: var(--accent);
}
.bulk-bar-enter-active, .bulk-bar-leave-active {
  transition: opacity .18s ease, transform .18s ease;
}
.bulk-bar-enter-from, .bulk-bar-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}

.channel-cell { display: flex; align-items: center; gap: 10px; }
.channel-thumb { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }

.connected-account {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: rgba(46, 160, 67, 0.06);
  border: 1px solid rgba(46, 160, 67, 0.25);
  border-left: 3px solid #3fb950;
  border-radius: var(--radius-sm);
}
.channel-avatar-lg {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  overflow: hidden;
  flex-shrink: 0;
  background: linear-gradient(145deg, rgba(240, 198, 116, 0.24), rgba(63, 185, 128, 0.16));
  border: 1px solid rgba(240, 198, 116, 0.35);
  color: var(--accent);
  font-size: var(--font-sm);
  font-weight: 750;
  letter-spacing: 0.04em;
}
.channel-thumb-lg { width: 100%; height: 100%; object-fit: cover; }

.default-radio { accent-color: #3fb950; cursor: pointer; }
.default-radio:disabled { cursor: default; }

/* Playlists tab — default-row visual treatment.
   Old design: the "default" signal was a disabled radio button. Disabled
   reads as "broken" or "loading", not "active state", so users were
   missing it. Replaced with:
   1. ✓ DEFAULT pill on the active row (clear, can't miss)
   2. "Make default" button on the others (obvious affordance)
   3. Accent left-border + tinted bg + accent title color so the active
      row stands out at a row-level glance, not just inside one cell. */
.default-cell { min-width: 110px; }
.default-badge {
  display: inline-block;
  padding: 3px 8px;
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.4px;
  border-radius: 999px;
  background: rgba(46, 160, 67, 0.18);
  color: rgb(140, 210, 150);
  border: 1px solid rgba(46, 160, 67, 0.45);
  white-space: nowrap;
}
.btn-make-default {
  font-size: var(--font-xs);
}
.plans-table tr.is-default {
  background: rgba(46, 160, 67, 0.06);
  border-left: 3px solid rgb(46, 160, 67);
}
.plans-table tr.is-default td:first-child {
  /* The border-left lives on the tr, but tr borders don't render in
     all browsers — back it up with the first cell's left border so
     the accent shows even where tr-borders are dropped. */
  border-left: 3px solid rgb(46, 160, 67);
  margin-left: -3px;
}
.default-title { color: rgb(140, 210, 150); }

.tab-placeholder {
  padding: 32px 18px;
  text-align: center;
  color: var(--text-secondary);
}

/* ── Queue tab ──────────────────────────────────────────────────── */
.queue-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 2px;
  flex-wrap: wrap;
}
.pagination-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.pagination-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.page-indicator {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 6px;
}

.input-sm {
  padding: 4px 8px;
  font-size: 12px;
  height: 28px;
}

/* ── Comments tab ─────────────────────────────────────────────────── */
.thread-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.thread {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px 16px;
}
.thread-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.thread-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-primary);
  flex-shrink: 0;
}
.thread-meta {
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
.thread-author { color: var(--text-primary); }
.thread-stamp { font-size: var(--font-xs); }
.thread-text {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.thread-replies {
  list-style: none;
  padding: 8px 0 0 32px;
  margin: 8px 0 0;
  border-left: 2px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.thread-reply {
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.thread-reply strong { color: var(--text-primary); }
.thread-reply .reply-text {
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.thread-more {
  margin: 6px 0 0;
  padding-left: 32px;
  font-size: var(--font-xs);
}
.reply-composer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reply-composer textarea { resize: vertical; }
.reply-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.draft-candidates {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--bg-primary);
  border: 1px dashed var(--border);
  border-radius: 4px;
}
.draft-hint { margin: 0; font-size: var(--font-xs); }
.draft-pill {
  text-align: left;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  white-space: normal;
  line-height: 1.4;
}
.draft-pill:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}

.queue-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.queue-table th {
  text-align: left;
  font-size: var(--font-xs); font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.queue-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border-subtle, var(--border));
  vertical-align: middle;
}
.col-title { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.meta-pill {
  display: inline-block;
  padding: 1px 8px;
  font-size: var(--font-xs);
  font-weight: 500;
  border-radius: 999px;
  margin-right: 4px;
}
.meta-pill.ok { background: rgba(46, 160, 67, 0.15); color: #3fb950; }
.meta-pill.warn { background: rgba(240, 140, 60, 0.15); color: rgb(228, 148, 66); }
.meta-pill.muted { background: var(--bg-tertiary); color: var(--text-muted); }
/* Reconcile link-state variants — matches the .state-chip set below.
 * `linked` (blue): already confirmed, sidecar exists.
 * `suggested` (green): high-confidence auto-match, ready to confirm.
 * `review` (amber): low-confidence title match, verify before saving.
 * `manual` (grey): no auto-match, user picks manually. */
.meta-pill.linked { background: rgba(80, 130, 200, 0.18); color: #6e9bd6; }
.meta-pill.suggested { background: rgba(46, 160, 67, 0.15); color: #3fb950; }
.meta-pill.review { background: rgba(240, 140, 60, 0.15); color: rgb(228, 148, 66); }
.meta-pill.manual { background: var(--bg-tertiary); color: var(--text-muted); }

/* Reconcile-tab specific elements */
.reconcile-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-top: 8px;
}
.reconcile-summary .state-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 999px;
  font-weight: 500;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  cursor: help;
}
.reconcile-summary .state-chip.linked { background: rgba(80, 130, 200, 0.10); border-color: rgba(80, 130, 200, 0.35); color: #6e9bd6; }
.reconcile-summary .state-chip.suggested { background: rgba(46, 160, 67, 0.10); border-color: rgba(46, 160, 67, 0.35); color: #3fb950; }
.reconcile-summary .state-chip.review { background: rgba(240, 140, 60, 0.10); border-color: rgba(240, 140, 60, 0.35); color: rgb(228, 148, 66); }
.reconcile-summary .state-chip.manual { color: var(--text-muted); }
.reconcile-summary .reconcile-shown { margin-left: auto; font-size: var(--font-xs); }

.reconcile-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  margin-top: 10px;
  padding: 8px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.reconcile-controls .control-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.reconcile-controls .control-label .select { font-size: 13px; min-width: 140px; text-transform: none; letter-spacing: 0; }

/* Subtle background tint on already-linked rows so the eye skims past
 * confirmed entries when the user switches to "All". The dropdown stays
 * fully usable — re-linking just shows the confirmation modal. */
.queue-table tr.row-linked td { background: rgba(80, 130, 200, 0.05); color: var(--text-muted); }
.queue-table tr.row-linked .video-link { color: var(--text-secondary); }

.reconcile-pager {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}
.reconcile-pager .page-indicator { padding: 0 8px; color: var(--text-secondary); }

/* Per-row schedule editor modal — used by the 📅 Edit button on uploaded
 * queue rows. Centered fixed overlay so it never gets clipped by the
 * table cell. Backdrop click closes the modal. */
.sched-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.sched-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px 20px;
  min-width: 380px;
  max-width: 480px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
}
.sched-modal-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 14px;
  margin-bottom: 10px;
}
.sched-modal-body { font-size: 13px; }
.sched-modal-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}
.sched-modal-label .input { font-size: 13px; padding: 6px 8px; }
.sched-modal-note {
  font-size: 12px;
  margin: 6px 0;
  padding: 6px 8px;
  background: var(--bg-tertiary);
  border-left: 2px solid var(--accent);
  border-radius: 4px;
  color: var(--text-secondary);
}
.sched-modal-error {
  font-size: 12px;
  margin: 8px 0 0;
  padding: 6px 8px;
  background: rgba(248, 81, 73, 0.10);
  border-left: 2px solid #f85149;
  border-radius: 4px;
  color: #f85149;
}
.sched-modal-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.video-link { color: var(--accent); text-decoration: none; font-weight: 500; }
.video-link:hover { text-decoration: underline; }

/* Live-job progress pill in the queue's Status column. */
.progress-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  font-size: var(--font-xs);
  font-weight: 500;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
}
.progress-pill.err { background: rgba(248, 81, 73, 0.15); color: #f85149; }

/* Final-video size chip — sits above the action buttons in the actions
   column. Always renders (em-dash when size is unknown) so the column
   width doesn't jump between rows. */
.size-chip {
  display: inline-block;
  margin-bottom: 6px;
  padding: 2px 8px;
  font-size: var(--font-xs);
  font-weight: 500;
  border-radius: 6px;
  background: var(--bg-secondary, rgba(148, 163, 184, 0.12));
  color: var(--text-secondary, #94a3b8);
  font-variant-numeric: tabular-nums;
  cursor: help;
}

.progress-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
  animation: progressPulse 1.2s ease-in-out infinite;
}
@keyframes progressPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.type-chip {
  display: inline-block;
  padding: 1px 8px;
  font-size: var(--font-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 999px;
  white-space: nowrap;
}
.type-chip.episode { background: rgba(88, 166, 255, 0.15); color: #58a6ff; }
.type-chip.import  { background: rgba(240, 198, 116, 0.15); color: #f0c674; }

.sched-pill {
  display: inline-block;
  padding: 0 4px;
  font-size: var(--font-xs);
  border-radius: 4px;
  background: var(--bg-tertiary);
  margin-left: 4px;
  vertical-align: middle;
}
.sched-pill.ok { background: rgba(46, 160, 67, 0.15); }

/* Plain-language clarifier under each scheduled queue cell. Three tones
   matching the meaning: green (✓ auto-publishes — YouTube has it),
   cyan-pending (will publish on upload — YouTube doesn't have it yet),
   muted (private mode — user schedules manually). Sized to the same
   visual weight as the existing emoji pills so it doesn't dominate the
   row. */
.sched-explainer { margin-top: 3px; }

/* Rich schedule cell layout — date on top, time + relative below.
   Both lines stay tightly packed inside the existing schedule-cell
   button so the inline date-time picker (which replaces the cell when
   editingScheduleFor === item.episode_code) sits in the same vertical
   space without the row height jumping during the swap. */
.sched-date {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  line-height: 1.3;
}
.sched-time {
  font-size: var(--font-xs);
  color: var(--text-secondary);
  line-height: 1.3;
}
.sched-relative {
  color: var(--text-muted);
}
/* Stale-public schedule: shown in place of the bright date/time when a
 * row's sidecar still has scheduled_for set even though the video is
 * already public on YouTube. Italic + muted so it reads as historical
 * info, not live state. Tooltip points the user at ☁ Sync from YouTube. */
.sched-stale {
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
  line-height: 1.4;
  cursor: help;
}

/* Privacy chip — three tones matching the privacy state. Sized to
   sit inline next to the existing meta-pill and progress-pill chips,
   so the Status column reads as a chip stack rather than a single
   value. */
.row-chip-stack {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 2px;
}
.privacy-chip {
  display: inline-block;
  padding: 1px 6px;
  font-size: var(--font-xs);
  line-height: 1.4;
  border-radius: 999px;
  border: 1px solid transparent;
  white-space: nowrap;
}
.privacy-chip--muted {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border-color: var(--border);
}
.privacy-chip--pending {
  background: rgba(99, 145, 200, 0.12);
  color: rgb(150, 180, 220);
  border-color: rgba(99, 145, 200, 0.30);
}
.privacy-chip--ok {
  background: rgba(46, 160, 67, 0.12);
  color: rgb(140, 210, 150);
  border-color: rgba(46, 160, 67, 0.30);
}

/* Playlist chip — sits inline with the other meta-pill chips. Distinct
   tone (purple-ish) so it doesn't get visually confused with the
   ✓ Ready / 🖼 Thumb pills. */
.meta-pill.playlist {
  background: rgba(166, 135, 220, 0.14);
  color: rgb(190, 165, 230);
  border: 1px solid rgba(166, 135, 220, 0.32);
}
.sched-chip {
  display: inline-block;
  padding: 1px 6px;
  font-size: var(--font-xs);
  line-height: 1.4;
  border-radius: 999px;
  border: 1px solid transparent;
  white-space: nowrap;
}
.sched-chip--ok {
  background: rgba(46, 160, 67, 0.12);
  color: rgb(140, 210, 150);
  border-color: rgba(46, 160, 67, 0.30);
}
.sched-chip--pending {
  background: rgba(99, 145, 200, 0.12);
  color: rgb(150, 180, 220);
  border-color: rgba(99, 145, 200, 0.30);
}
.sched-chip--muted {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border-color: var(--border);
}

.schedule-cell {
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: var(--radius-sm);
  text-align: left;
}
.schedule-cell:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.schedule-cell:disabled { cursor: default; }
.schedule-editor { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.unschedule-actions { display: flex; gap: 4px; margin-top: 2px; }
.btn-unschedule {
  font-size: var(--font-xs);
  padding: 1px 6px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.btn-unschedule:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.btn-unschedule.danger { color: #e4903a; }
.btn-unschedule.danger:hover:not(:disabled) { background: rgba(248, 81, 73, 0.12); color: #f85149; }

.import-editor {
  padding: 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: rgba(240, 198, 116, 0.04);
}

.missing-video-section {
  padding: 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: rgba(245, 158, 11, 0.04);
}

/* ── Plans tab ──────────────────────────────────────────────────── */
.plan-editor {
  padding: 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: rgba(240, 198, 116, 0.04);
}
.plan-editor-head {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 10px;
}
.plan-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 14px;
}
.plan-grid .form-group { margin: 0; }
.plan-grid .form-group label { display: block; font-size: var(--font-xs); color: var(--text-muted); margin-bottom: 2px; }
.plan-grid .full-row { grid-column: 1 / -1; }
.tz-picker-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tz-picker-row .tz-select { flex: 1 1 240px; min-width: 200px; }
.weekday-row { display: flex; gap: 4px; flex-wrap: wrap; }
.weekday-btn {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.weekday-btn:hover { border-color: var(--accent); color: var(--text-primary); }
.weekday-btn.on {
  border-color: var(--accent);
  background: var(--accent-dim);
  color: var(--accent);
}

.orphan-bulk-bar {
  display: flex; align-items: center; justify-content: space-between;
  flex-wrap: wrap; gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  font-size: 12px;
}

/* Item L — renumber rollback banner. Amber-toned to read as "advisory
   safety net", distinct from the red destructive-action wording in
   the bulk-mode picker below it. */
.renumber-undo-banner {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(217, 119, 6, 0.35);
  background: rgba(217, 119, 6, 0.08);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.renumber-undo-banner-icon {
  font-size: 18px;
  line-height: 1;
  color: rgb(217, 119, 6);
  padding-top: 2px;
}
.renumber-undo-banner-body { flex: 1; min-width: 0; }
.renumber-undo-banner-actions {
  display: flex; flex-direction: column; gap: 6px;
  flex-shrink: 0;
}
.renumber-undo-list {
  margin-top: 6px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  max-height: 160px;
  overflow-y: auto;
}
.renumber-undo-row {
  display: flex; gap: 6px;
  font-size: 12px;
  padding: 2px 0;
}

.explainer {
  margin-top: 8px;
  padding: 8px 12px;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
}
.explainer strong { color: var(--text-primary); }
.explainer ul { margin: 4px 0 0 18px; padding: 0; }
.explainer li { padding: 1px 0; }
.plan-actions { display: flex; gap: 8px; margin-top: 10px; }
.preview-list {
  margin-top: 10px;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
}
.preview-list ol { margin: 6px 0 0 20px; padding: 0; font-size: 12px; }
.preview-list li { padding: 2px 0; }

.playlist-select {
  max-width: 140px;
  font-size: var(--font-xs);
}

.create-playlist-card {
  padding: 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: rgba(240, 198, 116, 0.04);
  max-width: 560px;
}

.plans-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.plans-table th {
  text-align: left;
  font-size: var(--font-xs); font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.plans-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border-subtle, var(--border));
  vertical-align: middle;
}

/* ── Default-playlist banner ─────────────────────────────────────────
   Sits at the very top of the Queue tab so the user always knows
   whether new uploads will get auto-added to a playlist. Tinted accent
   when set, muted when unset (it's not an error, just FYI). */
.default-playlist-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: var(--accent-dim);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
}
.default-playlist-banner.unset {
  background: var(--bg-tertiary);
  border-color: var(--border);
  color: var(--text-muted);
}
.dpb-icon { font-size: 14px; flex-shrink: 0; }
.dpb-text { flex: 1; line-height: 1.4; }
.dpb-text strong { color: var(--text-primary); }

/* ── Reconcile-suggestions banner ────────────────────────────────────
   Sits above the queue toolbar when a background channel scan found
   videos that probably match local episodes. Distinct from the
   default-playlist banner: this one is actionable (call-out tone) so
   the user notices BEFORE clicking Upload and creating a duplicate. */
.reconcile-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: rgba(240, 140, 60, 0.10);
  border: 1px solid rgba(240, 140, 60, 0.30);
  border-left: 3px solid #e4903a;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
}
.rb-icon { font-size: 14px; flex-shrink: 0; }
.rb-text { flex: 1; line-height: 1.4; }
.rb-text strong { color: var(--text-primary); }

/* ── Queue toolbar (filter / sort / per-page / pager) ────────────────
   Shared between the Queue tab and the new Missing Video tab. Reuses
   the .queue-toolbar visual treatment from the pipeline page so the
   UI feels consistent across pages. */
.queue-toolbar {
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
.qt-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.qt-spacer { flex: 1 1 auto; }
.qt-label {
  color: var(--text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: var(--font-xs);
}
.qt-filter-group { flex: 1 1 100%; align-items: flex-start; gap: 8px; }

/* ── Quick views (v1.0.390) — intent buttons above the granular Show chips ── */
.quick-views {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.quick-views-label {
  color: var(--text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: var(--font-xs);
  margin-right: 2px;
}
.quick-view {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}
.quick-view:hover { background: var(--bg-hover, var(--bg-tertiary)); color: var(--text-primary); border-color: var(--text-muted); }
.quick-view.is-active {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}
.quick-view-icon { font-size: 14px; line-height: 1; }
.quick-view-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-secondary, rgba(127, 127, 127, 0.18));
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 600;
}
.quick-view.is-active .quick-view-count { background: var(--accent); color: var(--bg-primary, #1a1a1a); }
/* "Needs a video" jumps to another tab — read it as a link, not a filter. */
.quick-view--jump { border-style: dashed; }
.quick-view-arrow { color: var(--text-muted); font-size: 13px; }

.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}
.filter-chip:hover { background: var(--bg-hover, var(--bg-tertiary)); color: var(--text-primary); }
.filter-chip.is-active {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}
.filter-chip--overlay {
  border-style: dashed;
}
.filter-chip--overlay.is-active {
  background: rgba(96, 165, 250, 0.12);
  border-color: rgb(96, 165, 250);
  color: rgb(96, 165, 250);
  border-style: solid;
}
.filter-chip-icon { font-size: 13px; line-height: 1; }
.filter-chip-reset {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
  padding: 4px 6px;
  text-decoration: underline;
}
.filter-chip-reset:hover { color: var(--text-primary); }
.qt-search {
  position: relative;
  flex: 1 1 240px;
  max-width: 320px;
}
.qt-search input {
  width: 100%;
  padding-right: 26px;
}
.qt-search-clear {
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
.qt-search-clear:hover { color: var(--text-primary); background: var(--bg-hover); }
.qt-pager {
  flex-wrap: wrap;
  gap: 4px;
}
.page-indicator {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 6px;
}

/* ── Per-row kebab trigger ───────────────────────────────────────────
   The .kebab-trigger style mirrors the pipeline page's per-episode
   kebab. The .row-kebab-menu pane lives in the unscoped style block
   below because it teleports to <body>. */
.row-kebab {
  display: inline-flex;
  vertical-align: middle;
  position: relative;
}
.kebab-trigger {
  width: 26px; height: 26px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 16px;
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

/* ── v1.0.501 — operation report card ──────────────────────────────── */
.op-report { padding: 10px 14px; }
.op-report-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.op-report-title { font-size: 12.5px; color: var(--text-secondary); }
.op-report-failchip {
  font-size: var(--font-xs); font-weight: 700; padding: 1px 8px; border-radius: 999px;
  background: rgba(226, 92, 92, 0.14); color: rgb(200, 74, 74);
}
.op-report-spacer { flex: 1; }
.op-report-rows { max-height: 240px; overflow-y: auto; margin-top: 8px; display: flex; flex-direction: column; }
.op-report-row {
  display: flex; align-items: center; gap: 10px;
  padding: 4px 6px; font-size: 12.5px; border-radius: 4px;
}
.op-report-row:nth-child(odd) { background: var(--bg-tertiary); }
.op-report-row.bad { background: rgba(226, 92, 92, 0.07); }
.op-mark { width: 16px; text-align: center; color: rgb(34, 197, 94); flex: 0 0 auto; }
.op-report-row.bad .op-mark { color: rgb(200, 74, 74); }
.op-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; flex: 0 0 auto; min-width: 72px; }
.op-action { flex: 0 0 auto; font-weight: 600; font-size: 12px; }
.op-detail { flex: 1; color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-retry { flex: 0 0 auto; }
</style>

<!-- Unscoped — applies to the row-kebab menu after it teleports to <body>. -->
<style>
/* Plan scope picker — anchored next to the click target via inline style.
   Backdrop catches clicks-outside to close; popover is fixed so it doesn't
   move with the table scroll. */
.scope-popover-backdrop {
  position: fixed;
  inset: 0;
  z-index: 240;
  background: transparent;
}
.scope-popover {
  position: fixed;
  z-index: 250;
  width: 260px;
  max-width: calc(100vw - 24px);
  padding: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* Height is capped to the viewport via :style maxHeight. The inner list is
     the primary scroll region (head + action buttons stay pinned); the popover
     itself also scrolls as a fallback so nothing is ever cut off, even when the
     trigger button sits near the bottom of the screen. */
  overflow-y: auto;
}
.scope-popover-head {
  font-size: 13px;
  padding: 0 2px;
}
.scope-popover-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.scope-popover-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}
.scope-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  transition: background 0.1s, border-color 0.1s;
}
.scope-option:hover:not(:disabled) {
  background: var(--bg-tertiary);
  border-color: var(--border);
}
.scope-option:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.scope-option-label {
  font-weight: 500;
}
.scope-option-count {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
  min-width: 28px;
  text-align: center;
}
.scope-option-count.zero {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
.scope-popover-foot {
  border-top: 1px solid var(--border);
  padding-top: 6px;
  margin-top: 2px;
}
.plan-action-btn { white-space: nowrap; }

/* Item D — Apply preview panel inside the scope popover. Wider variant
   when previewing so the episode → slot rows fit. */
.scope-popover.scope-popover--preview { width: 440px; }
.scope-preview-summary {
  font-size: 13px;
  padding: 0 2px 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 6px;
}
.scope-preview-warn {
  font-size: var(--font-xs);
  padding: 6px 8px;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: rgb(180, 83, 9);
  border-radius: 4px;
  margin-bottom: 6px;
}
.scope-preview-error {
  font-size: var(--font-xs);
  padding: 6px 8px;
  background: rgba(220, 38, 38, 0.12);
  border: 1px solid rgba(220, 38, 38, 0.35);
  color: rgb(190, 18, 60);
  border-radius: 4px;
  margin-bottom: 6px;
}
.scope-preview-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Fill the space the capped popover leaves after the summary/warnings, and
     scroll internally so ALL rows are reachable (was hard-capped at 10). */
  flex: 1 1 auto;
  min-height: 60px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px;
  margin-bottom: 6px;
}
.scope-preview-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 6px;
  align-items: center;
  padding: 4px 6px;
  font-size: 12px;
  border-radius: 3px;
}
.scope-preview-row.is-past {
  background: rgba(220, 38, 38, 0.08);
  color: rgb(190, 18, 60);
}
.scope-preview-code {
  font-family: 'JetBrains Mono', SFMono-Regular, Menlo, Monaco, monospace;
  font-weight: 600;
}
.scope-preview-arrow { font-size: var(--font-xs); }
.scope-preview-slot {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scope-preview-more {
  padding: 4px 6px;
  font-size: var(--font-xs);
  text-align: center;
}
.scope-preview-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

/* Upload Plan modal — opens from the Queue tab's quick-apply button.
   Lighter weight than the schedule modal: no form inputs, just a plan
   chooser + the three scope-popover trigger buttons. */
.upload-plan-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 240;
  background: rgba(0, 0, 0, 0.45);
}
.upload-plan-modal {
  position: fixed;
  z-index: 250;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 460px;
  max-width: calc(100vw - 32px);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
}
.upload-plan-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}
.upload-plan-modal-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  line-height: 1;
  border-radius: 4px;
}
.upload-plan-modal-close:hover { color: var(--text-primary); background: var(--bg-tertiary); }
.upload-plan-modal-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.upload-plan-modal-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.upload-plan-modal-label .select { font-size: 13px; }
.upload-plan-modal-desc {
  font-size: 12px;
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  border: 1px solid var(--border);
}
.upload-plan-modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.upload-plan-modal-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--border);
  gap: 8px;
}

/* Tombstone pill — used on rows where the upstream YouTube video is gone. */
.tombstone-pill {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(120, 113, 108, 0.18);
  color: rgb(120, 113, 108);
  border: 1px solid rgba(120, 113, 108, 0.35);
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* Inline "Looks already on YouTube → Link" hint on Ready rows. */
.orphan-match-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.12);
  border: 1px solid rgba(96, 165, 250, 0.45);
  color: rgb(96, 165, 250);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.orphan-match-pill:hover {
  background: rgba(96, 165, 250, 0.22);
  color: rgb(59, 130, 246);
}

/* Item E — "Uploaded elsewhere" pill. Distinct color from the orphan-
   match pill (which is also blue) so users can tell them apart at a
   glance: orphan-match = "we found a YouTube video that might be this",
   external = "you told us this lives on a different account". */
.external-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(168, 85, 247, 0.14);
  border: 1px solid rgba(168, 85, 247, 0.45);
  color: rgb(168, 85, 247);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.1s, color 0.1s;
}
.external-pill:hover {
  background: rgba(168, 85, 247, 0.24);
  color: rgb(147, 51, 234);
}
.external-pill--no-url {
  /* Muted appearance when there's no URL yet — the click action is
     "open the edit modal" rather than "follow a link", so the pill
     should look slightly less inviting than a normal action. */
  background: rgba(168, 85, 247, 0.08);
  color: rgba(168, 85, 247, 0.85);
  border-style: dashed;
}

/* Link Video modal — wider than the plan modal so titles aren't truncated. */
.link-video-modal { width: 580px; }
.link-video-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px;
}
.link-video-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  width: 100%;
  transition: background 0.1s, border-color 0.1s;
}
.link-video-row:hover:not(:disabled) {
  background: var(--bg-tertiary);
  border-color: var(--border);
}
.link-video-row:disabled { opacity: 0.5; cursor: wait; }
.link-video-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.link-video-row-title {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.link-video-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: var(--font-xs);
  color: var(--text-muted);
}
.link-video-row-score {
  flex-shrink: 0;
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
.link-video-row-score.high-match {
  background: rgba(34, 197, 94, 0.15);
  color: rgb(34, 197, 94);
}

.row-kebab-menu {
  position: fixed;
  z-index: 250;
  min-width: 280px;
  padding: 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rkm-section {
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rkm-section-label {
  font-size: var(--font-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
.rkm-playlist-select {
  width: 100%;
}
.rkm-item {
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
.rkm-item:hover { background: var(--bg-tertiary); }
.rkm-icon {
  width: 20px;
  flex-shrink: 0;
  font-size: 14px;
  color: var(--accent);
  text-align: center;
  margin-top: 1px;
}
.rkm-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.rkm-body strong { font-size: 13px; font-weight: 600; }
.rkm-hint { font-size: var(--font-xs); color: var(--text-muted); line-height: 1.35; }

/* v1.0.41 — pre-upload preview modal. v1.0.46 — modal scales with the
   viewport instead of capping at 720px (which cramped meta + zoomed
   thumbnail into the same row). Wider on big screens, scales down on
   small ones; body is taller so description / tags don't push out
   when the thumbnail expands. */
.upload-plan-modal--preview {
  /* Override the base upload-plan-modal `width: 460px` with a
     viewport-aware budget. On a 1440px Mac display this gives ~960px;
     on a 1080p laptop ~870px; on a small Electron window it shrinks
     gracefully. */
  width: min(960px, calc(100vw - 48px));
  max-width: min(960px, calc(100vw - 48px));
  /* Taller default than the generic plan modal — the content runs
     thumbnail → title → description → tags, so even at small zoom
     it benefits from extra vertical room. */
  max-height: calc(100vh - 64px);
}
.upload-plan-modal--preview .upload-plan-modal-body {
  max-height: calc(100vh - 180px);
  overflow-y: auto;
}
.upload-preview-loading {
  display: flex;
  min-height: 180px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.upload-preview-thumb-block {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid rgba(242, 200, 111, 0.2);
  border-radius: 14px;
  background: linear-gradient(145deg, rgba(242, 200, 111, 0.055), rgba(76, 201, 154, 0.025));
}
.upload-preview-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.upload-preview-kicker {
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.upload-preview-section-head h3 { margin: 2px 0 0; font-size: 15px; }
.upload-preview-count {
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: var(--font-xs);
}
.upload-preview-featured {
  display: grid;
  width: 100%;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #0c0f0e;
  color: inherit;
  text-align: left;
  cursor: zoom-in;
}
.upload-preview-thumb-img {
  width: min(100%, 520px);
  aspect-ratio: 16 / 9;
  height: auto;
  object-fit: cover;
  transition: width 0.2s ease;
}
.upload-preview-thumb-img.is-expanded {
  width: 100%;
}
.upload-preview-featured-caption {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 11px;
  border-top: 1px solid var(--border);
}
.upload-preview-featured-caption strong {
  overflow: hidden;
  font-size: var(--font-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upload-preview-featured-caption span { color: var(--text-muted); font-size: var(--font-xs); }
.upload-preview-thumb-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(135px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.upload-preview-thumb-option {
  position: relative;
  min-width: 0;
  padding: 5px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.upload-preview-thumb-option:hover { transform: translateY(-1px); border-color: rgba(242, 200, 111, 0.5); }
.upload-preview-thumb-option.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(242, 200, 111, 0.14);
}
.upload-preview-thumb-option img { display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: 5px; object-fit: cover; }
.upload-preview-option-name {
  display: block;
  overflow: hidden;
  padding: 6px 2px 1px;
  font-size: var(--font-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upload-preview-pin { display: block; padding: 0 2px 2px; color: var(--text-muted); font-size: var(--font-xs); }
.upload-preview-check {
  position: absolute;
  top: 9px;
  right: 9px;
  display: grid;
  width: 21px;
  height: 21px;
  place-items: center;
  border-radius: 50%;
  background: var(--accent);
  color: #17140f;
  font-size: 12px;
  font-weight: 900;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.upload-preview-choice-note { margin: 8px 0 0; color: var(--text-muted); font-size: var(--font-xs); }
.upload-preview-desc {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.upload-preview-desc.is-collapsed {
  max-height: 80px;
  overflow: hidden;
  position: relative;
}
.upload-preview-desc.is-collapsed::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 30px;
  background: linear-gradient(transparent, var(--bg-tertiary));
  pointer-events: none;
}
.upload-preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.upload-preview-tags .idea-tag {
  font-size: var(--font-xs);
  padding: 2px 8px;
  background: var(--bg-tertiary);
  border-radius: 999px;
  color: var(--text-muted);
}
.scope-preview-anchor {
  margin: 7px 0;
  padding: 7px 9px;
  border: 1px solid rgba(76, 201, 154, 0.25);
  border-radius: 7px;
  background: rgba(76, 201, 154, 0.07);
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.scope-preview-anchor span { margin-right: 4px; color: #4cc99a; }
@media (max-width: 900px) {
  .upload-tabs { grid-auto-columns: minmax(138px, 44vw); }
  .queue-command-strip { align-items: stretch; flex-direction: column; }
}
@media (max-width: 560px) {
  .upload-preview-featured-caption { align-items: flex-start; flex-direction: column; }
  .upload-preview-thumb-picker { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
