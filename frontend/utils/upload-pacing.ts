/**
 * Pure helpers for the Upload Center's pacing UI (Story 386 Item 1 frontend).
 *
 * This file contains shared types, constants, and pure UI presentation helpers.
 * The actual scheduling algorithm (slot calculation, eligibility checks) is
 * backend-only in `electron/server/services/upload-pacing.ts`.
 */

export const UPLOAD_PACING_TIERS = ['gentle', 'regular', 'bulk', 'custom'] as const
export type UploadPacingTier = (typeof UPLOAD_PACING_TIERS)[number]

/** Starting daily upload limits for the default tiers. Editable, not hard limits. */
export const UPLOAD_PACING_TIER_DEFAULTS: Record<'gentle' | 'regular' | 'bulk', { daily_limit: number }> = {
  gentle: { daily_limit: 3 },
  regular: { daily_limit: 6 },
  bulk: { daily_limit: 12 },
}

/** Plain tier names — the count is never written here. */
export const UPLOAD_PACING_TIER_NAMES: Record<UploadPacingTier, string> = {
  gentle: 'Gentle', regular: 'Regular', bulk: 'Bulk', custom: 'Custom',
}

/**
 * Label for a tier with its ACTUAL configured count (AGENTS §1: a limit shown is
 * the limit enforced). Nothing here restates 3/6/12 as literals.
 */
export function uploadPacingTierLabel(tier: UploadPacingTier, dailyLimit: number): string {
  return `${UPLOAD_PACING_TIER_NAMES[tier]} (up to ${dailyLimit}/day)`
}

export interface UploadTimeWindow {
  start: string
  end: string
}

export interface UploadPacingPolicy {
  tier: UploadPacingTier
  daily_limit: number
  timezone: string
  window: UploadTimeWindow
  min_spacing_minutes?: number
  weekdays?: number[]
}

export interface PacingQueueItem {
  episode_code: string
  title?: string
  earliest_upload_on?: string | null
  publish_at?: string | null
}

export interface PacedSlot {
  episode_code: string
  upload_on: string
  publish_at: string | null
  channel_day_key: string
  quota_day_key: string
  slot_index_today: number
  daily_limit: number
}

export interface PacingConflict {
  episode_code: string
  reason: string
  detail: string
  upload_on: string | null
  publish_at: string | null
  required_lead_ms?: number
  actual_gap_ms?: number | null
}

export type PacingUnconfiguredReason =
  | 'missing_window'
  | 'invalid_timezone'
  | 'invalid_daily_limit'
  | 'invalid_window_hours'
  | 'invalid_policy'

export interface PacedPlanResult {
  ok: boolean
  slots: PacedSlot[]
  conflicts: PacingConflict[]
  unconfigured_reason?: PacingUnconfiguredReason
  unconfigured_message?: string
}

export type UploadWaitReason =
  | 'ready'
  | 'waiting_for_upload_on'
  | 'invalid_upload_on'
  | 'outside_window'
  | 'daily_limit_reached'
  | 'spacing_hold'
  | 'weekday_not_allowed'
  | 'publish_deadline_conflict'
  | 'unconfigured_pacing'
  | 'quota_exhausted'

export interface UploadEligibilityVerdict {
  eligible: boolean
  reason: UploadWaitReason
  detail: string
  earliest_start: string | null
  channel_day_key: string
  quota_day_key: string
  daily_limit: number
  uploads_today: number
  remaining_today: number
  effective_spacing_minutes: number
}

/** Minimal type-safe representation of a YouTube quota bucket snapshot for UI display. */
export interface YouTubeQuotaBucketSnapshot {
  limit?: number
  used?: number
  remaining?: number
  reset_at?: string
  verified?: boolean
}

/** Minimal type-safe representation of a YouTube quota snapshot for UI display. */
export interface YouTubeQuotaSnapshot {
  application_id?: string
  tracking_day?: string
  resets_at?: string
  unknown_before?: string
  external_usage_known?: false
  external_usage_note?: string
  buckets?: Record<string, YouTubeQuotaBucketSnapshot>
}

/**
 * One entry in the persistent upload queue projection.
 * Pinned from backend projection contract: episode identity, upload time,
 * publish time, plain waiting reason, actual next eligible time, and actionability.
 */
export interface UploadQueueEntry {
  episode_code: string
  title?: string
  upload_at?: string | null
  publish_at?: string | null
  wait_reason?: UploadWaitReason | string
  wait_detail?: string
  next_eligible_at?: string | null
  is_paused?: boolean
  position?: number
  can_remove?: boolean
  can_reorder?: boolean
}

export interface UploadQueueProjection {
  queue?: UploadQueueEntry[]
  paused_count?: number
  total_count?: number
}

/**
 * Plain waiting reason label for an UploadWaitReason code.
 * If no matching human string exists, returns the raw detail or a generic waiting message.
 */
export function waitingReasonLabel(reason: UploadWaitReason | string | undefined, detail?: string): string {
  if (detail) return detail
  switch (reason) {
    case 'ready': return 'Ready to upload'
    case 'waiting_for_upload_on': return 'Waiting for upload date'
    case 'invalid_upload_on': return 'Invalid upload date'
    case 'outside_window': return 'Outside upload window'
    case 'daily_limit_reached': return 'Daily limit reached'
    case 'spacing_hold': return 'Waiting for minimum spacing'
    case 'weekday_not_allowed': return 'Day not allowed for uploads'
    case 'publish_deadline_conflict': return 'Publication deadline conflict'
    case 'unconfigured_pacing': return 'Upload pacing not configured'
    case 'quota_exhausted': return 'Quota exhausted, waiting for reset'
    default: return 'Waiting in queue'
  }
}

/**
 * Convert a channel policy to the local `datetime-local` string in the channel timezone.
 */
export function toLocalDateTimeInput(isoString: string | null | undefined, timezone?: string): string {
  if (!isoString) return ''
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return ''
    // Format as YYYY-MM-DDTHH:MM in local browser time or target timezone
    return date.toISOString().slice(0, 16)
  } catch {
    return ''
  }
}

/**
 * Build a PacingQueueItem array from selected episode codes and dates.
 */
export function buildPacingQueueItems(
  episodeCodes: string[],
  earliestUploadOn?: string | null,
  publishAt?: string | null,
  titles?: Record<string, string>,
): PacingQueueItem[] {
  return episodeCodes.map(code => ({
    episode_code: code,
    title: titles?.[code] ?? code,
    earliest_upload_on: earliestUploadOn || null,
    publish_at: publishAt || null,
  }))
}
