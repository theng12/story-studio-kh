<template>
  <div class="uc-library">
    <p v-if="loading" class="hint">Loading this project’s published videos…</p>
    <p v-else-if="loadError" class="result err">{{ loadError }}</p>

    <template v-else>
      <section v-if="emptyCopy" class="panel empty" role="status">
        <h3>{{ emptyCopy.heading }}</h3>
        <p>{{ emptyCopy.body }}</p>
      </section>

      <section v-else class="panel inventory">
        <div>
          <span class="eyebrow">Published</span>
          <h3>{{ videos.length }} video{{ videos.length === 1 ? '' : 's' }} on YouTube</h3>
          <p class="hint">
            Each row compares what Story Studio intends, what YouTube said last time, and what it
            says now. Looking at this list does not contact YouTube — use Sync on the Overview.
            The one button here that does change YouTube is “Update YouTube”, and it asks first.
          </p>
        </div>

        <ul class="video-list">
          <li v-for="video in videos" :key="video.operation_id" class="video">
            <div class="video-head">
              <div class="video-id">
                <strong>{{ video.episode_code }}</strong>
                <code class="muted">{{ video.video_id }}</code>
              </div>
              <div class="video-state">
                <span :class="['badge', video.comparison.needs_attention ? 'attention' : 'settled']">
                  {{ video.comparison.needs_attention ? 'Needs a decision' : 'Settled' }}
                </span>
                <span class="hint">{{ checkedCopy(video) }}</span>
                <span v-if="video.comparison.thumbnail_changed_since_last_sync === true" class="hint warn">
                  Thumbnail changed on YouTube since the last check
                </span>
              </div>
            </div>

            <dl class="fields">
              <div v-for="field in video.comparison.fields" :key="field.field" class="field">
                <dt>{{ FIELD_LABELS[field.field] || field.field }}</dt>
                <dd>
                  <span :class="['state', field.state]">{{ STATE_LABELS[field.state] || field.state }}</span>
                  <template v-if="differs(field)">
                    <span class="value"><b>Story Studio:</b> {{ displayPair(field).local }}</span>
                    <span class="value"><b>YouTube now:</b> {{ displayPair(field).live }}</span>
                  </template>
                  <span v-if="field.decided_at" class="hint">You reviewed this on {{ formatWhen(field.decided_at) }}</span>

                  <span v-if="decidable(field)" class="decisions">
                    <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''"
                      @click="decide(video, field.field, 'use_story_studio')">Update YouTube to Story Studio’s Version</button>
                    <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''"
                      @click="decide(video, field.field, 'keep_youtube')">Keep YouTube</button>
                    <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''"
                      @click="decide(video, field.field, 'review_later')">Review Later</button>
                  </span>
                </dd>
              </div>
            </dl>

            <p class="hint playlists">{{ playlistCopy(video) }}</p>
            <div class="field-row thumbnail-action">
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="busy !== ''"
                @click="refreshThumbnail(video)"
              >
                {{ busy === `${video.operation_id}:thumbnail` ? 'Queueing…' : 'Refresh Thumbnail' }}
              </button>
              <span class="hint">Uses Story Studio’s current thumbnail for this exact video. It never runs on its own.</span>
            </div>
            <!--
              The copy above has always said a failed add "can be retried on its
              own". Until now nothing did the retrying — a promise in a sentence
              with no control behind it. One playlist, one video, one button.
            -->
            <div v-if="failedPlaylists(video).length" class="field-row">
              <button
                v-for="playlistId in failedPlaylists(video)"
                :key="playlistId"
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="busy !== ''"
                @click="retryPlaylist(video, playlistId)"
              >
                {{ busy === `${video.operation_id}:${playlistId}` ? 'Checking…' : `Retry ${playlistId}` }}
              </button>
            </div>
            <p class="hint">{{ captionCopy(video) }}</p>
          </li>
        </ul>
        <p v-if="actionResult" :class="['result', actionResult.kind]">{{ actionResult.message }}</p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
