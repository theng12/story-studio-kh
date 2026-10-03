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
        <div class="period">
          <label class="field">
            <span>Period</span>
            <select v-model="preset" class="input" :disabled="busy">
              <option v-for="option in PRESETS" :key="option.id" :value="option.id">{{ option.label }}</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>
          <template v-if="preset === 'custom'">
            <label class="field">
              <span>From</span>
              <input v-model="customStart" class="input" type="date" :max="todayUtc()" :disabled="busy">
            </label>
            <label class="field">
              <span>To</span>
              <input v-model="customEnd" class="input" type="date" :max="todayUtc()" :disabled="busy">
            </label>
          </template>
          <p class="hint control-hint">{{ periodProblem || 'Pick the period the figures should cover. Dates are in UTC, as YouTube counts them.' }}</p>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="busy || !!periodProblem || data.empty_reason === 'no_channel_assigned'"
            @click="refresh"
          >
            {{ busy ? 'Fetching…' : 'Fetch for This Period' }}
          </button>
          <p class="hint control-hint">
            {{ data.empty_reason === 'no_channel_assigned'
              ? 'Unavailable until a YouTube channel is assigned to this project.'
              : 'Asks YouTube for this period and replaces the saved figures. Nothing happens until you press it.' }}
          </p>
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
        <NuxtLink
          v-if="data.partial_reason === 'scope_missing' || data.partial_reason === 'not_connected'"
          :to="`/projects/${slug}/settings#youtube`"
          class="settings-link"
        >
          Open Settings → YouTube
        </NuxtLink>
        <p v-if="data.unreached_video_ids.length" class="hint">
          Not covered: {{ data.unreached_video_ids.join(', ') }}
        </p>
      </section>

      <p v-if="actionResult" class="result" :class="actionResult.kind">{{ actionResult.message }}</p>

      <section v-if="!data.episodes.length" class="panel hint-panel" role="status">
        <p class="hint">{{ emptyMessage }}</p>
      </section>

      <section v-else class="panel table-panel">
        <p class="window">
          {{ windowLabel }}<template v-if="!data.never_fetched"> · fetched {{ formatWhen(data.fetched_at) }}</template>
        </p>
        <p v-if="periodDiffers" class="result warn">
          The table still shows {{ data.start_date }} to {{ data.end_date }}. The period chosen above is
          {{ picked.start }} to {{ picked.end }} — press “Fetch for this period” to replace it.
        </p>
        <div class="toolbar">
          <label class="field search">
            <span>Find an episode</span>
            <input v-model="query" class="input" type="search" placeholder="Episode code or title">
            <span class="hint control-hint">Shows only matching rows. Totals and the export follow what is shown.</span>
          </label>
          <div class="field">
            <button class="btn btn-sm" type="button" :disabled="!shown.length" @click="exportCsv">Export CSV</button>
            <span class="hint control-hint">
              {{ shown.length
                ? 'Downloads exactly the rows shown, in this order, plus the totals row. Missing figures are written as words, never as 0.'
                : 'Nothing to export: no row matches the search.' }}
            </span>
          </div>
        </div>
        <p class="hint">
          Click a column heading to sort by it; click again to reverse. Rows without a figure always sort last.
          Hover a cell to see what it means and when it was checked.
        </p>

        <div class="table-wrap">
          <table class="uc-table">
            <thead>
              <tr>
                <th scope="col" class="sticky" :aria-sort="ariaSort('episode')">
                  <button type="button" class="sort" @click="sortBy('episode')">Episode{{ arrow('episode') }}</button>
                </th>
                <th v-for="col in COLUMNS" :key="col.id" scope="col" :aria-sort="ariaSort(col.id)">
                  <button type="button" class="sort" @click="sortBy(col.id)">{{ col.label }}{{ arrow(col.id) }}</button>
                </th>
              </tr>
            </thead>
            <tbody>
              <!--
                Keyed on the EPISODE code, not the video id. Two episodes linked to
                one video is a state this product models (Phase 6's "Conflict"), so
                it is two rows that must stay distinct.
              -->
              <tr v-for="row in shown" :key="row.code">
                <th scope="row" class="sticky">
                  <NuxtLink :to="publishLink(row.code)" class="code">{{ row.code }}</NuxtLink>
                  <span v-if="row.title" class="ep-title">{{ row.title }}</span>
                </th>
                <!--
                  `data-state` carries the state to the DOM so a reader, a test,
                  and a stylesheet all see the same four answers. The text differs
                  too — a state that only differed by attribute would still read as
                  a number on screen. The age and meaning ride in `title` and in
                  visually-hidden text, so 300 rows stay readable.
                -->
                <td
                  v-for="col in COLUMNS"
                  :key="col.id"
                  :class="col.fact ? 'fact' : 'metric'"
                  :data-state="row.cells[col.id].state"
                  :title="row.cells[col.id].detail"
                >
                  <span class="cell-text">{{ row.cells[col.id].text }}</span>
                  <span class="sr-only">{{ row.cells[col.id].detail }}</span>
                </td>
              </tr>
            </tbody>
            <tfoot v-if="shown.length">
              <tr class="totals">
                <th scope="row" class="sticky">{{ totalsLabel }}</th>
                <td v-for="col in COLUMNS" :key="col.id" :title="totalCell(col).detail">{{ totalCell(col).text }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p class="hint">
          Totals add up the count columns only, over the rows shown that have a figure. Averages, rates,
          dates and lengths have no total: adding them up would give a meaningless number.
        </p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Analytics: one row per episode.
 *
 * Every number here arrives as a state, not a bare figure, and is rendered
 * through `describe()` below so "YouTube said 0", "we never asked", "YouTube
 * does not offer this here" and "YouTube had nothing to say" cannot look alike
 * on screen, in a total, or in the CSV. No monetary figures, no composite
 * score, and no card-click rate — the metric whose old label said something it
 * did not measure. "Click-through rate" here is the THUMBNAIL rate.
 */
interface Metric { state: string, value?: number, fetched_at?: string, reason?: string }
interface Episode {
  episode_code: string
  /** The accepted idea's title, read live by the route; '' when there is none. */
  title: string
  video_id: string
  metrics: Record<string, Metric>
  /** Published (ms since epoch) and length (seconds), four-state like a metric. */
  facts: Record<string, Metric>
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
type Format = 'count' | 'percent' | 'duration' | 'date'
interface Column { id: string, label: string, csv?: string, format: Format, total?: boolean, fact?: boolean }
interface Cell { state: string, text: string, detail: string, sort: number | null, csv: string | number }

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

const METRIC_LABELS: Array<{ id: string, label: string, csv?: string, format: Format, total?: boolean }> = [
  { id: 'views', label: 'Views', format: 'count', total: true },
  { id: 'watch_minutes', label: 'Watch time (minutes)', format: 'count', total: true },
  { id: 'avg_view_seconds', label: 'Avg view duration', csv: 'Avg view duration (seconds)', format: 'duration' },
  { id: 'avg_view_percentage', label: 'Avg % viewed', format: 'percent' },
  { id: 'impressions', label: 'Impressions', format: 'count', total: true },
  { id: 'click_through_rate', label: 'Click-through rate', csv: 'Click-through rate (%)', format: 'percent' },
  { id: 'likes', label: 'Likes', format: 'count', total: true },
  { id: 'comments', label: 'Comments', format: 'count', total: true },
  { id: 'shares', label: 'Shares', format: 'count', total: true },
  { id: 'subscribers_gained', label: 'Subscribers gained', format: 'count', total: true },
]
const COLUMNS: Column[] = [
  { id: 'published', label: 'Published', format: 'date', fact: true },
  { id: 'length', label: 'Length', csv: 'Length (seconds)', format: 'duration', fact: true },
  ...METRIC_LABELS,
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

const SCOPE_MISSING_TEXT = 'Not available — reconnect YouTube with analytics access'

function formatValue(value: number, format: Format): string {
  if (format === 'date') return new Date(value).toISOString().slice(0, 10)
  if (format === 'percent') return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
  if (format === 'duration') {
    const total = Math.round(value)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = String(total % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
  }
  return value.toLocaleString('en-US')
}

/**
 * The rendered form of a metric or fact, and the ONLY one: the cell, the sort,
 * the totals and the CSV all read what this returns.
 */
function describe(metric: Metric | undefined, col: Column): Cell {
  const notFetched: Cell = data.value.partial_reason === 'scope_missing' && !col.fact
    // Not a fetch the owner forgot: a permission he has not granted.
    ? { state: 'not_fetched', text: SCOPE_MISSING_TEXT, detail: 'This channel has not granted analytics access, so this was never measured.', sort: null, csv: SCOPE_MISSING_TEXT }
    : { state: 'not_fetched', text: 'Not fetched', detail: 'Fetch analytics to see this.', sort: null, csv: 'Not fetched' }
  switch (metric?.state) {
    case 'value':
      // No `?? 0`. A `value` state without a number is malformed, and printing
      // 0 for it would manufacture the exact reading this page exists to
      // prevent — it falls through to "not fetched" instead.
      if (typeof metric.value !== 'number') break
      return {
        state: 'value',
        text: formatValue(metric.value, col.format),
        detail: col.fact
          ? `From YouTube’s video details, read ${formatWhen(metric.fetched_at)}`
          : `${windowPhrase()} · measured ${formatWhen(metric.fetched_at)}`,
        sort: metric.value,
        csv: col.format === 'date' ? formatValue(metric.value, 'date') : metric.value,
      }
    case 'not_available':
      return {
        state: 'not_available',
        text: 'Not available',
        detail: `${metric.reason || 'YouTube does not offer this here.'} (checked ${formatWhen(metric.fetched_at)})`,
        sort: null,
        csv: 'Not available',
      }
    case 'no_data':
      return {
        state: 'no_data',
        text: 'No data yet',
        // Scoped to the window: this says the PERIOD was quiet, not that the
        // video has never been watched.
        detail: `YouTube reported nothing ${windowPhrase()} (checked ${formatWhen(metric.fetched_at)})`,
        sort: null,
        csv: 'No data yet',
      }
  }
  return notFetched
}

/**
 * "for 2026-06-05 to 2026-09-03". The window is required on the stored cache,
 * so a fetched response always carries one.
 */
function windowPhrase(): string {
  return `for ${data.value.start_date} to ${data.value.end_date}`
}

const windowLabel = computed(() => (
  data.value.never_fetched
    ? 'No period measured yet'
    : `Measured over ${data.value.start_date} to ${data.value.end_date}`
))

const rows = computed(() => data.value.episodes.map(episode => ({
  code: episode.episode_code,
  title: episode.title || '',
  video_id: episode.video_id,
  cells: Object.fromEntries(COLUMNS.map(col => [
    col.id, describe((col.fact ? episode.facts : episode.metrics)?.[col.id], col),
  ])) as Record<string, Cell>,
})))
type Row = typeof rows.value[number]

// ── Filter and sort ─────────────────────────────────────────────────────────
const query = ref('')
const sortKey = ref('episode')
const sortDir = ref<'asc' | 'desc'>('asc')

function sortBy(key: string): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    // Figures start biggest-first; episodes start in code order.
    sortDir.value = key === 'episode' ? 'asc' : 'desc'
  }
}
const ariaSort = (key: string) =>
  sortKey.value === key ? (sortDir.value === 'asc' ? 'ascending' : 'descending') : 'none'
const arrow = (key: string) => (sortKey.value === key ? (sortDir.value === 'asc' ? ' ▲' : ' ▼') : '')

const shown = computed<Row[]>(() => {
  const needle = query.value.trim().toLowerCase()
  const filtered = needle
    ? rows.value.filter(row => row.code.toLowerCase().includes(needle) || row.title.toLowerCase().includes(needle))
    : rows.value
  const mul = sortDir.value === 'asc' ? 1 : -1
  const byCode = (a: Row, b: Row) => a.code.localeCompare(b.code, undefined, { numeric: true })
  return [...filtered].sort((a, b) => {
    if (sortKey.value === 'episode') return byCode(a, b) * mul
    const left = a.cells[sortKey.value]!.sort
    const right = b.cells[sortKey.value]!.sort
    // A row with no figure is not "smallest": it sorts last in BOTH directions.
    if (left === null || right === null) return left === right ? byCode(a, b) : (left === null ? 1 : -1)
    return (left - right) * mul || byCode(a, b)
  })
})

// ── Totals ──────────────────────────────────────────────────────────────────
const measuredRows = computed(() => shown.value.filter(row => row.cells.views!.state === 'value').length)
const totalsLabel = computed(() => `Totals of ${measuredRows.value} measured rows of ${shown.value.length} shown`)

/** A sum only for counts, only over figures - never a 0 standing in for "none". */
function totalCell(col: Column): { text: string, csv: string | number, detail: string } {
  if (!col.total) return { text: 'No total', csv: 'No total', detail: 'Averages, rates, dates and lengths are not added up.' }
  const values = shown.value.map(row => row.cells[col.id]!.sort).filter((v): v is number => v !== null)
  if (!values.length) return { text: 'No figures', csv: 'No figures', detail: 'None of the rows shown has a figure here.' }
  const sum = values.reduce((a, b) => a + b, 0)
  return { text: formatValue(sum, 'count'), csv: sum, detail: `Sum of the ${values.length} row(s) shown that have a figure.` }
}

// ── CSV ─────────────────────────────────────────────────────────────────────
function csvCell(value: string | number): string {
  if (typeof value === 'number') return String(value)
  // A cell a spreadsheet would run as a formula is written as text.
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvText(): string {
  const lines: Array<Array<string | number>> = [
    ['Episode', 'Title', 'Video ID', ...COLUMNS.map(col => col.csv ?? col.label)],
    ...shown.value.map(row => [row.code, row.title, row.video_id, ...COLUMNS.map(col => row.cells[col.id]!.csv)]),
    [totalsLabel.value, '', '', ...COLUMNS.map(col => totalCell(col).csv)],
  ]
  return lines.map(line => line.map(csvCell).join(',')).join('\n')
}

function exportCsv(): void {
  const period = data.value.never_fetched ? 'not-fetched' : `${data.value.start_date}-to-${data.value.end_date}`
  const blob = new Blob([csvText()], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `analytics-${slug.value}-${period}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const publishLink = (code: string) => `/projects/${slug.value}/upload/publish?episode_id=${encodeURIComponent(code)}`

// ── Period ──────────────────────────────────────────────────────────────────
const PRESETS = [
  { id: '7', label: 'Last 7 days' },
  { id: '28', label: 'Last 28 days' },
  { id: '90', label: 'Last 90 days' },
  { id: '365', label: 'Last 365 days' },
]
/** UTC calendar days, as YouTube's reports and the server's checks use. */
const todayUtc = () => new Date().toISOString().slice(0, 10)
const daysAgoUtc = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
const preset = ref('90')
const customStart = ref('')
const customEnd = ref('')
const picked = computed(() => (preset.value === 'custom'
  ? { start: customStart.value, end: customEnd.value }
  : { start: daysAgoUtc(Number(preset.value)), end: todayUtc() }))
const periodProblem = computed(() => {
  const { start, end } = picked.value
  if (!start || !end) return 'Choose both a start date and an end date.'
  if (start > end) return 'The start date must be on or before the end date.'
  if (end > todayUtc()) return 'The end date cannot be in the future.'
  return ''
})
const periodDiffers = computed(() => !data.value.never_fetched
  && (picked.value.start !== data.value.start_date || picked.value.end !== data.value.end_date))

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
      `/projects/${slug.value}/youtube/analytics/refresh`,
      { start_date: picked.value.start, end_date: picked.value.end })
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
.panel { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); min-width: 0; }
.header { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: flex-start; }
.header > div:first-child { flex: 1 1 360px; min-width: 0; }
.header h3 { margin: 4px 0; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.hint { color: var(--text-muted); font-size: var(--font-xs); margin: 0; }
.window { margin: 2px 0 6px; font-size: var(--font-sm); font-weight: 600; }
.period { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: flex-end; flex: 0 1 420px; }
.period .control-hint { flex-basis: 100%; }
.field { display: grid; gap: 2px; font-size: var(--font-xs); color: var(--text-muted); }
.field input, .field select { font-size: var(--font-sm); }
.field > .btn { justify-self: start; }
.settings-link { font-size: var(--font-sm); color: var(--accent); }
.partial { border-color: var(--warn, #b8860b); }
.partial h3 { margin: 0 0 4px; font-size: var(--font-md); }
.result { margin: 0; font-size: var(--font-sm); }
.result.err { color: var(--danger, #b00020); }
.result.warn { color: var(--warn, #b8860b); }
.table-panel { display: grid; gap: 8px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-end; justify-content: space-between; }
.toolbar .search { flex: 1 1 280px; max-width: 420px; }
.toolbar .field:last-child { max-width: 360px; }
/* The table scrolls inside its own box, never the page. */
.table-wrap { overflow-x: auto; max-width: 100%; border: 1px solid var(--border); border-radius: 8px; }
.uc-table { border-collapse: collapse; width: 100%; font-size: var(--font-sm); }
.uc-table th, .uc-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right; vertical-align: top; }
.uc-table thead th { position: sticky; top: 0; background: var(--surface); white-space: nowrap; }
.uc-table .sticky { position: sticky; left: 0; z-index: 1; background: var(--surface); text-align: left; min-width: 150px; max-width: 220px; }
.uc-table thead .sticky { z-index: 2; }
.sort { background: none; border: 0; padding: 0; font: inherit; font-weight: 600; color: inherit; cursor: pointer; }
.code { font-weight: 600; color: var(--accent); }
.ep-title { display: block; font-weight: 400; color: var(--text-muted); font-size: var(--font-xs); white-space: normal; }
td[data-state="value"] { font-variant-numeric: tabular-nums; white-space: nowrap; }
/* The four states differ in weight and colour as well as in words, so the
   difference survives a glance, not only a careful read. */
td[data-state="not_fetched"], td[data-state="no_data"], td[data-state="not_available"] {
  color: var(--text-muted); font-size: var(--font-xs); font-style: italic; min-width: 128px;
}
.totals th, .totals td { font-weight: 600; border-top: 2px solid var(--border); border-bottom: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
