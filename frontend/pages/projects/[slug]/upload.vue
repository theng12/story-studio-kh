<template>
  <div>
    <div class="upload-header">
      <h1>▶ YouTube Upload</h1>
      <button class="btn btn-sm btn-ghost" :disabled="loading" @click="refreshAll">
        <LoadingSpinner v-if="loading" size="sm" />
        {{ loading ? 'Loading…' : '↻ Refresh' }}
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
          <button class="btn btn-sm btn-ghost" :disabled="queueLoading" @click="loadQueue('youtube')">
            <LoadingSpinner v-if="queueLoading" size="sm" />
            {{ queueLoading ? 'Loading…' : '↻ Refresh' }}
          </button>
        </div>
      </div>
      <p v-if="importsFolder" class="text-muted" style="font-size: 11px; margin: 4px 0 0;">
        Import folder: <code>{{ importsFolder }}</code>
      </p>

      <div v-if="queueLoading && !queueItems.length" class="text-muted mt-2" style="font-size: 13px;">
        Scanning episodes for final videos…
      </div>
      <div v-else-if="!queueItems.length" class="text-muted mt-2" style="font-size: 13px;">
        No episodes with a final video yet. Run Video Assembly or drop a rendered file into an episode's folder, then refresh.
      </div>

      <!-- Pagination (R5.1). Only shown when the queue exceeds the
           smallest page size — otherwise the controls add noise. -->
      <div v-else-if="queueItems.length > 10 || queuePageSize > 10" class="queue-pagination mt-2">
        <label class="pagination-label">
          Per page
          <select v-model.number="queuePageSize" class="select select-sm">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
        <div class="pagination-controls">
          <button class="btn btn-sm btn-secondary" :disabled="queuePage <= 1" @click="goToQueuePage(1)" title="First page">« First</button>
          <button class="btn btn-sm btn-secondary" :disabled="queuePage <= 1" @click="goToQueuePage(queuePage - 1)">← Prev</button>
          <span class="page-indicator">
            Page <strong>{{ queuePage }}</strong> of {{ queueTotalPages }}
            <span class="text-muted">· {{ queueItems.length }} item{{ queueItems.length === 1 ? '' : 's' }}</span>
          </span>
          <button class="btn btn-sm btn-secondary" :disabled="queuePage >= queueTotalPages" @click="goToQueuePage(queuePage + 1)">Next →</button>
          <button class="btn btn-sm btn-secondary" :disabled="queuePage >= queueTotalPages" @click="goToQueuePage(queueTotalPages)" title="Last page">Last »</button>
        </div>
      </div>

      <table v-if="queueItems.length" class="queue-table mt-2">
        <thead>
          <tr>
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
          <tr v-for="item in paginatedQueueItems" :key="item.id">
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
                <!-- Per-row playlist override (A5). Defaults to '' = use
                     project default; '_none_' = explicitly skip; or any
                     playlist ID. Only shown when uploading a fresh video
                     (re-uploads are metadata-only, adding to a playlist
                     mid-lifecycle would be noisy). -->
                <select
                  v-if="!item.uploaded && playlists.length"
                  v-model="playlistOverrides[item.episode_code]"
                  class="select select-sm playlist-select"
                  :title="`Add this video to a specific playlist. Leaving as 'Default' uses ${defaultPlaylistId ? `\u201C${playlists.find((p: any) => p.id === defaultPlaylistId)?.title || defaultPlaylistId}\u201D` : 'no playlist (no project default set)'} automatically.`"
                >
                  <option value="">Default</option>
                  <option value="_none_">Don't add</option>
                  <option v-for="pl in playlists" :key="pl.id" :value="pl.id">{{ pl.title }}</option>
                </select>
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="uploadingRow === item.id || (quota && !item.uploaded && quota.used >= quota.block_at)"
                  :title="quota && !item.uploaded && quota.used >= quota.block_at
                    ? `YouTube API quota nearly exhausted (${quota.used}/${quota.ceiling}). Wait for midnight Pacific reset, or request a higher quota in Google Cloud.`
                    : item.uploaded
                    ? 'Update title/description/tags/thumbnail on the existing YouTube video. The video content and URL stay the same — view count is preserved.'
                    : 'Uploads as private with publishAt from the active plan (if any). Use Plans tab to schedule across the full queue.'"
                  @click="doUpload(item)"
                >
                  <LoadingSpinner v-if="uploadingRow === item.id" size="sm" />
                  {{ uploadingRow === item.id ? 'Queuing…' : (item.uploaded ? '↻ Update metadata' : '📤 Upload') }}
                </button>
                <button
                  v-if="item.uploaded"
                  class="btn btn-sm btn-ghost"
                  title="Forget this episode's upload record. Use when you uploaded to the wrong YouTube account by accident, or the video was deleted on YouTube. The next Upload creates a fresh video on the currently-connected channel."
                  @click="doResetUploadState(item)"
                >♻ Reset</button>
              </template>
              <template v-else>
                <button class="btn btn-sm btn-secondary" title="Edit title / description / tags for this import." @click="startEditImport(item)">Edit</button>
                <button class="btn btn-sm btn-danger" title="Remove from queue AND delete the file from disk." @click="doRemoveImport(item)">✕</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Missing final video — import per-episode (Phase 5) -->
      <div v-if="missingVideoEpisodes.length" class="missing-video-section mt-3">
        <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 8px;">
          <div>
            <h4 style="margin: 0; font-size: 13px;">📥 Episodes missing a final video</h4>
            <p class="text-muted" style="font-size: 11px; margin: 4px 0 0;">
              These episodes don't have an assembled final video yet. You can either run <strong>Video Assembly</strong>,
              or drop an externally-rendered file into the episode's <code>Imported/</code> folder and click <strong>Scan</strong> —
              the file will move into the canonical <code>video/</code> folder as <code>{{ '{code}' }}_final_video.ext</code>
              and show up in the queue above on next refresh.
            </p>
          </div>
        </div>
        <table class="queue-table mt-2">
          <thead>
            <tr>
              <th>Episode</th>
              <th>Title</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ep in missingVideoEpisodes" :key="ep.episode_code">
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
                  :title="`Walk this episode's Imported/ folder. Every video file found will be moved into ${ep.episode_code}'s video/ folder as the canonical final render — reusing the broadened detection so the Pipeline + Queue stop marking this episode as pending.`"
                  @click="doEpisodeScan(ep)"
                >
                  <LoadingSpinner v-if="episodeScanInFlight === ep.episode_code" size="sm" />
                  {{ episodeScanInFlight === ep.episode_code ? 'Scanning…' : '📥 Import + Scan' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

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
                :disabled="applying || uploadMode === 'private'"
                :title="uploadMode === 'private'
                  ? 'Apply-plan is disabled while Schedule mode is set to \u201CUpload private, schedule in YouTube Studio\u201D. Change mode on the Accounts tab to re-enable.'
                  : `Distribute the current Upload Queue (${queueItems.length} items) across this plan's next ${queueItems.length} slots and PATCH any already-uploaded video's publishAt.`"
                @click="doApplyPlan(p)"
              >
                <LoadingSpinner v-if="applying" size="sm" />
                {{ applying ? 'Applying…' : (uploadMode === 'private' ? '🔒 Apply (disabled in private mode)' : '📅 Apply to Queue') }}
              </button>
              <button
                class="btn btn-sm btn-ghost"
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
} = uploadApi

const { success, error: showError } = useToast()
const { ask } = useConfirm()

type TabId = 'accounts' | 'queue' | 'plans' | 'playlists' | 'reconcile' | 'orphans'
const tabs: Array<{ id: TabId; label: string; phase: number; disabled: boolean; hint?: string }> = [
  { id: 'accounts', label: 'Accounts', phase: 1, disabled: false, hint: 'Connect the YouTube channel for this project (single account).' },
  { id: 'queue', label: 'Upload Queue', phase: 2, disabled: false, hint: 'Per-episode queue with per-row upload. Re-running on an uploaded item updates metadata only.' },
  { id: 'plans', label: 'Plans', phase: 3, disabled: false, hint: 'Saved schedule plans — pick weekdays + time, preview slots, apply to the queue.' },
  { id: 'playlists', label: 'Playlists', phase: 3, disabled: false, hint: 'Manage the YouTube playlists on your channel. Create new ones and pick a default that new uploads auto-add to.' },
  { id: 'reconcile', label: 'Reconcile', phase: 6, disabled: false, hint: 'Fetch channel videos, fuzzy-match to local episodes, confirm links. One-time per video \u2014 saved to sidecar.' },
  { id: 'orphans', label: 'Unlinked Uploads', phase: 7, disabled: false, hint: 'Channel videos that don\u2019t match any local episode. Adopt them one at a time or in bulk (continuation codes or full-system renumber).' },
]
const activeTab = ref<TabId>('accounts')

// ── Queue state (Phase 2) ─────────────────────────────────────────────
const uploadingRow = ref<string | null>(null)
const scanning = ref(false)

// Pagination (R5.1). Mirrors the pattern in pipeline.vue — purely
// client-side slicing, since loadQueue already loads the full list.
const queuePage = ref(1)
const queuePageSize = ref<10 | 20 | 50 | 100>(10)
const queueTotalPages = computed(() =>
  Math.max(1, Math.ceil(queueItems.value.length / queuePageSize.value)))
const paginatedQueueItems = computed(() => {
  const start = (queuePage.value - 1) * queuePageSize.value
  return queueItems.value.slice(start, start + queuePageSize.value)
})
function goToQueuePage(n: number) {
  queuePage.value = Math.max(1, Math.min(queueTotalPages.value, Math.floor(n)))
}
// Reset to page 1 when the page size changes; clamp when the list
// shrinks (e.g. after bulk clear or removing an import).
watch(queuePageSize, () => { queuePage.value = 1 })
watch(queueTotalPages, (tp) => { if (queuePage.value > tp) queuePage.value = tp })

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

// Per-row playlist override (A5). Keyed by episode_code; '_none_' sentinel
// overrides the project default to "don't add to any playlist"; empty
// string = fall through to project default.
const playlistOverrides = reactive<Record<string, string>>({})

async function doUpload(item: any) {
  uploadingRow.value = item.id
  try {
    await triggerUpload({
      episode_id: item.episode_code,
      platform: 'youtube',
      privacy_status: 'private',
      playlist_id: playlistOverrides[item.episode_code] ?? null,
    })
    success(`Upload job queued for ${item.episode_code}. Watch progress in the Jobs tab.`)
    // Re-fetch queue + quota; quota moved by ~1600 units after the
    // resumable session init, so the banner should update promptly.
    setTimeout(() => { loadQueue('youtube'); loadQuota() }, 2000)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue upload')
  } finally {
    uploadingRow.value = null
  }
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
</style>
