/**
 * Upload pacing service — deterministic scheduling, eligibility, and conflict evaluation (Story 386 Item 1).
 *
 * Implements core primitives for upload pacing:
 * - Starting tiers (Gentle 3/day, Regular 6/day, Bulk 12/day) as editable counts, no auto-promotion.
 * - Window hours MUST be an explicit channel choice: no hidden 08:00–22:00 or 180-minute defaults.
 *   Missing window results in an honest configuration reason.
 * - Channel-local pacing day is distinct from the real API quota reset (e.g. midnight PT / America/Los_Angeles).
 * - "Upload on" is earliest transfer start; "Publish on" is YouTube public release time.
 * - Publish lead time (default 6 hours from YOUTUBE_PUBLISH_LEAD_TIME_MS) is enforced:
 *   upload_on + lead_time must be <= publish_at.
 * - Offline / quota recovery: no catch-up bursts! Earliest slot is >= now and spaced.
 * - Pure and deterministic: accepts recorded starts/completed transfers via data (no hardcoded channels/episodes).
 */

import { YOUTUBE_PUBLISH_LEAD_TIME_MS } from './youtube-publish-guard.js'
import {
  type UploadPacingPolicy,
  type UploadTimeWindow,
  type RecordedTransfer,
  type PacingQueueItem,
  type PacedSlot,
  type PacingConflict,
  type PacedPlanResult,
  type UploadEligibilityVerdict,
  type UploadEligibilityContext,
  type UploadWaitReason,
  validateUploadPacingPolicy,
  isValidIanaTimezone,
  hhmmToMinutes,
  effectiveSpacingMinutes,
} from '../contracts/upload-pacing.js'

export * from '../contracts/upload-pacing.js'

function parseTime(hhmm: string): [number, number] {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  if (!m) return [0, 0]
  return [Number(m[1]), Number(m[2])]
}

/**
 * Return a Date instant corresponding to the given local wall-clock time in timezone.
 * Handles DST shifts cleanly using iterative convergence against Intl.DateTimeFormat.
 */
export function dateAtTzLocal(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): Date {
  if (!isValidIanaTimezone(tz)) {
    throw new Error(`Invalid IANA timezone: "${String(tz)}"`)
  }
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0))
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(guess)
    const gy = Number(parts.find(p => p.type === 'year')?.value)
    const gm = Number(parts.find(p => p.type === 'month')?.value)
    const gd = Number(parts.find(p => p.type === 'day')?.value)
    const rawH = Number(parts.find(p => p.type === 'hour')?.value)
    const ghh = rawH === 24 ? 0 : rawH
    const gmm = Number(parts.find(p => p.type === 'minute')?.value)
    const wallUtc = Date.UTC(gy, gm - 1, gd, ghh, gmm, 0)
    const targetUtc = Date.UTC(y, m - 1, d, hh, mm, 0)
    const deltaMs = targetUtc - wallUtc
    if (Math.abs(deltaMs) < 60_000) return guess
    guess = new Date(guess.getTime() + deltaMs)
  }
  return guess
}

/**
 * Get the calendar day key (YYYY-MM-DD) for an instant in the specified timezone.
 * Fails loudly on invalid timezone or unparseable instant.
 */
