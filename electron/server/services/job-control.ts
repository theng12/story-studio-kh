import type {
  Job,
  JobControl,
  JobControlCapabilities,
  JobRemoteOperation,
} from '../models/types.js'
import { isSettledProviderEntry, isUnsettledProviderEntry } from '../lib/provider-task-state.js'
import {
  HELD_MUSIC_RESULT_GUIDANCE,
  MUSIC_RESULT_AWAITING_IMPORT_GUIDANCE,
  holdsUnknownMusicResult,
} from '../contracts/provider-task-state.js'
import { isProvenLocalStopCapableJob as isSafelyStoppableLocalJob } from './job-retry-policy.js'
import { hasFinalRenderRemoteWaitMarker, isRefusedFinalRenderReceipt, parseFinalRenderRemoteWaitReceipt } from '../lib/final-render-remote-wait.js'

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

// v1.4.81 — the terminal-state set used to live here, a second copy of the one
// `job-queue.ts` used to decide whether a row could actually be removed. They
// differed by one word and the owner paid for it with a "Clear finished (6)"
// button that cleared nothing. Both sides now read `isSettledProviderEntry`
// from the leaf module; `not_created` and its rationale live there too.
const PENDING_CANCELLATION_STATES = new Set(['queued', 'submitting', 'requested', 'reconciling', 'unknown'])
const PAUSABLE_SUBMISSION_TYPES = new Set<Job['type']>([
  // These executors check the cooperative pause marker between submissions.
  // Image batches currently do not, so advertising Pause there would let an
  // in-flight batch continue submitting work after promising otherwise.
  'audio', 'subtitles_transcribe', 'continuity_render', ])

// A local batch executor can be stopped between batches even while one provider request is already in
// flight. Its submitting entry carries only a placeholder id (`pending:<idempotency-key>`), so it is
// not a remote-cancel target — but the executor polls `isCancelled` and never appends the request it
// already paid for, leaving that batch's saved key collectable on a later retry.
//
// Keep this set separate from `SAFE_LOCAL_STOP_TYPES` (job-retry-policy.ts). That set proves NO
// provider request was ever sent, and the no-evidence copy promises nothing is charged. Merging the
// two would make that promise on a job whose paid response may still arrive.
const SUBMISSION_STOP_CAPABLE_TYPES = new Set<Job['type']>(['idea_campaign'])

function canPauseNewSubmissions(job: Pick<Job, 'type' | 'params'>): boolean {
  return PAUSABLE_SUBMISSION_TYPES.has(job.type)
    || (job.type === 'scene_plan_run' && job.params?.auto_repair_missing_prompts === true)
}

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
  return isSettledProviderEntry(entry)
}

function isSubmissionUncertain(entry: JobEvidence): boolean {
  return entry.state === 'submitting' || entry.queue_state === 'submitting'
}

function targetFor(entry: JobEvidence): { operation: JobRemoteOperation; provider_job_id: string } | null {
  if (!isRemoteOperation(entry.operation) || !entry.id) return null
  return { operation: entry.operation, provider_job_id: entry.id }
}

const OPERATION_WORK: Record<JobRemoteOperation, string> = {
  'voice.tts': 'narration request',
  'audio.transcription': 'transcription request',
  'image.generation': 'image request',
  'video.generation': 'video request',
  'chat.response': 'writing request',
  'music.generation': 'music request',
}

