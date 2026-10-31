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
 * YouTube account has been connected — a channel can predate its account
 * by months. A step that schedules a finished episode would therefore fail on
 * every channel until somebody remembered to open Upload Center and make a
 * plan, which is precisely the manual step the feature exists to remove.
 *
 * So the CADENCE belongs to the channel and the PLAN belongs to the account:
 *
 *   channel created  → cadence stored here, no account needed
 *   account connected → a plan is created from the cadence and made active
 *   from then on      → the PLAN is the authority
 *
 * ONE SCHEDULE, TWO SCREENS (v1.4.249). The owner: *"it saves here but doesn't
 * show me the plan's name so I have to do the same save again inside the
 * Upload Center. feels like a duplicate action."* Settings and the Upload
 * Center now read and write the same record through `readChannelSchedule` /
 * `saveChannelSchedule`: once a channel is assigned, that record is its active
 * upload plan, shown by name. Every save of the active plan — from either
 * screen — is mirrored back into the cadence, so the seed a future reconnect
 * uses is always the schedule the owner last saw, never an older one.
 *
 * Nothing here touches an episode that is already live. That protection lives
 * where it always has — `routes/upload.ts` partitions out any sidecar whose
 * `privacy_status` is `public` before writing a schedule (v1.0.46).
 */

import * as pm from './project-manager.js'
import * as plans from './upload-plans.js'
import type { UploadPlan, UploadSchedule, UploadPlanDefaults } from './upload-plans.js'
import type { UploadPlatform } from './upload-store.js'

export const CADENCE_CONFIG_KEY = 'publish_cadence'

export interface PublishCadence {
  schedule: UploadSchedule
  defaults: UploadPlanDefaults
}

/**
 * The starting point for a new channel (2026-10-31).
 *
 * The owner: *"all channels should default to 3 videos per week randomly but
 * not back to back"* and *"let's make the time random per the new default.
 * but once done. it's saved."* So the default is three videos a week on days
 * drawn from the channel's seed, each at a random time inside the window.
 */
export function defaultCadence(timezone?: string): PublishCadence {
  return {
    schedule: {
      weekdays: [],
      random_weekly: 3,
      random_time_window: { ...plans.RANDOM_TIME_WINDOW_DEFAULT },
      // Unused while the days are random, but the shape needs a valid time.
      time_local: plans.RANDOM_TIME_WINDOW_DEFAULT.start,
      timezone: timezone || 'Asia/Phnom_Penh',
    },
    // Private, because a plan publishes by handing YouTube a `publishAt` and
    // letting YouTube flip it live. A public default would publish on upload
    // and make the schedule meaningless.
    defaults: { privacy_status: 'private', made_for_kids: false },
  }
}

/**
 * What this channel publishes on until it saves its own schedule.
 *
 * Read at use time and never written: a channel with no saved plan keeps its
 * file exactly as it is, and the default simply applies.
 */
export function defaultSchedule(slug: string): UploadSchedule {
  return { ...defaultCadence().schedule, random_seed: slug }
}

/**
 * The switch that gives a finished episode its slot.
 *
 * Absent means ON: the owner (2026-10-31) wants every finished video to
 * schedule itself, and only an explicit `false` turns that off.
 */
export function autoScheduleEnabled(config: unknown): boolean {
  return (config as { auto_schedule_on_render?: unknown } | null | undefined)?.auto_schedule_on_render !== false
}

export function autoUploadMode(config: unknown): 'off' | 'private' | 'scheduled' {
  const mode = (config as { auto_upload?: unknown } | null | undefined)?.auto_upload
  return mode === 'private' || mode === 'scheduled' ? mode : 'off'
}

/**
 * 1.4.374 — the channel's Shorts upload switch, beside `auto_upload` above.
 * Absent or unknown means OFF: an unreadable value must never turn a
 * feature on. The reader lives here so the card, the route and the Shorts
 * job all answer the same question.
 */
export function shortsAutoUploadMode(config: unknown): 'off' | 'private' | 'scheduled' {
  const mode = (config as { shorts_auto_upload?: unknown } | null | undefined)?.shorts_auto_upload
  return mode === 'private' || mode === 'scheduled' ? mode : 'off'
}

