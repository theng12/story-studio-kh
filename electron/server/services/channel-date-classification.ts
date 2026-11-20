/**
 * ONE classification per channel per date, used by the agent route and the
 * calendar. YouTube is the only source for `on-youtube`; a local claim is the
 * only source for `planned`. `free` means neither claimed the date, and is only
 * said when YouTube was actually read. A missing local key never decides it.
 */

import { getIdeas } from './idea-manager.js'
import { readCadence } from './publish-cadence.js'
import { computeSlots, localDayKeyInTz, readItemSchedule } from './upload-plans.js'
import { getProjectYouTubeAssignment, readYouTubeConnectionRegistry } from './youtube-connection-store.js'
import { readYouTubeChannelSchedule } from './youtube-channel-schedule-store.js'

export type ChannelDateState = 'on-youtube' | 'planned' | 'free' | 'unknown'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

function dates(from: string, to: string): string[] {
  const out: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= end && out.length < 92; ms += 24 * 60 * 60 * 1000) {
    out.push(new Date(ms).toISOString().slice(0, 10))
  }
  return out
}

function weekKey(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  const offset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - offset)
  return date.toISOString().slice(0, 10)
}

export async function classifyChannelDates(slug: string, from: string, to: string) {
  if (!DAY.test(from) || !DAY.test(to) || Date.parse(to) < Date.parse(from)) {
    throw Object.assign(new Error('Choose valid from/to dates (YYYY-MM-DD), at most 92 days apart.'), { statusCode: 400 })
  }
  if (dates(from, to).length === 0 || Date.parse(to) - Date.parse(from) > 92 * 24 * 60 * 60 * 1000) {
    throw Object.assign(new Error('Choose at most 92 days.'), { statusCode: 400 })
  }
  const [assignment, registry, schedule, cadence, itemSchedule, ideas] = await Promise.all([
    getProjectYouTubeAssignment(slug).catch(() => null),
    readYouTubeConnectionRegistry().catch(() => null),
    readYouTubeChannelSchedule(slug).catch(() => null),
    readCadence(slug).catch(() => null),
    readItemSchedule(slug).catch(() => null),
    getIdeas(slug, 'accepted').catch(() => []),
  ])
  const channelId = assignment?.channel_id ?? null
  const grant = channelId ? registry?.channels[channelId] : null
  const connected = !!grant && grant.status === 'connected' && !!registry?.application
    && grant.application_id === registry.application.application_id
  const tz = cadence?.schedule.timezone || 'UTC'
  const days = dates(from, to)

  const youtube = new Map<string, { video_id: string; title?: string; publish_at: string; read_at: string }>()
  for (const slot of schedule?.scheduled_dates ?? []) {
    const day = localDayKeyInTz(new Date(slot.publish_at), tz)
    if (!youtube.has(day)) {
      youtube.set(day, {
        video_id: slot.video_id, publish_at: slot.publish_at, read_at: slot.read_at,
        ...(slot.title ? { title: slot.title } : {}),
      })
    }
  }

  const titles = new Map(ideas.filter(idea => !!idea.episode_code).map(idea => [idea.episode_code!, idea.title || '']))
  const planned = new Map<string, { episode_code: string | null; title: string; at: string }>()
  for (const [code, at] of Object.entries(itemSchedule ?? {})) {
    if (!Number.isFinite(Date.parse(at))) continue
    const day = localDayKeyInTz(new Date(at), tz)
    if (days.includes(day) && !planned.has(day)) {
      planned.set(day, { episode_code: code, title: titles.get(code) || code, at })
    }
  }
  // A cadence slot is intent too: it must never render as an empty hole.
  const weekdays = cadence?.schedule.weekdays ?? []
  if (weekdays.length) {
    const expectedCount = Math.ceil(days.length / 7) * weekdays.length + weekdays.length
    const slots = computeSlots(cadence!.schedule, expectedCount, { minStartDate: new Date(`${from}T00:00:00Z`) })
    for (const slot of slots) {
      const day = localDayKeyInTz(new Date(slot), tz)
      if (days.includes(day) && !planned.has(day)) {
        planned.set(day, { episode_code: null, title: 'Channel cadence', at: slot })
      }
    }
  }

  const blocked = !channelId || !connected
  let unknownReason: string | null = null
  if (!channelId) unknownReason = 'This project has no YouTube channel assigned.'
  else if (!connected) unknownReason = 'The assigned YouTube channel is not connected.'
  else if (schedule?.state === 'read_failed') unknownReason = `Last YouTube read failed: ${schedule.error || 'YouTube did not answer.'}`
  else if (schedule?.state !== 'scheduled' && schedule?.state !== 'unconfigured') {
    unknownReason = schedule?.error || 'Story Studio has not read this channel’s YouTube schedule yet.'
  }

  const classified = days.map(day => {
    const onYouTube = youtube.get(day)
    const claim = planned.get(day)
    const base = {
      date: day,
      weekday: WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!,
      week: weekKey(day),
    }
    if (blocked) return { ...base, state: 'unknown' as const, reason: unknownReason }
    if (onYouTube) return { ...base, state: 'on-youtube' as const, on_youtube: onYouTube }
    if (claim) return { ...base, state: 'planned' as const, planned: claim }
    if (unknownReason) return { ...base, state: 'unknown' as const, reason: unknownReason }
    return { ...base, state: 'free' as const }
  })

  const byWeek = new Map<string, number>()
  for (const day of classified) {
    if (day.state === 'on-youtube' || day.state === 'planned') byWeek.set(day.week, (byWeek.get(day.week) ?? 0) + 1)
  }
  const weeks = [...new Set(classified.map(day => day.week))]
  return {
    slug, channel_id: channelId, from, to, timezone: tz,
    generated_at: new Date().toISOString(),
    scheduled_count: schedule?.scheduled_count ?? null,
    next_slot_at: schedule?.next_slot_at ?? null,
    last_read_at: schedule?.read_at ?? null,
    read_freshness: schedule?.freshness ?? 'unknown',
    free_days_in_week: classified.filter(day => day.week === classified[0]?.week && day.state === 'free').length,
    weeks_under_cadence: weekdays.length
      ? weeks.filter(week => (byWeek.get(week) ?? 0) < weekdays.length).length
      : null,
    ready_and_unscheduled_count: null as number | null,
    days: classified.map(({ week, ...day }) => day),
  }
}
