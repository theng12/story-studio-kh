/**
 * Upload plans — saved schedule definitions that distribute queued items
 * across upcoming time slots and set/patch YouTube's `publishAt`.
 *
 * Schedule model picks from three composable primitives (per the user's
 * Q&A answer "I want interval-based, calendar pick, AND let YouTube's own
 * scheduling publish the videos"):
 *
 *   1. Weekday calendar  — set of weekdays + a single local time.
 *   2. Interval          — "every N weeks" applied on top of (1).
 *   3. Monthly           — OR a day-of-month override (mutually exclusive
 *                          with weekdays; if both provided, weekdays win).
 *   4. Phases (1.4.268)  — later rhythms that take over on a date
 *                          ("then from 2027-01-01: Mon, Wed, Fri at 20:00").
 *
 * Computed output: list of `{ position, publishAt }` tuples for a given
 * queue of N items, starting from the plan's start_date (or "now") and
 * walking forward through slots. End-date caps the slot stream.
 */

import { randomUUID } from 'crypto'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { readSidecarStrict, setScheduledFor } from './upload-sidecar.js'
import type { UploadPlatform } from './upload-store.js'
import { operationPublicationFacts, readYouTubeRetentionStores } from './youtube-remote-video.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import { isYouTubeVideoRemoved } from './youtube-project-publishing-store.js'
import type { ProjectFactsCache } from './utils.js'

export interface UploadSchedule {
  /** 0-6, Sunday = 0. Empty array + monthly_day set = monthly mode. */
  weekdays: number[]
  /** "HH:MM" 24h in the schedule's timezone. */
  time_local: string
  /** IANA timezone, e.g. 'America/Los_Angeles'. */
  timezone: string
  /** 1 = every week (default), 2 = bi-weekly, 3 = every 3 weeks, etc. */
  interval_weeks?: number
  /** Day of month (1–31). Ignored when weekdays is non-empty. */
  monthly_day?: number
  /** YYYY-MM-DD anchor (inclusive). Defaults to today in the tz. */
  start_date?: string
  /** YYYY-MM-DD upper bound (inclusive). Optional. */
  end_date?: string
  /**
   * Later rhythms, in date order (v1.4.268). The fields above are the first
   * phase; each entry here takes over from its own `start_date` ("then from
   * 2027-01-01: Mon, Wed, Fri at 20:00"). Timezone and `interval_weeks` are
   * shared. The plan horizon is the LAST phase's `end_date`. Absent or empty
   * means the single-pattern schedule, unchanged.
   */
  phases?: UploadSchedulePhase[]
}

export interface UploadSchedulePhase {
  /** YYYY-MM-DD (inclusive) in the schedule's timezone. */
  start_date: string
  /** YYYY-MM-DD (inclusive). Optional; on the last phase it is the plan horizon. */
  end_date?: string
  weekdays: number[]
  time_local: string
}

export interface UploadPlanDefaults {
  privacy_status: 'private' | 'unlisted' | 'public'
  language?: string
  made_for_kids?: boolean
}

export interface UploadPlan {
  id: string
  name: string
  platform: UploadPlatform
  account_id: string
  schedule: UploadSchedule
  defaults: UploadPlanDefaults
  created_at: string
  updated_at: string
}

export interface UploadScheduleAssignment {
  episode_code: string
  publishAt: string
}

export type UploadScheduleCasWriter = (
  episodeCode: string,
  scheduledFor: string | null,
  expectedScheduledFor: string | null,
) => Promise<void>

/**
 * A batch failed and at least one compensating CAS could not prove restoration.
 * The caller must surface these exact episode sets instead of claiming the
 * whole request failed atomically.
 */
export class UploadScheduleBatchWriteError extends Error {
  readonly code = 'YOUTUBE_PLAN_PARTIAL_WRITE'
  readonly expose = true
  readonly statusCode: number
  readonly committed_episode_codes: string[]
  readonly uncertain_episode_codes: string[]

  constructor(cause: unknown, committed: string[], uncertain: string[]) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    const named = uncertain.length ? uncertain.join(', ') : 'none'
    super(`The schedule write stopped (${detail}). Story Studio could not prove the final planned date for: ${named}. Refresh the Upload Center and review those episodes before trying again.`)
    this.name = 'UploadScheduleBatchWriteError'
    this.statusCode = 500
    this.committed_episode_codes = [...committed]
    this.uncertain_episode_codes = [...uncertain]
    ;(this as any).cause = cause
  }
}

