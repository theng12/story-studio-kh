/**
 * Upload pacing queue glue (Story 386 Item 1).
 *
 * Connects the pure pacing contract/service (`services/upload-pacing.ts`) to
 * the EXISTING persistent YouTube upload queue, quota ledger and channel
 * config. It invents no schedule and owns no clock: every number comes from
 * the job, the ledger, the channel policy or the recorded transfers.
 *
 * Dispatch model (no second scheduler, no cron):
 *   - A paced hold is expressed as a `quota_retry_at` on the job — the marker
 *     the queue already treats as "keep this row durable, wake it at this
 *     instant". The existing quota-wait timer is therefore the ONLY timer.
 *   - The queue pump asks `pacingHoldReason` before starting a youtube_upload
 *     and, when a job is held, writes the woke instant and scans FORWARD for
 *     the next job whose channel is open (fair cross-channel selection, so one
 *     held channel can never block the others).
 *   - `upload_on` (earliest transfer start) is persisted in the job params, so
 *     a restart re-reads it rather than remembering a relative delay.
 *
 * Every function here is side-effect free except `applyPacingHold`, which
 * mutates only the job it is handed.
 */

import type { Job } from '../models/types.js'
import {
  checkUploadEligibility,
  type UploadEligibilityVerdict,
  type RecordedTransfer,
  type UploadPacingPolicy,
} from './upload-pacing.js'
import { pacingInputsForPolicy } from './youtube-pacing-inputs.js'

/** The durable job param that carries "earliest allowed transfer start" (ISO 8601). */
export const UPLOAD_ON_PARAM = 'upload_on'
/** The durable job param naming the channel this upload was admitted for. */
export const UPLOAD_CHANNEL_PARAM = 'expected_channel_id'
/** The durable job param that holds the queue's paced wake instant (ISO 8601). */
export const PACING_RETRY_PARAM = 'quota_retry_at'
/** Set on a job whose publication date passed while it waited: it holds, it never moves (owner brief 7). */
export const PUBLISH_DEADLINE_HOLD_PARAM = 'pacing_publish_deadline_hold'

/** Read the planned publish instant the job will actually send (package `scheduled_for`). */
export function publishAtOf(job: Job): string | null {
  const scheduled = job.params?.scheduled_for
  if (typeof scheduled === 'string' && scheduled.trim()) return scheduled.trim()
  const legacy = job.params?.publish_at
  return typeof legacy === 'string' && legacy.trim() ? legacy.trim() : null
}

