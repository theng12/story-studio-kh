import type {
  Job,
  JobControl,
  JobControlCapabilities,
  JobRemoteOperation,
} from '../models/types.js'
import { GENSTUDIO_TASK_NOT_CREATED_STATE } from '../lib/provider-task-state.js'
import { isProvenLocalStopCapableJob as isSafelyStoppableLocalJob } from './job-retry-policy.js'

export { isSafelyStoppableLocalJob as isProvenLocalStopCapableJob }
export type { JobControl, JobControlCapabilities }

type JobEvidence = NonNullable<Job['genstudio_jobs']>[number]

const REMOTE_OPERATIONS = new Set<JobRemoteOperation>([
  'voice.tts',
  'audio.transcription',
  'image.generation',
  'video.generation',
  'chat.response',
  'music.generation',
])

// `not_created` is Story Studio's record that GenStudio answered and has no
// such task (v1.2.8). It belongs here for the same reason `failed` does:
// nothing about it can change again.
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', GENSTUDIO_TASK_NOT_CREATED_STATE])
const PENDING_CANCELLATION_STATES = new Set(['queued', 'submitting', 'requested', 'reconciling', 'unknown'])
const PAUSABLE_SUBMISSION_TYPES = new Set<Job['type']>([
  // These executors check the cooperative pause marker between submissions.
  // Image batches currently do not, so advertising Pause there would let an
  // in-flight batch continue submitting work after promising otherwise.
  'audio', 'subtitles_transcribe', 'continuity_render', 'scene_images_batch',
])

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

/** Name the provider tasks this job recorded as unfinished, without a wall of ids. */
function describeUnsettled(
  job: Pick<Job, 'genstudio_jobs' | 'remote_cancellations'>,
  evidence: JobEvidence[],
): { text: string; plural: boolean } {
  const names = evidence.filter(entry => !isProviderTerminal(entry)).map(describes)
  for (const record of Object.values(job.remote_cancellations || {})) {
    if (!PENDING_CANCELLATION_STATES.has(record.status)) continue
    const name = `${record.operation} ${record.provider_job_id}`
    if (!names.includes(name)) names.push(name)
  }
  if (!names.length) return { text: 'this job\'s provider work', plural: false }
  const plural = names.length > 1
  if (names.length <= 3) return { text: names.join(', '), plural }
  const rest = names.length - 3
  return { text: `${names.slice(0, 3).join(', ')} and ${rest} more provider task${rest === 1 ? '' : 's'}`, plural }
}

/**
 * v1.2.6 — the finished-job dismiss gate, after the re-check.
 *
 * The gate's intent is unchanged: history must not be discarded while provider
 * work genuinely might still settle. What changed is that Story Studio now
 * ASKS before saying so, and never describes the provider's state from a
 * snapshot it has not refreshed. Three distinct answers, three distinct
 * messages — a failed lookup is a statement about Story Studio's reach, not
 * about the provider.
 */
function unsettledHistoryControl(
  job: Pick<Job, 'genstudio_jobs' | 'remote_cancellations' | 'history_evidence_check'>,
  evidence: JobEvidence[],
): JobControl {
  const { text: outstanding, plural } = describeUnsettled(job, evidence)
  const check = job.history_evidence_check
  if (check?.state === 'unreachable') {
    const detail = check.detail ? ` ${check.detail}` : ''
    return control(
      'recheck-provider-status', true, 'Check GenStudio again',
      `Story Studio could not reach GenStudio to confirm whether ${outstanding} finished, so it cannot say whether that work is still running.${detail}`,
      'PROVIDER_STATUS_UNREACHABLE', 'remote-result-required',
    )
  }
  if (check?.state === 'unsettled') {
    return control(
      'recheck-provider-status', true, 'Check GenStudio again',
      `GenStudio reports that ${outstanding} ${plural ? 'have' : 'has'} not finished yet, so Story Studio is keeping this history until that work settles.`,
      'PROVIDER_WORK_ALREADY_STARTED', 'remote-result-required',
    )
  }
  // No answer yet — a check is running or about to. The button says what is
  // actually happening, and stays disabled only for as long as that is true.
  return control(
    'return-later', false, 'Checking provider status',
    `Story Studio is asking GenStudio whether ${outstanding} finished. This history can be removed as soon as GenStudio confirms ${plural ? 'they have' : 'it has'}.`,
    'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required',
  )
}

