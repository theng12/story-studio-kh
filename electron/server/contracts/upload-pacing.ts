/**
 * Upload pacing contracts and pure wire types (Story 386 Item 1).
 *
 * Configurable upload pacing operating rules for channels:
 * - Starting tiers: Gentle (up to 3/day), Regular (up to 6/day), Bulk (up to 12/day).
 *   These are editable starting counts, NOT hardcoded limits. No auto-promotion.
 * - Window hours MUST be an explicit channel choice: no hidden 08:00–22:00 or
 *   180-minute spacing defaults are assumed. Missing window requires an honest
 *   configuration reason.
 * - Channel-local pacing day is distinct from the YouTube API quota day (which resets at
 *   midnight PT / America/Los_Angeles).
 * - "Upload on" is the earliest allowed transfer start.
 * - "Publish on" is the YouTube future public time (private-until-publishAt).
 * - Publish lead time (default 6 hours from YOUTUBE_PUBLISH_LEAD_TIME_MS) is enforced:
 *   upload_on + lead_time must not exceed publish_at.
 *
 * PURE TYPES AND VALIDATORS ONLY. This file has zero Node.js dependencies so it
 * can be safely imported by frontend code or backend services without pulling in
 * server-only modules.
 */

export const UPLOAD_PACING_TIERS = ['gentle', 'regular', 'bulk', 'custom'] as const
export type UploadPacingTier = (typeof UPLOAD_PACING_TIERS)[number]

/** Starting daily upload limits for the default tiers. Editable, not hard limits. */
export const UPLOAD_PACING_TIER_DEFAULTS: Record<'gentle' | 'regular' | 'bulk', { daily_limit: number }> = {
  gentle: { daily_limit: 3 },
  regular: { daily_limit: 6 },
  bulk: { daily_limit: 12 },
}

export const UPLOAD_PACING_TIER_LABELS: Record<UploadPacingTier, string> = {
  gentle: 'Gentle (up to 3/day)',
  regular: 'Regular (up to 6/day)',
  bulk: 'Bulk (up to 12/day)',
  custom: 'Custom',
}

/**
 * Standard YouTube publish lead time: a private upload must be complete at least
 * 6 hours before its scheduled public release, or YouTube would publish immediately
 * upon upload if the publish date passes during upload.
 */
export const DEFAULT_PUBLISH_LEAD_TIME_MS = 6 * 60 * 60 * 1000
export const DEFAULT_PUBLISH_LEAD_TIME_TEXT = '6 hours'

/**
 * Explicit daily upload time window (in the channel's local timezone).
 * Must be chosen explicitly per channel. No silent default window is invented.
 */
export interface UploadTimeWindow {
  /** "HH:MM" 24-hour time when uploads may begin. */
  start: string
  /** "HH:MM" 24-hour time when uploads must stop starting. Must be after start. */
  end: string
}

/**
 * Channel upload pacing policy.
 */
export interface UploadPacingPolicy {
  /** Starting tier or custom tier. */
  tier: UploadPacingTier
  /** Maximum number of uploads permitted per channel-local day. Positive integer. */
  daily_limit: number
  /** IANA timezone for calculating the channel-local pacing day and window hours. */
  timezone: string
  /** Explicit upload window hours. MUST be provided; missing window is an honest unconfigured state. */
  window: UploadTimeWindow
  /** Optional minimum spacing in minutes between consecutive upload starts. */
  min_spacing_minutes?: number
  /** Allowed days of week (0=Sunday ... 6=Saturday). If omitted or empty, all 7 days are allowed. */
  weekdays?: number[]
}

/**
 * Recorded transfer event (completed or currently in progress).
 * Used to calculate remaining allowance for a channel-local day.
 */
export interface RecordedTransfer {
  episode_code?: string
  started_at: string
  completed_at?: string | null
  status?: 'queued' | 'in_progress' | 'completed' | 'failed' | 'aborted' | string
}

/**
 * An item in the queue needing a paced upload slot.
 */
export interface PacingQueueItem {
  episode_code: string
  /** Earliest upload time requested by user or pipeline (ISO 8601). Cannot be scheduled earlier. */
  earliest_upload_on?: string | null
  /** Planned public YouTube publishAt time (ISO 8601). */
  publish_at?: string | null
}

