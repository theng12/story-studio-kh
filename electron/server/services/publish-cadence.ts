/**
 * A channel's publishing cadence — how often this channel puts out an episode.
 *
 * WHY THIS SITS ON THE CHANNEL AND NOT ONLY IN UPLOAD CENTER (v1.4.20).
 *
 * The owner: *"right now my upload plan is in upload center. what if i make it
 * part of the channel creation? but also make it adjustable."*
 *
 * He is right, and it fixes a real hole in the Pipeline scheduling step. An
 * Upload Plan is keyed `platform:account_id`, so it cannot exist until a
 * YouTube account has been connected — Boundful's channel predates its account
 * by months. A step that schedules a finished episode would therefore fail on
 * every channel until somebody remembered to open Upload Center and make a
 * plan, which is precisely the manual step the feature exists to remove.
 *
 * So the CADENCE belongs to the channel and the PLAN belongs to the account:
 *
 *   channel created  → cadence stored here, no account needed
 *   account connected → a plan is created from the cadence and made active
 *   from then on      → the PLAN is the authority; the cadence is only a seed
 *
 * That last line is the part worth being strict about. Two places showing a
 * schedule is how "I changed it here but it used the other one" happens, so
 * this module never reads the cadence once a plan exists, and never writes
 * back to it when a plan changes.
 *
 * Nothing here touches an episode that is already live. That protection lives
 * where it always has — `routes/upload.ts` partitions out any sidecar whose
 * `privacy_status` is `public` before writing a schedule (v1.0.46).
 */

import * as pm from './project-manager.js'
import * as plans from './upload-plans.js'
import type { UploadSchedule, UploadPlanDefaults } from './upload-plans.js'
import type { UploadPlatform } from './upload-store.js'

export const CADENCE_CONFIG_KEY = 'publish_cadence'

export interface PublishCadence {
  schedule: UploadSchedule
  defaults: UploadPlanDefaults
}

/** Sensible starting point for a new channel: three a week, evening, private. */
export function defaultCadence(timezone?: string): PublishCadence {
  return {
    schedule: {
      weekdays: [1, 3, 5],
      time_local: '18:00',
      timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
    // Private, because a plan publishes by handing YouTube a `publishAt` and
    // letting YouTube flip it live. A public default would publish on upload
    // and make the schedule meaningless.
    defaults: { privacy_status: 'private', made_for_kids: false },
  }
}

function isUsableSchedule(value: unknown): value is UploadSchedule {
  if (!value || typeof value !== 'object') return false
  const s = value as UploadSchedule
  if (typeof s.time_local !== 'string' || !/^\d{2}:\d{2}$/.test(s.time_local)) return false
  if (typeof s.timezone !== 'string' || !s.timezone) return false
  const hasWeekdays = Array.isArray(s.weekdays) && s.weekdays.length > 0
  const hasMonthly = typeof s.monthly_day === 'number' && s.monthly_day >= 1 && s.monthly_day <= 31
  // Neither means no slot can ever be computed — a cadence that produces
  // nothing is worse than no cadence, because it looks configured.
  return hasWeekdays || hasMonthly
}

export async function readCadence(slug: string): Promise<PublishCadence | null> {
  const config = (await pm.getConfig(slug)) as any
  const raw = config?.[CADENCE_CONFIG_KEY]
  if (!raw || !isUsableSchedule(raw.schedule)) return null
  const defaults = raw.defaults && typeof raw.defaults === 'object'
    ? raw.defaults as UploadPlanDefaults
    : defaultCadence().defaults
  return { schedule: raw.schedule, defaults }
}

export async function writeCadence(slug: string, cadence: PublishCadence): Promise<void> {
  if (!isUsableSchedule(cadence.schedule)) {
    throw Object.assign(
      new Error('A publishing cadence needs at least one weekday or a day of the month, '
        + 'or it can never produce a slot.'),
      { statusCode: 400, expose: true },
    )
  }
  await pm.updateConfig(slug, { [CADENCE_CONFIG_KEY]: cadence } as any)
}

/**
 * Give a newly connected account a plan, if the channel has a cadence and the
 * account has no active plan yet.
 *
 * Deliberately does nothing when a plan is already active: connecting a second
 * device, or re-authorising an expired token, must not quietly reset a schedule
 * the owner has since tuned by hand.
 *
 * Returns the plan id when one was created, else null. Never throws into the
 * OAuth path — a channel that cannot be given a plan is still a connected
 * channel, and failing the connection over it would be the wrong trade.
 */
export async function ensurePlanForAccount(
  slug: string,
  platform: UploadPlatform,
  account_id: string,
  accountLabel?: string,
): Promise<string | null> {
  try {
    const existing = await plans.getActivePlanId(slug, platform, account_id)
    if (existing) return null
    const cadence = await readCadence(slug)
    if (!cadence) return null
    const plan = await plans.upsertPlan(slug, {
      name: accountLabel ? `${accountLabel} schedule` : 'Channel schedule',
      platform,
      account_id,
      schedule: cadence.schedule,
      defaults: cadence.defaults,
    })
    await plans.setActivePlanId(slug, platform, account_id, plan.id)
    return plan.id
  } catch {
    return null
  }
}
