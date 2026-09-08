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
            <button class="btn btn-ghost btn-sm" type="button" :disabled="refreshingList" @click="refreshList">
              {{ refreshingList ? 'Refreshing…' : 'Refresh list' }}
            </button>
          </div>
        </header>

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
                v-if="renderState(ep) === 'ready'" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== ''" @click="preview(ep.episode_code)"
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

      <Modal :visible="!!previewed" size="lg" labelledby="upload-review-title" @close="closeReview">
        <section v-if="previewed" class="upload-review">
          <header class="review-head">
            <div>
              <h2 id="upload-review-title" ref="previewHeading" tabindex="-1">What YouTube will receive</h2>
              <p>{{ previewedEpisode }} · exact metadata review before upload</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" @click="closeReview">Close</button>
          </header>
          <p v-if="previewed.modifications.length" class="hint">
            {{ previewed.modifications.length }} change{{ previewed.modifications.length === 1 ? '' : 's' }} applied to your metadata:
          </p>
          <p v-else class="hint">Nothing in your metadata needed changing.</p>

        <ul v-if="previewed.modifications.length" class="changes">
          <li v-for="(change, i) in previewed.modifications" :key="i"><b>{{ change.field }}</b> — {{ change.reason }}</li>
        </ul>
        <ul v-if="previewed.warnings.length" class="warnings">
          <li v-for="(warning, i) in previewed.warnings" :key="i"><b>Warning:</b> {{ warning }}</li>
        </ul>

        <dl class="payload">
          <div><dt>Title</dt><dd>{{ previewed.snippet.title }}</dd></div>
          <div><dt>Description</dt><dd class="pre">{{ previewed.snippet.description }}</dd></div>
          <div><dt>Tags</dt><dd>{{ (previewed.snippet.tags || []).join(', ') || 'none' }}</dd></div>
          <div><dt>Category</dt><dd>{{ previewed.snippet.categoryId }}</dd></div>
          <div><dt>Privacy</dt><dd>{{ previewed.status.privacyStatus }}</dd></div>
          <div v-if="previewed.status.publishAt"><dt>Scheduled for</dt><dd>{{ previewed.status.publishAt }}</dd></div>
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
        <div v-if="uploadBlocked" class="hint">{{ uploadBlocked }}</div>
        <!--
          The page must refuse where the route refuses. Uploading an episode
          that is already on YouTube returns 409 ALREADY_IN_FLIGHT, so offering
          the button here would be an invitation to a guaranteed error - and
          YouTube has no replace, so the owner would reasonably read the button
          as a way to correct something.
        -->
        <div v-else-if="alreadyPublished" class="hint">{{ alreadyPublished }}</div>
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
  operation?: Operation
  local?: {
    render: { state: RenderState; video_url?: string }
    upload: { state: UploadState; job_id?: string; reason?: string }
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
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { ask } = useConfirm()

const loading = ref(true)
const loadError = ref('')
const busy = ref('')
const episodes = ref<PublishableEpisode[]>([])
const total = ref(0)
const filter = ref('')
const statusFilter = ref<StatusFilter>('all')
const sort = ref<SortMode>('episode_newest')
const rowResults = reactive<Record<string, { kind: 'ok' | 'warn' | 'err'; message: string }>>({})
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
function uploadState(ep: PublishableEpisode): UploadState {
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
function closeReview(): void { previewed.value = null; previewedEpisode.value = '' }

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
  const requestedSlug = slug.value
  const expectedChannelId = assignedChannel.value?.channel_id
  const expectedChannelTitle = assignedChannel.value?.title
  const expectedPackageRevision = previewed.value?.package_revision
  const confirmed = await ask({
    title: `Upload ${episodeCode} to YouTube?`,
    message: `This uploads ${episodeCode} to ${expectedChannelTitle || 'the assigned channel'} (${expectedChannelId || 'unknown'}). `
      + 'A video cannot be replaced once uploaded — only deleted and uploaded again under a new link.',
    confirmLabel: 'Upload',
  })
  if (!confirmed) return
  if (slug.value !== requestedSlug || previewedEpisode.value !== episodeCode
    || previewed.value?.package_revision !== expectedPackageRevision
    || assignedChannel.value?.channel_id !== expectedChannelId) return
  const action = beginAction('upload')
  delete rowResults[episodeCode]
  try {
    const res = await post<{ job_id: string; channel_id: string }>(
      `/projects/${requestedSlug}/youtube/upload`,
      {
        episode_code: episodeCode,
        confirm: true,
        expected_channel_id: expectedChannelId,
        expected_package_revision: expectedPackageRevision,
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

async function preview(episodeCode: string): Promise<void> {
  const action = beginAction(`preview-${episodeCode}`)
  delete rowResults[episodeCode]
  // Drop the previous payload BEFORE asking for the next one. Leaving it up
  // while a different episode's request is in flight — or after it fails —
  // shows one episode's exact payload while the reader believes they asked
  // about another.
  previewed.value = null
  previewedEpisode.value = ''
  try {
    const result = await post<Preview>(`/projects/${action.slug}/youtube/preview`, {
      // No `mark_as_ai_generated` here. The server resolves it from the
      // project's own setting; sending it was how the preview came to show a
      // disclosure the owner had turned off.
      episode_code: episodeCode, privacy_status: 'private',
    })
    if (!actionIsCurrent(action)) return
    previewed.value = result
    previewedEpisode.value = episodeCode
    await nextTick()
    previewHeading.value?.focus()
  } catch (error: any) {
    if (!actionIsCurrent(action)) return
    rowResults[episodeCode] = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not build the upload details.' }
  } finally {
    if (actionIsCurrent(action)) busy.value = ''
  }
}

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
  closeReview()
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
.head-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; }
.visible-count { color: var(--text-muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
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
.payload { display: grid; gap: 6px; margin: 0; max-height: min(55vh, 520px); overflow: auto; }
.payload > div { display: grid; grid-template-columns: minmax(120px, 160px) minmax(0, 1fr); gap: 12px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.payload dt, .payload dd { margin: 0; font-size: var(--font-xs); }
.payload dd { color: var(--text-secondary); overflow-wrap: anywhere; }
.payload dd.pre { white-space: pre-wrap; }

@container uc-publish (max-width: 880px) {
  .episode-columns { display: none; }
  .op { grid-template-columns: minmax(160px, 1.2fr) repeat(3, minmax(110px, 1fr)); }
  .fact-label { position: static; width: auto; height: auto; overflow: visible; clip: auto; white-space: normal; }
  .op-actions { grid-column: 1 / -1; justify-content: flex-start; }
}
@container uc-publish (max-width: 620px) {
  .uploads-head, .review-head { align-items: stretch; flex-direction: column; }
  .episode-tools { grid-template-columns: 1fr; }
  .sort-control { min-width: 0; }
  .op { grid-template-columns: 1fr 1fr; }
  .op-id, .publication-fact, .op-actions, .row-result { grid-column: 1 / -1; }
  .op-actions .btn { flex: 1 1 150px; }
  .payload > div { grid-template-columns: 1fr; }
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
}
</style>