/**
 * A calculated future upload slot.
 */
export interface PacedSlot {
  episode_code: string
  /** The calculated earliest allowed upload start instant (ISO 8601 UTC). */
  upload_on: string
  /** The planned public YouTube publish time (ISO 8601 UTC), or null if private with no schedule. */
  publish_at: string | null
  /** The channel-local pacing day (YYYY-MM-DD) in the channel's timezone. */
  channel_day_key: string
  /** The API quota day (YYYY-MM-DD in America/Los_Angeles by default). */
  quota_day_key: string
  /** 1-based index among uploads for this channel on that channel-local day. */
  slot_index_today: number
  /** The effective daily limit for the channel on that day. */
  daily_limit: number
}

/**
 * A detected scheduling conflict (e.g. publication deadline cannot be met).
 */
export interface PacingConflict {
  episode_code: string
  reason:
    | 'cannot_meet_publish_deadline'
    | 'publish_at_in_past'
    | 'publish_at_too_soon'
    | 'invalid_publish_at'
    | 'invalid_upload_on'
  detail: string
  upload_on: string | null
  publish_at: string | null
  required_lead_ms: number
  actual_gap_ms: number | null
}

/**
 * Unconfigured reasons when upload pacing policy cannot compute slots.
 */
export type PacingUnconfiguredReason =
  | 'missing_window'
  | 'invalid_timezone'
  | 'invalid_daily_limit'
  | 'invalid_window_hours'
  | 'invalid_policy'

/**
 * Result of calculating future paced upload slots for a batch of items.
 */
export interface PacedPlanResult {
  ok: boolean
  slots: PacedSlot[]
  conflicts: PacingConflict[]
  unconfigured_reason?: PacingUnconfiguredReason
  unconfigured_message?: string
}

/**
 * Reasons why an upload may be waiting.
 */
export type UploadWaitReason =
  | 'ready'
  | 'waiting_for_upload_on'
  | 'outside_window'
  | 'daily_limit_reached'
  | 'spacing_hold'
  | 'weekday_not_allowed'
  | 'publish_deadline_conflict'
  | 'unconfigured_pacing'
  | 'quota_exhausted'

/**
 * The evaluation of whether an upload is eligible to start right now.
 */
export interface UploadEligibilityVerdict {
  eligible: boolean
  reason: UploadWaitReason
  detail: string
  /** The next time this item will become eligible to upload (ISO 8601), or null if blocked/conflict. */
  earliest_start: string | null
  channel_day_key: string
  quota_day_key: string
  daily_limit: number
  uploads_today: number
  remaining_today: number
}

/**
 * Context provided when checking upload eligibility.
 */
export interface UploadEligibilityContext {
  now?: Date | number | string
  recorded_transfers?: readonly RecordedTransfer[]
  planned_upload_on?: string | null
  publish_at?: string | null
  publish_lead_ms?: number
  quota_exhausted?: boolean
  quota_reset_at?: string | null
  quota_timezone?: string
}

/**
 * Check whether a timezone string is recognized by Intl.DateTimeFormat.
 */
export function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Convert a 24-hour "HH:MM" string to minutes from midnight (0..1439).
 * Returns null if the format is invalid.
 */
export function hhmmToMinutes(hhmm: unknown): number | null {
  if (typeof hhmm !== 'string') return null
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Convert minutes from midnight to a 24-hour "HH:MM" string.
 */
export function minutesToHhmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.floor(minutes)))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Return the span in minutes between window start and window end.
 * Returns 0 if invalid or end <= start.
 */
export function windowDurationMinutes(window: UploadTimeWindow): number {
  const start = hhmmToMinutes(window.start)
  const end = hhmmToMinutes(window.end)
  if (start === null || end === null || end <= start) return 0
  return end - start
}

export type ValidateWindowResult =
  | { ok: true; window: UploadTimeWindow }
  | { ok: false; reason: 'missing_window' | 'invalid_format' | 'start_after_end'; message: string }

/**
 * Validate an upload window object. Requires explicit start and end strings in HH:MM format.
 * Missing window returns an honest configuration reason; does NOT invent 08:00–22:00.
 */
