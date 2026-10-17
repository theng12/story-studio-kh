<template>
  <div class="publishing-page">
    <PlainBackLink />
    <header class="publishing-header">
      <div>
        <span class="eyebrow">Publishing</span>
        <h1>Publishing Overview</h1>
        <p>
          Every channel in one place: what YouTube has <em>confirmed</em>, what Story Studio
          <em>plans</em>, and which channel needs you next. A local plan never covers a confirmed gap —
          a channel whose next slot YouTube has not confirmed reads as at risk.
        </p>
      </div>
      <div class="publishing-actions">
        <span v-if="generatedAt" class="publishing-generated">Overview updated {{ generatedAt }}</span>
        <button class="btn btn-secondary btn-sm" :disabled="refreshing" @click="refresh">
          {{ refreshing ? 'Checking YouTube…' : 'Check YouTube Now' }}
        </button>
      </div>
    </header>

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
        <!-- Coverage: the list/table half of the view, and the accessible
             fallback for the calendar below. Confirmed and planned are separate
             columns on purpose — they are different facts. -->
        <section class="publishing-section" aria-labelledby="coverage-title">
          <h2 id="coverage-title">Coverage</h2>
          <p class="section-hint">
            “Next uncovered slot” is the earliest expected slot with no confirmed YouTube schedule. A
            channel with no plan says so — Story Studio will not guess a rhythm.
          </p>
          <div class="coverage-scroll">
            <table class="coverage-table">
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Next uncovered slot</th>
                  <th scope="col">Last confirmed</th>
                  <th scope="col">Last planned</th>
                  <th scope="col">Confirmed</th>
                  <th scope="col">Planned dates</th>
                  <th scope="col">Ready</th>
                  <th scope="col">YouTube</th>
                  <th scope="col">Next step</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="channel in overview.channels" :key="channel.slug" :class="{ 'row-at-risk': channel.coverage.at_risk }">
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
                    <template v-else>
                      <span class="muted">All expected slots confirmed</span>
                    </template>
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
        </section>

        <!-- The calendar: one row per day, confirmed and planned clearly split,
             in the viewer's own locale and timezone. -->
        <section class="publishing-section" aria-labelledby="calendar-title">
          <div class="calendar-head">
            <h2 id="calendar-title">Calendar</h2>
            <ul class="legend" aria-label="Legend">
              <li><span class="legend-swatch legend-confirmed" aria-hidden="true"></span> Confirmed by YouTube</li>
              <li><span class="legend-swatch legend-planned" aria-hidden="true"></span> Planned (target)</li>
              <li><span class="legend-swatch legend-empty" aria-hidden="true"></span> Expected slot, nothing placed</li>
            </ul>
          </div>

          <p v-if="days.length === 0" class="empty" role="status">
            Nothing scheduled or planned yet. Set a publishing plan on a channel to see expected slots here.
          </p>

          <ol v-else class="calendar-list">
            <li v-for="day in days" :key="day.key" class="calendar-day">
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
        </section>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usePublishingOverview } from '~/composables/usePublishingOverview'
import type { PublishingOverviewCalendarEntry, PublishingOverviewChannel } from '@shared/publishing-overview'

const { overview, loading, error, refreshing, load, refresh } = usePublishingOverview()

// Load once when the page is opened. Never on every render.
load()

const generatedAt = computed(() => (overview.value ? formatInstant(overview.value.generated_at) : ''))

interface CalendarDay {
  key: string
  label: string
  events: Array<PublishingOverviewCalendarEntry & { key: string }>
}

/** Group the flat calendar into local days. */
const days = computed<CalendarDay[]>(() => {
  const entries = overview.value?.calendar ?? []
  const byDay = new Map<string, CalendarDay>()
  for (const entry of entries) {
    const date = new Date(entry.at)
    if (Number.isNaN(date.getTime())) continue
    const key = localDayKey(date)
    let day = byDay.get(key)
    if (!day) {
      day = { key, label: formatDay(date), events: [] }
      byDay.set(key, day)
    }
    day.events.push({ ...entry, key: `${entry.channel_slug}-${entry.kind}-${entry.at}-${entry.video_id || entry.episode_code || ''}` })
  }
  return [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key))
})

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

