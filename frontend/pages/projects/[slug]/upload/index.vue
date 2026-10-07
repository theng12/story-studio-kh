<template>
  <div class="uc-overview">
    <p v-if="loading" class="hint">Loading what needs your attention…</p>
    <p v-else-if="loadError" class="result err">
      {{ loadError }}
      <button class="btn btn-sm" type="button" @click="retryLoad">Retry</button>
    </p>

    <template v-else-if="overview">
      <!-- Setup is incomplete: say which step, and only that step. -->
      <section v-if="overview.unavailable_reason" class="panel setup" role="status">
        <h2>{{ setupCopy.heading }}</h2>
        <p>{{ setupCopy.body }}</p>
        <NuxtLink :to="`/projects/${slug}/settings`" class="btn btn-sm btn-primary">Open Settings → YouTube</NuxtLink>
      </section>

      <section v-else class="panel channel">
        <div class="channel-identity">
          <span class="channel-avatar" role="img" :aria-label="`${overview.assigned_channel?.title} channel icon`">
            <img
              v-if="!channelAvatarFailed"
              :src="channelAvatarUrl"
              alt=""
              @error="channelAvatarFailed = true"
            />
            <span v-else>{{ channelInitials }}</span>
          </span>
          <div>
          <span class="eyebrow">Publishing to</span>
          <h2>{{ overview.assigned_channel?.title }}</h2>
          <code class="channel-id">{{ overview.assigned_channel?.channel_id }}</code>
          </div>
        </div>
        <div class="channel-state">
          <span :class="['badge', overview.assigned_channel?.status]">{{ healthLabel }}</span>
          <span :class="['hint', freshness.stale ? 'stale' : '']">{{ syncCopy }}</span>
          <button class="btn btn-sm" type="button" :disabled="syncing || !canSync" @click="syncNow">
            {{ syncing ? 'Checking with YouTube…' : 'Check All Uploads' }}
          </button>
          <NuxtLink v-if="!canSync" :to="`/projects/${slug}/settings#youtube`" class="hint">
            {{ connectionAction }}
          </NuxtLink>
        </div>
      </section>

      <!-- A failed attempt is its own state. Showing the cached numbers with
           no word about the failure would be the worst of both. -->
      <p v-if="syncError" class="result err" role="alert">Couldn’t check with YouTube: {{ syncError }}</p>
      <section v-if="syncProblem" class="panel sync-problem" role="status">
        <h3>{{ syncProblem.heading }}</h3>
        <p>{{ syncProblem.body }}</p>
      </section>

      <!-- A ledger we cannot read is not the same as a project without one. -->
      <section v-if="overview.quota_unavailable_reason === 'ledger_unreadable'" class="panel quota-broken" role="status">
        <h3>The daily allowance count could not be read</h3>
        <p>
          Story Studio keeps its own record of what it has spent today, and that record is unreadable
          on this Mac. Uploads and other provider writes are paused until the local allowance record is repaired.
        </p>
      </section>

      <!-- Quota lives here and nowhere else in the app. -->
      <section v-else-if="overview.quota" class="panel quota">
        <div>
          <span class="eyebrow">Daily allowance</span>
          <h3>Google Cloud project quota</h3>
          <p class="hint">{{ overview.quota.external_usage_note }}</p>
        </div>
        <dl class="buckets">
          <div v-for="bucket in buckets" :key="bucket.id">
            <dt>{{ bucket.label }}</dt>
            <dd>
              <!--
                A limit we have not confirmed must not be shown as one. For an
                unverified bucket the usage is real and the ceiling is unknown,
                so it says so instead of printing arithmetic on a guess.
              -->
              <strong v-if="bucket.limit === null">{{ bucket.used }}</strong>
              <strong v-else :class="{ exhausted: (bucket.remaining ?? 0) <= 0 }">
                {{ bucket.used }} / {{ bucket.limit }}
              </strong>
              <span class="hint">
                {{ bucket.unit }}{{ bucket.stale ? ' · count may be behind' : '' }}{{
                  bucket.limit === null ? ' · daily limit not confirmed' : '' }}
              </span>
            </dd>
          </div>
        </dl>
        <p class="hint">Resets {{ formatWhen(overview.quota.resets_at) }}.</p>
      </section>

      <section class="panel attention">
        <div>
          <span class="eyebrow">Needs you</span>
          <h3>{{ episodesNeedingAttention === 0 ? 'Nothing is waiting' : `${episodesNeedingAttention} episode${episodesNeedingAttention === 1 ? '' : 's'} to look at` }}</h3>
          <p v-if="episodesNeedingAttention === 0" class="hint">
            {{ overview.operation_count === 0
              ? 'No episode has been uploaded from this project yet.'
              : 'Every uploaded episode is settled.' }}
          </p>
        </div>
        <ul v-if="episodesNeedingAttention > 0" class="attention-list">
          <li v-for="row in attentionRows" :key="row.id">
            <span class="count">{{ row.count }}</span>
            <span>{{ row.label }}</span>
            <NuxtLink :to="`/projects/${slug}/upload/publish`" class="btn btn-ghost btn-sm">Open Publish</NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
