/**
 * Per-episode, per-platform post receipts.
 *
 * `{episode_dir}/social_publish.json`, one file per episode, one receipt per
 * platform. The receipt is the ONLY proof a post exists: it is written after
 * the platform confirmed a post id, under the same lock the job reads it
 * through, so a retry sees it before it sends anything.
 *
 * Two rules the shape enforces:
 *   - A receipt names the exact source revision it was made from. A retry of a
 *     DIFFERENT file is a different post, not a duplicate, and it says so.
 *   - A failure is recorded beside the receipts, never instead of them, so a
 *     later platform failing cannot erase an earlier platform's proof.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import {
  SOCIAL_PLATFORMS,
  isSocialPlatform,
  type SocialPlatform,
  type SocialPostReceipt,
  type SocialPublishSidecar,
  type SocialErrorCode,
} from '../contracts/social-publishing.js'
import { resolveEpisodePaths, resolveEpisodePathsByCodeWithSidecar } from './utils.js'

const SIDECAR_NAME = 'social_publish.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function decodeReceipt(value: unknown): SocialPostReceipt | null {
  if (!isRecord(value)) return null
  const platform = value.platform
  if (!isSocialPlatform(platform)) return null
  for (const field of ['account_id', 'post_id', 'source_revision', 'posted_at'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) return null
  }
  const receipt: SocialPostReceipt = {
    platform,
    account_id: value.account_id as string,
    post_id: value.post_id as string,
    source_revision: value.source_revision as string,
    posted_at: value.posted_at as string,
  }
  if (typeof value.permalink === 'string' && value.permalink) receipt.permalink = value.permalink
  return receipt
}

function decodeSidecar(value: unknown, episodeCode: string): SocialPublishSidecar {
  if (!isRecord(value) || value.schema_version !== 1) {
    return { schema_version: 1, episode_code: episodeCode, receipts: [] }
  }
  const receipts = Array.isArray(value.receipts)
    ? value.receipts.map(decodeReceipt).filter((receipt): receipt is SocialPostReceipt => receipt !== null)
    : []
  const failures: SocialPublishSidecar['failures'] = {}
  if (isRecord(value.failures)) {
    for (const platform of SOCIAL_PLATFORMS) {
      const entry = value.failures[platform]
      if (!isRecord(entry)) continue
      if (typeof entry.message !== 'string' || !entry.message) continue
      if (typeof entry.code !== 'string' || !entry.code) continue
      if (typeof entry.at !== 'string' || !entry.at) continue
      failures[platform] = { message: entry.message, code: entry.code as SocialErrorCode, at: entry.at }
    }
  }
  return {
    schema_version: 1,
    episode_code: typeof value.episode_code === 'string' && value.episode_code ? value.episode_code : episodeCode,
    receipts,
    ...(Object.keys(failures).length ? { failures } : {}),
  }
}

/**
 * Read the receipts for one episode.
 *
 * Code-based resolution, not title-based, for the same reason the YouTube
 * sidecar reader moved: an episode renamed after posting would otherwise read
 * as "never posted" and be posted a second time.
 */
export async function readSocialSidecar(slug: string, episodeCode: string): Promise<SocialPublishSidecar> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeCode, SIDECAR_NAME)
  const filePath = path.join(paths.episode_dir, SIDECAR_NAME)
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema_version: 1, episode_code: episodeCode, receipts: [] }
    }
    throw error
  }
  return decodeSidecar(JSON.parse(raw), episodeCode)
}

/**
 * Mutate the sidecar under its lock and return the result.
 *
 * `fallbackTitle` is used only to create the folder when the episode has never
 * had a sidecar; every existing episode resolves by code.
 */
async function mutateSocialSidecar(
  slug: string,
  episodeCode: string,
  fallbackTitle: string,
  mutate: (sidecar: SocialPublishSidecar) => void,
): Promise<SocialPublishSidecar> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeCode, SIDECAR_NAME)
  const filePath = path.join(paths.episode_dir, SIDECAR_NAME)
  return withLock(filePath, async () => {
    let sidecar: SocialPublishSidecar
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      sidecar = decodeSidecar(JSON.parse(raw), episodeCode)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // The episode folder may not exist yet on a first post; `resolveEpisodePaths`
      // is the canonical creator, so use it rather than inventing a path here.
      const created = await resolveEpisodePaths(slug, episodeCode, fallbackTitle || '')
      await fs.mkdir(created.episode_dir, { recursive: true })
      sidecar = { schema_version: 1, episode_code: episodeCode, receipts: [] }
    }
    mutate(sidecar)
    await writeJsonAtomic(filePath, sidecar)
    return sidecar
  })
}

export async function recordSocialReceipt(
  slug: string,
  episodeCode: string,
  fallbackTitle: string,
  receipt: SocialPostReceipt,
): Promise<SocialPublishSidecar> {
  return mutateSocialSidecar(slug, episodeCode, fallbackTitle, (sidecar) => {
    sidecar.receipts = [...sidecar.receipts.filter(entry => entry.platform !== receipt.platform), receipt]
    if (sidecar.failures) delete sidecar.failures[receipt.platform]
    if (sidecar.failures && !Object.keys(sidecar.failures).length) delete sidecar.failures
  })
}

export async function recordSocialFailure(
  slug: string,
  episodeCode: string,
  fallbackTitle: string,
  platform: SocialPlatform,
  failure: { message: string; code: SocialErrorCode },
): Promise<SocialPublishSidecar> {
  return mutateSocialSidecar(slug, episodeCode, fallbackTitle, (sidecar) => {
    sidecar.failures = {
      ...(sidecar.failures ?? {}),
      [platform]: { message: failure.message, code: failure.code, at: new Date().toISOString() },
    }
  })
}

/** The receipt for a platform, when it was made from THIS exact file. */
export function receiptFor(sidecar: SocialPublishSidecar, platform: SocialPlatform, sourceRevision: string): SocialPostReceipt | undefined {
  return sidecar.receipts.find(receipt => receipt.platform === platform && receipt.source_revision === sourceRevision)
}

/**
 * Every receipt for this episode, whatever file it came from. The page shows
 * these so the owner can see what is already out there even after a re-render.
 */
export function receiptsFor(sidecar: SocialPublishSidecar): SocialPostReceipt[] {
  return sidecar.receipts
}
