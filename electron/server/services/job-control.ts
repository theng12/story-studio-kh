import type {
  Job,
  JobControl,
  JobControlCapabilities,
  JobRemoteOperation,
} from '../models/types.js'
import { isProvenLocalStopCapableJob as isSafelyStoppableLocalJob } from './job-retry-policy.js'

export { isSafelyStoppableLocalJob as isProvenLocalStopCapableJob }
export type { JobControl, JobControlCapabilities }

type JobEvidence = NonNullable<Job['genstudio_jobs']>[number]

const REMOTE_OPERATIONS = new Set<JobRemoteOperation>([
  'voice.tts',
  'audio.transcription',
  'image.generation',
  'video.generation',
])

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled'])
const PENDING_CANCELLATION_STATES = new Set(['queued', 'submitting', 'requested', 'reconciling', 'unknown'])
const VIDEO_POST_DISPATCH_STATES = new Set(['dispatched', 'running', 'validating', 'reconciling'])

function control(
  action: JobControl['action'],
  enabled: boolean,
  label: string,
  reason: string,
  code: JobControl['code'],
  financialEffect: JobControl['financial_effect'],
  targets?: JobControl['targets'],
): JobControl {
  return { action, enabled, label, reason, code, financial_effect: financialEffect, ...(targets?.length ? { targets } : {}) }
}

function isRemoteOperation(operation: string): operation is JobRemoteOperation {
  return REMOTE_OPERATIONS.has(operation as JobRemoteOperation)
}

function isProviderTerminal(entry: JobEvidence): boolean {
  return TERMINAL_STATES.has(entry.state) || entry.cancelled === true
}

function isSubmissionUncertain(entry: JobEvidence): boolean {
  return entry.state === 'submitting' || entry.queue_state === 'submitting'
}

function targetFor(entry: JobEvidence): { operation: JobRemoteOperation; provider_job_id: string } | null {
  if (!isRemoteOperation(entry.operation) || !entry.id) return null
  return { operation: entry.operation, provider_job_id: entry.id }
}

function describes(entry: JobEvidence): string {
  return `${entry.operation} ${entry.id || 'with no provider job ID'}`
}

/**
 * The single authority for active-job controls. It deliberately needs actual
 * GenStudio evidence before offering a provider cancellation request.
 */
export function classifyJobControl(
  job: Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations'>,
  capabilities: JobControlCapabilities,
): JobControl {
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    return control('clear-history', true, 'Remove from history', 'This finished job can be removed from the job list. Its files and provider evidence stay intact.', 'READY', 'history-only')
  }

  if (job.status === 'queued' || job.status === 'paused') {
    return control('cancel-before-submit', true, 'Cancel', 'This job has not submitted provider work.', 'READY', 'no-provider-request')
  }

  if (Object.values(job.remote_cancellations || {}).some(record => PENDING_CANCELLATION_STATES.has(record.status))) {
    return control('return-later', false, 'Checking cancellation', 'Story Studio is waiting for GenStudio to confirm the cancellation result. The provider work may still settle.', 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  const evidence = job.genstudio_jobs || []
  if (!evidence.length) {
    if (isSafelyStoppableLocalJob(job)) {
      return control('stop-local', true, 'Stop local work', 'This local job has a proven cooperative or child-process stop path.', 'READY', 'local-only')
    }
    return control('pause-submissions', false, 'Pause new submissions', 'This running job has no proven safe local stop. Let its current work settle before starting more.', 'JOB_NOT_AT_SAFE_LOCAL_STOP', 'none')
  }

  if (evidence.some(isSubmissionUncertain)) {
    return control('return-later', false, 'Checking submission', 'Story Studio cannot yet prove whether every provider request was accepted. It will reconcile before any new submission.', 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  const active = evidence.filter(entry => !isProviderTerminal(entry))
  const unsupported = active.filter(entry => !isRemoteOperation(entry.operation))
  if (unsupported.length) {
    return control('return-later', false, 'Return later', `${unsupported.map(describes).join(', ')} does not publish a cancellation endpoint. Provider work may still settle.`, 'REMOTE_CANCELLATION_NOT_SUPPORTED', 'provider-work-may-settle')
  }

  const targets: NonNullable<JobControl['targets']> = []
  const continuing: JobEvidence[] = []
  const ambiguous: JobEvidence[] = []
  for (const entry of active) {
    const target = targetFor(entry)
    if (!target) {
      ambiguous.push(entry)
      continue
    }
    if (entry.operation === 'video.generation' && VIDEO_POST_DISPATCH_STATES.has(entry.state)) {
      targets.push(target)
      continue
    }
    if (entry.cancellable === true) {
      targets.push(target)
      continue
    }
    if (entry.cancellable === false || entry.state === 'running' || entry.state === 'dispatched' || entry.state === 'validating') {
      continuing.push(entry)
      continue
    }
    ambiguous.push(entry)
  }

  if (ambiguous.length) {
    return control('return-later', false, 'Checking provider status', `${ambiguous.map(describes).join(', ')} has no authoritative cancellation state yet. Story Studio will keep the duplicate lock and reconcile it.`, 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  if (targets.length && capabilities.remoteCancellationAudited) {
    const continuingReason = continuing.length
      ? ` ${continuing.map(describes).join(', ')} already started and will continue settling.`
      : ''
    return control('request-remote-cancel', true, 'Request cancellation', `Story Studio will ask GenStudio to cancel ${targets.length === 1 ? 'the eligible provider task' : `${targets.length} eligible provider tasks`}; GenStudio determines whether credits are released.${continuingReason}`, 'READY', 'remote-result-required', targets)
  }

  if (targets.length) {
    return control('return-later', false, 'Return later', 'This job has no registered output auditor, so Story Studio cannot safely reconcile provider cancellation. Provider work may still settle.', 'REMOTE_CANCELLATION_NOT_SUPPORTED', 'provider-work-may-settle')
  }

  if (continuing.length) {
    return control('pause-submissions', false, 'Pause new submissions', `${continuing.map(describes).join(', ')} already started and will continue settling. New provider submissions can be paused, but this request cannot be cancelled.`, 'PROVIDER_WORK_ALREADY_STARTED', 'provider-work-may-settle')
  }

  return control('return-later', false, 'Return later', 'Story Studio is waiting for authoritative provider settlement.', 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
}
