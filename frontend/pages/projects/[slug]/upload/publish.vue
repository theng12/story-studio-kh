<template>
  <div class="uc-publish">
    <p v-if="loading" class="hint">Loading this project’s uploads…</p>
    <p v-else-if="loadError" class="result err">{{ loadError }}</p>

    <template v-else>
      <!--
        Rows are EPISODES, not upload records.

        This list used to be `/youtube/operations`, which only exists once an
        upload has happened — so a project that had never uploaded had no rows,
        and Preview (inside a row) and Upload (under a preview) could not be
        reached at all. The page said "Nothing uploaded yet" and offered nothing
        to press. An episode is publishable because it is finished, not because
        it has been published before; the record is overlaid where there is one.
      -->
      <section class="panel uploads">
        <div>
          <span class="eyebrow">Episodes</span>
          <h3>{{ episodes.length === 0 ? 'Nothing ready to publish yet' : `${episodes.length} episode${episodes.length === 1 ? '' : 's'}` }}</h3>
          <!-- Every accepted episode is listed. The filter is for finding one,
               never for hiding any: the count above always names the whole set. -->
          <input
            v-if="total > 12" v-model="filter" class="ep-filter" type="search"
            placeholder="Find an episode — code or title"
            aria-label="Filter episodes by code or title"
          />
          <p v-if="episodes.length === 0" class="hint">
            An episode appears here once it is accepted and its final video has been rendered.
          </p>
        </div>

        <p v-if="total && !visibleEpisodes.length" class="hint">
          No episode matches “{{ filter }}”. {{ total }} episode{{ total === 1 ? '' : 's' }} in total.
        </p>
        <ul v-if="visibleEpisodes.length" class="op-list">
          <li v-for="ep in visibleEpisodes" :key="ep.episode_code" class="op">
            <div class="op-id">
              <strong>{{ ep.episode_code }}</strong>
              <span class="muted">{{ ep.title }}</span>
              <code v-if="ep.remote_video_id || ep.operation?.video_id" class="muted">{{ ep.remote_video_id || ep.operation?.video_id }}</code>
            </div>
            <div class="op-state">
              <span v-if="ep.operation" :class="['badge', ep.operation.lifecycle]">{{ lifecycleLabel(ep.operation.lifecycle) }}</span>
              <span v-else-if="ep.has_remote_video" class="badge accepted">On YouTube</span>
              <span v-else-if="!ep.has_video" class="hint">No rendered video yet</span>
              <!-- The route's own reason, on the row. Without this a row whose
                   record could not be read said "Not uploaded yet" — an
                   invitation to upload what we had just failed to vouch for. -->
              <span v-else-if="ep.blocked_reason" class="hint">{{ ep.blocked_reason }}</span>
              <span v-else class="hint">Not uploaded yet</span>
              <span v-if="ep.operation && reasonFor(ep.operation)" class="hint">{{ reasonFor(ep.operation) }}</span>
              <span v-if="ep.operation" class="hint">{{ checkedCopy(ep.operation) }}</span>
            </div>
            <div class="op-actions">
              <button
                v-if="ep.operation?.video_id" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== '' || !!remoteBlocked" :title="remoteBlocked || ''"
                @click="refresh(ep.operation)"
              >
                {{ busy === ep.operation.operation_id ? 'Checking…' : 'Check on YouTube' }}
              </button>
              <!-- Nothing to preview without a rendered video: the route refuses it. -->
              <button
                v-if="ep.has_video" class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== ''" @click="preview(ep.episode_code)"
              >
                Preview
              </button>
            </div>
          </li>
        </ul>
        <p v-if="actionResult" :class="['result', actionResult.kind]">{{ actionResult.message }}</p>
        <!-- Spec section 17: disable only the REMOTE actions, and say why. The
             local records above stay fully readable either way. -->
        <p v-if="remoteBlocked" class="result warn">{{ remoteBlocked }}</p>
        <p class="hint">Checking with YouTube spends this Cloud project’s daily allowance. Nothing here checks on its own.</p>
      </section>

      <!-- The exact payload, in full, before anything is sent. Not a modal. -->
      <section v-if="previewed" class="panel preview">
        <div>
          <span class="eyebrow">Exact preview — {{ previewedEpisode }}</span>
          <h3>What YouTube will receive</h3>
          <p v-if="previewed.modifications.length" class="hint">
            {{ previewed.modifications.length }} change{{ previewed.modifications.length === 1 ? '' : 's' }} applied to your metadata:
          </p>
          <p v-else class="hint">Nothing in your metadata needed changing.</p>
        </div>

        <ul v-if="previewed.modifications.length" class="changes">
          <li v-for="(change, i) in previewed.modifications" :key="i"><b>{{ change.field }}</b> — {{ change.reason }}</li>
        </ul>
        <ul v-if="previewed.warnings.length" class="warnings">
          <li v-for="(warning, i) in previewed.warnings" :key="i">⚠ {{ warning }}</li>
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
          <span class="hint">Publishes {{ previewedEpisode }} to the channel this project is assigned to.</span>
        </div>
      </section>
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
interface PublishableEpisode {
  episode_code: string
  title: string
  has_video: boolean
  /** Why this episode cannot be uploaded, decided by the route. Absent = it can. */
  blocked_reason?: string
  /** Already on YouTube — from the operation record OR a legacy sidecar. */
  has_remote_video?: boolean
  remote_video_id?: string
  remote_source?: 'operation_record' | 'reconcile_link' | 'legacy_sidecar'
  operation?: Operation
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

/** The rows the filter box leaves visible. Filtering never changes `total`. */
const visibleEpisodes = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return episodes.value
  return episodes.value.filter(ep => ep.episode_code.toLowerCase().includes(needle)
    || (ep.title || '').toLowerCase().includes(needle))
})
const previewed = ref<Preview | null>(null)
const channelStatus = ref('')
const assignedChannel = ref<Channel | null>(null)
const quotaExhausted = ref(false)
const uploadQuotaExhausted = ref(false)
const quotaUnavailableReason = ref('')
const previewedEpisode = ref('')
const actionResult = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)

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