/**
 * Apply reviewed per-episode claims in order. If a later CAS fails, compensate
 * only values this request successfully wrote, using that new value as the
 * compensation expectation. A concurrent writer can therefore never be
 * overwritten by an old-map rollback.
 */
export async function applyScheduleAssignmentsWithRollback(
  assignments: readonly UploadScheduleAssignment[],
  previous: Readonly<Record<string, string | null>>,
  writer: UploadScheduleCasWriter,
): Promise<void> {
  const completed: UploadScheduleAssignment[] = []
  try {
    for (const assignment of assignments) {
      await writer(
        assignment.episode_code,
        assignment.publishAt,
        previous[assignment.episode_code] ?? null,
      )
      completed.push(assignment)
    }
  } catch (cause) {
    const uncertain: string[] = []
    for (const assignment of completed.reverse()) {
      try {
        await writer(
          assignment.episode_code,
          previous[assignment.episode_code] ?? null,
          assignment.publishAt,
        )
      } catch {
        uncertain.push(assignment.episode_code)
      }
    }
    if (uncertain.length) throw new UploadScheduleBatchWriteError(cause, [], uncertain.sort())
    throw cause
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Validate the persisted plan shape before accepting a user supplied save.
 *
 * `computeSlots` intentionally has recovery defaults for old config files, so
 * it is not suitable as an input validator. Keep this check at the save
 * boundary while allowing legacy records to remain readable.
 */
export function validateUploadPlanDraft(value: unknown): string | null {
  if (!isRecord(value)) return 'plan body required'
  if (typeof value.id !== 'undefined' && (typeof value.id !== 'string' || !value.id.trim())) {
    return 'id must be a non-empty string'
  }
  if (typeof value.name !== 'string' || !value.name.trim()) return 'name required'
  if (typeof value.account_id !== 'string' || !value.account_id.trim()) return 'account_id required'
  if (!isRecord(value.schedule)) return 'schedule required'
  if (!isRecord(value.defaults)) return 'defaults required'

  const schedule = value.schedule
  if (!Array.isArray(schedule.weekdays)) return 'schedule.weekdays must be an array'
  if (!schedule.weekdays.every((day: unknown) =>
    typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)) {
    return 'schedule.weekdays must contain integers from 0 to 6'
  }
  if (typeof schedule.time_local !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time_local)) {
    return 'schedule.time_local must be a valid 24-hour HH:MM time'
  }
  if (typeof schedule.timezone !== 'string' || !isValidTimezone(schedule.timezone)) {
    return 'schedule.timezone must be a valid IANA timezone'
  }

  const hasMonthlyDay = isOptionalValue(schedule.monthly_day)
  if (hasMonthlyDay && (!Number.isInteger(schedule.monthly_day) || schedule.monthly_day < 1 || schedule.monthly_day > 31)) {
    return 'schedule.monthly_day must be an integer from 1 to 31'
  }
  if (schedule.weekdays.length === 0 && !hasMonthlyDay) {
    return 'schedule requires weekdays or monthly_day'
  }
  if (isOptionalValue(schedule.interval_weeks)
    && (!Number.isInteger(schedule.interval_weeks) || schedule.interval_weeks < 1)) {
    return 'schedule.interval_weeks must be an integer of at least 1'
  }
  if (isOptionalValue(schedule.start_date) && !isValidCalendarDate(schedule.start_date)) {
    return 'schedule.start_date must be a valid YYYY-MM-DD date'
  }
  if (isOptionalValue(schedule.end_date) && !isValidCalendarDate(schedule.end_date)) {
    return 'schedule.end_date must be a valid YYYY-MM-DD date'
  }
  if (isValidCalendarDate(schedule.start_date) && isValidCalendarDate(schedule.end_date)
    && schedule.end_date < schedule.start_date) {
    return 'schedule.end_date must be on or after start_date'
  }
  const phaseProblem = validatePhases(schedule)
  if (phaseProblem) return phaseProblem

  const defaults = value.defaults
  if (defaults.privacy_status !== 'private'
    && defaults.privacy_status !== 'unlisted'
    && defaults.privacy_status !== 'public') {
    return 'defaults.privacy_status must be private, unlisted, or public'
  }
  if (typeof defaults.language !== 'undefined' && typeof defaults.language !== 'string') {
    return 'defaults.language must be a string'
  }
  if (typeof defaults.made_for_kids !== 'undefined' && typeof defaults.made_for_kids !== 'boolean') {
    return 'defaults.made_for_kids must be a boolean'
  }
  return null
}

function validatePhases(schedule: { start_date?: unknown; phases?: unknown }): string | null {
  if (schedule.phases === undefined || schedule.phases === null) return null
  if (!Array.isArray(schedule.phases)) return 'schedule.phases must be an array'
  let previous: string | undefined = isValidCalendarDate(schedule.start_date) ? schedule.start_date : undefined
  for (const [index, phase] of schedule.phases.entries()) {
    const at = `schedule.phases[${index}]`
    if (!isRecord(phase)) return `${at} must be an object`
    if (!isValidCalendarDate(phase.start_date)) return `${at}.start_date must be a valid YYYY-MM-DD date`
    if (previous && phase.start_date <= previous) return `${at}.start_date must be after the previous phase starts`
    if (isOptionalValue(phase.end_date) && (!isValidCalendarDate(phase.end_date) || phase.end_date < phase.start_date)) {
      return `${at}.end_date must be a valid date on or after its start_date`
    }
    if (!Array.isArray(phase.weekdays) || !phase.weekdays.length || !phase.weekdays.every((day: unknown) =>
      typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)) {
      return `${at}.weekdays must contain at least one integer from 0 to 6`
    }
    if (typeof phase.time_local !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(phase.time_local)) {
      return `${at}.time_local must be a valid 24-hour HH:MM time`
    }
    previous = phase.start_date
  }
  return null
}

/**
 * Normalize a user selection into stable production order. Checkbox Sets
 * preserve click order, which must never decide which episode receives the
 * earliest publishing slot. Empty values and duplicates are removed here so
 * preview and apply share one authoritative mapping rule.
 */
export function orderEpisodeCodes(codes: unknown[]): string[] {
  const unique = new Set<string>()
  for (const value of codes) {
    if (typeof value !== 'string') continue
    const code = value.trim()
    if (code) unique.add(code)
  }
  return Array.from(unique).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

/**
 * Publish dates follow episode order (owner, 2026-10-08: "I assembled 172, then
 * 245, then 390 … now 173–176 stay behind 245 and 390").
 *
 * `claims` must hold only FUTURE dates of episodes Story may still move (not
 * uploading, not on YouTube). The same dates are handed back out in
 * episode-code order, so the lowest code gets the earliest date. No new date is
 * made, so the plan horizon and "never earlier than now" hold automatically.
 * Returns only the episodes whose date changes.
 */
export function episodeOrderShifts(claims: Readonly<Record<string, string>>): Record<string, string> {
  const codes = orderEpisodeCodes(Object.keys(claims))
  const dates = codes.map(code => claims[code]!).sort((a, b) => Date.parse(a) - Date.parse(b))
  const shifts: Record<string, string> = {}
  codes.forEach((code, index) => {
    if (claims[code] !== dates[index]) shifts[code] = dates[index]!
  })
  return shifts
}

export async function listPlans(slug: string): Promise<UploadPlan[]> {
  const config = (await pm.getConfig(slug)) as any
  const plans = config?.upload_plans
  return Array.isArray(plans) ? plans : []
}

export async function getPlan(slug: string, id: string): Promise<UploadPlan | null> {
  const plans = await listPlans(slug)
  return plans.find(p => p.id === id) || null
}

export async function getActivePlanId(slug: string, platform: UploadPlatform, account_id: string): Promise<string> {
  const config = (await pm.getConfig(slug)) as any
  const key = `${platform}:${account_id}`
  return typeof config?.upload_plan_active?.[key] === 'string' ? config.upload_plan_active[key] : ''
}

export async function setActivePlanId(slug: string, platform: UploadPlatform, account_id: string, plan_id: string): Promise<void> {
  const config = (await pm.getConfig(slug)) as any
  const key = `${platform}:${account_id}`
  const next = { ...(config?.upload_plan_active || {}), [key]: plan_id }
  await pm.updateConfig(slug, { upload_plan_active: next } as any)
}

/** Active bindings that still name a plan this project holds. */
export function liveActiveMap(active: unknown, list: UploadPlan[]): Record<string, string> {
  const ids = new Set(list.map(p => p.id))
  const out: Record<string, string> = {}
  if (active && typeof active === 'object') {
    for (const [key, id] of Object.entries(active as Record<string, unknown>)) {
      if (typeof id === 'string' && ids.has(id)) out[key] = id
    }
  }
  return out
}

/**
 * Remove a plan, and every `active` binding that pointed at it or at any other
 * plan that is already gone (1.4.280). The 1.4.249 sweep dropped this along
 * with the legacy /upload/* routes; a stale binding left behind could be
 * resolved by a caller's "any active plan" fallback.
 */
export async function removePlan(slug: string, id: string): Promise<boolean> {
  const config = (await pm.getConfig(slug)) as any
  const list = await listPlans(slug)
  const next = list.filter(p => p.id !== id)
  if (next.length === list.length) return false
  await pm.updateConfig(slug, {
    upload_plans: next,
    upload_plan_active: liveActiveMap(config?.upload_plan_active, next),
  } as any)
  return true
}

export async function upsertPlan(slug: string, partial: Partial<UploadPlan> & { name: string; platform: UploadPlatform; account_id: string; schedule: UploadSchedule; defaults: UploadPlanDefaults }): Promise<UploadPlan> {
  const plans = await listPlans(slug)
  const now = new Date().toISOString()
  let plan: UploadPlan
  if (partial.id) {
    const existing = plans.find(p => p.id === partial.id)
    if (!existing) throw new Error(`Plan ${partial.id} not found`)
    plan = { ...existing, ...partial, updated_at: now } as UploadPlan
  } else {
    plan = {
      id: `plan_${randomUUID()}`,
      name: partial.name,
      platform: partial.platform,
      account_id: partial.account_id,
      schedule: partial.schedule,
      defaults: partial.defaults,
      created_at: now,
      updated_at: now,
    }
  }
  const nextList = partial.id
    ? plans.map(p => (p.id === plan.id ? plan : p))
    : [...plans, plan]
  await pm.updateConfig(slug, { upload_plans: nextList } as any)
  return plan
}

// ── Schedule compute ──────────────────────────────────────────────────────
//
// Pure function — no I/O. Given a plan's schedule and a count N, produces
// N ISO 8601 timestamps (UTC) for the next N slots starting at
// `schedule.start_date` (or "today in tz"). Caps at `end_date` when set;
// returns fewer than N if the stream runs out.
//
// `options.minStartDate` — when supplied, the walk is advanced to the
// day AFTER `minStartDate` (in plan tz), but never earlier than the
// plan's own `start_date`. The route layer uses this to "continue
// after the latest existing scheduled episode" so repeat-applies of a
// plan land safely past the existing queue instead of colliding with
// it. The interval-week anchor is intentionally pinned to the plan's
// original `start_date` so the bi-weekly/N-weekly rhythm is preserved
// even when the walk resumes mid-stream.
//
// (Replaces the v1.0.42 `skipClaimed: Set<string>` design, which
// silently failed whenever a sidecar's `scheduled_for` came from
// YouTube without `.000Z` milliseconds — exact-string set membership
// never matched the `Date.toISOString()` candidates emitted here.)

/**
 * The latest FUTURE slot already claimed, so a schedule walk resumes past it.
 *
 * ONE COPY, as of v1.4.21. This scan existed three times — twice in
 * `routes/upload.ts` (preview and apply) and once in
 * `services/episode-autoschedule.ts` — because when the third was written the
 * apply route had no tests at all, and refactoring untested code that sets the
 * owner's real publish dates was the worse risk. `upload-plan-apply-routes.test.ts`
 * closed that gap, so the copies collapse here.
 *
 * Four properties, each of which is a bug if lost:
 *
 *   PAST CLAIMS DO NOT COUNT. A video that went live last week must not push
 *   the next episode a week further out, or the schedule drifts forward every
 *   time an old episode is looked at.
 *
 *   THE TARGETS ARE EXCLUDED. An episode being scheduled must not be walked
 *   past by its own existing claim, or re-applying moves it every time.
 *
 *   THE LATEST WINS, not the first — resuming from a nearer claim would
 *   double-book a later one.
 *
 *   TIMESTAMPS ARE PARSED, not compared as text. The v1.0.42 defect this
 *   replaced held claims in a `Set<string>`, which missed any YouTube-synced
 *   value whose ISO form lacked `.000Z` and silently double-booked the slot.
 */
export async function latestFutureClaimMs(
  slug: string,
  platform: UploadPlatform,
  excludeCodes: Iterable<string>,
  deps: {
    getAcceptedIdeas: (slug: string) => Promise<Array<{ episode_code?: string | null; title?: string | null }>>
    readSidecar: (slug: string, code: string, title: string, platform: UploadPlatform)
      => Promise<{ scheduled_for?: string | null } | null>
  },
  now: number = Date.now(),
): Promise<number> {
  const excluded = new Set(excludeCodes)
  const accepted = await deps.getAcceptedIdeas(slug)
  let latest = 0
  await Promise.all(accepted.map(async (idea) => {
    if (!idea.episode_code || excluded.has(idea.episode_code)) return
    const sc = await deps.readSidecar(slug, idea.episode_code, idea.title || '', platform)
    if (!sc?.scheduled_for) return
    const t = Date.parse(sc.scheduled_for)
    if (Number.isFinite(t) && t > now && t > latest) latest = t
  }))
  return latest
}

/** Production claim walk using the canonical project schedule reader. */
export async function latestFutureProjectClaimMs(
  slug: string,
  platform: UploadPlatform,
  excludeCodes: Iterable<string>,
  now: number = Date.now(),
): Promise<number> {
  const schedule = platform === 'youtube' ? await readItemSchedule(slug) : null
  return latestFutureClaimMs(slug, platform, excludeCodes, {
    getAcceptedIdeas: projectSlug => im.getIdeas(projectSlug, 'accepted'),
    readSidecar: schedule
      ? async (_projectSlug, code) => ({ scheduled_for: schedule[code] || null })
      : async (projectSlug, code, title, selectedPlatform) => {
        const { readSidecarRaw } = await import('./upload-sidecar.js')
        return readSidecarRaw(projectSlug, code, title, selectedPlatform)
      },
  }, now)
}

export function computeSlots(
  schedule: UploadSchedule,
  count: number,
  options?: {
    minStartDate?: Date
    notBefore?: Date
    /**
     * Local calendar days (`YYYY-MM-DD` in the schedule's timezone) the caller
     * has already reserved, so the walk steps over them instead of
     * double-booking. Used by the re-lay action, where the customer picks the
     * starting date and other episodes keep the slots they already hold.
     *
     * A blocked day is SKIPPED, not counted: it neither consumes one of the
     * `count` slots nor moves the cadence anchor, so the chosen rhythm stays
     * intact and the caller can still receive exactly `count` distinct days.
     * Like `minStartDate`, this reserves the WHOLE local day, because a
     * customer who hand-placed an episode at an off-pattern time still owns
     * that date.
     */
    blockedDays?: ReadonlySet<string> | readonly string[]
  },
): string[] {
  // Validate the timezone up front so `new Intl.DateTimeFormat({ timeZone })`
  // never throws mid-loop. An invalid tz (typo, legacy "America/Buenos_Aires"
  // style) falls back to UTC so compute proceeds with reasonable behavior
  // rather than crashing the whole route handler.
  const tz = isValidTimezone(schedule.timezone) ? schedule.timezone : 'UTC'
  const planStartDate = schedule.start_date
    ? parseDateInTz(schedule.start_date, tz)
    : startOfDayInTz(new Date(), tz)
  // Phases (v1.4.268): the top-level fields are the first one; each later one
  // rules from its own start_date. A day past a phase's end_date and before the
  // next phase starts is simply not a slot day. The last phase's end_date is
  // the plan horizon, so a plan without phases walks exactly as before.
  const phases = [schedule, ...(Array.isArray(schedule.phases) ? schedule.phases : [])].map((phase, index) => {
    const weekdays = new Set((phase.weekdays || []).filter(d => d >= 0 && d <= 6))
    return {
      from: index === 0 ? null : parseDateInTz(phase.start_date!, tz),
      to: phase.end_date ? parseDateInTz(phase.end_date, tz) : null,
      time: parseTime(phase.time_local),
      weekdays,
      monthly: index === 0 && weekdays.size === 0 && schedule.monthly_day != null,
    }
  })
  const endDate = phases.at(-1)!.to

  // Walk start: optionally advanced past the latest existing claim.
  // We move to the start of the day AFTER `minStartDate` in tz so a
  // claim at any time-of-day on day D reserves the entire calendar
  // day D, even when the user manually scheduled at an off-pattern
  // time. Never moves earlier than the plan's own start_date.
  let startDate = planStartDate
  if (options?.minStartDate) {
    const minDayAfter = addDays(startOfDayInTz(options.minStartDate, tz), 1, tz)
    if (minDayAfter > startDate) startDate = minDayAfter
  }

  // An instant cutoff keeps a later-today slot available. A real claim above
  // still reserves its entire local day; the cadence anchor never moves.
  if (options?.notBefore) {
    const cutoffDay = startOfDayInTz(options.notBefore, tz)
    if (cutoffDay > startDate) startDate = cutoffDay
  }

  const slots: string[] = []
  // Walk one day at a time for up to 2 years out before giving up — covers
  // any reasonable plan horizon without unbounded iteration.
  const MAX_DAYS = 365 * 2
  const interval = Math.max(1, schedule.interval_weeks || 1)
  const blocked = options?.blockedDays
    ? (options.blockedDays instanceof Set ? options.blockedDays : new Set(options.blockedDays))
    : null

  // Anchor week for interval_weeks calc: first Sunday on/before the
  // PLAN's original start_date — not the (possibly advanced) walk
  // start. Pinning to the plan preserves the chosen N-weekly rhythm
  // when an apply resumes after off-rhythm manual schedules.
  const intervalAnchor = startOfWeek(planStartDate, tz)

  let cursor = new Date(startDate)
  let daysWalked = 0
  while (slots.length < count && daysWalked < MAX_DAYS) {
    if (endDate && cursor > endDate) break
    let phase = phases[0]!
    for (const later of phases) if (later.from && later.from <= cursor) phase = later
    const weekday = weekdayInTz(cursor, tz)
    const dayOfMonth = dayOfMonthInTz(cursor, tz)

    let matches = false
    if (phase.to && cursor > phase.to) {
      // Between a phase's end_date and the next phase's start: no slot day.
    } else if (phase.monthly) {
      matches = dayOfMonth === schedule.monthly_day
    } else if (phase.weekdays.has(weekday)) {
      if (interval === 1) {
        matches = true
      } else {
        // Interval gate: how many weeks since intervalAnchor?
        const weeksSinceAnchor = Math.floor(daysBetween(intervalAnchor, cursor, tz) / 7)
        matches = weeksSinceAnchor % interval === 0
      }
    }

    if (matches) {
      // An occupied local day is stepped over without consuming a slot, so a
      // re-lay flows around existing bookings instead of double-booking them.
      if (blocked?.has(localDayKeyInTz(cursor, tz))) {
        cursor = addDays(cursor, 1, tz)
        daysWalked++
        continue
      }
      const slot = isoAtTz(cursor, phase.time[0], phase.time[1], tz)
      if (!options?.notBefore || Date.parse(slot) > options.notBefore.getTime()) slots.push(slot)
    }

    cursor = addDays(cursor, 1, tz)
    daysWalked++
  }
  return slots
}

// ── Timezone-friendly helpers ─────────────────────────────────────────────
// Intl-based rather than a real tz library; good enough for scheduling
// accuracy. For one-off bugs near DST transitions we'd adopt `@js-temporal/polyfill`,
// but it's not pulling its weight in the dep tree for Phase 3.

function isValidTimezone(tz: string | undefined): tz is string {
  if (!tz || typeof tz !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch { return false }
}

function parseTime(hhmm: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return [18, 0]
  return [Math.min(23, parseInt(m[1] || '0', 10)), Math.min(59, parseInt(m[2] || '0', 10))]
}

function startOfDayInTz(d: Date, tz: string): Date {
  // Convert the date to that tz's midnight expressed as UTC instant.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const y = Number(parts.find(p => p.type === 'year')?.value)
  const m = Number(parts.find(p => p.type === 'month')?.value)
  const day = Number(parts.find(p => p.type === 'day')?.value)
  // Build an instant such that toLocaleString with that tz gives us YYYY-MM-DD 00:00.
  return dateAtTzLocal(y, m, day, 0, 0, tz)
}

function parseDateInTz(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return dateAtTzLocal(y || 1970, m || 1, d || 1, 0, 0, tz)
}

function dateAtTzLocal(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  // Build a UTC guess, then use Intl to read back the tz-local wall time,
  // and correct until the wall time matches what we asked for. Max two
  // iterations handle even the weirdest DST offsets.
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0))
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(guess)
    const gy = Number(parts.find(p => p.type === 'year')?.value)
    const gm = Number(parts.find(p => p.type === 'month')?.value)
    const gd = Number(parts.find(p => p.type === 'day')?.value)
    // Node's Intl.DateTimeFormat with hour12:false returns '24' for midnight
    // (instead of '00'). Normalize so round-trip math doesn't shift a day.
    const rawHour = Number(parts.find(p => p.type === 'hour')?.value)
    const ghh = rawHour === 24 ? 0 : rawHour
    const gmm = Number(parts.find(p => p.type === 'minute')?.value)
    const wallUtc = Date.UTC(gy, gm - 1, gd, ghh, gmm, 0)
    const targetUtc = Date.UTC(y, m - 1, d, hh, mm, 0)
    const deltaMs = targetUtc - wallUtc
    if (Math.abs(deltaMs) < 60_000) return guess
    guess = new Date(guess.getTime() + deltaMs)
  }
  return guess
}

