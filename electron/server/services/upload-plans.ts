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
 *
 * Computed output: list of `{ position, publishAt }` tuples for a given
 * queue of N items, starting from the plan's start_date (or "now") and
 * walking forward through slots. End-date caps the slot stream.
 */

import { randomUUID } from 'crypto'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { readSidecarRaw, setScheduledFor } from './upload-sidecar.js'
import type { UploadPlatform } from './upload-store.js'

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

export async function removePlan(slug: string, id: string): Promise<boolean> {
  const plans = await listPlans(slug)
  const next = plans.filter(p => p.id !== id)
  if (next.length === plans.length) return false
  await pm.updateConfig(slug, { upload_plans: next } as any)
  // Also clear any active pointer that referenced this plan.
  const config = (await pm.getConfig(slug)) as any
  const activeMap: Record<string, string> = config?.upload_plan_active || {}
  let touched = false
  const nextActive = { ...activeMap }
  for (const [key, val] of Object.entries(activeMap)) {
    if (val === id) { nextActive[key] = ''; touched = true }
  }
  if (touched) await pm.updateConfig(slug, { upload_plan_active: nextActive } as any)
  return true
}

// ── Schedule compute ──────────────────────────────────────────────────────
//
// Pure function — no I/O. Given a plan's schedule and a count N, produces
// N ISO 8601 timestamps (UTC) for the next N slots starting at
// `schedule.start_date` (or "today in tz"). Caps at `end_date` when set;
// returns fewer than N if the stream runs out.
//
// `skipClaimed` (v1.0.42) — when supplied, slots whose ISO timestamp
// matches any string in the set are skipped over instead of emitted.
// Use this to make repeat-applies of a plan land in the next FREE
// slot rather than re-claiming an already-scheduled time. Episodes
// being re-scheduled by the current apply should be subtracted from
// the set BEFORE passing in (the route layer handles that — see
// /upload/plans/:id/apply).

export function computeSlots(
  schedule: UploadSchedule,
  count: number,
  skipClaimed?: ReadonlySet<string>,
): string[] {
  // Validate the timezone up front so `new Intl.DateTimeFormat({ timeZone })`
  // never throws mid-loop. An invalid tz (typo, legacy "America/Buenos_Aires"
  // style) falls back to UTC so compute proceeds with reasonable behavior
  // rather than crashing the whole route handler.
  const tz = isValidTimezone(schedule.timezone) ? schedule.timezone : 'UTC'
  const [hh, mm] = parseTime(schedule.time_local)
  const startDate = schedule.start_date
    ? parseDateInTz(schedule.start_date, tz)
    : startOfDayInTz(new Date(), tz)
  const endDate = schedule.end_date ? parseDateInTz(schedule.end_date, tz) : null

  const slots: string[] = []
  // Walk one day at a time for up to 2 years out before giving up — covers
  // any reasonable plan horizon without unbounded iteration.
  const MAX_DAYS = 365 * 2
  const interval = Math.max(1, schedule.interval_weeks || 1)
  const weekdaysSet = new Set((schedule.weekdays || []).filter(d => d >= 0 && d <= 6))
  const monthlyMode = weekdaysSet.size === 0 && schedule.monthly_day != null

  // Anchor week for interval_weeks calc: first Sunday on/before startDate.
  // Rounds `elapsedWeeks` so every Nth week matches regardless of starting
  // weekday. `intervalAnchorDay` is a day-number delta from the anchor.
  const intervalAnchor = startOfWeek(startDate, tz)

  let cursor = new Date(startDate)
  let daysWalked = 0
  while (slots.length < count && daysWalked < MAX_DAYS) {
    if (endDate && cursor > endDate) break
    const weekday = weekdayInTz(cursor, tz)
    const dayOfMonth = dayOfMonthInTz(cursor, tz)

    let matches = false
    if (monthlyMode) {
      matches = dayOfMonth === schedule.monthly_day
    } else if (weekdaysSet.has(weekday)) {
      if (interval === 1) {
        matches = true
      } else {
        // Interval gate: how many weeks since intervalAnchor?
        const weeksSinceAnchor = Math.floor(daysBetween(intervalAnchor, cursor, tz) / 7)
        matches = weeksSinceAnchor % interval === 0
      }
    }

    if (matches) {
      const candidate = isoAtTz(cursor, hh, mm, tz)
      // Skip already-claimed slots — see header comment. The walk
      // continues so the next match keeps the user's chosen rhythm
      // instead of compressing all skipped occurrences into one.
      if (!skipClaimed || !skipClaimed.has(candidate)) {
        slots.push(candidate)
      }
    }

    cursor = addDays(cursor, 1)
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

function startOfWeek(d: Date, tz: string): Date {
  const day = weekdayInTz(d, tz)
  return addDays(startOfDayInTz(d, tz), -day)
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}

function daysBetween(a: Date, b: Date, _tz: string): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

// ── Per-item scheduled_for map (item I-eager: sidecar-backed) ─────────────
//
// Historical model (≤ v1.0.37): a single `config.upload_item_schedule`
// record on the project, keyed by episode_code, mapping → ISO 8601 publishAt.
// Two reads / writes were enough to mutate the whole project's schedule.
//
// Item I-eager (v1.0.38+) moved per-episode `scheduled_for` into each
// episode's YouTube sidecar so there's exactly one source of truth per
// episode. Imports keep using the config map (they have no sidecar).
// The boot-time migration in `upload-schedule-migration.ts` walks the
// legacy map once on app start and pours each entry into the matching
// sidecar.
//
// Backwards-compat invariant: `readItemSchedule` returns the merged view
// (sidecars first, then any unmigrated import-keyed entries from the
// legacy map). Existing callers that loop the map don't need to know
// where the data came from. After all installs have booted past the
// migration, the legacy map is empty for episodes; only `import:*` keys
// remain. We can delete the legacy field entirely after a release or two.

export const LEGACY_SCHEDULE_FIELD = 'upload_item_schedule'

/**
 * Build the merged schedule map for a project. Episode-coded entries
 * come from each accepted episode's sidecar (`scheduled_for`); any
 * non-episode keys (today only `import:*`) come from the legacy config
 * map. Falsy values are filtered so consumers can use `truthy-check`
 * for "is this scheduled?" without surprises from `null` carry-overs.
 */
export async function readItemSchedule(slug: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}

  // Sidecar reads — one per accepted episode. Project counts are tiny
  // (personal-use), and each read is a small JSON file, so the parallel
  // fan-out keeps this comfortably under a frame budget.
  const ideas = await im.getIdeas(slug, 'accepted').catch(() => [])
  await Promise.all(ideas.map(async (idea) => {
    if (!idea.episode_code) return
    const sc = await readSidecarRaw(slug, idea.episode_code, idea.title || '', 'youtube')
    if (sc?.scheduled_for) out[idea.episode_code] = sc.scheduled_for
  }))

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
  const ideas = await im.getIdeas(slug, 'accepted').catch(() => [])
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
