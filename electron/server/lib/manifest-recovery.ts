/** Recovery is supported only for durable GenStudio image jobs. */

import type { ImageModelConfig } from '../models/types.js'
import { createHash } from 'node:crypto'
import { getGenStudioUrl } from '../services/app-settings.js'
import { isFreeFleetModelId } from '../contracts/provider-task-state.js'
import { hashInput, type ImageRequestIdentityEvidence, type TaskManifestEntry } from '../services/task-manifest.js'
import {
  GenStudioImageArtifactUnavailableError,
  GenStudioImageTerminalFailureError,
  getGenStudioCancellationStatus,
  getGenStudioJobByIdempotencyKey,
  isGenStudioTaskAbsent,
  recoverImageWithGenStudio,
} from './genstudio-client.js'

export interface RecoveryResult {
  urls: string[]
  taskId: string
  provider: string
}

/**
 * Local `last_state` values that mean the saved provider job can never yield an
 * artifact again. Mirrors `isTerminalGenStudioTaskFailure` in generators/audio.ts
 * — the proven pattern — and adds the image-only "the artifact is gone" case.
 *
 * NOTE: there is no `cancelled` JobState in GenStudio; cancellation arrives as a
 * boolean and is normalised into `failed` before it reaches the manifest.
 */
export const TERMINAL_IMAGE_TASK_STATES: ReadonlySet<string> = new Set([
  'failed',
  'artifact_expired',
])

/**
 * An accepted GenStudio image task can be safely reconnected after a restart or
 * a lost network response. A terminal provider failure cannot: its idempotency
 * key intentionally resolves to the same failed GenStudio job forever, so
 * reusing it can never produce new pixels.
 */
export function isTerminalGenStudioImageTaskFailure(
  entry: { task_id?: string; last_state?: string } | null | undefined,
): boolean {
  return Boolean(entry?.task_id && entry.last_state && TERMINAL_IMAGE_TASK_STATES.has(entry.last_state))
}

/** Explicit outcome of trying to reclaim a saved image job. */
export type ImageRecoveryOutcome =
  /** The saved job already holds the artifact — reuse it, never re-pay. */
  | { kind: 'recovered'; urls: string[]; taskId: string; provider: string }
  /** No usable saved job. Submitting fresh work is correct. */
  | { kind: 'no-saved-job' }
  /** GenStudio settled this job as failed/cancelled. Needs a NEW retry identity. */
  | { kind: 'terminal-failed'; taskId: string; failureCode: string | null; reason: string }
  /** The job succeeded but its artifact is gone. Also needs a NEW retry identity. */
  | { kind: 'artifact-unavailable'; taskId: string; reason: string }
  /** GenStudio authoritatively says the accepted task is still active. */
  | { kind: 'still-generating'; taskId: string; state: string; reason: string }
  /**
   * The saved job's outcome is genuinely unknown (network/timeout). Callers MUST
   * NOT submit fresh work here — that is exactly how an uncertain request turns
   * into a duplicate paid submission. Fail the item; Retry reconnects.
   */
  | { kind: 'uncertain'; taskId: string; reason: string; error: Error }

function isCancellation(error: unknown, isCancelled?: () => boolean): boolean {
  if (isCancelled?.()) return true
  const message = error instanceof Error ? error.message : String(error)
  return /cancell?ed|abort/i.test(message)
}

/**
 * Reclaim a saved GenStudio image job and report WHY it could not be reclaimed,
 * as data rather than as an exception or an error-message match.
 *
 * Configuration problems (a pre-GenStudio manifest entry, a missing key) still
 * throw: they are not job outcomes, and silently resubmitting past them would
 * charge the account for a mistake the user has to fix once.
 */
