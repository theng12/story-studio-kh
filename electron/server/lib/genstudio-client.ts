/**
 * GenStudio KH client boundary for Story Studio.
 *
 * This module knows only the public GenStudio API contract. It has no sibling
 * Studio URL, token, worker list, or direct provider connection.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { getGenStudioUrl } from '../services/app-settings.js'
import { runFfmpeg } from './ffmpeg-utils.js'
import {
  GenStudioAdmissionPool,
  type GenStudioAdmissionState,
  type GenStudioAccountCapacity,
} from './genstudio-admission.js'
import { chunkText } from './text-chunker.js'
import {
  hasTtsControlValues,
  orderedTtsControlValues,
  parseTtsControlValues,
  parseTtsControls,
  type GenStudioTtsControl,
  type TtsControlValues,
} from './tts-controls.js'
import {
  describeOutputBudget,
  resolveOutputTokenBudget,
  type OutputBudget,
} from '../services/output-token-budget.js'
import {
  JSON_OBJECT_OUTPUT_CONTRACT,
  PROSE_OUTPUT_CONTRACT,
  validateStructuredOutput,
  type JsonSchema,
  type TextOutputContract,
} from './json-output-contract.js'
import {
  buildGenStudioRequestPreview,
  pendingGenStudioEntryId,
  type GenStudioRequestPreview,
  type GenStudioRequestPreviewInput,
} from './genstudio-request-preview.js'
import type { JobRemoteOperation, ResearchEvidenceLevel } from '../models/types.js'

/**
 * Job-poll cadence — ONE schedule shared by all five wait loops.
 *
 * WHY THIS IS NOT A FLAT INTERVAL ANY MORE
 * ----------------------------------------
 * It used to be `POLL_INTERVAL_MS = 1_000`, asked once a second until the job
 * settled. Every poll that answers "still running" is wasted work on both
 * sides, and the numbers are not small: a 90-second chapter generation cost 90
 * requests, 89 of them redundant; chapter batches run 4 concurrent, so one
 * customer sustained 4 req/s; and the 4-hour ceiling meant a genuinely stuck
 * job fired 14,400 requests before giving up. Story Studio is a desktop app
 * the customer leaves open, so that is steady-state load on hosted GenStudio,
 * not a burst.
 *
 * The ladder starts at 1s so a short operation still feels instant, then
 * widens through 2s and 5s to 10s, capping at 15s:
 *
 *   polls 1-3   1s   →  t = 3s
 *   polls 4-6   2s   →  t = 9s
 *   polls 7-8   5s   →  t = 19s
 *   polls 9-10  10s  →  t = 39s
 *   polls 11+   15s
 *
 * A 90-second job settles inside ~14 polls instead of 90. A stuck job that
 * runs the full 4-hour deadline costs ~968 polls instead of 14,400.
 *
 * JITTER: ±20% on every interval. Without it, four concurrent chapter batches
 * (and every other copy of the app on every other customer machine) fall into
 * lockstep and hand GenStudio synchronised request spikes. Jitter is applied
 * to a SERVER HINT too, but upward only — never poll sooner than the server
 * asked — matching what `noteRateLimit` already does with `Retry-After`.
 */
const POLL_LADDER_MS = [1_000, 1_000, 1_000, 2_000, 2_000, 2_000, 5_000, 5_000, 10_000, 10_000]
export const GENSTUDIO_POLL_MAX_INTERVAL_MS = 15_000
export const GENSTUDIO_POLL_JITTER_FRACTION = 0.2
/** How often an in-progress wait re-checks cancellation. Keeps a 15-second
 *  sleep from making the Cancel button feel dead. */
const POLL_CANCEL_CHECK_MS = 250

const NETWORK_RETRY_ATTEMPTS = 4
const CATALOG_RETRY_ATTEMPTS = 3
const CATALOG_REQUEST_TIMEOUT_MS = 8_000
const CATALOG_FRESH_MS = 5 * 60_000
const CATALOG_STALE_MS = 30 * 60_000
export const GENSTUDIO_LONG_JOB_TIMEOUT_MS = 4 * 60 * 60_000
export const GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS = 30_000
export const GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS = 5 * 60_000
/**
 * How long ONE language submission may hold its socket open.
 *
 * NOT a control-plane request, and this distinction cost a whole episode.
 * `POST /v1/chat/responses` answers 202 and carries `Location` + `Retry-After`,
 * so it reads like a durable submit-then-poll route. It is not: on the
 * product-first path GenStudio runs the model INLINE on the request thread
 * (`ProductChatCompletionService.complete` → `provider.complete(...)`, whose
 * job record is stamped `DispatchMode.SYNCHRONOUS`) and only then returns. The
 * POST therefore lasts as long as the generation does.
 *
 * Bounded at the 30-second control timeout, every language request that took
 * longer than 30 seconds was aborted mid-generation — while GenStudio carried
 * on, finished, and charged for it. Story Studio then retried the POST on the
 * same Idempotency-Key, which GenStudio correctly answered
 * `request_in_progress`. That refusal carries no job id, and no route anywhere
 * in the API looks a job up by idempotency key, so the finished, paid-for
 * output was unreachable: nine packs, 333 scenes, 131 credits, all of it
 * generated correctly and none of it retrievable. A 333-scene episode is not an
 * edge case — every pack of 40 scenes took 33–86 seconds, so EVERY pack lost.
 *
 * The ceiling is generous because the cost of it being too small is losing paid
 * work, while the cost of it being too large is bounded anyway: the operation
 * signal clamps every attempt to whatever remains of the caller's own deadline
 * (`GENSTUDIO_LONG_JOB_TIMEOUT_MS`), and cancellation still aborts instantly.
 */
export const GENSTUDIO_LANGUAGE_SUBMIT_TIMEOUT_MS = 20 * 60_000
export const GENSTUDIO_MAX_TRANSCRIPTION_BYTES = 100 * 1024 * 1024

export type GenStudioQueueState =
  | 'waiting_local'
  | 'submitting'
  | 'accepted'
  | 'waiting_account_capacity'
  | 'running'
  | 'completing'
  | 'succeeded'
  | 'failed'
  | 'waiting_credits'
  | 'cancelled'

interface GenStudioOperationContext {
  signal?: AbortSignal
  isCancelled?: () => boolean
  onQueueState?: (state: GenStudioQueueState, jobId?: string) => void | Promise<void>
  /** A durable accepted task lost its live connection and is being reclaimed. */
  onReconnect?: (jobId: string, reason: string) => void | Promise<void>
}

export interface GenStudioJob {
  id: string
  state: 'accepted' | 'reserved' | 'dispatched' | 'running' | 'validating' | 'succeeded' | 'failed' | 'reconciling'
  failure_code?: string | null
  audio_url?: string | null
  model_id?: string
  model_revision_id?: string
  credit_cost?: number
  remaining_credits?: number
  /**
   * Settlement values, exactly as GenStudio publishes them. `released_credits`
   * ships on TTS and transcription jobs; the full triad ships only on
   * `GET /v1/account/jobs`. Image, chat, video and music jobs omit all three —
   * Story Studio forwards whatever arrives and never derives a charge locally.
   */
  reserved_credits?: number | null
  settled_credits?: number | null
  released_credits?: number | null
  routing_status_code?: string | null
  price_version?: string | null
  location?: string | null
  /**
   * Cancellation is NOT a JobState (the enum is accepted|reserved|dispatched|
   * running|validating|reconciling|succeeded|failed). It rides on these
   * booleans, so treat `cancelled: true` as an extra terminal signal.
   */
  cancellable?: boolean | null
  cancelled?: boolean | null
  cancellation_requested?: boolean | null
  cancellation_note?: string | null
}

/** The cancellation fields GenStudio 0.93.1 actually publishes. */
export type GenStudioCancellationFields = {
  state: string
  cancellable?: boolean
  cancelled?: boolean
  cancellation_requested?: boolean
  cancellation_note?: string | null
  failure_code?: string | null
  released_credits?: number
}

const GENSTUDIO_JOB_STATES = new Set<GenStudioJob['state']>([
  'accepted', 'reserved', 'dispatched', 'running', 'validating', 'succeeded', 'failed', 'reconciling',
])

function parseGenStudioCancellationResponse(value: unknown): GenStudioJob & GenStudioCancellationFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GenStudio KH cancellation response was not an object')
  }
  const body = value as Record<string, unknown>
  if (typeof body.id !== 'string' || !body.id.trim()) {
    throw new Error('GenStudio KH cancellation response did not include a job id')
  }
  if (typeof body.state !== 'string' || !GENSTUDIO_JOB_STATES.has(body.state as GenStudioJob['state'])) {
    throw new Error('GenStudio KH cancellation response did not include a valid state')
  }
  const optionalBoolean = (name: string): boolean | undefined => (
    typeof body[name] === 'boolean' ? body[name] : undefined
  )
  const optionalText = (name: string): string | null | undefined => (
    typeof body[name] === 'string' || body[name] === null ? body[name] as string | null : undefined
  )
  const released = body.released_credits
  return {
    id: body.id,
    state: body.state as GenStudioJob['state'],
    ...(optionalBoolean('cancellable') !== undefined ? { cancellable: optionalBoolean('cancellable') } : {}),
    ...(optionalBoolean('cancelled') !== undefined ? { cancelled: optionalBoolean('cancelled') } : {}),
    ...(optionalBoolean('cancellation_requested') !== undefined ? { cancellation_requested: optionalBoolean('cancellation_requested') } : {}),
    ...(optionalText('cancellation_note') !== undefined ? { cancellation_note: optionalText('cancellation_note') } : {}),
    ...(optionalText('failure_code') !== undefined ? { failure_code: optionalText('failure_code') } : {}),
    ...(typeof released === 'number' && Number.isFinite(released) && released >= 0 ? { released_credits: released } : {}),
  }
}

/** The only two GenStudio job states that can never change again. */
export type GenStudioTerminalJobState = 'succeeded' | 'failed'

export function isTerminalGenStudioJobState(state: unknown): state is GenStudioTerminalJobState {
  return state === 'succeeded' || state === 'failed'
}

/** A GenStudio job that will never produce an artifact, for any reason. */
export function isSettledGenStudioJob(job: { state?: unknown; cancelled?: boolean | null }): boolean {
  return isTerminalGenStudioJobState(job.state) || job.cancelled === true
}

/** Every GenStudio product family Story Studio submits durable work to. */
export type GenStudioModality = 'image' | 'video' | 'tts' | 'transcription' | 'chat'

/** The shape every settled GenStudio job response shares. */
export interface GenStudioSettledJobShape {
  id: string
  state?: unknown
  failure_code?: string | null
  /** image / TTS / transcription jobs. */
  cancelled?: boolean | null
  cancellation_note?: string | null
  /** video jobs use this instead of `cancellable`. */
  cancellation_requested?: boolean | null
}

function settledFailureCode(job: GenStudioSettledJobShape): string | null {
  return typeof job.failure_code === 'string' && job.failure_code ? job.failure_code : null
}

/**
 * GenStudio finished this job and it will never yield an artifact.
 *
 * Reconnecting to the same job id — or replaying its idempotency key — can only
 * ever return the same failure, so a caller that wants a new asset MUST mint a
 * new retry identity instead of reopening this one. Typed per modality so
 * callers branch on `instanceof`, never on an error message.
 */
export class GenStudioTerminalFailureError extends Error {
  readonly terminal = true as const
  readonly state: GenStudioTerminalJobState = 'failed'
  readonly modality: GenStudioModality
  readonly jobId: string
  readonly failureCode: string | null
  readonly cancelled: boolean

  constructor(modality: GenStudioModality, job: GenStudioSettledJobShape, message: string) {
    super(message)
    this.name = 'GenStudioTerminalFailureError'
    this.modality = modality
    this.jobId = job.id
    this.failureCode = settledFailureCode(job)
    this.cancelled = job.cancelled === true
  }
}