/**
 * "Never checked" and "checked and found nothing" are different facts and must
 * not render the same.
 */
function checkedCopy(op: Operation): string {
  if (!op.processing?.checked_at) return 'Not checked with YouTube yet'
  const at = new Date(op.processing.checked_at)
  return Number.isNaN(at.getTime()) ? 'Not checked with YouTube yet' : `Checked ${at.toLocaleString()}`
}

/**
 * Why a remote check cannot run right now, or '' when it can. Local records
 * stay readable regardless — losing YouTube costs freshness, never access.
 */
/** Why an UPLOAD cannot run — the route's own preconditions, in the same order. */
const uploadBlocked = computed(() => {
  if (!channelStatus.value) return 'This project has no assigned YouTube channel, so it cannot upload.'
  if (channelStatus.value === 'reconnect_required') return 'Reconnect this channel in Settings before uploading.'
  if (channelStatus.value === 'scope_upgrade_required') return 'This channel needs its permissions upgraded in Settings before Story Studio can upload.'
  if (quotaUnavailableReason.value === 'ledger_unreadable') return 'Uploads and other provider writes are paused until the local allowance record is repaired.'
  if (uploadQuotaExhausted.value) return 'Today’s upload allowance for this Google Cloud project is used up. Uploading resumes after it resets.'
  return ''
})

const remoteBlocked = computed(() => {
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
  return episodes.value.find(ep => ep.episode_code === previewedEpisode.value)?.blocked_reason || ''
})


async function load(): Promise<void> {
  try {
    const [ops, overview] = await Promise.all([
      get<{ episodes: PublishableEpisode[]; total: number }>(`/projects/${slug.value}/youtube/publishable`),
      get<any>(`/projects/${slug.value}/youtube/overview`),
    ])
    episodes.value = ops.episodes
    total.value = ops.total ?? ops.episodes.length
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
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load this project’s uploads.'
  } finally {
    loading.value = false
  }
}