export function getChannelDayKey(instant: Date | number | string, timezone: string): string {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`Invalid IANA timezone: "${String(timezone)}"`)
  }
  const date = typeof instant === 'number' ? new Date(instant) : typeof instant === 'string' ? new Date(instant) : instant
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date/instant: "${String(instant)}"`)
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const d = parts.find(p => p.type === 'day')?.value
  if (!y || !m || !d) {
    throw new Error(`Failed to format date in timezone "${timezone}"`)
  }
  return `${y}-${m}-${d}`
}

/**
 * Get the YouTube API quota day key (YYYY-MM-DD in America/Los_Angeles by default).
 * Channel pacing days differ from quota days whenever the channel's timezone differs from PT.
 */
export function getQuotaDayKey(instant: Date | number | string, quotaTimezone = 'America/Los_Angeles'): string {
  return getChannelDayKey(instant, quotaTimezone)
}

/**
 * Parse a YYYY-MM-DD calendar day into local midnight Date in timezone.
 */
export function parseDateInTz(ymd: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) throw new Error(`Invalid calendar date format (expected YYYY-MM-DD): "${ymd}"`)
  const y = Number(m[1])
  const mon = Number(m[2])
  const d = Number(m[3])
  return dateAtTzLocal(y, mon, d, 0, 0, tz)
}

/**
 * Add calendar days in the specified timezone.
 */
export function addDaysInTz(date: Date, days: number, tz: string): Date {
  const dayKey = getChannelDayKey(date, tz)
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number]
  return dateAtTzLocal(y, m, d + days, 0, 0, tz)
}

/**
 * Format a Date instant to ISO 8601 UTC string for a given local hour/minute in timezone.
 */
export function isoAtTz(date: Date, hh: number, mm: number, tz: string): string {
  const dayKey = getChannelDayKey(date, tz)
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number]
  return dateAtTzLocal(y, m, d, hh, mm, tz).toISOString()
}

/**
 * Count recorded transfers belonging to a channel day (excluding failed/aborted).
 */
export function countChannelDayTransfers(
  transfers: readonly RecordedTransfer[],
  dayKey: string,
  timezone: string,
): number {
  let count = 0
  for (const transfer of transfers) {
    if (transfer.status === 'failed' || transfer.status === 'aborted') {
      continue
    }
    const timeStr = transfer.started_at || transfer.completed_at
    if (!timeStr) continue
    try {
      const transferDay = getChannelDayKey(timeStr, timezone)
      if (transferDay === dayKey) {
        count++
      }
    } catch {
      // skip unparseable entries
    }
  }
  return count
}

/**
 * Check whether an instant falls inside the daily window in the given timezone.
 */
export function isInsideWindow(
  instant: Date | number | string,
  window: UploadTimeWindow,
  timezone: string,
): boolean {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`Invalid IANA timezone: "${String(timezone)}"`)
  }
  const date = typeof instant === 'number' ? new Date(instant) : typeof instant === 'string' ? new Date(instant) : instant
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date/instant: "${String(instant)}"`)
  }
  const startMin = hhmmToMinutes(window.start)
  const endMin = hhmmToMinutes(window.end)
  if (startMin === null || endMin === null || endMin <= startMin) {
    throw new Error(`Invalid window: ${JSON.stringify(window)}`)
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)
  const rawH = Number(parts.find(p => p.type === 'hour')?.value)
  const h = rawH === 24 ? 0 : rawH
  const m = Number(parts.find(p => p.type === 'minute')?.value)
  const currentMin = h * 60 + m
  return currentMin >= startMin && currentMin <= endMin
}

/**
 * Check whether an instant falls on an allowed weekday in timezone.
 * Returns true if weekdays is undefined or empty (all days allowed).
 */