interface Field {
  field: string
  state: string
  local: string | null
  last_synced: string | null
  live: string | null
  decided_at?: string
}
interface Video {
  operation_id: string
  episode_code: string
  video_id: string | null
  comparison: {
    fields: Field[]
    needs_attention: boolean
    live_fetched_at: string | null
    thumbnail_changed_since_last_sync: boolean | null
  }
  playlists: Record<string, { state: string }>
  caption: { state: string; language?: string } | null
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { ask } = useConfirm()

const loading = ref(true)
const loadError = ref('')
const busy = ref('')
const videos = ref<Video[]>([])
const emptyReason = ref<string | null>(null)
const actionResult = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  tags: 'Tags',
  privacy_status: 'Privacy',
  scheduled_for: 'Scheduled for',
}

const STATE_LABELS: Record<string, string> = {
  in_sync: 'In sync',
  story_studio_changed: 'Story Studio has changes',
  youtube_changed: 'YouTube has changes',
  conflict: 'Conflict',
  keep_youtube: 'Keeping YouTube’s version',
  unknown: 'Not checked yet',
  unavailable: 'YouTube did not report this',
}

/** Each empty case has its own next action, so each gets its own sentence. */
const EMPTY_COPY: Record<string, { heading: string; body: string }> = {
  no_channel_assigned: {
    heading: 'This project has no YouTube channel',
    body: 'Assign one in Settings → YouTube. Everything here stays available locally until you do.',
  },
  nothing_uploaded: {
    heading: 'Nothing has been uploaded from this project yet',
    body: 'Once an episode is published to YouTube it appears here with what YouTube says about it.',
  },
  nothing_published_yet: {
    heading: 'No upload has been accepted by YouTube yet',
    body: 'An upload has been started for this project, but YouTube has not accepted a video from it. Publish shows where it got to.',
  },
}
const emptyCopy = computed(() => emptyReason.value ? EMPTY_COPY[emptyReason.value] ?? null : null)

/** Only show both sides when they actually differ — otherwise it is noise. */
function differs(field: Field): boolean {
  return field.state === 'story_studio_changed'
    || field.state === 'youtube_changed'
    || field.state === 'conflict'
}

/** A field nobody needs to answer gets no buttons. */
function decidable(field: Field): boolean {
  return differs(field) || field.state === 'keep_youtube'
}

function display(value: string | null): string {
  if (value === null) return '(nothing)'
  return value.length > 160 ? `${value.slice(0, 160)}…` : value
}

/**
 * Show the two disputed values so that they actually look different.
 *
 * Truncating both at 160 characters rendered byte-identical text whenever two
 * long descriptions agreed on their opening and diverged later - hiding the
 * difference at the exact moment the owner is being asked to judge it. This
 * windows both sides around the first character that differs.
 */
function displayPair(field: Field): { local: string; live: string } {
  const local = field.local
  const live = field.live
  if (local === null || live === null) return { local: display(local), live: display(live) }

  let at = 0
  while (at < local.length && at < live.length && local[at] === live[at]) at++
  if (at <= 120) return { local: display(local), live: display(live) }

  const from = Math.max(0, at - 40)
  const window = (value: string) => `…${value.slice(from, from + 160)}${value.length > from + 160 ? '…' : ''}`
  return { local: window(local), live: window(live) }
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return 'never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'never' : parsed.toLocaleString()
}

/** Never say "checked" about a video that has never been read. */
function checkedCopy(video: Video): string {
  return video.comparison.live_fetched_at
    ? `Checked ${formatWhen(video.comparison.live_fetched_at)}`
    : 'Not checked with YouTube yet'
}

/** The playlists whose add failed — exactly what the retry control offers. */
function failedPlaylists(video: Video): string[] {
  return Object.entries(video.playlists || {})
    .filter(([, value]: [string, any]) => value?.state === 'failed')
    .map(([playlistId]) => playlistId)
}

