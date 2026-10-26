/**
 * The social publish job: post one finished episode to the platforms the owner
 * ticked, and prove each one landed.
 *
 * AGENTS §8 is the shape of this file. A generator that returns is not success;
 * each platform is done only when its adapter returned the platform's own post
 * id, and that receipt is on disk. Three outcomes, all loud:
 *
 *   - every ticked platform confirmed  → done, one line per platform
 *   - some confirmed, some failed      → the failures are named in the error and
 *                                        the receipts that exist stay; Retry
 *                                        posts only the missing platforms
 *   - none confirmed                   → error, and nothing is recorded as posted
 *
 * Retries never double-post. The receipt names the exact source revision, and
 * a platform whose receipt matches the file being posted is SKIPPED with a line
 * saying so. A re-rendered episode is a different file, so it is not skipped —
 * that is a new post the owner asked for, not a duplicate.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import type { Job } from '../models/types.js'
import {
  SOCIAL_PLATFORMS,
  SocialError,
  type SocialErrorCode,
  type SocialPlatform,
} from '../contracts/social-publishing.js'
import {
  readProjectSocialAccounts,
  readSocialConnectionRegistry,
  resolveSocialTargets,
  socialAccountKey,
} from '../services/social-connection-store.js'
import {
  readSocialSidecar,
  receiptFor,
  recordSocialFailure,
  recordSocialReceipt,
} from '../services/social-publish-sidecar.js'
import { resolveSocialCredentials } from '../services/social-connect.js'
import { findYouTubeSourceVideoPath, resolveYouTubeSourceRevision } from '../services/youtube-source-video.js'
import { probeForUpload } from '../lib/ffprobe-check.js'
import { resolveUploadMetadata } from '../lib/upload-metadata.js'
import { resolveEpisodePaths } from '../services/utils.js'
import * as im from '../services/idea-manager.js'
import { isCancelled } from '../services/job-queue.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { facebookAdapter, instagramAdapter } from '../lib/social-publish/meta.js'
import { tiktokAdapter } from '../lib/social-publish/tiktok.js'
import type { SocialAdapter, SocialPostInput } from '../lib/social-publish/types.js'

const ADAPTERS: Record<SocialPlatform, SocialAdapter> = {
  facebook: facebookAdapter,
  instagram: instagramAdapter,
  tiktok: tiktokAdapter,
}

export interface SocialPublishParams {
  episode_id: string
  /**
   * The platforms the owner ticked for THIS upload. Absent or empty means
   * nothing is posted — the opt-in rule, enforced here as well as in the route
   * so a queued job cannot post to something the owner did not tick.
   */
  platforms?: string[]
  /** The owner's per-platform captions. Missing platforms use the episode's YouTube text. */
  captions?: Partial<Record<SocialPlatform, { title?: string; caption?: string }>>
}

/** TikTok and Instagram have no separate title field; Facebook does. */
function requestedPlatforms(params: SocialPublishParams): SocialPlatform[] {
  const requested = Array.isArray(params.platforms) ? params.platforms : []
  return SOCIAL_PLATFORMS.filter(platform => requested.includes(platform))
}

