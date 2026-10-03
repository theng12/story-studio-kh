/**
 * The editable form of an upload schedule, shared by Settings → Publishing and
 * Upload Center → Plans so both screens edit the same plan the same way
 * (v1.4.249, one schedule — see electron/server/services/publish-cadence.ts).
 */
export interface UploadScheduleShape {
  weekdays: number[]
  time_local: string
  timezone: string
  interval_weeks?: number
  monthly_day?: number
  start_date?: string
  end_date?: string
  [key: string]: unknown
}

export interface ScheduleDraft {
  name: string
  mode: 'weekly' | 'monthly'
  weekdays: number[]
  intervalWeeks: number
  monthlyDay: number
  timeLocal: string
  timezone: string
  startDate: string
  endDate: string
}

export const WEEKDAYS = [
  { value: 0, label: 'Sun' }, { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
]

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
    timeLocal: '18:00', timezone: deviceTimezone(), startDate: '', endDate: '',
  }
}

export function draftFromSchedule(schedule: Partial<UploadScheduleShape> | null | undefined, name = ''): ScheduleDraft {
  if (!schedule) return { ...emptyDraft(), name }
  const weekdays = Array.isArray(schedule.weekdays) ? [...schedule.weekdays] : []
  return {
    name,
    mode: weekdays.length || !schedule.monthly_day ? 'weekly' : 'monthly',
    weekdays,
    intervalWeeks: Number(schedule.interval_weeks) || 1,
    monthlyDay: Number(schedule.monthly_day) || 1,
    timeLocal: schedule.time_local || '18:00',
    timezone: schedule.timezone || deviceTimezone(),
    startDate: schedule.start_date || '',
    endDate: schedule.end_date || '',
  }
}

export function draftKey(d: ScheduleDraft): string {
  return JSON.stringify({ ...d, name: d.name.trim(), weekdays: [...d.weekdays].sort((a, b) => a - b) })
}

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false }
}

/** The draft as a schedule, or the one plain sentence that says what to fix. */
export function scheduleFromDraft(d: ScheduleDraft, opts: { requireName?: boolean } = {}):
  { ok: true; schedule: UploadScheduleShape } | { ok: false; error: string } {
  if (opts.requireName && !d.name.trim()) return { ok: false, error: 'Give this plan a name.' }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.timeLocal)) return { ok: false, error: 'Choose a valid time of day.' }
  if (!validTimezone(d.timezone)) return { ok: false, error: 'Choose a time zone from the list.' }
  if (d.startDate && d.endDate && d.startDate > d.endDate) return { ok: false, error: 'The end date must be on or after the start date.' }
  if (d.mode === 'weekly' && !d.weekdays.length) return { ok: false, error: 'Pick at least one day — a schedule with no days never produces a slot.' }
  if (d.mode === 'weekly' && (!Number.isInteger(d.intervalWeeks) || d.intervalWeeks < 1)) return { ok: false, error: 'Choose every 1 or more weeks.' }
  if (d.mode === 'monthly' && (!Number.isInteger(d.monthlyDay) || d.monthlyDay < 1 || d.monthlyDay > 31)) return { ok: false, error: 'Choose a day from 1 through 31.' }
  const schedule: UploadScheduleShape = {
    weekdays: d.mode === 'weekly' ? [...d.weekdays].sort((a, b) => a - b) : [],
    time_local: d.timeLocal,
    timezone: d.timezone,
  }
  if (d.mode === 'weekly') schedule.interval_weeks = d.intervalWeeks
  else schedule.monthly_day = d.monthlyDay
  if (d.startDate) schedule.start_date = d.startDate
  if (d.endDate) schedule.end_date = d.endDate
  return { ok: true, schedule }
}

/** "Tue, Thu, Sat · 19:30 · Asia/Phnom_Penh · every week" */
export function scheduleSummary(schedule: Partial<UploadScheduleShape> | null | undefined): string {
  if (!schedule) return 'No schedule yet'
  const time = `${schedule.time_local || '18:00'} · ${schedule.timezone || 'UTC'}`
  if (schedule.weekdays?.length) {
    const days = schedule.weekdays.map(day => WEEKDAYS.find(item => item.value === day)?.label).filter(Boolean).join(', ')
    const interval = Math.max(1, Number(schedule.interval_weeks) || 1)
    return `${days} · ${time} · ${interval === 1 ? 'every week' : `every ${interval} weeks`}`
  }
  return `Day ${schedule.monthly_day || 1} of each month · ${time}`
}

/** Roughly how many episodes a month the schedule produces. */
export function episodesPerMonth(schedule: Partial<UploadScheduleShape> | null | undefined): number {
  if (!schedule) return 0
  if (schedule.weekdays?.length) return Math.round((schedule.weekdays.length / Math.max(1, Number(schedule.interval_weeks) || 1)) * 4.345)
  return schedule.monthly_day ? 1 : 0
}
