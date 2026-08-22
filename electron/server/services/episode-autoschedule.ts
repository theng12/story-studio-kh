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
 * ── On the duplicated claim-walk ──
 *
 * `POST /upload/plans/:id/apply` contains the same "find the latest future
 * claim so the walk resumes past it" scan. That scan is NOT extracted, on
 * purpose: the apply route has no tests at all — `upload-plans-compute.test.ts`
 * covers `computeSlots` thoroughly and the route not once — so refactoring it
 * would mean editing untested code that schedules real uploads, with nothing to
 * catch a mistake before it reached YouTube.
 *
 * The duplication is bounded and guarded instead. The hard part (`computeSlots`
 * and all its calendar, interval and monthly maths) is shared and has fifteen
 * tests. Only the claim scan is copied, and
 * `episode-autoschedule-drift.test.ts` fails, naming the divergence, if the two
 * copies stop agreeing.
 */

import * as im from './idea-manager.js'
import * as plans from './upload-plans.js'
import { readSidecarRaw } from './upload-sidecar.js'
import type { UploadPlatform } from './upload-store.js'

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
 * The latest FUTURE slot already claimed by any other episode.
 *
 * Mirrors the scan in `POST /upload/plans/:id/apply`. Past slots are ignored
 * deliberately — a video that went live last week must not push new episodes
 * further out — and the target episode is excluded so re-running on the same
 * episode reuses its own slot rather than walking past it.
 */
export async function latestFutureClaim(
  slug: string,
  platform: UploadPlatform,
  excludeCode: string,
  now: number = Date.now(),
): Promise<Date | undefined> {
  const accepted = await im.getIdeas(slug, 'accepted')
  let latest = 0
  await Promise.all(accepted.map(async (idea: any) => {
    if (!idea.episode_code || idea.episode_code === excludeCode) return
    const sc = await readSidecarRaw(slug, idea.episode_code, idea.title || '', platform)
    if (!sc?.scheduled_for) return
    const t = Date.parse(sc.scheduled_for)
    if (Number.isFinite(t) && t > now && t > latest) latest = t
  }))
  return latest ? new Date(latest) : undefined
}

export async function scheduleEpisodeWithActivePlan(
  slug: string,
  episode_code: string,
  platform: UploadPlatform = 'youtube',
): Promise<AutoScheduleResult> {
  const code = String(episode_code || '').toUpperCase()
  if (!code) return { scheduled: false, episode_code: code, reason: 'No episode code was given.' }

  const store = await import('./upload-store.js')
  const account_id = await store.getDefaultAccountId(slug, platform)
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
      reason: 'This channel has no active upload plan. Set a publishing cadence in Channel Identity, '
        + 'or make a plan in Upload Center.',
    }
  }

  // Never move an episode that is already live. This is the same rule the
  // apply route has enforced since v1.0.46, restated here because this path
  // runs unattended and a desync between the local schedule and a public
  // video is exactly what nobody would notice.
  const sidecar = await readSidecarRaw(slug, code, '', platform)
  if (sidecar?.privacy_status === 'public') {
    return {
      scheduled: false, episode_code: code,
      reason: 'This episode is already public on YouTube, so its publish time was left alone.',
    }
  }
  if (sidecar?.scheduled_for) {
    return {
      scheduled: false, episode_code: code, publish_at: sidecar.scheduled_for,
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