function captionFor(input: {
  platform: SocialPlatform
  override: { title?: string; caption?: string } | undefined
  title: string
  description: string
  tags: string[]
}): { title: string; caption: string } {
  const hashtags = input.tags
    .map(tag => tag.trim().replace(/^#/, ''))
    .filter(Boolean)
    .map(tag => `#${tag.replace(/\s+/g, '')}`)
    .join(' ')
  const baseCaption = input.override?.caption?.trim() || [input.description.trim(), hashtags].filter(Boolean).join('\n\n')
  return {
    title: input.override?.title?.trim() || input.title,
    caption: baseCaption,
  }
}

export async function generateSocialPublish(job: Job): Promise<void> {
  const slug = job.project_slug
  const params = (job.params || {}) as SocialPublishParams
  const episodeCode = params.episode_id || job.episode_id
  if (!episodeCode) throw new Error('episode_id is required')

  const platforms = requestedPlatforms(params)
  if (!platforms.length) {
    throw new SocialError(400, 'SOCIAL_NOTHING_SELECTED', 'No platform was ticked, so nothing was posted.')
  }

  job.output_lines.push(`Social posting — ${episodeCode} → ${platforms.join(', ')}`)

  // Resolve the episode and the exact file FIRST: every refusal that follows
  // is about this file, and nothing should be sent before it is known.
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(entry => (entry.episode_code || '') === episodeCode)
  if (!idea) throw new Error(`Accepted idea not found for ${episodeCode}`)
  const paths = await resolveEpisodePaths(slug, episodeCode, idea.title || '')

  const videoPath = await findYouTubeSourceVideoPath(paths, slug, episodeCode, idea.title || '')
  if (!videoPath) {
    throw new Error(`No final video file found for ${episodeCode}. Render the episode first; nothing was posted.`)
  }
  const stat = await fsp.stat(videoPath)
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`${path.basename(videoPath)} is empty or unreadable. Nothing was posted.`)
  }

  const probe = await probeForUpload(videoPath)
  if (!probe.ok) {
    // `exceedsDurationLimit` is YouTube's ceiling, which is not a social limit.
    // Only a real probe failure stops here; the per-platform specs decide length.
    if (!probe.hasVideo || probe.durationSec <= 0 || probe.width <= 0) {
      throw new Error(probe.error || `ffprobe could not read ${path.basename(videoPath)}. Nothing was posted.`)
    }
  }

  const sourceRevision = await resolveYouTubeSourceRevision(videoPath)
  job.output_lines.push(`Source video: ${path.basename(videoPath)} (${(stat.size / (1024 * 1024)).toFixed(1)} MB, ${probe.width}×${probe.height}, ${Math.round(probe.durationSec)}s)`)

  const metadata = await resolveUploadMetadata({
    slug,
    episode_code: episodeCode,
    fallback_title: idea.title || '',
    platform: 'youtube',
  })

  // Which platforms can actually post. A ticked platform with no connected
  // account is refused BY NAME — a silent skip would read as "posted".
  const targets = await resolveSocialTargets(slug, platforms)
  if (targets.notConnected.length) {
    const names = targets.notConnected.join(', ')
    throw new SocialError(
      409,
      'SOCIAL_ACCOUNT_NOT_CONNECTED',
      `Connect an account for ${names} in Settings → Publishing before posting there. Nothing was posted to ${names}.`,
    )
  }

  const sidecar = await readSocialSidecar(slug, episodeCode)
  const confirmed: SocialPlatform[] = []
  const skipped: SocialPlatform[] = []
  const failed: Array<{ platform: SocialPlatform; message: string; code: SocialErrorCode }> = []

  for (const { platform, account } of targets.ready) {
    if (isCancelled(job.job_id)) throw new Error('Posting was stopped. Platforms already confirmed keep their receipts.')

    // Idempotency: this exact file is already on this platform. A retry after a
    // partial failure lands here for the platforms that succeeded.
    const existing = receiptFor(sidecar, platform, sourceRevision)
    if (existing) {
      skipped.push(platform)
      job.output_lines.push(`${platform}: already posted from this exact file (${existing.post_id}); not posting again.`)
      continue
    }

    const adapter = ADAPTERS[platform]
    const violation = adapter.specViolation({
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      sizeBytes: stat.size,
    })
    if (violation) {
      // A spec refusal is a REFUSAL, not a platform failure: the same file will
      // be refused again, and saying "retry" would be a lie.
      failed.push({ platform, message: violation, code: 'SOCIAL_VIDEO_REJECTED' })
      job.output_lines.push(`✗ ${platform}: ${violation}`)
      await recordSocialFailure(slug, episodeCode, idea.title || '', platform, { message: violation, code: 'SOCIAL_VIDEO_REJECTED' })
      continue
    }

    let credentials: Awaited<ReturnType<typeof resolveSocialCredentials>>
    try {
      credentials = await resolveSocialCredentials(platform, account)
    } catch (error) {
      const socialError = error instanceof SocialError ? error : null
      failed.push({
        platform,
        message: socialError?.detail || (error as Error)?.message || 'The saved sign-in could not be used.',
        code: socialError?.code || 'SOCIAL_RECONNECT_REQUIRED',
      })
      job.output_lines.push(`✗ ${platform}: ${failed.at(-1)!.message}`)
      await recordSocialFailure(slug, episodeCode, idea.title || '', platform, {
        message: failed.at(-1)!.message,
        code: (socialError?.code || 'SOCIAL_RECONNECT_REQUIRED') as SocialErrorCode,
      })
      continue
    }

    const text = captionFor({
      platform,
      override: params.captions?.[platform],
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
    })

    const input: SocialPostInput = {
      filePath: videoPath,
      title: text.title,
      caption: text.caption,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      sizeBytes: stat.size,
      credentials: {
        remoteId: account.remote_id,
        accessToken: credentials.accessToken,
        ...(credentials.pageToken ? { pageToken: credentials.pageToken } : {}),
        ...(credentials.pageId ? { pageId: credentials.pageId } : {}),
        ...(credentials.appId ? { appId: credentials.appId } : {}),
      },
      onProgress: (sent, total) => {
        job.progress = total > 0 ? Math.round((sent / total) * 100) : 0
        job.bytes_done = sent
        job.bytes_total = total
      },
      log: line => job.output_lines.push(`${platform}: ${line}`),
    }

    try {
      const output = await adapter.publish(input)
      if (!output.post_id) {
        throw new Error('The platform accepted the request but returned no post id, so the post cannot be proven.')
      }
      await recordSocialReceipt(slug, episodeCode, idea.title || '', {
        platform,
        account_id: account.remote_id,
        post_id: output.post_id,
        source_revision: sourceRevision,
        posted_at: new Date().toISOString(),
        ...(output.permalink ? { permalink: output.permalink } : {}),
      })
      confirmed.push(platform)
      job.output_lines.push(`✓ ${platform}: ${output.post_id}${output.permalink ? ` — ${output.permalink}` : ''}`)
    } catch (error) {
      const message = (error as Error)?.message || 'The platform refused the post.'
      const code: SocialErrorCode = (error as { code?: string })?.code === 'SOCIAL_RECONNECT_REQUIRED'
        ? 'SOCIAL_RECONNECT_REQUIRED'
        : 'SOCIAL_PLATFORM_REFUSED'
      failed.push({ platform, message, code })
      job.output_lines.push(`✗ ${platform}: ${message}`)
      await recordSocialFailure(slug, episodeCode, idea.title || '', platform, { message, code: code as SocialErrorCode })
    }
  }

  // The completion contract. "Done" means every ticked platform is either
  // confirmed by a post id or already confirmed from this exact file.
  const settled = new Set<SocialPlatform>([...confirmed, ...skipped])
  const missing = platforms.filter(platform => !settled.has(platform))
  requireJobCompletion(job, {
    label: `Posting ${episodeCode}`,
    expected: platforms.length,
    completed: settled.size,
    ...(missing.length ? { missing } : {}),
    ...(failed.length
      ? { message: `Posting ${episodeCode} incomplete: ${settled.size}/${platforms.length} platform(s) confirmed. ${failed.map(entry => `${entry.platform}: ${entry.message}`).join(' ')} Retry posts only the platforms that are missing; it will not post twice to the ones that succeeded.` }
      : {}),
    retry_hint: 'Retry posts only the platforms that are missing; it will not post twice to the ones that succeeded.',
  })
}

