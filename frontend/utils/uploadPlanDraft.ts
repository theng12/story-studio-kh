/**
 * The editable form of an upload schedule, shared by Settings → Publishing and
 * Upload Center → Plans so both screens edit the same plan the same way
 * (v1.4.249, one schedule — see electron/server/services/publish-cadence.ts).
 *
 * The counted default (2026-10-31) is the third mode: three videos a week on
 * random days, each at a random time inside a window. The customer's own
 * rhythm is the weekly mode — their days and their times of day.
 */
export interface UploadScheduleShape {
  weekdays: number[]
  time_local: string
  timezone: string
  interval_weeks?: number
  monthly_day?: number
  start_date?: string
  end_date?: string
  /** Later rhythms, each from its own start date (v1.4.268). */
  phases?: SchedulePhaseShape[]
  /** Videos a week. With no days chosen it is the random default. */
  random_weekly?: number
  /** The window the default's random time of day is drawn from. */
  random_time_window?: { start: string; end: string }
  /** The customer's own times of day — a day uses them in order. */
  times_local?: string[]
  [key: string]: unknown
}

export interface SchedulePhaseShape { start_date: string; end_date?: string; weekdays: number[]; time_local: string }

/** "Then from <date>: <days> at <time>", optionally until a date. */
export interface PhaseDraft { startDate: string; endDate: string; weekdays: number[]; timeLocal: string }

export interface ScheduleDraft {
  name: string
  mode: 'weekly' | 'monthly' | 'random'
  weekdays: number[]
  intervalWeeks: number
  monthlyDay: number
  timeLocal: string
  timezone: string
  startDate: string
  endDate: string
  phases: PhaseDraft[]
  /** Videos a week in the random default. */
  perWeek: number
  /** The window the default's random time of day is drawn from. */
  windowStart: string
  windowEnd: string
  /** The customer's own times of day. */
  timesLocal: string[]
}

