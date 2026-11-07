/**
 * Live pacing inputs for one channel (Story 386 Item 1).
 *
 * The ONE place that turns "what has this channel already uploaded recently,
 * and what is already queued for it" into the data shape the pure pacing
 * service consumes. It reads the EXISTING persistent sources — the app quota
 * ledger, the project's youtube_upload job rows and their sidecars — and never
 * keeps a parallel ledger of its own.
 *
 * `recorded_transfers` are completed / in-progress transfers (what the channel
 * day already consumed). `quota_*` come straight from the app-scoped quota
 * ledger, so the hold instant is the ledger's own reset, never a guess.
 */

import type { Job } from '../models/types.js'
import type { PacedSlot, RecordedTransfer, UploadPacingPolicy } from './upload-pacing.js'
import { getQuotaDayKey } from './upload-pacing.js'

/** One recorded transfer, as the pacing service needs it. */
export interface PacingLiveContext {
  recorded_transfers: RecordedTransfer[]
  existing_planned_slots: PacedSlot[]
  quota_exhausted: boolean
  quota_reset_at: string | null
  quota_timezone: string
}

/**
 * Turn the project's upload jobs plus the quota snapshot into the pacing inputs
 * for a policy. Pure over its arguments so the route, the queue and the tests
 * all agree.
 *
 * `jobs` should be the project's `youtube_upload` rows (queued/running/paused
 * count as planned slots; done rows whose channel matches count as transfers).
 */
export function pacingInputsForPolicy(input: {
  jobs: readonly Job[]
  policy: UploadPacingPolicy
  quota: {
    resets_at: string
    video_uploads: { used: number, limit: number | null }
  } | null
  quotaTimezone?: string
}): PacingLiveContext {
  const quotaTimezone = input.quotaTimezone || 'America/Los_Angeles'
  const recorded: RecordedTransfer[] = []
  const planned: PacedSlot[] = []

  for (const job of input.jobs) {
    if (job.type !== 'youtube_upload') continue
    if (job.status === 'done') {
      const at = job.finished_at || job.started_at || job.created_at
      if (at) {
        recorded.push({ episode_code: job.episode_id, started_at: at, completed_at: job.finished_at, status: 'completed' })
      }
      continue
    }
    if (job.status === 'error' || job.status === 'cancelled') continue
    // A queued / running / paused upload already owns a future slot IF it
    // carries an upload_on; a queued upload with no date is not yet planned.
    const uploadOn = typeof job.params?.upload_on === 'string' ? job.params.upload_on : null
    if (!uploadOn || !Number.isFinite(Date.parse(uploadOn))) continue
    const channelDay = input.policy.timezone
    const plannedAt = Date.parse(uploadOn)
    planned.push({
      episode_code: job.episode_id,
      upload_on: uploadOn,
      publish_at: null,
      channel_day_key: safeDayKey(plannedAt, channelDay),
      quota_day_key: getQuotaDayKey(plannedAt, quotaTimezone),
      slot_index_today: 0,
      daily_limit: input.policy.daily_limit,
    })
  }

  const quotaExhausted = !!input.quota
    && input.quota.video_uploads.limit !== null
    && input.quota.video_uploads.used >= input.quota.video_uploads.limit

  return {
    recorded_transfers: recorded,
    existing_planned_slots: planned,
    quota_exhausted: quotaExhausted,
    quota_reset_at: input.quota?.resets_at ?? null,
    quota_timezone: quotaTimezone,
  }
}

function safeDayKey(instantMs: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(instantMs))
    const y = parts.find(p => p.type === 'year')?.value
    const m = parts.find(p => p.type === 'month')?.value
    const d = parts.find(p => p.type === 'day')?.value
    return y && m && d ? `${y}-${m}-${d}` : ''
  } catch {
    return ''
  }
}
