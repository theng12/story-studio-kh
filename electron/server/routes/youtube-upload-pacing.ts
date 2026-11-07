/**
 * Upload pacing routes (Story 386 Item 1).
 *
 * GET  /projects/:slug/youtube/upload-pacing        — the channel's current policy + tier defaults
 * PUT  /projects/:slug/youtube/upload-pacing        — save the channel's editable policy
 * POST /projects/:slug/youtube/upload-pacing/preview — paced future slots + conflicts for selected episodes
 *
 * The scheduling ALGORITHM lives once, in `services/upload-pacing.ts`; these
 * routes only read live channel/config/quota data, hand it to that service and
 * return its answer. No slot time is computed here and no quota number is
 * invented: an unconfigured window is reported as unconfigured (§1, §6).
 */

import { Router } from 'express'

import { getProjectDir, getConfig, updateConfig } from '../services/project-manager.js'
import { getJobs } from '../services/job-queue.js'
import { readYouTubeConnectionRegistry, getProjectYouTubeAssignment } from '../services/youtube-connection-store.js'
import { readYouTubeQuota } from '../services/youtube-quota-ledger.js'
import { pacingInputsForPolicy } from '../services/youtube-pacing-inputs.js'
import {
  calculatePacedUploadSlots,
  validateUploadPacingPolicy,
  UPLOAD_PACING_TIERS,
  UPLOAD_PACING_TIER_DEFAULTS,
  type UploadPacingPolicy,
} from '../services/upload-pacing.js'

export const router = Router()

function fail(res: import('express').Response, error: unknown, fallback: string): void {
  const tagged = error as { statusCode?: number; status?: number } | null
  const status = typeof tagged?.statusCode === 'number'
    ? tagged.statusCode
    : typeof tagged?.status === 'number' ? tagged.status : 500
  res.status(status).json({ detail: error instanceof Error ? error.message : fallback })
}

/**
 * The channel's saved pacing policy, or null when none was ever chosen.
 *
 * Nothing here falls back to 3/6/12 with an 08:00–22:00 window: a channel that
 * has not chosen a window is genuinely unconfigured and the UI says so.
 */
async function readPolicy(slug: string): Promise<UploadPacingPolicy | null> {
  const config = (await getConfig(slug)) as any
  const raw = config?.upload_pacing
  if (!raw) return null
  const validated = validateUploadPacingPolicy(raw)
  return validated.ok ? validated.policy : null
}

router.get('/projects/:slug/youtube/upload-pacing', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!getProjectDir(slug)) return res.status(404).json({ detail: 'Project not found' })
    const policy = await readPolicy(slug)
    res.json({
      // Starting counts are DEFAULTS the UI offers, never a policy this route applies.
      tier_defaults: UPLOAD_PACING_TIER_DEFAULTS,
      tiers: UPLOAD_PACING_TIERS,
      policy,
      configured: policy !== null,
      ...(policy ? {} : {
        unconfigured_reason: 'missing_window',
        unconfigured_message: 'Choose this channel\'s upload window hours — no window is assumed.',
      }),
    })
  } catch (error) {
    fail(res, error, 'Failed to read the channel upload pacing.')
  }
})

router.put('/projects/:slug/youtube/upload-pacing', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!getProjectDir(slug)) return res.status(404).json({ detail: 'Project not found' })
    const validated = validateUploadPacingPolicy(req.body?.policy ?? req.body)
    if (!validated.ok) {
      res.status(400).json({ code: 'UPLOAD_PACING_INVALID', detail: validated.message, reason: validated.reason })
      return
    }
    // One key in the channel's config. `updateConfig` persists it through its
    // passthrough; nothing here spreads or rewrites the rest of config.json
    // (AGENTS §5 — a save carries only the field it owns).
    const saved = await updateConfig(slug, { upload_pacing: validated.policy } as any)
    if (!saved) {
      res.status(409).json({ code: 'UPLOAD_PACING_UNSAVED', detail: 'This project has no config to save into.' })
      return
    }
    res.json({ policy: validated.policy, saved: true })
  } catch (error) {
    fail(res, error, 'Failed to save the channel upload pacing.')
  }
})

router.post('/projects/:slug/youtube/upload-pacing/preview', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!getProjectDir(slug)) return res.status(404).json({ detail: 'Project not found' })
    const policy = await readPolicy(slug)
    if (!policy) {
      res.status(409).json({
        code: 'UPLOAD_PACING_UNCONFIGURED',
        detail: 'This channel has no upload window hours yet. Choose them before previewing upload slots.',
      })
      return
    }
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .map((item: any) => ({
        episode_code: typeof item?.episode_code === 'string' ? item.episode_code.trim() : '',
        earliest_upload_on: typeof item?.earliest_upload_on === 'string' ? item.earliest_upload_on : null,
        publish_at: typeof item?.publish_at === 'string' ? item.publish_at : null,
      }))
      .filter((item: { episode_code: string }) => item.episode_code)
    // The live context (recorded transfers, existing planned slots) is read the
    // same way the queue reads it, so a preview can never promise a slot the
    // dispatcher would refuse.
    const registry = await readYouTubeConnectionRegistry()
    const quota = registry.application
      ? await readYouTubeQuota(registry.application.application_id).catch(() => null)
      : null
    const context = pacingInputsForPolicy({
      jobs: await getJobs(slug, { type: 'youtube_upload' }),
      policy,
      quota: quota
        ? { resets_at: quota.resets_at, video_uploads: { used: quota.buckets.video_uploads.used, limit: quota.buckets.video_uploads.limit } }
        : null,
    })
    const plan = calculatePacedUploadSlots(items, policy, {
      now: Date.now(),
      recorded_transfers: context.recorded_transfers,
      existing_planned_slots: context.existing_planned_slots,
      quota_timezone: context.quota_timezone,
    })
    res.json(plan)
  } catch (error) {
    fail(res, error, 'Failed to preview upload slots.')
  }
})