export class GenStudioImageTerminalFailureError extends GenStudioTerminalFailureError {
  constructor(job: GenStudioSettledJobShape) {
    super(
      'image',
      job,
      job.cancelled === true
        ? `GenStudio KH image job ${job.id} was cancelled${job.cancellation_note ? ` (${job.cancellation_note})` : ''}. `
          + 'Its reservation was released; Retry submits a new job.'
        : `GenStudio KH image generation failed${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + 'The reservation was released and this job cannot be reopened; Retry submits a new job.',
    )
    this.name = 'GenStudioImageTerminalFailureError'
  }
}

export class GenStudioVideoTerminalFailureError extends GenStudioTerminalFailureError {
  constructor(job: GenStudioSettledJobShape) {
    super(
      'video',
      job,
      job.cancelled === true
        ? `GenStudio KH video job ${job.id} was cancelled. `
          + 'Its reservation was released; Retry submits a new job. No legacy fallback was attempted.'
        : `GenStudio video generation failed${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + 'The reservation was released and this job cannot be reopened; Retry submits a new job. '
          + 'No legacy fallback was attempted.',
    )
    this.name = 'GenStudioVideoTerminalFailureError'
  }
}

export class GenStudioTtsTerminalFailureError extends GenStudioTerminalFailureError {
  constructor(job: GenStudioSettledJobShape) {
    super(
      'tts',
      job,
      job.cancelled === true
        ? `GenStudio KH TTS job ${job.id} was cancelled${job.cancellation_note ? ` (${job.cancellation_note})` : ''}. `
          + 'Its reservation was released; Retry submits a new job. No fallback route was attempted.'
        : `GenStudio KH generation failed${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + 'No fallback route was attempted.',
    )
    this.name = 'GenStudioTtsTerminalFailureError'
  }
}

export class GenStudioTranscriptionTerminalFailureError extends GenStudioTerminalFailureError {
  constructor(job: GenStudioSettledJobShape) {
    super(
      'transcription',
      job,
      job.cancelled === true
        ? `GenStudio KH transcription job ${job.id} was cancelled${job.cancellation_note ? ` (${job.cancellation_note})` : ''}. `
          + 'Its reservation was released; Retry submits a new job. '
          + 'No fallback route was attempted.'
        : `GenStudio KH transcription failed${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + 'No fallback route was attempted.',
    )
    this.name = 'GenStudioTranscriptionTerminalFailureError'
  }
}

/**
 * A durable language job that GenStudio settled as `failed`.
 *
 * THIS IS THE WHOLE REASON `/v1/chat/responses` exists for Story Studio. Over
 * `/v1/chat/completions` the same outcome arrives as a bare 502 whose body is
 * `{"detail": "language generation failed"}` with NO code, so the app cannot
 * tell "the provider failed, retry is free" apart from "GenStudio could not
 * confirm the provider had NOT already accepted this, so retrying risks a
 * SECOND CHARGE". The durable job publishes `failure_code`, and this error
 * carries it through unchanged — the message comes from
 * `describeGenStudioLanguageFailure()` whenever the code is one of the two
 * published ones, so the wording and the no-auto-retry behaviour cannot drift
 * apart.
 */
export class GenStudioChatTerminalFailureError extends GenStudioTerminalFailureError {
  constructor(job: GenStudioSettledJobShape) {
    super(
      'chat',
      job,
      describeGenStudioLanguageFailure(settledFailureCode(job))
        ?? (job.cancelled === true
          ? `GenStudio KH language job ${job.id} was cancelled${job.cancellation_note ? ` (${job.cancellation_note})` : ''}. `
            + 'Its reservation was released; Retry submits a new job.'
          : `GenStudio KH language generation failed${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
            + 'The reservation was released and this job cannot be reopened; Retry submits a new job. '
            + 'No fallback route was attempted.'),
    )
    this.name = 'GenStudioChatTerminalFailureError'
  }
}

/**
 * A transcription quote settled before it could be confirmed into a job.
 *
 * Quotes carry `expires_at`, so a saved idempotency key can outlive the quote
 * it was minted for. Replaying that key only re-reads the dead quote, which is
 * why this is typed: the next Retry has to mint a NEW identity instead of
 * matching on the provider's wording.
 */
export class GenStudioTranscriptionQuoteExpiredError extends Error {
  readonly terminal = true as const
  readonly modality: GenStudioModality = 'transcription'
  readonly status: number

  constructor(status: number, detail: string) {
    super(
      `GenStudio KH could not confirm this transcription quote (HTTP ${status}): ${detail}. `
      + 'The quote expired or was already settled; no transcription was created and nothing was charged. '
      + 'Retry submits one fresh quote.',
    )
    this.name = 'GenStudioTranscriptionQuoteExpiredError'
    this.status = status
  }
}

/**
 * The job succeeded but GenStudio no longer serves its private artifact
 * (expired asset, or a completion with no download URL). Replaying the same
 * idempotency key would return the same job and the same missing bytes, so this
 * is terminal for recovery purposes even though the job itself did not fail.
 */
export class GenStudioArtifactUnavailableError extends Error {
  readonly terminal = true as const
  readonly modality: GenStudioModality
  readonly jobId: string
  readonly status: number

  constructor(modality: GenStudioModality, jobId: string, status: number, message: string) {
    super(message)
    this.name = 'GenStudioArtifactUnavailableError'
    this.modality = modality
    this.jobId = jobId
    this.status = status
  }
}

export class GenStudioImageArtifactUnavailableError extends GenStudioArtifactUnavailableError {
  constructor(jobId: string, status: number, detail?: string) {
    super(
      'image',
      jobId,
      status,
      `GenStudio KH image download failed${status ? ` (HTTP ${status})` : ''}`
      + `${detail ? ` — ${detail}` : ''}: job ${jobId} no longer serves its artifact. `
      + 'Retry submits a new job; the original reservation was already settled.',
    )
    this.name = 'GenStudioImageArtifactUnavailableError'
  }
}

export class GenStudioTtsArtifactUnavailableError extends GenStudioArtifactUnavailableError {
  constructor(jobId: string, status: number, detail?: string) {
    super(
      'tts',
      jobId,
      status,
      status
        ? `GenStudio KH audio download failed (HTTP ${status})${detail ? ` — ${detail}` : ''}: `
          + `job ${jobId} no longer serves its artifact. Retry submits a new job.`
        : `GenStudio KH job completed without an audio download URL: job ${jobId} `
          + 'no longer serves its artifact. Retry submits a new job.',
    )
    this.name = 'GenStudioTtsArtifactUnavailableError'
  }
}

export class GenStudioTranscriptionArtifactUnavailableError extends GenStudioArtifactUnavailableError {
  constructor(jobId: string, status: number, detail?: string) {
    super(
      'transcription',
      jobId,
      status,
      status
        ? `GenStudio KH SRT download failed (HTTP ${status})${detail ? ` — ${detail}` : ''}: `
          + `job ${jobId} no longer serves its artifact. Retry submits a new job.`
        : `GenStudio KH transcription completed without an SRT download URL: job ${jobId} `
          + 'no longer serves its artifact. Retry submits a new job.',
    )
    this.name = 'GenStudioTranscriptionArtifactUnavailableError'
  }
}

/**
 * True when GenStudio has already settled this request's outcome, for any
 * modality. Reconnecting to a settled job re-reads the same record forever, so
 * this is the single check every reconnect/recovery path branches on.
 */
export function isGenStudioSettledOutcomeError(error: unknown): boolean {
  return error instanceof GenStudioTerminalFailureError
    || error instanceof GenStudioArtifactUnavailableError
    || error instanceof GenStudioTranscriptionQuoteExpiredError
}

export interface GenStudioRetryScope {
  /**
   * Opaque token folded into the provider idempotency identity. Same token ⇒
   * same idempotency key ⇒ GenStudio replays the existing job instead of
   * charging for a second one.
   */
  scope: string
  /** True when this scope was minted to escape a terminal provider failure. */
  isRetry: boolean
  /** The terminal job this retry replaces, when there is one. */
  previousTaskId?: string
}

/**
 * Resolve the request scope for one durable asset (video / TTS / transcription).
 *
 * The identity has to be two things at once:
 *
 *  - FRESH after a terminal failure, or a manual Retry replays the dead job's
 *    idempotency key forever and never submits new work.
 *  - STABLE if the fresh submission's response is lost, or a reconnect mints a
 *    second scope and pays twice for the same asset.
 *
 * Both fall out of deriving the scope deterministically from persisted state —
 * the base scope plus the id of the job that failed — and never from a clock or
 * a random value. This is the modality-agnostic twin of `resolveImageRetryScope`
 * in lib/manifest-recovery.ts.
 */
export function resolveGenStudioRetryScope(
  entry: { task_id?: string; last_state?: string; request_scope?: string } | null | undefined,
  baseScope: string,
  isTerminalEntry: (entry: { task_id?: string; last_state?: string }) => boolean,
): GenStudioRetryScope {
  const saved = typeof entry?.request_scope === 'string' ? entry.request_scope.trim() : ''
  // Only adopt (and only promote) a saved scope that belongs to this base
  // attempt. A pre-scope manifest entry counts as belonging — it was submitted
  // under the bare base.
  const inChain = !saved || saved === baseScope || saved.startsWith(`${baseScope}:retry:`)
  const current = inChain && saved ? saved : baseScope
  if (!entry || !inChain || !isTerminalEntry(entry)) {
    return { scope: current, isRetry: current !== baseScope }
  }
  const token = createHash('sha256')
    .update(`${current}\n${entry.task_id || entry.request_scope || ''}`)
    .digest('hex')
    .slice(0, 12)
  return { scope: `${baseScope}:retry:${token}`, isRetry: true, previousTaskId: entry.task_id }
}

export interface GenStudioTtsRequest extends GenStudioOperationContext {
  text: string
  voiceId?: string
  /**
   * `TTSModelResponse.id` — the speech PRODUCT this request buys. GenStudio
   * sells speech by model and made `model_id` a required body field when TTS
   * pricing went model-first; a voice is only a compatible identity behind a
   * model and can never select a price on its own. Omitting it is a flat
   * `422 {"loc":["body","model_id"],"msg":"Field required"}` before any
   * provider is contacted.
   *
   * Optional here for the same reason `maxInputCharacters` is: recovery
   * reattaches to a job whose body — and therefore whose product — was decided
   * at submission time. Required by `GenStudioTtsSubmitRequest`, which every
   * submitting entry point takes.
   */
  modelId?: string | null
  speed: number
  /**
   * `TTSModelResponse.maximum_input_characters` for the model that will serve
   * this request. Story Studio never assumes a boundary: the caller resolves it
   * from the live catalogue and passes it in, so a catalogue change takes effect
   * on the very next submission. Required to SUBMIT — `buildGenStudioSubmission`
   * refuses without it. The recovery path reclaims an already-accepted job and
   * never re-derives a boundary for it, so it is optional here — and required
   * by `GenStudioTtsSubmitRequest`, which every submitting entry point takes.
   */
  maxInputCharacters?: number | null
  /**
   * Control values for THIS request, already resolved against the selected
   * model's published `controls[]` by `resolveTtsControlValues`.
   *
   * Never a raw form or a remembered map: only names the selected model
   * publishes may appear here, and every value is inside the range that model
   * published for it. Absent (or empty) means the model publishes no controls,
   * in which case nothing is sent and the idempotency digest is unchanged.
   */
  controls?: TtsControlValues
  /** Stable Story asset identity, such as project + episode + output file. */
  requestIdentity?: string
  /** Reuse a key already checkpointed beside the Story asset. */
  idempotencyKey?: string
  onProgress?: (received: number, total?: number) => void
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
  onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
}

/**
 * A TTS request that will SUBMIT new work, as opposed to reclaiming work
 * GenStudio already accepted.
 *
 * `maxInputCharacters` is optional on `GenStudioTtsRequest` because recovery
 * genuinely has no use for it: it reattaches to a job whose body was decided at
 * submission time. That optionality is also exactly how EP0067 broke — the
 * generator built its request object without the field, nothing objected at
 * build time, and the submit path's own `buildGenStudioSubmission` call refused
 * at runtime with a sentence blaming GenStudio for a figure GenStudio had
 * published correctly all along.
 *
 * The submitting entry points take THIS type, so the same omission is now a
 * compile error rather than ten failed sections and a wrong diagnosis. Every
 * test that submits already supplies the figure; only the one production caller
 * did not, which is why a green suite proved nothing.
 *
 * `modelId` joined it for the identical reason, one layer down: with the
 * boundary carried, all ten EP0067 sections reached GenStudio and were refused
 * `422 model_id: Field required`, because the submission body has never carried
 * the selected product at all. The generator knew it (`req.model`), printed it,
 * quoted with it, and dropped it on the way to the wire.
 */
export interface GenStudioTtsSubmitRequest extends GenStudioTtsRequest {
  maxInputCharacters: number
  modelId: string
}

export interface GenStudioTranscriptionModel {
  id: string
  display_name: string
  provider: string
  /**
   * `TranscriptionModelResponse.language` — one string, usually the sentinel
   * `"multilingual"`. EMPTY when GenStudio published nothing, which is a
   * different fact from "this model detects the language" and is rendered
   * differently. Never defaulted to a language code.
   */
  language: string
  /**
   * The language codes this model accepts, in the form the request's
   * `language` field expects. GenStudio does not publish this yet (see
   * docs/genstudio-handoff/transcription-language-request.md) so it is empty
   * today — and empty means "not published", never "supports nothing". The
   * moment GenStudio ships `supported_languages[]` the picker becomes a real
   * list with no release on this side.
   */
  supported_languages: string[]
  /**
   * Whether omitting `language` means the model detects it. `null` when
   * GenStudio has not said — Story Studio assumes detection and says so,
   * rather than pretending it was told.
   */
  supports_language_auto_detect: boolean | null
  available: boolean
  available_workers: number
  qualification_only: boolean
  /**
   * Published per-SECOND rate for this model.
   *
   * GenStudio prices transcription by the second (see
   * docs/genstudio-handoff/pricing-display-request.md). This previously read
   * `credits_per_minute` — a field GenStudio has never published — so the
   * parse always fell through to 0 and every model looked free. 0 now means
   * only what it has always meant elsewhere on this transport: GenStudio
   * published no rate. It is never a Story Studio guess, and it is never
   * rendered as "free".
   */
  credits_per_second: number
  /** Floor applied to a priced request. A per-second rate with a floor is how
   *  transcription is actually billed, so both must be read together — a short
   *  clip is charged the floor, not rate × seconds. */
  minimum_credits: number
  price_version: string
}

/** One published `(resolution, aspect_ratio)` pair from `ImageOutputOptionResponse`. */
export interface GenStudioImageOutputOption {
  resolution: string
  aspect_ratio: string
  width: number
  height: number
  is_default: boolean
  credits_per_image?: number
  base_credits_per_image?: number
  price_version?: string
  reference_generation_credits?: number
  reference_generation_price_version?: string
}

/**
 * `ImageModelResponse` — everything GenStudio publishes about one image model.
 *
 * Every optional field here means exactly one thing: GenStudio published
 * nothing about that concept for this model. Consumers must treat `undefined`
 * as "no contract", which is "omit the control" or "leave the behaviour to the
 * provider" — never "assume false" and never "assume a plausible number".
 * Nothing that GenStudio does not publish appears on this interface, so a
 * capability cannot be invented on the way through the transport.
 */
export interface GenStudioImageModel {
  id: string
  display_name: string
  /** Published model creator/provider label. Absent until GenStudio supplies it. */
  provider_name?: string
  description?: string
  available: boolean
  /** Why an unavailable model is unavailable, when GenStudio explains it. */
  availability_note?: string
  qualification_only: boolean
  execution_label?: string
  credits_per_image: number | null
  /** Undiscounted list price; present when a promotion is running. */
  base_credits_per_image: number | null
  minimum_credits: number | null
  price_version: string | null
  promotion_name?: string
  promotion_discount_percent?: number
  chargeable: boolean
  aspect_ratios: string[]
  default_aspect_ratio: string
  /** Published resolution label used when a request names none. */
  default_resolution?: string
  /** Valid `(resolution, aspect_ratio)` pairs with their own pricing. */
  output_options?: GenStudioImageOutputOption[]
  supports_reference_images: boolean
  /** Explicit img2img flag, where a model separates it from plain references. */
  supports_image_to_image?: boolean
  /** Whether a deterministic seed is honoured by this model. */
  supports_seed?: boolean
  min_reference_images?: number
  max_reference_images: number
  /** Longest edge GenStudio accepts on an uploaded reference image. */
  reference_image_max_dimension?: number
  reference_generation_credits?: number
  reference_generation_price_version?: string
  reference_strength_mode: string
  supported_reference_strengths: string[]
  /** Provider-declared prompt ceiling, in characters. */
  max_prompt_characters?: number
  /** Provider-declared prompt budget in tokens. NEVER converted to characters. */
  prompt_token_allowance?: number
  /** Operations this model serves (e.g. `image.generation`, `image.edit`). */
  operations?: string[]
}

interface GenStudioImageJob {
  id: string
  state: GenStudioJob['state']
  model_id: string
  prompt: string
  width: number
  height: number
  aspect_ratio: string
  steps: number
  seed?: number | null
  failure_code?: string | null
  routing_status_code?: string | null
  /**
   * `ImageJobResponse` publishes only these two credit fields — there is no
   * `released_credits` / `reserved_credits` / `settled_credits` on an image
   * job. The full triad lives on `GET /v1/account/jobs` only.
   */
  credit_cost?: number
  remaining_credits?: number
  cancellable?: boolean | null
  cancelled?: boolean | null
  cancellation_note?: string | null
  idempotent_replay?: boolean
  image_url?: string | null
}

/**
 * `ImageGenerationRequest` — prompt, model_id, aspect_ratio, resolution, seed,
 * reference_asset_ids. There is no `steps` field: inference steps are not a
 * customer control, and Story Studio does not send one.
 */
export interface GenStudioImageRequest extends GenStudioOperationContext {
  prompt: string
  modelId: string
  aspectRatio: string
  /**
   * Resolution LABEL from the model's published `output_options[]` (e.g. "1K"),
   * never a locally invented ladder. Absent means the model published no
   * output options, so GenStudio applies its own `default_resolution`.
   */
  resolution?: string
  width?: number
  height?: number
  seed?: number
  /** One private GenStudio source asset for supported image-to-image models. */
  referenceAssetIds?: string[]
  /** Stable for this Story Studio submission, distinct for a deliberate rerender. */
  requestIdentity?: string
  /** Reuse a key checkpointed before the charged image POST. */
  idempotencyKey?: string
  onState?: (state: GenStudioJob['state']) => void
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
}

interface GenStudioTranscriptionJob {
  id: string
  state: GenStudioJob['state']
  model_id: string
  failure_code?: string | null
  routing_status_code?: string | null
  srt_url?: string | null
  credit_cost?: number
  remaining_credits?: number
  /**
   * `TranscriptionJobResponse` DOES publish `released_credits` (image, chat,
   * video and music jobs do not). Story Studio forwards it verbatim so the UI
   * can show real settlement instead of a permanent "on hold".
   */
  released_credits?: number | null
  price_version?: string | null
  cancellable?: boolean | null
  cancelled?: boolean | null
  cancellation_note?: string | null
}

export interface GenStudioTranscriptionRequest extends GenStudioOperationContext {
  audioPath: string
  modelId: string
  /** Stable Story asset identity; never use a transient queue job ID here. */
  requestIdentity: string
  /** Reuse a key already checkpointed beside the Story asset. */
  idempotencyKey?: string
  language?: string
  wordTimestamps?: boolean
  onState?: (state: GenStudioTranscriptionJob['state'], jobId: string) => void | Promise<void>
  onJobAccepted?: (jobId: string, idempotencyKey: string, fileSha256: string) => void | Promise<void>
}

export interface GenStudioSubmission {
  body: {
    /** `TTSModelResponse.id` — the product GenStudio prices and bills. */
    model_id: string
    voice_id: string
    text: string
    speed: number
    /** Present ONLY when the selected model published controls to send. */
    controls?: TtsControlValues
  }
  idempotencyKey: string
}

/**
 * `StandardVoiceResponse`. Every field here is published by GenStudio; none is
 * derived. Provider and engine identity are customer-facing (AGENTS.md
 * "Provider Transparency") and travel all the way to the picker.
 */
export interface GenStudioVoice {
  id: string
  display_name: string
  language?: string
  description?: string
  provider?: string
  engine_id?: string
  engine_name?: string
  model_revision_id?: string
  model_family?: string
  voice_tier?: string
  voice_revision?: string
  custom_voice_id?: string | null
  public_voice_id?: string | null
  /** The voice's own rate. Differs from the model's rate on some voices. */
  credits_per_1000_characters?: number
  output_format?: string
  catalog_status?: string
  quote_enabled?: boolean
  generation_enabled?: boolean
  preview_available?: boolean
  preview_url?: string | null
  preview_text?: string | null
  preview_notice?: string | null
  /** GenStudio owns this. Story Studio reflects it and never shadows it. */
  is_saved?: boolean
  /** The TTS model this voice runs on — the compatibility key for the picker. */
  tts_model_id?: string | null
  tts_model_name?: string | null
}

/** `TTSModelResponse` — the selection and pricing axis for speech. */
export interface GenStudioTtsModel {
  id: string
  display_name: string
  provider_id: string
  provider_name: string
  description: string
  credits_per_1000_characters: number
  minimum_credits: number
  maximum_input_characters: number
  supports_speed: boolean
  supports_voice_cloning: boolean
  preview_policy: string
  generation_enabled: boolean
  /**
   * Optional `TTSModelResponse.provider_submit_concurrency` hint. It is not
   * capacity Story Studio owns or a submission gate; a null value means the
   * selected model publishes no usable fan-out hint.
   */
  provider_submit_concurrency: number | null
  /**
   * `TTSModelResponse.controls[]` — every extra knob THIS model takes, with
   * its own label, type, bounds, default and description. Story Studio renders
   * the list and never names a member of it (lib/tts-controls.ts). An empty
   * list means this model takes no controls, and none are shown or sent.
   */
  controls: GenStudioTtsControl[]
}

/** `GET /v1/music/models` — an account-visible music product published by GenStudio. */
export interface GenStudioMusicModel {
  id: string
  display_name: string
  /** Display only; absent means GenStudio published no provider. */
  provider_name?: string
  description: string
  coming_soon: boolean
  credits_per_request: number
  minimum_credits: number
  price_version: string
  standard_credits: number | null
  sale_credits: number | null
  sale_ends_at: string | null
  sale_disclaimer: string | null
  supports_instrumental: boolean
  supports_vocals: boolean
  requires_lyrics: boolean
  max_prompt_characters: number
  max_prompt_without_lyrics_characters: number | null
  min_prompt_characters: number
  max_lyrics_characters: number
  min_lyrics_characters: number
  max_title_characters: number
  outputs_per_request: number | null
}

/**
 * `TTSQuoteResponse` — GenStudio's own figure for one exact script.
 *
 * Every numeric below is `number | null`, and `null` means exactly one thing:
 * **GenStudio's 200 response did not carry this field.** It is never a stand-in
 * for a failed call — a non-200 quote throws `GenStudioApiError` in `readJson`
 * before this shape is ever built, so a caller holding one of these knows the
 * quote succeeded.
 *
 * These used to be coerced with `?? 0`, which collapsed "absent", "the response
 * was not a quote at all" and "genuinely zero" into one indistinguishable
 * number. On `credits` that read as FREE; on `maximum_input_characters` it made
 * the boundary guards below blame GenStudio for publishing nothing when the
 * real failure was a transport one. Do not reintroduce a default here — a
 * missing figure is reported, never replaced.
 */
export interface GenStudioTtsQuote {
  model_id?: string | null
  model_name?: string | null
  /** The control values GenStudio priced, echoed back from the request. */
  controls: TtsControlValues
  voice_id: string
  voice_tier: string
  billable_characters: number | null
  speed: number | null
  estimated_duration_ms: number | null
  maximum_input_characters: number | null
  credits: number | null
  credits_per_1000_characters: number | null
  price_version: string
  output_format: string
  chargeable: boolean
  generation_enabled: boolean
  notice: string
}

/**
 * GenStudio publishes one browsable library route per provider and no
 * discovery endpoint for them, so the published set lives here — in ONE place,
 * named after the providers exactly as GenStudio names them. A third library
 * is one entry. Nothing else in Story Studio may enumerate voice providers.
 */
export const GENSTUDIO_VOICE_LIBRARIES = [
  { id: 'elevenlabs', label: 'ElevenLabs', provider_id: 'elevenlabs-direct', path: '/v1/voice-library/elevenlabs' },
  { id: 'fish', label: 'Fish Audio', provider_id: 'fish-audio', path: '/v1/voice-library/fish' },
] as const

export type GenStudioVoiceLibraryId = typeof GENSTUDIO_VOICE_LIBRARIES[number]['id']

/** A row from either library page response. Both publish the same core shape. */
export interface GenStudioLibraryVoice {
  public_voice_id: string
  name: string
  description: string
  language: string
  accent?: string | null
  gender?: string | null
  age?: string | null
  use_case?: string | null
  category?: string | null
  preview_available: boolean
  preview_url: string | null
  notice_period_days?: number | null
  genstudio_voice_id?: string | null
  is_saved?: boolean
  credits_per_1000_characters?: number
}

export interface GenStudioLibraryPage {
  page: number
  has_more: boolean
  voices: GenStudioLibraryVoice[]
}

export interface GenStudioModelCapability {
  id: string
  revision: string
  display_name: string
  description?: string
  modality: 'audio' | 'image' | 'text' | 'video'
  operation: 'voice.tts' | 'audio.transcription' | 'image.generation' | 'chat.response' | 'video.generation'
  availability: 'available' | 'unavailable' | 'unknown'
  qualification_only: boolean
  pricing_unit?: string
  limits: Record<string, unknown>
  controls: Record<string, unknown>
}

export interface GenStudioChatModel {
  id: string
  display_name: string
  /** Published model creator/provider label. Absent until GenStudio supplies it. */
  provider_name?: string
  description?: string
  available: boolean
  qualification_only: boolean
  /**
   * Total prompt-plus-output budget published for this product.
   *
   * Read from GenStudio's `context_window_tokens`. The older
   * `context_limit_tokens` is a BACKWARDS-COMPATIBILITY ALIAS ONLY and is
   * consulted only when the current field is absent (an older GenStudio).
   * 0 means "not published" — never a Story Studio guess.
   */
  context_window_tokens: number
  /**
   * Maximum selectable output allowance published for this product.
   *
   * 0 means "not published" — same contract as `context_window_tokens`.
   * Story Studio never substitutes a figure of its own here; a product that
   * publishes no output ceiling is refused at submission time instead.
   */
  max_output_tokens: number
  controls: string[]
  activation_blockers: string[]
  input_credits_per_million_tokens: number
  output_credits_per_million_tokens: number
  minimum_credits: number
  price_version: string
  input_modalities: Array<'text' | 'image'>
  supports_vision: boolean
  max_input_images: number
  accepted_image_mime_types: string[]
  max_image_bytes: number
  max_image_dimension: number
  supported_detail_levels: Array<'low' | 'high' | 'auto'>
  supports_structured_output: boolean
  structured_output_mode: 'json_object' | 'request_json_schema'
  // ── Live web-search capability (published per product) ────────────────
  // Story Studio selects a web-research product by CAPABILITY ONLY. Never
  // infer any of this from a provider or model name.
  /** The product can run provider-side web searches. */
  supports_web_search: boolean
  /** The product returns citations for what it searched. */
  returns_citations: boolean
  /** Shape of those citations. Only 'structured' is machine-readable; any
   *  other value (including a prose format) is unusable as evidence. */
  citation_format: string | null
  /** The product accepts allow/block domain lists on the `web_search` block. */
  supports_domain_filters: boolean
  /** GenStudio has qualified this product for evidence-backed research. Until
   *  GenStudio flips this, web research mode stays unavailable — Story Studio
   *  must not second-guess the flag. */
  research_qualified: boolean
  /** GenStudio will accept `web_search.claim_attribution` for this product and
   *  return `citation_claims` linking individual claims to the pages it really
   *  retrieved. Absent on a GenStudio build that predates the field, which is
   *  exactly how this app tells the difference — so it reads false there and
   *  research keeps its existing run-level behaviour. */
  supports_claim_attribution: boolean
  /** Published per-search rate. A RATE, not a total: this app never multiplies
   *  it into a customer charge. Null when the catalogue does not publish one. */
  web_search_credits_per_search: number | null
  /** Published FLAT per-request web-research rate, charged in addition to the
   *  per-search figure. Also a RATE, never multiplied into a total here.
   *  Null when the catalogue does not publish one. */
  web_research_credits_per_request: number | null
  /** Enforceable cap on searches per request, or null when GenStudio cannot
   *  honestly enforce one (the current state — the provider searches
   *  autonomously). Null means "no depth control exists to offer". */
  max_web_searches: number | null
}

export interface GenStudioImageSourceAsset {
  id: string
  media_type: string
  byte_size: number
  width: number
  height: number
  expires_at: string
}

/**
 * One published `(duration, resolution)` pair with its own price.
 *
 * `duration_seconds` and `resolution` are DELIBERATELY a plain number and a
 * plain string. GenStudio publishes durations across 3-15 seconds and
 * resolutions across `480p|720p|1080p|4k`, and will publish more; a literal
 * union here is a copy of the catalogue, which the first rule in AGENTS.md
 * forbids. The parse validates SHAPE — a positive duration, a non-empty
 * resolution label, finite prices — never MEMBERSHIP of a list this app
 * happens to know today.
 */
export interface GenStudioVideoVariant {
  duration_seconds: number
  resolution: string
  credits_per_video: number
  minimum_credits: number
  price_version: string
}

export interface GenStudioVideoModel {
  id: string
  display_name: string
  description?: string
  available: boolean
  /**
   * Every mode GenStudio publishes for this model, unfiltered.
   *
   * Story Studio's own surfaces are image-to-video only (AGENTS.md, "Video
   * Model Boundary"), but that is a CALL-SITE rule, not a reason to discard
   * published catalogue data on the way in. Discarding it here would mean a
   * future surface needs a transport change to see what GenStudio already
   * said. Callers select with `supportsGenStudioVideoMode`.
   */
  modes: string[]
  aspect_ratios: string[]
  variants: GenStudioVideoVariant[]
  /**
   * Does the product return a clip that carries its OWN audio track?
   *
   * TRI-STATE ON PURPOSE. `true` / `false` are GenStudio's answer; `null` means
   * the catalogue said nothing, which is not the same as "no audio" and must
   * never be rendered as one. Story Studio's video assembly composes narration
   * over the clip and drops any embedded track, so a `true` here is money the
   * customer spends on something the finished episode will not contain — which
   * is exactly why it has to reach the picker instead of dying at the parse.
   */
  generates_audio: boolean | null
}

/** Story Studio's one video mode. Enforced where a request is BUILT, never by
 *  dropping modes during the catalogue parse. */
export const STORY_STUDIO_VIDEO_MODE = 'image-to-video'

/** Does this model publish the mode Story Studio actually submits? */
export function supportsGenStudioVideoMode(
  model: Pick<GenStudioVideoModel, 'modes'>,
  mode: string = STORY_STUDIO_VIDEO_MODE,
): boolean {
  return Array.isArray(model.modes) && model.modes.includes(mode)
}

/**
 * The cheapest published variant, or null when the model publishes none.
 *
 * Null is a real answer and callers must handle it by failing loudly: a model
 * with no published variant has no price and no honest default, and inventing
 * "5 seconds at 720p" is exactly the hardcoded ladder the first rule forbids.
 * Ties break towards the shorter clip, then the lexically first resolution, so
 * the choice is deterministic across catalogue reorderings.
 */
export function cheapestGenStudioVideoVariant(
  variants: readonly GenStudioVideoVariant[] | undefined | null,
): GenStudioVideoVariant | null {
  if (!Array.isArray(variants) || !variants.length) return null
  return [...variants].sort((a, b) => (
    a.credits_per_video - b.credits_per_video
    || a.minimum_credits - b.minimum_credits
    || a.duration_seconds - b.duration_seconds
    || a.resolution.localeCompare(b.resolution)
  ))[0]!
}

/** The published variant matching an exact (duration, resolution), or null.
 *  Null means "GenStudio does not publish this combination" and must be
 *  REJECTED by the caller — never quietly replaced with a nearby one. */
export function findGenStudioVideoVariant(
  variants: readonly GenStudioVideoVariant[] | undefined | null,
  durationSeconds: number,
  resolution: string,
): GenStudioVideoVariant | null {
  if (!Array.isArray(variants)) return null
  return variants.find(variant => (
    variant.duration_seconds === durationSeconds
    && variant.resolution.toLowerCase() === String(resolution).trim().toLowerCase()
  )) || null
}

/** How a published variant reads in a picker, an error, or a job log. */
export function describeGenStudioVideoVariant(variant: GenStudioVideoVariant): string {
  return `${variant.duration_seconds}s at ${variant.resolution}`
}

/**
 * `ChatJobResponse` — one durable language job on `POST /v1/chat/responses`.
 *
 * Terminal states are `succeeded` and `failed` ONLY; there is no cancelled or
 * rejected state on this route, which is why `waitForChatJob` polls on
 * `isTerminalGenStudioJobState` rather than on the image/TTS `cancelled` flag.
 *
 * The research envelope (`citations`, `citation_claims`, `research_ran_at`,
 * `web_searches_executed`, `web_search_credit_cost`) sits at the TOP LEVEL of
 * this response, exactly as it does on the synchronous
 * `OpenAIChatCompletionResponse` — see `GenStudioResearchEnvelope`, which both
 * shapes extend so a single parser serves both routes.
 */
interface GenStudioChatJob extends GenStudioResearchEnvelope {
  id: string
  state: GenStudioJob['state']
  operation?: string
  dispatch_mode?: string
  model_id: string
  output_text?: string | null
  /** False once GenStudio has dropped the retained text for this job. */
  output_retained?: boolean | null
  finish_reason?: string | null
  failure_code?: string | null
  routing_status_code?: string | null
  credit_cost?: number
  remaining_credits?: number
  price_version?: string | null
  /** True when this response replayed an existing job for the same key. */
  idempotent_replay?: boolean | null
}

interface GenStudioVideoSourceAsset {
  id: string
  media_type: string
  byte_size: number
  width: number
  height: number
  expires_at: string
}

interface GenStudioVideoJob extends GenStudioJob {
  model_id: string
  video_url?: string | null
  /**
   * `VideoJobResponse` carries `cancellation_requested` / `cancelled` — there
   * is no `cancellable` and no `cancellation_note`, and (unlike TTS and
   * transcription) no `released_credits`. Never invent one.
   */
  cancellation_requested?: boolean
  cancelled?: boolean
}

export interface GenStudioVideoRequest extends GenStudioOperationContext {
  prompt: string
  modelId: string
  sourceImagePath: string
  aspectRatio: string
  /** Taken from a variant the model PUBLISHES. Not a literal union: the
   *  catalogue owns the list, and the caller resolves against it. */
  durationSeconds: number
  resolution: string
  requestIdentity?: string
  /**
   * Reuse a key already checkpointed beside the Story asset. Persisting the key
   * BEFORE the POST is what turns a lost submit response into a replay instead
   * of a second paid job.
   */
  idempotencyKey?: string
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
  onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
}

export interface GenStudioVideoResult {
  videoUrl: string
  jobId: string
  modelId: string
  downloadHeaders: Record<string, string>
  creditCost?: number
  remainingCredits?: number
  priceVersion?: string | null
}

export interface GenStudioAccountOverview {
  credit_balance: number
  credits_used_30d: number
  subscription_plan_name: string
  /** @deprecated GenStudio 0.16 compatibility alias. */
  api_concurrency_limit?: number
  paid_concurrency_limit: number
  paid_active_jobs: number
  paid_queued_jobs: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
  total_jobs: number
  active_jobs: number
  completed_jobs: number
  failed_jobs: number
  available_assets: number
  next_asset_expiration: string | null
}

export interface GenStudioCustomerJob {
  id: string
  operation: GenStudioModelCapability['operation']
  state: GenStudioJob['state']
  model_id: string
  credit_cost: number
  reserved_credits: number
  settled_credits: number
  released_credits: number
  failure_code: string | null
  routing_status_code: string | null
  created_at: string
  updated_at: string
}

export interface GenStudioCreditActivity {
  id: string
  kind: 'credit' | 'charge' | 'return'
  description: string
  credits: number
  state: string
  reason_code: string
  balance_after: number | null
  created_at: string
  job_id: string | null
}

export interface GenStudioChatRequest extends GenStudioOperationContext {
  modelId: string
  system: string
  userMessage: string
  /**
   * Requested sampling temperature.
   *
   * SENT ONLY when the selected product publishes the `temperature` control
   * (see `productPublishesControl`). It is still part of the idempotency
   * digest on every request — see `LEGACY_CHAT_TEMPERATURE_DIGEST_DEFAULT`.
   */
  temperature?: number
  /**
   * An exact number of output tokens. Callers that can compute their own hard
   * ceiling still may; anything above the product's published limit is refused
   * before the request is submitted. Prefer `outputBudget` — it derives the
   * number from whatever the selected product publishes, so it cannot go stale
   * and cannot overshoot.
   */
  maxOutputTokens?: number
  /**
   * The SHAPE of this workflow's output. Resolved against the selected
   * product's published `max_output_tokens` at submission time. Absent means
   * short-form, which is the historical 2,048-token default.
   */
  outputBudget?: OutputBudget
  requestIdentity?: string
  idempotencyKey?: string
  /**
   * Read an existing durable request by its saved idempotency key. This is
   * recovery only: a missing or unreachable lookup never falls through to POST.
   */
  recoverByIdempotencyKey?: boolean
  /** Server-recorded pending keys allowed to use read-only recovery. */
  allowedRecoveryKeys?: string[]
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
  onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
  /** A private GenStudio-owned image asset for a vision-capable chat model. */
  inputImage?: { assetId: string; detail: 'low' | 'high' | 'auto' }
  /** Exact workflow contract; catalog mode compatibility is checked before spend. */
  outputContract?: TextOutputContract
  /** @deprecated Use outputContract. Preserved for older JSON Object callers. */
  jsonObject?: boolean
  /**
   * Live web search for this request. Serialized verbatim as the request's
   * `web_search` block. Built by services/research/web-capability.ts against
   * the SELECTED product's published capability — `max_searches` is present
   * only when that product publishes a non-null `max_web_searches`, and the
   * domain lists are present only when it publishes
   * `supports_domain_filters`. Omit the field entirely for a normal request.
   */
  webSearch?: GenStudioWebSearchBlock
  /**
   * Force one language route for this call. Leave unset in product code — the
   * route is a deployment decision, resolved once by
   * `resolveGenStudioChatTransport()`. Present so a test can pin either side
   * of the switch without mutating process state.
   */
  transport?: GenStudioChatTransport
}

/**
 * Which GenStudio language route a chat request takes.
 *
 * - `responses`   `POST /v1/chat/responses` → 202 + durable job + poll. The
 *                 default, and the only route that publishes `failure_code`,
 *                 so it is the only route on which Story Studio can tell a
 *                 retryable provider failure apart from one that might already
 *                 have been charged.
 * - `completions` `POST /v1/chat/completions`, one blocking call. Kept for
 *                 rollback only.
 */
export type GenStudioChatTransport = 'responses' | 'completions'

/** Set to `completions` to roll the whole app back to the synchronous route. */
export const GENSTUDIO_CHAT_TRANSPORT_ENV = 'STORY_STUDIO_GENSTUDIO_CHAT_TRANSPORT'

/**
 * THE SINGLE SWITCH POINT for the language route.
 *
 * Every language call in Story Studio funnels through `callChatWithGenStudio`,
 * which asks this function once and branches once. Rolling back is therefore
 * one environment variable — `STORY_STUDIO_GENSTUDIO_CHAT_TRANSPORT=completions`
 * — and needs no code change, no redeploy of call sites, and no second copy of
 * the guards: both routes run the identical pre-network checks, identical
 * output-token resolution, identical truncation detection and identical local
 * schema validation before and after the wire.
 */
export function resolveGenStudioChatTransport(
  override?: GenStudioChatTransport,
): GenStudioChatTransport {
  if (override === 'completions' || override === 'responses') return override
  return describeGenStudioChatTransport().transport
}

/**
 * Which language route is live, and WHY — for the startup log.
 *
 * WHY THIS EXISTS
 * ---------------
 * GenStudio once diagnosed a chapter-generation failure as Story Studio
 * "overriding its transport to completions". There was no override: the
 * running build simply predated the durable-route code. Nobody on either side
 * could tell which route was live without reading source, so a support
 * question about a customer machine had no answer. Now the answer is one line
 * in the log.
 *
 * `envValue` is the literal contents of an environment variable the operator
 * set. It is NEVER the API key or anything derived from it — this function has
 * no access to a key and must never be given one.
 */
export interface GenStudioChatTransportChoice {
  transport: GenStudioChatTransport
  /** `default` when the env var is unset or blank, `environment` when set. */
  source: 'default' | 'environment'
  /** What the env var literally said, or null when it was not set. */
  envValue: string | null
  /** False when the env var was set to something that is not a route name. */
  envRecognised: boolean
}

export function describeGenStudioChatTransport(
  env: NodeJS.ProcessEnv = process.env,
): GenStudioChatTransportChoice {
  const raw = env[GENSTUDIO_CHAT_TRANSPORT_ENV]
  const configured = (raw || '').trim().toLowerCase()
  if (!configured) {
    return { transport: 'responses', source: 'default', envValue: null, envRecognised: true }
  }
  const recognised = configured === 'completions' || configured === 'responses'
  return {
    transport: configured === 'completions' ? 'completions' : 'responses',
    source: 'environment',
    envValue: (raw || '').trim(),
    envRecognised: recognised,
  }
}

/**
 * The startup line. Written to be answerable on its own: it names the route,
 * the variable that controls it, and whether that variable was actually set.
 */
export function genStudioChatTransportLogLine(env: NodeJS.ProcessEnv = process.env): string {
  const choice = describeGenStudioChatTransport(env)
  const route = choice.transport === 'completions'
    ? 'completions (POST /v1/chat/completions, synchronous — rollback route)'
    : 'responses (POST /v1/chat/responses, durable job + poll — default route)'
  if (choice.source === 'default') {
    return `[genstudio] Language transport: ${route}. Source: built-in default `
      + `(${GENSTUDIO_CHAT_TRANSPORT_ENV} is not set).`
  }
  const recognised = choice.envRecognised
    ? ''
    : ' That value is not a route name, so the default route was kept.'
  return `[genstudio] Language transport: ${route}. Source: environment `
    + `(${GENSTUDIO_CHAT_TRANSPORT_ENV}="${choice.envValue}").${recognised}`
}

/** The request's `web_search` block, exactly as GenStudio accepts it. */
export interface GenStudioWebSearchBlock {
  enabled: true
  allowed_domains: string[]
  blocked_domains: string[]
  /** Present ONLY when the product publishes a non-null `max_web_searches`. */
  max_searches?: number
  /**
   * Ask the model to name, per claim, which of the pages it opened support
   * that claim. GenStudio keeps only the names that match its own record of
   * what was retrieved and returns them as `citation_claims`, so this can add
   * attribution but cannot invent one.
   *
   * Present ONLY when the product publishes `supports_claim_attribution`.
   * An older GenStudio rejects the unknown field outright, so it is omitted
   * rather than sent hopefully.
   */
  claim_attribution?: true
}

/**
 * One provider citation from the response ENVELOPE.
 *
 * Envelope, not model output: these are the provider's record of what it
 * actually read, so they are evidence rather than model-authored claims. A
 * model that writes a URL into its JSON answer is making a claim; a citation
 * here is not.
 */
export interface GenStudioCitation {
  id: string
  url: string
  title: string | null
  /** Contract fields no provider populates today. Left optional and ABSENT
   *  rather than invented — a blank publisher is the honest answer. */
  publisher: string | null
  published_at: string | null
  quote: string | null
  start_index: number | null
  end_index: number | null
  // DELIBERATELY NOT READ: the contract carries a per-source `retrieved_at`,
  // but provider-hosted search does not mean GenStudio fetched the page, so a
  // per-source retrieval time would be falsely precise. Run-level provenance
  // comes from the envelope's `research_ran_at` instead.
}

/**
 * Anything that can declare an incomplete language output — a durable
 * `/chat/responses` job or one `/chat/completions` choice.
 */
export interface GenStudioIncompleteOutput {
  id: string
  model_id: string
  output_text?: string | null
  finish_reason?: string | null
  state?: unknown
  failure_code?: string | null
}

/**
 * The finish reasons that mean "the model chose to stop here". Everything
 * else — `length`, `max_tokens`, `content_filter`, a provider's own dialect —
 * means the answer was cut short by something other than the model finishing
 * its thought, and is never presented as a complete result.
 *
 * Absence counts as a normal stop: GenStudio's OpenAI-compatible response
 * model types `finish_reason` as the literal `"stop"`, so an envelope that
 * omits it is one that could only ever have said `stop`.
 */
const COMPLETE_FINISH_REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'complete', 'completed'])

export function isCompleteFinishReason(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'string') return false
  const reason = value.trim().toLowerCase()
  return reason === '' || COMPLETE_FINISH_REASONS.has(reason)
}

/** A finish reason that specifically means "ran out of output tokens". */
function isTruncationFinishReason(reason: string | null): boolean {
  return !!reason && /^(length|max_tokens|max_output_tokens|token_limit)$/i.test(reason.trim())
}

/**
 * GenStudio completed the HTTP/provider exchange but the output it carries is
 * incomplete. Story Studio NEVER hands the partial text back to a caller as a
 * finished result — the partial is exposed on this error only so a caller with
 * its own completion audit (chunked narration) can preserve the units that did
 * finish before issuing one bounded, deliberate repair request.
 */
export class GenStudioChatIncompleteError extends Error {
  readonly jobId: string
  readonly modelId: string
  readonly partialText: string
  readonly finishReason: string | null
  /** True when the stop was the output-token ceiling, not the model. */
  readonly truncated: boolean

  constructor(job: GenStudioIncompleteOutput) {
    const finishReason = typeof job.finish_reason === 'string' ? job.finish_reason : null
    const truncated = isTruncationFinishReason(finishReason)
    super(
      truncated
        // The user has two real levers here, so name both. "Try again" is not
        // one of them: the same request against the same ceiling truncates
        // again at the same place.
        ? 'The answer was cut off before it finished: this request hit its output-token ceiling '
          + `(GenStudio reported finish_reason "${finishReason}"). Story Studio did not return the `
          + 'partial answer as a finished result. Choose a language product with a larger published '
          + 'output limit, or make the request smaller (fewer chapters, scenes, or items per run), '
          + 'then run it again.'
        : `GenStudio KH reported incomplete chat output${finishReason ? ` (${finishReason})` : ''}. `
          + 'The partial output was not returned as a finished result.',
    )
    this.name = 'GenStudioChatIncompleteError'
    this.jobId = job.id
    this.modelId = job.model_id
    this.partialText = typeof job.output_text === 'string' ? job.output_text : ''
    this.finishReason = finishReason
    this.truncated = truncated
  }
}

/**
 * The requested chat product does not resolve against GenStudio's live
 * catalogue: absent, unpublished, or qualification-only. Thrown strictly
 * before any network submission (see `prepareChatSubmission`'s doc comment),
 * so "No request or credit charge was made" is true, not just reassuring.
 *
 * Typed (rather than a plain `Error`) so a caller that holds a cached model
 * reference — an outline sidecar's `generation_params.model`, a saved batch
 * preset — can distinguish "this exact id is dead" from every other failure
 * mode and heal to the live default instead of hard-failing the whole run.
 * `message` is unchanged from the plain-Error form this replaces, so any
 * caller matching on wording is unaffected.
 */
export class GenStudioChatProductUnavailableError extends Error {
  readonly modelId: string

  constructor(modelId: string) {
    super(
      `The selected GenStudio language product "${modelId}" is not available. Choose a published product before retrying. No request or credit charge was made.`,
    )
    this.name = 'GenStudioChatProductUnavailableError'
    this.modelId = modelId
  }
}

type GenStudioOperation = GenStudioModelCapability['operation']

const genStudioAdmission = new GenStudioAdmissionPool(async (apiKey): Promise<GenStudioAccountCapacity> => {
  const overview = await readAccountJson<GenStudioAccountOverview>(
    apiKey,
    '/v1/account/overview',
  )
  if (
    !Number.isInteger(overview.paid_concurrency_limit)
    || overview.paid_concurrency_limit < 1
  ) {
    throw new Error('GenStudio account overview did not include a valid paid concurrency limit')
  }
  return {
    paid_concurrency_limit: overview.paid_concurrency_limit,
    paid_active_jobs: overview.paid_active_jobs,
    paid_queued_jobs: overview.paid_queued_jobs,
    max_queued_jobs: overview.max_queued_jobs,
    generation_submissions_per_minute: overview.generation_submissions_per_minute,
  }
})

export function genStudioAdmissionSnapshot() {
  return genStudioAdmission.snapshot()
}

function withGenStudioAdmission<T>(
  apiKey: string,
  request: GenStudioOperationContext,
  work: () => Promise<T>,
): Promise<T> {
  return genStudioAdmission.run(
    apiKey,
    request.signal,
    work,
    async (state: GenStudioAdmissionState) => {
      await request.onQueueState?.(state)
    },
  )
}

export async function refreshGenStudioAdmission(apiKey: string) {
  return genStudioAdmission.refreshNow(apiKey)
}

function queueStateForJob(job: GenStudioJob): GenStudioQueueState {
  if (job.state === 'succeeded') return 'succeeded'
  if (job.state === 'failed') return 'failed'
  if (job.routing_status_code === 'PAID_ACCOUNT_CONCURRENCY_QUEUED') {
    return 'waiting_account_capacity'
  }
  if (job.state === 'accepted' || job.state === 'reserved') return 'accepted'
  if (job.state === 'validating' || job.state === 'reconciling') return 'completing'
  return 'running'
}

async function reportQueueState(
  request: GenStudioOperationContext,
  job: GenStudioJob,
): Promise<void> {
  await request.onQueueState?.(queueStateForJob(job), job.id)
}

const GENSTUDIO_CANCELLATION_PATHS: Record<JobRemoteOperation, (jobId: string) => string> = {
  'voice.tts': jobId => `/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
  'image.generation': jobId => `/v1/images/${encodeURIComponent(jobId)}/cancel`,
  'audio.transcription': jobId => `/v1/transcriptions/${encodeURIComponent(jobId)}/cancel`,
  'video.generation': jobId => `/v1/videos/${encodeURIComponent(jobId)}/cancel`,
}

const GENSTUDIO_STATUS_PATHS: Record<JobRemoteOperation, (jobId: string) => string> = {
  'voice.tts': jobId => `/v1/jobs/${encodeURIComponent(jobId)}`,
  'image.generation': jobId => `/v1/images/${encodeURIComponent(jobId)}`,
  'audio.transcription': jobId => `/v1/transcriptions/${encodeURIComponent(jobId)}`,
  'video.generation': jobId => `/v1/videos/${encodeURIComponent(jobId)}`,
}

/**
 * Read the published state of one already-accepted provider task.  This is a
 * control-plane lookup only: it can never create provider work.
 */
export async function getGenStudioCancellationStatus(
  operation: JobRemoteOperation,
  baseUrl: string,
  apiKey: string,
  providerJobId: string,
  request: GenStudioOperationContext = {},
  deadline: number,
): Promise<GenStudioJob & GenStudioCancellationFields> {
  const response = await requestJsonWithRetry(
    `${apiBase(baseUrl)}${GENSTUDIO_STATUS_PATHS[operation](providerJobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
    apiKey,
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [],
    true,
    1,
  )
  const parsed = parseGenStudioCancellationResponse(response)
  if (parsed.id !== providerJobId) {
    throw new Error('GenStudio KH status response did not match the requested provider job')
  }
  return parsed
}

/**
 * Ask GenStudio to cancel one accepted task and return its response untouched.
 * This intentionally has no catch or fallback: a timeout is unknown, not a
 * reason to resend a control POST and accidentally contradict provider truth.
 */
export async function requestGenStudioCancellation(
  operation: JobRemoteOperation,
  baseUrl: string,
  apiKey: string,
  providerJobId: string,
  request: GenStudioOperationContext = {},
  deadline: number,
): Promise<GenStudioJob & GenStudioCancellationFields> {
  const response = await requestJsonWithRetry(
    `${apiBase(baseUrl)}${GENSTUDIO_CANCELLATION_PATHS[operation](providerJobId)}`,
    { method: 'POST', headers: authorization(apiKey) },
    request,
    deadline,
    undefined,
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [409],
    true,
    1,
  )
  const parsed = parseGenStudioCancellationResponse(response)
  if (parsed.id !== providerJobId) {
    throw new Error('GenStudio KH cancellation response did not match the requested provider job')
  }
  return parsed
}

function cancellationRecordStatus(result: GenStudioCancellationFields): 'confirmed' | 'requested' | 'reconciling' {
  if (result.cancelled === true) return 'confirmed'
  if (result.cancellation_requested === true) return 'requested'
  return 'reconciling'
}

/**
 * The poller already owns the API key and durable provider id. It is therefore
 * the only place that can send a queued cancellation request.  A route merely
 * records intent; it never races this worker with another provider POST.
 */
async function submitQueuedRemoteCancellation(
  operation: JobRemoteOperation,
  baseUrl: string,
  apiKey: string,
  providerJobId: string,
  deadline: number,
): Promise<void> {
  const queue = await import('../services/job-queue.js')
  const storyJobId = queue.currentJobId()
  if (!storyJobId) return
  let claimed = false
  try {
    claimed = await queue.claimRemoteCancellation(storyJobId, operation, providerJobId)
  } catch {
    // The durable ownership marker did not land, so no provider POST is safe.
    return
  }
  if (!claimed) return

  try {
    const result = await requestGenStudioCancellation(operation, baseUrl, apiKey, providerJobId, {}, deadline)
    await queue.recordRemoteCancellation(storyJobId, operation, providerJobId, {
      status: cancellationRecordStatus(result),
      state: result.state,
      ...(result.cancellable !== undefined ? { cancellable: result.cancellable } : {}),
      ...(result.cancelled !== undefined ? { cancelled: result.cancelled } : {}),
      ...(result.cancellation_requested !== undefined ? { cancellation_requested: result.cancellation_requested } : {}),
      ...(result.cancellation_note !== undefined ? { cancellation_note: result.cancellation_note } : {}),
      ...(result.failure_code !== undefined ? { failure_code: result.failure_code } : {}),
      ...(Number.isFinite(result.released_credits) ? { released_credits: result.released_credits } : {}),
    })
  } catch (error) {
    const status = error instanceof GenStudioApiError ? error.status : undefined
    // A pre-execution 409 is authoritative only about this cancellation
    // attempt, never about the task's final settlement. Keep polling it.
    await queue.recordRemoteCancellation(storyJobId, operation, providerJobId, {
      status: status === 409 ? 'rejected' : 'unknown',
      ...(status !== undefined ? { http_status: status } : {}),
      ...(error instanceof GenStudioApiError && error.code ? { failure_code: error.code } : {}),
    })
  }
}

/**
 * Capture the redacted preview of a request BEFORE it is submitted.
 *
 * Recording it up front is the whole point: a submission that is rejected
 * never receives a GenStudio job id, and that rejected request is exactly the
 * one the user opens the Jobs page to read. The preview therefore lands under
 * a `pending:<idempotency-key>` evidence id which the post-submit evidence
 * write adopts once the real id exists.
 *
 * `buildGenStudioRequestPreview` is the only builder, and it has no parameter
 * that can carry a header map or an api key — the Authorization header is
 * never in scope here.
 */
async function recordGenStudioRequestPreview(
  operation: GenStudioOperation,
  input: GenStudioRequestPreviewInput,
): Promise<GenStudioRequestPreview> {
  const preview = buildGenStudioRequestPreview(input)
  try {
    const queue = await import('../services/job-queue.js')
    const storyJobId = queue.currentJobId()
    if (storyJobId && preview.idempotency_key) {
      await queue.recordGenStudioJob(storyJobId, {
        id: pendingGenStudioEntryId(preview.idempotency_key),
        operation,
        state: 'submitting',
        model_id: preview.model_id,
        queue_state: 'submitting',
        updated_at: preview.captured_at,
        request: preview,
      })
    }
  } catch {
    // Diagnostics must never be able to fail a paid generation.
  }
  return preview
}

async function recordGenStudioEvidence(
  operation: GenStudioOperation,
  job: GenStudioJob,
  request?: GenStudioRequestPreview,
): Promise<void> {
  const queue = await import('../services/job-queue.js')
  const storyJobId = queue.currentJobId()
  if (!storyJobId || !job?.id) return
  await queue.recordGenStudioJob(storyJobId, {
    id: job.id,
    ...(request ? { request } : {}),
    operation,
    state: job.state,
    model_id: job.model_id || job.model_revision_id,
    credit_cost: Number.isFinite(job.credit_cost) ? job.credit_cost : undefined,
    remaining_credits: Number.isFinite(job.remaining_credits) ? job.remaining_credits : undefined,
    // Settlement is forwarded ONLY when GenStudio published it. An absent field
    // stays absent so the UI can say "not settled yet" instead of inventing a
    // hold out of credit_cost.
    //
    // This forwards every settlement field exactly when GenStudio published it;
    // it never derives one from a price or another field.
    ...(Number.isFinite(job.reserved_credits) ? { reserved_credits: job.reserved_credits as number } : {}),
    ...(Number.isFinite(job.settled_credits) ? { settled_credits: job.settled_credits as number } : {}),
    ...(Number.isFinite(job.released_credits) ? { returned_credits: job.released_credits as number } : {}),
    ...(Number.isFinite(job.released_credits) ? { released_credits: job.released_credits as number } : {}),
    price_version: job.price_version,
    failure_code: job.failure_code,
    ...(job.cancellable !== undefined ? { cancellable: job.cancellable } : {}),
    ...(job.cancelled !== undefined ? { cancelled: job.cancelled } : {}),
    ...(job.cancellation_requested !== undefined ? { cancellation_requested: job.cancellation_requested } : {}),
    ...(job.cancellation_note !== undefined ? { cancellation_note: job.cancellation_note } : {}),
    routing_status_code: job.routing_status_code,
    location: job.location || undefined,
    queue_state: queueStateForJob(job),
    updated_at: new Date().toISOString(),
  })
  if (operation in GENSTUDIO_CANCELLATION_PATHS) {
    await queue.reconcileRemoteCancellationFromProvider(storyJobId, operation as JobRemoteOperation, job.id, {
      state: job.state,
      ...(job.cancellable !== undefined ? { cancellable: job.cancellable } : {}),
      ...(job.cancelled !== undefined ? { cancelled: job.cancelled } : {}),
      ...(job.cancellation_requested !== undefined ? { cancellation_requested: job.cancellation_requested } : {}),
      ...(job.cancellation_note !== undefined ? { cancellation_note: job.cancellation_note } : {}),
      ...(job.failure_code !== undefined ? { failure_code: job.failure_code } : {}),
      ...(job.released_credits !== undefined ? { released_credits: job.released_credits } : {}),
    })
  }
}

export function catalogHasVoice(voices: GenStudioVoice[], voiceId: unknown): boolean {
  if (typeof voiceId !== 'string' || !voiceId.trim()) return false
  return voices.some(voice => voice.id === voiceId.trim() && voice.generation_enabled !== false)
}

function apiBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function requestUrl(baseUrl: string, value: string): string {
  const base = new URL(`${apiBase(baseUrl)}/`)
  const resolved = new URL(value, base)
  if (resolved.origin !== base.origin) {
    throw new Error('GenStudio KH returned an artifact URL outside its API origin')
  }
  return resolved.toString()
}

function authorization(apiKey: string): Record<string, string> {
  if (!apiKey.trim()) throw new Error('No GenStudio KH API key configured. Open Settings → This Mac → API Keys.')
  return { Authorization: `Bearer ${apiKey.trim()}` }
}

/**
 * Why "no boundary" is TWO messages, not one.
 *
 * The guards below refuse to guess a request boundary, which is right — a wrong
 * one bills a failed job. But the message they used to throw asserted, in every
 * case, that *GenStudio published nothing*. That claim is only true when a
 * successful catalogue or quote response really did omit the field. When the
 * zero arrived from somewhere else it named the wrong culprit and cost two
 * wrong diagnoses.
 *
 * A transport failure never reaches here at all: `readJson` throws
 * `GenStudioApiError` — carrying the real status and GenStudio's own `detail` —
 * before any quote or catalogue shape is built.
 *
 * There is a THIRD state, and missing it cost the third wrong diagnosis. A
 * figure can be absent because no GenStudio payload omitted it but Story Studio
 * never carried it this far — the submitting caller built its request object
 * without `maxInputCharacters`. GenStudio declares the field a required,
 * non-null `int` on both `TTSModelResponse` and `TTSQuoteResponse`, so a 200
 * from either literally cannot omit it; blaming GenStudio for an internal
 * omission sends the reader to the wrong repository and tells them to refresh a
 * catalogue that was never at fault. `origin` keeps the two apart.
 */
function describeMissingRequestBoundary(
  maxCharacters: number | null | undefined,
  consequence: string,
  origin: 'published' | 'submission' = 'published',
): string {
  if (maxCharacters == null) {
    if (origin === 'submission') {
      return 'Story Studio did not carry the selected voice model\'s maximum_input_characters into '
        + `this TTS submission. ${consequence}`
    }
    return `GenStudio KH published no maximum_input_characters for the selected voice model. ${consequence}`
  }
  // A number arrived, and it is unusable — zero, negative, or non-finite. That
  // is a value problem, not a missing publication, and saying so keeps the
  // "GenStudio published nothing" phrase for the case where it is true.
  return 'GenStudio KH published maximum_input_characters as '
    + `${Number.isFinite(maxCharacters) ? maxCharacters : String(maxCharacters)} for the selected voice model, `
    + `which is not a usable request boundary. ${consequence}`
}

/**
 * Split only at the boundary the selected model publishes
 * (`maximum_input_characters`). VoiceStudio owns every smaller model-sized
 * chunk, join, and final speed operation behind it. The caller must pass the
 * live figure — there is no default, because a wrong one bills a failed job.
 * `null`/`undefined` is accepted and refused loudly: the caller must be able to
 * hand over "absent" without first flattening it to a number.
 */
export function splitGenStudioApiRequests(text: string, maxCharacters: number | null | undefined): string[] {
  if (maxCharacters == null || !Number.isFinite(maxCharacters) || maxCharacters <= 0) {
    throw new Error(describeMissingRequestBoundary(
      maxCharacters,
      'Story Studio cannot decide where to split this script. Refresh the voice catalogue and try again.',
    ))
  }
  const cap = Math.floor(maxCharacters)
  return chunkText(text, cap).flatMap(part => {
    if (part.length <= cap) return [part]
    const slices: string[] = []
    for (let offset = 0; offset < part.length; offset += cap) {
      slices.push(part.slice(offset, offset + cap))
    }
    return slices
  })
}

/** Build the exact customer API payload plus a stable retry identity. */
export function buildGenStudioSubmission(request: GenStudioTtsRequest): GenStudioSubmission {
  const voiceId = request.voiceId?.trim() || ''
  if (!voiceId) throw new Error('Select a GenStudio KH voice before generating audio.')
  const modelId = request.modelId?.trim() || ''
  if (!modelId) {
    throw new Error(
      'Story Studio did not carry the selected voice model into this TTS submission. '
      + 'GenStudio KH sells speech by model and requires model_id on every request, so it '
      + 'refuses the body before any provider is contacted. That is a Story Studio defect, '
      + 'not a GenStudio KH publication gap — the catalogue publishes the model id the '
      + 'generator already selected and quoted with.',
    )
  }
  if (!request.text.trim()) throw new Error('GenStudio KH text cannot be empty.')
  const maxCharacters = request.maxInputCharacters
  if (maxCharacters == null || !Number.isFinite(maxCharacters) || maxCharacters <= 0) {
    throw new Error(describeMissingRequestBoundary(
      maxCharacters,
      'That is a Story Studio defect, not a GenStudio KH publication gap — the catalogue publishes '
      + 'the field for every TTS model. Story Studio will not guess a request boundary.',
      'submission',
    ))
  }
  const characterCount = Array.from(request.text.normalize('NFC')).length
  if (characterCount > maxCharacters) {
    throw new Error(`GenStudio KH accepts at most ${Math.floor(maxCharacters).toLocaleString()} characters per request for this voice model.`)
  }
  if (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2) {
    throw new Error('GenStudio KH speed must be between 0.5 and 2.0.')
  }
  // GenStudio hashes `controls` into ITS idempotency identity
  // (`_tts_idempotency_identity`), so two runs at different control settings
  // are different work over there. Story Studio's key must move with them or
  // the two runs collide on OUR key and the first result replays for the
  // second. Emitted only when the selected model actually published controls —
  // the same conditional-spread precedent as `output_budget` (chat) and
  // `resolution` (image), so a model publishing none produces the exact JSON
  // this digest produced before the field existed and a retry that crosses
  // this upgrade replays the in-flight job instead of paying for a second one.
  const controls = hasTtsControlValues(request.controls)
    ? orderedTtsControlValues(request.controls!)
    : null
  const body = {
    // The product first, because that is what GenStudio sells and prices. It
    // also enters the digest below, which is correct: the same script in the
    // same voice at a different model is different work at a different rate,
    // and must never replay the other one's result.
    model_id: modelId,
    voice_id: voiceId,
    text: request.text,
    speed: request.speed,
    ...(controls ? { controls } : {}),
  }
  const digest = createHash('sha256').update(JSON.stringify({
    ...body,
    request_identity: request.requestIdentity?.trim() || null,
  })).digest('hex')
  return { body, idempotencyKey: `story-tts-${digest.slice(0, 48)}` }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function shouldReconnectAcceptedTask(
  error: unknown,
  request: GenStudioOperationContext,
): boolean {
  if (request.isCancelled?.() || request.signal?.aborted) return false
  // A settled provider outcome is not lost connectivity. Reconnecting to it
  // would just re-read the same terminal job forever. One typed check covers
  // image, video, TTS and transcription.
  if (isGenStudioSettledOutcomeError(error)) return false
  // GenStudio stopped because it could not tell whether the provider already
  // took the request. Reconnecting is exactly the duplicate-charge risk it
  // refused to take on our behalf.
  if (isGenStudioSubmissionUncertain(error)) return false
  // The opposite case, stated explicitly rather than left to fall through the
  // status test below: GenStudio has CONFIRMED this request is running, so
  // reattaching to it is exactly right — and is the only correct response.
  if (isGenStudioRequestInProgress(error)) return true
  if (error instanceof GenStudioApiError) return retryableStatus(error.status)
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /timeout|timed out|fetch failed|network|socket|ECONN|HTTP (408|425|429|5\d\d)|invalid JSON/i.test(message)
}

/**
 * GenStudio's published language-route failure codes that Story Studio must
 * explain rather than pass through as "the provider failed".
 *
 * WHERE THESE COME FROM: cloud-api `app/modules/chat/product_service.py` sets
 * them as the job's terminal `failure_code`. On the `/v1/chat/completions`
 * path they surface today only as a 502 whose body is `{"detail": "language
 * generation failed"}` — so the code is readable through a durable job record
 * (`/v1/account/jobs`, `/v1/chat/responses/{id}`) or through an error body
 * that carries a `code`. Both are handled; neither is assumed.
 */
export const GENSTUDIO_LANGUAGE_FAILURE_CODES = {
  PROVIDER_FAILED: 'LANGUAGE_PROVIDER_FAILED',
  SUBMISSION_UNCERTAIN: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
} as const

/**
 * GenStudio's published capacity reason codes, carried on a language HTTP 429.
 *
 * They arrive in the response BODY as `capacity_reason` (with
 * `retry_after_seconds` beside it) and are mirrored on the
 * `X-GenStudio-Capacity-Reason` and `Retry-After` headers. Body first, header
 * as fallback — a proxy can strip or rewrite a header, but the body is what
 * GenStudio itself wrote.
 *
 * The codes are PROVIDER-AGNOSTIC by design and Story Studio keeps them that
 * way: no message below names, or lets a user infer, an upstream vendor.
 *
 * Story Studio previously rendered all five as one "GenStudio KH is busy or
 * rate-limited", which is how a real incident became unreadable — the user
 * could not tell an account limit they could act on from transient load they
 * could only wait out, and could not tell either from a request that was
 * ALREADY RUNNING.
 */
export const GENSTUDIO_CAPACITY_REASONS = {
  /** The account is already at its concurrent-job limit. */
  ACCOUNT_CONCURRENCY: 'account_concurrency',
  /** The account exceeded its submissions-per-minute allowance. */
  ACCOUNT_RATE_LIMIT: 'account_rate_limit',
  /** The account's pending-job queue is full. */
  ACCOUNT_QUEUE_LIMIT: 'account_queue_limit',
  /** GenStudio itself is shedding load. Transient, not account-specific. */
  PROVIDER_BACKPRESSURE: 'provider_backpressure',
  /** GenStudio already has THIS EXACT request running. Not a failure. */
  REQUEST_IN_PROGRESS: 'request_in_progress',
} as const

export type GenStudioCapacityReason =
  typeof GENSTUDIO_CAPACITY_REASONS[keyof typeof GENSTUDIO_CAPACITY_REASONS]

/** Normalize a published code. Unknown values are PRESERVED (lower-cased) so
 *  they can be logged, but they will not match any known-code branch and so
 *  degrade to the generic message. Never throws. */
export function normalizeGenStudioCapacityReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

/**
 * Read the capacity reason from a 429: response body first, header fallback.
 *
 * Tolerates a missing body, a non-object body and a missing header set. An
 * absent code returns null, which the error constructor renders as today's
 * generic message rather than treating as an error in itself.
 */
export function readGenStudioCapacityReason(
  body: unknown,
  headers?: Headers | null,
): string | null {
  const fromBody = body && typeof body === 'object'
    ? normalizeGenStudioCapacityReason((body as Record<string, unknown>).capacity_reason)
    : null
  if (fromBody) return fromBody
  try {
    return normalizeGenStudioCapacityReason(headers?.get('x-genstudio-capacity-reason'))
  } catch {
    return null
  }
}

/**
 * A distinct, actionable message per published capacity code, or null when the
 * code is absent or one this build does not know.
 *
 * Two shapes of message, deliberately different in voice:
 *   - an ACCOUNT code is the customer's own limit, so it says so and says what
 *     they can do about it;
 *   - a PROVIDER/QUEUE code is transient and already being retried, so it says
 *     that and asks nothing of them.
 * And `request_in_progress` is neither: it is not a failure at all.
 */
export function describeGenStudioCapacityReason(code: string | null | undefined): string | null {
  switch (normalizeGenStudioCapacityReason(code)) {
    case GENSTUDIO_CAPACITY_REASONS.ACCOUNT_CONCURRENCY:
      return 'Your GenStudio KH account is already running as many jobs at once as its plan allows, so this '
        + 'one is waiting for a slot. Nothing failed and nothing was charged. It starts on its own as soon as '
        + 'one of your running jobs finishes — or run fewer steps at once, or raise your account\'s '
        + 'concurrency limit, to clear the queue faster.'
    case GENSTUDIO_CAPACITY_REASONS.ACCOUNT_RATE_LIMIT:
      return 'Your GenStudio KH account has sent more requests per minute than its plan allows, so this one '
        + 'was held back. Nothing failed and nothing was charged. Story Studio is spacing out its retries for '
        + 'you; to stop hitting the limit, run fewer steps at once or raise your account\'s per-minute rate.'
    case GENSTUDIO_CAPACITY_REASONS.ACCOUNT_QUEUE_LIMIT:
      return 'Your GenStudio KH account\'s job queue is full, so this request could not be accepted. Nothing '
        + 'was charged. Wait for queued jobs to finish, or cancel some in your GenStudio account, then Retry '
        + '— raising your account\'s queue limit also clears it.'
    case GENSTUDIO_CAPACITY_REASONS.PROVIDER_BACKPRESSURE:
      return 'GenStudio KH is under heavy load right now and asked Story Studio to wait before trying again. '
        + 'This is temporary and is not a problem with your account, your credits, or this request. Story '
        + 'Studio is retrying automatically at the pace GenStudio asked for.'
    case GENSTUDIO_CAPACITY_REASONS.REQUEST_IN_PROGRESS:
      return 'GenStudio KH is already running this exact request. Story Studio did NOT send it again — a '
        + 'second submission would abandon the run already in progress and could be charged twice. The work '
        + 'is still going: leave this step alone and it will be picked up when it finishes. If Story Studio '
        + 'was restarted, use Retry to RECONNECT to the running job rather than starting the step over.'
    default:
      return null
  }
}

/**
 * True when GenStudio says it already has this exact request running.
 *
 * This is the one capacity code that must never be treated as a failure and
 * must never lead to another submission. Re-POSTing here is precisely what
 * abandons work already in flight.
 */
export function isGenStudioRequestInProgress(error: unknown): boolean {
  return error instanceof GenStudioApiError
    && error.capacityReason === GENSTUDIO_CAPACITY_REASONS.REQUEST_IN_PROGRESS
}

/**
 * A user-facing explanation for a known language failure code, or null.
 *
 * The `SUBMISSION_UNCERTAIN` wording is deliberate: GenStudio could not tell
 * whether the upstream provider had already accepted the request, so it
 * stopped instead of risking a second paid submission. Story Studio must make
 * the same choice — hence "no automatic retry", stated plainly so the message
 * and the behaviour cannot drift apart.
 */
export function describeGenStudioLanguageFailure(code: string | null | undefined): string | null {
  if (typeof code !== 'string' || !code.trim()) return null
  const normalized = code.trim().toUpperCase()
  if (normalized === GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN) {
    return 'GenStudio KH could not confirm whether the language provider had already accepted this '
      + 'request, so it stopped rather than risk sending it — and being charged for it — twice. '
      + 'Story Studio did NOT retry it automatically for the same reason. Check the run in your '
      + 'GenStudio account before resubmitting; if nothing was charged, run this step again.'
  }
  if (normalized === GENSTUDIO_LANGUAGE_FAILURE_CODES.PROVIDER_FAILED) {
    return 'The language provider behind this GenStudio KH product failed on every route GenStudio '
      + 'tried. No fallback route was attempted, and the reservation was '
      + 'released. Retry this step, or pick a different language product in Settings.'
  }
  return null
}

/**
 * True when this error carries GenStudio's "we do not know if the provider
 * already took it" code. Such a request must never be resubmitted by machine.
 *
 * Two shapes carry the code, and both must answer the same way:
 *   - an error BODY on the synchronous route (`GenStudioApiError.code`);
 *   - a settled durable job's `failure_code` on `/v1/chat/responses`, which is
 *     the only place the distinction is reliably published.
 */
export function isGenStudioSubmissionUncertain(error: unknown): boolean {
  if (error instanceof GenStudioTerminalFailureError) {
    return error.failureCode === GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN
  }
  if (!(error instanceof GenStudioApiError)) return false
  return error.languageFailureCode === GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN
}

/**
 * The settled-job failure code that means NO upstream route ever accepted this
 * request.
 *
 * GenStudio tries each ranked route for the product in turn. A route that
 * answers a documented non-success status on SUBMIT proves it took nothing, so
 * GenStudio moves to the next one; when the list runs out with nothing
 * accepted, the job settles `failed` with this code and its whole reservation
 * is released.
 *
 * That is what makes it the one failure Story Studio may retry by machine.
 * Every other terminal code describes work a provider had already taken on —
 * retrying those spends again for the same asset. Here nothing was taken and
 * nothing was charged, so the only cost of trying again is time.
 */
export const GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE = 'CLOUD_PROVIDER_EXHAUSTED'

/**
 * True when GenStudio settled this job because every route declined to take it.
 *
 * Deliberately an exact allow-list of one code rather than a deny-list. A code
 * this build has never seen is treated as "a provider may have done work",
 * which is the safe way to be wrong: a new code that should retry costs one
 * manual Retry, a new code that should NOT retry would cost money.
 *
 * A customer cancellation is excluded even though it settles the same way —
 * the user asked for it to stop.
 */
export function isGenStudioRouteExhausted(error: unknown): error is GenStudioTerminalFailureError {
  return error instanceof GenStudioTerminalFailureError
    && !error.cancelled
    && error.failureCode === GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE
}

/**
 * Render GenStudio's error `detail` as one sentence, whatever shape it took.
 *
 * FastAPI answers a body it will not accept with `detail` as an ARRAY of
 * field-level errors — `{"loc":["body","model_id"],"msg":"Field required"}` —
 * not a string. Every reader here tested `typeof detail === 'string'` and fell
 * through to a bare `HTTP 422`, so the one line that named the offending field
 * was thrown away at the door. EP0067 cost three wrong diagnoses to a message
 * GenStudio had already sent in full.
 *
 * String details pass through untouched. Anything unreadable still degrades to
 * `HTTP <status>`, so this can only ever add information.
 */
export function describeGenStudioDetail(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null | undefined)?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const fields = detail
      .map(entry => {
        const item = entry as { loc?: unknown; msg?: unknown } | null
        const msg = typeof item?.msg === 'string' ? item.msg.trim() : ''
        // Drop the leading section ("body", "query", "path"): every caller here
        // sends a body, and "body -> model_id" reads worse than "model_id".
        const loc = Array.isArray(item?.loc)
          ? item.loc
            .filter((part, index) => !(index === 0 && (part === 'body' || part === 'query' || part === 'path')))
            .map(part => String(part))
            .join('.')
          : ''
        if (loc && msg) return `${loc}: ${msg}`
        return msg || loc
      })
      .filter(Boolean)
    if (fields.length) return fields.join('; ')
  }
  return `HTTP ${status}`
}

/** Recover a published failure code from an error body's `code`, or from a
 *  detail string that quotes it. Returns null when neither says so — an
 *  unlabelled 502 is NOT assumed to be either code. */
function readLanguageFailureCode(detail: string, code?: string): string | null {
  const fromCode = typeof code === 'string' ? code.trim().toUpperCase() : ''
  const known = Object.values(GENSTUDIO_LANGUAGE_FAILURE_CODES) as string[]
  if (known.includes(fromCode)) return fromCode
  const quoted = /\bLANGUAGE_PROVIDER_(?:SUBMISSION_UNCERTAIN|FAILED)\b/i.exec(detail || '')
  return quoted ? quoted[0].toUpperCase() : null
}

/** GenStudio's capacity signal for one response, as read off body + headers. */
export interface GenStudioCapacitySignal {
  /** Published `capacity_reason`, already normalized. Null when absent. */
  reason?: string | null
  /** Published `retry_after_seconds`, or the parsed `Retry-After`. */
  retryAfterSeconds?: number | null
}

export class GenStudioApiError extends Error {
  /** A published `LANGUAGE_PROVIDER_*` code, when the response identified one. */
  readonly languageFailureCode: string | null
  /** A published capacity code, when the response carried one. Preserved even
   *  when this build does not recognise it, so it can still be logged. */
  readonly capacityReason: string | null
  /** GenStudio's own "ask again in N seconds", when it sent one. */
  readonly retryAfterSeconds: number | null

  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly code?: string,
    capacity?: GenStudioCapacitySignal,
  ) {
    const languageFailureCode = readLanguageFailureCode(detail, code)
    const languageFailureMessage = describeGenStudioLanguageFailure(languageFailureCode)
    const capacityReason = normalizeGenStudioCapacityReason(capacity?.reason)
    // A recognised capacity code replaces the generic status wording. An
    // unrecognised or absent one falls straight through to it — degrading, not
    // throwing, is the required behaviour for a code this build has not met.
    const capacityMessage = describeGenStudioCapacityReason(capacityReason)
    const message = languageFailureMessage
      ? languageFailureMessage
      : capacityMessage
      ? capacityMessage
      : status === 401
      ? `GenStudio KH did not accept this API key: ${detail}. Save a valid account key in Settings → This Mac.`
      : status === 402
        ? `GenStudio KH has insufficient credits for this request: ${detail}. Add credits, then Retry.`
        : status === 403
          ? `This GenStudio KH key or account is not allowed to use the selected product: ${detail}. Check its scopes and product access.`
          : status === 422
            ? `GenStudio KH rejected the product request before generation: ${detail}. Review the selected model and its output contract.`
            : status === 429
              ? `GenStudio KH is busy or rate-limited: ${detail}. Story Studio will honor its Retry-After guidance.`
              : status === 502
                ? `The provider behind this GenStudio KH product failed: ${detail}. No fallback route was attempted.`
                : isGenStudioReleaseGenerationUnavailable(status, detail)
                  ? 'GenStudio generation is disabled for the deployed release. Story Studio stopped all remaining ' +
                    'new submissions; accepted jobs and completed checkpoints are preserved. Enable exact-release ' +
                    'charging in GenStudio, then Retry to repair only unfinished work.'
                  : `GenStudio KH request failed: ${detail}`
    super(message)
    this.name = 'GenStudioApiError'
    this.languageFailureCode = languageFailureCode
    this.capacityReason = capacityReason
    this.retryAfterSeconds = Number.isFinite(capacity?.retryAfterSeconds)
      && (capacity!.retryAfterSeconds as number) >= 0
      ? capacity!.retryAfterSeconds as number
      : null
  }
}

export function isGenStudioReleaseGenerationUnavailable(
  status: number,
  detail: string,
): boolean {
  return status === 503
    && /generation is unavailable until charging is enabled for this exact release/i.test(detail)
}

export function operationSignal(
  signal: AbortSignal | undefined,
  deadline: number,
  operationTimeoutMs: number,
): AbortSignal {
  const remaining = Math.max(1, Math.min(operationTimeoutMs, deadline - Date.now()))
  const timeoutSignal = AbortSignal.timeout(remaining)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

export function parseGenStudioRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return null
  return Math.max(0, retryAt - now)
}

/**
 * A GenStudio-supplied "ask me again in N" hint on a job payload, in ms.
 *
 * GenStudio does not publish a poll hint today (see
 * docs/genstudio-handoff/job-poll-hint-request.md — the ask is open). This
 * reads the shapes that ask proposes, plus the `Retry-After` header, which
 * `requestJsonWithRetry` folds onto the body as `retry_after` the same way it
 * already folds `location` and `http_status`. The moment GenStudio ships any
 * of them, Story Studio honours it with no further code change.
 *
 * Returns null for anything absent, malformed or negative — a bad hint must
 * never be able to turn into a busy-loop.
 */
export function readGenStudioPollHintMs(payload: unknown, now = Date.now()): number | null {
  if (!payload || typeof payload !== 'object') return null
  const row = payload as Record<string, unknown>
  const ms = row.poll_after_ms ?? row.retry_after_ms
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) return Math.ceil(ms)
  // `retry_after_seconds` is GenStudio's published capacity hint. It rides the
  // SAME reader as every other server hint on purpose — one mechanism decides
  // "how long before we ask again", so a hint can never be honoured in the
  // poll loop and ignored in the retry loop.
  const seconds = row.retry_after_seconds ?? row.poll_after_seconds ?? row.poll_after
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000)
  }
  const header = row.retry_after ?? row.poll_after
  if (typeof header === 'string') return parseGenStudioRetryAfterMs(header, now)
  return null
}

/**
 * The delay before poll number `attempt` (0-based), in ms.
 *
 * Pure and injectable so the schedule can be simulated in a test without any
 * real waiting. Three rules, in order:
 *
 *   1. A server hint WINS over the local ladder, and is jittered upward only.
 *   2. Otherwise walk the ladder, capped at GENSTUDIO_POLL_MAX_INTERVAL_MS,
 *      with symmetric ±20% jitter.
 *   3. Whatever comes out is clamped to the time left before the deadline, so
 *      backoff can never overshoot the 4-hour ceiling. A widening interval
 *      must not be able to delay the timeout that protects the pipeline.
 */
export function genStudioPollDelayMs(options: {
  attempt: number
  remainingMs: number
  hintMs?: number | null
  random?: () => number
}): number {
  const random = options.random ?? Math.random
  const hint = typeof options.hintMs === 'number' && Number.isFinite(options.hintMs) && options.hintMs >= 0
    ? options.hintMs
    : null
  let delay: number
  if (hint != null) {
    // Upward-only jitter: honouring the server means never asking sooner.
    delay = Math.ceil(hint * (1 + GENSTUDIO_POLL_JITTER_FRACTION * random()))
  } else {
    const attempt = Math.max(0, Math.floor(options.attempt))
    const base = attempt < POLL_LADDER_MS.length
      ? POLL_LADDER_MS[attempt]!
      : GENSTUDIO_POLL_MAX_INTERVAL_MS
    const spread = 1 + GENSTUDIO_POLL_JITTER_FRACTION * (random() * 2 - 1)
    delay = Math.round(base * spread)
  }
  const remaining = Number.isFinite(options.remainingMs) ? options.remainingMs : 0
  return Math.max(0, Math.min(delay, Math.max(0, remaining)))
}

/**
 * One job's poll cadence, with an interruptible wait.
 *
 * Create one per wait loop and call `wait()` where the old flat
 * `setTimeout(POLL_INTERVAL_MS)` used to be. The wait wakes every 250 ms to
 * re-check cancellation, so widening to 15-second intervals does not make the
 * Cancel button feel dead — it returns early and lets the loop's own
 * cancellation branch do the cancelling, exactly as before.
 */
export function createGenStudioJobPoller(random: () => number = Math.random): {
  attempts: () => number
  wait: (deadline: number, ctx: GenStudioOperationContext, job?: unknown) => Promise<void>
} {
  let attempt = 0
  return {
    attempts: () => attempt,
    async wait(deadline, ctx, job) {
      const delay = genStudioPollDelayMs({
        attempt,
        remainingMs: deadline - Date.now(),
        hintMs: readGenStudioPollHintMs(job),
        random,
      })
      attempt++
      const wakeAt = Date.now() + delay
      for (;;) {
        const left = wakeAt - Date.now()
        if (left <= 0) return
        if (ctx.isCancelled?.() || ctx.signal?.aborted) return
        await new Promise(resolve => setTimeout(resolve, Math.min(POLL_CANCEL_CHECK_MS, left)))
      }
    },
  }
}

async function retryDelay(
  attempt: number,
  request: GenStudioOperationContext,
  deadline: number,
  retryAfterMs?: number | null,
): Promise<void> {
  if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
  if (Date.now() >= deadline) throw new Error('GenStudio KH job timed out while waiting for completion')
  const fallbackMs = Math.min(4_000, 500 * (2 ** (attempt - 1)))
  const requestedMs = retryAfterMs == null ? fallbackMs : Math.max(0, retryAfterMs)
  const delayMs = Math.min(requestedMs, Math.max(0, deadline - Date.now()))
  await new Promise(resolve => setTimeout(resolve, delayMs))
}

async function requestJsonWithRetry(
  url: string,
  init: RequestInit,
  request: GenStudioOperationContext,
  deadline: number,
  apiKey?: string,
  /** Per-ATTEMPT socket ceiling. Defaults to the control-plane timeout, which is
   *  right for every short request (job GETs, cancels, catalogue reads) and
   *  wrong for a POST that executes a model inline — see
   *  GENSTUDIO_LANGUAGE_SUBMIT_TIMEOUT_MS. */
  operationTimeoutMs: number = GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
  /** Statuses that a durable caller must reconcile read-only, not re-POST. */
  noRetryStatuses: readonly number[] = [],
  /** A read-only recovery lookup must classify its first HTTP response exactly. */
  noRetryApiErrors = false,
  /** Control requests whose outcome is ambiguous must never be resent. */
  maxAttempts = NETWORK_RETRY_ATTEMPTS,
): Promise<any> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryAfterMs: number | null = null
    if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
    try {
      const response = await fetch(url, {
        ...init,
        signal: operationSignal(request.signal, deadline, operationTimeoutMs),
      })
      const raw = await response.text()
      let body: any = {}
      if (raw) {
        try { body = JSON.parse(raw) }
        catch { throw new Error(`GenStudio KH returned invalid JSON (HTTP ${response.status})`) }
      }
      if (!response.ok) {
        const detail = describeGenStudioDetail(body, response.status)
        const bodyCode = typeof body?.code === 'string' ? body.code : undefined
        // Body first, header as fallback, for BOTH the reason and the delay.
        const capacityReason = readGenStudioCapacityReason(body, response.headers)
        const capacityHintMs = readGenStudioPollHintMs(body)
          ?? parseGenStudioRetryAfterMs(response.headers.get('retry-after'))
        const error = new GenStudioApiError(response.status, detail, bodyCode, {
          reason: capacityReason,
          retryAfterSeconds: capacityHintMs == null ? null : capacityHintMs / 1_000,
        })
        // A submission GenStudio could not confirm must not be resubmitted by
        // machine, whatever its HTTP status says about retryability. This is
        // checked BEFORE the status test so a 502/503 cannot slip past it.
        if (isGenStudioSubmissionUncertain(error)) {
          await request.onQueueState?.('failed')
          throw error
        }
        // GenStudio already has this exact request running. Re-POSTing it is
        // the one thing that must not happen — the retry loop below IS the
        // resubmission path, so leave it before reaching it. The queue state
        // is a WAITING state, never 'failed': this request has not failed, and
        // rendering it as a failure is what abandoned in-flight work.
        if (isGenStudioRequestInProgress(error)) {
          if (apiKey) genStudioAdmission.noteSubmissionReachable()
          await request.onQueueState?.('waiting_account_capacity')
          throw error
        }
        if (isGenStudioReleaseGenerationUnavailable(response.status, detail)) {
          const retryAfterMs = parseGenStudioRetryAfterMs(response.headers.get('retry-after'))
          genStudioAdmission.noteGlobalFailure(error, retryAfterMs ?? undefined)
          await request.onQueueState?.('failed')
          throw error
        }
        if (apiKey) genStudioAdmission.noteSubmissionReachable()
        if (response.status === 402) {
          await request.onQueueState?.('waiting_credits')
          throw error
        }
        if (noRetryApiErrors || !retryableStatus(response.status)) {
          await request.onQueueState?.('failed')
          throw error
        }
        if (noRetryStatuses.includes(response.status)) {
          await request.onQueueState?.('failed')
          throw error
        }
        lastError = error
        // GenStudio's own hint wins over the local schedule.
        retryAfterMs = capacityHintMs
        if (response.status === 429 && apiKey) {
          const retryBaseMs = retryAfterMs ?? 1_000
          await genStudioAdmission.noteRateLimit(apiKey, retryBaseMs)
          const jitterMs = Math.floor(
            Math.random() * Math.min(750, Math.max(100, retryBaseMs * 0.1)),
          )
          retryAfterMs = retryBaseMs + jitterMs
        }
      } else {
        if (apiKey) genStudioAdmission.noteSubmissionReachable()
        if (body && typeof body === 'object') {
          body.location ||= response.headers.get('location')
          body.http_status ||= response.status
          // Poll-cadence hint, if GenStudio ever sends one on a job GET. Folded
          // onto the body so the wait loops can prefer it over their local
          // backoff without every call site handling raw headers.
          body.retry_after ||= response.headers.get('retry-after')
        }
        return body
      }
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      lastError = error
      if (isGenStudioSubmissionUncertain(error)) throw error
      // Re-checked here as well as above: 429 is a retryable status, so
      // without this an in-progress request would fall through to the retry
      // loop and be POSTed again — the exact resubmission this code exists to
      // prevent.
      if (isGenStudioRequestInProgress(error)) throw error
      if (
        error instanceof GenStudioApiError
        && (
          noRetryStatuses.includes(error.status)
          || noRetryApiErrors
          || isGenStudioReleaseGenerationUnavailable(error.status, error.detail)
          || !retryableStatus(error.status)
        )
      ) {
        throw error
      }
    }
    if (attempt < maxAttempts) {
      await retryDelay(attempt, request, deadline, retryAfterMs)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('GenStudio KH request failed after reconnect attempts')
}

async function submitJsonWithAdmission(
  apiKey: string,
  url: string,
  init: RequestInit,
  request: GenStudioOperationContext,
  deadline: number,
  operationTimeoutMs: number = GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
  noRetryStatuses: readonly number[] = [],
): Promise<any> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => requestJsonWithRetry(url, init, request, deadline, apiKey, operationTimeoutMs, noRetryStatuses),
  )
}

