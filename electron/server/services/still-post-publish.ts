/**
 * Publish one rendered Still Post to a social platform.
 *
 * The smallest complete path, and only the one the official APIs allow from
 * this Mac:
 *
 *   Facebook Page photo  POST /{page-id}/photos with the image bytes as
 *                        multipart `source`. A local file is enough.
 *   Instagram            needs a PUBLIC image URL. Story Studio has no public
 *                        hosting and must not gain one for this, so Instagram
 *                        is refused in plain words instead of half-wired.
 *
 * Off by default: the channel's own `social_platforms` list is the deliberate
 * switch, and an empty list posts nothing. Every attempt leaves a receipt
 * beside the post, keyed by the exact file's SHA-256, so a retry of the same
 * image never posts twice and a re-rendered image is a new post.
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  PLATFORM_LABELS,
  SocialError,
  type SocialPlatform,
} from '../contracts/social-publishing.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import {
  facebookPhotoSpecViolation,
  publishFacebookPhoto,
} from '../lib/social-publish/meta.js'
import { resolveSocialCredentials } from './social-connect.js'
import {
  readProjectSocialOptIn,
  resolveSocialTargets,
} from './social-connection-store.js'
import {
  finalFilename,
  postDir,
  postsDir,
  postStateFor,
  readPost,
  validatePostId,
} from './still-posts.js'

export type StillPostPublishPlatform = 'facebook' | 'instagram'

export interface StillPostPublishReceipt {
  post_id: string
  permalink?: string
  file: string
  file_sha256: string
  posted_at: string
}

export interface StillPostPublishRecord {
  facebook?: StillPostPublishReceipt
  instagram?: StillPostPublishReceipt
  /** The last refusal for each platform, kept so a reload still explains it. */
  last_failure?: Partial<Record<StillPostPublishPlatform, { message: string, at: string }>>
}

function publishPath(slug: string, postId: string): string {
  return path.join(postDir(slug, postId), 'publish.json')
}