/**
 * Days between Shorts in 'scheduled' mode. A value outside 1–30 is not a
 * spacing, so the starting value (one day) is used instead of a number the
 * customer never chose (§6: never a fallback that reads as their answer).
 */
export function shortsUploadSpacingDays(config: unknown): number {
  const value = (config as { shorts_upload_spacing_days?: unknown } | null | undefined)?.shorts_upload_spacing_days
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 30 ? value : 1
}

function isUsableSchedule(value: unknown): value is UploadSchedule {
  if (!value || typeof value !== 'object') return false
  const s = value as UploadSchedule
  if (typeof s.time_local !== 'string' || !/^\d{2}:\d{2}$/.test(s.time_local)) return false
  if (typeof s.timezone !== 'string' || !s.timezone) return false
  const hasWeekdays = Array.isArray(s.weekdays) && s.weekdays.length > 0
  const hasMonthly = typeof s.monthly_day === 'number' && s.monthly_day >= 1 && s.monthly_day <= 31
  // The counted default (2026-10-31) draws its own days, so it needs neither.
  const hasCount = typeof s.random_weekly === 'number' && s.random_weekly >= 1
  // Neither means no slot can ever be computed — a cadence that produces
  // nothing is worse than no cadence, because it looks configured.
  return hasWeekdays || hasMonthly || hasCount
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
  await pm.updateConfig(slug, {
    [CADENCE_CONFIG_KEY]: { ...cadence, schedule: plans.ensureRandomSeed(cadence.schedule, slug) },
  } as any)
}

/**
 * Give an account its one active plan, if it has none.
 *
 * Deliberately does nothing when a plan is already active: connecting a second
 * device, or re-authorising an expired token, must not quietly reset a schedule
 * the owner has since tuned by hand.
 *
 * Never makes a duplicate: when the account already has saved plans but none
 * is active (or the active pointer names a plan that is gone), the most
 * recently edited one is made active instead of creating another from the
 * cadence. Only an account with no plans at all gets one made from the cadence.
 *
 * Returns the plan id it created or activated, else null. Never throws into the
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
    const all = await plans.listPlans(slug)
    const own = all.filter(p => p.platform === platform && p.account_id === account_id)
    const activeId = await plans.getActivePlanId(slug, platform, account_id)
    if (activeId && own.some(p => p.id === activeId)) return null
    if (own.length) {
      const newest = [...own].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0]!
      await plans.setActivePlanId(slug, platform, account_id, newest.id)
      return newest.id
    }
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

/** The schedule fields a cadence keeps; dates belong to one plan, not to a seed. */
function seedScheduleFrom(schedule: UploadSchedule): UploadSchedule {
  const seed: UploadSchedule = {
    weekdays: Array.isArray(schedule.weekdays) ? [...schedule.weekdays] : [],
    time_local: schedule.time_local,
    timezone: schedule.timezone,
  }
  if (schedule.interval_weeks) seed.interval_weeks = schedule.interval_weeks
  if (!seed.weekdays.length && schedule.monthly_day) seed.monthly_day = schedule.monthly_day
  // The counted default (2026-10-31) and the customer's own days and times.
  if (schedule.random_weekly) seed.random_weekly = schedule.random_weekly
  if (schedule.random_time_window) seed.random_time_window = { ...schedule.random_time_window }
  if (schedule.times_local?.length) seed.times_local = [...schedule.times_local]
  if (schedule.random_seed) seed.random_seed = schedule.random_seed
  return seed
}

/**
 * Keep the cadence equal to the channel's active plan. Called after every save
 * or activation of a plan; a plan that is not the active one for its account
 * leaves the cadence alone. Best-effort: the plan save already succeeded.
 */
export async function mirrorPlanToCadence(slug: string, plan: UploadPlan): Promise<void> {
  try {
    const activeId = await plans.getActivePlanId(slug, plan.platform, plan.account_id)
    if (activeId !== plan.id) return
    await writeCadence(slug, { schedule: seedScheduleFrom(plan.schedule), defaults: plan.defaults })
  } catch { /* the plan is saved; the seed catches up on the next save */ }
}