function describeProviderWork(operations: JobRemoteOperation[]): { text: string; plural: boolean } {
  const counts = new Map<JobRemoteOperation, number>()
  for (const operation of operations) counts.set(operation, (counts.get(operation) || 0) + 1)
  const parts = [...counts].map(([operation, count]) => {
    const work = OPERATION_WORK[operation]
    return count === 1 ? `the ${work}` : `${count} ${work}s`
  })
  if (!parts.length) return { text: 'this job\'s provider work', plural: false }
  return {
    text: parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`,
    plural: operations.length > 1,
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Public control copy never carries the exact identifier kept in job evidence. */
function publicControlDetail(value: string | null | undefined): string {
  return String(value || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'the provider request')
    .replace(/\b((?:provider[ _-]?)?(?:job|task|request)[ _-]?id)\s*[:=#]\s*[A-Za-z0-9._:-]{6,}/gi, '$1: hidden')
    .replace(/\b(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[-_])[A-Za-z0-9_-]+\b/g, '[request hidden]')
}

/** Name the provider tasks this job recorded as unfinished, without a wall of ids. */
function describeUnsettled(
  job: Pick<Job, 'genstudio_jobs' | 'remote_cancellations'>,
  evidence: JobEvidence[],
): { text: string; plural: boolean } {
  const seen = new Set<string>()
  const operations: JobRemoteOperation[] = []
  for (const entry of evidence) {
    if (isProviderTerminal(entry) || !isRemoteOperation(entry.operation)) continue
    seen.add(`${entry.operation}:${entry.id}`)
    operations.push(entry.operation)
  }
  for (const record of Object.values(job.remote_cancellations || {})) {
    if (!PENDING_CANCELLATION_STATES.has(record.status)) continue
    const key = `${record.operation}:${record.provider_job_id}`
    if (!seen.has(key)) operations.push(record.operation)
  }
  return describeProviderWork(operations)
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
  // A held song is the Gateway's own answer, not a stale snapshot: one line, pointing at the free
  // import, and never "finished" or removable (Dreamlands 571ec142).
  if (holdsUnknownMusicResult(evidence)) {
    return control(
      'recheck-provider-status', true, 'Check the Gateway again', HELD_MUSIC_RESULT_GUIDANCE,
      'PROVIDER_WORK_ALREADY_STARTED', 'remote-result-required',
    )
  }
  const { text: outstanding, plural } = describeUnsettled(job, evidence)
  const check = job.history_evidence_check
  if (check?.state === 'unreachable') {
    const detail = check.detail ? ` ${publicControlDetail(check.detail)}` : ''
    const staleTranscriptionAbsence = evidence.some(entry => (
      entry.operation === 'audio.transcription'
      && entry.state === 'not_created'
      && !isProviderTerminal(entry)
    ))
    return control(
      'recheck-provider-status', true, 'Check the Gateway again',
      staleTranscriptionAbsence
        ? `Story Studio could not reach the Gateway to recheck an earlier no-record transcription result, so it cannot confirm whether that request was created or charged.${detail}`
        : `Story Studio could not reach the Gateway to confirm whether ${outstanding} finished, so it cannot say whether that work is still running.${detail}`,
      'PROVIDER_STATUS_UNREACHABLE', 'remote-result-required',
    )
  }
  if (check?.state === 'unsettled') {
    return control(
      'recheck-provider-status', true, 'Check the Gateway again',
      `The Gateway reports that ${outstanding} ${plural ? 'have' : 'has'} not finished yet, so Story Studio is keeping this history until that work settles.`,
      'PROVIDER_WORK_ALREADY_STARTED', 'remote-result-required',
    )
  }
  // No answer yet. Whether a check is running RIGHT NOW is a fact about this
  // job, and the button must not name an activity that is not happening: a
  // `checking` record means a request to the Gateway is in flight, and no
  // record at all means none is. The two get different words for that reason.
  if (check?.state === 'checking') {
    return control(
      'return-later', false, 'Checking provider status',
      `Story Studio is asking Gateway whether ${outstanding} finished. This history can be removed as soon as the Gateway confirms ${plural ? 'they have' : 'it has'}.`,
      'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required',
    )
  }
  return control(
    'return-later', false, 'Waiting for Gateway status',
    `Story Studio is waiting for the Gateway to confirm whether ${outstanding} finished. It asks the Gateway again on its own, and this history can be removed as soon as the Gateway confirms ${plural ? 'they have' : 'it has'}.`,
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
  + 'It does not cancel provider work the Gateway has already accepted. '
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
  job: Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations' | 'reconciliation_error' | 'history_evidence_check' | 'force_abandoned' | 'music_results_awaiting_import'>
    & Partial<Pick<Job, 'job_id' | 'final_render_remote_wait'>>,
  capabilities: JobControlCapabilities,
): JobControl {
  const evidence = job.genstudio_jobs || []
  if (job.type === 'video_assembly' && hasFinalRenderRemoteWaitMarker(job)) {
    const parsed = parseFinalRenderRemoteWaitReceipt(job.final_render_remote_wait, job.job_id || '')
    // A refused render never became a remote job: the Gateway published `gateway_job_id: null` when
    // it turned the remote lane down, so this row is this Mac's own render. Offering it the
    // remote-wait Cancel recorded no remote target, left the row `running`, and the reconciler then
    // resumed it and rendered the episode again (2026-10-26). It takes the ordinary local controls
    // below instead: Stop while it waits or runs, and the finished rules once it ends.
    if (!(parsed.ok && isRefusedFinalRenderReceipt(parsed.receipt))) {
      if (parsed.ok && parsed.receipt.cancel_requested_at === null) {
        return control('request-remote-cancel', true, 'Cancel', 'Records your cancellation request while Story Studio waits for the remote render.', 'READY', 'remote-result-required')
      }
      return control('return-later', false, 'Return later', 'Story Studio is preserving this remote render record until it can be reconciled safely.', 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
    }
    if (!isFinishedJob(job.status) && !evidence.length) {
      return control(
        'stop-local', true, 'Cancel',
        'Stops this video on this Mac now. The Gateway refused the remote render, so nothing is running remotely. The accepted final video, its folder and the refusal record are left exactly as they are.',
        'READY', 'local-only',
      )
    }
  }
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
  // v1.4.81 — one shared definition of "settled", so the button and the action
  // behind it cannot disagree about which rows are clearable.
  const unsettledEvidence = evidence.some(isUnsettledProviderEntry)
    || Object.values(job.remote_cancellations || {}).some(record => PENDING_CANCELLATION_STATES.has(record.status))
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
  // A finished song not in the library yet: removing the row would orphan its free import.
  if (isFinishedJob(job.status) && job.music_results_awaiting_import?.length) {
    return control(
      'return-later', false, 'Recover in Music Library', MUSIC_RESULT_AWAITING_IMPORT_GUIDANCE,
      'PROVIDER_WORK_ALREADY_STARTED', 'remote-result-required',
    )
  }
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    return control('clear-history', true, 'Remove from history', 'This finished job can be removed from the job list. Its files and provider evidence stay intact.', 'READY', 'history-only')
  }

  if ((job.status === 'queued' || job.status === 'paused') && !evidence.length && !Object.keys(job.remote_cancellations || {}).length) {
    return control('cancel-before-submit', true, 'Cancel', 'Nothing has been sent to the Gateway yet, so cancelling costs nothing.', 'READY', 'no-provider-request')
  }

  const pendingCancellation = Object.values(job.remote_cancellations || {}).find(record => PENDING_CANCELLATION_STATES.has(record.status))
  if (pendingCancellation) {
    const detail = pendingCancellation.reconciliation_error || job.reconciliation_error
      ? ` ${publicControlDetail(pendingCancellation.reconciliation_error || job.reconciliation_error)}`
      : ''
    return control('return-later', false, 'Checking cancellation', `Story Studio is waiting for the Gateway to confirm the cancellation result. The provider work may still settle.${detail}`, 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  if (job.reconciliation_error) {
    return control('return-later', false, 'Checking provider status', `Story Studio cannot yet confirm every accepted provider task. ${publicControlDetail(job.reconciliation_error)}`, 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  if (!evidence.length) {
    if (isSafelyStoppableLocalJob(job)) {
      return control('stop-local', true, 'Stop', 'Stops this job on this Mac now. Nothing was sent to the Gateway, so nothing is charged.', 'READY', 'local-only')
    }
    return control('pause-submissions', canPauseNewSubmissions(job), 'Pause new work', 'This job can\'t be stopped halfway through a step. Pause stops it from starting anything new; the step under way finishes first.', 'JOB_NOT_AT_SAFE_LOCAL_STOP', 'none')
  }

  if (evidence.some(isSubmissionUncertain)) {
    // Stop the local batch loop, but never claim the request already sent was stopped: the Gateway
    // may still finish and charge it. The batch keeps its idempotency key, so a later retry collects
    // that same answer without a second POST. Every other type keeps the honest "cannot tell" refusal
    // — without a remote target there is no safe cancellation to offer.
    if (SUBMISSION_STOP_CAPABLE_TYPES.has(job.type)) {
      return control('stop-local', true, 'Stop', 'Stops this campaign on this Mac now. No further batches will be sent. The request already sent may still finish and be charged; its answer stays collectable when you retry.', 'READY', 'provider-work-may-settle')
    }
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
    // `cancellable` is the gateway's promise that a cancel is honoured now, and the gateway decides
    // when that is true: before dispatch, while a job waits for a Mac, and while a narration or
    // music job runs (the Hub stops both workers and reports `cancelled`). Story follows it rather
    // than guessing from `dispatch_state`; a render the gateway cannot stop says `false`.
    if (entry.cancellable === true) {
      targets.push(target)
      continue
    }
    continuing.push(entry)
  }

  if (ambiguous.length) {
    const work = describeProviderWork(ambiguous.filter(entry => isRemoteOperation(entry.operation)).map(entry => entry.operation as JobRemoteOperation))
    // Story Studio does not know the Gateway's cancellation state here, and it
    // is not asking the Gateway at this moment — it asks again on its own, and
    // keeps the duplicate lock meanwhile. A button must not name an activity
    // that is not happening, so this says what is true: it is WAITING. (The
    // same rule the finished-history gate follows, and the reason a stalled
    // writing job used to read "Checking provider status" while nothing was
    // being checked.)
    return control('return-later', false, 'Waiting for Gateway status', `Story Studio is waiting for the Gateway to answer whether ${work.text} can still be stopped. It asks the Gateway again on its own, and keeps the duplicate lock until the Gateway answers.`, 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
  }

  if (targets.length && capabilities.remoteCancellationAudited) {
    const settling = [...continuing, ...unsupported]
    const continuingReason = settling.length
      ? ` ${capitalise(describeProviderWork(settling.filter(entry => isRemoteOperation(entry.operation)).map(entry => entry.operation as JobRemoteOperation)).text)} already started and will finish.`
      : ''
    return control('request-remote-cancel', true, 'Cancel', `Asks the Gateway to stop ${targets.length === 1 ? 'the request it can still stop' : `the ${targets.length} requests it can still stop`}. Work that never runs is not charged.${continuingReason}`, 'READY', 'remote-result-required', targets)
  }

  if (targets.length) {
    return control('return-later', false, 'Return later', 'This job has no registered output auditor, so Story Studio cannot safely reconcile provider cancellation. Provider work may still settle.', 'REMOTE_CANCELLATION_NOT_SUPPORTED', 'provider-work-may-settle')
  }

  if (unsupported.length) {
    const work = describeProviderWork(unsupported.filter(entry => isRemoteOperation(entry.operation)).map(entry => entry.operation as JobRemoteOperation))
    return control('return-later', false, 'Return later', `${capitalise(work.text)} ${work.plural ? 'do' : 'does'} not publish a cancellation endpoint. Provider work may still settle.`, 'REMOTE_CANCELLATION_NOT_SUPPORTED', 'provider-work-may-settle')
  }

  if (continuing.length) {
    const work = describeProviderWork(continuing.filter(entry => isRemoteOperation(entry.operation)).map(entry => entry.operation as JobRemoteOperation))
    return control('pause-submissions', canPauseNewSubmissions(job), 'Pause new work', `${capitalise(work.text)} already started and will finish — it can't be cancelled now. Pause stops anything new from being sent.`, 'PROVIDER_WORK_ALREADY_STARTED', 'provider-work-may-settle')
  }

  return control('return-later', false, 'Return later', 'Story Studio is waiting for authoritative provider settlement.', 'CANCELLATION_STATUS_UNKNOWN', 'remote-result-required')
}

