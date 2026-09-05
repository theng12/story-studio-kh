<template>
  <div class="uc-analytics">
    <p v-if="loading" class="hint">Loading analytics…</p>
    <p v-else-if="loadError" class="result err">{{ loadError }}</p>

    <template v-else>
      <section class="panel header">
        <div>
          <span class="eyebrow">Analytics</span>
          <h3>{{ headline }}</h3>
          <!--
            The window is not decoration. "1,204 views" means 1,204 IN A WINDOW,
            and without it on screen the figure reads as lifetime — while a
            quiet quarter on a two-year-old video reads as "no data" about the
            video rather than about the period.
          -->
          <p class="window">{{ windowLabel }}</p>
          <p class="hint">
            Read from a saved copy, so opening this costs nothing. Fetching is the only thing here
            that contacts YouTube. Nothing on this page is estimated: a number YouTube did not
            report is shown as missing, never filled in.
          </p>
        </div>
        <div class="field-row">
          <button
            class="btn btn-sm"
            type="button"
            :disabled="busy || data.empty_reason === 'no_channel_assigned'"
            @click="refresh"
          >
            {{ busy ? 'Fetching…' : 'Fetch analytics from YouTube' }}
          </button>
        </div>
      </section>

      <section v-if="data.empty_reason === 'no_channel_assigned'" class="panel hint-panel" role="status">
        <p class="hint">
          No YouTube channel is assigned to this project yet, so there are no numbers to show.
          Assign a channel on the Upload Center overview first.
        </p>
      </section>

      <!--
        Each reason gets its own words because each has a different next action.
        Folding them into one "not everything" banner would be the same defect
        this page exists to prevent, moved from the metric level to the list.
      -->
      <section v-if="data.partial" class="panel partial" role="status">
        <h3>{{ PARTIAL_HEADINGS[data.partial_reason || ''] || 'This is not the whole picture' }}</h3>
        <p>{{ PARTIAL_BODIES[data.partial_reason || ''] || 'The last fetch stopped before it had covered everything.' }}</p>
        <p v-if="data.unreached_video_ids.length" class="hint">
          Not covered: {{ data.unreached_video_ids.join(', ') }}
        </p>
      </section>

      <p v-if="actionResult" class="result" :class="actionResult.kind">{{ actionResult.message }}</p>

      <section v-if="!data.episodes.length" class="panel hint-panel" role="status">
        <p class="hint">{{ emptyMessage }}</p>
      </section>

      <!--
        Keyed on the EPISODE code, not the video id. Two episodes linked to one
        video is a state this product models (Phase 6's "Conflict"), so it is
        two rows that must stay distinct — keying on the video gave them the
        same key and Vue rendered one.
      -->
      <section v-for="episode in data.episodes" :key="episode.episode_code" class="panel episode">
        <div class="episode-head">
          <strong>{{ episode.episode_code }}</strong>
          <span class="hint">{{ episode.video_id }}</span>
        </div>
        <dl class="metrics">
          <div v-for="metric in metricsOf(episode)" :key="metric.id" class="metric" :data-state="metric.state">
            <dt>{{ metric.label }}</dt>
            <dd>
              <!--
                `data-state` carries the state to the DOM so a reader, a test,
                and a stylesheet all see the same four answers. The text differs
                too — a state that only differed by attribute would still read
                as a number on screen.
              -->
              <strong>{{ metric.text }}</strong>
              <span class="hint">{{ metric.detail }}</span>
            </dd>
          </div>
        </dl>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Analytics.
 *
 * Every number here arrives as a state, not a bare figure, and is rendered
 * through `describe()` below so "YouTube said 0", "we never asked", "YouTube
 * does not offer this here" and "YouTube had nothing to say" cannot look alike
 * on screen. No monetary figures, no composite score, and no card-click "CTR" —
 * the metric whose old label said something it did not measure.
 */
interface Metric { state: string, value?: number, fetched_at?: string, reason?: string }
interface Episode {
  episode_code: string
  video_id: string
  metrics: Record<string, Metric>
  // No `title`. The route sets it to the episode code and nothing else can, so
  // `title || episode_code` was a fallback that could not fire — and it kept a
  // "hostile titles are rendered as text" test alive against a field the route
  // can only fill with a validated identifier.
}
interface Analytics {
  episodes: Episode[]
  fetched_at: string | null
  partial: boolean
  partial_reason?: string
  unreached_video_ids: string[]
  never_fetched: boolean
  start_date: string | null
  end_date: string | null
  empty_reason: string | null
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()

const loading = ref(true)
const loadError = ref('')
const busy = ref(false)
const actionResult = ref<{ kind: string, message: string } | null>(null)
const data = ref<Analytics>({
  episodes: [], fetched_at: null, partial: false, unreached_video_ids: [],
  never_fetched: true, start_date: null, end_date: null, empty_reason: null,
})

const METRIC_LABELS: Array<{ id: string, label: string }> = [
  { id: 'views', label: 'Views' },
  { id: 'watch_minutes', label: 'Minutes watched' },
  { id: 'avg_view_seconds', label: 'Average view (seconds)' },
  { id: 'avg_view_percentage', label: 'Average view (percent)' },
  { id: 'likes', label: 'Likes' },
  { id: 'comments', label: 'Comments' },
  { id: 'shares', label: 'Shares' },
]

const PARTIAL_HEADINGS: Record<string, string> = {
  quota_exhausted: 'Today’s allowance ran out partway through',
  provider_error: 'YouTube stopped answering partway through',
  report_truncated: 'This project has more episodes than one report returns',
  scope_missing: 'This channel has not granted analytics access',
  not_all_measured: 'Some episodes have not been measured yet',
  not_connected: 'This channel is not signed in',
}
const PARTIAL_BODIES: Record<string, string> = {
  quota_exhausted: 'What you see below was fetched before the allowance ran out. The rest has not been looked at yet.',
  provider_error: 'What you see below was fetched before YouTube stopped answering. Fetching again may reach the rest.',
  // A different situation from the two above, and a different answer: waiting
  // will not help and retrying will not help, because the report itself has a
  // ceiling. Saying "try again" here would waste an allowance to prove it.
  report_truncated: 'One report covers a limited number of videos, and these episodes fell outside it. They have not been measured — this is not a finding about them.',
  // Neither waiting nor retrying fixes this, so the words must not suggest
  // either. It is a permission the owner has to grant.
  scope_missing: 'Story Studio can see this channel but not its analytics. Reconnect the channel in Settings → YouTube and grant analytics access; nothing here can be measured until then.',
  // Unlike the others this one IS fixed by fetching again — an episode was
  // published after the last fetch, so its row is honest but empty.
  not_all_measured: 'These episodes were published after the last fetch, so they have no figures yet. Fetch again to measure them.',
  not_connected: 'Story Studio has no credentials for this channel. Reconnect it in Settings → YouTube — this is a sign-in, not a permission.',
}

/**
 * The rendered form of a metric, and the ONLY one.
 *
 * There was a second copy on the server (`describeMetric`) that nothing
 * called; it is deleted. Rendering belongs here, where the four states have to
 * be distinguishable to a person, and where the page's own tests assert what
 * the DOM actually shows.
 */
function describe(metric: Metric | undefined): { text: string, detail: string, state: string } {
  if (!metric) return { text: 'Not fetched', detail: 'Fetch analytics to see this.', state: 'not_fetched' }
  switch (metric.state) {
    case 'value':
      // No `?? 0`. A `value` state without a number is malformed, and printing
      // 0 for it would manufacture the exact reading this page exists to
      // prevent — it falls through to the default instead.
      if (typeof metric.value !== 'number') break
      return {
        text: metric.value.toLocaleString('en-US'),
        detail: `${windowPhrase()} · measured ${formatWhen(metric.fetched_at)}`,
        state: 'value',
      }
    case 'not_available':
      return {
        text: 'Not available for this video',
        detail: `${metric.reason || 'YouTube does not offer this metric here.'} (checked ${formatWhen(metric.fetched_at)})`,
        state: 'not_available',
      }
    case 'no_data':
      return {
        text: 'No data yet',
        // Scoped to the window: this says the PERIOD was quiet, not that the
        // video has never been watched.
        detail: `YouTube reported nothing ${windowPhrase()} (checked ${formatWhen(metric.fetched_at)})`,
        state: 'no_data',
      }
  }
  return { text: 'Not fetched', detail: 'Fetch analytics to see this.', state: 'not_fetched' }
}

/**
 * "for 2026-06-05 to 2026-09-03".
 *
 * There is no "unstated period" branch: the window is required on the stored
 * cache, so a cache without one fails decode and is dropped rather than served.
 * A windowless-but-fetched response is a shape the route cannot send, and the
 * branch that handled it could only be reached by a test inventing one.
 */
function windowPhrase(): string {
  return `for ${data.value.start_date} to ${data.value.end_date}`
}

const windowLabel = computed(() => (
  data.value.never_fetched
    ? 'No period measured yet'
    : `Measured over ${data.value.start_date} to ${data.value.end_date}`
))

const metricsOf = (episode: Episode) =>
  METRIC_LABELS.map(({ id, label }) => ({ id, label, ...describe(episode.metrics[id]) }))

const headline = computed(() => {
  if (data.value.empty_reason === 'no_channel_assigned') return 'No channel assigned'
  if (data.value.never_fetched) return 'Analytics have not been fetched yet'
  return `Last fetched ${formatWhen(data.value.fetched_at)}`
})

const emptyMessage = computed(() => {
  if (data.value.empty_reason === 'no_channel_assigned') {
    return 'Assign a YouTube channel to this project first.'
  }
  return 'No episode from this project has been published to this channel yet.'
})

function formatWhen(value: string | null | undefined): string {
  if (!value) return 'never'
  const when = new Date(value)
  return Number.isNaN(when.getTime()) ? 'an unknown time' : when.toLocaleString()
}

async function load(): Promise<void> {
  try {
    data.value = await get<Analytics>(`/projects/${slug.value}/youtube/analytics`)
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Failed to load analytics.'
  } finally {
    loading.value = false
  }
}

async function refresh(): Promise<void> {
  busy.value = true
  actionResult.value = null
  try {
    const res = await post<{ fetched: number, partial: boolean }>(
      `/projects/${slug.value}/youtube/analytics/refresh`, {})
    actionResult.value = {
      kind: res.partial ? 'warn' : 'ok',
      message: res.partial
        ? `Fetched ${res.fetched} episode(s) — this is not the whole picture.`
        : `Fetched ${res.fetched} episode(s).`,
    }
    await load()
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Failed to fetch analytics.' }
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.uc-analytics { display: grid; gap: 12px; min-width: 0; container-type: inline-size; }
.panel { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); }
.header { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: flex-start; }
.header h3 { margin: 4px 0; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.hint { color: var(--text-muted); font-size: 12px; margin: 0; }
.window { margin: 2px 0 6px; font-size: 13px; font-weight: 600; }
.field-row { display: flex; gap: 8px; align-items: center; }
.partial { border-color: var(--warn, #b8860b); }
.partial h3 { margin: 0 0 4px; font-size: 14px; }
.result { margin: 0; font-size: 13px; }
.result.err { color: var(--danger, #b00020); }
.result.warn { color: var(--warn, #b8860b); }
.episode-head { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
.metrics { display: grid; gap: 8px; margin: 10px 0 0; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.metric dt { color: var(--text-muted); font-size: 12px; }
.metric dd { margin: 2px 0 0; display: grid; gap: 2px; }
/* The four states differ in weight and colour as well as in words, so the
   difference survives a glance, not only a careful read. */
.metric[data-state="value"] strong { font-size: 18px; }
.metric[data-state="not_fetched"] strong,
.metric[data-state="no_data"] strong,
.metric[data-state="not_available"] strong { font-size: 13px; font-weight: 500; color: var(--text-muted); }
@container (max-width: 480px) {
  .metrics { grid-template-columns: 1fr 1fr; }
}
</style>
