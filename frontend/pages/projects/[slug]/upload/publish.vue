<template>
  <div class="uc-publish">
    <p v-if="loading" class="hint">Loading this project’s uploads…</p>
    <div v-else-if="loadError" class="load-failure" role="alert">
      <p class="result err">{{ loadError }}</p>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="refreshingList" @click="refreshList">
        {{ refreshingList ? 'Retrying…' : 'Retry loading' }}
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
            <h3>{{ episodes.length === 0 ? 'Nothing ready to publish yet' : `${total} episode${total === 1 ? '' : 's'}` }}</h3>
            <p v-if="episodes.length" class="hint">Local files, upload work, and YouTube publication are shown separately.</p>
            <p v-else class="hint">An episode appears here once it is accepted. Render its final video in Video Assembly before uploading.</p>
          </div>
          <div class="head-actions">
            <span v-if="episodes.length" class="visible-count" aria-live="polite">{{ sortedEpisodes.length }} shown</span>
            <button
              v-if="episodes.length" class="btn btn-ghost btn-sm" type="button"
              :disabled="busy !== '' || !planCandidates.length || !!planBlocked"
              :title="planBlocked || (!planCandidates.length ? 'No visible video needs a planned date.' : '')"
              @click="planUnscheduledVideos"
            >
              {{ busy === 'plan-batch' ? 'Planning…' : `Plan unscheduled videos (${planCandidates.length})` }}
            </button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="refreshingList" @click="refreshList">
              {{ refreshingList ? 'Refreshing…' : 'Refresh list' }}
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
            {{ channelStatus === 'connected' ? 'Connected' : channelStatus === 'scope_upgrade_required' ? 'Permission upgrade required' : 'Reconnect required' }}
          </span>
        </div>
        <div v-else-if="!overviewError" class="channel-banner channel-missing" role="alert">
          <div>
            <strong>No YouTube channel assigned</strong>
            <span>These videos are ready locally, but Story Studio cannot upload them until this project has a channel.</span>
          </div>
          <NuxtLink :to="`/projects/${slug}/settings#youtube`" class="btn btn-ghost btn-sm">Assign channel</NuxtLink>
        </div>
        <p v-if="planResult" :class="['result', planResult.kind]" role="status">{{ planResult.message }}</p>

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

        <p v-if="total && !sortedEpisodes.length" class="empty-filter" role="status">
          No episodes match these filters. <button type="button" class="inline-action" @click="clearFilters">Clear filters</button>
        </p>
        <div v-if="sortedEpisodes.length" class="episode-columns" aria-hidden="true">
          <span>Episode</span><span>Local video</span><span>Upload</span><span>Publication</span><span>Actions</span>
        </div>
        <ul v-if="sortedEpisodes.length" class="op-list">
          <li v-for="ep in sortedEpisodes" :key="ep.episode_code" class="op" :data-episode-code="ep.episode_code">
            <div class="op-id">
              <strong>{{ ep.episode_code }}</strong>
              <span class="episode-title">{{ ep.title }}</span>
              <code v-if="ep.remote_video_id || ep.operation?.video_id" class="muted">{{ ep.remote_video_id || ep.operation?.video_id }}</code>
            </div>

            <div class="fact">
              <span class="fact-label">Local video</span>
              <span :class="['state-text', stateTone(renderState(ep))]">{{ renderLabel(ep) }}</span>
              <button v-if="playableVideoUrl(ep)" class="inline-action" type="button" @click="openVideo(ep)">Play local video</button>
              <NuxtLink v-else-if="renderState(ep) === 'missing'" class="inline-action" :to="videoAssemblyLink(ep)">Open Video Assembly</NuxtLink>
            </div>

            <div class="fact">
              <span class="fact-label">Upload</span>
              <span :class="['state-text', stateTone(uploadState(ep))]">{{ uploadLabel(ep) }}</span>
              <span v-if="uploadReason(ep)" class="fact-note">{{ uploadReason(ep) }}</span>
              <ProgressBar
                v-if="uploadProgress(ep)"
                class="upload-progress"
                :progress="uploadProgress(ep)?.progress"
                :bytes-done="uploadProgress(ep)?.bytes_done"
                :bytes-total="uploadProgress(ep)?.bytes_total"
                :speed-bps="uploadProgress(ep)?.speed_bps"
                :eta-seconds="uploadProgress(ep)?.eta_seconds"
                :indeterminate="uploadProgress(ep)?.progress == null && uploadProgress(ep)?.bytes_total == null"
                :label="uploadState(ep) === 'queued' ? 'Waiting to upload' : 'Uploading to YouTube'"
              />
              <NuxtLink v-if="uploadProgress(ep)" class="inline-action" :to="`/projects/${slug}/jobs`">View in Jobs</NuxtLink>
              <span v-if="uploadProgress(ep) && jobsStale" class="fact-note">Progress may be out of date.</span>
            </div>

            <div class="fact publication-fact">
              <span class="fact-label">Publication</span>
              <span :class="['state-text', stateTone(publicationState(ep))]">{{ publicationLabel(ep) }}</span>
              <span v-if="publicationDate(ep)" class="fact-note">{{ publicationDate(ep) }}</span>
              <span v-if="plannedDate(ep)" class="fact-note">Plan: {{ plannedDate(ep) }}</span>
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
              <button
                v-if="canScheduleExisting(ep)" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== '' || !!scheduleBlocked" :title="scheduleBlocked || ''"
                @click="preview(ep.episode_code, $event, 'schedule')"
              >
                {{ busy === `preview-${ep.episode_code}` ? 'Preparing…' : 'Schedule publication' }}
              </button>
              <button
                v-if="renderState(ep) === 'ready'" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== ''" @click="preview(ep.episode_code, $event)"
              >
                {{ busy === `preview-${ep.episode_code}` ? 'Preparing…' : 'Review upload details' }}
              </button>
            </div>
            <p v-if="ep.blocked_reason" class="row-result warn">{{ ep.blocked_reason }}</p>
            <p v-if="rowResults[ep.episode_code]" :class="['row-result', rowResults[ep.episode_code].kind]" role="status">
              {{ rowResults[ep.episode_code].message }}
            </p>
          </li>
        </ul>
        <!-- Spec section 17: disable only the REMOTE actions, and say why. The
             local records above stay fully readable either way. -->
        <p v-if="remoteBlocked" class="result warn">{{ remoteBlocked }}</p>
        <p v-if="overviewError" class="result warn">{{ overviewError }} Local video facts remain available.</p>
        <p class="hint">Checking with YouTube spends this Cloud project’s daily allowance. Nothing here checks on its own.</p>
      </section>

      <Modal :visible="!!previewed" size="lg" labelledby="upload-review-title" @close="closeReview()">
        <section v-if="previewed" class="upload-review">
          <header class="review-head">
            <div>
              <h2 id="upload-review-title" ref="previewHeading" tabindex="-1">What YouTube will receive</h2>
              <p>{{ previewedEpisode }} · exact metadata review before upload</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="closeReview()">Close</button>
          </header>
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
              {{ busy.startsWith('timing-') ? 'Reviewing…' : 'Review this time' }}
            </button>
          </div>
            <button
              v-if="!plannedPublishAt && reviewIntent === 'upload'"
            class="inline-action" type="button" :disabled="busy !== '' || !!planBlocked"
            @click="useNextPlanSlot"
          >
            Use the next date from this channel’s upload plan
          </button>
          <p v-if="timingError" class="row-result err" role="alert">{{ timingError }}</p>
          <p v-else-if="timingDirty" class="hint" role="status">Review this timing choice to rebuild the exact YouTube payload before continuing.</p>
        </section>

        <ul v-if="previewed.modifications.length" class="changes">
          <li v-for="(change, i) in previewed.modifications" :key="i"><b>{{ change.field }}</b> — {{ change.reason }}</li>
        </ul>
        <ul v-if="previewed.warnings.length" class="warnings">
          <li v-for="(warning, i) in previewed.warnings" :key="i"><b>Warning:</b> {{ warning }}</li>
        </ul>

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
            <div class="selected-thumbnail">
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
          </template>
          <div v-else-if="previewed.thumbnail.state === 'unavailable'" class="thumbnail-unavailable" role="status">
            <strong>{{ previewed.thumbnail.filename }}</strong>
            <span>{{ previewed.thumbnail.reason || 'The selected thumbnail is unavailable.' }}</span>
          </div>
          <div v-else class="thumbnail-unavailable" role="status">
            <strong>No thumbnail is selected for this upload.</strong>
            <span>Choose or generate one if you want Story Studio to set a thumbnail on YouTube.</span>
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
          <NuxtLink class="thumbnail-generator-link" :to="thumbnailGeneratorLink(previewedEpisode)">
            Open {{ previewedEpisode }} in Thumbnail Generator
          </NuxtLink>
        </section>

        <dl class="payload">
          <div><dt>Title</dt><dd>{{ previewed.snippet.title }}</dd></div>
          <div><dt>Description</dt><dd class="pre">{{ previewed.snippet.description }}</dd></div>
          <div><dt>Tags</dt><dd>{{ (previewed.snippet.tags || []).join(', ') || 'none' }}</dd></div>
          <div><dt>Category</dt><dd>{{ previewed.snippet.categoryId }}</dd></div>
          <div><dt>Privacy</dt><dd>{{ previewed.status.privacyStatus }}</dd></div>
          <div v-if="previewed.status.publishAt">
            <dt>Scheduled for</dt>
            <dd><strong>{{ formatZonedWhen(previewed.status.publishAt, timingTimezone) }}</strong><small>{{ previewed.status.publishAt }}</small></dd>
          </div>
          <div><dt>Marked as AI-generated</dt><dd>{{ previewed.status.containsSyntheticMedia ? 'yes' : 'no' }}</dd></div>
        </dl>
        <p class="hint">Nothing is changed after this point. This is the payload.</p>

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
        <div v-else-if="timingDirty" class="hint">Review the selected timing above before continuing.</div>
        <div v-else-if="reviewIntent === 'schedule' && !previewed.status.publishAt" class="hint">Choose a future planned or custom date to schedule this private video.</div>
        <div v-else-if="reviewIntent === 'schedule'" class="field-row upload-row">
          <button class="btn btn-primary" type="button" :disabled="busy !== ''" @click="scheduleExisting">
            {{ busy === 'schedule' ? 'Scheduling…' : 'Schedule on YouTube' }}
          </button>
          <span class="hint">Updates the existing video after YouTube confirms it is private. It does not upload the video again.</span>
        </div>
        <div v-else-if="previewed.thumbnail.state === 'unavailable' || thumbnailImageUnavailable" class="hint">
          Choose an available thumbnail before uploading.
        </div>
        <div v-else class="field-row upload-row">
          <button class="btn btn-primary" type="button" :disabled="busy !== ''" @click="upload(previewedEpisode)">
            {{ busy === 'upload' ? 'Uploading…' : 'Upload to YouTube' }}
          </button>
          <span class="hint">Uploads {{ previewedEpisode }} to the channel this project is assigned to.</span>
        </div>
        <p v-if="rowResults[previewedEpisode]" :class="['row-result', rowResults[previewedEpisode].kind]" role="status">
          {{ rowResults[previewedEpisode].message }}
        </p>
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
type StatusFilter = 'all' | 'ready' | 'missing' | 'in_progress' | 'planned' | 'uploaded' | 'scheduled' | 'published' | 'attention'
type SortMode = 'episode_newest' | 'episode_oldest' | 'schedule_soonest' | 'status'
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
  snippet: { title: string; description?: string; tags?: string[]; categoryId?: string }
  status: { privacyStatus: string; publishAt?: string; containsSyntheticMedia?: boolean }
  modifications: Array<{ field: string; reason: string }>
  warnings: string[]
  thumbnail: {
    state: 'selected' | 'none' | 'unavailable'
    filename?: string
    url?: string
    reason?: string
    options: Array<{ filename: string; url: string; is_pinned?: boolean }>
  }
}