/**
 * Submit one language request, and REATTACH to it rather than lose it.
 *
 * Two things make a language submission different from every other POST here:
 * it runs the model on the request thread, and its answer is the only copy of
 * work the account has already paid for. So a lost socket is not a failed
 * request — it is a finished request nobody can collect.
 *
 * `request_in_progress` is GenStudio saying "I have this exact request, it is
 * still running". Re-POSTing the SAME Idempotency-Key cannot start a second
 * job: GenStudio resolves the key against the existing job record and either
 * refuses again (still running) or, once the job reaches SUCCEEDED, RETURNS
 * THAT JOB'S STORED OUTPUT. During this live `request_in_progress` case the
 * replay is the reattachment path because the 429 carries no job id. For a
 * persisted lost response, GenStudio 0.93.1's read-only GET-by-idempotency-key
 * endpoint is used before Story Studio can consider any new work.
 *
 * Bounded by the caller's deadline, paced by GenStudio's own `Retry-After` when
 * it sends one, and cancellable throughout.
 */
async function submitLanguageJson(
  apiKey: string,
  url: string,
  init: RequestInit,
  request: GenStudioOperationContext,
  deadline: number,
): Promise<any> {
  const poller = createGenStudioJobPoller()
  for (;;) {
    try {
      return await submitJsonWithAdmission(
        apiKey, url, init, request, deadline, GENSTUDIO_LANGUAGE_SUBMIT_TIMEOUT_MS, [502, 504],
      )
    } catch (error) {
      if (!isGenStudioRequestInProgress(error)) throw error
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      if (Date.now() >= deadline) throw error
      const retryAfterSeconds = error instanceof GenStudioApiError ? error.retryAfterSeconds : null
      await poller.wait(
        deadline,
        request,
        retryAfterSeconds == null ? undefined : { retry_after_seconds: retryAfterSeconds },
      )
    }
  }
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = describeGenStudioDetail(body, response.status)
    const code = typeof body?.code === 'string' ? body.code : undefined
    const hintMs = readGenStudioPollHintMs(body)
      ?? parseGenStudioRetryAfterMs(response.headers.get('retry-after'))
    throw new GenStudioApiError(response.status, detail, code, {
      reason: readGenStudioCapacityReason(body, response.headers),
      retryAfterSeconds: hintMs == null ? null : hintMs / 1_000,
    })
  }
  return body
}