export async function tryRecoverImageFromManifestEntry(
  entry: TaskManifestEntry | null,
  apiKey: string,
  modelConfig: ImageModelConfig,
  isCancelled?: () => boolean,
  options: { observeCurrentState?: boolean; allowPreparedReplayOnAbsent?: boolean } = {},
): Promise<ImageRecoveryOutcome> {
  if (!entry) return { kind: 'no-saved-job' }
  if (!entry.task_id && !entry.idempotency_key) return { kind: 'no-saved-job' }
  if (entry.provider !== 'genstudio-image' && entry.provider !== 'genstudio') {
    throw new Error('This image job comes from an older version of Story Studio. Generate the image again.')
  }
  if (!apiKey) throw new Error('A Gateway API Key is required to reconnect to this image job.')
  // Cheapest possible check: we already recorded this job as terminal, so do not
  // spend a round-trip re-reading a 6-day-old failure.
  if (isTerminalGenStudioImageTaskFailure(entry)) {
    const reason = `the saved Gateway job is already recorded as ${entry.last_state}`
    return entry.last_state === 'artifact_expired'
      ? { kind: 'artifact-unavailable', taskId: entry.task_id, reason }
      : { kind: 'terminal-failed', taskId: entry.task_id, failureCode: null, reason }
  }
  try {
    let taskId = entry.task_id
    if (!taskId || options.observeCurrentState) {
      const baseUrl = await getGenStudioUrl()
      const deadline = Date.now() + 30_000
      const control = taskId
        ? await getGenStudioCancellationStatus('image.generation', baseUrl, apiKey, taskId, { isCancelled }, deadline)
        : await getGenStudioJobByIdempotencyKey('image.generation', baseUrl, apiKey, entry.idempotency_key!, { isCancelled }, deadline)
      taskId = control.id
      if (!['succeeded', 'failed'].includes(control.state) && control.cancelled !== true && options.observeCurrentState) {
        return {
          kind: 'still-generating', taskId: control.id, state: control.state,
          reason: `The Gateway reports this task as ${control.state}`,
        }
      }
      if (control.state === 'failed' || control.cancelled === true) {
        return {
          kind: 'terminal-failed', taskId: control.id, failureCode: control.failure_code || null,
          reason: `The Gateway reports this task as failed`,
        }
      }
    }
    const result = await recoverImageWithGenStudio(apiKey, taskId, { isCancelled })
    return { kind: 'recovered', urls: [result.url], taskId: result.jobId, provider: entry.provider }
  } catch (error) {
    if (isCancellation(error, isCancelled)) throw error
    if (options.allowPreparedReplayOnAbsent && !entry.task_id && entry.last_state === 'prepared'
      && isGenStudioTaskAbsent(error)) {
      return { kind: 'no-saved-job' }
    }
    if (error instanceof GenStudioImageTerminalFailureError) {
      return {
        kind: 'terminal-failed',
        taskId: error.jobId,
        failureCode: error.failureCode,
        reason: error.message,
      }
    }
    if (error instanceof GenStudioImageArtifactUnavailableError) {
      return { kind: 'artifact-unavailable', taskId: error.jobId, reason: error.message }
    }
    // Free fleet (the owner's own Macs; nothing is charged): an outcome that cannot be
    // confirmed — e.g. "No such job" for the saved key — counts as not made. Report it
    // as settled so every caller promotes to a fresh request identity (derived from this
    // id) instead of failing on every Retry. Paid models stay `uncertain` below.
    if (isFreeFleetModelId(modelConfig.api_model) && (!entry.model_id || isFreeFleetModelId(entry.model_id))) {
      return {
        kind: 'terminal-failed',
        taskId: entry.task_id || entry.idempotency_key!,
        failureCode: null,
        reason: `the earlier free image request could not be confirmed (${error instanceof Error ? error.message : String(error)}), so it counts as not made`,
      }
    }
    return {
      kind: 'uncertain',
      taskId: entry.task_id || '',
      reason: !entry.task_id && entry.idempotency_key
        ? `Could not confirm the prepared image by its idempotency key: ${error instanceof Error ? error.message : String(error)}`
        : error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export interface ManualImageReplacement {
  scope: string
  superseded: ImageRequestIdentityEvidence
}

export function imageManifestIdentityHash(entry: TaskManifestEntry): string {
  return createHash('sha256').update(JSON.stringify({
    provider: entry.provider,
    task_id: entry.task_id,
    submitted_at: entry.submitted_at,
    input_hash: entry.input_hash || '',
    idempotency_key: entry.idempotency_key || '',
    operation: entry.operation || '',
    last_state: entry.last_state || '',
    request_scope: entry.request_scope || '',
  })).digest('hex')
}

/** Derive one replay-stable explicit replacement while retaining old evidence. */
export function resolveManualImageReplacement(
  entry: TaskManifestEntry,
  actionId: string,
): ManualImageReplacement {
  if (!entry.task_id && !entry.idempotency_key) {
    throw new Error('Replace anyway requires a durable earlier image request identity.')
  }
  const superseded: ImageRequestIdentityEvidence = {
    provider: entry.provider,
    task_id: entry.task_id,
    submitted_at: entry.submitted_at,
    ...(entry.idempotency_key ? { idempotency_key: entry.idempotency_key } : {}),
    ...(entry.input_hash ? { input_hash: entry.input_hash } : {}),
    ...(entry.request_scope ? { request_scope: entry.request_scope } : {}),
    ...(entry.operation === 'image' ? { operation: 'image' as const } : {}),
    ...(entry.last_state ? { last_state: entry.last_state } : {}),
  }
  const token = createHash('sha256')
    .update(`${actionId}\n${imageManifestIdentityHash(entry)}`)
    .digest('hex').slice(0, 12)
  return { scope: `manual-finish:${actionId}:replace:${token}`, superseded }
}

/** Whether this manifest already records a fresh request for one bulk repair action. */
export function isCurrentPipelineRepairImageAttempt(entry: { request_scope?: string } | null | undefined, actionId: string): boolean {
  const scope = entry?.request_scope
  const base = `manual-finish:${actionId}`
  return scope === base || Boolean(scope?.startsWith(`${base}:`))
}

export function hasPipelineRepairImageAttempt(entry: TaskManifestEntry | null | undefined, actionId: string): boolean {
  return isCurrentPipelineRepairImageAttempt(entry, actionId)
    || Boolean(entry?.superseded_image_requests?.some(previous =>
      isCurrentPipelineRepairImageAttempt(previous, actionId)))
}

/**
 * Legacy null/throw shape, kept for callers that only care "did I get an
 * artifact for free?". A terminal saved job now yields `null` (submit fresh)
 * instead of an exception, but genuine uncertainty still throws so it can never
 * be mistaken for "nothing was saved".
 */
export async function tryRecoverImageFromManifest(
  entry: TaskManifestEntry | null,
  apiKey: string,
  modelConfig: ImageModelConfig,
  isCancelled?: () => boolean,
): Promise<RecoveryResult | null> {
  const outcome = await tryRecoverImageFromManifestEntry(entry, apiKey, modelConfig, isCancelled)
  if (outcome.kind === 'recovered') {
    return { urls: outcome.urls, taskId: outcome.taskId, provider: outcome.provider }
  }
  if (outcome.kind === 'uncertain') throw outcome.error
  return null
}

export interface ImageRetryScope {
  /**
   * Opaque token to fold into BOTH the manifest input hash and the provider
   * idempotency identity. Same token ⇒ same idempotency key ⇒ GenStudio replays
   * the existing job instead of charging for a second one.
   */
  scope: string
  /** True when this scope was minted to escape a terminal provider failure. */
  isRetry: boolean
  /** The terminal job this retry replaces, when there is one. */
  previousTaskId?: string
}

/**
 * Resolve the request scope for one image asset.
 *
 * The identity has to be two things at once:
 *
 *  - FRESH after a terminal failure, or a manual Retry replays the dead job's
 *    idempotency key forever and never submits new work (the reported bug: a
 *    Retry reused three failed jobs from six days earlier).
 *  - STABLE if the fresh submission's response is lost, or a reconnect mints a
 *    second scope and pays twice for the same picture.
 *
 * Both fall out of deriving the scope deterministically from persisted state —
 * the base scope plus the id of the job that failed — and never from a clock or
 * a random value. Re-running this against the same manifest entry always yields
 * the same scope, and the hash keeps the token a fixed length no matter how many
 * deliberate retries an asset accumulates.
 */
export function resolveImageRetryScope(
  entry: TaskManifestEntry | null | undefined,
  baseScope: string,
): ImageRetryScope {
  const saved = typeof entry?.request_scope === 'string' ? entry.request_scope.trim() : ''
  // Only adopt (and only promote) a saved scope that belongs to this base
  // attempt. A pre-scope manifest entry counts as belonging — it was submitted
  // under the bare base. A new deliberate force-render carries its own base,
  // which is already a fresh identity, so it never inherits an older retry
  // chain and never needs promoting.
  const inChain = !saved || saved === baseScope || saved.startsWith(`${baseScope}:retry:`)
  const current = inChain && saved ? saved : baseScope
  if (!inChain || !isTerminalGenStudioImageTaskFailure(entry)) {
    return { scope: current, isRetry: current !== baseScope }
  }
  const token = hashInput(`${current}\n${entry!.task_id}`).slice(-12)
  return { scope: `${baseScope}:retry:${token}`, isRetry: true, previousTaskId: entry!.task_id }
}

/**
 * The manifest entry as it should read once GenStudio has told us the saved job
 * is terminal. Persist this BEFORE resolving the next scope so the retry
 * identity is derivable again after a crash.
 */
export function terminalImageManifestEntry(
  entry: TaskManifestEntry,
  outcome: ImageRecoveryOutcome & { kind: 'terminal-failed' | 'artifact-unavailable' },
): TaskManifestEntry {
  return {
    ...entry,
    task_id: outcome.taskId || entry.task_id,
    operation: 'image',
    last_state: outcome.kind === 'artifact-unavailable' ? 'artifact_expired' : 'failed',
  }
}

/** Old provider video jobs are intentionally not recovered. */
export async function tryRecoverVideoFromManifest(
  _entry: TaskManifestEntry | null,
  _config: unknown,
  _isCancelled?: () => boolean,
  _pollDeadlineMs?: number,
): Promise<RecoveryResult | null> {
  return null
}
