/**
 * Publishing one finished episode to Facebook, Instagram and TikTok.
 *
 * Owner decision 2026-10-27: strictly OPT-IN. A channel chooses which platforms
 * it posts to; every upload shows those choices ticked and posts to nothing the
 * owner did not tick. The owner has no accounts yet, so the whole feature must
 * work the day one is connected and must do nothing until then.
 *
 * What is shared and what is not:
 *   - One registry (`social-connection-store.ts`) holds the OAuth applications
 *     and the connected accounts, exactly as the YouTube registry does.
 *   - Credentials live in the same encrypted `app-secrets.json` bucket scheme,
 *     under `social` instead of `youtube`, and are registered for redaction.
 *   - Each platform speaks its own protocol, so each has one adapter in
 *     `lib/social-publish/`. Everything above them — the job, the receipts, the
 *     idempotency rule, the opt-in gate — is written once.
 */

export const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'tiktok'] as const
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number]

/** Which OAuth application serves a platform. Instagram publishes through the Meta app. */
export const SOCIAL_OAUTH_PROVIDERS = ['meta', 'tiktok'] as const
export type SocialOAuthProvider = typeof SOCIAL_OAUTH_PROVIDERS[number]

export const PLATFORM_PROVIDER: Record<SocialPlatform, SocialOAuthProvider> = {
  facebook: 'meta',
  instagram: 'meta',
  tiktok: 'tiktok',
}

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
}

/**
 * The closed set of public failures. Each one is a sentence the owner can act
 * on; none of them carries a provider token, a raw provider body, or a URL that
 * grants further writes.
 */
export type SocialErrorCode =
  | 'SOCIAL_APPLICATION_NOT_CONFIGURED'
  | 'SOCIAL_ACCOUNT_NOT_CONNECTED'
  | 'SOCIAL_RECONNECT_REQUIRED'
  | 'SOCIAL_OAUTH_REJECTED'
  | 'SOCIAL_OAUTH_TIMEOUT'
  | 'SOCIAL_OAUTH_UNAVAILABLE'
  | 'SOCIAL_OAUTH_STATE_MISMATCH'
  | 'SOCIAL_PLATFORM_REFUSED'
  | 'SOCIAL_PLATFORM_UNAVAILABLE'
  | 'SOCIAL_VIDEO_REJECTED'
  | 'SOCIAL_IMAGE_REJECTED'
  | 'SOCIAL_POST_NOT_ENABLED'
  | 'SOCIAL_IMAGE_NOT_RENDERED'
  | 'SOCIAL_IMAGE_URL_REQUIRED'
  | 'SOCIAL_NOTHING_SELECTED'
  | 'SOCIAL_SECRET_RECOVERY_REQUIRED'
  | 'SOCIAL_CONNECTION_REGISTRY_CORRUPT'

export class SocialError extends Error {
  readonly code: SocialErrorCode
  readonly statusCode: number
  readonly detail: string
  constructor(statusCode: number, code: SocialErrorCode, detail: string) {
    super(detail)
    this.code = code
    this.statusCode = statusCode
    this.detail = detail
  }
  toPublic(): { code: SocialErrorCode; detail: string } {
    return { code: this.code, detail: this.detail }
  }
}

/** A connected account, as the registry stores it. No token ever reaches this shape. */
export interface SocialAccountRecord {
  platform: SocialPlatform
  provider: SocialOAuthProvider
  application_id: string
  /** The platform's own identity: a Facebook Page id, an IG professional account id, a TikTok open_id. */
  remote_id: string
  /** The display name the platform publishes for this account. */
  remote_name: string
  /**
   * Facebook: the Page this account posts as. Instagram: the Page that owns the
   * professional account, which is what Meta's token exchange returns.
   * TikTok: absent.
   */
  page_id?: string
  connected_at: string
  updated_at: string
  status: 'connected' | 'reconnect_required'
}

export interface SocialApplicationRecord {
  provider: SocialOAuthProvider
  application_id: string
  /** Public client identifier. Never the secret. */
  client_id: string
  /**
   * The exact redirect URI registered with the provider. Meta requires an exact
   * match, and TikTok accepts a wildcard port, so this is configuration rather
   * than something the loopback server may choose for itself.
   */
  redirect_uri: string
  configured_at: string
  updated_at: string
}

/** One platform's result for one episode. Written only after the platform confirmed it. */
export interface SocialPostReceipt {
  platform: SocialPlatform
  account_id: string
  /** The platform's own post identity: a Facebook video id, an IG media id, a TikTok publish_id. */
  post_id: string
  /** The exact local source the post was made from, so a retry cannot post a different file. */
  source_revision: string
  posted_at: string
  /** The public URL when the platform returns one. Display only. */
  permalink?: string
}

export interface SocialPublishSidecar {
  schema_version: 1
  episode_code: string
  receipts: SocialPostReceipt[]
  /** Last failure per platform, so the page can say why without re-running anything. */
  failures?: Partial<Record<SocialPlatform, { message: string; code: SocialErrorCode; at: string }>>
}

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(value)
}

export function isSocialOAuthProvider(value: unknown): value is SocialOAuthProvider {
  return typeof value === 'string' && (SOCIAL_OAUTH_PROVIDERS as readonly string[]).includes(value)
}

/** Account ids are opaque but must stay safe as map keys and path segments. */
export function isValidSocialAccountId(value: unknown): value is string {
  return typeof value === 'string'
    && value !== '__proto__' && value !== 'constructor' && value !== 'prototype'
    && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}