function isoAtTz(d: Date, hh: number, mm: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const y = Number(parts.find(p => p.type === 'year')?.value)
  const m = Number(parts.find(p => p.type === 'month')?.value)
  const day = Number(parts.find(p => p.type === 'day')?.value)
  return dateAtTzLocal(y, m, day, hh, mm, tz).toISOString()
}

function weekdayInTz(d: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[wd] ?? 0
}

function dayOfMonthInTz(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: '2-digit' }).formatToParts(d)
  return Number(parts.find(p => p.type === 'day')?.value) || 1
}

/**
 * The local calendar day (`YYYY-MM-DD`) an instant falls on in `tz`.
 *
 * Exported because the re-lay route must key an episode's existing claim by the
 * same local day `computeSlots` uses to test occupancy. Two different notions of
 * "the same day" — UTC vs local, say — would let a blocked slot through.
 */
export function localDayKeyInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimezone(tz) ? tz : 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const y = parts.find(p => p.type === 'year')?.value ?? '1970'
  const m = parts.find(p => p.type === 'month')?.value ?? '01'
  const day = parts.find(p => p.type === 'day')?.value ?? '01'
  return `${y}-${m}-${day}`
}

function startOfWeek(d: Date, tz: string): Date {
  const day = weekdayInTz(d, tz)
  return addDays(startOfDayInTz(d, tz), -day, tz)
}

