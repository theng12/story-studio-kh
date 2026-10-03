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

import * as plans from './upload-plans.js'
import { readSidecarRaw } from './upload-sidecar.js'
import type { UploadPlatform } from './upload-store.js'
import { resolveYouTubeCredential } from './youtube-credential.js'

export interface AutoScheduleResult {
  scheduled: boolean
  episode_code: string
  publish_at?: string
  plan_id?: string
  plan_name?: string
  /** Why nothing happened, in words a person can act on. */
  reason?: string
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
): Promise<AutoScheduleResult> {
  const code = String(episode_code || '').toUpperCase()
  if (!code) return { scheduled: false, episode_code: code, reason: 'No episode code was given.' }

  const store = await import('./upload-store.js')
  const credential = platform === 'youtube' ? await resolveYouTubeCredential(slug) : null
  const account_id = platform === 'youtube'
    ? credential?.accountId || ''
    : await store.getDefaultAccountId(slug, platform)
  if (!account_id) {
    return {
      scheduled: false, episode_code: code,
      reason: 'This channel has no connected YouTube account yet, so there is no schedule to draw a slot from.',
    }
  }

  const planId = await plans.getActivePlanId(slug, platform, account_id)
  const plan = planId ? await plans.getPlan(slug, planId) : null
  if (!plan) {
    return {
      scheduled: false, episode_code: code,
      reason: 'This channel has no upload schedule yet. Set one in Settings → Publishing '
        + '(the Upload Center shows the same plan).',
    }
  }

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
      plan_id: plan.id, plan_name: plan.name,
      reason: 'This episode already has a publish time; it was left as it is.',
    }
  }

  const minStartDate = await latestFutureClaim(slug, platform, code)
  const slots = plans.computeSlots(plan.schedule, 1, { minStartDate })
  if (!slots.length) {
    return {
      scheduled: false, episode_code: code, plan_id: plan.id, plan_name: plan.name,
      reason: `Plan "${plan.name}" has no free slot left within its horizon. `
        + 'Extend its end date, or add weekdays so it produces slots more often.',
    }
  }

  const publish_at = slots[0]!
  const existing = await plans.readItemSchedule(slug)
  await plans.writeItemSchedule(slug, { ...existing, [code]: publish_at })

  return { scheduled: true, episode_code: code, publish_at, plan_id: plan.id, plan_name: plan.name }
}