export const WEEKDAYS = [
  { value: 0, label: 'Sun' }, { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
]

/** The default's random time window — the same starting value the backend uses. */
export const RANDOM_WINDOW_DEFAULT = { start: '08:00', end: '22:00' }

/** The default every channel starts on: three videos a week. */
export const RANDOM_PER_WEEK_DEFAULT = 3

export function deviceTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** Every IANA zone this computer knows, for the time-zone picker. */
export function timezoneOptions(current = ''): string[] {
  let zones: string[] = []
  try { zones = (Intl as any).supportedValuesOf?.('timeZone') || [] } catch { zones = [] }
  const list = zones.length ? [...zones] : ['UTC']
  if (current && !list.includes(current)) list.unshift(current)
  return list
}

export function emptyDraft(): ScheduleDraft {
  return {
    name: '', mode: 'weekly', weekdays: [], intervalWeeks: 1, monthlyDay: 1,
    timeLocal: '18:00', timezone: deviceTimezone(), startDate: '', endDate: '', phases: [],
    perWeek: RANDOM_PER_WEEK_DEFAULT,
    windowStart: RANDOM_WINDOW_DEFAULT.start, windowEnd: RANDOM_WINDOW_DEFAULT.end,
    timesLocal: ['18:00'],
  }
}

export function draftFromSchedule(schedule: Partial<UploadScheduleShape> | null | undefined, name = ''): ScheduleDraft {
  if (!schedule) return { ...emptyDraft(), name }
  const weekdays = Array.isArray(schedule.weekdays) ? [...schedule.weekdays] : []
  const counted = Number(schedule.random_weekly) || 0
  const window = schedule.random_time_window
  const times = Array.isArray(schedule.times_local) && schedule.times_local.length
    ? [...schedule.times_local]
    : [schedule.time_local || '18:00']
  return {
    name,
    // A counted schedule with no days is the random default; with days it is
    // the customer's own weekly rhythm.
    mode: counted && !weekdays.length ? 'random' : (weekdays.length || !schedule.monthly_day ? 'weekly' : 'monthly'),
    weekdays,
    intervalWeeks: Number(schedule.interval_weeks) || 1,
    monthlyDay: Number(schedule.monthly_day) || 1,
    timeLocal: schedule.time_local || '18:00',
    timezone: schedule.timezone || deviceTimezone(),
    startDate: schedule.start_date || '',
    endDate: schedule.end_date || '',
    phases: (Array.isArray(schedule.phases) ? schedule.phases : []).map(phase => ({
      startDate: phase.start_date || '',
      endDate: phase.end_date || '',
      weekdays: Array.isArray(phase.weekdays) ? [...phase.weekdays] : [],
      timeLocal: phase.time_local || '18:00',
    })),
    perWeek: counted || RANDOM_PER_WEEK_DEFAULT,
    windowStart: window?.start || RANDOM_WINDOW_DEFAULT.start,
    windowEnd: window?.end || RANDOM_WINDOW_DEFAULT.end,
    timesLocal: times,
  }
}

export function draftKey(d: ScheduleDraft): string {
  return JSON.stringify({ ...d, name: d.name.trim(), weekdays: [...d.weekdays].sort((a, b) => a - b) })
}

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false }
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** The draft as a schedule, or the one plain sentence that says what to fix. */
export function scheduleFromDraft(d: ScheduleDraft, opts: { requireName?: boolean } = {}):
  { ok: true; schedule: UploadScheduleShape } | { ok: false; error: string } {
  if (opts.requireName && !d.name.trim()) return { ok: false, error: 'Give this plan a name.' }
  if (!validTimezone(d.timezone)) return { ok: false, error: 'Choose a time zone from the list.' }
  if (d.startDate && d.endDate && d.startDate > d.endDate) return { ok: false, error: 'The end date must be on or after the start date.' }

  if (d.mode === 'random') {
    // The random days and the random time are the three-a-week default; any
    // other count is the customer's own days and times.
    if (d.perWeek !== RANDOM_PER_WEEK_DEFAULT) {
      return {
        ok: false,
        error: 'Random days and a random time are the 3-videos-a-week default. '
          + 'Choose Weekly days to set your own count.',
      }
    }
    if (!validTime(d.windowStart) || !validTime(d.windowEnd)) {
      return { ok: false, error: 'Choose a valid start and end time for the random time of day.' }
    }
    if (Number(d.windowStart.slice(3)) % 5 !== 0 || Number(d.windowEnd.slice(3)) % 5 !== 0) {
      return { ok: false, error: 'The random time of day lands on 5-minute marks — use times like 08:00 or 21:35.' }
    }
    if (d.windowEnd <= d.windowStart) {
      return { ok: false, error: 'The random time of day must end after it starts.' }
    }
    return {
      ok: true,
      schedule: {
        weekdays: [],
        random_weekly: RANDOM_PER_WEEK_DEFAULT,
        random_time_window: { start: d.windowStart, end: d.windowEnd },
        time_local: d.windowStart,
        timezone: d.timezone,
      },
    }
  }

  const times = (d.timesLocal?.length ? d.timesLocal : [d.timeLocal]).filter(Boolean)
  if (!times.length || !times.every(validTime)) return { ok: false, error: 'Choose a valid time of day.' }
  if (new Set(times).size !== times.length) return { ok: false, error: 'Two videos cannot share the same time of day.' }
  if (d.mode === 'weekly' && !d.weekdays.length) return { ok: false, error: 'Pick at least one day — a schedule with no days never produces a slot.' }
  if (d.mode === 'weekly' && (!Number.isInteger(d.intervalWeeks) || d.intervalWeeks < 1)) return { ok: false, error: 'Choose every 1 or more weeks.' }
  if (d.mode === 'monthly' && (!Number.isInteger(d.monthlyDay) || d.monthlyDay < 1 || d.monthlyDay > 31)) return { ok: false, error: 'Choose a day from 1 through 31.' }
  const schedule: UploadScheduleShape = {
    weekdays: d.mode === 'weekly' ? [...d.weekdays].sort((a, b) => a - b) : [],
    time_local: times[0]!,
    timezone: d.timezone,
  }
  if (d.mode === 'weekly') {
    schedule.interval_weeks = d.intervalWeeks
    if (times.length > 1) schedule.times_local = times
  } else {
    schedule.monthly_day = d.monthlyDay
  }
  if (d.startDate) schedule.start_date = d.startDate
  if (d.endDate) schedule.end_date = d.endDate
  let previous = d.startDate
  for (const phase of d.phases || []) {
    if (!phase.startDate) return { ok: false, error: 'Choose the date the later schedule starts.' }
    if (previous && phase.startDate <= previous) return { ok: false, error: 'A later schedule must start after the one before it.' }
    if (!phase.weekdays.length) return { ok: false, error: 'Pick at least one day for the later schedule.' }
    if (!validTime(phase.timeLocal)) return { ok: false, error: 'Choose a valid time for the later schedule.' }
    if (phase.endDate && phase.endDate < phase.startDate) return { ok: false, error: 'The later schedule must end on or after its start date.' }
    previous = phase.startDate
  }
  if (d.phases?.length) {
    schedule.phases = d.phases.map(phase => ({
      start_date: phase.startDate,
      ...(phase.endDate ? { end_date: phase.endDate } : {}),
      weekdays: [...phase.weekdays].sort((a, b) => a - b),
      time_local: phase.timeLocal,
    }))
  }
  return { ok: true, schedule }
}

