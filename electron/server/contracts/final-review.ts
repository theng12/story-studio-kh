/**
 * Final-video review marks — the wire shape shared by the Review page, the
 * Production Board and Video Assembly (owner, 2026-10-29).
 *
 * A mark says what the owner thought of ONE exact file. It is a review note
 * only: it authorises nothing (not upload, not scheduling, not publishing),
 * and no generator, pipeline step or gate reads it.
 *
 * "Not reviewed" and "could not read the mark" are different answers and stay
 * different values here (AGENTS.md §6).
 */

export type FinalReviewDecision = 'approved' | 'needs_changes' | 'auto_passed'

/**
 * What the mark was made against. `version` is the identity's own version: if
 * the fields below ever change meaning, a version-1 record reads `unreadable`
 * instead of being compared with fields that no longer mean the same thing.
 */
export interface FinalReviewFileIdentity {
  version: 1
  /** Absolute path of the final the mark belongs to. */
  path: string
  size: number
  mtime_ms: number
  ino: number
  /** `sha256:<hex>` of the bytes when the mark was made. */
  sha256: string
}

/** What the file looks like now. `null` on a stale mark means it is gone. */
export interface FinalReviewFileNow {
  path: string
  size: number
  mtime_ms: number
  ino: number
}

export type FinalReviewState =
  | { state: 'not_reviewed' }
  | { state: 'current'; decision: FinalReviewDecision; decided_at: string; identity: FinalReviewFileIdentity }
  | { state: 'stale'; decision: FinalReviewDecision; decided_at: string; recorded: FinalReviewFileIdentity; current: FinalReviewFileNow | null }
  | { state: 'unreadable'; error: string }

export interface FinalReviewItem {
  channel_slug: string
  channel_name: string
  episode_code: string
  title: string
  /** The authenticated, range-streaming final-video route (no key, no bearer). */
  stream_url: string
  size: number
  mtime_ms: number
  /**
   * Inode of the final when it was listed. The POST echoes it back so an atomic
   * replacement that keeps the same size and modified time is still refused
   * (see `writeFinalReview`), not just an in-place rewrite.
   */
  ino: number
  /** Whether review is enabled for this item's channel at list time. */
  review_enabled: boolean
  review: FinalReviewState
  /**
   * Set when auto-pass could not save its mark for this final. The item stays
   * `not_reviewed` — never a fake auto-pass — and says plainly why.
   */
  auto_pass_error?: string
}

export interface FinalReviewChannel {
  slug: string
  name: string
  /** Off unless the channel turned review on. Off writes and shows nothing. */
  review_enabled: boolean
  /** Off unless the channel turned auto-pass on. Off auto-marks nothing. */
  auto_pass_enabled: boolean
  /** Finals listed for this channel (0 when review is off). */
  final_count: number
  /** Number of finals that have been auto-passed. */
  auto_pass_count?: number
  /** Present only when part of this channel could not be read. */
  error?: string
}

export interface FinalReviewListResponse {
  channels: FinalReviewChannel[]
  /** Every listed final, newest first, across the review-enabled channels. */
  finals: FinalReviewItem[]
  generated_at: string
}