function normalizePreview(value: Preview): Preview {
  return {
    ...value,
    thumbnail: value.thumbnail || { state: 'none', options: [] },
  }
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { ask } = useConfirm()
const { jobs, jobsStale } = useJobs()

const loading = ref(true)
const loadError = ref('')
const busy = ref('')
const episodes = ref<PublishableEpisode[]>([])
const total = ref(0)
const filter = ref('')
const statusFilter = ref<StatusFilter>('all')
const sort = ref<SortMode>('episode_newest')
const rowResults = reactive<Record<string, { kind: 'ok' | 'warn' | 'err'; message: string }>>({})
const planResult = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)
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
const statusOptions = computed(() => ([
  { key: 'all' as const, label: 'All', count: episodes.value.length },
  { key: 'ready' as const, label: 'Ready to upload', count: countStatus('ready') },
  { key: 'missing' as const, label: 'Missing video', count: countStatus('missing') },
  { key: 'in_progress' as const, label: 'In progress', count: countStatus('in_progress') },
  { key: 'planned' as const, label: 'Planned', count: countStatus('planned') },
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
const previewHeading = ref<HTMLElement | null>(null)
const reviewOpener = ref<HTMLElement | null>(null)
const thumbnailImageUnavailable = ref(false)
const thumbnailError = ref('')
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
function uploadLabel(ep: PublishableEpisode): string { return UPLOAD_LABELS[uploadState(ep)] }
function publicationLabel(ep: PublishableEpisode): string {
  const state = publicationState(ep)
  const visibility = ep.publication?.visibility
  return `${PUBLICATION_LABELS[state]}${visibility ? ` · ${visibility}` : ''}`
}
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

function isFutureIso(value: string | undefined): value is string {
  if (!value) return false
  const at = new Date(value).getTime()
  return Number.isFinite(at) && at > Date.now()
}
const selectedEpisode = computed(() => episodes.value.find(ep => ep.episode_code === previewedEpisode.value) || null)
const plannedPublishAt = computed(() => isFutureIso(selectedEpisode.value?.plan?.scheduled_at)
  ? selectedEpisode.value!.plan!.scheduled_at!
  : '')
function canScheduleExisting(ep: PublishableEpisode): boolean {
  return ep.can_schedule_existing === true && publicationState(ep) === 'uploaded'
}
const scheduleVisibilityUnknown = computed(() => reviewIntent.value === 'schedule'
  && !!selectedEpisode.value
  && !selectedEpisode.value.publication?.visibility)
function publicationDate(ep: PublishableEpisode): string {
  if (ep.publication?.published_at) return `Published ${formatZonedWhen(ep.publication.published_at)}`
  if (ep.publication?.scheduled_at) return formatZonedWhen(ep.publication.scheduled_at, ep.plan?.timezone)
  return ''
}
function plannedDate(ep: PublishableEpisode): string {
  if (!ep.plan?.scheduled_at) return ''
  return formatZonedWhen(ep.plan.scheduled_at, ep.plan.timezone)
}
function lastCheckedLabel(ep: PublishableEpisode): string {
  const checkedAt = ep.publication?.last_checked_at || ep.operation?.processing?.checked_at
  if (checkedAt) return `Checked ${formatWhen(checkedAt)}`
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
  if (key === 'planned') return !!ep.plan?.scheduled_at && publicationState(ep) !== 'scheduled'
  if (key === 'uploaded') return publicationState(ep) === 'uploaded'
  if (key === 'scheduled') return publicationState(ep) === 'scheduled'
  if (key === 'published') return publicationState(ep) === 'published'
  if (key === 'attention') return renderState(ep) === 'unknown'
    || ['failed', 'unknown'].includes(uploadState(ep))
    || ['failed', 'rejected', 'unknown'].includes(publicationState(ep))
  if (renderState(ep) !== 'ready' || ep.blocked_reason) return false
  if (uploadState(ep) === 'none' && publicationState(ep) === 'unpublished') return true
  const hasRemoteIdentity = !!(ep.has_remote_video || ep.remote_video_id || ep.operation?.video_id)
  return uploadState(ep) === 'failed' && ['failed', 'rejected'].includes(publicationState(ep)) && !hasRemoteIdentity
}
function countStatus(key: StatusFilter): number { return episodes.value.filter(ep => matchesStatus(ep, key)).length }
function clearFilters(): void { filter.value = ''; statusFilter.value = 'all' }
function openVideo(ep: PublishableEpisode): void { if (playableVideoUrl(ep)) videoEpisode.value = ep }
function closeVideo(): void { videoEpisode.value = null; videoError.value = '' }
function closeReview(restoreFocus = true): void {
  const opener = reviewOpener.value
  reviewOpener.value = null
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

interface UploadPlan {
  id: string
  name: string
  platform: string
  account_id: string
  schedule?: { timezone?: string }
}
interface PlanAssignment { episode_code: string; publishAt: string }

async function assignPlanDates(episodeCodes: string[], busyLabel: string): Promise<{ assignments: PlanAssignment[]; timezone: string } | null> {
  const channelId = assignedChannel.value?.channel_id
  if (!episodeCodes.length || !channelId || busy.value) return null
  const action = beginAction(busyLabel)
  try {
    const listed = await get<{ plans: UploadPlan[]; active: Record<string, string> }>(`/projects/${action.slug}/upload/plans`)
    if (!actionIsCurrent(action)) return null
    const planId = listed.active?.[`youtube:registry:${channelId}`]
    const plan = listed.plans.find(candidate => candidate.id === planId)
    if (!plan) throw new Error('This channel does not have an active upload plan. Create or activate one in Settings → Publishing.')
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
      .map(item => `${item.episode_code}: ${formatZonedWhen(item.publishAt, zone)} (${item.publishAt})`)
      .join('\n')
    const confirmed = await ask({
      title: previewResult.assignments.length === 1 ? `Use the next ${plan.name} date?` : `Plan ${previewResult.assignments.length} unscheduled videos?`,
      message: `The plan currently proposes:\n${proposedDates}\n\nStory Studio will check current claims again before saving. These are local planned dates; each YouTube upload or existing private video still needs its own confirmation.`,
      confirmLabel: previewResult.assignments.length === 1 ? 'Use planned date' : 'Save planned dates',
    })
    if (!actionIsCurrent(action)) return null
    if (!confirmed) return null
    const applied = await post<{ assignments: PlanAssignment[]; skipped_existing: string[] }>(
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
    return { assignments: applied.assignments, timezone: zone }
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
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
    timingMode.value = 'planned'
    await rebuildTimingPreview('planned')
  } catch (error: any) {
    timingError.value = error?.data?.detail || error?.message || 'Could not use the next upload plan date.'
  }
}

const planCandidates = computed(() => visibleEpisodes.value.filter(ep => {
  if (isFutureIso(ep.plan?.scheduled_at) || renderState(ep) !== 'ready') return false
  if (canScheduleExisting(ep)) return true
  const hasRemote = !!(ep.has_remote_video || ep.remote_video_id || ep.operation?.video_id)
  return !hasRemote && !ep.blocked_reason && ['none', 'failed'].includes(uploadState(ep))
    && ['unpublished', 'failed', 'rejected'].includes(publicationState(ep))
}))

async function planUnscheduledVideos(): Promise<void> {
  const codes = [...planCandidates.value]
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
      message: `Saved local planned dates for ${result.assignments.length} video${result.assignments.length === 1 ? '' : 's'}. YouTube has not been changed; confirm each upload or private-video schedule separately.`,
    }
  } catch (error: any) {
    planResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not plan those videos.' }
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
  if (!channelStatus.value) return 'This project has no assigned YouTube channel, so it cannot upload.'
  if (channelStatus.value === 'reconnect_required') return 'Reconnect this channel in Settings before uploading.'
  if (channelStatus.value === 'scope_upgrade_required') return 'This channel needs its permissions upgraded in Settings before Story Studio can upload.'
  if (quotaUnavailableReason.value === 'ledger_unreadable') return 'Uploads and other provider writes are paused until the local allowance record is repaired.'
  if (uploadQuotaExhausted.value) return 'Today’s upload allowance for this Google Cloud project is used up. Uploading resumes after it resets.'
  return ''
})

const remoteBlocked = computed(() => {
  if (overviewError.value) return 'YouTube connection status is unavailable, so remote checks are paused.'
  if (!channelStatus.value) return 'This project has no assigned YouTube channel, so it cannot check anything on YouTube.'
  if (channelStatus.value === 'reconnect_required') return 'Reconnect this channel in Settings before checking anything on YouTube.'
  if (channelStatus.value === 'scope_upgrade_required') return 'This channel needs its permissions upgraded in Settings before Story Studio can read from YouTube.'
  if (quotaExhausted.value) return 'Today’s allowance for this Google Cloud project is used up. Checking resumes after it resets.'
  return ''
})

const scheduleBlocked = computed(() => {
  if (overviewError.value) return 'YouTube connection status is unavailable, so scheduling is paused.'
  if (!channelStatus.value) return 'This project has no assigned YouTube channel, so it cannot schedule a video.'
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
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load this project’s uploads.'
  } finally {
    if (revision === loadRevision && requestedSlug === slug.value) loading.value = false
  }
}

async function refreshList(): Promise<void> {
  refreshingList.value = true
  try { await load() } finally { refreshingList.value = false }
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
    const res = await post<{ state: { lifecycle: string }; persisted: boolean }>(
      `/projects/${action.slug}/youtube/operations/${op.operation_id}/refresh`, {},
    )
    if (!actionIsCurrent(action)) return
    // A status we could not get is not a verdict, and the copy says so.
    rowResults[op.episode_code] = res.state.lifecycle === 'status_unavailable'
      ? { kind: 'warn', message: `${op.episode_code}: YouTube did not return this video. Its last known state is kept.` }
      : { kind: 'ok', message: `${op.episode_code}: ${lifecycleLabel(res.state.lifecycle)}.` }
    await load()
  } catch (error: any) {
    if (!actionIsCurrent(action)) return
    rowResults[op.episode_code] = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not check that video.' }
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
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
  if (previewed.value?.thumbnail.state === 'unavailable' || thumbnailImageUnavailable.value || timingDirty.value) return
  const requestedSlug = slug.value
  const expectedChannelId = assignedChannel.value?.channel_id
  const expectedChannelTitle = assignedChannel.value?.title
  const expectedPackageRevision = previewed.value?.package_revision
  const expectedThumbnailFilename = previewed.value?.thumbnail.state === 'selected'
    ? previewed.value.thumbnail.filename || null
    : null
  const expectedPrivacyStatus = previewed.value?.status.privacyStatus || 'private'
  const expectedPublishAt = previewed.value?.status.publishAt
  if (expectedPublishAt && !isFutureIso(expectedPublishAt)) {
    timingDirty.value = true
    timingError.value = 'This scheduled time has passed. Choose and review a new future time before uploading.'
    return
  }
  const timingConfirmation = expectedPublishAt
    ? `Scheduled for ${formatZonedWhen(expectedPublishAt, timingTimezone.value)} (${expectedPublishAt}). `
    : 'This video will stay private until you schedule or publish it. '
  const confirmationAction = beginAction('confirm-upload')
  const confirmed = await ask({
    title: `Upload ${episodeCode} to YouTube?`,
    message: `This uploads ${episodeCode} to ${expectedChannelTitle || 'the assigned channel'} (${expectedChannelId || 'unknown'}). `
      + timingConfirmation
      + `Thumbnail: ${expectedThumbnailFilename || 'none selected'}. `
      + 'A video cannot be replaced once uploaded — only deleted and uploaded again under a new link.',
    confirmLabel: 'Upload',
  })
  if (!actionIsCurrent(confirmationAction)) return
  if (!confirmed) { busy.value = ''; return }
  if (slug.value !== requestedSlug || previewedEpisode.value !== episodeCode
    || previewed.value?.package_revision !== expectedPackageRevision
    || previewed.value?.status.privacyStatus !== expectedPrivacyStatus
    || previewed.value?.status.publishAt !== expectedPublishAt
    || (previewed.value?.thumbnail.state === 'selected' ? previewed.value.thumbnail.filename || null : null) !== expectedThumbnailFilename
    || assignedChannel.value?.channel_id !== expectedChannelId) { busy.value = ''; return }
  busy.value = 'upload'
  const action = confirmationAction
  delete rowResults[episodeCode]
  try {
    const res = await post<{ job_id: string; channel_id: string }>(
      `/projects/${requestedSlug}/youtube/upload`,
      {
        episode_code: episodeCode,
        confirm: true,
        expected_channel_id: expectedChannelId,
        expected_package_revision: expectedPackageRevision,
        thumbnail_filename: expectedThumbnailFilename,
        privacy_status: expectedPrivacyStatus,
        ...(expectedPublishAt ? { publish_at: expectedPublishAt } : {}),
      },
    )
    if (!actionIsCurrent(action)) return
    rowResults[episodeCode] = {
      kind: 'ok',
      message: `Uploading ${episodeCode} to ${res.channel_id}. Progress appears in Jobs.`,
    }
    await load()
  } catch (error: any) {
    if (!actionIsCurrent(action)) return
    rowResults[episodeCode] = { kind: 'err', message: error?.data?.detail || error?.message || 'Failed to start that upload.' }
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
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
    confirmLabel: 'Schedule video',
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
  reviewIntent.value = intent
  customDateTime.value = ''
  customMinimum.value = localDateTimeValue(new Date(Date.now() + 60_000))
  timingError.value = ''
  const episode = episodes.value.find(item => item.episode_code === episodeCode)
  const initialMode: TimingMode = isFutureIso(episode?.plan?.scheduled_at) ? 'planned' : 'private'
  timingMode.value = initialMode
  timingDirty.value = true
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
    timingTimezone.value = initialMode === 'planned' ? episode?.plan?.timezone || deviceTimezone : deviceTimezone
    timingDirty.value = false
    await nextTick()
    previewHeading.value?.focus()
  } catch (error: any) {
    if (!actionIsCurrent(action)) return
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
  filter.value = ''
  statusFilter.value = 'all'
  planResult.value = null
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
.result.err, .row-result.err { color: var(--danger); }
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
.episode-title { color: var(--text-secondary); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.fact-label {
  position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0);
  white-space: nowrap; border: 0; color: var(--text-muted); font-size: var(--font-xs); font-weight: 700;
}
.state-text { font-size: 12px; font-weight: 700; }
.tone-success { color: var(--success); }
.tone-info { color: var(--text-secondary); }
.tone-danger { color: var(--danger); }
.tone-muted { color: var(--text-muted); }
.fact-note { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; overflow-wrap: anywhere; }
.upload-progress { margin-top: 3px; min-width: 120px; }
.op-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.row-result { grid-column: 1 / -1; margin: 0; padding-top: 7px; border-top: 1px solid var(--border); line-height: 1.5; }

.upload-review, .video-review { display: grid; gap: 14px; min-width: 0; }
.review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.review-head h2 { margin: 0; font-size: 18px; }
.review-head h2:focus { outline: none; }
.review-head p { margin: 4px 0 0; color: var(--text-muted); font-size: var(--font-xs); }
.video-review video { width: 100%; max-height: min(65vh, 560px); border-radius: var(--radius-sm); background: #000; }
.changes, .warnings { display: grid; gap: 4px; margin: 0; padding-left: 18px; font-size: var(--font-xs); }
.warnings { color: var(--warning, #d97706); }
.publishing-review { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
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
  .upload-review .review-head, .video-review .review-head { align-items: stretch; flex-direction: column; }
  .upload-review .payload > div { grid-template-columns: 1fr; }
  .timing-options { grid-template-columns: 1fr; }
  .selected-thumbnail { grid-template-columns: 1fr; }
  .thumbnail-options { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 390px) {
  .thumbnail-review-head { align-items: stretch; flex-direction: column; }
  .thumbnail-options { grid-template-columns: 1fr; }
}
</style>