async function readRecord(slug: string, postId: string): Promise<StillPostPublishRecord> {
  let raw: string
  try {
    raw = await fsp.readFile(publishPath(slug, postId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    throw error
  }
  try {
    return JSON.parse(raw) as StillPostPublishRecord
  } catch {
    // "Never posted" and "cannot tell" must not read the same: a corrupt receipt
    // could hide a real post, and posting again would double it.
    throw new Error(
      `The posting record for ${postId} could not be read, so Story Studio cannot tell whether this image was already posted. `
        + `Move or repair ${publishPath(slug, postId)} before posting.`,
    )
  }
}

/** Every post's receipts, for the workspace so a reload still says what was posted. */
export async function readStillPostPublishes(slug: string): Promise<Record<string, StillPostPublishRecord>> {
  const root = postsDir(slug)
  let entries: string[] = []
  try { entries = await fsp.readdir(root) } catch { return {} }
  const out: Record<string, StillPostPublishRecord> = {}
  for (const entry of entries) {
    if (!entry.startsWith('post-')) continue
    const record = await readRecord(slug, entry)
    if (Object.keys(record).length) out[entry] = record
  }
  return out
}

function requirePlatform(value: unknown): StillPostPublishPlatform {
  if (value === 'facebook' || value === 'instagram') return value
  throw new SocialError(400, 'SOCIAL_PLATFORM_UNAVAILABLE', 'Choose Facebook or Instagram to post this image.')
}

/**
 * Post one rendered Still Post, or refuse in words that say why.
 *
 * `already: true` means this exact image is already on the platform; nothing
 * was sent, and the receipt that proves it is returned.
 */
export async function publishStillPost(
  slug: string,
  postId: string,
  platformValue: unknown,
): Promise<{ platform: StillPostPublishPlatform, already: boolean, receipt: StillPostPublishReceipt }> {
  const platform = requirePlatform(platformValue)
  const post = await readPost(slug, validatePostId(postId))
  if (!post) throw new SocialError(404, 'SOCIAL_PLATFORM_UNAVAILABLE', 'That post no longer exists. Nothing was posted.')

  const optedIn = await readProjectSocialOptIn(slug)
  if (!optedIn.includes(platform as SocialPlatform)) {
    throw new SocialError(
      403,
      'SOCIAL_POST_NOT_ENABLED',
      `${PLATFORM_LABELS[platform]} posting is not turned on for this channel. Turn it on in Settings → Publishing; nothing was posted.`,
    )
  }

  if (platform === 'instagram') {
    // Not a missing setting the owner can fix here: Instagram's content
    // publishing API reads images from a public URL, and Story Studio is a
    // local app with no public image host.
    throw new SocialError(
      409,
      'SOCIAL_IMAGE_URL_REQUIRED',
      'Instagram accepts an image only from a public web address, and Story Studio has no public image hosting. '
        + 'Nothing was posted. Post this image by hand, or configure a public image host for this channel.',
    )
  }

  const aspect = post.aspects[0] || '1:1'
  const file = finalFilename(0, aspect)
  const filePath = path.join(postDir(slug, post.id), file)
  const state = await postStateFor(slug, post)
  if (state.panels[0]?.finals?.[aspect] !== 'ok') {
    throw new SocialError(
      409,
      'SOCIAL_IMAGE_NOT_RENDERED',
      `The ${aspect} image is not rendered (or its words changed). Render it first; nothing was posted.`,
    )
  }
  const bytes = await fsp.readFile(filePath)
  const violation = facebookPhotoSpecViolation({ sizeBytes: bytes.byteLength })
  if (violation) {
    throw new SocialError(400, 'SOCIAL_IMAGE_REJECTED', `${violation} Nothing was posted.`)
  }
  const fileSha = createHash('sha256').update(bytes).digest('hex')

  const record = await readRecord(slug, post.id)
  const existing = record.facebook
  if (existing && existing.file_sha256 === fileSha) {
    return { platform, already: true, receipt: existing }
  }

  const targets = await resolveSocialTargets(slug, [platform])
  if (targets.notConnected.length) {
    throw new SocialError(
      409,
      'SOCIAL_ACCOUNT_NOT_CONNECTED',
      `Connect a Facebook Page in Settings → Publishing before posting there. Nothing was posted.`,
    )
  }
  const account = targets.ready[0]!.account
  const resolved = await resolveSocialCredentials(platform, account)
  const credentials = { ...resolved, remoteId: account.remote_id }

  try {
    const posted = await publishFacebookPhoto({
      filePath,
      title: '',
      caption: post.caption.trim(),
      durationSec: 0,
      width: 0,
      height: 0,
      sizeBytes: bytes.byteLength,
      credentials,
      log: line => console.log(`[still-post-publish] ${post.id}: ${line}`),
    })
    const receipt: StillPostPublishReceipt = {
      post_id: posted.post_id,
      ...(posted.permalink ? { permalink: posted.permalink } : {}),
      file,
      file_sha256: fileSha,
      posted_at: new Date().toISOString(),
    }
    await writeJsonAtomic(publishPath(slug, post.id), {
      ...record,
      facebook: receipt,
      last_failure: Object.fromEntries(
        Object.entries(record.last_failure ?? {}).filter(([key]) => key !== 'facebook'),
      ),
    })
    return { platform, already: false, receipt }
  } catch (error) {
    const message = (error as Error)?.message || 'Facebook did not accept the image.'
    await writeJsonAtomic(publishPath(slug, post.id), {
      ...record,
      last_failure: { ...(record.last_failure ?? {}), [platform]: { message, at: new Date().toISOString() } },
    }).catch(() => {})
    throw new SocialError(502, 'SOCIAL_PLATFORM_REFUSED', `${message} Nothing was recorded as posted.`)
  }
}