export function validateUploadTimeWindow(window: unknown): ValidateWindowResult {
  if (window === undefined || window === null) {
    return {
      ok: false,
      reason: 'missing_window',
      message: 'Channel upload window hours must be chosen explicitly; no default window is assumed.',
    }
  }
  if (typeof window !== 'object' || Array.isArray(window)) {
    return {
      ok: false,
      reason: 'invalid_format',
      message: 'Upload window must be an object with start and end "HH:MM" strings.',
    }
  }
  const w = window as Record<string, unknown>
  const startMinutes = hhmmToMinutes(w.start)
  const endMinutes = hhmmToMinutes(w.end)
  if (startMinutes === null || endMinutes === null) {
    return {
      ok: false,
      reason: 'invalid_format',
      message: 'Upload window start and end must be valid 24-hour "HH:MM" times.',
    }
  }
  if (endMinutes <= startMinutes) {
    return {
      ok: false,
      reason: 'start_after_end',
      message: `Upload window end (${String(w.end)}) must be after start (${String(w.start)}).`,
    }
  }
  return {
    ok: true,
    window: { start: (w.start as string).trim(), end: (w.end as string).trim() },
  }
}

export type ValidatePolicyResult =
  | { ok: true; policy: UploadPacingPolicy }
  | { ok: false; reason: PacingUnconfiguredReason; message: string }

/**
 * Validate a channel upload pacing policy.
 * All constraints fail loudly with descriptive errors.
 */
export function validateUploadPacingPolicy(policy: unknown): ValidatePolicyResult {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { ok: false, reason: 'invalid_policy', message: 'Upload pacing policy must be an object.' }
  }
  const p = policy as Record<string, unknown>

  // Tier check
  const tier = p.tier
  if (typeof tier !== 'string' || !UPLOAD_PACING_TIERS.includes(tier as UploadPacingTier)) {
    return {
      ok: false,
      reason: 'invalid_policy',
      message: `Invalid tier: "${String(tier)}". Must be one of: ${UPLOAD_PACING_TIERS.join(', ')}.`,
    }
  }

  // Daily limit check
  const limit = Number(p.daily_limit)
  if (!Number.isInteger(limit) || limit < 1) {
    return {
      ok: false,
      reason: 'invalid_daily_limit',
      message: `daily_limit must be a positive integer, got ${String(p.daily_limit)}.`,
    }
  }

  // Timezone check
  if (!isValidIanaTimezone(p.timezone)) {
    return {
      ok: false,
      reason: 'invalid_timezone',
      message: `timezone must be a valid IANA timezone name, got "${String(p.timezone)}".`,
    }
  }

  // Window check
  const windowValidation = validateUploadTimeWindow(p.window)
  if (!windowValidation.ok) {
    return {
      ok: false,
      reason: windowValidation.reason === 'missing_window' ? 'missing_window' : 'invalid_window_hours',
      message: windowValidation.message,
    }
  }

  // Spacing check (optional)
  if (p.min_spacing_minutes !== undefined && p.min_spacing_minutes !== null) {
    const spacing = Number(p.min_spacing_minutes)
    if (!Number.isFinite(spacing) || spacing < 0) {
      return {
        ok: false,
        reason: 'invalid_policy',
        message: `min_spacing_minutes must be a non-negative number, got ${String(p.min_spacing_minutes)}.`,
      }
    }
  }

  // Weekdays check (optional)
  if (p.weekdays !== undefined && p.weekdays !== null) {
    if (!Array.isArray(p.weekdays) || !p.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return {
        ok: false,
        reason: 'invalid_policy',
        message: 'weekdays must be an array of integers from 0 (Sunday) to 6 (Saturday).',
      }
    }
  }

  return {
    ok: true,
    policy: {
      tier: tier as UploadPacingTier,
      daily_limit: limit,
      timezone: p.timezone as string,
      window: windowValidation.window,
      ...(p.min_spacing_minutes !== undefined ? { min_spacing_minutes: Number(p.min_spacing_minutes) } : {}),
      ...(Array.isArray(p.weekdays) ? { weekdays: [...p.weekdays] } : {}),
    },
  }
}
