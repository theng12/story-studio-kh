<template>
  <div>
    <div class="upload-header">
      <h1>▶ YouTube Upload</h1>
      <button
        class="btn btn-sm btn-ghost"
        :disabled="loading"
        title="Reload accounts, OAuth status, and playlists across all tabs. Use after connecting/disconnecting a YouTube account or if a tab looks stale. Doesn't refresh the upload queue rows — use the Refresh queue button inside the queue for that."
        @click="refreshAll"
      >
        <LoadingSpinner v-if="loading" size="sm" />
        {{ loading ? 'Loading…' : '↻ Refresh accounts' }}
      </button>
    </div>

    <p class="text-muted mt-1 mb-2" style="font-size: 13px; max-width: 860px;">
      Connect a YouTube channel, queue episodes, apply a recurring schedule, and let YouTube handle the actual publish
      moment via its own <code>publishAt</code>. Each project is bound to exactly one channel — reconnecting swaps the
      binding without leaving stale tokens behind. TikTok + Facebook have their own pages in the sidebar (coming in v2).
    </p>

    <!-- Quota banner — shows when we're approaching or past the daily limit. -->
    <div
      v-if="quota && quota.used >= quota.warn_at"
      class="quota-banner"
      :class="{ block: quota.used >= quota.block_at }"
    >
      <span class="quota-icon">{{ quota.used >= quota.block_at ? '🛑' : '⚠️' }}</span>
      <span class="quota-text">
        <strong>YouTube API quota:</strong>
        {{ quota.used.toLocaleString() }} / {{ quota.ceiling.toLocaleString() }} units used today
        ({{ Math.round(quota.used / quota.ceiling * 100) }}%).
        <template v-if="quota.used >= quota.block_at">
          New uploads are paused to avoid mid-stream 403s.
        </template>
        <template v-else>
          ~{{ Math.max(0, Math.floor((quota.ceiling - quota.used) / 1600)) }} more upload(s) before the block threshold.
        </template>
        Resets at {{ new Date(quota.resets_at).toLocaleString() }} (midnight Pacific).
        <a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank" rel="noopener noreferrer">Request a quota increase</a>.
      </span>
    </div>

    <!-- Stale-ledger warning — shown independently of the quota banner so
         the user sees it even when their displayed `used` count is low. The
         flag gets set when a recordQuotaUsage write fails (disk full, lock
         contention, permissions drift); it clears on the next successful
         write. See electron/server/services/upload-quota.ts. -->
    <div
      v-if="quota && quota.stale"
      class="quota-banner stale"
      title="The local quota counter is updated after each YouTube API call by writing to config.json. The most recent write failed, so the number above may be lower than what YouTube has actually billed today. Check Google Cloud Console → YouTube Data API → Quotas if uploads start returning 403."
    >
      <span class="quota-icon">⚠</span>
      <span class="quota-text">
        <strong>Local quota count may be stale.</strong>
        The last ledger write failed — the displayed total above is behind what YouTube has actually billed.
        Check
        <a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank" rel="noopener noreferrer">Google Cloud Console</a>
        if uploads start failing.
      </span>
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
        {{ tab.label }}
        <span v-if="tab.disabled" class="tab-soon">Phase {{ tab.phase }}</span>
      </button>
    </div>

    <!-- ── Accounts tab ─────────────────────────────────────────────── -->
    <div v-if="activeTab === 'accounts'" class="card mt-2">
      <h3 style="margin: 0">Platforms & Connected Accounts</h3>
      <p class="text-muted" style="font-size: 12px; margin: 4px 0 12px;">
        Story Studio uses the <strong>installed-app loopback flow</strong>: clicking Connect
        opens your system browser, you consent, and our local app catches the redirect.
        Tokens live in this project's <code>secrets.json</code> (mode 0600) and never leave your machine.
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
            One project = one YouTube channel. Connecting a different Google account replaces the existing connection
            (tokens are revoked + wiped) so uploads can't accidentally land on the wrong channel.
          </p>
        </div>

        <!-- OAuth client credentials form -->
        <details class="oauth-client-details" :open="!clientStatus.youtube?.configured">
          <summary>
            <strong>Google Cloud OAuth app</strong>
            <span v-if="clientStatus.youtube?.check_error" class="state-pill state-warn" :title="clientStatus.youtube.check_error">
              ⚠ Couldn't verify
            </span>
            <span v-else-if="clientStatus.youtube?.configured" class="state-pill state-set">Configured</span>
            <span v-else class="state-pill state-empty">Not configured</span>
          </summary>
          <p v-if="clientStatus.youtube?.check_error" class="text-muted" style="font-size: 12px; color: #fbbf24;">
            We couldn't reach the OAuth status endpoint to confirm whether credentials are saved
            (<code>{{ clientStatus.youtube.check_error }}</code>). Don't re-paste your client_id/secret on this signal alone —
            it might already be configured. Try again once the backend is reachable.
          </p>
          <p class="text-muted" style="font-size: 12px;">
            You need a Google Cloud OAuth <em>Desktop app</em> client (console.cloud.google.com → APIs & Services → Credentials).
            Paste the <code>client_id</code> + <code>client_secret</code> here. They're stored in this project's secrets file,
            not shared across projects or with anyone else. Redirect URIs do <strong>not</strong> need to be configured — the loopback redirect uses a random port.
          </p>
          <div class="oauth-client-row">
            <div class="form-group">
              <label>client_id</label>
              <input v-model="ytClientIdInput" class="input input-sm" :placeholder="clientStatus.youtube?.client_id || 'xxxxxxxx.apps.googleusercontent.com'" />
            </div>
            <div class="form-group">
              <label>client_secret</label>
              <input
                v-model="ytClientSecretInput"
                class="input input-sm"
                type="password"
                :placeholder="clientStatus.youtube?.client_secret_masked || 'GOCSPX-...'"
              />
            </div>
            <button
              class="btn btn-sm btn-primary"
              :disabled="!canSaveClient"
              @click="saveYoutubeClient"
            >Save</button>
            <button
              v-if="clientStatus.youtube?.configured"
              class="btn btn-sm btn-danger"
              @click="clearYoutubeClient"
            >Clear</button>
          </div>
        </details>

        <!-- Connect button + status -->
        <div class="connect-row">
          <button
            class="btn btn-primary"
            :disabled="!clientStatus.youtube?.configured || connecting"
            :title="clientStatus.youtube?.configured
              ? 'Opens Google\'s consent page in your system browser. After approval, the redirect lands on our loopback server and a new account row appears here.'
              : 'Save a client_id + client_secret first.'"
            @click="connectYoutube"
          >
            <LoadingSpinner v-if="connecting" size="sm" />
            {{ connecting ? (connectPhase || 'Connecting…') : '🔌 Connect YouTube' }}
          </button>
          <span v-if="connectError" class="text-danger" style="font-size: 12px;">{{ connectError }}</span>
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
        <p class="text-muted mt-1" style="font-size: 11px;">
          {{ uploadMode === 'private'
            ? 'In private mode, every video uploads as private with no publishAt. You schedule each one inside YouTube Studio.'
            : 'In Apply-plan mode, scheduled publishing is handled by YouTube server-side via publishAt — Story Studio doesn\'t need to be running at the publish moment.' }}
        </p>

        <!-- Connected account card (single) -->
        <div v-if="youtubeAccounts[0]" class="connected-account mt-2">
          <img v-if="youtubeAccounts[0].thumbnail_url" :src="youtubeAccounts[0].thumbnail_url" class="channel-thumb-lg" />
          <div style="flex: 1; min-width: 0;">
            <strong style="display: block;">{{ youtubeAccounts[0].remote_title }}</strong>
            <div class="text-muted" style="font-size: 11px;">
              <code>{{ youtubeAccounts[0].remote_id }}</code>
              <span v-if="youtubeAccounts[0].custom_url"> · {{ youtubeAccounts[0].custom_url }}</span>
            </div>
            <div class="text-muted" style="font-size: 11px;">
              Connected {{ formatDate(youtubeAccounts[0].connected_at) }}
            </div>
          </div>
          <button
            class="btn btn-sm btn-danger"
            :title="`Disconnect \u201C${youtubeAccounts[0].remote_title}\u201D. Tokens are revoked on Google's side and wiped locally. Videos already uploaded stay on YouTube. You can reconnect a different channel afterward.`"
            @click="disconnect(youtubeAccounts[0])"
          >Disconnect</button>
        </div>
      </section>

    </div>

    <!-- ── Queue tab ─────────────────────────────────────────────────── -->
    <div v-else-if="activeTab === 'queue'" class="card mt-2">
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
            title="Re-scan every episode for a final video and reload these queue rows. Bypasses the 30-second backend cache so disk changes show up immediately. Doesn't touch your account/OAuth state — use the Refresh accounts button at the top for that."
            @click="loadQueue({ nocache: true, page: queuePage })"
          >
            <LoadingSpinner v-if="queueLoading" size="sm" />
            {{ queueLoading ? 'Loading…' : '↻ Refresh queue' }}
          </button>
        </div>
      </div>
      <p v-if="importsFolder" class="text-muted" style="font-size: 11px; margin: 4px 0 0;">
        Import folder: <code>{{ importsFolder }}</code>
      </p>

      <!-- Filter + sort + pagination toolbar. All three feed the same
           server-side paged request — switching filter or sort jumps to
           page 1 automatically. The default filter is "Not uploaded"
           because the dominant use case is "show me what's left to do". -->
      <div class="queue-toolbar mt-2">
        <div class="qt-group">
          <label class="qt-label" title="Filter the list to a specific status. Counts reflect the current selection.">Show</label>
          <select v-model="queueFilter" class="select select-sm">
            <option value="all">All ({{ queueTotalUnfiltered }})</option>
            <option value="not_uploaded">Not uploaded</option>
            <option value="uploaded">Uploaded</option>
            <option value="scheduled">Scheduled</option>
            <option value="failed" title="Episodes whose most recent upload job failed">Failed</option>
          </select>
        </div>
        <div class="qt-group">
          <label class="qt-label">Sort</label>
          <select v-model="queueSort" class="select select-sm">
            <option value="code_asc">Episode code · oldest first</option>
            <option value="code_desc">Episode code · newest first</option>
            <option value="status">Status (uploaded → scheduled → ready)</option>
            <option value="scheduled_asc">Scheduled · soonest first</option>
            <option value="scheduled_desc">Scheduled · latest first</option>
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
          <tr v-for="item in queueItems" :key="item.id" :class="{ 'row-selected': item.type === 'episode' && selectedQueueIds.has(item.episode_code) }">
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
              <code v-else style="font-size: 11px;">{{ item.filename }}</code>
            </td>
            <td class="col-title">{{ item.title }}</td>
            <td>
              <span :class="item.has_metadata ? 'meta-pill ok' : 'meta-pill warn'" :title="item.has_metadata
                ? 'Title + description from the Metadata Generator output (episodes) or import sidecar.'
                : item.type === 'episode'
                  ? 'No metadata on disk yet — upload will use the episode title only. Run Metadata Generator first for best results.'
                  : 'Import has no metadata yet — click Edit to add title / description / tags.'">
                {{ item.has_metadata ? '✓ Ready' : '⚠ Missing' }}
              </span>
              <span v-if="item.has_thumbnail" class="meta-pill ok" title="Highest-version thumbnail will be uploaded after the video.">🖼 Thumb</span>
              <span v-else-if="item.type === 'episode'" class="meta-pill muted" title="No thumbnail file found — YouTube will auto-generate one.">no thumb</span>
            </td>
            <td>
              <template v-if="uploadJobFor(item.episode_code) && ['queued', 'running'].includes(uploadJobFor(item.episode_code)!.status)">
                <!-- Live job state beats the sidecar display — user sees
                     progress the moment the job starts running. -->
                <span class="progress-pill" :title="`Job status: ${uploadJobFor(item.episode_code)!.status}. Click Jobs in the sidebar to see the live log.`">
                  <span class="progress-dot" />
                  {{ uploadJobFor(item.episode_code)!.status === 'queued' ? 'Queued…' : `Uploading ${uploadJobFor(item.episode_code)!.progress}%` }}
                </span>
              </template>
              <template v-else-if="uploadJobFor(item.episode_code) && uploadJobFor(item.episode_code)!.status === 'error'">
                <span class="progress-pill err" :title="uploadJobFor(item.episode_code)!.error || 'Upload failed — check Jobs tab for details.'">
                  ⚠ Failed
                </span>
              </template>
              <template v-else-if="item.uploaded">
                <a :href="item.video_url" target="_blank" rel="noopener" class="video-link" :title="`Video id: ${item.video_id} — opens in YouTube. Click Upload again to PATCH metadata only, not replace the video.`">
                  ✓ Uploaded
                </a>
                <span class="text-muted" style="font-size: 11px; display: block;">
                  {{ item.privacy_status }} · last sync {{ formatScheduled(item.last_sync_at) }}
                </span>
              </template>
              <span v-else class="text-muted">Not uploaded</span>
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
                  :title="item.type === 'episode' ? 'Click to change the scheduled publish time for this episode.' : ''"
                  :disabled="item.type !== 'episode'"
                  @click="startEditSchedule(item)"
                >
                  {{ formatScheduled(item.scheduled_for) }}
                  <span v-if="item.schedule_source === 'planned'" class="sched-pill" title="Scheduled by an Upload Plan. When you click Upload, this time is pushed to YouTube as publishAt.">📅</span>
                  <span v-else-if="item.schedule_source === 'synced'" class="sched-pill ok" title="Time is live on YouTube via publishAt.">☁️</span>
                </button>
                <!-- Plain-language clarifier: today the schedule cell only
                     shows emoji pills with the explanation buried in
                     tooltips, so users can't tell from glance who
                     actually drives the publish moment. This chip makes
                     the YouTube-native flow visible: in apply-plan mode,
                     YouTube handles publish via publishAt; in private
                     mode, the user does it from YT Studio. -->
                <div v-if="item.scheduled_for && item.type === 'episode'" class="sched-explainer">
                  <span v-if="uploadMode === 'private'" class="sched-chip sched-chip--muted">
                    Manual schedule in YouTube Studio
                  </span>
                  <span v-else-if="item.uploaded" class="sched-chip sched-chip--ok">
                    ✓ YouTube auto-publishes at this time
                  </span>
                  <span v-else class="sched-chip sched-chip--pending">
                    YouTube will publish on upload
                  </span>
                </div>
                <div v-if="item.scheduled_for && item.type === 'episode'" class="unschedule-actions">
                  <button
                    class="btn-unschedule"
                    :disabled="unschedulingFor === item.episode_code"
                    title="Clear this publish time. Video stays private on YouTube so you can schedule it via YT Studio."
                    @click="doUnschedule(item, 'private')"
                  >✕ Clear</button>
                  <button
                    v-if="item.uploaded"
                    class="btn-unschedule danger"
                    :disabled="unschedulingFor === item.episode_code"
                    title="Publish now — flips this video to PUBLIC immediately. The schedule is cleared."
                    @click="doUnschedule(item, 'public')"
                  >▶ Publish now</button>
                </div>
              </template>
            </td>
            <td class="col-actions">
              <template v-if="item.type === 'episode'">
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
                    {{ rowBusy[item.id] === 'metadata' ? '…' : '↻ Metadata' }}
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
                      <button
                        v-if="item.uploaded"
                        class="rkm-item"
                        role="menuitem"
                        @click="doResetUploadState(item); closeRowMenu()"
                      >
                        <span class="rkm-icon">♻</span>
                        <div class="rkm-body">
                          <strong>Reset upload state</strong>
                          <span class="rkm-hint">Forget this episode's link to its YouTube video. Use when you uploaded to the wrong account or the video was deleted on YouTube. Next Upload creates a fresh video.</span>
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
          <label>Tags <span class="text-muted" style="font-size: 11px; font-weight: normal;">(comma-separated)</span></label>
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
    <div v-else-if="activeTab === 'missing'" class="card mt-2">
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
            title="Re-scan every episode for a final video file."
            @click="loadMissingVideoEpisodes"
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
              <button
                class="btn btn-sm btn-ghost"
                :disabled="legacyMarkInFlight === ep.episode_code"
                title="Mark this episode as already uploaded to YouTube (the video lives only there, no local file). Removes it from this list. Reversible from the Reconcile or Unlinked tabs if you ever pull it back in."
                @click="doMarkLegacyUploaded(ep)"
              >
                <LoadingSpinner v-if="legacyMarkInFlight === ep.episode_code" size="sm" />
                {{ legacyMarkInFlight === ep.episode_code ? 'Marking…' : '✓ Mark as uploaded' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ── Plans tab ──────────────────────────────────────────────────── -->
    <div v-else-if="activeTab === 'plans'" class="card mt-2">
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
            <span v-if="!youtubeAccounts.length" class="text-muted" style="font-size:11px">
              Connect a YouTube account on the Accounts tab first.
            </span>
          </div>
          <div class="form-group">
            <label>Time of day
              <span class="text-muted" style="font-size:11px; font-weight:normal">({{ editing.schedule.timezone }})</span>
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
            <span class="text-muted" style="font-size:11px">
              24-hour time. Use the arrow keys or the native picker to step in 15-minute increments.
            </span>
          </div>
          <div class="form-group">
            <label>Timezone
              <span class="text-muted" style="font-size:11px; font-weight:normal">
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
            <span class="text-muted" style="font-size:11px">
              {{ tzData.total }} IANA zones bundled offline (source: {{ tzData.source }}).
              Offsets shown for January — summer-time zones shift +1h in July.
            </span>
          </div>
          <div class="form-group full-row">
            <label>Weekdays
              <span class="text-muted" style="font-size:11px; font-weight:normal">
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
              <span class="text-muted" style="font-size:11px; font-weight:normal">(every N weeks)</span>
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
            <span class="text-muted" style="font-size:11px">
              When set, weekdays are ignored — e.g. 15 = the 15th of every month.
            </span>
          </div>
          <div class="form-group">
            <label>Start date</label>
            <input v-model="editing.schedule.start_date" class="input input-sm" type="date" />
            <span class="text-muted" style="font-size:11px">
              <strong>What it does:</strong> the first day this plan can fire a slot. Useful when the first
              episode in your queue should publish on a specific future date (e.g. "next Monday" for a season
              launch). <strong>Blank = start from today.</strong>
            </span>
          </div>
          <div class="form-group">
            <label>End date <span class="text-muted" style="font-size:11px; font-weight:normal">(optional)</span></label>
            <input v-model="editing.schedule.end_date" class="input input-sm" type="date" />
            <span class="text-muted" style="font-size:11px">
              <strong>What it does:</strong> last day this plan will fire a slot. After this date, Apply
              produces no more times. <strong>Blank = the plan runs indefinitely.</strong>
              Use when you want a bounded campaign (e.g. "stop after the season finale on Oct 31").
            </span>
          </div>
          <div class="form-group">
            <label>Default privacy
              <span class="text-muted" style="font-size:11px; font-weight:normal">(applied on upload)</span>
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
              <span class="text-muted" style="font-size:10px">({{ slot }})</span>
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
          <tr v-for="p in plans" :key="p.id">
            <td><strong>{{ p.name }}</strong></td>
            <td style="font-size: 12px;">
              <template v-if="p.schedule.monthly_day">
                Monthly · day {{ p.schedule.monthly_day }} at {{ p.schedule.time_local }} {{ p.schedule.timezone }}
              </template>
              <template v-else>
                {{ (p.schedule.weekdays || []).map(d => WEEKDAY_LABELS[d]).join(', ') || '—' }}
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
              <button
                class="btn btn-sm btn-primary"
                :disabled="applying || applyAndUploading || uploadMode === 'private'"
                :title="uploadMode === 'private'
                  ? 'Apply-plan is disabled while Schedule mode is set to \u201CUpload private, schedule in YouTube Studio\u201D. Change mode on the Accounts tab to re-enable.'
                  : `Distribute the current Upload Queue (${queueItems.length} items) across this plan's next ${queueItems.length} slots and PATCH any already-uploaded video's publishAt.`"
                @click="doApplyPlan(p)"
              >
                <LoadingSpinner v-if="applying" size="sm" />
                {{ applying ? 'Applying…' : (uploadMode === 'private' ? '🔒 Apply (disabled in private mode)' : '📅 Apply to Queue') }}
              </button>
              <!-- Bulk path: applies the plan AND fires uploads for every
                   not-yet-uploaded queue item, each carrying its planned
                   publishAt. After this single click YouTube handles the
                   publish moment server-side — Story Studio doesn't need
                   to be running. Disabled in private mode (publishAt is
                   never written there, so the bulk path makes no sense). -->
              <button
                class="btn btn-sm btn-primary"
                :disabled="applying || applyAndUploading || uploadMode === 'private'"
                :title="uploadMode === 'private'
                  ? 'Apply + Upload is disabled in private mode (no publishAt is written). Switch to Apply-plan mode on the Accounts tab.'
                  : `Apply this plan AND queue an upload for every not-yet-uploaded episode in the Queue (${queueItems.length} item${queueItems.length === 1 ? '' : 's'}). Each upload carries its planned publishAt, so YouTube auto-publishes at the scheduled time and the app can be off afterward.`"
                @click="doApplyAndUpload(p)"
              >
                <LoadingSpinner v-if="applyAndUploading" size="sm" />
                {{ applyAndUploading ? 'Working…' : '🚀 Apply + Upload all' }}
              </button>
              <button
                class="btn btn-sm btn-ghost"
                :disabled="applying || applyAndUploading"
                title="Remove any per-item schedule entries this plan applied. Useful if you applied the wrong plan and want to undo without deleting it."
                @click="doUnapplyPlan(p)"
              >↩ Unapply</button>
              <button class="btn btn-sm btn-ghost" @click="startEditPlan(p)">Edit</button>
              <button class="btn btn-sm btn-danger" @click="doDeletePlan(p)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ── Playlists tab (A4) ──────────────────────────────────────── -->
    <div v-else-if="activeTab === 'playlists'" class="card mt-2">
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
          <label>Description <span class="text-muted" style="font-size: 11px; font-weight: normal;">(optional)</span></label>
          <textarea v-model="newPlaylistForm.description" class="textarea" style="min-height: 60px; font-size: 12px;" />
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
              <input
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
              <div v-if="pl.description" class="text-muted" style="font-size: 11px;">{{ pl.description.slice(0, 120) }}{{ pl.description.length > 120 ? '…' : '' }}</div>
            </td>
            <td>
              <span :class="['meta-pill', pl.privacyStatus === 'public' ? 'ok' : pl.privacyStatus === 'unlisted' ? 'warn' : 'muted']">
                {{ pl.privacyStatus }}
              </span>
            </td>
            <td style="font-size: 12px;">{{ pl.itemCount }}</td>
            <td class="col-actions">
              <a :href="`https://www.youtube.com/playlist?list=${pl.id}`" target="_blank" rel="noopener" class="btn btn-sm btn-ghost">Open ↗</a>
              <button
                v-if="defaultPlaylistId === pl.id"
                class="btn btn-sm btn-ghost"
                title="Remove this playlist as the default. New uploads won't be auto-added to any playlist."
                @click="doSetDefaultPlaylist('')"
              >Clear default</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ── Reconcile tab ───────────────────────────────────────────── -->
    <div v-else-if="activeTab === 'reconcile'" class="card mt-2">
      <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 10px;">
        <div>
          <h3 style="margin: 0">Reconcile channel</h3>
          <p class="text-muted" style="font-size: 12px; margin: 4px 0 0; max-width: 720px;">
            Fetches up to ~400 recent videos from your default YouTube channel, fuzzy-matches them to local episodes, and lets you
            confirm the links. Confirmed matches write per-episode sidecars so <strong>re-uploading an episode from Story Studio
            patches metadata on the existing video</strong> (never creates a duplicate). Safe to re-run — videos already linked
            are marked below and skipped by default.
          </p>
        </div>
        <button class="btn btn-sm btn-primary" :disabled="reconcileLoading" @click="runReconcilePreview">
          <LoadingSpinner v-if="reconcileLoading" size="sm" />
          {{ reconcileLoading ? 'Fetching…' : '🔍 Fetch channel + preview' }}
        </button>
      </div>

      <div v-if="!reconcileState" class="text-muted mt-2" style="font-size: 13px;">
        Click <strong>Fetch channel + preview</strong> to pull recent videos and propose matches.
      </div>

      <div v-else class="mt-2">
        <div style="font-size: 12px; color: var(--text-secondary);">
          <strong>{{ reconcileState.remote_count }}</strong> channel video(s) ·
          <strong>{{ reconcileState.local_count }}</strong> local episode(s) ·
          <strong>{{ reconcileState.already_linked.length }}</strong> already linked via sidecar
        </div>

        <table class="queue-table mt-2">
          <thead>
            <tr>
              <th>Channel video</th>
              <th>Match confidence</th>
              <th>Link to episode</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in reconcileState.rows" :key="row.videoId">
              <td>
                <a :href="`https://youtu.be/${row.videoId}`" target="_blank" rel="noopener" class="video-link">
                  {{ row.title || '(untitled)' }}
                </a>
                <div class="text-muted" style="font-size: 11px;">
                  <code>{{ row.videoId }}</code>
                  <span v-if="row.publishedAt"> · published {{ new Date(row.publishedAt).toLocaleDateString() }}</span>
                  <span v-if="row.privacyStatus"> · {{ row.privacyStatus }}</span>
                </div>
              </td>
              <td>
                <span :class="[
                  'meta-pill',
                  row.reason === 'episode_code' ? 'ok' : row.reason === 'title_similarity' ? (row.score > 0.6 ? 'ok' : 'warn') : 'muted',
                ]">
                  {{ reasonLabel(row) }}
                </span>
              </td>
              <td>
                <select v-model="row.selected_episode_code" class="select select-sm" style="min-width: 140px;">
                  <option value="">— don't link —</option>
                  <option v-for="ep in missingVideoEpisodes.concat(queueItems.filter(i => i.type === 'episode'))"
                          :key="ep.episode_code" :value="ep.episode_code">
                    {{ ep.episode_code }} · {{ ep.title?.slice(0, 60) || '' }}
                  </option>
                </select>
                <!-- Inline "create new episode" escape hatch for Reconcile —
                     saves a trip to the Unlinked Uploads tab when the user
                     realizes this remote video doesn't match any local
                     episode. Bypasses the Save-selected-links flow and
                     adopts the video as a brand-new episode with the code
                     typed here. -->
                <div style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
                  <input
                    v-model="orphanCodeDraft[row.videoId]"
                    class="input input-sm"
                    style="max-width: 110px; font-size: 11px;"
                    :placeholder="`or new: TN${String(orphansNextNumber).padStart(4, '0')}`"
                    :title="`Type a new episode code + click Adopt to create a synthetic episode from this video. Use this when the remote video has no matching local episode and you want Story Studio to take over managing it. This is equivalent to the per-row Adopt on the Unlinked Uploads tab.`"
                  />
                  <button
                    class="btn btn-sm btn-secondary"
                    style="padding: 2px 8px; font-size: 11px;"
                    :disabled="orphanBusy || !orphanCodeDraft[row.videoId]?.trim()"
                    @click="doAdoptSingleOrphan({ videoId: row.videoId, title: row.title, publishedAt: row.publishedAt, privacyStatus: row.privacyStatus })"
                  >Adopt</button>
                </div>
              </td>
              <td class="col-actions">
                <span v-if="row.suggested_episode_code && row.selected_episode_code !== row.suggested_episode_code"
                      class="text-muted" style="font-size: 11px;" :title="`Matcher suggested ${row.suggested_episode_code}; you changed it.`">
                  ✎ edited
                </span>
              </td>
            </tr>
          </tbody>
        </table>

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
    <div v-else-if="activeTab === 'orphans'" class="card mt-2">
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
            <label class="text-muted" style="font-size: 11px;">
              <input type="checkbox" :checked="selectedOrphanIds.size === orphans.length" @change="selectAllOrphans(($event.target as HTMLInputElement).checked)" />
              Select all ({{ orphans.length }})
            </label>
            <strong v-if="selectedOrphanIds.size" style="font-size: 12px;">{{ selectedOrphanIds.size }} selected</strong>
          </div>
          <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
            <label class="text-muted" style="font-size: 11px;">
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
                <div class="text-muted" style="font-size: 11px;">
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

    <!-- Placeholder for not-yet-built tabs so the navigation reads honestly -->
    <div v-else class="card mt-2 tab-placeholder">
      <h3>{{ tabs.find(t => t.id === activeTab)?.label }}</h3>
      <p class="text-muted" style="font-size: 13px;">
        This tab arrives in Phase {{ tabs.find(t => t.id === activeTab)?.phase }} of the Upload Center rollout.
      </p>
    </div>

    <!-- Sticky bulk-action bar — appears when at least one queue row is
         ticked. Mirrors the Ideas Generator Accept bar (same Transition,
         same fixed positioning) so users build one mental model for
         "selection toolbar in this app". Each bulk button is enabled
         only when EVERY selected row supports that action — see the
         can*Bulk computeds. We deliberately keep the toolbar visible
         even when all bulk actions are disabled (with a hint) so the
         user understands why the click isn't working without having to
         open a tooltip per row. -->
    <Transition name="bulk-bar">
      <div v-if="activeTab === 'queue' && selectedQueueIds.size > 0" class="queue-bulk-bar" role="region" aria-label="Bulk upload actions">
        <span class="queue-bulk-bar-count">{{ selectedQueueIds.size }} selected</span>
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
        >↻ Metadata</button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="!canBulkPlaylist"
          :title="bulkPlaylistTitle"
          @click="doBulkPlaylist"
        >♫ Playlist</button>
        <button class="btn btn-ghost btn-sm" @click="selectedQueueIds.clear()">Clear</button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
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
  clientStatus,
  loading,
  youtubeAccounts,
  queueItems,
  queueLoading,
  queueTotal,
  queueTotalUnfiltered,
  queueTotalPages,
  queueLastParams,
  markLegacyUploaded,
  markLegacyUploadedBulk,
  loadQueue,
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
  quota,
  loadQuota,
  uploadMode,
  loadUploadMode,
  setUploadModeFor,
  editSchedule,
  unschedule,
  clearItemSchedule,
  resetUploadState,
  orphans,
  orphansNextNumber,
  orphansAlreadyLinked,
  orphansError,
  orphansLoading,
  loadOrphans,
  adoptSingleOrphan,
  adoptBulkOrphans,
  playlists,
  defaultPlaylistId,
  playlistsLoading,
  playlistsError,
  loadPlaylists,
  createPlaylistFor,
  setDefaultPlaylist,
  refreshAll,
  saveOAuthClient,
  clearOAuthClient,
  startOAuthFlow,
  waitForOAuthFlow,
  removeAccount,
  setDefault,
  triggerUpload,
  triggerMetadataUpdate,
  triggerPlaylistUpdate,
} = uploadApi