/**
 * v1.2.8 — the owner override.
 *
 * Every other control here is earned: it is offered only when Story Studio can
 * prove the action is safe. That is the right default and it is unchanged. But
 * taken absolutely it produced a job with no exit at all — a
 * `reconciliation_error` disabled cancel, Delete refused a non-terminal job,
 * and the only remaining button said "Checking provider status" forever. Three
 * of the owner's jobs reached that state at once, and nothing in the product
 * could clear them.
 *
 * So this one is not earned from evidence. It is available because he says so,
 * and it is honest in the same breath about the three things it cannot do. The
 * wording is the confirmation the user reads before clicking — it is not a
 * warning designed to frighten, because he has already accepted every one of
 * these consequences; it is a statement of what will and will not happen.
 */
const FORCE_ABANDON_REASON =
  'Story Studio stops tracking this job and the queue moves on. '
  + 'It does not cancel provider work GenStudio has already accepted. '
  + 'It does not refund credits already spent. '
  + 'Output may still arrive, and it stays recoverable from the episode afterwards. '
  + 'Use this when a job is stuck and you would rather move on than keep waiting.'

function forceAbandonControl(): JobControl {
  return control(
    'force-abandon', true, 'Abandon this job', FORCE_ABANDON_REASON,
    'OWNER_OVERRIDE', 'provider-work-may-settle',
  )
}

function isFinishedJob(status: Job['status']): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}

/**
 * The single authority for active-job controls. It deliberately needs actual
 * GenStudio evidence before offering a provider cancellation request.
 */
