/**
 * Give one finished episode the next free slot in its channel's schedule.
 *
 * WHAT THIS REPLACES (v1.4.20). The owner: *"i have to manually update the
 * schedule each time. and also select the videos. there's not enough
 * automation flow in the youtube upload."*
 *
 * The queue already lists episodes on its own — nothing is enqueued by hand.
 * What was manual was SELECTING which of them to schedule and pressing apply,
 * every time. The Pipeline does not need to select: it knows exactly which
 * episode it just rendered.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch YouTube. It writes a local schedule
 * and stops. The owner chose that ("enqueue and schedule only — you press
 * upload"), and it is also what makes this safe to run unattended — a bad
 * render cannot reach a channel.
 *
 * EPISODE ORDER (1.4.262). After the new slot is written, the future dates of
 * episodes not on YouTube yet are dealt back out in episode-code order
 * (`upload-plans.episodeOrderShifts`), so finishing 173 after 245 and 390 puts
 * 173 first. Episodes uploading or already on YouTube keep their dates.
 *
 * ── On the claim-walk ──
 *
 * `POST /upload/plans/:id/apply` and its preview need the same "find the
 * latest future claim so the walk resumes past it" scan. That was duplicated
 * here on purpose in 1.4.20: the apply route had no tests, and refactoring
 * untested code that sets real publish dates was the worse risk.
 *
 * `upload-plan-apply-routes.test.ts` closed that gap in 1.4.21 — the scan now
 * lives once, in `upload-plans.latestFutureClaimMs`, and all three callers use
 * it. The drift alarm that guarded the duplicate is gone with the duplicate.
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { readStoredFinalCheck } from '../lib/final-video-check.js'

import { withLock } from '../lib/atomic-store.js'
import * as plans from './upload-plans.js'
import * as im from './idea-manager.js'
import { defaultSchedule, readCadence } from './publish-cadence.js'
import { getProjectDir } from './project-manager.js'
import { readSidecarRaw, readSidecarStrict, setScheduledFor } from './upload-sidecar.js'
import type { UploadPlatform } from './upload-store.js'
import { createProjectFactsCache } from './utils.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import { resolveYouTubeCredential } from './youtube-credential.js'
import { listYouTubeOperations } from './youtube-operation-store.js'
import { readYouTubeProjectPublishingState } from './youtube-project-publishing-store.js'
import { remoteVideoFor } from './youtube-remote-video.js'

export interface AutoScheduleResult {
  scheduled: boolean
  episode_code: string
  publish_at?: string
  plan_id?: string
  plan_name?: string
  /** Why nothing happened, in words a person can act on. */
  reason?: string
  /** Other episodes whose date moved so dates follow episode order. */
  order_shifted?: string[]
  hold?: { status: 'failed' | 'stale' | 'unchecked' | 'check-error'; reason: string }
}

/** The hold belongs to the final itself and survives a restart. */
function holdPath(videoPath: string): string { return `${videoPath}.auto-schedule.json` }

export async function readAutoScheduleHold(videoPath: string): Promise<AutoScheduleResult['hold'] | null> {
  try {
    const state = JSON.parse(await fs.readFile(holdPath(videoPath), 'utf8'))
    return state?.hold?.reason && state?.hold?.status ? state.hold : null
  } catch { return null }
}