function freshnessLabel(channel: PublishingOverviewChannel): string {
  if (channel.confirmed.error === 'no_channel_assigned') return 'No channel assigned'
  if (channel.confirmed.error === 'channel_not_connected') return 'Not connected'
  if (channel.confirmed.freshness === 'unknown') return 'Never checked'
  if (channel.confirmed.freshness === 'stale') return `Stale · ${formatInstant(channel.confirmed.last_checked_at || '')}`
  return `Fresh · ${formatInstant(channel.confirmed.last_checked_at || '')}`
}
</script>

<style scoped>
.publishing-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px 20px 64px;
}
.publishing-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}
.publishing-header h1 { margin: 4px 0 6px; font-size: 1.6rem; }
.publishing-header p { margin: 0; max-width: 64ch; color: var(--text-secondary, #666); }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .72rem; color: var(--text-secondary, #888); }
.publishing-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.publishing-generated { font-size: .78rem; color: var(--text-secondary, #888); }
.publishing-section { margin-top: 32px; }
.section-hint { margin: 4px 0 12px; color: var(--text-secondary, #888); font-size: .85rem; max-width: 72ch; }
.empty { padding: 24px; text-align: center; color: var(--text-secondary, #888); }

.coverage-scroll { overflow-x: auto; }
.coverage-table { width: 100%; border-collapse: collapse; font-size: .9rem; }
.coverage-table th, .coverage-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border, #e5e5e5); vertical-align: top; }
.coverage-table th { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-secondary, #888); white-space: nowrap; }
.row-at-risk { background: color-mix(in srgb, var(--warning, #b26a00) 7%, transparent); }
.channel-link { font-weight: 600; }
.channel-handle { display: block; font-size: .78rem; color: var(--text-secondary, #888); }
.plan-link { display: block; margin-top: 2px; font-size: .8rem; }
.rec-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.rec-link { font-size: .8rem; }
.muted { color: var(--text-secondary, #999); }
.risk-badge {
  display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 4px; font-size: .72rem;
  background: color-mix(in srgb, var(--warning, #b26a00) 18%, transparent); color: var(--warning, #b26a00);
}

.freshness { font-size: .8rem; white-space: nowrap; }
.freshness-fresh { color: var(--success, #2e7d32); }
.freshness-stale { color: var(--warning, #b26a00); }
.freshness-unknown { color: var(--text-secondary, #999); }

.calendar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.legend { display: flex; gap: 16px; list-style: none; margin: 0; padding: 0; font-size: .8rem; color: var(--text-secondary, #888); flex-wrap: wrap; }
.legend li { display: flex; align-items: center; gap: 6px; }
.legend-swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.legend-confirmed { background: var(--success, #2e7d32); }
.legend-planned { background: var(--accent, #2f6feb); }
.legend-empty { border: 1.5px dashed var(--accent, #2f6feb); background: transparent; }

.calendar-list { list-style: none; margin: 16px 0 0; padding: 0; }
.calendar-day { display: flex; gap: 16px; padding: 10px 0; border-top: 1px solid var(--border, #eee); }
.calendar-day-label { min-width: 190px; font-weight: 600; }
.calendar-events { list-style: none; margin: 0; padding: 0; flex: 1; display: flex; flex-direction: column; gap: 6px; }
.calendar-event { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: .9rem; }
.event-kind { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; padding: 2px 6px; border-radius: 4px; }
.event-confirmed .event-kind { background: color-mix(in srgb, var(--success, #2e7d32) 15%, transparent); color: var(--success, #2e7d32); }
.event-planned .event-kind { background: color-mix(in srgb, var(--accent, #2f6feb) 15%, transparent); color: var(--accent, #2f6feb); }
.event-empty .event-kind { background: transparent; border: 1px dashed var(--accent, #2f6feb); color: var(--accent, #2f6feb); }
.event-channel { font-weight: 600; }
.event-time { color: var(--text-secondary, #888); }
.event-title { color: var(--text-secondary, #666); }
.confirmed-badge { font-size: .72rem; color: var(--success, #2e7d32); }
</style>