interface CatalogCacheEntry<T> {
  value: T
  loadedAt: number
  freshUntil: number
  staleUntil: number
}

/** One cache policy for every GenStudio catalogue Story Studio reads. */
export type GenStudioCatalogKind =
  | 'capabilities'
  | 'voices'
  | 'tts-models'
  | 'chat'
  | 'image'
  | 'music'
  | 'video'
  | 'transcription'

/**
 * `live`  — fetched during this call.
 * `fresh` — served from cache inside the 5-minute freshness window.
 * `stale` — served from cache only because a refresh failed; still inside the
 *           30-minute staleness window, and the UI must say so.
 */
export type GenStudioCatalogFreshness = 'live' | 'fresh' | 'stale'

export interface GenStudioCatalogSnapshot<T> {
  kind: GenStudioCatalogKind
  value: T
  freshness: GenStudioCatalogFreshness
  /** True while the value is only usable because a refresh failed. */
  stale: boolean
  /** When the cached copy was actually loaded from GenStudio. */
  loadedAt: string
  ageMs: number
}

const CATALOG_LABEL: Record<GenStudioCatalogKind, string> = {
  capabilities: 'capability',
  voices: 'voice',
  'tts-models': 'voice model',
  chat: 'language product',
  image: 'image model',
  music: 'music model',
  video: 'video model',
  transcription: 'transcription model',
}

/**
 * The catalogue could not be refreshed AND no copy remains inside the staleness
 * window. Typed so a submission path refuses loudly instead of spending against
 * a product nobody can currently verify exists, is available, or is priced the
 * way Story Studio last saw it.
 */
export class GenStudioCatalogUnavailableError extends Error {
  readonly kind: GenStudioCatalogKind
  /** Age of the last cached copy, when there was one at all. */
  readonly ageMs: number | null

  constructor(kind: GenStudioCatalogKind, ageMs: number | null, cause?: unknown) {
    super(
      `The GenStudio KH ${CATALOG_LABEL[kind]} catalogue could not be refreshed`
      + `${ageMs == null
        ? ' and Story Studio has no cached copy'
        : ` and the cached copy is ${Math.round(ageMs / 60_000)} minute(s) old, beyond the `
          + `${Math.round(CATALOG_STALE_MS / 60_000)}-minute staleness limit`}. `
      + 'Story Studio refused to submit work against an unverified product; nothing was requested '
      + 'and no credits were charged. Check your connection, then Retry.',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'GenStudioCatalogUnavailableError'
    this.kind = kind
    this.ageMs = ageMs
  }
}

const catalogCache = new Map<string, CatalogCacheEntry<unknown>>()
const catalogRefreshes = new Map<string, Promise<unknown>>()

function catalogCacheKey(kind: GenStudioCatalogKind, baseUrl: string, apiKey: string): string {
  return `${kind}:${createHash('sha256').update(`${baseUrl}\0${apiKey}`).digest('hex')}`
}

/**
 * Forget every cached catalogue. Use when the account key changes — a snapshot
 * loaded under a different key must never authorise a submission.
 */
export function clearGenStudioCatalogCache(): void {
  catalogCache.clear()
}

/**
 * Force the next read of every catalogue to revalidate, while keeping the
 * cached copy usable as a stale fallback during a short service interruption.
 */
export function invalidateGenStudioCatalogFreshness(): void {
  for (const entry of catalogCache.values()) entry.freshUntil = 0
}

async function fetchCatalogJson(url: string, apiKey: string): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 1; attempt <= CATALOG_RETRY_ATTEMPTS; attempt++) {
    try {
      return await readJson(await fetch(url, {
        headers: authorization(apiKey),
        signal: AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS),
      }))
    } catch (error) {
      lastError = error
      if (error instanceof GenStudioApiError && !retryableStatus(error.status)) throw error
    }
    if (attempt < CATALOG_RETRY_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 300 * (2 ** (attempt - 1))))
    }
  }
  throw new Error(
    'GenStudio KH model catalog could not be reached after automatic reconnect attempts.',
    { cause: lastError },
  )
}

function catalogSnapshot<T>(
  kind: GenStudioCatalogKind,
  entry: CatalogCacheEntry<T>,
  freshness: GenStudioCatalogFreshness,
  now: number,
): GenStudioCatalogSnapshot<T> {
  return {
    kind,
    value: entry.value,
    freshness,
    stale: freshness === 'stale',
    loadedAt: new Date(entry.loadedAt).toISOString(),
    ageMs: Math.max(0, now - entry.loadedAt),
  }
}

/**
 * Catalog reads are free and idempotent. Share one refresh across concurrent
 * jobs, keep a successful snapshot warm for normal generation, and use that
 * snapshot during a short service interruption. Authentication and scope
 * failures never fall back to stale account data, and a copy older than the
 * staleness window is refused outright rather than used to authorise spend.
 *
 * Every modality goes through this one function: capabilities, voices, chat,
 * image, video and transcription.
 */
async function cachedCatalogSnapshot<T>(
  kind: GenStudioCatalogKind,
  key: string,
  load: () => Promise<T>,
): Promise<GenStudioCatalogSnapshot<T>> {
  const now = Date.now()
  const cached = catalogCache.get(key) as CatalogCacheEntry<T> | undefined
  if (cached && cached.freshUntil > now) return catalogSnapshot(kind, cached, 'fresh', now)

  let refresh = catalogRefreshes.get(key) as Promise<T> | undefined
  if (!refresh) {
    refresh = load().then(value => {
      const loadedAt = Date.now()
      catalogCache.set(key, {
        value,
        loadedAt,
        freshUntil: loadedAt + CATALOG_FRESH_MS,
        staleUntil: loadedAt + CATALOG_STALE_MS,
      })
      return value
    }).finally(() => {
      if (catalogRefreshes.get(key) === refresh) catalogRefreshes.delete(key)
    })
    catalogRefreshes.set(key, refresh)
  }

  try {
    await refresh
    const loaded = catalogCache.get(key) as CatalogCacheEntry<T>
    return catalogSnapshot(kind, loaded, 'live', Date.now())
  } catch (error) {
    // Never serve account data the key is not (or no longer) entitled to.
    if (error instanceof GenStudioApiError && (error.status === 401 || error.status === 403)) throw error
    const settledAt = Date.now()
    const fallback = catalogCache.get(key) as CatalogCacheEntry<T> | undefined
    if (fallback && fallback.staleUntil > settledAt) return catalogSnapshot(kind, fallback, 'stale', settledAt)
    throw new GenStudioCatalogUnavailableError(
      kind,
      fallback ? Math.max(0, settledAt - fallback.loadedAt) : null,
      error,
    )
  }
}