/**
 * Retry ONE failed playlist add, for one video.
 *
 * The preview reads local operation records only. Its resulting exact count
 * and quota estimate are shown in the confirmation before the provider write.
 */
async function retryPlaylist(video: Video, playlistId: string): Promise<void> {
  busy.value = `${video.operation_id}:${playlistId}`
  actionResult.value = null
  try {
    const preview = await post<{
      additions: string[]
      already_present: string[]
      no_video_id: string[]
      unknown_operation_ids: string[]
      estimated_quota_units: number
    }>(`/projects/${slug.value}/youtube/playlists/preview`, {
      playlist_id: playlistId,
      operation_ids: [video.operation_id],
    })
    if (!preview.additions.includes(video.operation_id)) {
      actionResult.value = {
        kind: 'warn',
        message: `${video.episode_code}: this playlist retry has nothing to add.`,
      }
      return
    }

    const confirmed = await ask({
      title: `Add ${video.episode_code} to playlist ${playlistId}?`,
      message: `This retry adds one accepted video. Estimated YouTube quota: ${preview.estimated_quota_units} units.`,
      confirmLabel: 'Add to Playlist',
    })
    if (!confirmed) return

    const result = await post<{ added: number; failed: number; skipped: number; unrecorded?: number; receipts?: Array<{ unrecorded?: boolean }> }>(
      `/projects/${slug.value}/youtube/playlists/apply`,
      { playlist_id: playlistId, operation_ids: [video.operation_id] },
    )
    const unrecorded = Boolean(result.unrecorded) || result.receipts?.some(receipt => receipt.unrecorded)
    actionResult.value = result.failed
      ? { kind: 'warn', message: `${video.episode_code}: playlist retry needs review before trying again.` }
      : unrecorded
        ? { kind: 'warn', message: `${video.episode_code}: YouTube may have accepted this playlist retry, but Story Studio could not record it. Check YouTube Studio before retrying.` }
        : { kind: 'ok', message: `${video.episode_code}: playlist retry recorded.` }
    await load()
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'That playlist retry did not work.' }
  } finally {
    busy.value = ''
  }
}

/**
 * Queue one operation-bound thumbnail refresh. The server checks the current
 * immutable channel assignment before it creates the job; this page must not
 * turn a thumbnail hint into an automatic bulk write.
 */
async function refreshThumbnail(video: Video): Promise<void> {
  const confirmed = await ask({
    title: `Refresh ${video.episode_code} thumbnail on YouTube?`,
    message: 'Story Studio will queue the current local thumbnail for this exact accepted video on its assigned channel.',
    confirmLabel: 'Refresh Thumbnail',
  })
  if (!confirmed) return

  busy.value = `${video.operation_id}:thumbnail`
  actionResult.value = null
  try {
    const result = await post<{ job_id: string; episode_code: string }>(
      `/projects/${slug.value}/youtube/library/${video.operation_id}/thumbnail`,
      { confirm: true },
    )
    actionResult.value = {
      kind: 'ok',
      message: `${result.episode_code || video.episode_code}: thumbnail refresh queued. Progress appears in Jobs.`,
    }
    await load()
  } catch (error: any) {
    actionResult.value = {
      kind: 'err',
      message: error?.data?.detail || error?.message || 'Could not queue that thumbnail refresh.',
    }
  } finally {
    busy.value = ''
  }
}

function playlistCopy(video: Video): string {
  const entries = Object.entries(video.playlists)
  if (!entries.length) return 'Not in any playlist Story Studio knows about.'
  const present = entries.filter(([, value]) => value.state === 'present').length
  const failed = entries.filter(([, value]) => value.state === 'failed').length
  const parts = [`In ${present} playlist${present === 1 ? '' : 's'}`]
  if (failed) parts.push(`${failed} playlist add failed and can be retried on its own`)
  return `${parts.join(' · ')}.`
}