function addDays(d: Date, days: number, tz: string): Date {
  const key = localDayKeyInTz(d, tz)
  const [year, month, day] = key.split('-').map(Number)
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days))
  return dateAtTzLocal(
    shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), 0, 0, tz,
  )
}

function daysBetween(a: Date, b: Date, tz: string): number {
  const [ay, am, ad] = localDayKeyInTz(a, tz).split('-').map(Number)
  const [by, bm, bd] = localDayKeyInTz(b, tz).split('-').map(Number)
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000)
}

// ── Per-item publication facts and schedule map ───────────────────────────

export const LEGACY_SCHEDULE_FIELD = 'upload_item_schedule'

export async function readItemPublicationStates(slug: string, cache?: ProjectFactsCache): Promise<Record<string, {
  privacy_status?: string
  scheduled_for?: string | null
}>> {
  const out: Record<string, { privacy_status?: string; scheduled_for?: string | null }> = {}
  // The caller's request-scoped facts. Without it a per-episode sweep re-read
  // and re-parsed project.json and ideas.json for EVERY episode — the global
  // Publishing Overview asks this once per channel, so the whole channel paid
  // it 250 times over.
  const ideas = await im.getIdeas(slug, 'accepted', cache)
  const { records: operations, state } = await readYouTubeRetentionStores(slug, cache)
  const assignedChannel = (await getProjectYouTubeAssignment(slug))?.channel_id
  await Promise.all(ideas.map(async (idea) => {
    if (!idea.episode_code) return
    const canonical = operations.filter(record => record.episode_code === idea.episode_code
      && (!assignedChannel || record.channel_id === assignedChannel)
      && !isYouTubeVideoRemoved(state, idea.episode_code!, record.channel_id, record.video_id)).at(-1)
    const facts = canonical ? operationPublicationFacts(canonical) : {}
    const sc = await readSidecarStrict(slug, idea.episode_code, 'youtube', cache)
    const removedSidecar = isYouTubeVideoRemoved(state, idea.episode_code, sc?.channel_id, sc?.video_id)
    out[idea.episode_code] = {
      ...(facts.privacy_status !== undefined
        ? { privacy_status: facts.privacy_status }
        : sc?.privacy_status && !removedSidecar ? { privacy_status: sc.privacy_status } : {}),
      // A private remote receipt with no publishAt is not a competing claim.
      // Keep a locally planned sidecar slot until an explicit schedule PUT
      // confirms it remotely. A public or unlisted canonical receipt remains
      // authoritative, including its null publishAt.
      ...(facts.scheduled_for
        ? { scheduled_for: facts.scheduled_for }
        : facts.privacy_status === 'private' && sc
          ? { scheduled_for: sc.scheduled_for }
          : facts.scheduled_for !== undefined
            ? { scheduled_for: facts.scheduled_for }
            : sc ? { scheduled_for: sc.scheduled_for } : {}),
    }
  }))
  return out
}