async function cachedCatalog<T>(
  kind: GenStudioCatalogKind,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  return (await cachedCatalogSnapshot(kind, key, load)).value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Fetch the account-visible voice catalog. `modelId` forwards GenStudio's own
 * `model_id` filter so compatibility is decided by GenStudio, not by Story
 * Studio comparing strings.
 */
export async function listVoicesSnapshot(
  apiKey: string,
  options: { modelId?: string; collection?: string; search?: string } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioVoice[]>> {
  const baseUrl = await getGenStudioUrl()
  const query = new URLSearchParams()
  if (options.modelId?.trim()) query.set('model_id', options.modelId.trim())
  if (options.collection?.trim()) query.set('collection', options.collection.trim())
  if (options.search?.trim()) query.set('search', options.search.trim())
  const suffix = query.size ? `?${query.toString()}` : ''
  return cachedCatalogSnapshot('voices', catalogCacheKey('voices', `${baseUrl}${suffix}`, apiKey), async () => {
  const payload = await fetchCatalogJson(`${apiBase(baseUrl)}/v1/voices${suffix}`, apiKey)
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid voice catalog')
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    language: optionalText(value?.language),
    description: optionalText(value?.description),
    provider: optionalText(value?.provider),
    engine_id: optionalText(value?.engine_id),
    engine_name: optionalText(value?.engine_name),
    model_revision_id: optionalText(value?.model_revision_id),
    model_family: optionalText(value?.model_family),
    voice_tier: optionalText(value?.voice_tier),
    voice_revision: optionalText(value?.voice_revision),
    custom_voice_id: nullableText(value?.custom_voice_id),
    public_voice_id: nullableText(value?.public_voice_id),
    credits_per_1000_characters: optionalCount(value?.credits_per_1000_characters),
    output_format: optionalText(value?.output_format),
    catalog_status: optionalText(value?.catalog_status),
    quote_enabled: typeof value?.quote_enabled === 'boolean' ? value.quote_enabled : undefined,
    generation_enabled: typeof value?.generation_enabled === 'boolean' ? value.generation_enabled : undefined,
    preview_available: typeof value?.preview_available === 'boolean' ? value.preview_available : undefined,
    preview_url: nullableText(value?.preview_url),
    preview_text: nullableText(value?.preview_text),
    preview_notice: nullableText(value?.preview_notice),
    is_saved: typeof value?.is_saved === 'boolean' ? value.is_saved : undefined,
    tts_model_id: nullableText(value?.tts_model_id),
    tts_model_name: nullableText(value?.tts_model_name),
  })).filter((voice: GenStudioVoice) => voice.id && voice.display_name)
  })
}

export async function listVoices(
  apiKey: string,
  options: { modelId?: string; collection?: string; search?: string } = {},
): Promise<GenStudioVoice[]> {
  return (await listVoicesSnapshot(apiKey, options)).value
}

/**
 * `GET /v1/tts/models` — the speech selection and pricing axis. Every field is
 * required by the published contract, so a row missing one is a broken row and
 * is dropped rather than repaired with an invented value.
 */
export async function listTtsModelsSnapshot(
  apiKey: string,
): Promise<GenStudioCatalogSnapshot<GenStudioTtsModel[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('tts-models', catalogCacheKey('tts-models', baseUrl, apiKey), async () => {
    const payload = await fetchCatalogJson(`${apiBase(baseUrl)}/v1/tts/models`, apiKey)
    if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid voice model catalog')
    return payload.flatMap((value: any): GenStudioTtsModel[] => {
      const id = typeof value?.id === 'string' ? value.id.trim() : ''
      const displayName = typeof value?.display_name === 'string' ? value.display_name.trim() : ''
      const rate = optionalCount(value?.credits_per_1000_characters)
      const minimum = optionalCount(value?.minimum_credits)
      const maxCharacters = optionalCount(value?.maximum_input_characters)
      if (!id || !displayName || rate === undefined || minimum === undefined || maxCharacters === undefined) return []
      return [{
        id,
        display_name: displayName,
        provider_id: typeof value?.provider_id === 'string' ? value.provider_id.trim() : '',
        provider_name: typeof value?.provider_name === 'string' ? value.provider_name.trim() : '',
        description: typeof value?.description === 'string' ? value.description.trim() : '',
        credits_per_1000_characters: rate,
        minimum_credits: minimum,
        maximum_input_characters: maxCharacters,
        supports_speed: value?.supports_speed === true,
        supports_voice_cloning: value?.supports_voice_cloning === true,
        preview_policy: typeof value?.preview_policy === 'string' ? value.preview_policy.trim() : '',
        generation_enabled: value?.generation_enabled === true,
        // This is a model-local hint, not something Story Studio may derive
        // from the provider name or id. Absent, null, and malformed values
        // stay unknown so the caller can safely serialize.
        provider_submit_concurrency: Number.isInteger(value?.provider_submit_concurrency)
          && value.provider_submit_concurrency > 0
          ? value.provider_submit_concurrency
          : null,
        // Carried through exactly as published. An absent or empty list means
        // this model takes no controls — never a reason to supply some.
        controls: parseTtsControls(value?.controls),
      }]
    })
  })
}

export async function listTtsModels(apiKey: string): Promise<GenStudioTtsModel[]> {
  return (await listTtsModelsSnapshot(apiKey)).value
}

/** Fetch the account-visible music catalog without deriving availability or provider identity. */
export async function listMusicModelsSnapshot(
  apiKey: string,
): Promise<GenStudioCatalogSnapshot<GenStudioMusicModel[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('music', catalogCacheKey('music', baseUrl, apiKey), async () => {
    const payload = await fetchCatalogJson(`${apiBase(baseUrl)}/v1/music/models`, apiKey)
    if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid music model catalog')
    return payload.flatMap((value: any): GenStudioMusicModel[] => {
      const id = typeof value?.id === 'string' ? value.id.trim() : ''
      const displayName = typeof value?.display_name === 'string' ? value.display_name.trim() : ''
      const hasDescription = typeof value?.description === 'string'
      const description = hasDescription ? value.description.trim() : ''
      const isNullableInteger = (field: unknown): field is number | null => field === null || Number.isInteger(field)
      const isNullableText = (field: unknown): field is string | null => field === null || typeof field === 'string'
      if (
        !id || !displayName || !hasDescription || typeof value?.coming_soon !== 'boolean'
        || !Number.isInteger(value?.credits_per_request) || !Number.isInteger(value?.minimum_credits)
        || typeof value?.price_version !== 'string'
        || !isNullableInteger(value?.standard_credits) || !isNullableInteger(value?.sale_credits)
        || !isNullableText(value?.sale_ends_at) || !isNullableText(value?.sale_disclaimer)
        || typeof value?.supports_instrumental !== 'boolean' || typeof value?.supports_vocals !== 'boolean'
        || typeof value?.requires_lyrics !== 'boolean'
        || !Number.isInteger(value?.max_prompt_characters)
        || !isNullableInteger(value?.max_prompt_without_lyrics_characters)
        || !Number.isInteger(value?.min_prompt_characters) || !Number.isInteger(value?.max_lyrics_characters)
        || !Number.isInteger(value?.min_lyrics_characters) || !Number.isInteger(value?.max_title_characters)
        || !isNullableInteger(value?.outputs_per_request)
      ) return []
      return [{
        id,
        display_name: displayName,
        provider_name: optionalText(value?.provider_name),
        description,
        coming_soon: value.coming_soon,
        credits_per_request: value.credits_per_request,
        minimum_credits: value.minimum_credits,
        price_version: value.price_version.trim(),
        standard_credits: value.standard_credits,
        sale_credits: value.sale_credits,
        sale_ends_at: value.sale_ends_at,
        sale_disclaimer: value.sale_disclaimer,
        supports_instrumental: value.supports_instrumental,
        supports_vocals: value.supports_vocals,
        requires_lyrics: value.requires_lyrics,
        max_prompt_characters: value.max_prompt_characters,
        max_prompt_without_lyrics_characters: value.max_prompt_without_lyrics_characters,
        min_prompt_characters: value.min_prompt_characters,
        max_lyrics_characters: value.max_lyrics_characters,
        min_lyrics_characters: value.min_lyrics_characters,
        max_title_characters: value.max_title_characters,
        outputs_per_request: value.outputs_per_request,
      }]
    })
  })
}

export async function listMusicModels(apiKey: string): Promise<GenStudioMusicModel[]> {
  return (await listMusicModelsSnapshot(apiKey)).value
}

/**
 * Toggle GenStudio's own saved flag. GenStudio owns the saved state; Story
 * Studio drops its cached voice rows afterwards so the next read comes back
 * with the authoritative `is_saved` rather than a local guess at it.
 */
export async function setGenStudioVoiceSaved(
  apiKey: string,
  voiceId: string,
  saved: boolean,
): Promise<void> {
  const id = voiceId.trim()
  if (!id) throw new Error('A GenStudio voice id is required to change its saved state.')
  const baseUrl = await getGenStudioUrl()
  const response = await fetch(`${apiBase(baseUrl)}/v1/voices/${encodeURIComponent(id)}/save`, {
    method: saved ? 'POST' : 'DELETE',
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new GenStudioApiError(response.status, `voice save returned HTTP ${response.status}`)
  }
  invalidateGenStudioCatalogFreshness()
}

function voiceLibraryPath(library: string): string {
  const match = GENSTUDIO_VOICE_LIBRARIES.find(entry => entry.id === library.trim())
  if (!match) {
    throw new Error(`GenStudio KH publishes no voice library named "${library}".`)
  }
  return match.path
}

/** Browse one provider's public voice library page. Not a Story Studio cache. */
export async function listGenStudioVoiceLibrary(
  apiKey: string,
  library: string,
  options: { search?: string; page?: number } = {},
): Promise<GenStudioLibraryPage> {
  const baseUrl = await getGenStudioUrl()
  const query = new URLSearchParams()
  if (options.search?.trim()) query.set('search', options.search.trim())
  if (Number.isFinite(options.page) && (options.page as number) > 0) query.set('page', String(Math.floor(options.page as number)))
  const suffix = query.size ? `?${query.toString()}` : ''
  const payload: any = await fetchCatalogJson(`${apiBase(baseUrl)}${voiceLibraryPath(library)}${suffix}`, apiKey)
  if (!payload || !Array.isArray(payload.voices)) {
    throw new Error('GenStudio KH returned an invalid voice library page')
  }
  return {
    page: optionalCount(payload.page) ?? 0,
    has_more: payload.has_more === true,
    voices: payload.voices.flatMap((value: any): GenStudioLibraryVoice[] => {
      const publicVoiceId = typeof value?.public_voice_id === 'string' ? value.public_voice_id.trim() : ''
      if (!publicVoiceId) return []
      return [{
        public_voice_id: publicVoiceId,
        name: typeof value?.name === 'string' ? value.name.trim() : '',
        description: typeof value?.description === 'string' ? value.description.trim() : '',
        language: typeof value?.language === 'string' ? value.language.trim() : '',
        accent: nullableText(value?.accent),
        gender: nullableText(value?.gender),
        age: nullableText(value?.age),
        use_case: nullableText(value?.use_case),
        category: nullableText(value?.category),
        preview_available: value?.preview_available === true,
        preview_url: nullableText(value?.preview_url),
        notice_period_days: optionalCount(value?.notice_period_days) ?? null,
        genstudio_voice_id: nullableText(value?.genstudio_voice_id),
        is_saved: typeof value?.is_saved === 'boolean' ? value.is_saved : undefined,
        credits_per_1000_characters: optionalCount(value?.credits_per_1000_characters),
      }]
    }),
  }
}

/** Bring a public library voice into the customer's own GenStudio library. */
export async function addGenStudioVoiceLibraryVoice(
  apiKey: string,
  library: string,
  publicVoiceId: string,
): Promise<{ voice_id: string; created: boolean; saved?: boolean; credits_per_1000_characters?: number }> {
  const id = publicVoiceId.trim()
  if (!id) throw new Error('A public voice id is required to add a library voice.')
  const baseUrl = await getGenStudioUrl()
  const response = await fetch(`${apiBase(baseUrl)}${voiceLibraryPath(library)}/add`, {
    method: 'POST',
    headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_voice_id: id }),
    signal: AbortSignal.timeout(GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS),
  })
  const payload: any = await readJson(response)
  invalidateGenStudioCatalogFreshness()
  return {
    voice_id: typeof payload?.voice_id === 'string' ? payload.voice_id : '',
    created: payload?.created === true,
    saved: typeof payload?.saved === 'boolean' ? payload.saved : undefined,
    credits_per_1000_characters: optionalCount(payload?.credits_per_1000_characters),
  }
}

/**
 * `POST /v1/tts/quotes` — GenStudio's exact credit figure for one exact script.
 * Never cached: a quote belongs to the text it was asked about.
 */
export async function requestGenStudioTtsQuote(
  apiKey: string,
  request: {
    /** `TTSModelResponse.id`. Required — GenStudio prices speech by model. */
    modelId: string
    voiceId: string
    text: string
    speed?: number
    /**
     * Already resolved against the SELECTED model's published `controls[]`
     * (lib/tts-controls.ts). Sent verbatim so the quote prices the same
     * settings generation will submit — GenStudio's own quote takes them.
     */
    controls?: TtsControlValues
  },
): Promise<GenStudioTtsQuote> {
  const voiceId = request.voiceId.trim()
  if (!voiceId) throw new Error('Select a GenStudio KH voice before asking for a quote.')
  // GenStudio requires `model_id` on the quote body too, so a conditional
  // spread here only bought the right to send a body GenStudio must reject —
  // and its rejection is a field-level 422 nobody reads as "we forgot the
  // model". Refuse locally, in our own name, instead.
  const modelId = request.modelId?.trim() || ''
  if (!modelId) {
    throw new Error(
      'Story Studio did not carry the selected voice model into this quote. GenStudio KH '
      + 'prices speech by model and requires model_id on every quote request.',
    )
  }
  if (!request.text.trim()) throw new Error('There is no text to quote.')
  const baseUrl = await getGenStudioUrl()
  const body: Record<string, unknown> = { model_id: modelId, voice_id: voiceId, text: request.text }
  if (Number.isFinite(request.speed)) body.speed = request.speed
  // Omitted entirely when the model publishes no controls, so a request for
  // such a model is byte-identical to the one sent before controls existed.
  if (hasTtsControlValues(request.controls)) body.controls = orderedTtsControlValues(request.controls!)
  const response = await fetch(`${apiBase(baseUrl)}/v1/tts/quotes`, {
    method: 'POST',
    headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS),
  })
  const payload: any = await readJson(response)
  return {
    model_id: nullableText(payload?.model_id),
    model_name: nullableText(payload?.model_name),
    controls: parseTtsControlValues(payload?.controls),
    voice_id: typeof payload?.voice_id === 'string' ? payload.voice_id : voiceId,
    voice_tier: typeof payload?.voice_tier === 'string' ? payload.voice_tier : '',
    // NOT defaulted. `readJson` above has already thrown for any non-200, so
    // reaching this line means GenStudio answered 200; a `null` here therefore
    // means "this 200 quote did not publish the field" and nothing else.
    // Callers must report that, not paper over it — `?? 0` on `credits` reads
    // as free, and `?? 0` on `maximum_input_characters` manufactures the
    // "GenStudio published no maximum_input_characters" claim locally.
    billable_characters: optionalCount(payload?.billable_characters) ?? null,
    speed: optionalCount(payload?.speed) ?? null,
    estimated_duration_ms: optionalCount(payload?.estimated_duration_ms) ?? null,
    maximum_input_characters: optionalCount(payload?.maximum_input_characters) ?? null,
    credits: optionalCount(payload?.credits) ?? null,
    credits_per_1000_characters: optionalCount(payload?.credits_per_1000_characters) ?? null,
    price_version: typeof payload?.price_version === 'string' ? payload.price_version : '',
    output_format: typeof payload?.output_format === 'string' ? payload.output_format : '',
    chargeable: payload?.chargeable === true,
    generation_enabled: payload?.generation_enabled === true,
    notice: typeof payload?.notice === 'string' ? payload.notice : '',
  }
}

/**
 * Download one already-generated GenStudio voice sample. This path never
 * submits a TTS job and therefore never consumes generation credits.
 */
export async function downloadVoicePreview(
  apiKey: string,
  previewPath: string,
): Promise<{ bytes: Buffer; mediaType: string }> {
  const baseUrl = await getGenStudioUrl()
  const isCatalogPreview = previewPath.startsWith('/v1/voices/') && previewPath.endsWith('/preview')
  const isLibraryPreview = GENSTUDIO_VOICE_LIBRARIES.some(library => previewPath.startsWith(`${library.path}/`))
    && previewPath.endsWith('/preview')
  if (!isCatalogPreview && !isLibraryPreview) {
    throw new Error('GenStudio KH returned an invalid voice preview path')
  }
  const response = await fetch(requestUrl(baseUrl, previewPath), {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new GenStudioApiError(response.status, `voice preview download returned HTTP ${response.status}`)
  }
  const mediaType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0]!.trim()
  if (!mediaType.startsWith('audio/')) {
    throw new Error('GenStudio KH voice preview did not return audio')
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mediaType,
  }
}

/** Fetch GenStudio's provider-owned capability registry without copying it into project config. */
export async function listModelCapabilitiesSnapshot(
  apiKey: string,
): Promise<GenStudioCatalogSnapshot<GenStudioModelCapability[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('capabilities', catalogCacheKey('capabilities', baseUrl, apiKey), async () => {
  const payload = await fetchCatalogJson(`${apiBase(baseUrl)}/v1/models`, apiKey)
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid capability catalog')
  const modalities = new Set(['audio', 'image', 'text', 'video'])
  const operations = new Set(['voice.tts', 'audio.transcription', 'image.generation', 'chat.response', 'video.generation'])
  const availability = new Set(['available', 'unavailable', 'unknown'])
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    revision: typeof value?.revision === 'string' ? value.revision.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    modality: value?.modality,
    operation: value?.operation,
    availability: availability.has(value?.availability) ? value.availability : 'unknown',
    qualification_only: value?.qualification_only !== false,
    pricing_unit: typeof value?.pricing_unit === 'string' ? value.pricing_unit.trim() : undefined,
    limits: value?.limits && typeof value.limits === 'object' ? value.limits : {},
    controls: value?.controls && typeof value.controls === 'object' ? value.controls : {},
  })).filter((model: GenStudioModelCapability) => (
    !!model.id && !!model.display_name && modalities.has(model.modality) && operations.has(model.operation)
  ))
  })
}

export async function listModelCapabilities(apiKey: string): Promise<GenStudioModelCapability[]> {
  return (await listModelCapabilitiesSnapshot(apiKey)).value
}

/**
 * Read a published token limit, preferring GenStudio's CURRENT field name and
 * accepting a deprecated alias only when the current one is absent.
 *
 * Story Studio never substitutes a number of its own here: a limit this app
 * invented would be a promise GenStudio has not made, and would go stale the
 * moment the catalogue changes. `0` means "not published", which every caller
 * must treat as "unknown", not as "zero budget".
 */
function readPublishedTokenLimit(preferred: unknown, deprecatedAlias: unknown): number {
  if (Number.isInteger(preferred)) return Math.max(1, preferred as number)
  if (Number.isInteger(deprecatedAlias)) return Math.max(1, deprecatedAlias as number)
  return 0
}

export async function listChatModelsSnapshot(
  apiKey: string,
): Promise<GenStudioCatalogSnapshot<GenStudioChatModel[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('chat', catalogCacheKey('chat', baseUrl, apiKey), async () => {
  const payload = await fetchCatalogJson(`${apiBase(baseUrl)}/v1/chat/models`, apiKey)
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid chat model catalog')
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    provider_name: publishedText(value?.provider_name),
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    available: value?.available === true,
    qualification_only: value?.qualification_only !== false,
    context_window_tokens: readPublishedTokenLimit(
      value?.context_window_tokens,
      value?.context_limit_tokens,
    ),
    // 0 means "not published" — the same contract `context_window_tokens`
    // above already uses, and never a Story Studio guess. This used to
    // default to 2,048, which is the invented-fallback bug in its most
    // expensive form: every consumer downstream (the pre-network ceiling
    // check, the credit reservation, the chunking maths) would treat 2,048 as
    // a figure GenStudio had published for the product, and a chapter sized
    // against it comes back truncated after the customer has paid for it.
    max_output_tokens: readPublishedTokenLimit(value?.max_output_tokens, undefined),
    controls: Array.isArray(value?.controls) ? value.controls.filter((item: unknown) => typeof item === 'string') : [],
    activation_blockers: Array.isArray(value?.activation_blockers)
      ? value.activation_blockers.filter((item: unknown) => typeof item === 'string')
      : [],
    input_credits_per_million_tokens: Number.isFinite(value?.input_credits_per_million_tokens)
      ? Math.max(0, value.input_credits_per_million_tokens)
      : 0,
    output_credits_per_million_tokens: Number.isFinite(value?.output_credits_per_million_tokens)
      ? Math.max(0, value.output_credits_per_million_tokens)
      : 0,
    minimum_credits: Number.isFinite(value?.minimum_credits)
      ? Math.max(0, value.minimum_credits)
      : 0,
    price_version: typeof value?.price_version === 'string' ? value.price_version.trim() : '',
    input_modalities: Array.isArray(value?.input_modalities)
      ? value.input_modalities.filter((item: unknown): item is 'text' | 'image' => item === 'text' || item === 'image')
      : ['text'],
    supports_vision: value?.supports_vision === true,
    max_input_images: Number.isInteger(value?.max_input_images) ? Math.max(0, value.max_input_images) : 0,
    accepted_image_mime_types: Array.isArray(value?.accepted_image_mime_types)
      ? value.accepted_image_mime_types.filter((item: unknown): item is string => typeof item === 'string' && item.startsWith('image/'))
      : [],
    max_image_bytes: Number.isInteger(value?.max_image_bytes) ? Math.max(0, value.max_image_bytes) : 0,
    max_image_dimension: Number.isInteger(value?.max_image_dimension) ? Math.max(0, value.max_image_dimension) : 0,
    supported_detail_levels: Array.isArray(value?.supported_detail_levels)
      ? value.supported_detail_levels.filter((item: unknown): item is 'low' | 'high' | 'auto' => item === 'low' || item === 'high' || item === 'auto')
      : [],
    supports_structured_output: value?.supports_structured_output === true,
    // GenStudio language products return JSON Object output unless the
    // catalogue explicitly advertises that a strict JSON schema can be
    // requested. Never assume strict-schema support from a missing field.
    structured_output_mode: (
      value?.structured_output_mode === 'request_json_schema'
        ? 'request_json_schema'
        : 'json_object'
    ) as GenStudioChatModel['structured_output_mode'],
    // Web-search capability. Every flag defaults to the SAFE value (false /
    // null) when the catalogue omits it: an older GenStudio release that has
    // never heard of web search must read as "not web-capable", never as
    // "capable and unrestricted".
    supports_web_search: value?.supports_web_search === true,
    returns_citations: value?.returns_citations === true,
    citation_format: typeof value?.citation_format === 'string' && value.citation_format.trim()
      ? value.citation_format.trim()
      : null,
    supports_domain_filters: value?.supports_domain_filters === true,
    research_qualified: value?.research_qualified === true,
    supports_claim_attribution: value?.supports_claim_attribution === true,
    web_search_credits_per_search: Number.isFinite(value?.web_search_credits_per_search)
      ? Math.max(0, value.web_search_credits_per_search)
      : null,
    web_research_credits_per_request: Number.isFinite(value?.web_research_credits_per_request)
      ? Math.max(0, value.web_research_credits_per_request)
      : null,
    // Only a positive integer is a usable cap. Null (and any junk) means
    // GenStudio cannot enforce a search count, so no depth control is offered.
    max_web_searches: Number.isInteger(value?.max_web_searches) && value.max_web_searches > 0
      ? value.max_web_searches
      : null,
  })).filter((model: GenStudioChatModel) => model.id && model.display_name)
  })
}

export async function listChatModels(apiKey: string): Promise<GenStudioChatModel[]> {
  return (await listChatModelsSnapshot(apiKey)).value
}

export async function listVideoModelsSnapshot(
  apiKey: string,
): Promise<GenStudioCatalogSnapshot<GenStudioVideoModel[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('video', catalogCacheKey('video', baseUrl, apiKey), async () => {
  const payload = await fetchCatalogJson(`${apiBase(baseUrl)}/v1/videos/models`, apiKey)
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid video model catalog')
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    available: value?.available === true,
    // Every published mode survives the transport. Story Studio submits only
    // image-to-video, but that is enforced where a request is built, not by
    // deleting what GenStudio said.
    modes: Array.isArray(value?.modes)
      ? value.modes
        .filter((item: unknown): item is string => typeof item === 'string' && !!item.trim())
        .map((item: string) => item.trim())
      : [],
    aspect_ratios: Array.isArray(value?.aspect_ratios)
      ? value.aspect_ratios.filter((item: unknown): item is string => typeof item === 'string')
      : [],
    // SHAPE, not membership. A variant is kept when it is well-formed: a
    // positive finite duration, a non-empty resolution label, finite prices
    // and a price version. A 4k or 8-second product GenStudio publishes today
    // therefore reaches the UI unchanged; the old filter dropped it silently,
    // leaving the model looking as if it had no variants at all.
    variants: Array.isArray(value?.variants)
      ? value.variants.filter((item: any) => (
          Number.isFinite(item?.duration_seconds)
          && item.duration_seconds > 0
          && typeof item?.resolution === 'string'
          && item.resolution.trim().length > 0
          && Number.isFinite(item?.credits_per_video)
          && Number.isFinite(item?.minimum_credits)
          && typeof item?.price_version === 'string'
        )).map((item: any): GenStudioVideoVariant => ({
          duration_seconds: item.duration_seconds,
          resolution: item.resolution.trim(),
          credits_per_video: item.credits_per_video,
          minimum_credits: item.minimum_credits,
          price_version: item.price_version,
        }))
      : [],
    // Tri-state. An absent or non-boolean field is `null` ("GenStudio did not
    // say"), never coerced to `false` — claiming a model is silent when the
    // catalogue never said so is inventing a capability answer.
    generates_audio: typeof value?.generates_audio === 'boolean' ? value.generates_audio : null,
  })).filter((model: GenStudioVideoModel) => model.id && model.display_name)
  })
}

export async function listVideoModels(apiKey: string): Promise<GenStudioVideoModel[]> {
  return (await listVideoModelsSnapshot(apiKey)).value
}

function videoSourceMediaType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    default: return 'application/octet-stream'
  }
}

export function buildGenStudioVideoIdempotencyKey(input: {
  prompt: string
  modelId: string
  sourceSha256: string
  aspectRatio: string
  durationSeconds: number
  resolution: string
  requestIdentity?: string
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    prompt: input.prompt.trim(),
    model_id: input.modelId.trim(),
    source_sha256: input.sourceSha256,
    aspect_ratio: input.aspectRatio,
    duration_seconds: input.durationSeconds,
    resolution: input.resolution,
    request_identity: input.requestIdentity || null,
  })).digest('hex')
  return `story-video-${digest.slice(0, 44)}`
}

/**
 * Poll one accepted video job to a settled outcome.
 *
 * Terminal is `succeeded` | `failed` ONLY — there is no `cancelled` JobState.
 * Cancellation rides on the `cancelled` boolean, so it is treated as an extra
 * terminal signal via `isSettledGenStudioJob`.
 */
async function waitForVideoJob(
  baseUrl: string,
  apiKey: string,
  submitted: GenStudioVideoJob,
  request: GenStudioVideoRequest,
  deadline: number,
): Promise<GenStudioVideoJob> {
  let current = submitted
  let reportedState = ''
  let reportedRoutingState = ''
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || ''
    if (reportedState === current.state && reportedRoutingState === routingState) return
    reportedState = current.state
    reportedRoutingState = routingState
    await recordGenStudioEvidence('video.generation', current)
    await reportQueueState(request, current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!isSettledGenStudioJob(current)) {
    await submitQueuedRemoteCancellation('video.generation', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) {
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) throw new Error('GenStudio video job timed out while waiting for completion.')
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/videos/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioVideoJob
    await reportState()
  }
  await genStudioAdmission.notifyTerminal(apiKey)
  if (current.state === 'failed' || current.cancelled === true) {
    throw new GenStudioVideoTerminalFailureError(current)
  }
  return current
}

function videoResult(
  baseUrl: string,
  apiKey: string,
  completed: GenStudioVideoJob,
): GenStudioVideoResult {
  const videoUrl = completed.video_url || `/v1/videos/${encodeURIComponent(completed.id)}/file`
  return {
    videoUrl: requestUrl(baseUrl, videoUrl),
    jobId: completed.id,
    modelId: completed.model_id,
    downloadHeaders: authorization(apiKey),
    creditCost: completed.credit_cost,
    remainingCredits: completed.remaining_credits,
    priceVersion: completed.price_version,
  }
}

