/**
 * The one door every Facebook, Instagram and TikTok request goes through.
 *
 * Same reason as `youtube-client.ts`: a test must be able to hand this file a
 * fake transport and nothing else. No product code calls the global `fetch`,
 * so no test can reach a real platform by accident — which is the rule for
 * this feature: the owner has no accounts yet, and nothing here may make a
 * real network call from a test run.
 */

let socialFetch: typeof fetch = (...args) => globalThis.fetch(...args)

/** Sibling adapters make their own requests through this binding. */
export const socialTransport: typeof fetch = (...args) => socialFetch(...args)

export function __setSocialTransportForTests(transport: typeof fetch): void {
  socialFetch = transport
}

export function __resetSocialTransportForTests(): void {
  socialFetch = (...args) => globalThis.fetch(...args)
}

/** What every adapter needs to publish one finished file. */
export interface SocialPostInput {
  filePath: string
  /** The platform's own title field, where it has one. */
  title: string
  /** Description and hashtags, as the owner edited them for this platform. */
  caption: string
  /** Measured by the job with ffprobe before any request is made. */
  durationSec: number
  width: number
  height: number
  sizeBytes: number
  credentials: SocialCredentials
  onProgress?: (bytesSent: number, totalBytes: number) => void
  signal?: AbortSignal
  log: (line: string) => void
}

export interface SocialCredentials {
  /** The account's own platform identity: a Facebook Page id, an IG professional account id, a TikTok open_id. */
  remoteId: string
  /** The user access token. TikTok posts with this one. */
  accessToken: string
  /** Facebook / Instagram: the Page token that authorizes the post. */
  pageToken?: string
  /** Facebook / Instagram: the Page the post appears on. */
  pageId?: string
  /** Facebook: the Meta app id, required to open a resumable upload session. */
  appId?: string
}

export interface SocialPostOutput {
  /** The platform's own identity for the post. This is the proof of success. */
  post_id: string
  /** A public address for the post, when the platform returns one. Display only. */
  permalink?: string
}

/**
 * A refusal that is about the FILE, not about the request. Raised before any
 * byte is sent so the owner is never told "Facebook failed" when the answer is
 * "this video is 16:9 and Reels needs 9:16".
 */
export class SocialSpecError extends Error {
  constructor(message: string) { super(message) }
}

/** The smallest honest shape a refusal needs. */
export interface SocialAdapter {
  /** What this platform will accept, checked against measured facts. Null = acceptable. */
  specViolation(input: Pick<SocialPostInput, 'durationSec' | 'width' | 'height' | 'sizeBytes'>): string | null
  publish(input: SocialPostInput): Promise<SocialPostOutput>
}