/** Build the canonical schedule map, with planning/legacy sidecars as fallback. */
export async function readItemSchedule(slug: string, cache?: ProjectFactsCache): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const states = await readItemPublicationStates(slug, cache)
  for (const [code, state] of Object.entries(states)) {
    if (state.scheduled_for) out[code] = state.scheduled_for
  }

  // Legacy map — merge in non-episode keys. Episode-coded keys may also
  // linger in the map on the first boot before migration runs (or if
  // the migration is mid-flight); the sidecar wins on conflict because
  // it's the post-migration source of truth.
  const config = (await pm.getConfig(slug)) as any
  const legacy = (config?.[LEGACY_SCHEDULE_FIELD] && typeof config[LEGACY_SCHEDULE_FIELD] === 'object')
    ? config[LEGACY_SCHEDULE_FIELD] as Record<string, string>
    : null
  if (legacy) {
    for (const [k, v] of Object.entries(legacy)) {
      if (!v) continue
      // Sidecar already wins for episode codes, so only fall through
      // when the key isn't already covered. Imports + any future non-
      // episode key types land here unconditionally.
      if (k in out) continue
      out[k] = v
    }
  }

  return out
}

/**
 * Apply a complete schedule map: every entry not in the new map is
 * cleared. Episode-coded entries write through to each episode's
 * sidecar; non-episode keys (today `import:*`) ride in the legacy
 * config map exactly as before.
 *
 * Performance: O(N) sidecar reads + targeted writes (only touched
 * sidecars are actually rewritten — see setScheduledFor's no-op
 * guards). This is bigger than the old single-config-write but still
 * negligible for personal-use project sizes.
 */