/** Reconnect to an already accepted video task. Never submits new work. */
async function recoverVideoWithGenStudioAdmitted(
  apiKey: string,
  jobId: string,
  request: GenStudioVideoRequest,
): Promise<GenStudioVideoResult> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const initial = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/videos/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
  ) as GenStudioVideoJob
  // Classify BEFORE polling. A job that already failed (or was cancelled)
  // cannot become a clip, and a poll loop would only re-read the same terminal
  // record forever.
  if (initial.state === 'failed' || initial.cancelled === true) {
    await recordGenStudioEvidence('video.generation', initial)
    await reportQueueState(request, initial)
    await request.onState?.(initial.state, initial.id)
    throw new GenStudioVideoTerminalFailureError(initial)
  }
  const completed = initial.state === 'succeeded'
    ? initial
    : await waitForVideoJob(baseUrl, apiKey, initial, request, deadline)
  if (completed === initial) {
    await recordGenStudioEvidence('video.generation', initial)
    await reportQueueState(request, initial)
    await request.onState?.(initial.state, initial.id)
  }
  return videoResult(baseUrl, apiKey, completed)
}

export async function recoverVideoWithGenStudio(
  apiKey: string,
  jobId: string,
  request: GenStudioVideoRequest,
): Promise<GenStudioVideoResult> {
  return recoverVideoWithGenStudioAdmitted(apiKey, jobId, request)
}

/** Submit image-to-video work only through GenStudio's durable video boundary. */
async function generateVideoWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioVideoRequest,
): Promise<GenStudioVideoResult> {
  const prompt = request.prompt.trim()
  const modelId = request.modelId.trim()
  if (prompt.length < 3 || prompt.length > 4_000) throw new Error('GenStudio video prompts must contain 3 to 4,000 characters.')
  if (!modelId) throw new Error('Select a GenStudio video model.')
  const source = await fs.readFile(request.sourceImagePath)
  if (!source.length) throw new Error('GenStudio video source image is empty.')
  const sourceSha256 = createHash('sha256').update(source).digest('hex')
  // A caller that checkpointed its key before this call is authoritative: that
  // persisted key is exactly what makes a lost submit response replay instead
  // of creating a second paid job.
  const idempotencyKey = request.idempotencyKey?.trim() || buildGenStudioVideoIdempotencyKey({
    prompt,
    modelId,
    sourceSha256,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    requestIdentity: request.requestIdentity,
  })
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const uploadBody = new FormData()
  uploadBody.set(
    'upload',
    new Blob([new Uint8Array(source)], { type: videoSourceMediaType(request.sourceImagePath) }),
    path.basename(request.sourceImagePath),
  )
  const sourceAsset = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/videos/source-images`,
    { method: 'POST', headers: authorization(apiKey), body: uploadBody },
    request,
    deadline,
  ) as GenStudioVideoSourceAsset
  if (!sourceAsset.id) throw new Error('GenStudio video source upload returned no asset id.')

  const requestPreview = await recordGenStudioRequestPreview('video.generation', {
    method: 'POST',
    path: '/v1/videos/generations',
    modelId,
    idempotencyKey,
    messages: [{ role: 'prompt', content: prompt }],
    fields: [
      ['mode', 'image-to-video'],
      ['duration_seconds', request.durationSeconds],
      ['resolution', request.resolution],
      ['aspect_ratio', request.aspectRatio],
      ['reference_asset_id', sourceAsset.id],
    ],
  })
  const submitted = await submitJsonWithAdmission(
    apiKey,
    `${apiBase(baseUrl)}/v1/videos/generations`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        prompt,
        model_id: modelId,
        mode: 'image-to-video',
        reference_asset_id: sourceAsset.id,
        aspect_ratio: request.aspectRatio,
        duration_seconds: request.durationSeconds,
        resolution: request.resolution,
      }),
    },
    request,
    deadline,
  ) as GenStudioVideoJob
  await recordGenStudioEvidence('video.generation', submitted, requestPreview)
  await reportQueueState(request, submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  try {
    return videoResult(baseUrl, apiKey, await waitForVideoJob(baseUrl, apiKey, submitted, request, deadline))
  } catch (error) {
    // A settled outcome is never reopened; only a lost connection reconnects,
    // and it reconnects to the job we already paid for.
    if (!shouldReconnectAcceptedTask(error, request)) throw error
    await request.onReconnect?.(submitted.id, error instanceof Error ? error.message : String(error))
    return recoverVideoWithGenStudioAdmitted(apiKey, submitted.id, request)
  }
}

export async function generateVideoWithGenStudio(
  apiKey: string,
  request: GenStudioVideoRequest,
): Promise<GenStudioVideoResult> {
  return generateVideoWithGenStudioAdmitted(apiKey, request)
}

async function readAccountJson<T>(apiKey: string, pathName: string): Promise<T> {
  const baseUrl = await getGenStudioUrl()
  return readJson(await fetch(`${apiBase(baseUrl)}${pathName}`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  })) as Promise<T>
}

/** Lightweight authoritative account status used by the usage surfaces. */
export async function getGenStudioAccountOverview(apiKey: string): Promise<GenStudioAccountOverview> {
  const {
    credit_balance,
    credits_used_30d,
    subscription_plan_name,
    api_concurrency_limit,
    paid_concurrency_limit,
    paid_active_jobs,
    paid_queued_jobs,
    max_queued_jobs,
    generation_submissions_per_minute,
    total_jobs,
    active_jobs,
    completed_jobs,
    failed_jobs,
    available_assets,
    next_asset_expiration,
  } = await readAccountJson<GenStudioAccountOverview>(apiKey, '/v1/account/overview')
  return {
    credit_balance,
    credits_used_30d,
    subscription_plan_name,
    api_concurrency_limit,
    paid_concurrency_limit,
    paid_active_jobs,
    paid_queued_jobs,
    max_queued_jobs,
    generation_submissions_per_minute,
    total_jobs,
    active_jobs,
    completed_jobs,
    failed_jobs,
    available_assets,
    next_asset_expiration,
  }
}

/** Authoritative balance and settlement data; never reconstructed locally. */
export async function getGenStudioAccountSnapshot(apiKey: string): Promise<{
  overview: GenStudioAccountOverview
  jobs: { items: GenStudioCustomerJob[]; page: number; page_size: number; total: number; total_pages: number }
  credit_activity: { items: GenStudioCreditActivity[]; page: number; page_size: number; total: number; total_pages: number }
}> {
  // Prove the key has account access before starting the two larger paginated
  // reads. An invalid or under-scoped key therefore produces one clear
  // failure instead of three concurrent rejected requests.
  const overview = await getGenStudioAccountOverview(apiKey)
  // GenStudio accepts a fixed page-size set. Keep this explicit so Story
  // Studio cannot drift back to an otherwise reasonable but invalid value.
  const accountPageSize = 20
  const [jobs, creditActivity] = await Promise.all([
    readAccountJson<any>(apiKey, `/v1/account/jobs?page=1&page_size=${accountPageSize}`),
    readAccountJson<any>(apiKey, `/v1/account/credit-activity?page=1&page_size=${accountPageSize}`),
  ])
  return { overview, jobs, credit_activity: creditActivity }
}

/**
 * The temperature that has always stood in for an unset caller value.
 *
 * It remains a DIGEST component on every request, including one whose product
 * does not publish the `temperature` control and therefore never puts the
 * field on the wire. The digest describes the WORK REQUESTED, not the exact
 * bytes posted, and changing it would change every chat idempotency key — a
 * retry crossing that upgrade would resubmit and charge a second time. Same
 * reasoning as `LEGACY_IMAGE_STEPS_DIGEST_COMPONENT`.
 */
const LEGACY_CHAT_TEMPERATURE_DIGEST_DEFAULT = 0.7

/**
 * `top_p` FROZEN into the digest at its historical value; it is no longer a
 * parameter and is no longer sent.
 *
 * Every chat request this app has ever made carried `top_p: 1`: no caller ever
 * set `topP`, and the single caller that passed one passed exactly `1`, which
 * is also what the `?? 1` fallback produced. Keeping the component frozen makes
 * every key computed after the field's removal byte-identical to the one
 * computed before it, so a retry that crosses this upgrade still replays the
 * in-flight job instead of submitting — and billing — a second one.
 */
const LEGACY_CHAT_TOP_P_DIGEST_COMPONENT = 1

/**
 * Wire-format digest component, keyed by output-contract mode.
 *
 * BUG THIS CLOSES (v1.0.788, commit 9842059): that release changed what a
 * `prose` request puts on the wire — `response_format` went from
 * `{"type":"json_object"}` (with a wrapper instruction telling the model to
 * escape its whole answer into one JSON string) to `{"type":"text"}`. The
 * digest below hashed only `output_contract` (`{mode:'prose'}` either way),
 * never the wire format, so a prose batch that failed TERMINALLY under the
 * old format computed the SAME key when retried under the new one. GenStudio
 * correctly refuses that: same key, different request body. The result was a
 * terminally-failed job holding its key forever against a request shape that
 * can never match again — every episode ever attempted before the upgrade
 * stayed permanently blocked.
 *
 * FIX SHAPE, not a one-off patch: `response_format` is a real part of what
 * Story Studio sends (GenStudio's own `product_service.py::_canonical_hash`
 * folds `response_format` into ITS request hash for exactly this reason), so
 * it belongs in the digest. `prose` is the only mode wired here because it is
 * the only mode whose wire mapping has ever changed — `productResponseFormat`
 * reads `PROSE_RESPONSE_FORMAT`, the SAME constant hashed here, so the two can
 * never drift apart again the way they did in v1.0.788.
 *
 * `json_object` / `json_schema` are DELIBERATELY given no entry (the spread
 * below contributes nothing for them, so their digest bytes are IDENTICAL to
 * every key ever computed for those modes). Their wire mapping has never
 * changed. Adding a component for them now would perturb every JSON-mode key
 * ever issued — including one still genuinely in-flight at GenStudio at the
 * moment this fix ships — for zero collision this app has ever hit. Extend
 * this map the day THEIR mapping changes, not before; same reasoning as
 * `LEGACY_CHAT_TOP_P_DIGEST_COMPONENT` below.
 */
function wireFormatDigestComponent(outputContract: TextOutputContract): Record<string, unknown> {
  return outputContract.mode === 'prose' ? { response_format: PROSE_RESPONSE_FORMAT } : {}
}

/**
 * The contract as the REQUEST sees it — local-only fields stripped.
 *
 * The digest exists to answer "is this the same request?", and GenStudio
 * answers the same question from the bytes it received. `accept` is never
 * received by anyone: it says what Story Studio will DO with the answer, not
 * what it asked for. Hashing it would mint a new key for a byte-identical
 * request, and a new key is not a harmless difference — it abandons a job
 * already in flight under the old key and pays for a second one, which is the
 * exact failure this whole key exists to prevent.
 *
 * Stripping it also has a concrete recovery value: the packs orphaned by the
 * submit-timeout defect were already generated, charged, and retained by
 * GenStudio. Because their keys are unchanged by this release, re-running that
 * stage REPLAYS those settled jobs instead of buying them again.
 *
 * A contract with no `accept` hashes byte-for-byte as it always has: `accept`
 * is added last by its builder, so the rest spread preserves key order.
 */
function digestOutputContract(outputContract: TextOutputContract): TextOutputContract {
  if (outputContract.mode !== 'json_object') return outputContract
  const { accept: _localOnly, ...asked } = outputContract
  return asked
}

export function buildGenStudioChatIdempotencyKey(request: GenStudioChatRequest): string {
  const outputContract = request.outputContract
    ?? (request.jsonObject === true ? JSON_OBJECT_OUTPUT_CONTRACT : PROSE_OUTPUT_CONTRACT)
  const digest = createHash('sha256').update(JSON.stringify({
    model_id: request.modelId.trim(),
    system: request.system,
    user_message: request.userMessage,
    temperature: request.temperature ?? LEGACY_CHAT_TEMPERATURE_DIGEST_DEFAULT,
    top_p: LEGACY_CHAT_TOP_P_DIGEST_COMPONENT,
    // model-drift-allow: frozen digest component, not a limit. Every key ever
    // computed for a caller that named no ceiling used this number; changing it
    // would change every idempotency key and let a retry that crosses an
    // upgrade submit — and bill — a second job instead of replaying the first.
    max_output_tokens: request.maxOutputTokens ?? 2_048,
    // Two tiers resolve to two different ceilings on the same product, so they
    // must not share a replay key. Emitted only when a tier was declared, so
    // every pre-existing caller's digest stays byte-for-byte what it was.
    ...(describeOutputBudget(request.outputBudget)
      ? { output_budget: describeOutputBudget(request.outputBudget) }
      : {}),
    request_identity: request.requestIdentity?.trim() || null,
    input_image: request.inputImage ? { asset_id: request.inputImage.assetId, detail: request.inputImage.detail } : null,
    output_contract: digestOutputContract(outputContract),
    // The WIRE format, not a re-derivation of it. See wireFormatDigestComponent.
    ...wireFormatDigestComponent(outputContract),
  })).digest('hex')
  return `story-chat-${digest.slice(0, 47)}`
}

/**
 * GenStudio's web-research evidence envelope.
 *
 * Field names confirmed against the published contract
 * (cloud-api app/modules/chat/schemas.py :: OpenAIChatCompletionResponse AND
 * :: ChatJobResponse, plus app/modules/chat/router.py). These are NOT guesses
 * and must not drift back to invented names.
 *
 * CARRIED BY BOTH ROUTES: the durable `/v1/chat/responses` job publishes these
 * at the same top level as the synchronous completion envelope does — see
 * docs/genstudio-web-search-request.md §3, which asked for citations "as their
 * own field on the job response". Modelling it once means the durable
 * migration cannot silently drop research provenance.
 */
interface GenStudioResearchEnvelope {
  /** Provider citations for a web-search request. Envelope-level on purpose:
   *  sources are provider evidence, not something the model wrote. */
  citations?: unknown
  /** Whether GenStudio actually ran the request as a web-research request. */
  web_search_requested?: unknown
  /** Searches the provider actually executed. `null` = not reported. */
  web_searches_executed?: unknown
  /** Credits for the web-search ADD-ON only — not the request's total charge.
   *  Reported as-is; this app never multiplies a published rate into a total. */
  web_search_credit_cost?: unknown
  /** When the research run completed, per GenStudio. Preferred over Story
   *  Studio's locally stamped `generated_at` for "Research ran on". */
  research_ran_at?: unknown
  /** Claim-to-source linkage. In the contract, but providers do not populate
   *  it yet, so it is parsed and carried without any per-claim display. */
  citation_claims?: unknown
  /** Pages the provider reported retrieving. Never promoted into citations. */
  source_urls?: unknown
  /** The published strength of the returned research evidence. */
  research_evidence_level?: unknown
}

interface GenStudioChatCompletion extends GenStudioResearchEnvelope {
  id: string
  model: string
  choices: Array<{
    message?: { content?: string }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/** Parse the envelope citation list. Unknown/garbage entries are dropped
 *  rather than passed through: a citation with no URL is not evidence. */
export function parseGenStudioCitations(value: unknown): GenStudioCitation[] {
  if (!Array.isArray(value)) return []
  const out: GenStudioCitation[] = []
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') continue
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!url) continue
    const text = (key: string): string | null => {
      const item = raw[key]
      return typeof item === 'string' && item.trim() ? item.trim() : null
    }
    const offset = (key: string): number | null => {
      const item = raw[key]
      return Number.isInteger(item) && (item as number) >= 0 ? item as number : null
    }
    out.push({
      id: text('id') || `source-${index + 1}`,
      url,
      title: text('title'),
      publisher: text('publisher'),
      published_at: text('published_at'),
      quote: text('quote') || text('snippet'),
      start_index: offset('start_index'),
      end_index: offset('end_index'),
    })
  }
  return out
}

/**
 * What a web-search run actually did / cost, as GenStudio reported it.
 *
 * Every field is null when GenStudio did not report it — this app never fills
 * the gap with a locally computed estimate, and the surfaces say "not
 * reported" rather than showing a number nobody was charged.
 */
export interface GenStudioWebSearchUsage {
  /** Provider-reported retrieved pages. These do not attribute answer text. */
  sourceUrls: string[]
  /** Evidence strength GenStudio published, or null when no research ran. */
  researchEvidenceLevel: ResearchEvidenceLevel | null
  /** Envelope `web_searches_executed`. */
  searchesExecuted: number | null
  /** Envelope `web_search_credit_cost` — the web-search ADD-ON cost only. */
  searchCreditCost: number | null
  /** Envelope `research_ran_at`, ISO8601. Run-level provenance; there is no
   *  per-source retrieval time to display. */
  researchRanAt: string | null
  /** Envelope `citation_claims`. Empty today — providers do not populate it —
   *  but parsed so it lights up the moment one does. */
  citationClaims: GenStudioCitationClaim[]
}

/** Explicit claim-to-source linkage, when a provider returns it. */
export interface GenStudioCitationClaim {
  claim_id: string
  citation_ids: string[]
}

/** Parse `citation_claims`. A claim with no source ids is not linkage. */
export function parseGenStudioCitationClaims(value: unknown): GenStudioCitationClaim[] {
  if (!Array.isArray(value)) return []
  const out: GenStudioCitationClaim[] = []
  for (const raw of value as Array<Record<string, unknown> | null>) {
    if (!raw || typeof raw !== 'object') continue
    const claimId = typeof raw.claim_id === 'string' ? raw.claim_id.trim() : ''
    if (!claimId) continue
    const ids = Array.isArray(raw.citation_ids)
      ? raw.citation_ids.filter((id): id is string => typeof id === 'string' && !!id.trim())
        .map(id => id.trim())
      : []
    if (!ids.length) continue
    out.push({ claim_id: claimId, citation_ids: ids })
  }
  return out
}

/** An ISO timestamp GenStudio actually sent, or null. Never locally stamped. */
function readReportedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value.trim())
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** Read the research envelope off EITHER route's response. Identical field
 *  names, so one parser — a durable job and a synchronous completion report
 *  their web run exactly the same way. */
function readWebSearchUsage(envelope: GenStudioResearchEnvelope): GenStudioWebSearchUsage {
  const executed = envelope.web_searches_executed
  const cost = envelope.web_search_credit_cost
  return {
    sourceUrls: Array.isArray(envelope.source_urls)
      ? [...new Set(envelope.source_urls.flatMap(raw => {
        if (typeof raw !== 'string' || !raw.trim()) return []
        try {
          const url = new URL(raw.trim())
          return url.protocol === 'http:' || url.protocol === 'https:' ? [url.toString()] : []
        } catch {
          return []
        }
      }))]
      : [],
    researchEvidenceLevel: envelope.research_evidence_level === 'attributed_claim_citations'
      || envelope.research_evidence_level === 'claim_citations'
      || envelope.research_evidence_level === 'source_urls_only'
      ? envelope.research_evidence_level
      : null,
    searchesExecuted: Number.isInteger(executed) && (executed as number) >= 0
      ? executed as number
      : null,
    searchCreditCost: Number.isInteger(cost) && (cost as number) >= 0
      ? cost as number
      : null,
    researchRanAt: readReportedTimestamp(envelope.research_ran_at),
    citationClaims: parseGenStudioCitationClaims(envelope.citation_claims),
  }
}

/** The "nothing reported" usage record, for a request that never asked.
 *  Frozen: it is handed to every non-web result, so it must not be mutable. */
export const EMPTY_WEB_SEARCH_USAGE: GenStudioWebSearchUsage = Object.freeze({
  sourceUrls: Object.freeze([] as string[]) as string[],
  researchEvidenceLevel: null,
  searchesExecuted: null,
  searchCreditCost: null,
  researchRanAt: null,
  citationClaims: Object.freeze([] as GenStudioCitationClaim[]) as GenStudioCitationClaim[],
})

const SCHEMA_INSTRUCTION_MAX_DEPTH = 5
const SCHEMA_INSTRUCTION_MAX_ENUM = 12

function isSchemaObject(value: unknown): value is JsonSchema {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function schemaTypeLabel(schema: JsonSchema): string {
  const type = Array.isArray(schema.type)
    ? schema.type.filter(item => typeof item === 'string').join(' or ')
    : schema.type
  return typeof type === 'string' && type ? type : 'value'
}

function schemaConstraintLabel(schema: JsonSchema): string {
  const bits: string[] = []
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const shown = schema.enum.slice(0, SCHEMA_INSTRUCTION_MAX_ENUM).map(item => JSON.stringify(item))
    const rest = schema.enum.length - shown.length
    bits.push(`one of: ${shown.join(', ')}${rest > 0 ? `, +${rest} more listed in the request` : ''}`)
  }
  const isString = schemaTypeLabel(schema) === 'string'
  if (typeof schema.minLength === 'number' && schema.minLength > 0) {
    bits.push(schema.minLength === 1 ? 'non-empty' : `at least ${schema.minLength} characters`)
  }
  if (typeof schema.maxLength === 'number' && isString) bits.push(`at most ${schema.maxLength} characters`)
  if (typeof schema.minimum === 'number') bits.push(`minimum ${schema.minimum}`)
  if (typeof schema.maximum === 'number') bits.push(`maximum ${schema.maximum}`)
  if (typeof schema.minItems === 'number' && schema.minItems === schema.maxItems) {
    bits.push(`exactly ${schema.minItems} items`)
  } else {
    if (typeof schema.minItems === 'number') bits.push(`at least ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number') bits.push(`at most ${schema.maxItems} items`)
  }
  return bits.length ? ` (${bits.join(', ')})` : ''
}

function describeSchemaNode(schema: JsonSchema, indent: string, depth: number, lines: string[]): void {
  if (depth > SCHEMA_INSTRUCTION_MAX_DEPTH) return
  const label = schemaTypeLabel(schema)
  if (label === 'object') {
    const properties = isSchemaObject(schema.properties) ? schema.properties : {}
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === 'string')
        : [],
    )
    for (const [key, child] of Object.entries(properties)) {
      const childSchema = isSchemaObject(child) ? child : {}
      lines.push(
        `${indent}- ${key}: ${schemaTypeLabel(childSchema)}${schemaConstraintLabel(childSchema)}`
        + `${required.has(key) ? ' [required]' : ' [optional]'}`,
      )
      describeSchemaNode(childSchema, `${indent}  `, depth + 1, lines)
    }
    return
  }
  if (label === 'array' && isSchemaObject(schema.items)) {
    const items = schema.items
    if (schemaTypeLabel(items) === 'object') {
      lines.push(`${indent}- each item is an object with:`)
      describeSchemaNode(items, `${indent}  `, depth + 1, lines)
      return
    }
    lines.push(`${indent}- each item: ${schemaTypeLabel(items)}${schemaConstraintLabel(items)}`)
  }
}

/**
 * Describe a workflow schema in words so a JSON Object product returns the
 * shape Story Studio validates locally. Deterministic and token-frugal: field
 * names, types, bounds, and which keys are required.
 */
export function describeSchemaForInstructions(name: string, schema: JsonSchema): string {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []
  const lines = [`Return exactly one JSON object for the "${name}" contract.`]
  if (required.length) {
    lines.push(`Required top-level key${required.length === 1 ? '' : 's'}: ${required.join(', ')}.`)
  }
  describeSchemaNode(schema, '', 0, lines)
  if (schema.additionalProperties === false) lines.push('Do not add any keys that are not listed above.')
  lines.push('Return only that JSON object: no markdown fences, no commentary, no trailing text.')
  return lines.join('\n')
}

const JSON_OBJECT_WRAPPER_INSTRUCTION =
  'Return exactly one JSON object. Return only that object: no markdown fences, no commentary, no trailing text.'

/**
 * What GenStudio KH is asked to return for a `prose` contract, on the wire.
 *
 * SINGLE SOURCE OF TRUTH: `productResponseFormat` sends this value, and
 * `buildGenStudioChatIdempotencyKey` hashes this same constant — never a
 * second literal that happens to say the same thing today. The v1.0.788
 * defect (see the digest comment below) existed because the wire value and
 * the digest were two independent facts that silently drifted apart. Sharing
 * one constant makes that drift a compile-time impossibility: change this
 * value and both call sites move together.
 */
const PROSE_RESPONSE_FORMAT: Record<string, unknown> = { type: 'text' }

/**
 * Choose the response format for one published language product.
 *
 * GenStudio language products do not require provider-native strict JSON
 * schema, so this function is TOTAL: it never rejects a product for its
 * advertised structured-output mode. JSON Object output is preferred for
 * structured contracts, and the required structure is carried in the request
 * instructions; the returned object is validated locally against the workflow
 * schema.
 *
 * PROSE ASKS FOR PROSE. A narrative chapter is not JSON and is no longer sent
 * as JSON. Until this release every prose contract requested
 * `{ type: 'json_object' }` and told the model to emit the whole answer as one
 * escaped JSON string, so every quote, newline and apostrophe in three chapters
 * of narration had to be escaped perfectly or GenStudio rejected the result as
 * LANGUAGE_STRUCTURED_OUTPUT_INVALID — after the account had already been
 * charged for generating it.
 *
 * The wrapper existed because GenStudio once forced structure on every language
 * request. It no longer does: output structure is a property of the REQUEST,
 * not of the product. In `ProductChatCompletionService.complete`, a request
 * whose mode is `none` is the FIRST arm of the chain and returns the caller's
 * messages untouched — so it never reaches the product-mode gate below it, no
 * JSON instruction is injected, no native `response_format` is forwarded to the
 * provider, and the JSON validation that raises
 * LANGUAGE_STRUCTURED_OUTPUT_INVALID returns early without decoding anything.
 * That holds for a product advertising `json_object` and for one advertising
 * `request_json_schema` alike, which is why `productMode` is not consulted here.
 *
 * `{ type: 'text' }` is sent EXPLICITLY rather than omitted:
 * `/v1/chat/completions` keeps `response_format` a required field with no
 * default, so an omitted format is a 422 there. `/v1/chat/responses` treats an
 * absent format as text, and accepts the same explicit object — one value is
 * therefore correct on both routes.
 */
function productResponseFormat(
  productMode: GenStudioChatModel['structured_output_mode'],
  outputContract: TextOutputContract,
): { responseFormat: Record<string, unknown>; wrapperInstruction?: string } {
  if (outputContract.mode === 'prose') return { responseFormat: PROSE_RESPONSE_FORMAT }

  const name = outputContract.name ?? 'story_studio_json_object'
  const schema = outputContract.schema
  const wrapperInstruction = schema
    ? describeSchemaForInstructions(name, schema)
    : JSON_OBJECT_WRAPPER_INSTRUCTION

  // Only a product whose sole advertised mode is request_json_schema receives a
  // provider-native schema, and only when the workflow actually supplies one.
  if (productMode === 'request_json_schema' && schema) {
    return {
      responseFormat: {
        type: 'json_schema',
        json_schema: { name, strict: true, schema },
      },
      wrapperInstruction,
    }
  }
  return { responseFormat: { type: 'json_object' }, wrapperInstruction }
}

/**
 * Turn one finished language output into a validated Story Studio result.
 *
 * ONE implementation for BOTH routes on purpose: truncation detection and
 * local schema validation are the two checks that stand between a half-written
 * chapter and a docx on disk, so neither may exist in two places where one copy
 * can rot. `/v1/chat/completions` feeds it `choices[0].message.content` +
 * `choices[0].finish_reason`; `/v1/chat/responses` feeds it the job's
 * `output_text` + `finish_reason`.
 */
function parseLanguageOutput(
  output: GenStudioIncompleteOutput,
  outputContract: TextOutputContract,
): { text: string; jobId: string; modelId: string } {
  const raw = output.output_text
  // Truncation is never success. GenStudio's own settlement path already
  // refuses to charge an output whose finish_reason is not a stop
  // (LANGUAGE_PROVIDER_INCOMPLETE), so a truncated envelope should not reach
  // us — but "should not" is not a guarantee, and the failure mode if it does
  // is the worst kind: a half-written chapter saved to disk as if it were
  // finished. Check it here, at the one place every language call passes.
  if (!isCompleteFinishReason(output.finish_reason)) {
    throw new GenStudioChatIncompleteError(output)
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('GenStudio KH language product succeeded without usable output.')
  }
  const value = validateStructuredOutput(raw, outputContract)
  if (outputContract.mode === 'prose') {
    return {
      text: (value as { text: string }).text,
      jobId: output.id,
      modelId: output.model_id,
    }
  }
  return {
    text: JSON.stringify(value),
    jobId: output.id,
    modelId: output.model_id,
  }
}

function parseProductCompletion(
  completion: GenStudioChatCompletion,
  outputContract: TextOutputContract,
): { text: string; jobId: string; modelId: string } {
  const choice = completion.choices?.[0]
  return parseLanguageOutput({
    id: completion.id,
    model_id: completion.model,
    output_text: typeof choice?.message?.content === 'string' ? choice.message.content : null,
    finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  }, outputContract)
}