export async function scheduleCheckedEpisode(
  slug: string, code: string, videoPath: string, checkError = false,
): Promise<AutoScheduleResult> {
  const pm = await import('./project-manager.js')
  const config = await pm.getConfig(slug) as any
  if (config.auto_schedule_on_render === false) return { scheduled: false, episode_code: code }
  const existing = await plans.readItemPublicationStates(slug)
  const scheduled = (await plans.readItemSchedule(slug))[code] || existing[code]?.scheduled_for
  if (scheduled || existing[code]?.privacy_status === 'public') {
    return { scheduled: false, episode_code: code, reason: 'This episode already has a publish time or is public; it was left as it is.' }
  }
  if (config.auto_schedule_require_final_check !== false) {
    const stored = await readStoredFinalCheck(videoPath)
    const status = checkError ? 'check-error' : !stored ? 'unchecked' : stored.stale ? 'stale' : !stored.result.passed ? 'failed' : null
    const descriptions = {
      failed: 'The final check failed.', stale: 'The video changed since its final check.',
      unchecked: 'The final video has not been checked.', 'check-error': 'The final check could not run.',
    }
    const hold: NonNullable<AutoScheduleResult['hold']> = status
      ? { status, reason: `Not automatically scheduled: ${descriptions[status]} Run Final Check in Publish; a pass will schedule it.` }
      : { status: 'check-error', reason: 'Automatic scheduling was interrupted. Run Final Check in Publish; a pass will schedule it.' }
    await fs.writeFile(holdPath(videoPath), JSON.stringify({ hold }) + '\n')
    if (status) return { scheduled: false, episode_code: code, reason: hold.reason, hold }
  }
  const result = await scheduleEpisodeWithActivePlan(slug, code, 'youtube', true)
  if (result.scheduled || result.publish_at) await fs.writeFile(holdPath(videoPath), JSON.stringify({ hold: null }) + '\n')
  else if (result.reason) {
    const prior = await readAutoScheduleHold(videoPath)
    if (prior) await fs.writeFile(holdPath(videoPath), JSON.stringify({ hold: { ...prior, reason: `Final check passed, but the episode could not be scheduled: ${result.reason}` } }) + '\n')
  }
  return result
}

/**
 * Future dates Story may still move: the episode is not uploading and has no
 * video on the channel. Anything already on YouTube keeps its date, and so does
 * an episode whose upload record cannot be read (it might be on YouTube).
 */
export async function movableLocalClaims(
  slug: string,
  channelId: string,
  schedule: Readonly<Record<string, string>>,
  now: number = Date.now(),
): Promise<Record<string, string>> {
  const { getJobs } = await import('./job-queue.js')
  const [jobs, operations, publishingState, ideas] = await Promise.all([
    getJobs(slug, { type: 'youtube_upload' }),
    listYouTubeOperations(slug),
    readYouTubeProjectPublishingState(slug),
    im.getIdeas(slug, 'accepted'),
  ])
  const uploading = new Set(jobs
    .filter(job => ['queued', 'running', 'paused'].includes(job.status))
    .map(job => job.episode_id))
  const titles = new Map(ideas.filter(idea => !!idea.episode_code).map(idea => [idea.episode_code!, idea.title || '']))
  const facts = createProjectFactsCache(slug)
  const out: Record<string, string> = {}
  for (const [code, at] of Object.entries(schedule)) {
    if (!titles.has(code) || uploading.has(code) || !(Date.parse(at) > now)) continue
    try {
      if (await remoteVideoFor(slug, code, titles.get(code)!, channelId, operations, publishingState, facts)) continue
    } catch {
      continue
    }
    out[code] = at
  }
  return out
}

/** Hand the movable future dates back out in episode order; returns what moved. */
async function keepEpisodeOrder(slug: string, channelId: string): Promise<Record<string, string>> {
  const movable = await movableLocalClaims(slug, channelId, await plans.readItemSchedule(slug))
  const shifts = plans.episodeOrderShifts(movable)
  const codes = plans.orderEpisodeCodes(Object.keys(shifts))
  if (!codes.length) return shifts
  const titles = new Map((await im.getIdeas(slug, 'accepted'))
    .filter(idea => !!idea.episode_code).map(idea => [idea.episode_code!, idea.title || '']))
  const expected: Record<string, string | null> = {}
  for (const code of codes) expected[code] = (await readSidecarStrict(slug, code, 'youtube'))?.scheduled_for ?? null
  await plans.applyScheduleAssignmentsWithRollback(
    codes.map(code => ({ episode_code: code, publishAt: shifts[code]! })),
    expected,
    (code, scheduledFor, previous) => setScheduledFor(slug, code, titles.get(code) || '', 'youtube', scheduledFor, previous),
  )
  return shifts
}

/**
 * The latest future claim, from the one shared copy in `upload-plans.ts`.
 *
 * This used to be a deliberate duplicate of the scan in `routes/upload.ts`,
 * because that route had no tests and refactoring it would have risked the
 * owner's real publish dates with nothing to catch a mistake.
 * `upload-plan-apply-routes.test.ts` closed that gap in v1.4.21, so preview,
 * apply and this path now walk the same code.
 */
async function latestFutureClaim(
  slug: string,
  platform: UploadPlatform,
  excludeCode: string,
): Promise<Date | undefined> {
  const ms = await plans.latestFutureProjectClaimMs(slug, platform, [excludeCode])
  return ms ? new Date(ms) : undefined
}

