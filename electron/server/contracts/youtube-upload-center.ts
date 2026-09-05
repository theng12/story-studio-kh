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