/**
 * A batch may safely expose two independent controls at once: pausing future
 * submissions and asking GenStudio to cancel exact pre-dispatch targets.
 * Neither action is allowed to impersonate the other.
 */
export function classifyJobControls(
  job: Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations' | 'reconciliation_error' | 'history_evidence_check' | 'force_abandoned' | 'music_results_awaiting_import'>
    & Partial<Pick<Job, 'job_id' | 'final_render_remote_wait'>>
    & Partial<Pick<Job, 'pause_requested' | 'resume_after_pause'>>,
  capabilities: JobControlCapabilities,
): JobControl[] {
  const provider = classifyProviderJobControl(job, capabilities)
  if (job.type === 'video_assembly' && hasFinalRenderRemoteWaitMarker(job)) return [provider]
  const canPause = job.status === 'running' && canPauseNewSubmissions(job)
  // A pause that is still taking effect is not "ready to pause" again: the
  // button would repeat a request already made, and the card would keep
  // promising that waiting items start automatically. Say what is happening.
  const pausing = canPause && job.pause_requested === true
  const pause = !canPause
    ? null
    : pausing
      ? control(
        'pause-submissions',
        false,
        job.resume_after_pause ? 'Resuming after pause' : 'Pausing…',
        job.resume_after_pause
          ? 'Resume was requested while the pause was taking effect. Work already sent finishes and is saved first; then the job continues on its own with only what is still missing.'
          : 'Nothing new is being sent. Work already sent finishes and is saved; then the job shows Paused. Press Resume to keep it going instead.',
        'JOB_NOT_AT_SAFE_LOCAL_STOP',
        'none',
      )
      : control(
        'pause-submissions',
        true,
        'Pause new work',
        'Stops sending new work. Anything already sent finishes and is saved, so nothing is lost or charged twice.',
        'READY',
        'none',
      )
  const controls = !pause
    ? [provider]
    : provider.action === 'pause-submissions' ? [pause] : [pause, provider]

  // v1.2.9 — the guarantee is still that there is always a way out, but v1.2.8
  // measured "a way out" as "any button you can click". That is the wrong test.
  // For a FINISHED job the only exit is removing the row, and
  // `recheck-provider-status` is a diagnostic, not an exit: it is enabled, so
  // `controls.every(c => !c.enabled)` was false and the override was withheld —
  // yet clicking it can only ever re-ask a question. When the evidence has no
  // recoverable task identity the answer is permanently "cannot tell", so the
  // owner was left holding a job whose single enabled button was guaranteed
  // never to release it. That is the exact dead end v1.2.8 was written to
  // abolish, rebuilt out of two individually reasonable parts.
  //
  // So ask the honest question instead: can the user actually leave? An
  // unfinished job is never offered `clear-history`, so this stays a strict
  // superset of the old rule — nothing that used to be offered stops being
  // offered. A job already abandoned does not offer it again.
  const canLeave = controls.some(candidate => candidate.enabled && candidate.action === 'clear-history')
  if (!job.force_abandoned && !canLeave) {
    controls.push(forceAbandonControl())
  }
  return controls
}

/** Backwards-compatible primary control; public snapshots also include all controls. */
export function classifyJobControl(
  job: Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations' | 'reconciliation_error' | 'history_evidence_check' | 'force_abandoned' | 'music_results_awaiting_import'>
    & Partial<Pick<Job, 'job_id' | 'final_render_remote_wait'>>,
  capabilities: JobControlCapabilities,
): JobControl {
  return classifyProviderJobControl(job, capabilities)
}