export async function scheduleEpisodeWithActivePlan(
  slug: string,
  episode_code: string,
  platform: UploadPlatform = 'youtube',
  preserveExisting = false,
): Promise<AutoScheduleResult> {
  const code = String(episode_code || '').toUpperCase()
  if (!code) return { scheduled: false, episode_code: code, reason: 'No episode code was given.' }

  const store = await import('./upload-store.js')
  const credential = platform === 'youtube' ? await resolveYouTubeCredential(slug) : null
  const account_id = platform === 'youtube'
    ? credential?.accountId || ''
    : await store.getDefaultAccountId(slug, platform)

  const planId = account_id ? await plans.getActivePlanId(slug, platform, account_id) : ''
  const plan = planId ? await plans.getPlan(slug, planId) : null
  // No saved plan? The channel's own cadence, else the default every channel
  // starts on (2026-10-31): three a week on random days at a random time.
  // Nothing is written for the default — it is read at use time.
  const cadence = plan ? null : await readCadence(slug)
  const schedule = plan?.schedule ?? cadence?.schedule ?? defaultSchedule(slug)
  const planName = plan?.name ?? (cadence ? 'Channel cadence' : 'Default schedule')

  // Never move an episode that is already live. This is the same rule the
  // apply route has enforced since v1.0.46, restated here because this path
  // runs unattended and a desync between the local schedule and a public
  // video is exactly what nobody would notice.
  const sidecar = platform === 'youtube' ? null : await readSidecarRaw(slug, code, '', platform)
  let privacyStatus: string | undefined = sidecar?.privacy_status
  let scheduledFor = sidecar?.scheduled_for || null
  if (platform === 'youtube') {
    const states = await plans.readItemPublicationStates(slug)
    privacyStatus = states[code]?.privacy_status
    scheduledFor = states[code]?.scheduled_for || null
  }
  if (privacyStatus === 'public') {
    return {
      scheduled: false, episode_code: code,
      reason: 'This episode is already public on YouTube, so its publish time was left alone.',
    }
  }
  if (scheduledFor) {
    return {
      scheduled: false, episode_code: code, publish_at: scheduledFor,
      ...(plan ? { plan_id: plan.id } : {}), plan_name: planName,
      reason: 'This episode already has a publish time; it was left as it is.',
    }
  }

  const write = async (): Promise<AutoScheduleResult> => {
    const current = await plans.readItemPublicationStates(slug)
    const currentSchedule = (await plans.readItemSchedule(slug))[code] || current[code]?.scheduled_for
    if (currentSchedule || current[code]?.privacy_status === 'public') {
      return { scheduled: false, episode_code: code, publish_at: currentSchedule || undefined,
        reason: 'This episode already has a publish time or is public; it was left as it is.' }
    }
    const minStartDate = await latestFutureClaim(slug, platform, code)
    const slots = plans.computeSlots(schedule, 1, { minStartDate })
    if (!slots.length) {
      return {
        scheduled: false, episode_code: code,
        ...(plan ? { plan_id: plan.id } : {}), plan_name: planName,
        reason: `The schedule "${planName}" has no free slot left within its horizon. `
          + 'Extend its end date, or add days so it produces slots more often.',
      }
    }
    let publish_at = slots[0]!
    const existing = await plans.readItemSchedule(slug)
    await plans.writeItemSchedule(slug, { ...existing, [code]: publish_at })
    const channelId = !preserveExisting && platform === 'youtube' ? (await getProjectYouTubeAssignment(slug))?.channel_id : null
    const shifts = channelId ? await keepEpisodeOrder(slug, channelId) : {}
    publish_at = shifts[code] ?? publish_at
    const order_shifted = Object.keys(shifts).filter(other => other !== code)
    return {
      scheduled: true, episode_code: code, publish_at,
      ...(plan ? { plan_id: plan.id } : {}), plan_name: planName,
      ...(order_shifted.length ? { order_shifted: plans.orderEpisodeCodes(order_shifted) } : {}),
    }
  }
  // The Upload Center's plan routes hold this lock too, so an apply and a
  // finished render never reorder the same dates at once.
  const projectDir = getProjectDir(slug)
  return projectDir ? withLock(path.join(projectDir, 'youtube', 'upload-center-plan.lock'), write) : write()
}
