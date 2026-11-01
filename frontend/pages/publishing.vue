<template>
  <div class="publishing-page page-frame">
    <PlainBackLink />
    <PageTitle
      eyebrow="Publishing"
      title="Publishing Overview"
      description="Every channel in one place: what YouTube has confirmed, what Story Studio plans, and which channel needs you next. A local plan never covers a confirmed gap — a channel whose next slot YouTube has not confirmed reads as at risk."
    >
      <template #actions>
        <span v-if="generatedAt" class="publishing-generated">Overview updated {{ generatedAt }}</span>
        <button class="btn btn-secondary btn-sm" :disabled="refreshing" @click="refresh">
          {{ refreshing ? 'Checking YouTube…' : 'Check YouTube Now' }}
        </button>
      </template>
    </PageTitle>
    <ApiDataStatus path="/publishing/overview" @retry="load" />

    <p v-if="loading && !overview" class="empty" role="status">Loading the publishing overview…</p>

    <WorkspaceNotice v-if="error" tone="warning" title="Publishing overview unavailable">
      {{ error }}
      <template #actions>
        <button type="button" class="btn btn-sm btn-secondary" :disabled="loading" @click="load(true)">Try Again</button>
      </template>
    </WorkspaceNotice>

    <template v-if="overview">
      <section v-if="overview.channels.length === 0" class="empty" role="status">
        <h2>No channels yet</h2>
        <p>Create a channel and it will appear here with its schedule.</p>
        <NuxtLink to="/" class="btn btn-secondary btn-sm">Go to your channels</NuxtLink>
      </section>

      <template v-else>
        <div class="publishing-toolbar">
          <input
            v-model="query"
            class="channel-search"
            type="search"
            placeholder="Search channels by name, slug or YouTube title"
            aria-label="Search channels by name, slug or connected YouTube title"
          />
          <nav class="publishing-tabs" role="tablist" aria-label="Publishing views" @keydown="moveTab">
            <button
              v-for="tab in tabs"
              :id="`publishing-tab-${tab.id}`"
              :key="tab.id"
              :ref="element => setTabRef(tab.id, element)"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.id"
              :aria-controls="`publishing-panel-${tab.id}`"
              :tabindex="activeTab === tab.id ? 0 : -1"
              @click="activeTab = tab.id"
            >{{ tab.label }}<span>{{ tabCountLabel(tab.id) }}</span></button>
          </nav>
        </div>

        <!-- Coverage: sortable, searchable channel table. Filter and sort run
             before the 25-channel page slice, so a page never hides a match. -->
        <section
          id="publishing-panel-coverage"
          class="publishing-section"
          role="tabpanel"
          aria-labelledby="publishing-tab-coverage"
          :hidden="activeTab !== 'coverage'"
        >
          <div class="section-head">
            <h2 id="coverage-title">Coverage</h2>
            <span v-if="sortedChannels.length" class="result-count">
              {{ coverageStart }}–{{ coverageEnd }} of {{ sortedChannels.length }} channels
            </span>
          </div>
          <p class="section-hint">
            “Next uncovered slot” is the earliest expected slot with no confirmed YouTube schedule. A
            channel with no plan says so — Story Studio will not guess a rhythm. Sort any column with
            its header button; unknown values stay last.
          </p>
          <p v-if="sortedChannels.length === 0" class="empty" role="status">No channel matches “{{ query.trim() }}”.</p>
          <template v-else>
            <div class="coverage-scroll">
              <table class="coverage-table">
                <thead>
                  <tr>
                    <th scope="col" :aria-sort="ariaSort('name')">
                      <button type="button" class="sort-button" @click="sortBy('name')">Channel <span aria-hidden="true">{{ sortIndicator('name') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('next_uncovered')">
                      <button type="button" class="sort-button" @click="sortBy('next_uncovered')">Next uncovered slot <span aria-hidden="true">{{ sortIndicator('next_uncovered') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('last_confirmed')">
                      <button type="button" class="sort-button" @click="sortBy('last_confirmed')">Last confirmed <span aria-hidden="true">{{ sortIndicator('last_confirmed') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('last_planned')">
                      <button type="button" class="sort-button" @click="sortBy('last_planned')">Last planned <span aria-hidden="true">{{ sortIndicator('last_planned') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('confirmed_count')">
                      <button type="button" class="sort-button" @click="sortBy('confirmed_count')">Confirmed <span aria-hidden="true">{{ sortIndicator('confirmed_count') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('planned_count')">
                      <button type="button" class="sort-button" @click="sortBy('planned_count')">Planned dates <span aria-hidden="true">{{ sortIndicator('planned_count') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('ready')">
                      <button type="button" class="sort-button" @click="sortBy('ready')">Ready <span aria-hidden="true">{{ sortIndicator('ready') }}</span></button>
                    </th>
                    <th scope="col" :aria-sort="ariaSort('youtube')">
                      <button type="button" class="sort-button" @click="sortBy('youtube')">YouTube <span aria-hidden="true">{{ sortIndicator('youtube') }}</span></button>
                    </th>
                    <th scope="col">Next step</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="channel in pagedChannels" :key="channel.slug" :class="{ 'row-at-risk': channel.coverage.at_risk }">
                    <td>
                      <NuxtLink :to="`/projects/${channel.slug}/board`" class="channel-link">{{ channel.name }}</NuxtLink>
                      <span v-if="channel.channel" class="channel-handle">{{ channel.channel.title }}</span>
                      <span v-else class="channel-handle muted">{{ channelStateLabel(channel) }}</span>
                    </td>
                    <td>
                      <template v-if="channel.coverage.next_uncovered_slot">
                        <span v-if="channel.coverage.at_risk" class="risk-badge">At risk</span>
                        <time :datetime="channel.coverage.next_uncovered_slot">{{ formatInstant(channel.coverage.next_uncovered_slot) }}</time>
                      </template>
                      <!-- An unreadable plan is NOT an absent one: say which. -->
                      <template v-else-if="channel.plan_set === null">
                        <span class="muted" :title="channel.plan_error || ''">Couldn't read publishing plan</span>
                        <NuxtLink :to="`/projects/${channel.slug}/upload/plans`" class="plan-link">Open publishing plans</NuxtLink>
                      </template>
                      <template v-else-if="channel.plan_set === false">
                        <span class="muted">Publishing plan not set</span>
                        <NuxtLink :to="`/projects/${channel.slug}/upload/plans`" class="plan-link">Set a plan</NuxtLink>
                      </template>
                      <!-- No expected slot is not the same as every expected slot confirmed. -->
                      <template v-else-if="channel.planned.slots.length">
                        <span class="muted">All expected slots confirmed</span>
                      </template>
                      <template v-else>
                        <span class="muted">No expected slots in the horizon</span>
                      </template>
                      <!-- The plan's days and the releases' days disagree: said here, never repaired. -->
                      <p v-if="offCadenceNote(channel)" class="cadence-note">{{ offCadenceNote(channel) }}</p>
                    </td>
                    <td>
                      <time v-if="channel.coverage.last_confirmed_date" :datetime="channel.coverage.last_confirmed_date">
                        {{ channel.coverage.last_confirmed_date }}
                      </time>
                      <span v-else class="muted">—</span>
                    </td>
                    <td>
                      <time v-if="channel.coverage.last_planned_date" :datetime="channel.coverage.last_planned_date">
                        {{ channel.coverage.last_planned_date }}
                      </time>
                      <span v-else class="muted">—</span>
                    </td>
                    <td>{{ channel.coverage.scheduled_video_count }}</td>
                    <td>{{ channel.coverage.planned_date_count }}</td>
                    <td>
                      <span
                        v-if="channel.coverage.ready_video_count === null"
                        class="muted"
                        :title="channel.readiness.error || 'Story Studio could not read this channel\'s episodes'"
                      >unknown<span v-if="channel.readiness.ready_unknown > 0"> · {{ channel.readiness.ready_unknown }} unreadable</span></span>
                      <span v-else>{{ channel.coverage.ready_video_count }}</span>
                    </td>
                    <td>
                      <span class="freshness" :class="`freshness-${channel.confirmed.freshness}`">{{ freshnessLabel(channel) }}</span>
                    </td>
                    <td>
                      <NuxtLink :to="channel.next_action.url" class="btn btn-secondary btn-sm">{{ channel.next_action.label }}</NuxtLink>
                      <ul v-if="channel.recommendations.length > 1" class="rec-list">
                        <li v-for="rec in channel.recommendations.slice(1)" :key="rec.episode_code">
                          <NuxtLink :to="rec.url" class="rec-link" :title="rec.reason">{{ rec.label }}</NuxtLink>
                        </li>
                      </ul>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <nav v-if="coveragePageCount > 1" class="pagination" aria-label="Coverage pages">
              <button type="button" class="btn btn-secondary btn-sm" :disabled="coveragePage === 1" @click="previousCoveragePage">Previous</button>
              <span>Page {{ coveragePage }} of {{ coveragePageCount }}</span>
              <button type="button" class="btn btn-secondary btn-sm" :disabled="coveragePage === coveragePageCount" @click="nextCoveragePage">Next</button>
            </nav>
          </template>
        </section>

        <!-- Calendar: Week/Month/Year over LOCAL dates, one bounded batch of 25
             EVENTS (never 25 days), confirmed and planned kept distinct. -->
        <section
          id="publishing-panel-calendar"
          class="publishing-section"
          role="tabpanel"
          aria-labelledby="publishing-tab-calendar"
          :hidden="activeTab !== 'calendar'"
        >
          <div class="calendar-head">
            <h2 id="calendar-title">Calendar</h2>
            <ul class="legend" aria-label="Legend">
              <li><span class="legend-swatch legend-confirmed" aria-hidden="true"></span> Confirmed by YouTube</li>
              <li><span class="legend-swatch legend-planned" aria-hidden="true"></span> Planned (target)</li>
              <li><span class="legend-swatch legend-empty" aria-hidden="true"></span> Expected slot, nothing placed</li>
            </ul>
          </div>

          <div class="calendar-controls">
            <div class="calendar-views" role="group" aria-label="Calendar range">
              <button
                v-for="view in calendarViews"
                :key="view.id"
                type="button"
                class="calendar-view-button"
                :aria-pressed="calendarView === view.id"
                @click="setCalendarView(view.id)"
              >{{ view.label }}</button>
            </div>
            <div class="calendar-nav">
              <button type="button" class="btn btn-secondary btn-sm" @click="shiftCalendar(-1)">Previous</button>
              <button type="button" class="btn btn-secondary btn-sm" @click="goToday">Today</button>
              <button type="button" class="btn btn-secondary btn-sm" @click="shiftCalendar(1)">Next</button>
              <span class="calendar-range" aria-live="polite">{{ calendarRangeLabel }}</span>
            </div>
          </div>

          <p class="section-hint">
            Expected-slot markers come from the publishing plan's next 12 slots — not a complete
            annual horizon. Every confirmed and locally planned entry returned for this range is
            listed; events are paginated in batches of 25, never by day.
          </p>

          <!-- The plan's days and the releases' days disagree: said here too,
               because the empty expected slots are the visible symptom. -->
          <ul v-if="cadenceNotes.length" class="cadence-notes">
            <li v-for="note in cadenceNotes" :key="note.slug" class="cadence-note">
              {{ note.name }}: {{ note.text }}
            </li>
          </ul>

          <p v-if="calendarEvents.length === 0" class="empty" role="status">
            Nothing scheduled, planned or expected in this range{{ query.trim() ? ` for “${query.trim()}”` : '' }}.
          </p>

          <template v-else>
            <ol class="calendar-list">
              <li v-for="day in visibleCalendarDays" :key="day.key" class="calendar-day">
                <div class="calendar-day-label">
                  <time :datetime="day.key">{{ day.label }}</time>
                </div>
                <ul class="calendar-events">
                  <li
                    v-for="event in day.events"
                    :key="event.key"
                    class="calendar-event"
                    :class="[`event-${event.kind}`, { 'event-empty': event.empty }]"
                  >
                    <span class="event-kind">{{ event.kind === 'confirmed' ? 'Confirmed' : (event.empty ? 'Expected' : 'Planned') }}</span>
                    <span class="event-channel">{{ event.channel_name }}</span>
                    <span class="event-time">{{ formatTime(event.at) }}</span>
                    <span v-if="event.title || event.episode_code" class="event-title">{{ event.title || event.episode_code }}</span>
                    <span v-else-if="event.empty" class="event-title muted">Expected slot — nothing placed yet</span>
                    <!-- An unresolved identity is NOT the same fact as a key that
                         names no episode, so it is never spelled the same way. -->
                    <span v-else-if="event.identity_unknown" class="event-title muted">Locally planned date — episode unknown</span>
                    <span v-else class="event-title muted">Locally planned date</span>
                    <span v-if="event.kind === 'confirmed'" class="event-badge confirmed-badge">on YouTube</span>
                  </li>
                </ul>
              </li>
            </ol>
            <nav v-if="calendarPageCount > 1" class="pagination" aria-label="Calendar event pages">
              <button type="button" class="btn btn-secondary btn-sm" :disabled="calendarPage === 1" @click="previousCalendarPage">Previous</button>
              <span>Events {{ calendarEventStart }}–{{ calendarEventEnd }} of {{ calendarEvents.length }}</span>
              <button type="button" class="btn btn-secondary btn-sm" :disabled="calendarPage === calendarPageCount" @click="nextCalendarPage">Next</button>
            </nav>
          </template>
        </section>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePublishingOverview } from '~/composables/usePublishingOverview'
import type { PublishingOverviewCalendarEntry, PublishingOverviewChannel } from '@shared/publishing-overview'

const { overview, loading, error, refreshing, load, refresh } = usePublishingOverview()

// Load once when the page is opened. Never on every render.
load()

const generatedAt = computed(() => (overview.value ? formatInstant(overview.value.generated_at) : ''))

// ---- Accessible Coverage/Calendar tabs (the Studio Library's roving-tabindex pattern)
type PublishingTab = 'coverage' | 'calendar'

const tabs: Array<{ id: PublishingTab; label: string }> = [
  { id: 'coverage', label: 'Coverage' },
  { id: 'calendar', label: 'Calendar' },
]
const activeTab = ref<PublishingTab>('coverage')
const tabRefs = new Map<PublishingTab, HTMLButtonElement>()

function setTabRef(id: PublishingTab, element: unknown): void {
  if (element instanceof HTMLButtonElement) tabRefs.set(id, element)
  else tabRefs.delete(id)
}

function moveTab(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = tabs.findIndex(tab => tab.id === activeTab.value)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  const target = tabs[next]
  if (!target) return
  activeTab.value = target.id
  tabRefs.get(target.id)?.focus()
}

// ---- One channel search, shared by BOTH views --------------------------------
// Matches the channel name, its slug, and the connected YouTube channel title.
const query = ref('')

function channelMatches(channel: PublishingOverviewChannel, needle: string): boolean {
  if (!needle) return true
  return channel.name.toLowerCase().includes(needle)
    || channel.slug.toLowerCase().includes(needle)
    || (channel.channel?.title || '').toLowerCase().includes(needle)
}

const filteredChannels = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return (overview.value?.channels ?? []).filter(channel => channelMatches(channel, needle))
})

const channelsBySlug = computed(() => new Map(
  (overview.value?.channels ?? []).map(channel => [channel.slug, channel] as [string, PublishingOverviewChannel]),
))

// ---- Coverage sorting --------------------------------------------------------
type SortKey = 'name' | 'next_uncovered' | 'last_confirmed' | 'last_planned' | 'confirmed_count' | 'planned_count' | 'ready' | 'youtube'

const sortKey = ref<SortKey | null>(null)
const sortDir = ref<'asc' | 'desc'>('asc')

function sortBy(key: SortKey): void {
  if (sortKey.value !== key) {
    sortKey.value = key
    sortDir.value = 'asc'
  } else if (sortDir.value === 'asc') {
    sortDir.value = 'desc'
  } else {
    // Third press returns to the API's own priority order.
    sortKey.value = null
    sortDir.value = 'asc'
  }
}

function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}

function sortIndicator(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? '▲' : '▼'
}

function timestampValue(value: string | null): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

function sortValue(channel: PublishingOverviewChannel, key: SortKey): string | number | null {
  switch (key) {
    case 'name': return channel.name.toLowerCase()
    case 'next_uncovered': return timestampValue(channel.coverage.next_uncovered_slot)
    case 'last_confirmed': return timestampValue(channel.coverage.last_confirmed_date)
    case 'last_planned': return timestampValue(channel.coverage.last_planned_date)
    case 'confirmed_count': return channel.coverage.scheduled_video_count
    case 'planned_count': return channel.coverage.planned_date_count
    case 'ready': return channel.coverage.ready_video_count
    case 'youtube':
      // Disconnected / never-checked are unknown, not "bad": they sort last.
      if (channel.confirmed.error === 'no_channel_assigned' || channel.confirmed.error === 'channel_not_connected') return null
      if (channel.confirmed.freshness === 'unknown') return null
      return channel.confirmed.freshness === 'fresh' ? 0 : 1
  }
}

function isUnknown(value: string | number | null): boolean {
  return value === null || value === ''
}

const sortedChannels = computed(() => {
  const key = sortKey.value
  const list = filteredChannels.value
  if (!key) return list // Default: the API's own priority order.
  const direction = sortDir.value === 'asc' ? 1 : -1
  return list
    .map((channel, index) => ({ channel, index, value: sortValue(channel, key) }))
    .sort((a, b) => {
      // Unknown sorts last in BOTH directions; ties keep API priority (stable).
      const aUnknown = isUnknown(a.value)
      const bUnknown = isUnknown(b.value)
      if (aUnknown || bUnknown) {
        if (aUnknown && bUnknown) return a.index - b.index
        return aUnknown ? 1 : -1
      }
      const result = typeof a.value === 'number' && typeof b.value === 'number'
        ? a.value - b.value
        : String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: 'base' })
      return result !== 0 ? result * direction : a.index - b.index
    })
    .map(item => item.channel)
})

// ---- Coverage pagination (after filter + sort) -------------------------------
const COVERAGE_PAGE_SIZE = 25
const coveragePage = ref(1)
const coveragePageCount = computed(() => Math.max(1, Math.ceil(sortedChannels.value.length / COVERAGE_PAGE_SIZE)))
const pagedChannels = computed(() => {
  const page = Math.min(coveragePage.value, coveragePageCount.value)
  return sortedChannels.value.slice((page - 1) * COVERAGE_PAGE_SIZE, page * COVERAGE_PAGE_SIZE)
})
const coverageStart = computed(() => (sortedChannels.value.length === 0 ? 0 : (Math.min(coveragePage.value, coveragePageCount.value) - 1) * COVERAGE_PAGE_SIZE + 1))
const coverageEnd = computed(() => Math.min(Math.min(coveragePage.value, coveragePageCount.value) * COVERAGE_PAGE_SIZE, sortedChannels.value.length))

function previousCoveragePage(): void { coveragePage.value = Math.max(1, coveragePage.value - 1) }
function nextCoveragePage(): void { coveragePage.value = Math.min(coveragePageCount.value, coveragePage.value + 1) }

// A filter/sort change resets to page 1; a shrinking result clamps the page.
watch([query, sortKey, sortDir], () => { coveragePage.value = 1 })
watch(coveragePageCount, count => { if (coveragePage.value > count) coveragePage.value = count })

// ---- Calendar: Week / Month / Year over local dates --------------------------
type CalendarView = 'week' | 'month' | 'year'

const calendarViews: Array<{ id: CalendarView; label: string }> = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
]
const calendarView = ref<CalendarView>('month')
const calendarPage = ref(1)

function startOfDay(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), date.getDate()) }
function addDays(date: Date, days: number): Date { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days) }

const anchor = ref(startOfDay(new Date()))

const calendarRange = computed(() => {
  if (calendarView.value === 'week') {
    const start = addDays(anchor.value, -((anchor.value.getDay() + 6) % 7)) // Monday start
    return { start, end: addDays(start, 6) }
  }
  if (calendarView.value === 'month') {
    return { start: new Date(anchor.value.getFullYear(), anchor.value.getMonth(), 1), end: new Date(anchor.value.getFullYear(), anchor.value.getMonth() + 1, 0) }
  }
  return { start: new Date(anchor.value.getFullYear(), 0, 1), end: new Date(anchor.value.getFullYear(), 11, 31) }
})

const calendarRangeLabel = computed(() => {
  const { start, end } = calendarRange.value
  if (calendarView.value === 'year') return String(start.getFullYear())
  if (calendarView.value === 'month') return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(start)
  const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${format.format(start)} – ${format.format(end)}`
})

function shiftCalendar(direction: number): void {
  if (calendarView.value === 'week') anchor.value = addDays(anchor.value, 7 * direction)
  else if (calendarView.value === 'month') anchor.value = new Date(anchor.value.getFullYear(), anchor.value.getMonth() + direction, 1)
  else anchor.value = new Date(anchor.value.getFullYear() + direction, 0, 1)
}

function goToday(): void { anchor.value = startOfDay(new Date()) }

function setCalendarView(view: CalendarView): void {
  calendarView.value = view
  calendarPage.value = 1
}

function calendarKey(entry: PublishingOverviewCalendarEntry): string {
  return `${entry.channel_slug}-${entry.kind}-${entry.at}-${entry.video_id || entry.episode_code || ''}`
}

// The API already bounds expected cadence markers to the plan's next 12 slots
// (PLANNED_SLOT_HORIZON); the page says so and never claims a complete year.
// Every entry the API returns for the visible range is preserved.
const calendarEvents = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const { start, end } = calendarRange.value
  const endExclusive = addDays(end, 1)
  return (overview.value?.calendar ?? [])
    .filter(entry => {
      const date = new Date(entry.at)
      if (Number.isNaN(date.getTime())) return false
      if (date < start || date >= endExclusive) return false
      const channel = channelsBySlug.value.get(entry.channel_slug)
      if (channel) return channelMatches(channel, needle)
      if (!needle) return true
      return entry.channel_name.toLowerCase().includes(needle) || entry.channel_slug.toLowerCase().includes(needle)
    })
    .map((entry, index) => ({ ...entry, key: `${calendarKey(entry)}-${index}` }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.key.localeCompare(b.key))
})

// Events are paginated in bounded batches, NOT days: 65 events on one day is
// 25 + 25 + 15, never one endless day list.
const CALENDAR_PAGE_SIZE = 25
const calendarPageCount = computed(() => Math.max(1, Math.ceil(calendarEvents.value.length / CALENDAR_PAGE_SIZE)))
const paginatedCalendarEvents = computed(() => {
  const page = Math.min(calendarPage.value, calendarPageCount.value)
  return calendarEvents.value.slice((page - 1) * CALENDAR_PAGE_SIZE, page * CALENDAR_PAGE_SIZE)
})
const calendarEventStart = computed(() => (calendarEvents.value.length === 0 ? 0 : (Math.min(calendarPage.value, calendarPageCount.value) - 1) * CALENDAR_PAGE_SIZE + 1))
const calendarEventEnd = computed(() => Math.min(Math.min(calendarPage.value, calendarPageCount.value) * CALENDAR_PAGE_SIZE, calendarEvents.value.length))

function previousCalendarPage(): void { calendarPage.value = Math.max(1, calendarPage.value - 1) }
function nextCalendarPage(): void { calendarPage.value = Math.min(calendarPageCount.value, calendarPage.value + 1) }

watch([query, calendarView, anchor], () => { calendarPage.value = 1 })
watch(calendarPageCount, count => { if (calendarPage.value > count) calendarPage.value = count })

interface CalendarDay {
  key: string
  label: string
  events: Array<PublishingOverviewCalendarEntry & { key: string }>
}

const visibleCalendarDays = computed<CalendarDay[]>(() => {
  const byDay = new Map<string, CalendarDay>()
  for (const entry of paginatedCalendarEvents.value) {
    const date = new Date(entry.at)
    const key = localDayKey(date)
    let day = byDay.get(key)
    if (!day) {
      day = { key, label: formatDay(date), events: [] }
      byDay.set(key, day)
    }
    day.events.push(entry)
  }
  return [...byDay.values()]
})

function tabCountLabel(tab: PublishingTab): string {
  return String(tab === 'coverage' ? filteredChannels.value.length : calendarEvents.value.length)
}

// ---- Formatting and honest labels -------------------------------------------
function localDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date)
}

function formatInstant(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date)
}

/** "No channel assigned" and "assigned but not connected" are different problems. */
function channelStateLabel(channel: PublishingOverviewChannel): string {
  if (channel.confirmed.error === 'no_channel_assigned') return 'No YouTube channel assigned'
  if (channel.confirmed.error === 'channel_not_connected') return 'YouTube channel assigned, not connected'
  return 'No YouTube channel connected'
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * The plan's expected days against the days the confirmed releases land on.
 *
 * A release on a day the plan does not expect is still a real release, and it
 * covers no expected slot — so "nothing placed" would read as "nothing is
 * coming". Counted inside the plan's next 12 slots only, and repairs nothing.
 */
function offCadenceNote(channel: PublishingOverviewChannel): string {
  const cadence = channel.cadence
  if (!cadence || cadence.off_cadence_count <= 0) return ''
  const count = cadence.off_cadence_count
  const one = count === 1
  const days = cadence.off_cadence_weekdays.map(day => WEEKDAY_NAMES[day] ?? '?').join(', ')
  return `${count} confirmed release${one ? '' : 's'} ${one ? 'lands' : 'land'} on a day the plan does not expect, between the first and last of the next 12 expected slots${days ? ` (${days})` : ''}`
}

const cadenceNotes = computed(() => filteredChannels.value
  .map(channel => ({ slug: channel.slug, name: channel.name, text: offCadenceNote(channel) }))
  .filter(note => note.text !== ''))

/**
 * Which artifact is actually old.
 *
 * The channel LISTING and the per-video checks have separate ages, so a label
 * that hangs "stale" on the newest check blames the wrong one.
 */
function freshnessLabel(channel: PublishingOverviewChannel): string {
  // The channel is not connected: nothing else applies.
  if (channel.confirmed.error === 'no_channel_assigned') return 'No channel assigned'
  if (channel.confirmed.error === 'channel_not_connected') return 'Not connected'
  // A read that FAILED is not a fresh answer.
  if (channel.confirmed.error) return `Couldn't read YouTube · ${channel.confirmed.error}`
  const listing = channel.confirmed.listing
  const attempt = listing?.last_attempt
  const staleVideos = channel.confirmed.stale_videos ?? 0
  const stalePart = staleVideos > 0 ? ` · ${staleVideos} stale check${staleVideos === 1 ? '' : 's'}` : ''
  // The last listing attempt failed: any freshness below is about the LAST
  // success, so the failed attempt is what the owner has to act on.
  if (attempt?.outcome === 'failed') {
    const code = attempt.error_code || 'unknown'
    const lastComplete = listing?.complete_at ? ` · last full read ${formatInstant(listing.complete_at)}` : ''
    return `Listing failed ${formatInstant(attempt.attempted_at)} · ${code}${lastComplete}${stalePart}`
  }
  if (channel.confirmed.freshness === 'unknown') return 'Never checked'
  if (channel.confirmed.freshness === 'fresh') return `Fresh · ${formatInstant(channel.confirmed.last_checked_at || '')}`
  // The listing is what finds releases Story Studio never made, so an old one
  // hides them: it is named first, with its own date.
  if (listing && listing.state !== 'complete') {
    if (listing.state === 'never') return `Never listed${stalePart}`
    return `Listing incomplete · ${formatInstant(listing.partial_at || '')}${stalePart}`
  }
  if (listing?.stale) return `Stale listing · ${formatInstant(listing.complete_at || '')}${stalePart}`
  if ((channel.confirmed.unchecked_videos ?? 0) > 0) return 'Checks incomplete'
  return `Stale checks${stalePart}`
}
</script>

<style scoped>
/* No width, margin or padding here: .page-frame owns the frame. This page used
   to declare `max-width: none` and run edge to edge while review sat in a
   720px column — the owner's "it's different width" (2026-11-01). */
.publishing-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.publishing-title { min-width: 0; }
.publishing-header h1 { margin: 2px 0 4px; font-size: 1.5rem; }
.publishing-header p { margin: 0; max-width: 72ch; color: var(--text-secondary, #666); line-height: 1.4; }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .72rem; color: var(--text-secondary, #888); }
.publishing-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: 0 0 auto; }
.publishing-generated { font-size: .78rem; color: var(--text-secondary, #888); }
.empty { padding: 18px; text-align: center; color: var(--text-secondary, #888); }

.publishing-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.channel-search {
  flex: 1 1 260px;
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--border, #ccc);
  border-radius: 8px;
  background: var(--bg-secondary, #fff);
  color: inherit;
  font: inherit;
}
.channel-search:focus-visible { outline: 3px solid var(--accent, #2f6feb); outline-offset: 2px; }
.publishing-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border: 1px solid var(--border, #e5e5e5); border-radius: 10px; background: var(--bg-secondary, #f7f7f7); }
.publishing-tabs button {
  display: inline-flex; align-items: center; gap: 7px; min-width: 0; min-height: 34px;
  padding: 6px 12px; border: 0; border-radius: 7px; background: transparent;
  color: var(--text-secondary, #555); cursor: pointer; font: inherit; font-weight: 600;
}
.publishing-tabs button:focus-visible { outline: 3px solid var(--accent, #2f6feb); outline-offset: 2px; }
.publishing-tabs button[aria-selected='true'] { background: var(--accent-dim, #e4ecff); color: var(--text-primary, #111); }
.publishing-tabs span { color: var(--accent, #2f6feb); font-size: .74rem; font-variant-numeric: tabular-nums; }

.publishing-section { margin-top: 14px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.section-head h2, .calendar-head h2 { margin: 0; font-size: 1.15rem; }
.result-count { color: var(--text-secondary, #888); font-size: .8rem; font-variant-numeric: tabular-nums; }
.section-hint { margin: 3px 0 8px; color: var(--text-secondary, #888); font-size: .82rem; max-width: 88ch; line-height: 1.4; }

.coverage-scroll { width: 100%; max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.coverage-table { width: 100%; min-width: 860px; border-collapse: collapse; font-size: .88rem; }
.coverage-table th, .coverage-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border, #e5e5e5); vertical-align: top; }
.coverage-table th { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-secondary, #888); white-space: nowrap; }
.sort-button { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-transform: inherit; letter-spacing: inherit; cursor: pointer; }
.sort-button:focus-visible { outline: 3px solid var(--accent, #2f6feb); outline-offset: 2px; }
.sort-button span { font-size: .68rem; }
.row-at-risk { background: color-mix(in srgb, var(--warning, #b26a00) 7%, transparent); }
.channel-link { font-weight: 600; }
.channel-handle { display: block; font-size: .78rem; color: var(--text-secondary, #888); }
.plan-link { display: block; margin-top: 2px; font-size: .8rem; }
.rec-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.rec-link { font-size: .78rem; }
.muted { color: var(--text-secondary, #999); }
.cadence-note { display: block; margin: 4px 0 0; font-size: .78rem; color: var(--warning, #b26a00); }
.cadence-notes { margin: 0 0 10px; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.cadence-notes .cadence-note { margin: 0; }
.risk-badge {
  display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 4px; font-size: .72rem;
  background: color-mix(in srgb, var(--warning, #b26a00) 18%, transparent); color: var(--warning, #b26a00);
}
.freshness { font-size: .8rem; white-space: nowrap; }
.freshness-fresh { color: var(--success, #2e7d32); }
.freshness-stale { color: var(--warning, #b26a00); }
.freshness-unknown { color: var(--text-secondary, #999); }

.pagination { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; font-size: .82rem; color: var(--text-secondary, #888); font-variant-numeric: tabular-nums; }

.calendar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.legend { display: flex; gap: 16px; list-style: none; margin: 0; padding: 0; font-size: .8rem; color: var(--text-secondary, #888); flex-wrap: wrap; }
.legend li { display: flex; align-items: center; gap: 6px; }
.legend-swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.legend-confirmed { background: var(--success, #2e7d32); }
.legend-planned { background: var(--accent, #2f6feb); }
.legend-empty { border: 1.5px dashed var(--accent, #2f6feb); background: transparent; }

.calendar-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.calendar-views { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid var(--border, #e5e5e5); border-radius: 9px; background: var(--bg-secondary, #f7f7f7); }
.calendar-view-button { min-height: 30px; padding: 4px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary, #555); font: inherit; font-size: .82rem; font-weight: 600; cursor: pointer; }
.calendar-view-button[aria-pressed='true'] { background: var(--accent-dim, #e4ecff); color: var(--text-primary, #111); }
.calendar-view-button:focus-visible { outline: 3px solid var(--accent, #2f6feb); outline-offset: 2px; }
.calendar-nav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.calendar-range { font-size: .85rem; font-weight: 600; }

.calendar-list { list-style: none; margin: 10px 0 0; padding: 0; }
.calendar-day { display: flex; gap: 14px; padding: 6px 0; border-top: 1px solid var(--border, #eee); }
.calendar-day-label { min-width: 170px; font-weight: 600; }
.calendar-events { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.calendar-event { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: .88rem; }
.event-kind { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; padding: 2px 6px; border-radius: 4px; }
.event-confirmed .event-kind { background: color-mix(in srgb, var(--success, #2e7d32) 15%, transparent); color: var(--success, #2e7d32); }
.event-planned .event-kind { background: color-mix(in srgb, var(--accent, #2f6feb) 15%, transparent); color: var(--accent, #2f6feb); }
.event-empty .event-kind { background: transparent; border: 1px dashed var(--accent, #2f6feb); color: var(--accent, #2f6feb); }
.event-channel { font-weight: 600; }
.event-time { color: var(--text-secondary, #888); }
.event-title { color: var(--text-secondary, #666); overflow-wrap: anywhere; }
.confirmed-badge { font-size: .72rem; color: var(--success, #2e7d32); }

@media (max-width: 720px) {
  .publishing-header { flex-direction: column; align-items: stretch; }
  .publishing-actions { align-items: flex-start; }
  .calendar-day { flex-direction: column; gap: 3px; }
  .calendar-day-label { min-width: 0; }
}
@media (max-width: 560px) {
  .publishing-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .publishing-tabs button { justify-content: center; min-height: 44px; }
  .calendar-view-button { min-height: 40px; }
  .pagination { justify-content: space-between; }
}
@media (max-width: 420px) {
  .calendar-nav { width: 100%; }
  .calendar-range { width: 100%; }
}
</style>