/** Result of one language-product call. `citations` and `webSearch` are only
 *  populated for a request that carried a `web_search` block. */
export interface GenStudioChatResult {
  text: string
  jobId: string
  modelId: string
  /** Provider citations from the response envelope. Empty for a normal call,
   *  and legitimately empty for a web call where the provider searched nothing
   *  or cited nothing — that outcome is surfaced, never hidden. */
  citations: GenStudioCitation[]
  /** Actual searches / charge, when reported. Null fields mean "not reported". */
  webSearch: GenStudioWebSearchUsage
}

/**
 * Everything one language call needs on the wire, resolved BEFORE any network
 * submission and shared byte-for-byte by both routes.
 */
interface PreparedChatSubmission {
  modelId: string
  product: GenStudioChatModel
  maxOutputTokens: number
  outputContract: TextOutputContract
  responseFormat: Record<string, unknown>
  /** system (+ wrapper instruction) then user — but ONLY when the product
   *  publishes the `system_instruction` control. When it does not, the same
   *  text is folded into the single user turn instead, so the instruction is
   *  still delivered without sending a field the product never advertised.
   *  `messages` on the completions route, `input` on the responses route. */
  messages: Array<{ role: string; content: string }>
  /** Sampling fields the product actually published, already resolved. A field
   *  absent here is NOT sent — never sent as a Story Studio default. */
  samplingFields: Record<string, number>
  idempotencyKey: string
  transport: GenStudioChatTransport
}

/**
 * Does the selected product publish this control?
 *
 * `controls[]` is GenStudio's statement of the legal field set for a product
 * (`system_instruction | temperature | top_p | max_output_tokens`). An absent
 * entry means the product does not advertise the field, and Story Studio must
 * not send it — sending an unpublished sampling parameter is exactly the
 * "value nobody chose" the first rule in AGENTS.md forbids. An EMPTY list
 * therefore means "publish nothing, send nothing", not "send everything".
 */
export function productPublishesControl(
  product: Pick<GenStudioChatModel, 'controls'>,
  control: 'system_instruction' | 'temperature' | 'top_p' | 'max_output_tokens',
): boolean {
  return Array.isArray(product.controls) && product.controls.includes(control)
}

/**
 * Run every pre-network guard and resolve the request shape.
 *
 * EVERY `throw` in this function happens STRICTLY BEFORE the submit call on
 * both routes — that is what makes the "No request or credit charge was made"
 * wording true rather than merely reassuring. Nothing here submits work: the
 * only network access is the cached product catalogue read, which is a GET
 * against `/v1/chat/models` and never creates a job.
 */
async function prepareChatSubmission(
  apiKey: string,
  request: GenStudioChatRequest,
): Promise<PreparedChatSubmission> {
  const modelId = request.modelId.trim().replace(/^genstudio-chat:/, '')
  if (!modelId) throw new Error('Select a GenStudio KH chat model.')
  if (!request.userMessage.trim()) throw new Error('GenStudio KH chat input cannot be empty.')
  if (request.inputImage) {
    throw new Error('The GenStudio language-product endpoint is text-only in this release. No request or credit charge was made.')
  }
  const product = (await listChatModels(apiKey)).find(model => model.id === modelId)
  if (!product || !product.available || product.qualification_only) {
    throw new GenStudioChatProductUnavailableError(modelId)
  }
  // An explicit number still wins (and is still checked below). Otherwise the
  // workflow's declared tier is sized from THIS product's published ceiling —
  // never from a constant that goes stale when GenStudio publishes a product
  // with a different limit. An absent budget resolves to the historical
  // short-form default, so callers that never opted in are unchanged.
  //
  // `/v1/chat/responses` publishes NO maximum of its own for
  // `max_output_tokens` (the old 32,768 route cap is gone), so the product's
  // published ceiling remains the real and only limit — the durable migration
  // does not shrink any allowance shipped in v1.0.765/766.
  //
  // A product that publishes NO output ceiling cannot be sized at all, so the
  // request is refused here rather than sized against a number Story Studio
  // made up. Same reasoning as `splitGenStudioApiRequests`, which refuses to
  // pick a TTS request boundary GenStudio did not publish: guessing an output
  // budget too low truncates a chapter mid-sentence, and truncated output has
  // already cost the customer by the time anyone notices. Pre-network — no
  // request is made and no credit is charged.
  if (!Number.isInteger(product.max_output_tokens) || product.max_output_tokens < 1) {
    throw new Error(
      `GenStudio KH published no max_output_tokens for ${product.display_name}. `
      + 'Story Studio cannot size this request without it and will not invent a ceiling. '
      + 'Refresh the model catalogue or choose another published product. '
      + 'No request or credit charge was made.',
    )
  }
  const maxOutputTokens = request.maxOutputTokens
    ?? resolveOutputTokenBudget(request.outputBudget, product.max_output_tokens)
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > product.max_output_tokens) {
    throw new Error(
      `This workflow requested ${maxOutputTokens.toLocaleString()} output tokens, but ${product.display_name} publishes a ${product.max_output_tokens.toLocaleString()}-token limit. No request or credit charge was made.`,
    )
  }
  const outputContract = request.outputContract
    ?? (request.jsonObject === true ? JSON_OBJECT_OUTPUT_CONTRACT : PROSE_OUTPUT_CONTRACT)
  const { responseFormat, wrapperInstruction } = productResponseFormat(
    product.structured_output_mode,
    outputContract,
  )
  const systemText = [request.system.trim(), wrapperInstruction].filter(Boolean).join('\n\n')
  // A system TURN is the `system_instruction` control. When the product does
  // not publish it, the instruction is folded into the user turn instead: the
  // text still reaches the model, and no unpublished field goes on the wire.
  const sendsSystemTurn = !!systemText && productPublishesControl(product, 'system_instruction')
  return {
    modelId,
    product,
    maxOutputTokens,
    outputContract,
    responseFormat,
    messages: [
      ...(sendsSystemTurn ? [{ role: 'system', content: systemText }] : []),
      {
        role: 'user',
        content: !systemText || sendsSystemTurn
          ? request.userMessage
          : `${systemText}\n\n${request.userMessage}`,
      },
    ],
    // `temperature` travels only when published. `top_p` never travels at all
    // — Story Studio has never had a top_p value anyone chose, so there is
    // nothing honest to send. See `LEGACY_CHAT_TOP_P_DIGEST_COMPONENT`.
    samplingFields: productPublishesControl(product, 'temperature')
      ? { temperature: request.temperature ?? LEGACY_CHAT_TEMPERATURE_DIGEST_DEFAULT }
      : {},
    // Derived from the request CONTENT, never from a clock or a counter. That
    // is what makes it survive a lost response: the retry inside
    // `requestJsonWithRetry` re-sends the identical `Idempotency-Key`, and a
    // whole new process computing it from the same request lands on the same
    // string, so GenStudio replays the running job instead of charging twice.
    idempotencyKey: request.idempotencyKey?.trim() || buildGenStudioChatIdempotencyKey(request),
    transport: resolveGenStudioChatTransport(request.transport),
  }
}

/** The diagnostic fields both routes record, minus the route-specific ones. */
function chatPreviewFields(
  request: GenStudioChatRequest,
  prepared: PreparedChatSubmission,
): Array<[string, unknown]> {
  return [
    // Diagnostics must describe what was SENT. A product that does not publish
    // `temperature` shows the field as absent, not as a number nobody sent.
    ...Object.entries(prepared.samplingFields) as Array<[string, unknown]>,
    ['system_instruction', prepared.messages.some(message => message.role === 'system')],
    ['output_contract', prepared.outputContract.mode],
    ['structured_output_mode', prepared.product.structured_output_mode],
    ...(request.webSearch
      ? [
          ['web_search', true] as [string, unknown],
          ['web_search_max_searches', request.webSearch.max_searches ?? null] as [string, unknown],
          ['web_search_allowed_domains', request.webSearch.allowed_domains.length] as [string, unknown],
          ['web_search_blocked_domains', request.webSearch.blocked_domains.length] as [string, unknown],
        ]
      : []),
  ]
}

/** A durable chat job in the shape the shared evidence recorder expects. */
function chatJobEvidence(job: GenStudioChatJob): GenStudioJob {
  return {
    id: job.id,
    state: job.state,
    model_id: job.model_id,
    ...(job.failure_code ? { failure_code: job.failure_code } : {}),
    ...(job.routing_status_code ? { routing_status_code: job.routing_status_code } : {}),
    ...(Number.isFinite(job.credit_cost) ? { credit_cost: job.credit_cost } : {}),
    ...(Number.isFinite(job.remaining_credits) ? { remaining_credits: job.remaining_credits } : {}),
    ...(job.price_version ? { price_version: job.price_version } : {}),
  }
}

export class GenStudioChatRecoveryUnresolvedError extends Error {
  readonly idempotencyKey: string

  constructor(idempotencyKey: string, cause?: unknown) {
    super(
      `GenStudio KH could not find the earlier language submission for idempotency key ${idempotencyKey}. `
      + 'Story Studio kept its existing request identity and did not submit fresh work. Check GenStudio, then Retry.',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'GenStudioChatRecoveryUnresolvedError'
    this.idempotencyKey = idempotencyKey
  }
}

// A missing record or an ambiguous gateway failure is not enough evidence to
// submit replacement work. Every other HTTP status is actionable GenStudio
// feedback and must remain visible to the caller.
const UNRESOLVED_CHAT_RECOVERY_LOOKUP_STATUSES = [404, 502, 504]

/**
 * Reclaim a durable chat request whose POST response was lost. This endpoint
 * is account-scoped and read-only; missing or unreachable evidence is never
 * permission to make another provider submission.
 */
async function recoverChatByIdempotencyKey(
  apiKey: string,
  idempotencyKey: string,
  request: GenStudioChatRequest,
  prepared: PreparedChatSubmission,
  requestPreview: GenStudioRequestPreview,
): Promise<GenStudioChatResult> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  let initial: GenStudioChatJob
  try {
    initial = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/chat/responses/by-idempotency-key/${encodeURIComponent(idempotencyKey)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
      apiKey,
      GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
      [],
      true,
    ) as GenStudioChatJob
  } catch (error) {
    if (request.isCancelled?.() || request.signal?.aborted) throw error
    if (
      error instanceof GenStudioApiError
      && !UNRESOLVED_CHAT_RECOVERY_LOOKUP_STATUSES.includes(error.status)
    ) throw error
    throw new GenStudioChatRecoveryUnresolvedError(idempotencyKey, error)
  }
  await recordGenStudioEvidence('chat.response', chatJobEvidence(initial), requestPreview)
  await reportQueueState(request, chatJobEvidence(initial))
  await request.onJobAccepted?.(initial.id, idempotencyKey)
  await request.onState?.(initial.state, initial.id)
  if (initial.state === 'failed') {
    await genStudioAdmission.notifyTerminal(apiKey)
    throw new GenStudioChatTerminalFailureError(initial)
  }
  const completed = initial.state === 'succeeded'
    ? initial
    : await waitForChatJob(baseUrl, apiKey, initial, request, deadline)
  return finishChatJob(apiKey, request, prepared, completed)
}

/**
 * Poll one accepted language job to a terminal state.
 *
 * Mirrors `waitForImageJob` / the TTS `waitForJob` deliberately — same poll
 * interval, same `deadline`, same cancellation check, same
 * `recordGenStudioEvidence` + queue-state reporting, so the Jobs page shows a
 * language job exactly the way it already shows every other modality.
 *
 * Terminal is `succeeded | failed` ONLY: unlike image/TTS/transcription this
 * route publishes no `cancelled` flag and no cancel endpoint, so a local
 * cancellation stops POLLING and says so rather than pretending it stopped the
 * job. The job stays GenStudio-owned and reconnectable by id.
 */
async function waitForChatJob(
  baseUrl: string,
  apiKey: string,
  job: GenStudioChatJob,
  request: GenStudioChatRequest,
  deadline: number,
): Promise<GenStudioChatJob> {
  let current = job
  let reportedState: string | null = null
  let reportedRoutingState: string | null = null
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || null
    if (reportedState === current.state && reportedRoutingState === routingState) return
    reportedState = current.state
    reportedRoutingState = routingState
    await recordGenStudioEvidence('chat.response', chatJobEvidence(current))
    await reportQueueState(request, chatJobEvidence(current))
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!isTerminalGenStudioJobState(current.state)) {
    if (request.isCancelled?.() || request.signal?.aborted) {
      await request.onQueueState?.('cancelled', current.id)
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) {
      // A slow job can never hang a pipeline step forever: the deadline is set
      // once at submission from GENSTUDIO_LONG_JOB_TIMEOUT_MS and every poll,
      // retry and backoff inside this loop is bounded by it.
      throw new Error('GenStudio KH language job timed out while waiting for completion')
    }
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/chat/responses/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioChatJob
    await reportState()
  }
  await genStudioAdmission.notifyTerminal(apiKey)
  if (current.state === 'failed') throw new GenStudioChatTerminalFailureError(current)
  return current
}

/**
 * Reconnect to an already accepted language job. NEVER submits new work.
 *
 * This is the whole point of the durable route: a dropped connection reclaims
 * the job the account has already paid to start instead of buying a second one.
 */
async function recoverChatJobAdmitted(
  apiKey: string,
  jobId: string,
  request: GenStudioChatRequest,
): Promise<GenStudioChatJob> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const initial = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/chat/responses/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
  ) as GenStudioChatJob
  // Classify BEFORE polling: a job that already failed cannot become output,
  // and a poll loop would only re-read the same terminal record.
  if (initial.state === 'failed') {
    await recordGenStudioEvidence('chat.response', chatJobEvidence(initial))
    await reportQueueState(request, chatJobEvidence(initial))
    await request.onState?.(initial.state, initial.id)
    await genStudioAdmission.notifyTerminal(apiKey)
    throw new GenStudioChatTerminalFailureError(initial)
  }
  return waitForChatJob(baseUrl, apiKey, initial, request, deadline)
}

export async function recoverChatWithGenStudio(
  apiKey: string,
  jobId: string,
  request: GenStudioChatRequest,
): Promise<GenStudioChatResult> {
  const prepared = await prepareChatSubmission(apiKey, request)
  const completed = await recoverChatJobAdmitted(apiKey, jobId, request)
  return finishChatJob(apiKey, request, prepared, completed)
}

/** Validate a settled language job and shape the caller's result. */
async function finishChatJob(
  apiKey: string,
  request: GenStudioChatRequest,
  prepared: PreparedChatSubmission,
  completed: GenStudioChatJob,
): Promise<GenStudioChatResult> {
  let parsed: ReturnType<typeof parseLanguageOutput>
  try {
    parsed = parseLanguageOutput(completed, prepared.outputContract)
  } catch (error) {
    // The job is settled either way, so the account slot is free: release it
    // before rejecting the payload, or a run of unusable outputs (truncation,
    // a contract violation) silently starves the admission pool.
    await request.onQueueState?.('failed', completed.id)
    await genStudioAdmission.notifyTerminal(apiKey)
    throw error
  }
  const result: GenStudioChatResult = {
    ...parsed,
    citations: request.webSearch ? parseGenStudioCitations(completed.citations) : [],
    webSearch: request.webSearch ? readWebSearchUsage(completed) : EMPTY_WEB_SEARCH_USAGE,
  }
  await request.onQueueState?.('succeeded', result.jobId)
  await genStudioAdmission.notifyTerminal(apiKey)
  return result
}

/**
 * Submit one durable language job and poll it to a validated result.
 *
 * The durable twin of every other modality: submit through the admission pool,
 * record evidence, hand the caller the accepted job id, then poll — and on a
 * lost connection RECONNECT to the same job rather than submit a second one.
 */
async function callChatViaResponses(
  apiKey: string,
  request: GenStudioChatRequest,
  prepared: PreparedChatSubmission,
): Promise<GenStudioChatResult> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  // Written BEFORE the POST: a submission whose response never arrives still
  // leaves its idempotency key on the Story job's evidence entry (under
  // `pending:<key>`), so the run that reattaches can prove which key was in
  // flight instead of minting a new one and paying twice.
  const requestPreview = await recordGenStudioRequestPreview('chat.response', {
    method: 'POST',
    path: '/v1/chat/responses',
    modelId: prepared.modelId,
    responseFormat: prepared.responseFormat,
    tokenLimits: { max_output_tokens: prepared.maxOutputTokens },
    idempotencyKey: prepared.idempotencyKey,
    messages: prepared.messages,
    fields: chatPreviewFields(request, prepared),
  })
  if (request.recoverByIdempotencyKey) {
    if (request.allowedRecoveryKeys?.length && !request.allowedRecoveryKeys.includes(prepared.idempotencyKey)) {
      throw new GenStudioChatRecoveryUnresolvedError(prepared.idempotencyKey)
    }
    return recoverChatByIdempotencyKey(apiKey, prepared.idempotencyKey, request, prepared, requestPreview)
  }
  let submitted: GenStudioChatJob
  try {
    submitted = await submitLanguageJson(
      apiKey,
      `${apiBase(baseUrl)}/v1/chat/responses`,
      {
        method: 'POST',
        headers: {
          ...authorization(apiKey),
          'Content-Type': 'application/json',
          // Required by the route (8..128 characters). Computed once, above, and
          // reused verbatim by every network retry of this submission.
          'Idempotency-Key': prepared.idempotencyKey,
        },
        body: JSON.stringify({
          // `ChatResponseRequest` field names — NOT the OpenAI-compatible ones.
          model_id: prepared.modelId,
          input: prepared.messages,
          response_format: prepared.responseFormat,
          // Only the sampling fields this product publishes. Never `top_p`.
          ...prepared.samplingFields,
          max_output_tokens: prepared.maxOutputTokens,
          // Present only for a deliberate web-search request. `web_search` is
          // available on this route too, so web research is durable as well.
          ...(request.webSearch ? { web_search: request.webSearch } : {}),
        }),
      },
      request,
      deadline,
    ) as GenStudioChatJob
  } catch (error) {
    if (request.isCancelled?.() || request.signal?.aborted) throw error
    // A coded uncertain submission is a terminal safety result, not an
    // unlabelled gateway failure. GenStudio explicitly stopped rather than
    // risk a second provider charge, so no lookup or replacement may follow.
    if (isGenStudioSubmissionUncertain(error)) throw error
    // Only GenStudio's documented ambiguous submission outcomes (502/504),
    // plus a transport error with no HTTP response, can be reconciled through
    // the read-only lookup. Auth, credit, validation, rate, release-disabled
    // 503, and other explicit API failures remain directly actionable.
    if (
      error instanceof GenStudioApiError
      && error.status !== 502
      && error.status !== 504
    ) throw error
    return recoverChatByIdempotencyKey(apiKey, prepared.idempotencyKey, request, prepared, requestPreview)
  }
  await recordGenStudioEvidence('chat.response', chatJobEvidence(submitted), requestPreview)
  await reportQueueState(request, chatJobEvidence(submitted))
  await request.onJobAccepted?.(submitted.id, prepared.idempotencyKey)
  let completed: GenStudioChatJob
  try {
    completed = await waitForChatJob(baseUrl, apiKey, submitted, request, deadline)
  } catch (error) {
    // `shouldReconnectAcceptedTask` refuses to reconnect a settled outcome AND
    // refuses `LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN` specifically — a second
    // submission is exactly the duplicate charge GenStudio declined to risk.
    if (!shouldReconnectAcceptedTask(error, request)) throw error
    await request.onReconnect?.(submitted.id, error instanceof Error ? error.message : String(error))
    completed = await recoverChatJobAdmitted(apiKey, submitted.id, request)
  }
  return finishChatJob(apiKey, request, prepared, completed)
}

/**
 * ROLLBACK ROUTE — the original synchronous `POST /v1/chat/completions`.
 *
 * Kept reachable and unchanged on purpose. It cannot distinguish
 * `LANGUAGE_PROVIDER_FAILED` from `LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN`
 * unless GenStudio happens to name the code in the error body, because a
 * synchronous failure arrives as a bare 502 with no `failure_code`.
 */
