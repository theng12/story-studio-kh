export interface YouTubeApplicationRecord {
  application_id: string
  client_id: string
  google_cloud_project_id?: string
  fingerprint: string
  configured_at: string
  updated_at: string
}

export interface YouTubeChannelRecord {
  channel_id: string
  application_id: string
  title: string
  handle?: string
  thumbnail_url?: string
  connected_at: string
  updated_at: string
  /**
   * When Story Studio last held a fresh authorization for this channel. Optional
   * because a registry written before this field existed is valid, not corrupt.
   * `last_sync_at` is deliberately absent until Phase 3 has something to write
   * into it; an always-absent field would read as "never synchronized".
   */
  last_refresh_at?: string
  /** When the owner last completed Google consent (Connect or Reconnect). Optional: older records use `updated_at`. */
  authorized_at?: string
  /**
   * Set when Google refused this grant about 7 days after consent — the
   * signature of an OAuth app still in "Testing" publishing status, whose
   * refresh tokens expire after 7 days. Drives "Signed in until ~date".
   */
  seven_day_sign_in?: boolean
  granted_scopes: string[]
  status: 'connected' | 'reconnect_required' | 'scope_upgrade_required'
}

export interface YouTubeProjectAssignment {
  project_slug: string
  channel_id: string
  assigned_at: string
}