function classifyProviderJobControl(
  job: Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations' | 'reconciliation_error' | 'history_evidence_check' | 'force_abandoned'>,
  capabilities: JobControlCapabilities,
): JobControl {
  const evidence = job.genstudio_jobs || []
  // An abandoned job is one the owner told Story Studio to stop tracking. The
  // unsettled-evidence gate below would immediately re-trap it in exactly the
  // dead end he just escaped, so it does not apply here. Nothing is discarded:
  // the provider evidence, the files and the billing record all survive
  // removing the row, and the reason says so.
  if (job.force_abandoned && isFinishedJob(job.status)) {
    return control(
      'clear-history', true, 'Remove from history',
      'You abandoned this job, so Story Studio is no longer waiting on it. Removing the row leaves its files, its provider evidence and its billing record untouched.',
      'READY', 'history-only',
    )
  }
  const unsettledEvidence = evidence.some(entry => (
    entry.cancelled !== true && !TERMINAL_STATES.has(entry.state)
  )) || Object.values(job.remote_cancellations || {}).some(record => PENDING_CANCELLATION_STATES.has(record.status))
  if ((job.status === 'done' || job.status === 'error' || job.status === 'cancelled') && unsettledEvidence) {
    // v1.2.6 — `genstudio_jobs` is a snapshot taken while the job ran, not a
    // live reading. An entry that was mid-flight when it was written stays
    // mid-flight forever, so this gate used to assert "durable provider work
    // is still settling" about work that had settled long ago, and offered a
    // disabled button labelled "Checking provider status" that checked
    // nothing. The queue now re-asks GenStudio (see
    // refreshFinishedJobProviderEvidence in job-queue.ts) and records the
    // answer, and each of the three outcomes gets its own honest wording.
    return unsettledHistoryControl(job, evidence)
  }
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    return control('clear-history', true, 'Remove from history', 'This finished job can be removed from the job list. Its files and provider evidence stay intact.', 'READY', 'history-only')
  }

  if ((job.status === 'queued' || job.status === 'paused') && !evidence.length && !Object.keys(job.remote_cancellations || {}).length) {
    return control('cancel-before-submit', true, 'Cancel', 'This job has not submitted provider work.', 'READY', 'no-provider-request')
  }

  const pendingCancellation = Object.values(job.remote_cancellations || {}).find(record => PENDING_CANCELLATION_STATES.has(record.status))
  if (pendingCancellation) {
    const detail = pendingCancellation.reconciliation_error || job.reconciliation_error
      ? ` ${pendingCancellation.reconciliation_error || job.reconciliation_error}`
      : ''
    return control('return-later', false, 'Checking cancellation', `Story Studio is waiting for GenStudio to confirm the cancellation result. The provider work may still settle.${detail}`, 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  if (job.reconciliation_error) {
    return control('return-later', false, 'Checking provider status', `Story Studio cannot yet confirm every accepted provider task. ${job.reconciliation_error}`, 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  if (!evidence.length) {
    if (isSafelyStoppableLocalJob(job)) {
      return control('stop-local', true, 'Stop local work', 'This local job has a proven cooperative or child-process stop path.', 'READY', 'local-only')
    }
    return control('pause-submissions', PAUSABLE_SUBMISSION_TYPES.has(job.type), 'Pause new submissions', 'This running job has no proven safe local stop. Let its current work settle before starting more.', 'JOB_NOT_AT_SAFE_LOCAL_STOP', 'none')
  }

  if (evidence.some(isSubmissionUncertain)) {
    return control('return-later', false, 'Checking submission', 'Story Studio cannot yet prove whether every provider request was accepted. It will reconcile before any new submission.', 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  const active = evidence.filter(entry => !isProviderTerminal(entry))
  const targets: NonNullable<JobControl['targets']> = []
  const continuing: JobEvidence[] = []
  const unsupported: JobEvidence[] = []
  const ambiguous: JobEvidence[] = []
  for (const entry of active) {
    if (!isRemoteOperation(entry.operation)) {
      unsupported.push(entry)
      continue
    }
    const target = targetFor(entry)
    if (!target) {
      ambiguous.push(entry)
      continue
    }
    if (entry.dispatch_state !== 'pre_dispatch' && entry.dispatch_state !== 'dispatched') {
      ambiguous.push(entry)
      continue
    }
    if (entry.dispatch_state === 'pre_dispatch' && entry.cancellable === true) {
      targets.push(target)
      continue
    }
    continuing.push(entry)
  }

  if (ambiguous.length) {
    return control('return-later', false, 'Checking provider status', `${ambiguous.map(describes).join(', ')} has no authoritative cancellation state yet. Story Studio will keep the duplicate lock and reconcile it.`, 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  if (targets.length && capabilities.remoteCancellationAudited) {
    const settling = [...continuing, ...unsupported]
    const continuingReason = settling.length
      ? ` ${settling.map(describes).join(', ')} already started and will continue settling.`
      : ''
    return control('request-remote-cancel', true, 'Request cancellation', `Story Studio will ask GenStudio to cancel ${targets.length === 1 ? 'the eligible provider task' : `${targets.length} eligible provider tasks`}; GenStudio determines whether credits are released.${continuingReason}`, 'READY', 'remote-result-required', targets)
  }

  if (targets.length) {
    return control('return-later', false, 'Return later', 'This job has no registered output auditor, so Story Studio cannot safely reconcile provider cancellation. Provider work may still settle.', 'REMOTE_CANCELLATION_NOT_SUPPORTED', 'provider-work-may-settle')
  }

  if (unsupported.length) {
    return control('return-later', false, 'Return later', `${unsupported.map(describes).join(', ')} does not publish a cancellation endpoint. Provider work may still settle.`, 'REMOTE_CANCELLATION_NOT_SUPPORTED', 'provider-work-may-settle')
  }

  if (continuing.length) {
    return control('pause-submissions', PAUSABLE_SUBMISSION_TYPES.has(job.type), 'Pause new submissions', `${continuing.map(describes).join(', ')} already started and will continue settling. New provider submissions can be paused, but this request cannot be cancelled.`, 'PROVIDER_WORK_ALREADY_STARTED', 'provider-work-may-settle')
  }

  return control('return-later', false, 'Return later', 'Story Studio is waiting for authoritative provider settlement.', 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
}

/**
 * A batch may safely expose two independent controls at once: pausing future
 * submissions and asking GenStudio to cancel exact pre-dispatch targets.
 * Neither action is allowed to impersonate the other.
 */
export function classifyJobControls(
  job: Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations' | 'reconciliation_error' | 'history_evidence_check' | 'force_abandoned'>,
  capabilities: JobControlCapabilities,
): JobControl[] {
  const provider = classifyProviderJobControl(job, capabilities)
  const canPause = job.status === 'running' && PAUSABLE_SUBMISSION_TYPES.has(job.type)
  const pause = canPause
    ? control(
      'pause-submissions',
      true,
      'Pause new submissions',
      'Story Studio will stop claiming new items. Already accepted work will finish settling and checkpointing.',
      'READY',
      'none',
    )
    : null
  const controls = !pause
    ? [provider]
    : provider.action === 'pause-submissions' ? [pause] : [pause, provider]

  // v1.2.8 — the guarantee is that there is always a way out. Offer the
  // override on any unfinished job, and on any finished one whose only control
  // is disabled — the two shapes that can otherwise become a dead end. A job
  // already abandoned does not offer it again.
  const deadEnd = controls.every(candidate => !candidate.enabled)
  if (!job.force_abandoned && (!isFinishedJob(job.status) || deadEnd)) {
    controls.push(forceAbandonControl())
  }
  return controls
}

/** Backwards-compatible primary control; public snapshots also include all controls. */
export function classifyJobControl(
  job: Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations' | 'reconciliation_error' | 'history_evidence_check' | 'force_abandoned'>,
  capabilities: JobControlCapabilities,
): JobControl {
  return classifyProviderJobControl(job, capabilities)
}
