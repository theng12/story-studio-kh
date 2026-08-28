import { getGenStudioUrl } from './app-settings.js'
import {
  getGenStudioCancellationStatus,
  getGenStudioJobByIdempotencyKey,
  isGenStudioTaskAbsent,
  isSettledGenStudioJob,
  requestGenStudioCancellation,
  type GenStudioCancellationFields,
  type GenStudioJob,
} from '../lib/genstudio-client.js'
import { GENSTUDIO_TASK_NOT_CREATED_STATE, isNeverCreatedProviderTask } from '../lib/provider-task-state.js'
import { idempotencyKeyFromPendingEntryId } from '../lib/genstudio-request-preview.js'
import type { Job, JobRemoteCancellation } from '../models/types.js'
import { redactSensitiveValue } from '../lib/redact-secrets.js'

type ProviderEvidenceOperation = NonNullable<Job['genstudio_jobs']>[number]['operation']

/**
 * What Story Studio records for a task GenStudio says it does not have.
 *
 * Deliberately NOT a `GenStudioJob`: that type's `state` is GenStudio's own
 * published vocabulary, and `not_created` is not in it and must never look as
 * though it is. The compiler enforcing that separation is the point.
 */
export interface AbsentProviderTask {
  id: string
  state: typeof GENSTUDIO_TASK_NOT_CREATED_STATE
  cancelled: false
  cancellation_requested: false
  cancellable: false
  /**
   * Explicit zeroes: "no such task" is a positive statement that nothing was
   * reserved, settled or released — leaving these absent would read as
   * "unknown", which is exactly what this is not.
   *
   * These are not prices and they do not follow the catalogue. There is no
   * published figure to read, because there is no task: GenStudio confirmed it
   * never created one. A model's rate is what a task WOULD have cost; this
   * records what a task that does not exist DID cost, which is nothing, for
   * every model, for ever.
   */
  // model-drift-allow: a task GenStudio confirms it never created cost nothing; there is no catalogue figure for a request that does not exist
  reserved_credits: 0
  // model-drift-allow: as above — nothing was reserved, so nothing settled
  settled_credits: 0
  // model-drift-allow: as above — nothing was reserved, so there is nothing to release
  released_credits: 0
}

export type ReconciledProviderTask = (GenStudioJob & GenStudioCancellationFields) | AbsentProviderTask

type ReconcileEvidence = {
  records: Record<string, JobRemoteCancellation>
  providerJobs: Array<{ operation: ProviderEvidenceOperation; evidence_id: string; job: ReconciledProviderTask }>
  reason?: string
  /**
   * v1.2.8 — provider tasks GenStudio answered a lookup for by saying it has
   * no such task. Reported separately from `reason` on purpose: `reason` means
   * "still waiting", and these are finished questions with a definite answer.
   */
  absent: Array<{ operation: ProviderEvidenceOperation; evidence_id: string }>
}

export type JobCancellationReconcileOutcome = ReconcileEvidence & (
  | { kind: 'pending' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'succeeded' }
)

const PENDING = new Set<JobRemoteCancellation['status']>(['queued', 'submitting', 'requested', 'reconciling', 'unknown'])
const REMOTE_OPERATIONS = new Set<JobRemoteCancellation['operation']>([
  'voice.tts', 'audio.transcription', 'image.generation', 'video.generation', 'chat.response', 'music.generation',
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
    ...(provider.dispatch_state !== undefined ? { dispatch_state: provider.dispatch_state } : {}),
    ...(provider.cancellable !== undefined ? { cancellable: provider.cancellable } : {}),
    ...(provider.cancelled !== undefined ? { cancelled: provider.cancelled } : {}),
    ...(provider.cancellation_requested !== undefined ? { cancellation_requested: provider.cancellation_requested } : {}),
    ...(provider.cancellation_note !== undefined ? { cancellation_note: provider.cancellation_note } : {}),
    ...(provider.failure_code !== undefined ? { failure_code: provider.failure_code } : {}),
    ...(typeof provider.reserved_credits === 'number' && Number.isFinite(provider.reserved_credits) ? { reserved_credits: provider.reserved_credits } : {}),
    ...(typeof provider.settled_credits === 'number' && Number.isFinite(provider.settled_credits) ? { settled_credits: provider.settled_credits } : {}),
    ...(typeof provider.released_credits === 'number' && Number.isFinite(provider.released_credits) ? { released_credits: provider.released_credits } : {}),
    updated_at: new Date().toISOString(),
  }
}