export function isAllowedWeekday(
  instant: Date | number | string,
  weekdays: number[] | undefined,
  timezone: string,
): boolean {
  if (!weekdays || weekdays.length === 0) return true
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`Invalid IANA timezone: "${String(timezone)}"`)
  }
  const date = typeof instant === 'number' ? new Date(instant) : typeof instant === 'string' ? new Date(instant) : instant
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date/instant: "${String(instant)}"`)
  }
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const dayIndex = map[wd] ?? 0
  return weekdays.includes(dayIndex)
}

/**
 * Find the next instant when an upload window opens on an allowed weekday.
 */
export function findNextAllowedWindowStart(
  fromInstant: Date | number | string,
  policy: UploadPacingPolicy,
): string {
  const fromMs = typeof fromInstant === 'number' ? fromInstant : typeof fromInstant === 'string' ? Date.parse(fromInstant) : fromInstant.getTime()
  if (!Number.isFinite(fromMs)) throw new Error(`Invalid instant: "${String(fromInstant)}"`)

  const tz = policy.timezone
  const [startH, startM] = parseTime(policy.window.start)
  const [endH, endM] = parseTime(policy.window.end)
  const fromDate = new Date(fromMs)
  const currentDayKey = getChannelDayKey(fromDate, tz)
  const currentDayDate = parseDateInTz(currentDayKey, tz)
  const [curY, curM, curD] = currentDayKey.split('-').map(Number) as [number, number, number]

  // Check today if allowed
  if (isAllowedWeekday(currentDayDate, policy.weekdays, tz)) {
    const todayWindowStartMs = dateAtTzLocal(curY, curM, curD, startH, startM, tz).getTime()
    const todayWindowEndMs = dateAtTzLocal(curY, curM, curD, endH, endM, tz).getTime()
    if (fromMs < todayWindowStartMs) {
      return new Date(todayWindowStartMs).toISOString()
    }
    if (fromMs <= todayWindowEndMs) {
      return new Date(fromMs).toISOString()
    }
  }

  // Walk forward up to 14 days
  for (let offset = 1; offset <= 14; offset++) {
    const nextDay = addDaysInTz(currentDayDate, offset, tz)
    if (isAllowedWeekday(nextDay, policy.weekdays, tz)) {
      const nextDayKey = getChannelDayKey(nextDay, tz)
      const [ny, nm, nd] = nextDayKey.split('-').map(Number) as [number, number, number]
      const nextWindowStartMs = dateAtTzLocal(ny, nm, nd, startH, startM, tz).getTime()
      return new Date(nextWindowStartMs).toISOString()
    }
  }

  // Fallback: tomorrow at window start
  const fallback = addDaysInTz(currentDayDate, 1, tz)
  const [fy, fm, fd] = getChannelDayKey(fallback, tz).split('-').map(Number) as [number, number, number]
  return dateAtTzLocal(fy, fm, fd, startH, startM, tz).toISOString()
}

export interface CalculatePacedSlotsOptions {
  /** Current time reference (defaults to Date.now()). */
  now?: Date | number | string
  /** Existing completed or in-progress transfers that count against daily allowances. */
  recorded_transfers?: readonly RecordedTransfer[]
  /** Existing planned slots in the queue that shouldn't be collided with. */
  existing_planned_slots?: readonly PacedSlot[]
  /** Required publish lead time in ms (defaults to YOUTUBE_PUBLISH_LEAD_TIME_MS = 6 hours). */
  publish_lead_ms?: number
  /** Timezone for API quota day tracking (defaults to 'America/Los_Angeles'). */
  quota_timezone?: string
}

/**
 * Calculate future upload slots and detect scheduling conflicts for a batch of queue items.
 *
 * Rules:
 * - Deterministic: slots spread across the window and day allowance.
 * - No catchup burst: candidate slots are never in the past (>= now), and spaced from recent uploads.
 * - Daily allowance: channel-local day counts both recorded transfers and planned slots.
 * - Window hours: uploads only start within the explicit window.
 * - Conflict detection: upload_on + lead_time > publish_at produces a loud conflict record.
 * - Missing window or unconfigured policy returns an honest unconfigured result.
 */
export function calculatePacedUploadSlots(
  items: readonly PacingQueueItem[],
  policy: UploadPacingPolicy,
  options?: CalculatePacedSlotsOptions,
): PacedPlanResult {
  const validation = validateUploadPacingPolicy(policy)
  if (!validation.ok) {
    return {
      ok: false,
      slots: [],
      conflicts: [],
      unconfigured_reason: validation.reason,
      unconfigured_message: validation.message,
    }
  }

  if (items.length === 0) {
    return { ok: true, slots: [], conflicts: [] }
  }

  const validPolicy = validation.policy
  const nowMs = typeof options?.now === 'number'
    ? options.now
    : typeof options?.now === 'string'
      ? Date.parse(options.now)
      : options?.now instanceof Date
        ? options.now.getTime()
        : Date.now()

  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid "now" timestamp: "${String(options?.now)}"`)
  }

  const leadMs = options?.publish_lead_ms ?? YOUTUBE_PUBLISH_LEAD_TIME_MS
  const quotaTz = options?.quota_timezone || 'America/Los_Angeles'
  if (!isValidIanaTimezone(quotaTz)) {
    throw new Error(`Invalid quota timezone: "${String(quotaTz)}"`)
  }

  const [startH, startM] = parseTime(validPolicy.window.start)
  const [endH, endM] = parseTime(validPolicy.window.end)
  // Same spacing figure the eligibility verdict enforces — one source of truth.
  const effectiveSpacingMin = effectiveSpacingMinutes(validPolicy)

  // Track counts and existing uploads per channel-local day
  const daySlotCounts = new Map<string, number>()
  let lastTransferOrSlotMs: number | null = null

  // Account for recorded transfers
  const recorded = options?.recorded_transfers ?? []
  for (const t of recorded) {
    if (t.status === 'failed' || t.status === 'aborted') continue
    const timeStr = t.started_at || t.completed_at
    if (!timeStr) continue
    const tMs = Date.parse(timeStr)
    if (!Number.isFinite(tMs)) continue
    const dayKey = getChannelDayKey(tMs, validPolicy.timezone)
    daySlotCounts.set(dayKey, (daySlotCounts.get(dayKey) || 0) + 1)
    if (lastTransferOrSlotMs === null || tMs > lastTransferOrSlotMs) {
      lastTransferOrSlotMs = tMs
    }
  }

  // Account for existing planned slots
  const existingSlots = options?.existing_planned_slots ?? []
  for (const s of existingSlots) {
    const sMs = Date.parse(s.upload_on)
    if (!Number.isFinite(sMs)) continue
    const dayKey = s.channel_day_key || getChannelDayKey(sMs, validPolicy.timezone)
    daySlotCounts.set(dayKey, (daySlotCounts.get(dayKey) || 0) + 1)
    if (lastTransferOrSlotMs === null || sMs > lastTransferOrSlotMs) {
      lastTransferOrSlotMs = sMs
    }
  }

  const slots: PacedSlot[] = []
  const conflicts: PacingConflict[] = []

  for (const item of items) {
    let itemMinMs = nowMs
    if (item.earliest_upload_on) {
      const parsedEarliest = Date.parse(item.earliest_upload_on)
      if (!Number.isFinite(parsedEarliest)) {
        throw new Error(`Invalid earliest_upload_on for ${item.episode_code}: "${item.earliest_upload_on}"`)
      }
      if (parsedEarliest > itemMinMs) {
        itemMinMs = parsedEarliest
      }
    }

    // Determine the calendar day to begin searching
    let candidateDayDate = parseDateInTz(getChannelDayKey(itemMinMs, validPolicy.timezone), validPolicy.timezone)
    let assigned = false
    let safetyCounter = 0

    while (!assigned && safetyCounter++ < 365) {
      const dayKey = getChannelDayKey(candidateDayDate, validPolicy.timezone)

      // Skip non-allowed weekdays
      if (!isAllowedWeekday(candidateDayDate, validPolicy.weekdays, validPolicy.timezone)) {
        candidateDayDate = addDaysInTz(candidateDayDate, 1, validPolicy.timezone)
        continue
      }

      // Check daily limit
      const currentDayCount = daySlotCounts.get(dayKey) || 0
      if (currentDayCount >= validPolicy.daily_limit) {
        candidateDayDate = addDaysInTz(candidateDayDate, 1, validPolicy.timezone)
        continue
      }

      const [curY, curM, curD] = dayKey.split('-').map(Number) as [number, number, number]
      const dayWindowStartMs = dateAtTzLocal(curY, curM, curD, startH, startM, validPolicy.timezone).getTime()
      const dayWindowEndMs = dateAtTzLocal(curY, curM, curD, endH, endM, validPolicy.timezone).getTime()

      // Calculate earliest candidate time for this slot today
      let candidateTimeMs = Math.max(dayWindowStartMs, itemMinMs)

      // Nominal slot position if spreading across day
      if (currentDayCount > 0 && effectiveSpacingMin > 0) {
        const nominalSlotTimeMs = dayWindowStartMs + currentDayCount * effectiveSpacingMin * 60_000
        candidateTimeMs = Math.max(candidateTimeMs, nominalSlotTimeMs)
      }

      // Spacing hold from last upload
      if (lastTransferOrSlotMs !== null && effectiveSpacingMin > 0) {
        const spacingClearedMs = lastTransferOrSlotMs + effectiveSpacingMin * 60_000
        candidateTimeMs = Math.max(candidateTimeMs, spacingClearedMs)
      }

      // If candidate time exceeds the daily window, advance to tomorrow
      if (candidateTimeMs > dayWindowEndMs) {
        candidateDayDate = addDaysInTz(candidateDayDate, 1, validPolicy.timezone)
        continue
      }

      // Found slot!
      const uploadOnIso = new Date(candidateTimeMs).toISOString()
      const quotaDayKey = getQuotaDayKey(candidateTimeMs, quotaTz)
      const slotIndexToday = currentDayCount + 1

      daySlotCounts.set(dayKey, slotIndexToday)
      lastTransferOrSlotMs = candidateTimeMs

      const slot: PacedSlot = {
        episode_code: item.episode_code,
        upload_on: uploadOnIso,
        publish_at: item.publish_at ?? null,
        channel_day_key: dayKey,
        quota_day_key: quotaDayKey,
        slot_index_today: slotIndexToday,
        daily_limit: validPolicy.daily_limit,
      }
      slots.push(slot)
      assigned = true

      // Conflict evaluation
      if (item.publish_at) {
        const pubMs = Date.parse(item.publish_at)
        if (!Number.isFinite(pubMs)) {
          conflicts.push({
            episode_code: item.episode_code,
            reason: 'invalid_publish_at',
            detail: `The publish date "${item.publish_at}" is not a valid date.`,
            upload_on: uploadOnIso,
            publish_at: item.publish_at,
            required_lead_ms: leadMs,
            actual_gap_ms: null,
          })
        } else if (pubMs < nowMs) {
          conflicts.push({
            episode_code: item.episode_code,
            reason: 'publish_at_in_past',
            detail: `The publish date "${item.publish_at}" is in the past — YouTube publishes a video immediately when its publish date has already passed.`,
            upload_on: uploadOnIso,
            publish_at: item.publish_at,
            required_lead_ms: leadMs,
            actual_gap_ms: pubMs - candidateTimeMs,
          })
        } else if (pubMs < nowMs + leadMs) {
          conflicts.push({
            episode_code: item.episode_code,
            reason: 'publish_at_too_soon',
            detail: `The publish date "${item.publish_at}" is less than ${leadMs / (60 * 60 * 1000)} hours away, so it could pass before the upload finishes.`,
            upload_on: uploadOnIso,
            publish_at: item.publish_at,
            required_lead_ms: leadMs,
            actual_gap_ms: pubMs - candidateTimeMs,
          })
        } else if (candidateTimeMs + leadMs > pubMs) {
          const gapMinutes = Math.round((pubMs - candidateTimeMs) / (60 * 1000))
          conflicts.push({
            episode_code: item.episode_code,
            reason: 'cannot_meet_publish_deadline',
            detail: `Upload slot ${uploadOnIso} leaves only ${gapMinutes} minutes before publish date ${item.publish_at}, but at least ${leadMs / (60 * 60 * 1000)} hours lead time is required.`,
            upload_on: uploadOnIso,
            publish_at: item.publish_at,
            required_lead_ms: leadMs,
            actual_gap_ms: pubMs - candidateTimeMs,
          })
        }
      }
    }

    if (!assigned) {
      throw new Error(`Unable to find an upload slot for ${item.episode_code} within 365 days.`)
    }
  }

  return {
    ok: true,
    slots,
    conflicts,
  }
}

