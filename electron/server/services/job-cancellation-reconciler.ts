import { getGenStudioUrl } from './app-settings.js'
import {
  getGenStudioCancellationStatus,
  isSettledGenStudioJob,
  requestGenStudioCancellation,
  type GenStudioCancellationFields,
  type GenStudioJob,
} from '../lib/genstudio-client.js'
import type { Job, JobRemoteCancellation } from '../models/types.js'
import { redactSensitiveValue } from '../lib/redact-secrets.js'

type ReconcileEvidence = {
  records: Record<string, JobRemoteCancellation>
  providerJobs: Array<{ operation: JobRemoteCancellation['operation']; job: GenStudioJob & GenStudioCancellationFields }>
  reason?: string
}

export type JobCancellationReconcileOutcome = ReconcileEvidence & (
  | { kind: 'pending' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'succeeded' }
)

const PENDING = new Set<JobRemoteCancellation['status']>(['queued', 'submitting', 'requested', 'reconciling', 'unknown'])
const REMOTE_OPERATIONS = new Set<JobRemoteCancellation['operation']>([
  'voice.tts', 'audio.transcription', 'image.generation', 'video.generation',
])

function isRemoteOperation(value: string): value is JobRemoteCancellation['operation'] {
  return REMOTE_OPERATIONS.has(value as JobRemoteCancellation['operation'])
}

function asRecord(
  prior: JobRemoteCancellation,
  provider: GenStudioJob & GenStudioCancellationFields,
  status: JobRemoteCancellation['status'],
): JobRemoteCancellation {
  const { reconciliation_error: _priorError, ...cleanPrior } = prior
  return {
    ...cleanPrior,
    status,
    state: provider.state,
    ...(provider.cancellable !== undefined ? { cancellable: provider.cancellable } : {}),
    ...(provider.cancelled !== undefined ? { cancelled: provider.cancelled } : {}),
    ...(provider.cancellation_requested !== undefined ? { cancellation_requested: provider.cancellation_requested } : {}),
    ...(provider.cancellation_note !== undefined ? { cancellation_note: provider.cancellation_note } : {}),
    ...(provider.failure_code !== undefined ? { failure_code: provider.failure_code } : {}),
    ...(Number.isFinite(provider.released_credits) ? { released_credits: provider.released_credits } : {}),
    updated_at: new Date().toISOString(),
  }
}

function observedStatus(provider: GenStudioJob & GenStudioCancellationFields): JobRemoteCancellation['status'] {
  if (provider.cancelled === true) return 'confirmed'
  if (isSettledGenStudioJob(provider)) return 'rejected'
  if (provider.cancellation_requested === true) return 'requested'
  return 'reconciling'
}

function reconciliationError(error: unknown): string {
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? `HTTP ${(error as { status: number }).status}: `
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return redactSensitiveValue(`GenStudio status check is waiting (${status}${message})`).slice(0, 320)
}

/**
 * Re-read existing GenStudio work after restart. A record reaches this helper
 * only after the queue durably claimed a cancellation attempt (`submitting`).
 * Therefore it performs no generation POST and issues a cancellation POST only
 * when the fresh provider read still publishes that exact task as cancellable.
 */
export async function reconcilePendingJobCancellation(
  job: Job,
  apiKey: string,
): Promise<JobCancellationReconcileOutcome> {
  const records = { ...(job.remote_cancellations || {}) }
  const pending = Object.entries(records).filter(([, record]) => PENDING.has(record.status))
  const providerJobs: Array<{ operation: JobRemoteCancellation['operation']; job: GenStudioJob & GenStudioCancellationFields }> = []
  let reason: string | undefined

  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + 30_000
  for (const [key, record] of pending) {
    try {
      let provider = await getGenStudioCancellationStatus(
        record.operation, baseUrl, apiKey, record.provider_job_id, {}, deadline,
      )
      // `submitting` is a crash-recovery ownership marker. A fresh GET proves
      // the provider is still pre-dispatch before we repeat the idempotent
      // control request. `unknown` deliberately never retries blindly.
      if (record.status === 'submitting' && provider.cancellable === true && !isSettledGenStudioJob(provider)) {
        provider = await requestGenStudioCancellation(
          record.operation, baseUrl, apiKey, record.provider_job_id, {}, deadline,
        )
      }
      records[key] = asRecord(record, provider, observedStatus(provider))
      providerJobs.push({ operation: record.operation, job: provider })
    } catch (error) {
      // Missing credentials, a stopped GenStudio service, and a malformed
      // status response are not evidence that the provider stopped. Preserve
      // the duplicate lock and let a later control-plane read decide.
      const errorReason = reconciliationError(error)
      records[key] = {
        ...record, status: 'unknown', reconciliation_error: errorReason,
        updated_at: new Date().toISOString(),
      }
      reason = errorReason
    }
  }

  // A Story job may have a mix of eligible and already-dispatched provider
  // targets. The latter are not cancellation records, but still must settle
  // before this job releases its duplicate lock or claims verified success.
  const observed = new Set(providerJobs.map(item => `${item.operation}:${item.job.id}`))
  for (const evidence of job.genstudio_jobs || []) {
    if (!evidence.id || !isRemoteOperation(evidence.operation)) continue
    const key = `${evidence.operation}:${evidence.id}`
    if (observed.has(key)) continue
    try {
      const provider = await getGenStudioCancellationStatus(
        evidence.operation, baseUrl, apiKey, evidence.id, {}, deadline,
      )
      providerJobs.push({ operation: evidence.operation, job: provider })
      observed.add(key)
    } catch (error) {
      // The exact accepted target cannot be proven terminal. This includes an
      // unavailable API key/service and is intentionally a nonterminal hold.
      return { kind: 'pending', records, providerJobs, reason: reconciliationError(error) }
    }
  }

  const values = Object.values(records)
  if (values.some(record => PENDING.has(record.status))) return { kind: 'pending', records, providerJobs, reason }
  if (providerJobs.some(item => !isSettledGenStudioJob(item.job))) return { kind: 'pending', records, providerJobs, reason }
  if (providerJobs.some(item => item.job.state === 'failed' && item.job.cancelled !== true)) {
    return { kind: 'failed', records, providerJobs, reason }
  }
  if (providerJobs.length && providerJobs.every(item => item.job.cancelled === true)) return { kind: 'cancelled', records, providerJobs, reason }
  // A partial success plus cancellation is not a verified complete output
  // set. The queue turns this into the same repair-first Error as a failed
  // provider target; never let one successful sibling green-light the job.
  if (providerJobs.some(item => item.job.cancelled === true)) return { kind: 'failed', records, providerJobs, reason }
  if (providerJobs.length && providerJobs.every(item => item.job.state === 'succeeded')) return { kind: 'succeeded', records, providerJobs, reason }
  return { kind: 'pending', records, providerJobs, reason }
}