/** Read the earliest allowed transfer start recorded when the job was admitted. */
export function uploadOnOf(job: Job): string | null {
  const value = job.params?.[UPLOAD_ON_PARAM]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The channel this job targets, as the queue lane sees it (null when unrecorded). */
export function channelOf(job: Job): string | null {
  const value = job.params?.[UPLOAD_CHANNEL_PARAM]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export interface PacingChannelContext {
  policy: UploadPacingPolicy
  /** Completed / in-progress transfers for this channel, from the real quota ledger. */
  recorded_transfers: readonly RecordedTransfer[]
  quota_exhausted: boolean
  quota_reset_at: string | null
}

export interface PacingHoldInputs {
  now?: Date | number | string
  /** Resolve a channel's policy + recorded transfers, or null when unconfigured. */
  channelContext: (channelId: string | null) => PacingChannelContext | null
}

/** "HH:MM:SS" deltas are folded into the reset string; no arithmetic happens here on a guess. */
function quotaResetInstant(context: PacingChannelContext): string | null {
  const reset = context.quota_reset_at
  return typeof reset === 'string' && Number.isFinite(Date.parse(reset)) ? reset : null
}

/**
 * Build one channel's dispatch context from the project's own upload rows and
 * the app quota ledger. Rows that name a DIFFERENT channel are left out, so a
 * hold on one channel cannot consume or block another channel's allowance; a
 * row that records no channel is kept because the project is that channel.
 */
export function pacingContextForChannel(input: {
  jobs: readonly Job[]
  policy: UploadPacingPolicy
  channelId: string | null
  quota: {
    resets_at: string
    video_uploads: { used: number, limit: number | null }
  } | null
}): PacingChannelContext {
  const scoped = input.channelId
    ? input.jobs.filter(job => {
      const id = channelOf(job)
      return id === null || id === input.channelId
    })
    : input.jobs
  const live = pacingInputsForPolicy({ jobs: scoped, policy: input.policy, quota: input.quota })
  return {
    policy: input.policy,
    recorded_transfers: live.recorded_transfers,
    quota_exhausted: live.quota_exhausted,
    quota_reset_at: live.quota_reset_at,
  }
}

/**
 * Whether a queued upload carrying a future pacing instant must be re-decided
 * by the boot scan instead of sleeping until that stored instant. The instant
 * is a hint from the process that wrote it; policy, quota and the channel's
 * window may all have changed while the app was closed (§1, §6).
 */
export function uploadPacingBootReevaluates(job: Job, nowMs = Date.now()): boolean {
  if (job.type !== 'youtube_upload' || job.status !== 'queued') return false
  const retryAt = job.params?.[PACING_RETRY_PARAM]
  if (typeof retryAt !== 'string') return false
  const retryAtMs = Date.parse(retryAt)
  return Number.isFinite(retryAtMs) && retryAtMs > nowMs
}

/**
 * Decide whether a youtube_upload job may start NOW. Returns the pure verdict,
 * or null when the channel has no configured pacing — in which case the queue
 * keeps its previous behaviour rather than inventing a policy (AGENTS §1).
 */
export function evaluateJobPacing(job: Job, inputs: PacingHoldInputs): UploadEligibilityVerdict | null {
  const context = inputs.channelContext(channelOf(job))
  if (!context) return null
  return checkUploadEligibility(
    { episode_code: job.episode_id, earliest_upload_on: uploadOnOf(job), publish_at: publishAtOf(job) },
    context.policy,
    {
      now: inputs.now ?? Date.now(),
      recorded_transfers: context.recorded_transfers,
      planned_upload_on: uploadOnOf(job),
      publish_at: publishAtOf(job),
      quota_exhausted: context.quota_exhausted,
      quota_reset_at: quotaResetInstant(context),
    },
  )
}

/**
 * Whether the queue should hold this job before starting it, and until when.
 *
 * A hold is only ever returned with a real future instant OR with no instant
 * at all (an honest "configure this channel" / "quota reset unknown" hold that
 * waits for a later pass rather than a guessed clock).
 */
export interface PacingHold {
  reason: UploadEligibilityVerdict['reason']
  detail: string
  /** The instant the queue should wake this row, or null when none is known. */
  wake_at: string | null
}

export function pacingHoldReason(job: Job, inputs: PacingHoldInputs): PacingHold | null {
  const verdict = evaluateJobPacing(job, inputs)
  if (!verdict || verdict.eligible) return null
  const wake = verdict.earliest_start && Number.isFinite(Date.parse(verdict.earliest_start))
    ? verdict.earliest_start
    : null
  return { reason: verdict.reason, detail: verdict.detail, wake_at: wake }
}

/**
 * Apply a pacing hold to the job it was decided for — the SAME durable marker
 * the queue's own quota wait uses, so a restart re-reads the instant. Never
 * touches any other job. Returns the instant the row was parked until, or null.
 */
export function applyPacingHold(job: Job, hold: PacingHold): string | null {
  if (!hold.wake_at) return null
  job.params[PACING_RETRY_PARAM] = hold.wake_at
  if (hold.reason === 'publish_deadline_conflict') job.params[PUBLISH_DEADLINE_HOLD_PARAM] = true
  return hold.wake_at
}

/**
 * The job's plain-language waiting reason IN QUEUE ORDER, read by the Upload
 * Center list. Called with the same context the pump uses, so the list and the
 * dispatch agree about why a row is not moving.
 */
export function jobWaitingReason(job: Job, inputs: PacingHoldInputs): PacingHold | null {
  if (job.status === 'paused') {
    return {
      reason: 'quota_exhausted',
      detail: job.params?.[PUBLISH_DEADLINE_HOLD_PARAM]
        ? 'Held: the publication date passed while this upload waited. Choose a new future date.'
        : 'Paused. Resume it from the queue when ready.',
      wake_at: null,
    }
  }
  return pacingHoldReason(job, inputs)
}