/** Provider channel IDs are opaque but must remain safe map keys and path segments. */
export function isValidYouTubeChannelId(value: unknown): value is string {
  return typeof value === 'string'
    && value !== '__proto__' && value !== 'constructor' && value !== 'prototype'
    && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export const YOUTUBE_VIDEO_LIFECYCLES = [
  'preparing', 'uploading', 'accepted', 'processing', 'ready',
  'failed', 'rejected', 'status_unavailable',
] as const

export type YouTubeVideoLifecycle = typeof YOUTUBE_VIDEO_LIFECYCLES[number]

/**
 * YouTube's own verdict that an accepted upload never became a video. Not
 * "we could not ask" and not "we did not see it": YouTube looked at this exact
 * video and said it failed or rejected it.
 *
 * The video id stays as history — never offered as the episode's video again,
 * and never allowed to block the ONE replacement upload the owner is entitled
 * to (Domnak DM0001–DM0003, 2026-10-19: a channel not yet verified for long
 * videos; YouTube abandoned every one of them).
 */
export const SUPERSEDED_LIFECYCLES: ReadonlySet<string> = new Set(['failed', 'rejected'])

export type YouTubeLocalRenderProjection = {
  state: 'ready' | 'missing' | 'unknown'
  video_url?: string
}

export type YouTubeLocalUploadProjection = {
  state: 'none' | 'queued' | 'running' | 'failed' | 'succeeded' | 'unknown'
  job_id?: string
  progress?: number
  bytes_done?: number
  bytes_total?: number
  speed_bps?: number
  eta_seconds?: number
  reason?: string
}

/** Production Board receipt status, independent of local media and generation readiness. */
export interface YouTubeEpisodeUploadStatus {
  state: 'pending' | 'queued' | 'uploading' | 'processing' | 'uploaded' | 'recorded' | 'failed' | 'unknown'
  video_id?: string
  url?: string
  source?: 'operation_record' | 'reconcile_link' | 'legacy_sidecar'
  visibility?: string
  scheduled_for?: string | null
  checked_at?: string
  reason?: string
}

export type YouTubePublicationProjection = {
  state: 'unpublished' | 'uploaded' | 'processing' | 'published' | 'scheduled' | 'failed' | 'rejected' | 'unknown'
  visibility?: string
  published_at?: string
  scheduled_at?: string
  last_checked_at?: string
  /**
   * The moment YouTube stopped returning this video, so the `visibility` and
   * `scheduled_at` above are the last CONFIRMED publication rather than a fresh
   * answer. Absent means both fields are current. Without it, "we do not know
   * any more" and "nothing is scheduled" read identically (AGENTS.md §6).
   */
  unverified_since?: string
  reason?: string
}

export type YouTubePlanProjection = {
  scheduled_at?: string
  timezone?: string
}

export type YouTubeEpisodePublishableProjection = {
  local: {
    render: YouTubeLocalRenderProjection
    upload: YouTubeLocalUploadProjection
  }
  publication: YouTubePublicationProjection
  plan: YouTubePlanProjection
}

/**
 * Which final-check verdict a row is showing, and which file it was measured on.
 *
 * `checked_at` is the value an upload echoes back to bind its acknowledgement to this exact check
 * (`acknowledge_final_check` + `final_check_checked_at` on the upload POST). The file's size and
 * mtime are read-only context: the verdict is bound to those bytes, and a rewritten file makes it
 * stale rather than silently describing the new ones.
 */
export type YouTubeFinalCheckIdentity = {
  /** When the check ran — the stored verdict's own `checked_at`. */
  checked_at: string
  /** The finished file's size when it was checked. */
  file_size: number
  /** The finished file's mtime (ms) when it was checked. */
  file_mtime_ms: number
}

/** The final-check verdict stored beside an episode's finished video, as the rows report it. */
export type YouTubeFinalCheckProjection = {
  /** The row's one line: "Final check: passed", or the first thing that is wrong with it. */
  summary: string
  passed: boolean
  /** False when no verdict has been stored for this file yet. */
  checked: boolean
  /** True when the file has been rewritten since the check ran. */
  stale: boolean
  issues: Array<{ check: string; verdict: string }>
  /** Null when no verdict has been stored — "not checked" and "checked" are different answers. */
  identity: YouTubeFinalCheckIdentity | null
}

export const YOUTUBE_FOUNDATION_ERROR_CODES = [
  'YOUTUBE_APPLICATION_NOT_CONFIGURED',
  'YOUTUBE_APPLICATION_CHANGED',
  'YOUTUBE_CHANNEL_NOT_CONNECTED',
  'YOUTUBE_CHANNEL_NOT_ASSIGNED',
  'YOUTUBE_CHANNEL_ALREADY_ASSIGNED',
  'YOUTUBE_ASSIGNMENT_CHANGED',
  'YOUTUBE_CHANNEL_MISMATCH',
  'YOUTUBE_VIDEO_ID_CONFLICT',
  'YOUTUBE_RECORD_REVISION_CONFLICT',
  'YOUTUBE_QUOTA_EXHAUSTED',
  'YOUTUBE_LEDGER_UNREADABLE',
  'YOUTUBE_ALREADY_PUBLISHED',
  'YOUTUBE_OPERATION_NOT_FOUND',
  'YOUTUBE_OPERATION_RECORD_CORRUPT',
  'YOUTUBE_SECRET_STORAGE_UNAVAILABLE',
  'YOUTUBE_SECRET_RECOVERY_REQUIRED',
  'YOUTUBE_OAUTH_PROVIDER_REJECTED',
  'YOUTUBE_OAUTH_UNAVAILABLE',
  'YOUTUBE_OAUTH_STATE_MISMATCH',
  'YOUTUBE_OAUTH_REDIRECT_MISMATCH',
  'YOUTUBE_OAUTH_TIMEOUT',
  'YOUTUBE_OAUTH_CANCELLED',
  'YOUTUBE_OAUTH_FLOW_UNKNOWN',
  /** YouTube could not be asked; distinct from any answer it gave. */
  'YOUTUBE_STATUS_UNCHECKED',
] as const

export type YouTubeFoundationErrorCode = typeof YOUTUBE_FOUNDATION_ERROR_CODES[number]

export interface YouTubePublicError {
  code: YouTubeFoundationErrorCode
  detail: string
}

export class YouTubeFoundationError extends Error {
  readonly statusCode: number
  readonly code: YouTubeFoundationErrorCode
  readonly detail: string
  readonly expose = true

  constructor(status: number, code: YouTubeFoundationErrorCode, detail: string) {
    super(detail)
    this.name = 'YouTubeFoundationError'
    this.statusCode = status
    this.code = code
    this.detail = detail
  }

  toPublic(): YouTubePublicError {
    return { code: this.code, detail: this.detail }
  }
}