export async function writeItemSchedule(slug: string, map: Record<string, string>): Promise<void> {
  // Partition the incoming map so episode-coded entries hit sidecars
  // and non-episode keys ride the legacy map. We can't tell from a key
  // alone what's "episode-coded" without consulting accepted ideas, so
  // walk that list first.
  const ideas = await im.getIdeas(slug, 'accepted')
  const ideaByCode = new Map<string, { title: string }>()
  for (const i of ideas) {
    if (i.episode_code) ideaByCode.set(i.episode_code, { title: i.title || '' })
  }

  const importKeys: Record<string, string> = {}
  const episodeKeys: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    if (!v) continue
    if (ideaByCode.has(k)) episodeKeys[k] = v
    else if (k.startsWith('import:')) importKeys[k] = v
    // Anything else (orphan codes referring to deleted ideas, typos
    // from a route that didn't validate) is silently dropped — it
    // would have nowhere consistent to live and just clutters config.
  }

  // Drive sidecar writes — set new entries, clear any episode that was
  // previously scheduled but isn't in the new map. We could read every
  // sidecar to know which are currently set, but it's cheaper to just
  // call setScheduledFor on every accepted episode (no-ops are guarded
  // inside the helper).
  await Promise.all(Array.from(ideaByCode.entries()).map(async ([code, info]) => {
    const next = episodeKeys[code] ?? null
    await setScheduledFor(slug, code, info.title, 'youtube', next)
  }))

  // Update the legacy map for non-episode keys. Preserve any other
  // legacy entries (`import:*`, future shapes) unchanged. The map is
  // also where unmigrated episode entries linger pre-boot — clear
  // them out here so writes through this path stay self-consistent.
  const config = (await pm.getConfig(slug)) as any
  const prior = (config?.[LEGACY_SCHEDULE_FIELD] && typeof config[LEGACY_SCHEDULE_FIELD] === 'object')
    ? config[LEGACY_SCHEDULE_FIELD] as Record<string, string>
    : {}
  const nextLegacy: Record<string, string> = {}
  for (const [k, v] of Object.entries(prior)) {
    if (!v) continue
    // Drop episode-coded entries that the sidecar now owns. Drop any
    // non-import key shape too — those are orphans from a route that
    // didn't validate (typo'd code, deleted-since-scheduled idea) and
    // they have nowhere consistent to live now that the sidecar is
    // the source of truth for episodes.
    if (ideaByCode.has(k)) continue
    if (!k.startsWith('import:')) continue
    nextLegacy[k] = v
  }
  for (const [k, v] of Object.entries(importKeys)) nextLegacy[k] = v
  await pm.updateConfig(slug, { [LEGACY_SCHEDULE_FIELD]: nextLegacy } as any)
}