async function refresh(op: Operation): Promise<void> {
  busy.value = op.operation_id
  actionResult.value = null
  try {
    const res = await post<{ state: { lifecycle: string }; persisted: boolean }>(
      `/projects/${slug.value}/youtube/operations/${op.operation_id}/refresh`, {},
    )
    // A status we could not get is not a verdict, and the copy says so.
    actionResult.value = res.state.lifecycle === 'status_unavailable'
      ? { kind: 'warn', message: `${op.episode_code}: YouTube did not return this video. Its last known state is kept.` }
      : { kind: 'ok', message: `${op.episode_code}: ${lifecycleLabel(res.state.lifecycle)}.` }
    await load()
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not check that video.' }
  } finally {
    busy.value = ''
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
  const confirmed = await ask({
    title: `Upload ${episodeCode} to YouTube?`,
    message: `This publishes ${episodeCode} to ${assignedChannel.value?.title || 'the assigned channel'} (${assignedChannel.value?.channel_id || 'unknown'}). `
      + 'A video cannot be replaced once uploaded — only deleted and uploaded again under a new link.',
    confirmLabel: 'Upload',
  })
  if (!confirmed) return
  busy.value = 'upload'
  actionResult.value = null
  try {
    const res = await post<{ job_id: string; channel_id: string }>(
      `/projects/${slug.value}/youtube/upload`,
      {
        episode_code: episodeCode,
        confirm: true,
        expected_channel_id: assignedChannel.value?.channel_id,
        expected_package_revision: previewed.value?.package_revision,
      },
    )
    actionResult.value = {
      kind: 'ok',
      message: `Uploading ${episodeCode} to ${res.channel_id}. Progress appears in Jobs.`,
    }
    await load()
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Failed to start that upload.' }
  } finally {
    busy.value = ''
  }
}

async function preview(episodeCode: string): Promise<void> {
  busy.value = `preview-${episodeCode}`
  actionResult.value = null
  // Drop the previous payload BEFORE asking for the next one. Leaving it up
  // while a different episode's request is in flight — or after it fails —
  // shows one episode's exact payload while the reader believes they asked
  // about another.
  previewed.value = null
  previewedEpisode.value = ''
  try {
    previewed.value = await post<Preview>(`/projects/${slug.value}/youtube/preview`, {
      // No `mark_as_ai_generated` here. The server resolves it from the
      // project's own setting; sending it was how the preview came to show a
      // disclosure the owner had turned off.
      episode_code: episodeCode, privacy_status: 'private',
    })
    previewedEpisode.value = episodeCode
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not build the preview.' }
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<style scoped>
/* Same container fix as Overview: these @container rules did nothing. */
.uc-publish { container-type: inline-size; container-name: uc-publish; display: grid; gap: 14px; min-width: 0; }
.panel { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.panel h3 { margin: 3px 0; }
.panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.hint { color: var(--text-muted); font-size: var(--font-xs); }
.muted { color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }


.op-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.op { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.op > * { min-width: 0; }
.op-id, .op-state { display: grid; gap: 2px; }
.op-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { justify-self: start; padding: 2px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 700; }
.badge.ready { background: rgba(80, 160, 120, .16); color: var(--success); }
.badge.processing, .badge.uploading, .badge.accepted, .badge.preparing { background: rgba(120, 140, 200, .16); color: var(--text-secondary); }
.badge.failed, .badge.rejected { background: rgba(200, 80, 80, .16); color: var(--danger); }
.badge.status_unavailable { background: rgba(217, 119, 6, .16); color: var(--warning, #d97706); }

.changes, .warnings { display: grid; gap: 4px; margin: 0; padding-left: 18px; font-size: var(--font-xs); }
.warnings { color: var(--warning, #d97706); }
.payload { display: grid; gap: 6px; margin: 0; }
.payload > div { display: grid; grid-template-columns: minmax(120px, 160px) minmax(0, 1fr); gap: 12px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.payload dt, .payload dd { margin: 0; font-size: var(--font-xs); }
.payload dd { color: var(--text-secondary); overflow-wrap: anywhere; }
.payload dd.pre { white-space: pre-wrap; }

@container uc-publish (max-width: 700px) {
  .op { grid-template-columns: 1fr; }
  .payload > div { grid-template-columns: 1fr; }
}
</style>