interface Bucket { used: number; limit: number | null; remaining: number | null; unit: string; stale: boolean; limit_verified: boolean }
interface Overview {
  assigned_channel: { channel_id: string; title: string; status: string } | null
  unavailable_reason: 'no_oauth_application' | 'no_channel_connected' | 'no_channel_assigned' | null
  quota_unavailable_reason: 'no_oauth_application' | 'ledger_unreadable' | null
  episodes_needing_attention: number
  quota: {
    resets_at: string
    external_usage_note: string
    buckets: Record<'video_uploads' | 'search' | 'other_endpoints' | 'analytics', Bucket>
  } | null
  attention: { processing: number; failed: number; rejected: number; status_unavailable: number; drift: number }
  operation_count: number
  last_remote_sync_at: string | null
  last_sync_attempt: { attempted_at: string; outcome: 'ok' | 'partial' | 'failed'; checked: number; error_code?: string } | null
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()

const loading = ref(true)
const loadError = ref('')
const syncing = ref(false)
const syncError = ref('')
const overview = ref<Overview | null>(null)
const channelAvatarFailed = ref(false)

const channelAvatarUrl = computed(() => {
  const channelId = overview.value?.assigned_channel?.channel_id
  return channelId
    ? `/api/projects/${encodeURIComponent(slug.value)}/upload/accounts/${encodeURIComponent(`registry:${channelId}`)}/avatar`
    : ''
})
const channelInitials = computed(() => {
  const title = overview.value?.assigned_channel?.title?.trim() || 'YouTube'
  return title.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('')
})
watch(channelAvatarUrl, () => { channelAvatarFailed.value = false })

/** Anything older than this is called out rather than shown as current. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** Each missing setup step gets its own sentence — never one generic empty state. */
const SETUP_COPY: Record<string, { heading: string; body: string }> = {
  no_oauth_application: {
    heading: 'Connect Story Studio to YouTube once',
    body: 'Add your Google Cloud OAuth application in Settings. Every channel on this Mac connects through it, and you only do this once.',
  },
  no_channel_connected: {
    heading: 'Connect a YouTube channel',
    body: 'The OAuth application is saved. Authorize the channel you publish to, then assign it to this project.',
  },
  no_channel_assigned: {
    heading: 'Choose this project’s channel',
    body: 'Channels are connected, but this project does not publish to one yet. It stays fully usable locally until you choose.',
  },
}

const setupCopy = computed(() => SETUP_COPY[overview.value?.unavailable_reason ?? ''] ?? {
  heading: 'YouTube is not available for this project',
  body: 'Open Settings to finish connecting.',
})

const HEALTH: Record<string, string> = {
  connected: 'Connected',
  reconnect_required: 'Reconnect required',
  scope_upgrade_required: 'Permission upgrade required',
}
const healthLabel = computed(() => HEALTH[overview.value?.assigned_channel?.status ?? ''] ?? 'Unknown')
const canSync = computed(() => overview.value?.assigned_channel?.status === 'connected')
const connectionAction = computed(() => overview.value?.assigned_channel?.status === 'scope_upgrade_required'
  ? 'Update this channel’s permission in Settings → YouTube.'
  : 'Reconnect this channel in Settings → YouTube.')

const BUCKET_LABELS: Array<{ id: 'video_uploads' | 'search' | 'other_endpoints' | 'analytics'; label: string }> = [
  { id: 'video_uploads', label: 'Video uploads' },
  { id: 'search', label: 'Search' },
  { id: 'other_endpoints', label: 'Everything else' },
  // Analytics bills against its own YouTube allowance. Listed here because a
  // bucket nothing displays is a bucket nobody can act on.
  { id: 'analytics', label: 'Analytics' },
]
const buckets = computed(() => {
  const quota = overview.value?.quota
  if (!quota) return []
  return BUCKET_LABELS.map(({ id, label }) => ({ id, label, ...quota.buckets[id] }))
})

const ATTENTION_LABELS: Array<{ id: keyof Overview['attention']; label: string }> = [
  { id: 'processing', label: 'still processing on YouTube' },
  { id: 'failed', label: 'upload failed' },
  { id: 'rejected', label: 'rejected by YouTube' },
  { id: 'status_unavailable', label: 'status could not be checked' },
  { id: 'drift', label: 'differ from YouTube' },
]
const attentionRows = computed(() => {
  const attention = overview.value?.attention
  if (!attention) return []
  return ATTENTION_LABELS
    .map(({ id, label }) => ({ id, label, count: attention[id] }))
    .filter(row => row.count > 0)
})
/**
 * Episodes, not the sum of the rows. One video can be both processing and
 * drifted; those are two actions but one episode, and "3 things" for two
 * videos would be a lie the reader cannot detect.
 */
const episodesNeedingAttention = computed(() => overview.value?.episodes_needing_attention ?? 0)

/**
 * How old the data is, measured from the last SUCCESSFUL read — never from the
 * last attempt. A failed attempt must not make stale data look fresh.
 */
const freshness = computed(() => {
  const at = overview.value?.last_remote_sync_at
  if (!at) return { known: false, stale: false }
  const parsed = Date.parse(at)
  if (!Number.isFinite(parsed)) return { known: false, stale: false }
  return { known: true, stale: Date.now() - parsed > STALE_AFTER_MS }
})

const syncCopy = computed(() => {
  const at = overview.value?.last_remote_sync_at
  if (!at) return 'Not checked with YouTube yet'
  return freshness.value.stale
    ? `Showing what YouTube said on ${formatWhen(at)} — this may be out of date`
    : `Last checked with YouTube ${formatWhen(at)}`
})

/**
 * Why the last deliberate sync did not work, in terms the owner can act on.
 * "We never reached YouTube" and "YouTube answered and refused" need different
 * responses, so they get different screens.
 */
const SYNC_PROBLEMS: Record<string, { heading: string; body: string }> = {
  offline: {
    heading: 'Story Studio could not reach YouTube',
    body: 'The last check never got an answer, so what you see below is the last thing YouTube told us. Check this Mac’s internet connection and try again.',
  },
  provider_error: {
    heading: 'YouTube refused the last check',
    body: 'YouTube answered but would not return this channel’s videos. That usually means the connection needs reauthorizing in Settings.',
  },
  quota_exhausted: {
    heading: 'Today’s allowance is used up',
    body: 'The last check could not run because this Google Cloud project has spent its daily allowance. It resets automatically.',
  },
}

const syncProblem = computed(() => {
  const attempt = overview.value?.last_sync_attempt
  if (!attempt || attempt.outcome !== 'failed') return null
  return SYNC_PROBLEMS[attempt.error_code ?? ''] ?? {
    heading: 'The last check with YouTube did not finish',
    body: 'What you see below is the last thing YouTube told us.',
  }
})

function formatWhen(value: string | null | undefined): string {
  if (!value) return 'never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'never' : parsed.toLocaleString()
}

async function load(): Promise<void> {
  try {
    overview.value = await get<Overview>(`/projects/${slug.value}/youtube/overview`)
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load the Upload Center.'
  } finally {
    loading.value = false
  }
}

/**
 * The only thing on this page that spends quota, and only when clicked. The
 * outcome is read back from the server rather than assumed from the response.
 */
async function syncNow(): Promise<void> {
  syncing.value = true
  syncError.value = ''
  try {
    await post(`/projects/${slug.value}/youtube/sync`, {})
  } catch (error: any) {
    // The attempt is recorded server-side either way and the reload below shows
    // it, but the owner who clicked must also be told right now that it failed.
    syncError.value = error?.data?.detail || error?.message || 'The check did not finish.'
  } finally {
    await load()
    syncing.value = false
  }
}

async function retryLoad(): Promise<void> {
  loadError.value = ''
  loading.value = true
  await load()
}

onMounted(load)
</script>

<style scoped>
/* The @container rules below need a container to query. Without this the
   whole block compiled fine and did nothing — the class of bug AGENTS.md
   calls "CSS that silently does nothing". */
.uc-overview { container-type: inline-size; container-name: uc-overview; display: grid; gap: 14px; min-width: 0; }
.panel { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.panel h2, .panel h3 { margin: 3px 0; }
.panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.hint { color: var(--text-muted); font-size: var(--font-xs); }
.result.err { color: var(--danger); font-size: var(--font-xs); }

.channel { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
.channel > * { min-width: 0; }
.channel-identity { display: flex; align-items: center; gap: 12px; min-width: 0; }
.channel-avatar {
  display: grid; place-items: center; flex: 0 0 42px; width: 42px; height: 42px;
  overflow: hidden; border: 1px solid var(--border); border-radius: 50%;
  background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700;
}
.channel-avatar img { width: 100%; height: 100%; object-fit: cover; }
.channel-id { color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.channel-state { display: grid; gap: 4px; justify-items: end; text-align: right; }
.badge { padding: 2px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 700; }
.badge.connected { background: rgba(80, 160, 120, .16); color: var(--success); }
.badge.reconnect_required, .badge.scope_upgrade_required { background: rgba(217, 119, 6, .16); color: var(--warning, #d97706); }

.buckets { display: grid; gap: 6px; margin: 0; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.buckets > div { display: grid; gap: 2px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.buckets dt, .buckets dd { margin: 0; font-size: var(--font-xs); }
.buckets dd { display: grid; gap: 2px; }
.buckets strong.exhausted { color: var(--danger); }
.quota-broken h3, .sync-problem h3 { color: var(--warning, #d97706); }
.hint.stale { color: var(--warning, #d97706); }

.attention-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.attention-list li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); font-size: 13px; }
.count { font-weight: 700; font-variant-numeric: tabular-nums; }

@container uc-overview (max-width: 620px) {
  .channel { grid-template-columns: 1fr; }
  .channel-state { justify-items: start; text-align: left; }
}
</style>