/**
 * The page's read: what is already posted, what failed, and what this channel
 * could post to. Never returns a token.
 */
export async function describeSocialState(slug: string, episodeCode: string): Promise<{
  accounts: Partial<Record<SocialPlatform, string>>
  receipts: Array<{ platform: SocialPlatform; post_id: string; posted_at: string; permalink?: string; source_revision: string }>
  failures: Array<{ platform: SocialPlatform; message: string; code: string; at: string }>
}> {
  const [sidecar, accounts] = await Promise.all([
    readSocialSidecar(slug, episodeCode),
    readProjectSocialAccounts(slug),
  ])
  const registry = await readSocialConnectionRegistry()
  const connected: Partial<Record<SocialPlatform, string>> = {}
  for (const platform of SOCIAL_PLATFORMS) {
    const remoteId = accounts[platform]
    if (!remoteId) continue
    const account = registry.accounts[socialAccountKey(platform, remoteId)]
    if (account?.status === 'connected') connected[platform] = account.remote_name
  }
  return {
    accounts: connected,
    receipts: sidecar.receipts.map(receipt => ({
      platform: receipt.platform,
      post_id: receipt.post_id,
      posted_at: receipt.posted_at,
      source_revision: receipt.source_revision,
      ...(receipt.permalink ? { permalink: receipt.permalink } : {}),
    })),
    failures: Object.entries(sidecar.failures ?? {}).map(([platform, failure]) => ({
      platform: platform as SocialPlatform,
      message: failure.message,
      code: failure.code,
      at: failure.at,
    })),
  }
}