export interface ChannelSchedule {
  /** The assigned YouTube channel, or null before one is chosen. */
  channel: { channel_id: string; title: string } | null
  /** `registry:<channel id>` when a channel is assigned, else ''. */
  account_id: string
  /** The channel's active plan — THE schedule once a channel is assigned. */
  plan: UploadPlan | null
  /** Every saved plan for this channel, so either screen can switch between them. */
  plans: UploadPlan[]
  /** The channel's rhythm before YouTube is connected (also kept equal to the active plan). */
  cadence: PublishCadence | null
  /**
   * What this channel publishes on until it saves its own schedule (2026-10-31):
   * three a week on random days at a random time. Read at use time — nothing
   * on disk is written for it.
   */
  default_schedule: UploadSchedule
  auto_schedule_on_render: boolean
  auto_schedule_require_final_check: boolean
  auto_upload: 'off' | 'private' | 'scheduled'
  /** 1.4.374 — the channel's Shorts upload switch. Off unless the owner turns it on. */
  shorts_auto_upload: 'off' | 'private' | 'scheduled'
  /** Days between Shorts in 'scheduled' mode (1–30). */
  shorts_upload_spacing_days: number
  /** How many Shorts this channel makes per episode (0–3). */
  shorts_per_episode: number
}

async function assignedChannel(slug: string): Promise<{ channel_id: string; title: string; account_id: string } | null> {
  const { resolveYouTubeCredential } = await import('./youtube-credential.js')
  const credential = await resolveYouTubeCredential(slug).catch(() => null)
  if (!credential) return null
  const { readYouTubeConnectionRegistry } = await import('./youtube-connection-store.js')
  const registry = await readYouTubeConnectionRegistry().catch(() => null)
  const title = registry?.channels?.[credential.channelId]?.title || credential.channelId
  return { channel_id: credential.channelId, title, account_id: credential.accountId }
}

/**
 * What Settings → Publishing and the Upload Center both show.
 *
 * Also the migration for channels set up before v1.4.249: a channel with a
 * cadence and no plan gets its plan now, and a channel whose plans were never
 * made active gets its newest one activated — without ever creating a second
 * copy of a schedule that already exists.
 */
export async function readChannelSchedule(slug: string): Promise<ChannelSchedule> {
  const channel = await assignedChannel(slug)
  if (channel) await ensurePlanForAccount(slug, 'youtube', channel.account_id, channel.title)
  const config = (await pm.getConfig(slug)) as any
  const cadence = await readCadence(slug)
  const auto = autoScheduleEnabled(config)
  const fallback = defaultSchedule(slug)
  if (!channel) {
    return {
      channel: null, account_id: '', plan: null, plans: [], cadence,
      default_schedule: fallback, auto_schedule_on_render: auto, auto_schedule_require_final_check: config?.auto_schedule_require_final_check !== false, auto_upload: autoUploadMode(config),
      shorts_auto_upload: shortsAutoUploadMode(config), shorts_upload_spacing_days: shortsUploadSpacingDays(config),
      shorts_per_episode: (await import('./episode-shorts.js')).shortsPerEpisode((config as any).shorts_per_episode),
    }
  }
  const own = (await plans.listPlans(slug)).filter(p => p.platform === 'youtube' && p.account_id === channel.account_id)
  const activeId = await plans.getActivePlanId(slug, 'youtube', channel.account_id)
  return {
    channel: { channel_id: channel.channel_id, title: channel.title },
    account_id: channel.account_id,
    plan: own.find(p => p.id === activeId) || null,
    plans: own,
    cadence,
    default_schedule: fallback,
    auto_schedule_on_render: auto,
    auto_schedule_require_final_check: config?.auto_schedule_require_final_check !== false, auto_upload: autoUploadMode(config),
    shorts_auto_upload: shortsAutoUploadMode(config), shorts_upload_spacing_days: shortsUploadSpacingDays(config),
    shorts_per_episode: (await import('./episode-shorts.js')).shortsPerEpisode((config as any).shorts_per_episode),
  }
}