const dayLabels = (days: number[]): string => days.map(day => WEEKDAYS.find(item => item.value === day)?.label).filter(Boolean).join(', ')

/** "Tue, Thu, Sat · 19:30 · Asia/Phnom_Penh · every week · then from 2027-01-01: Mon, Wed, Fri at 20:00" */
export function scheduleSummary(schedule: Partial<UploadScheduleShape> | null | undefined): string {
  if (!schedule) return 'No schedule yet'
  const time = `${schedule.time_local || '18:00'} · ${schedule.timezone || 'UTC'}`
  const later = (schedule.phases || []).map(phase =>
    ` · then from ${phase.start_date}: ${dayLabels(phase.weekdays || [])} at ${phase.time_local}${phase.end_date ? ` until ${phase.end_date}` : ''}`).join('')
  if (schedule.random_weekly && !schedule.weekdays?.length) {
    const window = schedule.random_time_window || RANDOM_WINDOW_DEFAULT
    return `${schedule.random_weekly} a week · random days · random ${window.start}–${window.end} · ${schedule.timezone || 'UTC'}`
  }
  if (schedule.weekdays?.length) {
    const interval = Math.max(1, Number(schedule.interval_weeks) || 1)
    const times = Array.isArray(schedule.times_local) && schedule.times_local.length
      ? schedule.times_local.join(', ')
      : (schedule.time_local || '18:00')
    return `${dayLabels(schedule.weekdays)} · ${times} · ${schedule.timezone || 'UTC'} · ${interval === 1 ? 'every week' : `every ${interval} weeks`}${later}`
  }
  return `Day ${schedule.monthly_day || 1} of each month · ${time}${later}`
}

/** Roughly how many episodes a month the schedule produces. */
export function episodesPerMonth(schedule: Partial<UploadScheduleShape> | null | undefined): number {
  if (!schedule) return 0
  if (schedule.random_weekly && !schedule.weekdays?.length) {
    return Math.round(Number(schedule.random_weekly) * 4.345)
  }
  if (schedule.weekdays?.length) {
    const times = Array.isArray(schedule.times_local) && schedule.times_local.length ? schedule.times_local.length : 1
    return Math.round((schedule.weekdays.length * times / Math.max(1, Number(schedule.interval_weeks) || 1)) * 4.345)
  }
  return schedule.monthly_day ? 1 : 0
}