async function callChatViaCompletions(
  apiKey: string,
  request: GenStudioChatRequest,
  prepared: PreparedChatSubmission,
): Promise<GenStudioChatResult> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const requestPreview = await recordGenStudioRequestPreview('chat.response', {
    method: 'POST',
    path: '/v1/chat/completions',
    modelId: prepared.modelId,
    responseFormat: prepared.responseFormat,
    tokenLimits: { max_completion_tokens: prepared.maxOutputTokens },
    idempotencyKey: prepared.idempotencyKey,
    messages: prepared.messages,
    fields: [['stream', false], ...chatPreviewFields(request, prepared)],
  })
  const completion = await submitLanguageJson(
    apiKey,
    `${apiBase(baseUrl)}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': prepared.idempotencyKey,
      },
      body: JSON.stringify({
        model: prepared.modelId,
        messages: prepared.messages,
        response_format: prepared.responseFormat,
        stream: false,
        // Only the sampling fields this product publishes. Never `top_p`.
        ...prepared.samplingFields,
        max_completion_tokens: prepared.maxOutputTokens,
        ...(request.webSearch ? { web_search: request.webSearch } : {}),
      }),
    },
    request,
    deadline,
  ) as GenStudioChatCompletion
  // The exchange is over the moment the response lands: whatever the envelope
  // turns out to say, this account's in-flight slot is free. Release it before
  // inspecting the payload, or a run of rejected envelopes (truncated output,
  // an unusable body, a contract violation) silently starves the admission
  // pool until it times out.
  let parsed: ReturnType<typeof parseProductCompletion>
  try {
    parsed = parseProductCompletion(completion, prepared.outputContract)
  } catch (error) {
    await request.onState?.('failed', completion.id)
    await request.onQueueState?.('failed', completion.id)
    await genStudioAdmission.notifyTerminal(apiKey)
    throw error
  }
  const result: GenStudioChatResult = {
    ...parsed,
    citations: request.webSearch ? parseGenStudioCitations(completion.citations) : [],
    webSearch: request.webSearch
      ? readWebSearchUsage(completion)
      : EMPTY_WEB_SEARCH_USAGE,
  }
  const evidence: GenStudioJob = {
    id: result.jobId,
    state: 'succeeded',
    model_id: result.modelId,
  }
  await recordGenStudioEvidence('chat.response', evidence, requestPreview)
  await request.onJobAccepted?.(result.jobId, prepared.idempotencyKey)
  await request.onState?.('succeeded', result.jobId)
  await request.onQueueState?.('succeeded', result.jobId)
  await genStudioAdmission.notifyTerminal(apiKey)
  return result
}

/**
 * Execute one exact published language product through GenStudio's product API.
 *
 * The guards run FIRST and identically for both routes; the transport decision
 * is made ONCE, here, and nowhere else in the app.
 */
async function callChatWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioChatRequest,
): Promise<GenStudioChatResult> {
  const prepared = await prepareChatSubmission(apiKey, request)
  return prepared.transport === 'completions'
    ? callChatViaCompletions(apiKey, request, prepared)
    : callChatViaResponses(apiKey, request, prepared)
}

export async function callChatWithGenStudio(
  apiKey: string,
  request: GenStudioChatRequest,
): Promise<GenStudioChatResult> {
  return callChatWithGenStudioAdmitted(apiKey, request)
}

/** Upload a locally stored Story Studio reference as a private GenStudio asset. */
export async function uploadImageSourceWithGenStudio(
  apiKey: string,
  sourceImagePath: string,
): Promise<GenStudioImageSourceAsset> {
  const bytes = await fs.readFile(sourceImagePath)
  if (!bytes.length) throw new Error('Thumbnail reference image is empty.')
  const type = videoSourceMediaType(sourceImagePath)
  if (!type.startsWith('image/')) throw new Error('Thumbnail reference must be a PNG, JPEG, WebP, or GIF image.')
  const body = new FormData()
  body.set('upload', new Blob([new Uint8Array(bytes)], { type }), path.basename(sourceImagePath))
  const baseUrl = await getGenStudioUrl()
  const response = await fetch(`${apiBase(baseUrl)}/v1/images/source-images`, {
    method: 'POST', headers: authorization(apiKey), body, signal: AbortSignal.timeout(GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS),
  })
  const value = await readJson(response)
  if (!value || typeof value.id !== 'string') throw new Error('GenStudio KH did not return a private reference asset id.')
  return {
    id: value.id, media_type: typeof value.media_type === 'string' ? value.media_type : type,
    byte_size: Number.isInteger(value.byte_size) ? value.byte_size : bytes.length,
    width: Number.isInteger(value.width) ? value.width : 0,
    height: Number.isInteger(value.height) ? value.height : 0,
    expires_at: typeof value.expires_at === 'string' ? value.expires_at : '',
  }
}

/** Fetch the account-visible transcription catalog from the GenStudio boundary. */
export async function listTranscriptionModelsSnapshot(
  apiKey: string,
): Promise<GenStudioCatalogSnapshot<GenStudioTranscriptionModel[]>> {
  const baseUrl = await getGenStudioUrl()
  const key = catalogCacheKey('transcription', baseUrl, apiKey)
  return cachedCatalogSnapshot('transcription', key, async () => {
    const payload = await fetchCatalogJson(`${apiBase(baseUrl)}/v1/transcription/models`, apiKey)
    if (!Array.isArray(payload)) {
      throw new Error('GenStudio KH returned an invalid transcription model catalog')
    }
    return payload.map((value: any) => ({
      id: typeof value?.id === 'string' ? value.id.trim() : '',
      display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
      // Provider transparency means pass through what GenStudio publishes.
      // An absent provider is unknown, never the gateway name.
      provider: typeof value?.provider === 'string' ? value.provider.trim() : '',
      // NOT defaulted to 'multilingual': an absent field is missing data, and
      // collapsing it into a sentinel makes a gap look like a published fact.
      language: typeof value?.language === 'string' ? value.language.trim() : '',
      supported_languages: Array.isArray(value?.supported_languages)
        ? value.supported_languages
          .filter((code: unknown): code is string => typeof code === 'string' && !!code.trim())
          .map((code: string) => code.trim())
        : [],
      supports_language_auto_detect: typeof value?.supports_language_auto_detect === 'boolean'
        ? value.supports_language_auto_detect
        : null,
      available: value?.available === true,
      available_workers: Number.isInteger(value?.available_workers)
        ? Math.max(0, value.available_workers)
        : 0,
      qualification_only: value?.qualification_only !== false,
      // GenStudio publishes a per-SECOND rate. Reading `credits_per_minute`
      // here (a field it does not publish) made every model parse as 0.
      credits_per_second: Number.isFinite(value?.credits_per_second)
        ? Math.max(0, value.credits_per_second)
        : 0,
      minimum_credits: Number.isFinite(value?.minimum_credits)
        ? Math.max(0, value.minimum_credits)
        : 0,
      price_version: typeof value?.price_version === 'string' ? value.price_version.trim() : '',
    })).filter((model: GenStudioTranscriptionModel) => model.id && model.display_name)
  })
}

export async function listTranscriptionModels(
  apiKey: string,
): Promise<GenStudioTranscriptionModel[]> {
  return (await listTranscriptionModelsSnapshot(apiKey)).value
}

/**
 * Optional-field readers for the image catalogue.
 *
 * Each returns `undefined` — never a stand-in value — when GenStudio published
 * nothing usable, so "absent" survives the trip to every consumer intact.
 */
function publishedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function publishedFlag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function publishedPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined
}

function publishedCredits(value: unknown): number | undefined {
  return Number.isFinite(value) && (value as number) >= 0 ? value as number : undefined
}

/** Fetch the account-visible image catalog owned by GenStudio. */
export async function listImageModelsSnapshot(
  apiKey: string,
): Promise<GenStudioCatalogSnapshot<GenStudioImageModel[]>> {
  const baseUrl = await getGenStudioUrl()
  const key = catalogCacheKey('image', baseUrl, apiKey)
  return cachedCatalogSnapshot('image', key, async () => {
    const payload = await fetchCatalogJson(`${apiBase(baseUrl)}/v1/image/models`, apiKey)
    if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid image model catalog')
    return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    provider_name: publishedText(value?.provider_name),
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    available: value?.available === true,
    qualification_only: value?.qualification_only !== false,
    execution_label: typeof value?.execution_label === 'string' ? value.execution_label.trim() : undefined,
    credits_per_image: Number.isFinite(value?.credits_per_image)
      ? Math.max(0, value.credits_per_image)
      : null,
    minimum_credits: Number.isFinite(value?.minimum_credits)
      ? Math.max(0, value.minimum_credits)
      : null,
    price_version: typeof value?.price_version === 'string' ? value.price_version.trim() : null,
    base_credits_per_image: Number.isFinite(value?.base_credits_per_image)
      ? Math.max(0, value.base_credits_per_image)
      : null,
    promotion_name: publishedText(value?.promotion_name),
    promotion_discount_percent: Number.isFinite(value?.promotion_discount_percent)
      ? value.promotion_discount_percent
      : undefined,
    availability_note: publishedText(value?.availability_note),
    chargeable: value?.chargeable === true,
    aspect_ratios: Array.isArray(value?.aspect_ratios)
      ? value.aspect_ratios.filter((ratio: unknown): ratio is string => typeof ratio === 'string' && !!ratio.trim())
      : [],
    default_aspect_ratio: typeof value?.default_aspect_ratio === 'string'
      ? value.default_aspect_ratio.trim()
      : '16:9',
    default_resolution: publishedText(value?.default_resolution),
    // Carried through the transport for the resolution surface. Rows missing
    // any part of the pair are dropped rather than patched, so a half-published
    // option can never be offered — or charged for — as if it were valid.
    output_options: Array.isArray(value?.output_options)
      ? value.output_options.filter((option: any) => (
          typeof option?.resolution === 'string' && option.resolution.trim().length > 0
          && typeof option?.aspect_ratio === 'string' && option.aspect_ratio.trim().length > 0
          && Number.isInteger(option?.width) && option.width > 0
          && Number.isInteger(option?.height) && option.height > 0
        )).map((option: any): GenStudioImageOutputOption => ({
          resolution: option.resolution.trim(),
          aspect_ratio: option.aspect_ratio.trim(),
          width: option.width,
          height: option.height,
          is_default: option.is_default === true,
          credits_per_image: publishedCredits(option?.credits_per_image),
          base_credits_per_image: publishedCredits(option?.base_credits_per_image),
          price_version: publishedText(option?.price_version),
          reference_generation_credits: publishedCredits(option?.reference_generation_credits),
          reference_generation_price_version: publishedText(option?.reference_generation_price_version),
        }))
      : undefined,
    supports_reference_images: value?.supports_reference_images === true,
    supports_image_to_image: publishedFlag(value?.supports_image_to_image),
    supports_seed: publishedFlag(value?.supports_seed),
    min_reference_images: Number.isInteger(value?.min_reference_images) && value.min_reference_images >= 0
      ? value.min_reference_images
      : undefined,
    max_reference_images: Number.isInteger(value?.max_reference_images) ? Math.max(0, value.max_reference_images) : 0,
    reference_image_max_dimension: publishedPositiveInteger(value?.reference_image_max_dimension),
    reference_generation_credits: publishedCredits(value?.reference_generation_credits),
    reference_generation_price_version: publishedText(value?.reference_generation_price_version),
    reference_strength_mode: typeof value?.reference_strength_mode === 'string' ? value.reference_strength_mode : 'none',
    supported_reference_strengths: Array.isArray(value?.supported_reference_strengths)
      ? value.supported_reference_strengths.filter((item: unknown): item is string => typeof item === 'string') : [],
    max_prompt_characters: publishedPositiveInteger(value?.max_prompt_characters),
    // Kept in its published unit. A token budget is never divided by a fixed
    // ratio to manufacture a character cap — that is what `max_prompt_characters`
    // is for, and Khmer script would be mis-capped by any such conversion.
    prompt_token_allowance: publishedPositiveInteger(value?.prompt_token_allowance),
    operations: Array.isArray(value?.operations)
      ? value.operations.filter((item: unknown): item is string => typeof item === 'string' && !!item.trim())
      : undefined,
    })).filter((model: GenStudioImageModel) => model.id && model.display_name)
  })
}

export async function listImageModels(apiKey: string): Promise<GenStudioImageModel[]> {
  return (await listImageModelsSnapshot(apiKey)).value
}

/**
 * Stable per-submission key GenStudio dedupes charged image jobs on.
 *
 * `steps` is FROZEN into the digest at its historical value and is not a
 * parameter. Every image request this app has ever sent carried
 * `steps: LEGACY_IMAGE_STEPS_DIGEST_COMPONENT` — the provider path always used
 * the catalogue mapper's fallback (GenStudio publishes no step contract), and
 * the style-preview path always used that same fallback. Keeping the component
 * frozen makes every key computed after the field's removal byte-identical to
 * the one computed before it, so a retry that crosses this upgrade boundary
 * still replays the in-flight job instead of submitting — and billing — a
 * second one. Dropping it from the digest would have changed every key.
 */
const LEGACY_IMAGE_STEPS_DIGEST_COMPONENT = 4

export function buildGenStudioImageIdempotencyKey(input: {
  prompt: string
  modelId: string
  aspectRatio: string
  resolution?: string
  width?: number
  height?: number
  seed?: number
  requestIdentity?: string
  referenceAssetIds?: string[]
}): string {
  const hasDimensions = Number.isInteger(input.width) && input.width! > 0
    && Number.isInteger(input.height) && input.height! > 0
  // `resolution` is a NEW request field, so it joins the digest the way
  // `output_budget` joined the chat digest: emitted ONLY when the caller
  // actually chose one. Two resolutions of the same ratio are different work
  // at different prices and must not share a replay key, but a caller that
  // names none produces the exact JSON this digest produced before the field
  // existed — so a retry crossing this upgrade replays the in-flight job
  // instead of submitting, and billing, a second one. Same reasoning as
  // `LEGACY_IMAGE_STEPS_DIGEST_COMPONENT`.
  const resolution = (input.resolution || '').trim()
  const digest = createHash('sha256').update(JSON.stringify({
    prompt: input.prompt.trim(),
    model_id: input.modelId.trim(),
    aspect_ratio: input.aspectRatio,
    steps: LEGACY_IMAGE_STEPS_DIGEST_COMPONENT,
    width: hasDimensions ? input.width : null,
    height: hasDimensions ? input.height : null,
    seed: input.seed ?? null,
    request_identity: input.requestIdentity || null,
    reference_asset_ids: input.referenceAssetIds || [],
    ...(resolution ? { resolution } : {}),
  })).digest('hex')
  return `story-image-${digest.slice(0, 44)}`
}

async function waitForImageJob(
  baseUrl: string,
  apiKey: string,
  submitted: GenStudioImageJob,
  request: GenStudioOperationContext & { onState?: (state: GenStudioJob['state']) => void },
  deadline: number,
): Promise<GenStudioImageJob> {
  let current = submitted
  await recordGenStudioEvidence('image.generation', current)
  await reportQueueState(request, current)
  request.onState?.(current.state)
  const poller = createGenStudioJobPoller()
  while (!isSettledGenStudioJob(current)) {
    await submitQueuedRemoteCancellation('image.generation', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) {
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) throw new Error('GenStudio KH image job timed out while waiting for completion')
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/images/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioImageJob
    await recordGenStudioEvidence('image.generation', current)
    await reportQueueState(request, current)
    request.onState?.(current.state)
  }
  await genStudioAdmission.notifyTerminal(apiKey)
  if (current.state === 'failed' || current.cancelled === true) {
    throw new GenStudioImageTerminalFailureError(current)
  }
  return current
}

async function downloadImageArtifact(
  baseUrl: string,
  apiKey: string,
  completed: GenStudioImageJob,
  request: GenStudioOperationContext,
  deadline: number,
): Promise<string> {
  if (!completed.image_url) {
    throw new GenStudioImageArtifactUnavailableError(completed.id, 0, 'the job completed without a download URL')
  }
  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(requestUrl(baseUrl, completed.image_url), {
        headers: authorization(apiKey),
        signal: operationSignal(request.signal, deadline, GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        // A gone artifact is terminal: replaying the idempotency key returns
        // the same settled job with the same missing bytes.
        if (response.status === 404 || response.status === 410) {
          throw new GenStudioImageArtifactUnavailableError(completed.id, response.status)
        }
        const error = new Error(`GenStudio KH image download failed (HTTP ${response.status})`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length < 24 || bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
          throw new Error('GenStudio KH returned an invalid PNG artifact')
        }
        return `data:image/png;base64,${bytes.toString('base64')}`
      }
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      if (error instanceof GenStudioImageArtifactUnavailableError) throw error
      lastError = error
      if (error instanceof Error && !/HTTP (408|425|429|5\d\d)/.test(error.message)
        && !error.message.includes('fetch failed')) throw error
    }
    if (attempt < NETWORK_RETRY_ATTEMPTS) await retryDelay(attempt, request, deadline)
  }
  throw lastError instanceof Error ? lastError : new Error('GenStudio KH image download failed')
}

/** Reconnect to an already accepted image task. Never submits new work. */
async function recoverImageWithGenStudioAdmitted(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & { onState?: (state: GenStudioJob['state']) => void } = {},
): Promise<{ url: string; jobId: string; modelId: string }> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const initial = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/images/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
  ) as GenStudioImageJob
  // Classify BEFORE polling. A job that already failed (or was cancelled)
  // cannot become an artifact, and a poll loop would only re-read the same
  // terminal record; a job that already succeeded needs its bytes, not a poll.
  if (initial.state === 'failed' || initial.cancelled === true) {
    await recordGenStudioEvidence('image.generation', initial)
    await reportQueueState(request, initial)
    request.onState?.(initial.state)
    throw new GenStudioImageTerminalFailureError(initial)
  }
  const completed = initial.state === 'succeeded'
    ? initial
    : await waitForImageJob(baseUrl, apiKey, initial, request, deadline)
  if (completed === initial) {
    await recordGenStudioEvidence('image.generation', initial)
    await reportQueueState(request, initial)
    request.onState?.(initial.state)
  }
  const url = await downloadImageArtifact(baseUrl, apiKey, completed, request, deadline)
  return { url, jobId: completed.id, modelId: completed.model_id }
}

export async function recoverImageWithGenStudio(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & { onState?: (state: GenStudioJob['state']) => void } = {},
): Promise<{ url: string; jobId: string; modelId: string }> {
  return recoverImageWithGenStudioAdmitted(apiKey, jobId, request)
}

/** Submit one durable GenStudio image task and return its verified private PNG. */
async function generateImageWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioImageRequest,
): Promise<{ url: string; jobId: string; modelId: string }> {
  const prompt = request.prompt.trim()
  const modelId = request.modelId.trim()
  // Bounds published on `ImageGenerationRequest.prompt` itself. The per-model
  // ceiling is `max_prompt_characters` and is enforced against the selected
  // model before this point — this check must never sit below it, or a prompt
  // GenStudio publishes as acceptable would be refused by an invented limit.
  if (prompt.length < 3 || prompt.length > 32_000) {
    throw new Error('GenStudio KH image prompts must contain 3 to 32,000 characters.')
  }
  if (!modelId) throw new Error('Select a GenStudio KH image model.')
  const hasDimensions = Number.isInteger(request.width) && request.width! > 0
    && Number.isInteger(request.height) && request.height! > 0
  // Sent only when the caller resolved one from the model's published
  // `output_options[]`. GenStudio applies its own `default_resolution` when the
  // field is absent, which is exactly the right behaviour for a model that
  // publishes no output options at all.
  const resolution = (request.resolution || '').trim()
  const body = {
    prompt,
    model_id: modelId,
    aspect_ratio: request.aspectRatio,
    ...(resolution ? { resolution } : {}),
    ...(hasDimensions
      ? { width: request.width, height: request.height }
      : {}),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.referenceAssetIds?.length ? { reference_asset_ids: request.referenceAssetIds } : {}),
  }
  const idempotencyKey = request.idempotencyKey?.trim() || buildGenStudioImageIdempotencyKey({
    prompt,
    modelId,
    aspectRatio: request.aspectRatio,
    resolution,
    width: request.width,
    height: request.height,
    seed: request.seed,
    requestIdentity: request.requestIdentity,
    referenceAssetIds: request.referenceAssetIds,
  })
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const requestPreview = await recordGenStudioRequestPreview('image.generation', {
    method: 'POST',
    path: '/v1/images/generations',
    modelId,
    idempotencyKey,
    messages: [{ role: 'prompt', content: prompt }],
    fields: [
      ['aspect_ratio', request.aspectRatio],
      ['resolution', resolution || undefined],
      ['width', hasDimensions ? request.width : undefined],
      ['height', hasDimensions ? request.height : undefined],
      ['seed', request.seed],
      ['reference_asset_ids', request.referenceAssetIds?.length ? request.referenceAssetIds : undefined],
    ],
  })
  const submitted = await submitJsonWithAdmission(
    apiKey,
    `${apiBase(baseUrl)}/v1/images/generations`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    request,
    deadline,
  ) as GenStudioImageJob
  await recordGenStudioEvidence('image.generation', submitted, requestPreview)
  await reportQueueState(request, submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  try {
    const completed = await waitForImageJob(baseUrl, apiKey, submitted, request, deadline)
    const url = await downloadImageArtifact(baseUrl, apiKey, completed, request, deadline)
    return { url, jobId: completed.id, modelId: completed.model_id }
  } catch (error) {
    if (!shouldReconnectAcceptedTask(error, request)) throw error
    await request.onReconnect?.(submitted.id, error instanceof Error ? error.message : String(error))
    return recoverImageWithGenStudioAdmitted(apiKey, submitted.id, request)
  }
}

export async function generateImageWithGenStudio(
  apiKey: string,
  request: GenStudioImageRequest,
): Promise<{ url: string; jobId: string; modelId: string }> {
  return generateImageWithGenStudioAdmitted(apiKey, request)
}

function transcriptionMediaType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.wav': return 'audio/wav'
    case '.mp3': return 'audio/mpeg'
    case '.m4a': return 'audio/mp4'
    case '.aac': return 'audio/aac'
    case '.flac': return 'audio/flac'
    case '.ogg': return 'audio/ogg'
    case '.opus': return 'audio/opus'
    case '.webm': return 'audio/webm'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    default: return 'application/octet-stream'
  }
}

/**
 * Statuses that mean this quote can never be confirmed: it is gone, already
 * settled, or no longer valid for this account. 402/429/5xx are deliberately
 * excluded — those are retryable and must not retire a paid identity.
 */
function isTerminalQuoteStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 409 || status === 410 || status === 422
}

export function buildGenStudioTranscriptionIdempotencyKey(input: {
  requestIdentity: string
  fileSha256: string
  modelId: string
  language?: string
  wordTimestamps?: boolean
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    request_identity: input.requestIdentity,
    file_sha256: input.fileSha256,
    model_id: input.modelId,
    language: input.language || null,
    word_timestamps: input.wordTimestamps === true,
  })).digest('hex')
  return `story-stt-${digest.slice(0, 48)}`
}

async function waitForTranscriptionJob(
  baseUrl: string,
  apiKey: string,
  submitted: GenStudioTranscriptionJob,
  request: GenStudioOperationContext & {
    onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
  },
  deadline: number,
): Promise<GenStudioTranscriptionJob> {
  let current = submitted
  let reportedState: string | null = null
  let reportedRoutingState: string | null = null
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || null
    if (reportedState === current.state && reportedRoutingState === routingState) return
    reportedState = current.state
    reportedRoutingState = routingState
    await recordGenStudioEvidence('audio.transcription', current)
    await reportQueueState(request, current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!isSettledGenStudioJob(current)) {
    await submitQueuedRemoteCancellation('audio.transcription', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) {
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) {
      throw new Error('GenStudio KH transcription timed out while waiting for completion')
    }
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/transcriptions/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioTranscriptionJob
    await reportState()
  }
  await genStudioAdmission.notifyTerminal(apiKey)
  if (current.state === 'failed' || current.cancelled === true) {
    throw new GenStudioTranscriptionTerminalFailureError(current)
  }
  return current
}

async function downloadTranscriptionArtifact(
  baseUrl: string,
  apiKey: string,
  completed: GenStudioTranscriptionJob,
  request: GenStudioOperationContext,
  deadline: number,
): Promise<string> {
  if (!completed.srt_url) {
    throw new GenStudioTranscriptionArtifactUnavailableError(
      completed.id, 0, 'the job completed without a download URL',
    )
  }
  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(requestUrl(baseUrl, completed.srt_url), {
        headers: authorization(apiKey),
        signal: operationSignal(request.signal, deadline, GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        // A gone artifact is terminal: replaying the idempotency key returns
        // the same settled job with the same missing bytes.
        if (response.status === 404 || response.status === 410) {
          throw new GenStudioTranscriptionArtifactUnavailableError(completed.id, response.status)
        }
        const error = new Error(`GenStudio KH SRT download failed (HTTP ${response.status})`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        const srt = await response.text()
        if (!srt.trim()) throw new Error('GenStudio KH returned an empty SRT artifact')
        return srt
      }
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      if (error instanceof GenStudioArtifactUnavailableError) throw error
      lastError = error
      if (error instanceof Error && !/HTTP (408|425|429|5\d\d)/.test(error.message)
        && !error.message.includes('fetch failed')) throw error
    }
    if (attempt < NETWORK_RETRY_ATTEMPTS) await retryDelay(attempt, request, deadline)
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('GenStudio KH SRT download failed after reconnect attempts')
}

/** Reconnect to an already accepted transcription. Never submits new work. */
async function recoverTranscriptionWithGenStudioAdmitted(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & {
    onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
  },
): Promise<{ srt: string; jobId: string; modelId: string }> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const initial = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/transcriptions/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
  ) as GenStudioTranscriptionJob
  // Classify BEFORE polling. A job that already failed (or was cancelled)
  // cannot become a transcript, and a poll loop would only re-read the same
  // terminal record — the "reopen a six-day-old failure forever" bug.
  if (initial.state === 'failed' || initial.cancelled === true) {
    await recordGenStudioEvidence('audio.transcription', initial)
    await reportQueueState(request, initial)
    await request.onState?.(initial.state, initial.id)
    throw new GenStudioTranscriptionTerminalFailureError(initial)
  }
  const completed = await waitForTranscriptionJob(baseUrl, apiKey, initial, request, deadline)
  const srt = await downloadTranscriptionArtifact(baseUrl, apiKey, completed, request, deadline)
  return { srt, jobId: completed.id, modelId: completed.model_id }
}

export async function recoverTranscriptionWithGenStudio(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & {
    onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
  },
): Promise<{ srt: string; jobId: string; modelId: string }> {
  return recoverTranscriptionWithGenStudioAdmitted(apiKey, jobId, request)
}

/** Submit private audio to GenStudio, poll its durable job, and return verified SRT text. */
async function transcribeWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioTranscriptionRequest,
): Promise<{ srt: string; jobId: string; modelId: string }> {
  const modelId = request.modelId.trim()
  if (!modelId) throw new Error('Select a GenStudio KH transcription model.')
  if (!request.requestIdentity.trim()) throw new Error('Stable Story Studio transcription asset identity is required.')
  const file = await fs.readFile(request.audioPath)
  if (!file.length) throw new Error('Transcription audio is empty.')
  if (file.length > GENSTUDIO_MAX_TRANSCRIPTION_BYTES) {
    throw new Error('GenStudio KH transcription input exceeds the 100 MiB qualification limit.')
  }
  const fileSha256 = createHash('sha256').update(file).digest('hex')
  const idempotencyKey = request.idempotencyKey?.trim() || buildGenStudioTranscriptionIdempotencyKey({
    requestIdentity: request.requestIdentity,
    fileSha256,
    modelId,
    language: request.language,
    wordTimestamps: request.wordTimestamps,
  })
  const body = new FormData()
  body.set(
    'file',
    new Blob([new Uint8Array(file)], { type: transcriptionMediaType(request.audioPath) }),
    path.basename(request.audioPath),
  )
  body.set('model', modelId)
  if (request.language) body.set('language', request.language)
  body.set('word_timestamps', String(request.wordTimestamps === true))

  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const requestPreview = await recordGenStudioRequestPreview('audio.transcription', {
    method: 'POST',
    path: '/v1/audio/transcriptions/quotes',
    modelId,
    idempotencyKey,
    fields: [
      ['model', modelId],
      ['language', request.language || 'auto'],
      ['word_timestamps', request.wordTimestamps === true],
      ['file', path.basename(request.audioPath)],
      ['file_bytes', file.length],
    ],
  })
  // A quote carries `expires_at`. When a saved idempotency key outlives its
  // quote, the quote/confirm exchange fails permanently — surface that as a
  // typed outcome so the caller retires the key instead of matching wording.
  const quote = await submitJsonWithAdmission(
    apiKey,
    `${apiBase(baseUrl)}/v1/audio/transcriptions/quotes`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Idempotency-Key': idempotencyKey,
      },
      body,
    },
    request,
    deadline,
  ).catch((error: unknown) => {
    if (error instanceof GenStudioApiError && isTerminalQuoteStatus(error.status)) {
      throw new GenStudioTranscriptionQuoteExpiredError(error.status, error.detail)
    }
    throw error
  }) as { id?: string }
  if (!quote.id) throw new Error('GenStudio KH transcription quote returned no quote id.')
  const confirmIdempotencyKey = `${idempotencyKey}-confirm`
  const submitted = await submitJsonWithAdmission(
    apiKey,
    `${apiBase(baseUrl)}/v1/audio/transcriptions/quotes/${encodeURIComponent(quote.id)}/confirm`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Idempotency-Key': confirmIdempotencyKey,
      },
    },
    request,
    deadline,
  ).catch((error: unknown) => {
    if (error instanceof GenStudioApiError && isTerminalQuoteStatus(error.status)) {
      throw new GenStudioTranscriptionQuoteExpiredError(error.status, error.detail)
    }
    throw error
  }) as GenStudioTranscriptionJob
  await recordGenStudioEvidence('audio.transcription', submitted, requestPreview)
  await reportQueueState(request, submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey, fileSha256)
  try {
    const completed = await waitForTranscriptionJob(baseUrl, apiKey, submitted, request, deadline)
    const srt = await downloadTranscriptionArtifact(baseUrl, apiKey, completed, request, deadline)
    return { srt, jobId: completed.id, modelId: completed.model_id }
  } catch (error) {
    if (!shouldReconnectAcceptedTask(error, request)) throw error
    await request.onReconnect?.(submitted.id, error instanceof Error ? error.message : String(error))
    return recoverTranscriptionWithGenStudioAdmitted(apiKey, submitted.id, request)
  }
}

export async function transcribeWithGenStudio(
  apiKey: string,
  request: GenStudioTranscriptionRequest,
): Promise<{ srt: string; jobId: string; modelId: string }> {
  return transcribeWithGenStudioAdmitted(apiKey, request)
}

async function waitForJob(
  baseUrl: string,
  apiKey: string,
  job: GenStudioJob,
  request: GenStudioTtsRequest,
  deadline: number,
): Promise<GenStudioJob> {
  let current = job
  let reportedState: string | null = null
  let reportedRoutingState: string | null = null
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || null
    if (reportedState === current.state && reportedRoutingState === routingState) return
    reportedState = current.state
    reportedRoutingState = routingState
    await recordGenStudioEvidence('voice.tts', current)
    await reportQueueState(request, current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!isSettledGenStudioJob(current)) {
    await submitQueuedRemoteCancellation('voice.tts', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) {
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) {
      throw new Error('GenStudio KH TTS job timed out while waiting for completion')
    }
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/jobs/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioJob
    await reportState()
  }
  await genStudioAdmission.notifyTerminal(apiKey)
  if (current.state === 'failed' || current.cancelled === true) {
    throw new GenStudioTtsTerminalFailureError(current)
  }
  return current
}

async function completeTtsJobToFile(
  baseUrl: string,
  apiKey: string,
  outPath: string,
  submitted: GenStudioJob,
  request: GenStudioTtsRequest,
  deadline: number,
): Promise<void> {
  const completed = await waitForJob(baseUrl, apiKey, submitted, request, deadline)
  if (!completed.audio_url) {
    throw new GenStudioTtsArtifactUnavailableError(completed.id, 0, 'the job completed without a download URL')
  }

  const tempPath = path.join(os.tmpdir(), `genstudio-audio-${randomUUID()}.wav`)
  try {
    let downloaded = false
    let downloadError: unknown
    for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS && !downloaded; attempt++) {
      try {
        const audioResponse = await fetch(requestUrl(baseUrl, completed.audio_url), {
          headers: authorization(apiKey),
          signal: operationSignal(request.signal, deadline, GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
        })
        if (!audioResponse.ok) {
          // A gone artifact is terminal: replaying the idempotency key returns
          // the same settled job with the same missing bytes.
          if (audioResponse.status === 404 || audioResponse.status === 410) {
            throw new GenStudioTtsArtifactUnavailableError(completed.id, audioResponse.status)
          }
          const error = new Error(`GenStudio KH audio download failed (HTTP ${audioResponse.status})`)
          if (!retryableStatus(audioResponse.status)) throw error
          downloadError = error
        } else {
          const body = audioResponse.body as ReadableStream<Uint8Array> | null
          if (!body) throw new Error('GenStudio KH audio download returned no body')
          const file = await fs.open(tempPath, 'w')
          let received = 0
          try {
            const reader = body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) {
                await file.write(value)
                received += value.length
                request.onProgress?.(received, Number(audioResponse.headers.get('content-length')) || undefined)
              }
            }
          } finally {
            await file.close()
          }
          downloaded = true
        }
      } catch (error) {
        if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
        if (error instanceof GenStudioArtifactUnavailableError) throw error
        downloadError = error
      }
      if (!downloaded && attempt < NETWORK_RETRY_ATTEMPTS) {
        await fs.rm(tempPath, { force: true }).catch(() => {})
        await retryDelay(attempt, request, deadline)
      }
    }
    if (!downloaded) throw downloadError instanceof Error ? downloadError : new Error('GenStudio KH audio download failed')
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await runFfmpeg(['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-b:a', '192k', outPath])
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

/** Reconnect to an already accepted TTS task. Never submits new work. */
async function recoverTtsToFileAdmitted(
  apiKey: string,
  outPath: string,
  jobId: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const current = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/jobs/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
  ) as GenStudioJob
  await completeTtsJobToFile(baseUrl, apiKey, outPath, current, request, deadline)
}

export async function recoverTtsToFile(
  apiKey: string,
  outPath: string,
  jobId: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  return recoverTtsToFileAdmitted(apiKey, outPath, jobId, request)
}

/** Generate a GenStudio API TTS job, then convert its private WAV response to Story's MP3 contract. */
async function generateTtsToFileAdmitted(
  apiKey: string,
  outPath: string,
  request: GenStudioTtsSubmitRequest,
): Promise<void> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const submission = buildGenStudioSubmission(request)
  const idempotencyKey = request.idempotencyKey?.trim() || submission.idempotencyKey
  // Narration text is deliberately summarised as a character count rather than
  // stored: a single request carries up to the model's published
  // maximum_input_characters, and the operator's question here is
  // "which voice/speed/length went out?".
  const requestPreview = await recordGenStudioRequestPreview('voice.tts', {
    method: 'POST',
    path: '/v1/audio/jobs',
    idempotencyKey,
    fields: [
      // The product first: GenStudio prices speech by model, so "which model?"
      // is the first thing an operator reconciling a charge needs to see.
      ['model_id', submission.body.model_id],
      ['voice_id', submission.body.voice_id],
      ['speed', submission.body.speed],
      ['characters', Array.from(String(submission.body.text ?? '').normalize('NFC')).length],
      // Recorded only when the model published controls, so the operator can
      // see which settings a job went out under. The names are GenStudio's.
      ...(submission.body.controls
        ? Object.entries(submission.body.controls).map(([name, value]) => [`control ${name}`, value] as [string, unknown])
        : []),
    ],
  })
  const submitted = await submitJsonWithAdmission(
    apiKey,
    `${apiBase(baseUrl)}/v1/audio/jobs`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(submission.body),
    },
    request,
    deadline,
  ) as GenStudioJob
  await recordGenStudioEvidence('voice.tts', submitted, requestPreview)
  await reportQueueState(request, submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  try {
    await completeTtsJobToFile(baseUrl, apiKey, outPath, submitted, request, deadline)
  } catch (error) {
    // A settled outcome is never reopened; a lost connection reconnects to the
    // job this submission already paid for instead of submitting another.
    if (!shouldReconnectAcceptedTask(error, request)) throw error
    await request.onReconnect?.(submitted.id, error instanceof Error ? error.message : String(error))
    await recoverTtsToFileAdmitted(apiKey, outPath, submitted.id, request)
  }
}

export async function generateTtsToFile(
  apiKey: string,
  outPath: string,
  request: GenStudioTtsSubmitRequest,
): Promise<void> {
  return generateTtsToFileAdmitted(apiKey, outPath, request)
}