export interface ChannelScheduleInput {
  /** Absent when only the auto-schedule switch is being flipped. */
  schedule?: UploadSchedule
  /** Plan name; only used when a plan is created or renamed. */
  name?: string
  auto_schedule_on_render?: boolean
  auto_schedule_require_final_check?: boolean
  auto_upload?: 'off' | 'private' | 'scheduled'
  /**
   * 1.4.374 — the channel's Shorts: how many per episode (0–3), how to upload
   * them, and the days between them.
   */
  shorts_per_episode?: number
  shorts_auto_upload?: 'off' | 'private' | 'scheduled'
  shorts_upload_spacing_days?: number
}

/**
 * Save the channel's schedule from either screen. With a channel assigned it
 * edits the ACTIVE plan in place (or creates and activates the first one);
 * without one it stores the cadence that becomes the plan on connect.
 */
export async function saveChannelSchedule(slug: string, input: ChannelScheduleInput): Promise<ChannelSchedule> {
  const badRequest = (detail: string) => Object.assign(new Error(detail), { statusCode: 400, status: 400, expose: true })
  if (typeof input.auto_schedule_on_render === 'boolean') {
    await pm.updateConfig(slug, { auto_schedule_on_render: input.auto_schedule_on_render } as any)
  }
  if (input.auto_upload) await pm.updateConfig(slug, { auto_upload: input.auto_upload } as any)
  if (typeof input.shorts_per_episode === 'number') {
    await pm.updateConfig(slug, { shorts_per_episode: input.shorts_per_episode } as any)
  }
  if (input.shorts_auto_upload) await pm.updateConfig(slug, { shorts_auto_upload: input.shorts_auto_upload } as any)
  if (typeof input.shorts_upload_spacing_days === 'number') {
    await pm.updateConfig(slug, { shorts_upload_spacing_days: input.shorts_upload_spacing_days } as any)
  }
  if (typeof input.auto_schedule_require_final_check === 'boolean') {
    await pm.updateConfig(slug, { auto_schedule_require_final_check: input.auto_schedule_require_final_check } as any)
  }
  // Only the switch was sent: the starting schedule is not on disk and must
  // not be written there.
  if (!input.schedule) return readChannelSchedule(slug)
  const channel = await assignedChannel(slug)
  if (!channel) {
    const current = await readCadence(slug)
    await writeCadence(slug, {
      schedule: seedScheduleFrom(input.schedule),
      defaults: current?.defaults || defaultCadence().defaults,
    })
    return readChannelSchedule(slug)
  }
  await ensurePlanForAccount(slug, 'youtube', channel.account_id, channel.title)
  const activeId = await plans.getActivePlanId(slug, 'youtube', channel.account_id)
  const active = activeId ? await plans.getPlan(slug, activeId) : null
  const name = (input.name || '').trim() || active?.name || `${channel.title} schedule`
  const draft = {
    ...(active ? { id: active.id } : {}),
    name,
    platform: 'youtube' as const,
    account_id: channel.account_id,
    schedule: { ...(active?.schedule || {}), ...input.schedule },
    defaults: active?.defaults || (await readCadence(slug))?.defaults || defaultCadence().defaults,
  }
  // Fields cleared by the editor must really clear, not survive the merge.
  if (!input.schedule.monthly_day) delete (draft.schedule as any).monthly_day
  if (!input.schedule.start_date) delete (draft.schedule as any).start_date
  if (!input.schedule.end_date) delete (draft.schedule as any).end_date
  if (!input.schedule.interval_weeks) delete (draft.schedule as any).interval_weeks
  if (!input.schedule.phases?.length) delete draft.schedule.phases
  // The counted default and the customer's own days are different modes, so
  // one set of fields must not survive the other.
  if (!input.schedule.random_weekly) {
    delete (draft.schedule as any).random_weekly
    delete (draft.schedule as any).random_time_window
  } else {
    delete (draft.schedule as any).interval_weeks
  }
  if (!input.schedule.times_local?.length) delete (draft.schedule as any).times_local
  const problem = plans.validateUploadPlanDraft(draft)
  if (problem) throw badRequest(problem)
  const saved = await plans.upsertPlan(slug, draft)
  if (!active) await plans.setActivePlanId(slug, 'youtube', channel.account_id, saved.id)
  await mirrorPlanToCadence(slug, saved)
  return readChannelSchedule(slug)
}