function absentProviderTask(evidenceId: string): AbsentProviderTask {
  return {
    id: evidenceId,
    state: GENSTUDIO_TASK_NOT_CREATED_STATE,
    cancelled: false,
    cancellation_requested: false,
    cancellable: false,
    // model-drift-allow: see AbsentProviderTask — a task GenStudio confirms it never created cost nothing, for every model
    reserved_credits: 0,
    // model-drift-allow: as above — nothing was reserved, so nothing settled
    settled_credits: 0,
    // model-drift-allow: as above — nothing was reserved, so there is nothing to release
    released_credits: 0,
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

export interface ReconcileOptions {
  /**
   * v1.2.6 — read-only mode: re-read provider state but never issue the
   * cancellation POST. Used when refreshing the stored evidence of a job that
   * has already FINISHED. Such a job is not asking to be cancelled — it is
   * only asking whether the work it recorded has settled — and a stranded
   * `submitting` marker on a finished job must not turn a status question into
   * a control request.
   */
  readOnly?: boolean
}

/**
 * Re-read existing GenStudio work after restart. A record reaches this helper
 * only after the queue durably claimed a cancellation attempt (`submitting`).
 * Therefore it performs no generation POST and issues a cancellation POST only
 * when the fresh provider read still publishes that exact task as cancellable
 * — and never at all in `readOnly` mode.
 */
export async function reconcilePendingJobCancellation(
  job: Job,
  apiKey: string,
  options: ReconcileOptions = {},
): Promise<JobCancellationReconcileOutcome> {
  const records = { ...(job.remote_cancellations || {}) }
  const pending = Object.entries(records).filter(([, record]) => PENDING.has(record.status))
  const providerJobs: ReconcileEvidence['providerJobs'] = []
  const absent: ReconcileEvidence['absent'] = []
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
      if (!options.readOnly && record.status === 'submitting' && provider.dispatch_state === 'pre_dispatch' && provider.cancellable === true && !isSettledGenStudioJob(provider)) {
        provider = await requestGenStudioCancellation(
          record.operation, baseUrl, apiKey, record.provider_job_id, {}, deadline,
        )
      }
      records[key] = asRecord(record, provider, observedStatus(provider))
      providerJobs.push({ operation: record.operation, evidence_id: record.provider_job_id, job: provider })
    } catch (error) {
      // v1.2.8 — GenStudio ANSWERED, and the answer is that it has no such
      // task. That is a verdict, not a gap in Story Studio's reach, so it
      // resolves this record instead of preserving the hold forever.
      if (isGenStudioTaskAbsent(error)) {
        const { reconciliation_error: _cleared, ...cleanRecord } = record
        records[key] = {
          ...cleanRecord,
          status: 'absent',
          state: GENSTUDIO_TASK_NOT_CREATED_STATE,
          http_status: 404,
          updated_at: new Date().toISOString(),
        }
        absent.push({ operation: record.operation, evidence_id: record.provider_job_id })
        continue
      }
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
  const observed = new Set(providerJobs.map(item => `${item.operation}:${item.evidence_id}`))
  for (const evidence of job.genstudio_jobs || []) {
    // v1.2.9 — the placeholder id already contains the idempotency key, so an
    // entry that still has one is never actually keyless. Reading it only from
    // the `request` preview meant a batch larger than
    // GENSTUDIO_REQUEST_PREVIEW_RETAINED declared itself unreconcilable the
    // moment the older previews were pruned, and then said so to the owner as
    // if it were a fact about the evidence rather than about where we looked.
    const idempotencyKey = evidence.request?.idempotency_key
      || idempotencyKeyFromPendingEntryId(evidence.id || '')
      || undefined
    const pendingEvidence = !evidence.id || evidence.id.startsWith('pending:')
    const evidenceId = evidence.id || (idempotencyKey ? `pending:${idempotencyKey}` : '')
    if (pendingEvidence && !idempotencyKey) {
      return { kind: 'pending', records, providerJobs, absent, reason: 'Story Studio cannot reconcile provider evidence without a durable task identity or saved idempotency key.' }
    }
    const key = `${evidence.operation}:${evidenceId}`
    if (observed.has(key)) continue
    // Already recorded as never created by an earlier pass. Asking again would
    // get the same 404 and cost a round trip per reconciliation tick.
    if (isNeverCreatedProviderTask(evidence)) {
      providerJobs.push({ operation: evidence.operation, evidence_id: evidenceId, job: absentProviderTask(evidenceId) })
      observed.add(key)
      absent.push({ operation: evidence.operation, evidence_id: evidenceId })
      continue
    }
    try {
      const provider = isRemoteOperation(evidence.operation)
        ? pendingEvidence
          ? await getGenStudioJobByIdempotencyKey(evidence.operation, baseUrl, apiKey, idempotencyKey!, {}, deadline)
          : await getGenStudioCancellationStatus(evidence.operation, baseUrl, apiKey, evidenceId, {}, deadline)
        : null
      if (!provider) {
        return { kind: 'pending', records, providerJobs, absent, reason: `${evidence.operation} ${evidenceId} has no published read-only reconciliation path. Provider work may still settle.` }
      }
      providerJobs.push({ operation: evidence.operation, evidence_id: evidenceId, job: provider })
      observed.add(key)
    } catch (error) {
      // v1.2.8 — GenStudio does not have this task. Whether the id was durable
      // or only an idempotency key, "no such request for this account" means
      // it was never created: nothing ran, nothing was reserved, nothing was
      // charged. Record it as terminal and keep going, rather than holding the
      // whole job on an outcome that will never arrive.
      if (isGenStudioTaskAbsent(error)) {
        providerJobs.push({ operation: evidence.operation, evidence_id: evidenceId, job: absentProviderTask(evidenceId) })
        observed.add(key)
        absent.push({ operation: evidence.operation, evidence_id: evidenceId })
        continue
      }
      // The exact accepted target cannot be proven terminal. This includes an
      // unavailable API key/service and is intentionally a nonterminal hold.
      return { kind: 'pending', records, providerJobs, absent, reason: reconciliationError(error) }
    }
  }

  const values = Object.values(records)
  if (values.some(record => PENDING.has(record.status))) return { kind: 'pending', records, providerJobs, absent, reason }
  if (providerJobs.some(item => !isSettledGenStudioJob(item.job))) return { kind: 'pending', records, providerJobs, absent, reason }
  if (providerJobs.some(item => item.job.state === 'failed' && item.job.cancelled !== true)) {
    return { kind: 'failed', records, providerJobs, absent, reason }
  }
  if (providerJobs.length && providerJobs.every(item => item.job.cancelled === true)) return { kind: 'cancelled', records, providerJobs, absent, reason }
  // A partial success plus cancellation is not a verified complete output
  // set. The queue turns this into the same repair-first Error as a failed
  // provider target; never let one successful sibling green-light the job.
  if (providerJobs.some(item => item.job.cancelled === true)) return { kind: 'failed', records, providerJobs, absent, reason }
  // Same reasoning for a task that was never created: whatever it was meant to
  // produce does not exist, so the recorded output set is incomplete. This is
  // the repair-first Error, never a green job — but it IS terminal, which is
  // the whole point. The batch stops waiting.
  if (absent.length) return { kind: 'failed', records, providerJobs, absent, reason }
  if (providerJobs.length && providerJobs.every(item => item.job.state === 'succeeded')) return { kind: 'succeeded', records, providerJobs, absent, reason }
  return { kind: 'pending', records, providerJobs, absent, reason }
}