const { success, error: showError } = useToast()
const { ask } = useConfirm()

type TabId = 'accounts' | 'queue' | 'missing' | 'plans' | 'playlists' | 'reconcile' | 'orphans'
const tabs: Array<{ id: TabId; label: string; phase: number; disabled: boolean; hint?: string }> = [
  { id: 'accounts', label: 'Accounts', phase: 1, disabled: false, hint: 'Connect the YouTube channel for this project (single account).' },
  { id: 'queue', label: 'Upload Queue', phase: 2, disabled: false, hint: 'Per-episode queue with per-row upload. Re-running on an uploaded item updates metadata only.' },
  { id: 'missing', label: 'Missing Video', phase: 2, disabled: false, hint: 'Episodes whose final video isn’t on disk yet. Render via Video Assembly, drop a file via Import + Scan, or mark as already uploaded if the video lives only on YouTube (legacy episodes).' },
  { id: 'plans', label: 'Plans', phase: 3, disabled: false, hint: 'Saved schedule plans — pick weekdays + time, preview slots, apply to the queue.' },
  { id: 'playlists', label: 'Playlists', phase: 3, disabled: false, hint: 'Manage the YouTube playlists on your channel. Create new ones and pick a default that new uploads auto-add to.' },
  { id: 'reconcile', label: 'Reconcile', phase: 6, disabled: false, hint: 'Fetch channel videos, fuzzy-match to local episodes, confirm links. One-time per video \u2014 saved to sidecar.' },
  { id: 'orphans', label: 'Unlinked Uploads', phase: 7, disabled: false, hint: 'Channel videos that don\u2019t match any local episode. Adopt them one at a time or in bulk (continuation codes or full-system renumber).' },
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
//   filter = 'not_uploaded' — main use case is "show me what's left to upload"
//   sort   = 'code_asc'     — natural episode order
//   page   = 1, pageSize = 10
const queueFilter = ref<import('~/composables/useUploadAccounts').QueueFilter>('not_uploaded')
const queueSort   = ref<import('~/composables/useUploadAccounts').QueueSort>('code_asc')
const queuePage = ref(1)
const queuePageSize = ref<10 | 20 | 50 | 100>(10)

function goToQueuePage(n: number) {
  const clamped = Math.max(1, Math.min(queueTotalPages.value, Math.floor(n)))
  queuePage.value = clamped
  loadQueue({ page: clamped })
}

// When filter or sort changes, jump back to page 1 — the prior page
// number probably doesn't make sense in the new filtered list.
watch([queueFilter, queueSort], () => {
  queuePage.value = 1
  loadQueue({ filter: queueFilter.value, sort: queueSort.value, page: 1, pageSize: queuePageSize.value })
})
watch(queuePageSize, (s) => {
  queuePage.value = 1
  loadQueue({ pageSize: s, page: 1 })
})

// ── Missing Video tab state ──────────────────────────────────────────
// Search + client-side pagination (the missing-video endpoint returns
// the full list — much smaller than the queue's enriched payload, so a
// server-side page split here isn't worth the round-trip cost).
const missingLoading = ref(false)
const missingSearch = ref('')
const missingPage = ref(1)
const missingPageSize = ref<10 | 20 | 50 | 100>(20)
const legacyMarkInFlight = ref<string | null>(null)

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

async function doMarkLegacyUploaded(ep: { episode_code: string; title: string }) {
  // Confirm because this changes which episodes show as "needing attention"
  // — easy to misclick and confuse the operator later about why an
  // episode is missing from the missing-video list.
  const ok = await ask({
    title: `Mark ${ep.episode_code} as already uploaded?`,
    message: `Removes "${ep.title || ep.episode_code}" from this list. Use this for episodes uploaded to YouTube before Story Studio existed (no local video file). Reversible — flag is stored in the project config under youtube_legacy_uploaded.`,
    confirmLabel: 'Mark uploaded',
  })
  if (!ok) return
  legacyMarkInFlight.value = ep.episode_code
  try {
    await markLegacyUploaded(ep.episode_code, true)
    success(`${ep.episode_code} marked as already uploaded`)
    await loadMissingVideoEpisodes()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to mark episode as uploaded')
  } finally {
    legacyMarkInFlight.value = null
  }
}

// Refresh missing-video data when entering the tab so it's never stale
// (the user may have just rendered videos in another window).
watch(activeTab, (t) => {
  if (t === 'missing') {
    missingLoading.value = true
    loadMissingVideoEpisodes().finally(() => { missingLoading.value = false })
  }
})

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
function uploadJobFor(episode_code: string): { status: string; progress: number; error?: string | null } | null {
  const j = uploadJobByEpisode.value.get(episode_code)
  if (!j) return null
  return { status: j.status, progress: Number(j.progress) || 0, error: j.error }
}

// Auto-refresh the queue when any youtube_upload job we were tracking
// transitions to a terminal state. This is what closes the "clicked
// Upload but queue still says Not uploaded" loop — the sidecar file the
// job writes is only visible via re-fetching the queue endpoint.
const terminalSeen = new Set<string>()
watch(allJobs, (list) => {
  let needsRefresh = false
  for (const j of (list || []) as any[]) {
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
}, { deep: true })
watch(activeTab, (tab) => {
  if (tab === 'queue') {
    if (!queueItems.value.length) loadQueue('youtube')
    if (!importsFolder.value) loadImportsFolder()
    loadMissingVideoEpisodes()   // refresh every time; cheap, reflects post-scan state
    // Playlists are needed in the queue too for the per-row override
    // dropdown. Cheap (60s-cached) so no quota concerns.
    if (!playlists.value.length && youtubeAccounts.value.length) loadPlaylists()
  }
  if (tab === 'plans' && !plans.value.length) loadPlans()
  if (tab === 'playlists' && !playlists.value.length) loadPlaylists()
  if (tab === 'orphans') loadOrphans()
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
  } catch (e: any) {
    showError(e?.data?.detail || 'Bulk adopt failed')
  } finally {
    orphanConfirming.value = false
  }
}

// ── Playlists tab state (A4) ─────────────────────────────────────────────
const showCreatePlaylist = ref(false)
const newPlaylistForm = reactive<{ title: string; description: string; privacyStatus: 'public' | 'unlisted' | 'private' }>({
  title: '', description: '', privacyStatus: 'private',
})
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
const reconcileState = ref<null | {
  account_id: string
  remote_count: number
  local_count: number
  already_linked: string[]
  rows: Array<{
    videoId: string
    title: string
    publishedAt: string
    privacyStatus?: string
    suggested_episode_code: string | null
    selected_episode_code: string    // user-editable; empty = "don't link"
    score: number
    reason: string
  }>
}>(null)
const reconcileLoading = ref(false)
const reconcileConfirming = ref(false)

async function runReconcilePreview() {
  reconcileLoading.value = true
  try {
    const r = await reconcilePreview()
    reconcileState.value = {
      account_id: r.account_id,
      remote_count: r.remote_count,
      local_count: r.local_count,
      already_linked: r.already_linked,
      rows: r.suggestions.map((s: any) => ({
        videoId: s.remote.videoId,
        title: s.remote.title,
        publishedAt: s.remote.publishedAt,
        privacyStatus: s.remote.privacyStatus,
        suggested_episode_code: s.suggested_episode_code,
        selected_episode_code: s.suggested_episode_code || '',
        score: s.score,
        reason: s.reason,
      })),
    }
    success(`Fetched ${r.remote_count} channel video(s) · ${r.local_count} local episode(s) considered.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Reconcile preview failed')
  } finally {
    reconcileLoading.value = false
  }
}

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

  reconcileConfirming.value = true
  try {
    const r = await reconcileConfirm(s.account_id, links)
    const errCount = r.errors?.length || 0
    const okCount = r.written?.length || 0
    const msg = [`${okCount} link(s) saved`, errCount ? `${errCount} error(s)` : ''].filter(Boolean).join(' · ')
    success(msg)
    // Refresh queue so newly-linked episodes show as uploaded.
    await loadQueue('youtube')
    // Drop from the reconcile table.
    s.rows = s.rows.filter((row: any) => !r.written.includes(row.selected_episode_code))
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
  const set = new Set(editing.value.schedule.weekdays || [])
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
    showError(e?.data?.detail || 'Failed to save plan')
  }
}

async function runPreview() {
  if (!editing.value?.id) {
    showError('Save the plan first, then preview.')
    return
  }
  try {
    previewSlots.value = await previewPlan(editing.value.id, 10)
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

async function doApplyPlan(plan: any) {
  // Apply to every queue item in position order.
  if (!queueItems.value.length) await loadQueue('youtube')
  const episode_codes = queueItems.value.map((i: any) => i.episode_code)
  if (!episode_codes.length) {
    showError('No queue items to schedule. Assemble at least one final video first.')
    return
  }
  applying.value = true
  try {
    const r = await applyPlan(plan.id, episode_codes)
    const patchedOk = r.patched.filter((p: any) => p.ok).length
    const patchedFail = r.patched.length - patchedOk
    const msg = [
      `${r.assignments.length} items scheduled`,
      patchedOk ? `${patchedOk} live video(s) patched` : '',
      patchedFail ? `${patchedFail} patch failure(s)` : '',
    ].filter(Boolean).join(' · ')
    success(msg)
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to apply plan')
  } finally {
    applying.value = false
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
async function doApplyAndUpload(plan: any) {
  if (!queueItems.value.length) await loadQueue('youtube')
  const episode_codes = queueItems.value.map((i: any) => i.episode_code)
  if (!episode_codes.length) {
    showError('No queue items to schedule. Assemble at least one final video first.')
    return
  }
  applyAndUploading.value = true
  try {
    // Step 1 — apply schedule + PATCH already-uploaded.
    const r = await applyPlan(plan.id, episode_codes)
    const patchedOk = r.patched.filter((p: any) => p.ok).length
    const patchedFail = r.patched.length - patchedOk

    // Step 2 — derive the set that needs a fresh upload.
    const patchedSet = new Set(r.patched.map((p: any) => p.episode_code))
    const notYetUploaded = r.assignments.filter((a: any) => !patchedSet.has(a.episode_code))

    // Step 3 — guardrail: only upload episodes that have a final on
    // disk. queueItems already filters to publishable rows.
    const codeToItem = new Map(queueItems.value.map((i: any) => [i.episode_code, i]))
    const ready = notYetUploaded.filter((a: any) => codeToItem.has(a.episode_code))
    const skipped = notYetUploaded.length - ready.length

    if (ready.length === 0) {
      // Nothing to fan out — surface what just happened so the toast
      // doesn't go silent after a click.
      const parts = [
        `${r.assignments.length} item(s) scheduled`,
        patchedOk ? `${patchedOk} live video(s) patched` : '',
        patchedFail ? `${patchedFail} patch failure(s)` : '',
        skipped ? `${skipped} skipped (no final video on disk)` : '',
      ].filter(Boolean)
      success(parts.join(' · '))
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
        `${r.assignments.length} item(s) scheduled`,
        patchedOk ? `${patchedOk} live video(s) patched` : '',
        patchedFail ? `${patchedFail} patch failure(s)` : '',
      ].filter(Boolean)
      success(`${parts.join(' · ')} · upload step cancelled`)
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
      try {
        await triggerUpload({
          episode_id: a.episode_code,
          platform: 'youtube',
          privacy_status: 'private',
        })
        uploaded++
      } catch (e: any) {
        failed++
        const detail = e?.data?.detail || e?.message || 'unknown error'
        failures.push(`${a.episode_code}: ${detail}`)
      }
    }

    // Step 6 — summary toast.
    const summaryParts = [
      `📅 Scheduled ${r.assignments.length}`,
      patchedOk ? `↻ Patched ${patchedOk}` : '',
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
    } else {
      success(summaryParts)
    }
    await loadQueue('youtube')
  } catch (e: any) {
    // applyPlan failure (most likely past-slot validation) — abort
    // before any uploads. The detail message from the backend is
    // already actionable ("Edit the plan's start_date to today or later").
    showError(e?.data?.detail || 'Failed to apply plan')
  } finally {
    applyAndUploading.value = false
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
  if (item.uploaded) return 'Already uploaded — use ↻ Metadata to update title/description/tags, or ♫ Playlist to add to a playlist.'
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
  const ok = await confirmGeneration(slug.value, 'youtube_upload', {
    episode_id: item.episode_code,
    count: 1,
  })
  if (!ok) return
  rowBusy[item.id] = 'upload'
  try {
    await triggerUpload({
      episode_id: item.episode_code,
      platform: 'youtube',
      privacy_status: 'private',
      playlist_id: playlistOverrides[item.episode_code] ?? null,
    })
    success(`Upload job queued for ${item.episode_code}. Watch progress in the Jobs tab.`)
    setTimeout(() => { loadQueue('youtube'); loadQuota() }, 2000)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue upload')
  } finally {
    rowBusy[item.id] = null
  }
}

async function doUpdateMetadata(item: any) {
  if (!canUpdateMetadataRow(item)) return
  const ok = await confirmGeneration(slug.value, 'youtube_metadata_update', {
    episode_id: item.episode_code,
    count: 1,
  })
  if (!ok) return
  rowBusy[item.id] = 'metadata'
  try {
    await triggerMetadataUpdate({
      episode_id: item.episode_code,
      platform: 'youtube',
    })
    success(`Metadata update queued for ${item.episode_code} — privacy + schedule will stay as they are on YouTube.`)
    setTimeout(() => { loadQueue('youtube'); loadQuota() }, 2000)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue metadata update')
  } finally {
    rowBusy[item.id] = null
  }
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

// OAuth client form state — bound to inputs, flushed on Save.
const ytClientIdInput = ref('')
const ytClientSecretInput = ref('')
const canSaveClient = computed(() => !!ytClientIdInput.value.trim() && !!ytClientSecretInput.value.trim())

async function saveYoutubeClient() {
  try {
    await saveOAuthClient('youtube', ytClientIdInput.value.trim(), ytClientSecretInput.value.trim())
    ytClientIdInput.value = ''
    ytClientSecretInput.value = ''
    success('YouTube OAuth client saved — you can now connect an account.')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save OAuth client')
  }
}

async function clearYoutubeClient() {
  const ok = await ask({
    title: 'Clear YouTube OAuth client?',
    message: 'This removes the Google Cloud client_id + client_secret from this project. Connected accounts remain (their tokens still work) but you won\'t be able to connect new ones until you re-add a client.',
    confirmLabel: 'Clear',
    danger: true,
  })
  if (!ok) return
  try {
    await clearOAuthClient('youtube')
    success('OAuth client cleared.')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to clear OAuth client')
  }
}

// Connect-flow state — owns its own loading spinner + error message.
const connecting = ref(false)
const connectPhase = ref('')
const connectError = ref('')

async function connectYoutube() {
  connecting.value = true
  connectError.value = ''
  connectPhase.value = 'Preparing…'
  try {
    const { flow_id, auth_url } = await startOAuthFlow('youtube')
    connectPhase.value = 'Opened browser — waiting for consent…'
    // Open the system browser. In Electron this lands via the main-process
    // navigation handler; in dev (plain Nuxt) it opens a new tab.
    window.open(auth_url, '_blank', 'noopener,noreferrer')
    const r = await waitForOAuthFlow(flow_id)
    if (!r.ok) {
      connectError.value = r.error || 'OAuth flow failed'
      return
    }
    success('YouTube connected — account added below.')
  } catch (e: any) {
    connectError.value = e?.data?.detail || e?.message || 'Failed to connect'
  } finally {
    connecting.value = false
    connectPhase.value = ''
  }
}

async function disconnect(acc: any) {
  const ok = await ask({
    title: `Disconnect "${acc.remote_title}"?`,
    message: 'Removes the stored tokens and the account row. Videos already uploaded stay on YouTube unchanged.',
    confirmLabel: 'Disconnect',
    danger: true,
  })
  if (!ok) return
  try {
    await removeAccount(acc)
    success(`Disconnected ${acc.remote_title}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to disconnect')
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
    showError(e?.data?.detail || 'Failed to save schedule')
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
    showError(e?.data?.detail || 'Unschedule failed')
  } finally {
    unschedulingFor.value = null
  }
}

// ── Bulk clear + plan unapply (A3) ────────────────────────────────────────
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
  const ok = await ask({
    title: `Reset upload state for ${item.episode_code}?`,
    message: [
      'Clears the local upload record so the next Upload creates a fresh video on your currently-connected YouTube channel.',
      '',
      `Current remote: ${item.video_url || '(no video_id)'} — this video is NOT deleted; remove it manually in YouTube Studio if it\'s on the wrong account.`,
      '',
      'Use this when:',
      '• You uploaded to the wrong YouTube account by accident',
      '• You deleted the video on YouTube but Story Studio still thinks it\'s uploaded',
      '• You want to treat this episode as never-uploaded',
    ].join('\n'),
    confirmLabel: 'Reset state',
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

async function doUnapplyPlan(plan: any) {
  const ok = await ask({
    title: `Unapply plan "${plan.name}"?`,
    message: 'Clears the per-item scheduled times this plan would have produced for the current queue. YouTube videos keep their current live publishAt — use per-row actions if you want YT updated too.',
    confirmLabel: 'Unapply',
    danger: true,
  })
  if (!ok) return
  try {
    const r = await clearItemSchedule({ plan_id: plan.id, sync_youtube: false })
    success(`Unapplied "${plan.name}" — ${r.cleared} schedule entry/entries removed.`)
    await loadQueue('youtube')
  } catch (e: any) {
    showError(e?.data?.detail || 'Unapply failed')
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

onMounted(() => {
  refreshAll()
  loadQuota()
  loadUploadMode()
})
</script>

<style scoped>
.upload-header {
  display: flex; align-items: center; justify-content: space-between;
  padding-top: 16px;
  flex-wrap: wrap; gap: 10px;
}
.upload-header h1 { margin: 0; font-size: 22px; }

.quota-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 12px 0 4px;
  padding: 10px 12px;
  background: rgba(240, 140, 60, 0.10);
  border: 1px solid rgba(240, 140, 60, 0.30);
  border-left: 3px solid #e4903a;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
}
.quota-banner.block {
  background: rgba(248, 81, 73, 0.10);
  border-color: rgba(248, 81, 73, 0.40);
  border-left-color: #f85149;
}
.quota-banner.stale {
  background: rgba(196, 165, 60, 0.10);
  border-color: rgba(196, 165, 60, 0.35);
  border-left-color: #c4a53c;
}
.quota-icon { font-size: 14px; line-height: 1.4; flex-shrink: 0; }
.quota-text { flex: 1; line-height: 1.5; }
.quota-text strong { color: var(--text-primary); }
.quota-text a { color: var(--accent); text-decoration: none; }
.quota-text a:hover { text-decoration: underline; }

.upload-tabs {
  display: flex; gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-top: 12px;
}
.upload-tab {
  position: relative;
  padding: 8px 14px;
  border: none; background: none;
  color: var(--text-secondary);
  font-size: 13px; font-weight: 500;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}
.upload-tab:hover:not(:disabled) { color: var(--text-primary); }
.upload-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.upload-tab:disabled { cursor: not-allowed; opacity: 0.55; }
.tab-soon {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  background: var(--bg-tertiary);
  border-radius: 999px;
  color: var(--text-muted);
}

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
  font-size: 11px; font-weight: 500;
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

.oauth-client-details {
  margin: 6px 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
}
.oauth-client-details summary {
  cursor: pointer;
  display: flex; align-items: center; gap: 10px;
  font-size: 13px;
}
.oauth-client-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto auto;
  gap: 8px;
  align-items: end;
  margin-top: 10px;
}
.oauth-client-row .form-group { margin: 0; }
.oauth-client-row label {
  display: block; font-size: 11px; color: var(--text-muted);
  margin-bottom: 2px;
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
  font-size: 11px; font-weight: 600;
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
.col-actions { width: 1%; white-space: nowrap; text-align: right; }

/* Three-button cluster per row. Right-aligned, tight gap, wraps onto a
   second line on narrow viewports rather than overflowing the table. */
.row-actions {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  align-items: center;
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
.channel-thumb-lg { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }

.default-radio { accent-color: #3fb950; cursor: pointer; }
.default-radio:disabled { cursor: default; }

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

.queue-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.queue-table th {
  text-align: left;
  font-size: 11px; font-weight: 600;
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
  font-size: 11px;
  font-weight: 500;
  border-radius: 999px;
  margin-right: 4px;
}
.meta-pill.ok { background: rgba(46, 160, 67, 0.15); color: #3fb950; }
.meta-pill.warn { background: rgba(240, 140, 60, 0.15); color: rgb(228, 148, 66); }
.meta-pill.muted { background: var(--bg-tertiary); color: var(--text-muted); }

.video-link { color: var(--accent); text-decoration: none; font-weight: 500; }
.video-link:hover { text-decoration: underline; }

/* Live-job progress pill in the queue's Status column. */
.progress-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
}
.progress-pill.err { background: rgba(248, 81, 73, 0.15); color: #f85149; }
.progress-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
  animation: progressPulse 1.2s ease-in-out infinite;
}
@keyframes progressPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.type-chip {
  display: inline-block;
  padding: 1px 8px;
  font-size: 10px;
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
  font-size: 10px;
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
.sched-chip {
  display: inline-block;
  padding: 1px 6px;
  font-size: 10.5px;
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
  font-size: 10px;
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
.plan-grid .form-group label { display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 2px; }
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

.explainer {
  margin-top: 8px;
  padding: 8px 12px;
  font-size: 11px;
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
  font-size: 11px;
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
  font-size: 11px; font-weight: 600;
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
  font-size: 11px;
}
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
</style>

<!-- Unscoped — applies to the row-kebab menu after it teleports to <body>. -->
<style>
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
  font-size: 10px;
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
.rkm-hint { font-size: 11px; color: var(--text-muted); line-height: 1.35; }
</style>