function captionCopy(video: Video): string {
  if (!video.caption) return 'No caption track has been recorded for this video.'
  return `Captions: ${video.caption.state}${video.caption.language ? ` (${video.caption.language})` : ''}.`
}

async function load(): Promise<void> {
  try {
    const res = await get<{ videos: Video[]; empty_reason: string | null }>(
      `/projects/${slug.value}/youtube/library`,
    )
    videos.value = res.videos
    emptyReason.value = res.empty_reason
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load this project’s videos.'
  } finally {
    loading.value = false
  }
}

async function decide(video: Video, field: string, decision: string): Promise<void> {
  if (decision === 'use_story_studio') {
    // This rewrites the LIVE video on YouTube — name the field and both values first.
    const row = video.comparison.fields.find(f => f.field === field)
    const label = FIELD_LABELS[field] || field
    const sensitive = field === 'privacy_status' || field === 'scheduled_for'
    const confirmed = await ask({
      title: `Update ${label} on YouTube for ${video.episode_code}?`,
      message: `This changes the live video on YouTube. ${label} is now ${display(row?.live ?? null)} on YouTube and will become ${display(row?.local ?? null)}.`
        + (sensitive ? ' Privacy and schedule changes can show or hide the video to viewers straight away.' : ''),
      confirmLabel: 'Update YouTube',
      danger: sensitive,
    })
    if (!confirmed) return
  }
  busy.value = `${video.operation_id}:${field}`
  actionResult.value = null
  try {
    await post(`/projects/${slug.value}/youtube/library/${video.operation_id}/drift`, { field, decision })
    actionResult.value = {
      kind: 'ok',
      message: decision === 'review_later'
        ? `${video.episode_code}: left for later. The difference stays visible.`
        : decision === 'use_story_studio'
          ? `YouTube updated — ${video.episode_code}: ${FIELD_LABELS[field] || field} now matches Story Studio.`
          : `${video.episode_code}: keeping YouTube’s ${FIELD_LABELS[field] || field}. Story Studio will not change it.`,
    }
    await load()
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save that decision.' }
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<style scoped>
/* Declared so the @container rules below actually apply — the repo-wide guard
   test fails the build if this is ever dropped. */
.uc-library { container-type: inline-size; container-name: uc-library; display: grid; gap: 14px; min-width: 0; }
.panel { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.panel h3 { margin: 3px 0; }
.panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.hint { color: var(--text-muted); font-size: var(--font-xs); }
.hint.warn { color: var(--warning, #d97706); }
.muted { color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }
.empty h3 { color: var(--text-primary); }

.video-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.video { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.video > * { min-width: 0; }
.video-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 12px; }
.video-id, .video-state { display: grid; gap: 2px; }
.video-state { justify-items: end; text-align: right; }
.badge { padding: 2px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 700; }
.badge.settled { background: rgba(80, 160, 120, .16); color: var(--success); }
.badge.attention { background: rgba(217, 119, 6, .16); color: var(--warning, #d97706); }

.fields { display: grid; gap: 6px; margin: 0; }
.field { display: grid; grid-template-columns: minmax(110px, 150px) minmax(0, 1fr); gap: 10px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-secondary); }
.field dt, .field dd { margin: 0; font-size: var(--font-xs); }
.field dd { display: grid; gap: 4px; }
.value { color: var(--text-secondary); overflow-wrap: anywhere; }
.state { font-weight: 700; }
.state.in_sync { color: var(--success); }
.state.conflict, .state.youtube_changed, .state.story_studio_changed, .state.unavailable { color: var(--warning, #d97706); }
.state.unknown { color: var(--text-muted); }
.state.keep_youtube { color: var(--text-secondary); }
.decisions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }

@container uc-library (max-width: 680px) {
  .video-head { grid-template-columns: 1fr; }
  .video-state { justify-items: start; text-align: left; }
  .field { grid-template-columns: 1fr; }
}
</style>