/**
 * Check whether an item is eligible to upload right now based on policy, window, quota and queue context.
 */
export function checkUploadEligibility(
  item: PacingQueueItem,
  policy: UploadPacingPolicy,
  context: UploadEligibilityContext = {},
): UploadEligibilityVerdict {
  const policyValidation = validateUploadPacingPolicy(policy)
  if (!policyValidation.ok) {
    return {
      eligible: false,
      reason: 'unconfigured_pacing',
      detail: policyValidation.message,
      earliest_start: null,
      channel_day_key: '',
      quota_day_key: '',
      daily_limit: 0,
      uploads_today: 0,
      remaining_today: 0,
      // Not "spacing is none" — no spacing could be derived from a policy that
      // failed validation; the reason above says so.
      effective_spacing_minutes: 0,
    }
  }

  const validPolicy = policyValidation.policy
  const nowMs = typeof context.now === 'number'
    ? context.now
    : typeof context.now === 'string'
      ? Date.parse(context.now)
      : context.now instanceof Date
        ? context.now.getTime()
        : Date.now()

  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid "now" timestamp: "${String(context.now)}"`)
  }

  const quotaTz = context.quota_timezone || 'America/Los_Angeles'
  const channelDayKey = getChannelDayKey(nowMs, validPolicy.timezone)
  const quotaDayKey = getQuotaDayKey(nowMs, quotaTz)
  const uploadsToday = countChannelDayTransfers(context.recorded_transfers ?? [], channelDayKey, validPolicy.timezone)
  const remainingToday = Math.max(0, validPolicy.daily_limit - uploadsToday)
  // The SAME spacing the slot calculator enforces (configured floor vs window spread).
  const spacingMin = effectiveSpacingMinutes(validPolicy)

  // One verdict builder: every branch fills only what differs, so the shape cannot drift.
  const verdict = (
    reason: UploadWaitReason,
    detail: string,
    extra: { earliest_start?: string | null; eligible?: boolean; remaining_today?: number } = {},
  ): UploadEligibilityVerdict => ({
    eligible: extra.eligible ?? false,
    reason,
    detail,
    earliest_start: extra.earliest_start ?? null,
    channel_day_key: channelDayKey,
    quota_day_key: quotaDayKey,
    daily_limit: validPolicy.daily_limit,
    uploads_today: uploadsToday,
    remaining_today: extra.remaining_today ?? remainingToday,
    effective_spacing_minutes: spacingMin,
  })

  // 1. Quota check — a reset time counts only when it is a valid FUTURE instant.
  //    A missing, unparseable or already-passed reset reads as an honest hold with
  //    no wake time invented (nothing auto-wakes on a guessed clock).
  if (context.quota_exhausted) {
    const resetMs = typeof context.quota_reset_at === 'string' ? Date.parse(context.quota_reset_at) : NaN
    const resetKnown = Number.isFinite(resetMs) && resetMs > nowMs
    return verdict(
      'quota_exhausted',
      resetKnown
        ? `YouTube API quota is exhausted. Holding until the tracked reset at ${new Date(resetMs).toISOString()}.`
        : 'YouTube API quota is exhausted, and no valid future reset time is known. The upload holds until a reset is observed; no wake time is invented.',
      { earliest_start: resetKnown ? new Date(resetMs).toISOString() : null },
    )
  }

  // 2. Waiting for the upload time — BOTH constraints hold, so the LATER valid
  //    instant wins; an unparseable date is a hold, never silently "eligible".
  const targetValues: string[] = [item.earliest_upload_on, context.planned_upload_on]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  let targetMs: number | null = null
  for (const value of targetValues) {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) {
      return verdict('invalid_upload_on', `The upload date "${value}" is not a valid date — holding for a corrected date.`)
    }
    if (targetMs === null || parsed > targetMs) targetMs = parsed
  }
  if (targetMs !== null && nowMs < targetMs) {
    const iso = new Date(targetMs).toISOString()
    return verdict('waiting_for_upload_on', `Upload is scheduled for ${iso}.`, { earliest_start: iso })
  }

  // 3. Publish deadline conflict check
  const pubDate = item.publish_at || context.publish_at
  if (pubDate) {
    const pubMs = Date.parse(pubDate)
    const leadMs = context.publish_lead_ms ?? YOUTUBE_PUBLISH_LEAD_TIME_MS
    if (!Number.isFinite(pubMs)) {
      return verdict('publish_deadline_conflict', `Publish date "${pubDate}" is not a valid date.`)
    }
    if (pubMs < nowMs) {
      return verdict('publish_deadline_conflict', `Publish date "${pubDate}" is in the past. Must hold for corrected date.`)
    }
    if (nowMs + leadMs > pubMs) {
      return verdict(
        'publish_deadline_conflict',
        `Publish deadline "${pubDate}" is less than ${leadMs / (60 * 60 * 1000)} hours from now; cannot upload without violating lead time.`,
      )
    }
  }

  // 4. Allowed weekdays check
  if (!isAllowedWeekday(nowMs, validPolicy.weekdays, validPolicy.timezone)) {
    return verdict(
      'weekday_not_allowed',
      'Today is not an allowed upload day for this channel.',
      { earliest_start: findNextAllowedWindowStart(nowMs, validPolicy) },
    )
  }

  // 5. Daily limit reached — next start comes from the channel-local NEXT day's
  //    window (never a raw now+24h, which overshoots past a window end or a DST shift).
  if (uploadsToday >= validPolicy.daily_limit) {
    const tomorrowLocal = addDaysInTz(parseDateInTz(channelDayKey, validPolicy.timezone), 1, validPolicy.timezone)
    return verdict(
      'daily_limit_reached',
      `Daily limit of ${validPolicy.daily_limit} uploads reached for channel day ${channelDayKey}.`,
      { earliest_start: findNextAllowedWindowStart(tomorrowLocal, validPolicy), remaining_today: 0 },
    )
  }

  // 6. Outside window check
  if (!isInsideWindow(nowMs, validPolicy.window, validPolicy.timezone)) {
    return verdict(
      'outside_window',
      `Current time is outside the allowed window ${validPolicy.window.start}–${validPolicy.window.end}.`,
      { earliest_start: findNextAllowedWindowStart(nowMs, validPolicy) },
    )
  }

  // 7. Spacing hold — same effective spacing as the slot calculator, so an
  //    in-window check can never wave through back-to-back starts.
  if (spacingMin > 0 && context.recorded_transfers && context.recorded_transfers.length > 0) {
    let latestTransferMs: number | null = null
    for (const t of context.recorded_transfers) {
      if (t.status === 'failed' || t.status === 'aborted') continue
      const tTime = t.started_at || t.completed_at
      if (!tTime) continue
      const parsed = Date.parse(tTime)
      if (Number.isFinite(parsed) && (latestTransferMs === null || parsed > latestTransferMs)) {
        latestTransferMs = parsed
      }
    }
    if (latestTransferMs !== null && nowMs < latestTransferMs + spacingMin * 60_000) {
      const spacingIso = new Date(latestTransferMs + spacingMin * 60_000).toISOString()
      return verdict('spacing_hold', `Spacing hold of ${spacingMin}m between uploads is active until ${spacingIso}.`, {
        earliest_start: spacingIso,
      })
    }
  }

  // All checks passed
  return verdict('ready', 'Ready for upload.', { eligible: true, earliest_start: new Date(nowMs).toISOString() })
}
