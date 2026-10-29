/**
 * GenStudio KH client boundary for Story Studio.
 *
 * This module knows only the public GenStudio API contract. It has no sibling
 * Studio URL, token, worker list, or direct provider connection.
 */

import { submitSent } from './inflight-submits.js'
import { safetyGate, safetyMode, type SafetyMode } from '../services/safety-checks.js'
import { STORY_CALLER } from './machine-name.js'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { carriesCapacityFacts, humanGatewayText } from './gateway-failure-text.js'
import { getAppSetting, getGenStudioUrl, getLanguageTimeoutMs, setAppSetting, getPaidAudioReplacementSetting, getPaidWritingReplacementSetting, withPaidAudioConfirmation, withPaidWritingConfirmation } from '../services/app-settings.js'
import { balancedReplacementSettlement, generationReplacementKey, replacementAllowance, type ReplacementKind } from '../services/generation-paid-replacement.js'
import type { GenerationReplacementAttempt, Job } from '../models/types.js'
import { runFfmpeg } from './ffmpeg-utils.js'
import { probeAudioSignature } from './audio-concat.js'
import {
  GenStudioAdmissionPool,
  type GenStudioAdmissionState,
  type GenStudioAccountCapacity,
  type GenStudioServiceTier,
  type GenStudioServiceTierStanding,
} from './genstudio-admission.js'
import { splitAtLimit } from './sentence-ends.js'
import { chunkText } from './text-chunker.js'
import { ACTIVE_GENSTUDIO_PROVIDER_STATES, isNeverCreatedProviderTask } from './provider-task-state.js'
import { isFreeFleetModelId } from '../contracts/provider-task-state.js'
// Every outbound JSON body is serialised through `wellFormedJson`, never
// through bare `JSON.stringify`. GenStudio is a UTF-8 service and correctly
// refuses a lone surrogate; this is the single boundary that guarantees it
// never receives one. See lib/well-formed-text.ts.
import { wellFormedJson } from './well-formed-text.js'
import {
  hasTtsControlValues,
  orderedTtsControlValues,
  parseDeliveryInstructionControl,
  parseTtsControlValues,
  parseTtsControls,
  type GenStudioDeliveryInstructionControl,
  type GenStudioTtsControl,
  type TtsControlValues,
} from './tts-controls.js'
import {
  chatAllowanceSeconds,
  describeOutputBudget,
  effectiveChatTimeoutMs,
  expectedOutputTokensFor,
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
import { findGenStudioProduct } from '../contracts/genstudio-product-identity.js'
import { nextTtsRouteRetryIdentity } from '../services/tts-capacity-retry.js'

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
/** A server poll hint below this is read as this: 0 must never mean "ask again immediately". */
export const GENSTUDIO_POLL_MIN_HINT_MS = 1_000
/** How often an in-progress wait re-checks cancellation. Keeps a 15-second
 *  sleep from making the Cancel button feel dead. */
const POLL_CANCEL_CHECK_MS = 250

/**
 * Test-only poll cadence, in milliseconds per attempt (the last entry repeats).
 *
 * Only the WAIT between polls moves: the ladder's shape, the cap, the jitter, the
 * server-hint floor, cancellation and the deadline clamp all still apply, so a
 * test that shortens this observes the same sequence of polls and the same
 * terminal state — one second sooner per attempt. Tests that assert the cadence
 * itself use the pure function with this left null, so they read the published
 * ladder exactly as before.
 */
let pollLadderOverrideMs: readonly number[] | null = null
export function _setGenStudioPollLadderForTesting(ladderMs: readonly number[] | null): void {
  const valid = Array.isArray(ladderMs) && ladderMs.length > 0
    && ladderMs.every(ms => Number.isFinite(ms) && ms >= 0)
  pollLadderOverrideMs = valid ? [...ladderMs] : null
}

const NETWORK_RETRY_ATTEMPTS = 4
/**
 * Attempts for a READ of an accepted job (every wait-loop poll and every reconnect read).
 *
 * Four attempts spanned ~3.5 s of backoff. The Gateway is restarted on this Mac to install new
 * builds, and a restart takes longer than that, so an image/voice/video job already accepted and
 * running fell out of its poll, got one automatic reconnect that hit the same gap, and surfaced as a
 * failed item although the Gateway finished it a few seconds later. A job read is idempotent and
 * the 4-hour deadline still bounds it; twelve attempts ride out ~35 s of backoff (0.5, 1, 2, then 4 s
 * steps) and a Cancel still lands within a quarter second.
 */
export const GENSTUDIO_JOB_READ_ATTEMPTS = 12
const CATALOG_RETRY_ATTEMPTS = 3
/**
 * One catalogue GET's own ceiling.
 *
 * Thirty seconds, the same as a control call (`GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS`).
 *
 * It used to be eight. On the overloaded production Mac mini the catalogue reads
 * (`/v1/tts/models`, `/v1/chat/models`) timed out for more than half an hour while
 * 30-second control calls to the SAME Gateway answered normally — so the ceiling,
 * not the Gateway, was what failed. A catalogue read is free and idempotent and the
 * copy it refreshes is good for `CATALOG_FRESH_MS`, so waiting longer costs nothing;
 * giving up at eight seconds made the stale-catalogue guard refuse paid jobs.
 */
export const CATALOG_REQUEST_TIMEOUT_MS = 30_000
const CATALOG_FRESH_MS = 5 * 60_000
const CATALOG_STALE_MS = 30 * 60_000
/** How long a last-known account overview stays showable, clearly marked stale. */
const ACCOUNT_OVERVIEW_STALE_MS = 30 * 60_000
/**
 * How long Story Studio keeps following ONE accepted gateway job.
 *
 * **The Gateway decides when a job is over; Story follows it.** This used to be four hours (and a
 * deliberate reconnect after it, so about eight), which made Story give up on its own clock while
 * the gateway — which owns the queue wait, the per-lane run budget, the machine retries and the
 * cancel to the Hub — still held the job alive: an orphaned render nobody would collect. Story now
 * waits for as long as the gateway reports the job alive (the job card shows its state: queued,
 * waiting for a Mac, running), and the gateway ends every job itself with a typed failure and a real
 * cancel. A week is only the safety valve for a gateway that went silent for good — every poll
 * already fails fast when it is unreachable.
 */
export const GENSTUDIO_LONG_JOB_TIMEOUT_MS = 7 * 24 * 60 * 60_000
export const GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS = 30_000
export const GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS = 5 * 60_000
/**
 * How long ONE language submission may hold its socket open.
 *
 * OWNER-EDITABLE since 2026-08-29, and no longer a constant. The number lives
 * in `app-settings.json` under `genstudio_language_timeout_minutes`, defaults
 * to 30 minutes, and is read FRESH on every submission — changing it in
 * This Mac → Throughput takes effect on the next request with no restart.
 * `services/app-settings.ts` carries the bounds and where they come from.
 * The history below is why the number matters at all.
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
export async function languageSubmitTimeoutMs(): Promise<number> {
  return getLanguageTimeoutMs()
}

/**
 * The socket timeout one chat request actually gets: **the owner's dial or this request's own
 * computed allowance, whichever is longer, capped at the Hub's 4-hour ceiling.**
 *
 * The dial alone is not enough since 2026-10-19. Studio Hub computes each Chat job's deadline from
 * the job — the expected answer it was told, that Mac's measured decode rate — and a 100-prompt
 * scene pack is ~68 minutes on the fleet's slowest Mac. A socket bounded only by the 30-minute
 * default would abort generation that the Gateway and the Hub had both allowed, and that
 * GenStudio had already run and charged for. The allowance is derived from the same
 * `expected_output_tokens` this client sends, at the fleet's slowest measured rate, so the two
 * sides cannot disagree about how long the answer takes.
 *
 * `max` and never a replacement: an operator who set 60 minutes keeps 60 even when the allowance
 * is two. `services/output-token-budget.ts` owns every constant in that arithmetic.
 */
export async function effectiveChatSubmitTimeoutMs(allowanceSeconds: number): Promise<number> {
  return effectiveChatTimeoutMs(await getLanguageTimeoutMs(), allowanceSeconds)
}
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
  /** Internal automatic replacement cap; only sent after a fresh server support check. */
  replacementChargeLimit?: number
  /** Called after admission/waits and immediately before each physical POST. */
  beforePost?: () => void | Promise<void>
  /** Optional per-attempt gate around the physical submission, not its retry wait. */
  withPost?: (post: () => Promise<Response>) => Promise<Response>
  signal?: AbortSignal
  isCancelled?: () => boolean
  onQueueState?: (state: GenStudioQueueState, jobId?: string) => void | Promise<void>
  /** A durable accepted task lost its live connection and is being reclaimed. */
  onReconnect?: (jobId: string, reason: string) => void | Promise<void>
}

export interface GenStudioJob {
  id: string
  state: 'accepted' | 'reserved' | 'dispatched' | 'running' | 'validating' | 'succeeded' | 'failed' | 'reconciling'
  dispatch_state?: 'pre_dispatch' | 'dispatched'
  failure_code?: string | null
  audio_url?: string | null
  model_id?: string
  model_revision_id?: string
  credit_cost?: number
  /** USD the provider charged, present only when it stated one (`cost_source: "provider"`). Absent is not $0. */
  cost_usd?: number
  cost_source?: 'provider'
  remaining_credits?: number
  /**
   * Settlement values, exactly as GenStudio publishes them. `released_credits`
   * Story Studio forwards whatever GenStudio publishes and never derives a
   * charge locally.
   */
  reserved_credits?: number | null
  settled_credits?: number | null
  released_credits?: number | null
  routing_status_code?: string | null
  retry_after_seconds?: number | null
  retry_at?: string | null
  last_provider_progress_at?: string | null
  stall_recovery_at?: string | null
  status_detail?: string | null
  failure_detail?: string | null
  queue_position?: number | null
  queue_eta_seconds?: number | null
  queue_reason?: 'provider_pace' | null
  /** See `GenStudioSettledJobShape`. Optional; absent on older APIs. */
  failure_reason?: string | null
  failure_class?: string | null
  /** Studio Hub 0.6.137+ voice jobs: per-section check results (lib/tts-section-quality.ts). Passed through when the Gateway does. */
  section_quality?: unknown
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
  /** The gateway is holding a `failed` job whose outcome it could not confirm; a result may still be adopted. */
  recovery_required?: boolean | null
  recovery_state?: string | null
  /** Running at the gateway, but the machine has not started it yet. Null once a Mac is rendering. */
  waiting?: GenStudioWaiting | null
}

/** `waiting` on a job envelope: the job is queued or deferred at a Mac, not rendering. */
export interface GenStudioWaiting {
  reason: string | null
  next_try_at: string | null
  since: string | null
}

/**
 * A `failed` job the gateway still holds for adoption (a gateway restart or an ambiguous read).
 * Its result may yet arrive as `succeeded`, so it is not final inside the grace window.
 */
export function holdsUnknownOutcome(job: { recovery_required?: unknown; recovery_state?: unknown }): boolean {
  return job.recovery_required === true || job.recovery_state === 'unknown_outcome'
}

/** ~5 minutes: the gateway's hold sweep runs every 60 s. */
export const UNKNOWN_OUTCOME_GRACE_MS = 5 * 60_000

/** Reads `waiting` off an envelope, tolerating a gateway that predates it. */
export function normalizeGenStudioWaiting(value: unknown): GenStudioWaiting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const w = value as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return { reason: text(w.reason), next_try_at: text(w.next_try_at), since: text(w.since) }
}

/** The cancellation fields GenStudio 0.97.1 actually publishes. */
export type GenStudioCancellationFields = {
  state: string
  dispatch_state?: 'pre_dispatch' | 'dispatched'
  cancellable?: boolean
  cancelled?: boolean
  cancellation_requested?: boolean
  cancellation_note?: string | null
  failure_code?: string | null
  reserved_credits?: number
  settled_credits?: number
  released_credits?: number
  retry_after_seconds?: number | null
  retry_at?: string | null
  last_provider_progress_at?: string | null
  stall_recovery_at?: string | null
  status_detail?: string | null
  failure_detail?: string | null
}

const GENSTUDIO_JOB_STATES = new Set<GenStudioJob['state']>([
  ...ACTIVE_GENSTUDIO_PROVIDER_STATES, 'succeeded', 'failed',
])

function isValidSettlement(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseGenStudioCancellationResponse(value: unknown): GenStudioJob & GenStudioCancellationFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway cancellation response was not an object')
  }
  const body = value as Record<string, unknown>
  if (typeof body.id !== 'string' || !body.id.trim()) {
    throw new Error('Gateway cancellation response did not include a job id')
  }
  if (typeof body.state !== 'string' || !GENSTUDIO_JOB_STATES.has(body.state as GenStudioJob['state'])) {
    throw new Error('Gateway cancellation response did not include a valid state')
  }
  const optionalBoolean = (name: string): boolean | undefined => (
    typeof body[name] === 'boolean' ? body[name] : undefined
  )
  const optionalText = (name: string): string | null | undefined => (
    typeof body[name] === 'string' || body[name] === null ? body[name] as string | null : undefined
  )
  const optionalSettlement = (name: string): number | undefined => {
    const field = body[name]
    return isValidSettlement(field) ? field : undefined
  }
  const optionalNumberOrNull = (name: string): number | null | undefined => {
    const field = body[name]
    return field === null || isValidSettlement(field) ? field as number | null : undefined
  }
  const optionalNonEmptyTextOrNull = (name: string): string | null | undefined => {
    const field = body[name]
    if (field === null) return null
    return typeof field === 'string' && field.trim() ? field : undefined
  }
  /** Remote-authored prose, made safe to show a customer. See the function. */
  const optionalCustomerSafeDetail = (name: string): string | null | undefined => {
    const raw = optionalNonEmptyTextOrNull(name)
    return typeof raw === 'string' ? customerSafeRemoteDetail(raw) : raw
  }
  const dispatchState = body.dispatch_state
  return {
    id: body.id,
    state: body.state as GenStudioJob['state'],
    ...(dispatchState === 'pre_dispatch' || dispatchState === 'dispatched' ? { dispatch_state: dispatchState } : {}),
    ...(optionalBoolean('cancellable') !== undefined ? { cancellable: optionalBoolean('cancellable') } : {}),
    ...(optionalBoolean('cancelled') !== undefined ? { cancelled: optionalBoolean('cancelled') } : {}),
    ...(optionalBoolean('cancellation_requested') !== undefined ? { cancellation_requested: optionalBoolean('cancellation_requested') } : {}),
    ...(optionalText('cancellation_note') !== undefined ? { cancellation_note: optionalText('cancellation_note') } : {}),
    ...(optionalBoolean('recovery_required') !== undefined ? { recovery_required: optionalBoolean('recovery_required') } : {}),
    ...(optionalText('recovery_state') !== undefined ? { recovery_state: optionalText('recovery_state') } : {}),
    ...(body.waiting !== undefined ? { waiting: normalizeGenStudioWaiting(body.waiting) } : {}),
    ...(optionalText('failure_code') !== undefined ? { failure_code: optionalText('failure_code') } : {}),
    ...(optionalText('failure_class') !== undefined ? { failure_class: optionalText('failure_class') } : {}),
    ...(optionalSettlement('reserved_credits') !== undefined ? { reserved_credits: optionalSettlement('reserved_credits') } : {}),
    ...(optionalSettlement('settled_credits') !== undefined ? { settled_credits: optionalSettlement('settled_credits') } : {}),
    ...(optionalSettlement('released_credits') !== undefined ? { released_credits: optionalSettlement('released_credits') } : {}),
    ...(optionalNumberOrNull('retry_after_seconds') !== undefined ? { retry_after_seconds: optionalNumberOrNull('retry_after_seconds') } : {}),
    ...(optionalNonEmptyTextOrNull('retry_at') !== undefined ? { retry_at: optionalNonEmptyTextOrNull('retry_at') } : {}),
    ...(optionalNonEmptyTextOrNull('last_provider_progress_at') !== undefined ? { last_provider_progress_at: optionalNonEmptyTextOrNull('last_provider_progress_at') } : {}),
    ...(optionalNonEmptyTextOrNull('stall_recovery_at') !== undefined ? { stall_recovery_at: optionalNonEmptyTextOrNull('stall_recovery_at') } : {}),
    ...(optionalNonEmptyTextOrNull('status_detail') !== undefined ? { status_detail: optionalCustomerSafeDetail('status_detail') } : {}),
    ...(optionalNonEmptyTextOrNull('failure_detail') !== undefined ? { failure_detail: optionalCustomerSafeDetail('failure_detail') } : {}),
  }
}

/**
 * v1.4.82 — remote-authored detail text, made safe to put in front of a customer.
 *
 * `status_detail` and `failure_detail` are prose GenStudio writes, and it writes
 * them about ITS OWN estate: "waiting for a worker; no site has accepted this
 * job yet; placement window closes at 14:32". Story Studio prints them verbatim
 * on the job card, so a customer could read off how many machines we run and how
 * saturated they are. The owner's ruling is that infrastructure shape is
 * internal — no counts, no saturation, no site names.
 *
 * Word-substituting into someone else's sentence produces nonsense, so a
 * sentence that describes the estate is REPLACED whole with the operational
 * equivalent: what state the work is in, and that nothing has gone wrong.
 * Detail that says nothing about our estate passes through untouched.
 *
 * The raw text is not lost — it stays in the server's own log, which is where
 * infrastructure detail belongs.
 *
 * ── Why no time is scraped out of the prose any more (1.4.83) ──
 *
 * This used to carry a clock time across, on the reasoning that the escalation
 * deadline was the one genuinely useful fact in the sentence being discarded.
 * The fact was useful; the way it was obtained was not. It came from an
 * unanchored `HH:MM` pattern run over the whole sentence, so it took the FIRST
 * clock-shaped substring anywhere in GenStudio's prose whether or not that
 * substring was the deadline — and it reprinted those digits with no timezone
 * conversion at all, in GenStudio's zone, beside a time the app had rendered in
 * the reader's. A card was seen reading:
 *
 *     Queued — waiting for capacity; automatic escalation at 00:00.
 *     GenStudio will intervene Today 10:24:24 PM.
 *
 * Two clocks, for ONE deadline, disagreeing. The deadline was never in doubt:
 * `stall_recovery_at` rides on the very same record, as a real timestamp, and
 * the second sentence there is rendered from it correctly. Guessing at a
 * duplicate of a value we already hold exactly is not worth one wrong number in
 * front of a customer, so the guess is gone. The deadline is stated once, by
 * the frontend, from `stall_recovery_at` — see `genStudioStatusDetail` in
 * `pages/projects/[slug]/jobs.vue`.
 */
const INFRASTRUCTURE_SHAPE = /\b(machines?|workers?|sites?|fleet|nodes?|placement window)\b/i

export function customerSafeRemoteDetail(raw: string): string {
  // Known Gateway/Hub shapes become sentences first (`gateway-failure-text.ts`).
  const human = humanGatewayText(raw)
  // A memory or disk figure is the one thing the owner needs when no Mac can take the job ("needs
  // ~16 GB, this one has 8 GB"); it is kept, with "machine" spelled "Mac", never blanked.
  if (carriesCapacityFacts(raw) || carriesCapacityFacts(human)) return human.replace(/\bmachines\b/gi, 'Macs').replace(/\bmachine\b/gi, 'Mac')
  if (!INFRASTRUCTURE_SHAPE.test(human)) return human
  console.log(`[genstudio] remote detail withheld from the customer view: ${raw}`)
  return 'Queued — waiting for capacity. Nothing failed and nothing was charged.'
}

/** The only two GenStudio job states that can never change again. */
export type GenStudioTerminalJobState = 'succeeded' | 'failed'

export function isTerminalGenStudioJobState(state: unknown): state is GenStudioTerminalJobState {
  return state === 'succeeded' || state === 'failed'
}

export { GENSTUDIO_TASK_NOT_CREATED_STATE } from './provider-task-state.js'
export { isNeverCreatedProviderTask }

/**
 * v1.2.8 — the one predicate that separates "the provider answered, and does
 * not have this" from "Story Studio could not reach the provider".
 *
 * A 404 on a control-plane job GET is an ANSWER. GenStudio looked the id up
 * against this account and found nothing, which means nothing was created,
 * nothing was reserved, and nothing was charged. There is no outcome left to
 * wait for, so continuing to poll wedges the job forever — the defect this
 * fixes.
 *
 * Everything else stays transient, deliberately and by construction:
 *
 *   - a network failure, DNS failure, socket error or timeout never becomes a
 *     `GenStudioApiError` at all (see `requestJsonWithRetry`), so it cannot
 *     reach this predicate;
 *   - 5xx is GenStudio failing to answer, not answering;
 *   - 401/403 is a credential problem — the task's existence was never
 *     established either way;
 *   - 410 is deliberately excluded. "Gone" says the record EXISTED and was
 *     removed, which is the opposite claim, and a task that existed may have
 *     been charged.
 *
 * An exact allow-list of one status, for the same reason
 * `isGenStudioRouteExhausted` is an allow-list of one failure code: being
 * wrong in the "keep waiting" direction costs one manual click, being wrong in
 * the "it was never created" direction is how you pay twice. Story Studio also
 * never resubmits off the back of this on its own, so even a mistaken 404
 * cannot spend money.
 */
export function isGenStudioTaskAbsent(error: unknown): error is GenStudioApiError {
  return error instanceof GenStudioApiError && error.status === 404
}

/**
 * A GenStudio job that will never produce an artifact, for any reason —
 * including a task GenStudio has told us it does not have.
 */
export function isSettledGenStudioJob(job: { state?: unknown; cancelled?: boolean | null }): boolean {
  return isTerminalGenStudioJobState(job.state) || isNeverCreatedProviderTask(job) || job.cancelled === true
}

/** Every GenStudio product family Story Studio submits durable work to. */
export type GenStudioModality = 'image' | 'video' | 'tts' | 'transcription' | 'chat' | 'music'

/** The shape every settled GenStudio job response shares. */
export interface GenStudioSettledJobShape {
  id: string
  state?: unknown
  /** `studio-hub::…` is the owner's free fleet (see `isFreeFleetModelId`). */
  model_id?: string | null
  failure_code?: string | null
  reserved_credits?: number | null
  settled_credits?: number | null
  released_credits?: number | null
  /** image / TTS / transcription jobs. */
  cancelled?: boolean | null
  cancellation_note?: string | null
  /** video jobs use this instead of `cancellable`. */
  cancellation_requested?: boolean | null
  /**
   * The serving provider's own account of why it refused, when GenStudio has
   * one it can publish. Optional on purpose: a deployed API that predates the
   * field simply omits it, and every surface below then reads exactly as it
   * did before. Never assume it is present.
   */
  failure_reason?: string | null
  /**
   * What KIND of problem it was, in GenStudio's own closed vocabulary. Branch
   * on this, never on `failure_reason`'s wording. Optional for the same reason
   * as the field above; see `GenStudioFailureClass`.
   */
  failure_class?: string | null
  /** The gateway could not confirm the outcome, so a resubmission might duplicate real work. */
  recovery_required?: boolean | null
  recovery_state?: string | null
}

function settledFailureCode(job: GenStudioSettledJobShape): string | null {
  return typeof job.failure_code === 'string' && job.failure_code ? job.failure_code : null
}

/** Absent, null, and blank all mean the same thing: nothing to show. */
function settledFailureReason(job: GenStudioSettledJobShape): string | null {
  return typeof job.failure_reason === 'string' && job.failure_reason.trim()
    ? humanGatewayText(job.failure_reason)
    : null
}

/**
 * What KIND of problem ended the job, as GenStudio classified it.
 *
 * GenStudio computes this from structured facts — the job's failure code and
 * the recorded exception class — and publishes it. Story Studio does NOT
 * derive it from the reason text, and must not start: our own request for this
 * field (`docs/genstudio-handoff/content-refusal-code-request.md`) said so in
 * as many words, because "pattern-matching provider error text to infer a
 * content refusal ... would break the first time a provider changed its
 * wording". The message is for a human to read; this is the part code branches
 * on.
 *
 * `unknown` covers both "GenStudio published no class" (every deployed API
 * older than the field) and "GenStudio published one we do not recognise" (a
 * newer API that has grown a fourth value). Both mean the same thing here: show
 * what we have and invent no advice.
 */
export type GenStudioFailureClass =
  | 'content_refused'
  | 'provider_transient'
  | 'provider_error'
  | 'unknown'

const KNOWN_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'content_refused',
  'provider_transient',
  'provider_error',
])

export function settledFailureClass(job: GenStudioSettledJobShape): GenStudioFailureClass {
  const raw = typeof job.failure_class === 'string' ? job.failure_class.trim() : ''
  return KNOWN_FAILURE_CLASSES.has(raw) ? (raw as GenStudioFailureClass) : 'unknown'
}

/**
 * Where a user edits the text this modality submitted, named the way the app
 * names it, so "edit the prompt" points somewhere they can actually click.
 */
const REPROMPT_SURFACE: Record<GenStudioModality, string> = {
  image: 'the Prompts page',
  video: 'the Prompts page',
  chat: 'the script',
  tts: 'the script',
  music: 'the music prompt',
  transcription: 'the source audio',
}

/**
 * One actionable sentence, or nothing at all.
 *
 * `provider_error` and `unknown` both return null on purpose. A confidently
 * wrong instruction ("edit your prompt") costs more than silence when the real
 * cause was a billing hold or an expired key — and `provider_error` is
 * GenStudio saying, precisely, that it will not claim to know why.
 */
export function genStudioFailureGuidance(
  failureClass: GenStudioFailureClass,
  modality: GenStudioModality,
): string | null {
  switch (failureClass) {
    case 'content_refused':
      return `The provider refused this prompt's content. Edit the prompt (open `
        + `${REPROMPT_SURFACE[modality]}) and Retry — retrying unchanged will fail again.`
    case 'provider_transient':
      return 'Temporary provider issue — Retry usually succeeds.'
    default:
      return null
  }
}

function releasedCreditSettlement(job: GenStudioSettledJobShape): string {
  // Free fleet work has no credits to report; "0 credits released" there is noise (owner, 2026-10-03).
  if (isFreeFleetModelId(job.model_id)) return ''
  const released = job.released_credits
  return typeof released === 'number' && Number.isFinite(released) && released >= 0
    ? `GenStudio reports ${released} credits released.`
    : 'Credit settlement is not yet published; check its Gateway status.'
}

/** A sentence about credits or fallbacks belongs to paid work only. */
function paidOnly(job: GenStudioSettledJobShape, text: string): string {
  return isFreeFleetModelId(job.model_id) ? '' : text
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
  /** The provider's own words, when GenStudio published them. */
  readonly failureReason: string | null
  /** What kind of problem it was, as GenStudio classified it. */
  readonly failureClass: GenStudioFailureClass
  readonly cancelled: boolean
  /** The gateway holds this failure as an unknown outcome: never resubmit it by machine. */
  readonly unknownOutcome: boolean
  readonly reservedCredits: number | null
  readonly settledCredits: number | null
  readonly releasedCredits: number | null
  /** The model id the job envelope published; `studio-hub::…` is the owner's free fleet. */
  readonly modelId: string | null

  constructor(modality: GenStudioModality, job: GenStudioSettledJobShape, message: string) {
    // Appended HERE rather than in each of the six subclasses, and rather than
    // at the render sites, because every surface that shows a failed job shows
    // `.message`: the job card's red error line, `Thumbnail N: FAILED — ...`,
    // and `Chapter N: ...`. One seam reaches all of them, and none of them can
    // drift out of step with the others.
    //
    // When GenStudio publishes no reason — including every currently deployed
    // API, which does not know the field — both parts are null and `message`
    // is byte-for-byte what it was before this existed.
    const reason = settledFailureReason(job)
    const failureClass = settledFailureClass(job)
    super([
      message.replace(/\s{2,}/g, ' ').trim(),
      reason ? `Provider reason: ${reason}` : null,
      genStudioFailureGuidance(failureClass, modality),
    ].filter(Boolean).join(' '))
    this.name = 'GenStudioTerminalFailureError'
    this.modality = modality
    this.jobId = job.id
    this.failureCode = settledFailureCode(job)
    this.failureReason = reason
    this.failureClass = failureClass
    this.cancelled = job.cancelled === true
    this.unknownOutcome = holdsUnknownOutcome(job)
    this.reservedCredits = typeof job.reserved_credits === 'number' && Number.isFinite(job.reserved_credits) ? job.reserved_credits : null
    this.settledCredits = typeof job.settled_credits === 'number' && Number.isFinite(job.settled_credits) ? job.settled_credits : null
    this.releasedCredits = typeof job.released_credits === 'number' && Number.isFinite(job.released_credits) ? job.released_credits : null
    this.modelId = typeof job.model_id === 'string' && job.model_id ? job.model_id : null
  }
}

/** A machine retry is safe only when GenStudio proves the whole reservation returned. */
export function hasFullyReleasedZeroSettlement(error: GenStudioTerminalFailureError): boolean {
  const values = [error.reservedCredits, error.settledCredits, error.releasedCredits]
  return values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    && error.settledCredits === 0
    && error.releasedCredits === error.reservedCredits
}

export class GenStudioImageTerminalFailureError extends GenStudioTerminalFailureError {
  constructor(job: GenStudioSettledJobShape) {
    super(
      'image',
      job,
      job.cancelled === true
        ? `The image job ${job.id} was cancelled at the Gateway${job.cancellation_note ? ` (${job.cancellation_note})` : ''}. `
          + `${releasedCreditSettlement(job)} Retry submits a new job.`
        : `The Gateway could not make the image${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + `${releasedCreditSettlement(job)} This job cannot be reopened; Retry submits a new job.`,
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
        ? `The video job ${job.id} was cancelled at the Gateway. `
          + `${releasedCreditSettlement(job)} Retry submits a new job. ${paidOnly(job, 'No legacy fallback was attempted.')}`
        : `The Gateway could not make the video${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + `${releasedCreditSettlement(job)} This job cannot be reopened; Retry submits a new job. `
          + paidOnly(job, 'No legacy fallback was attempted.'),
    )
    this.name = 'GenStudioVideoTerminalFailureError'
  }
}

/**
 * v1.4.37 — a settled music job.
 *
 * Music is the first modality where ONE settled job carries MORE THAN ONE paid
 * artefact: Suno returns two complete tracks for a single charge, measured
 * 2026-08-23 (100 credits reserved, 100 captured, two files). Everything about
 * this class is therefore ordinary, but the RESULT type it accompanies is not —
 * see `GenStudioMusicResult.tracks`.
 */
export class GenStudioMusicTerminalFailureError extends GenStudioTerminalFailureError {
  constructor(job: GenStudioSettledJobShape) {
    super(
      'music',
      job,
      job.cancelled === true
        ? `The music job ${job.id} was cancelled at the Gateway. `
          + `${releasedCreditSettlement(job)} Retry submits a new job. ${paidOnly(job, 'No legacy fallback was attempted.')}`
        : holdsUnknownOutcome(job)
          ? `The Gateway is still checking this music result${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}; nothing was run twice. `
            + 'Once it finishes, "Recover existing result" on the Music Library page imports it without a new generation.'
        : `The Gateway could not make the music${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + `${releasedCreditSettlement(job)} This job cannot be reopened; Retry submits a new job. `
          + paidOnly(job, 'No legacy fallback was attempted.'),
    )
    this.name = 'GenStudioMusicTerminalFailureError'
  }
}

export class GenStudioTtsTerminalFailureError extends GenStudioTerminalFailureError {
  constructor(job: GenStudioSettledJobShape) {
    super(
      'tts',
      job,
      job.cancelled === true
        ? `The narration job ${job.id} was cancelled at the Gateway${job.cancellation_note ? ` (${job.cancellation_note})` : ''}. `
          + `${releasedCreditSettlement(job)} Retry submits a new job. ${paidOnly(job, 'No fallback route was attempted.')}`
        : `Gateway generation failed${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + `${releasedCreditSettlement(job)} ${paidOnly(job, 'No fallback route was attempted.')}`,
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
        ? `The transcription job ${job.id} was cancelled at the Gateway${job.cancellation_note ? ` (${job.cancellation_note})` : ''}. `
          + `${releasedCreditSettlement(job)} Retry submits a new job. `
          + paidOnly(job, 'No fallback route was attempted.')
        : `The Gateway could not transcribe the audio${settledFailureCode(job) ? ` (${settledFailureCode(job)})` : ''}. `
          + `${releasedCreditSettlement(job)} ${paidOnly(job, 'No fallback route was attempted.')}`,
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
    super('chat', job, chatFailureSentence(job))
    // The owner reads this on every writing page. The base class appends "Provider reason: …";
    // here the reason is "Details", and the gateway's "being checked" note is dropped because a
    // writing request that reached this point is over — nothing is checking it any more.
    const details = this.failureReason?.replace(/\s*The result is being checked; nothing was run twice\./i, '').trim()
    this.message = [chatFailureSentence(job), details ? `Details: ${details}` : null,
      genStudioFailureGuidance(this.failureClass, 'chat')].filter(Boolean).join(' ')
    this.name = 'GenStudioChatTerminalFailureError'
  }
}

/**
 * What happened to a writing request and what to do next, in the owner's words: no job ids, no
 * failure codes, no "route"/"provider"/"reconcile". Credits are mentioned only when some moved —
 * the free Gemini pool settles 0/0/0, and "0 credits released" is noise. A positive release keeps
 * the exact "GenStudio reports N credits released." sentence `job-queue` quotes on Abandon.
 */
function chatFailureSentence(job: GenStudioSettledJobShape): string {
  const code = settledFailureCode(job)
  const what = job.cancelled === true
    ? 'This writing request was cancelled. Retry sends it again.'
    : holdsUnknownOutcome(job)
      ? LOST_WRITING_REQUEST
      : describeGenStudioLanguageFailure(code)
        ?? 'Writing failed. Retry this step; if it keeps failing, pick a different writing model.'
  const released = job.released_credits
  const settled = job.settled_credits
  const credits = [
    typeof settled === 'number' && settled > 0 ? `${settled} credits were charged for this attempt.` : null,
    typeof released === 'number' && released > 0 ? `GenStudio reports ${released} credits released.` : null,
  ].filter(Boolean).join(' ')
  return credits ? `${what} ${credits}` : what
}

const LOST_WRITING_REQUEST = 'The writing service lost track of this request after it was sent, so Story Studio '
  + 'did not send it again by itself (a paid writing model could charge twice). Generate this step again to '
  + 'send a fresh request.'

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
      `The Gateway could not confirm this transcription quote (HTTP ${status}): ${detail}. `
      + 'The quote expired or was already settled; no transcription was created and nothing was charged. '
      + 'Retry submits one fresh quote.',
    )
    this.name = 'GenStudioTranscriptionQuoteExpiredError'
    this.status = status
  }
}

/** A saved transcription task id not visible to the current GenStudio account. */
export class GenStudioTranscriptionTaskUnavailableError extends Error {
  readonly modality: GenStudioModality = 'transcription'
  readonly jobId: string
  readonly status: number

  constructor(jobId: string, status: number) {
    super(
      `Saved transcription task ${jobId} was not found with the current Gateway connection/account (HTTP ${status}). `
      + 'It cannot be retrieved here; a fresh request requires an explicit section re-run and may be charged.',
    )
    this.name = 'GenStudioTranscriptionTaskUnavailableError'
    this.jobId = jobId
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
      `Could not download the image from the Gateway${status ? ` (HTTP ${status})` : ''}`
      + `${detail ? ` — ${detail}` : ''}: job ${jobId} no longer serves its artifact. `
      + 'Retry submits a new job; check the original job in the Gateway for its settlement status.',
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
        ? `Could not download the audio from the Gateway (HTTP ${status})${detail ? ` — ${detail}` : ''}: `
          + `job ${jobId} no longer serves its artifact. Retry submits a new job.`
        : detail && detail !== 'the job completed without a download URL'
        ? `The audio from Gateway job ${jobId} is unusable (${detail}). Retry submits a new job.`
        : `Gateway job completed without an audio download URL: job ${jobId} `
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
        ? `Gateway SRT download failed (HTTP ${status})${detail ? ` — ${detail}` : ''}: `
          + `job ${jobId} no longer serves its artifact. Retry submits a new job.`
        : `The Gateway finished transcribing but sent no subtitle file: job ${jobId} `
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
  /** Live selected model publication. An absent/incomplete range means neutral speed 1. */
  supportsSpeed?: boolean | null
  minimumSpeed?: number | null
  maximumSpeed?: number | null
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
  /**
   * How the words should be read — the model's own free-text delivery/emotion
   * direction (owner, 2026-10-29). Already resolved against the SELECTED
   * model's published control by `resolveDeliveryInstruction`, so it is present
   * only when the model publishes the control and the customer typed something.
   *
   * Absent is the ordinary case and produces the exact body (and idempotency
   * digest) this client sent before the field existed. It reaches the wire as
   * the Gateway's top-level `delivery_instruction` parameter, which the Gateway
   * refuses with a 422 on a model whose catalogue row does not publish it.
   */
  deliveryInstruction?: string
  /**
   * `m4a` asks the lane to hand the narration back as AAC (transport only — Story still writes
   * its MP3 chapter from whatever arrives). Absent = native WAV, today's behaviour.
   */
  outputFormat?: 'm4a'
  /**
   * The join pauses (seconds) the lane inserts where it splits this request's text: at a
   * paragraph break and after a sentence. Sent only when the selected model publishes them
   * (`pause_parameters`), already clamped to its range. Absent = the model's own pauses.
   */
  pauses?: TtsPauseValues
  /** Stable Story asset identity, such as project + episode + output file. */
  requestIdentity?: string
  /** Called with the finished job's `section_quality` when the Gateway passed one through. */
  onSectionQuality?: (sectionQuality: unknown) => void
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

/** Resolve speed against the selected model's live publication. */
export function resolveGenStudioTtsSpeed(
  requested: unknown,
  supportsSpeed?: boolean | null,
  minimumSpeed?: number | null,
  maximumSpeed?: number | null,
): number {
  const speed = requested == null ? 1 : Number(requested)
  if (!Number.isFinite(speed)) throw new Error('Gateway speed must be a finite number.')
  if (supportsSpeed !== true) return 1
  if (typeof minimumSpeed !== 'number' || !Number.isFinite(minimumSpeed) || minimumSpeed <= 0
    || typeof maximumSpeed !== 'number' || !Number.isFinite(maximumSpeed) || maximumSpeed < minimumSpeed) return 1
  if (speed < minimumSpeed || speed > maximumSpeed) {
    throw new Error(`Gateway speed must be between ${minimumSpeed} and ${maximumSpeed}.`)
  }
  return speed
}

export type GenStudioCostTier = 'economy' | 'balanced' | 'premium'
export type GenStudioLlmCostTier = 'promotional' | 'value' | 'economy' | 'premium'

function parseGenStudioCostTier(value: unknown): GenStudioCostTier | undefined {
  return value === 'economy' || value === 'balanced' || value === 'premium'
    ? value
    : undefined
}

function parseGenStudioLlmCostTier(value: unknown): GenStudioLlmCostTier | undefined {
  return value === 'promotional' || value === 'value' || value === 'economy' || value === 'premium'
    ? value
    : undefined
}

export interface GenStudioCatalogLock {
  /** A visible teaser that this account may not submit. Absent on older catalogs. */
  locked?: boolean
  /** GenStudio's machine-readable explanation, only meaningful when locked. */
  lock_reason?: string
}

function parseGenStudioCatalogLock(value: unknown): GenStudioCatalogLock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  if (typeof row.locked !== 'boolean') return {}
  const lockReason = row.locked && typeof row.lock_reason === 'string' && row.lock_reason.trim()
    ? row.lock_reason.trim()
    : undefined
  return {
    locked: row.locked,
    ...(lockReason ? { lock_reason: lockReason } : {}),
  }
}

/**
 * Who stated a model's price, and the price in USD by unit (gateway 0.2.82+).
 *
 * The zero-valued `credits_*` fields on the same row are parser shapes, NOT
 * prices — nothing here may read them as "free". Absent on older gateways, in
 * which case every field is omitted and the row shows no price at all.
 * `price_usd` is kept for `provider` / `provider_page` / `local`; unit keys are read
 * verbatim (`per_image`, `input_per_1m_tokens`, ...) and never derived. A pricing-page row
 * (0.2.83) also carries `price_url`, and lists a unit the page prices several ways in
 * `price_variants` instead of `price_usd`.
 */
export interface GenStudioPriceVariant {
  unit: string
  /** Which size / quality / tier this number is for. */
  variant: string
  /** A USD number, or (for `unit: "other"`) the page's own words in `unit_text`. Never both invented. */
  usd?: number
  unit_text?: string
  source_url?: string
}

export interface GenStudioPriceTruth {
  price_source?: 'provider' | 'provider_page' | 'local' | 'unpublished'
  price_usd?: Record<string, number> | null
  price_as_of?: string | null
  /** `provider_page` only: the provider's own pricing page the number was read from. */
  price_url?: string
  /** `provider_page` only: a unit the page prices several ways. Never picked between, never in `price_usd`. */
  price_variants?: GenStudioPriceVariant[]
  /**
   * Whether using this row can cost money. Published on EVERY catalogue row and
   * on voice rows; `false` is the Gateway stating the work is free.
   *
   * Produced by `parseGenStudioChargeable` — a separate parse because the flag
   * is published independently of `price_source`, so a row that states one
   * without the other must keep the one it stated. The frontend's own
   * `PriceTruth` carries it the same way.
   */
  chargeable?: boolean
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return /^https?:\/\//i.test(text) ? text : undefined
}

export function parseGenStudioPriceTruth(value: unknown): GenStudioPriceTruth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  const source = row.price_source
  if (source !== 'provider' && source !== 'provider_page' && source !== 'local' && source !== 'unpublished') return {}
  if (source === 'unpublished') return { price_source: source, price_usd: null, price_as_of: null }
  const usd: Record<string, number> = {}
  if (row.price_usd && typeof row.price_usd === 'object' && !Array.isArray(row.price_usd)) {
    for (const [unit, amount] of Object.entries(row.price_usd)) {
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) usd[unit] = amount
    }
  }
  const variants: GenStudioPriceVariant[] = source !== 'provider_page' || !Array.isArray(row.price_variants) ? [] : row.price_variants.flatMap((item: any) => {
    const sourceUrl = httpUrl(item?.source_url)
    const hasUsd = typeof item?.usd === 'number' && Number.isFinite(item.usd) && item.usd >= 0
    const unitText = typeof item?.unit_text === 'string' ? item.unit_text.trim() : ''
    return typeof item?.unit === 'string' && item.unit.trim() && typeof item?.variant === 'string' && item.variant.trim() && (hasUsd || unitText)
      ? [{
        unit: item.unit.trim(),
        variant: item.variant.trim(),
        ...(hasUsd ? { usd: item.usd } : { unit_text: unitText }),
        ...(sourceUrl ? { source_url: sourceUrl } : {}),
      }]
      : []
  })
  // A "priced" row with no usable number is unpublished, never free. (A page row that only lists variants is priced: it varies.)
  if (source !== 'local' && !Object.keys(usd).length && !variants.length) return { price_source: 'unpublished', price_usd: null, price_as_of: null }
  const asOf = typeof row.price_as_of === 'string' && row.price_as_of.trim() ? row.price_as_of.trim() : null
  const url = source === 'provider_page' ? httpUrl(row.price_url) : undefined
  return {
    price_source: source,
    price_usd: usd,
    price_as_of: source === 'local' ? null : asOf,
    ...(url ? { price_url: url } : {}),
    ...(variants.length ? { price_variants: variants } : {}),
  }
}

/**
 * The Gateway's published `chargeable` flag, carried through the transport.
 *
 * Every catalogue row states whether using it can cost money — `_story_row`
 * sets it on every modality — and a voice row states it too. This is the ONE
 * place that decides how it crosses the boundary, spread beside
 * `parseGenStudioPriceTruth` by every catalogue parser, so the flag cannot be
 * kept by one modality and silently dropped by another. It was dropped by TTS,
 * video, transcription and voices while chat, image and music kept it, which
 * left a free `studio-hub` model looking unverifiable in production.
 *
 * ABSENT STAYS ABSENT: a row that published nothing carries no key at all —
 * never `false`, which is a "this is free" claim the Gateway never made.
 */
export function parseGenStudioChargeable(value: unknown): { chargeable?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const flag = publishedFlag((value as Record<string, unknown>).chargeable)
  return flag === undefined ? {} : { chargeable: flag }
}

/**
 * The provider-stated USD cost of a job (gateway 0.2.82+), carried through verbatim. The gateway
 * omits both keys unless the provider stated a charge, so absence stays absence: nothing here
 * defaults to 0 or derives a cost from tokens x price.
 */
export function providerCostUsd(job: { cost_usd?: unknown; cost_source?: unknown } | null | undefined): { cost_usd?: number; cost_source?: 'provider' } {
  const cost = job?.cost_usd
  return job?.cost_source === 'provider' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ? { cost_usd: cost, cost_source: 'provider' }
    : {}
}

/**
 * Identifiers a published product answers to, beyond the one in `id`.
 *
 * GenStudio products carry a raw `public_model_id` AND an owner-defined
 * `customer_handle`; the image and video listings are moving to publish the
 * handle, and submit accepts either form. The catalog parsers below build
 * explicit object literals, so ANY field not named here is silently dropped —
 * which means without this, a handle GenStudio publishes would never reach the
 * resolver and a preset holding the old raw id could never be matched to it.
 *
 * Parsed permissively and stored verbatim. Story Studio never invents an alias
 * and never rewrites one; it only remembers what GenStudio said. Matching is
 * done through `@shared/genstudio-product-identity`, never by hand.
 */
export interface GenStudioProductAliases {
  /** Owner-defined public handle, e.g. `gpt-image-2`. */
  customer_handle?: string
  /** Raw product id, when the listing publishes the handle as `id`. */
  public_model_id?: string
  /** Superseded identifiers this product still answers to. */
  legacy_ids?: string[]
}

function parseGenStudioProductAliases(value: unknown): GenStudioProductAliases {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  const text = (candidate: unknown): string | undefined =>
    typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
  const legacy = Array.isArray(row.legacy_ids)
    ? row.legacy_ids
      .filter((entry: unknown): entry is string => typeof entry === 'string' && !!entry.trim())
      .map((entry: string) => entry.trim())
    : []
  const handle = text(row.customer_handle)
  const rawId = text(row.public_model_id)
  return {
    ...(handle ? { customer_handle: handle } : {}),
    ...(rawId ? { public_model_id: rawId } : {}),
    ...(legacy.length ? { legacy_ids: legacy } : {}),
  }
}

export interface GenStudioTranscriptionModel extends GenStudioCatalogLock, GenStudioPriceTruth {
  id: string
  display_name: string
  /**
   * The legacy single provider field. Kept because gateway-kh publishes it
   * alongside `provider_name` on transcription rows so older readers keep
   * working; `provider_name` is the field the shared contract moved to.
   */
  provider: string
  /**
   * The serving provider, as GenStudio publishes it.
   *
   * This arrived on transcription and video rows and was DISCARDED here until
   * 2026-09-18: the field was neither declared nor read, so a published fact was
   * thrown away at the parse boundary and every row rendered a blank provider.
   * `AGENTS.md`'s Provider Transparency section requires a published provider be
   * shown, so the fix is to carry it, never to derive one. Empty means not
   * published — never the gateway's own name, and never guessed from the id.
   */
  provider_name?: string
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
  cost_tier?: GenStudioCostTier
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
export interface GenStudioImageModel extends GenStudioCatalogLock, GenStudioPriceTruth, GenStudioProductAliases {
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
  chargeable?: boolean
  cost_tier?: GenStudioCostTier
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
  /** GenStudio requires a short-lived placement permit before paid submission. */
  requires_admission_permit?: boolean
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
  /** See `GenStudioSettledJobShape`. Optional; absent on older APIs. */
  failure_reason?: string | null
  failure_class?: string | null
  routing_status_code?: string | null
  /** `ImageJobResponse` publishes a released reservation when it has one. */
  credit_cost?: number
  remaining_credits?: number
  settled_credits?: number | null
  released_credits?: number | null
  cancellable?: boolean | null
  cancelled?: boolean | null
  cancellation_note?: string | null
  queue_position?: number | null
  queue_eta_seconds?: number | null
  queue_reason?: 'provider_pace' | null
  recovery_required?: boolean | null
  recovery_state?: string | null
  waiting?: GenStudioWaiting | null
  idempotent_replay?: boolean
  image_url?: string | null
}

/**
 * `ImageGenerationRequest` — prompt, model_id, aspect_ratio, resolution, seed,
 * reference_asset_ids. There is no `steps` field: inference steps are not a
 * customer control, and Story Studio does not send one.
 */
export interface GenStudioImageRequest extends GenStudioOperationContext {
  /** 1.4.295 — scene images go as Gateway `background` (owner: thumbnails first, songs next, scene images last). Not in the idempotency key. */
  priority?: 'background'
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
  /** `jpeg` asks the lane for a JPEG instead of a PNG. Absent = native (today's behaviour). */
  outputFormat?: 'jpeg'
  /** Stable for this Story Studio submission, distinct for a deliberate rerender. */
  requestIdentity?: string
  /** Reuse a key checkpointed before the charged image POST. */
  idempotencyKey?: string
  /** Revalidate owner-controlled authority at the final charged POST boundary. */
  beforeSubmit?: () => void | Promise<void>
  /** Live image-catalog policy. Absent/false preserves the legacy direct route. */
  requiresAdmissionPermit?: boolean
  onState?: (state: GenStudioJob['state']) => void
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
}

export interface GenStudioImageResult {
  url: string
  jobId: string
  modelId: string
  settledCredits?: number
}

interface GenStudioTranscriptionJob {
  id: string
  state: GenStudioJob['state']
  model_id: string
  failure_code?: string | null
  /** See `GenStudioSettledJobShape`. Optional; absent on older APIs. */
  failure_reason?: string | null
  failure_class?: string | null
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
  queue_position?: number | null
  queue_eta_seconds?: number | null
  queue_reason?: 'provider_pace' | null
  recovery_required?: boolean | null
  recovery_state?: string | null
  waiting?: GenStudioWaiting | null
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
  /** Persist and authorize the exact live quote before its charged confirmation. */
  beforeConfirm?: (quote: GenStudioTranscriptionQuote) => void | Promise<void>
  /** A route obtained this exact quote for the same action-scoped audio bytes. */
  preparedQuote?: GenStudioTranscriptionQuote
  /** Serialize authorization and the physical confirmation with policy mutations. */
  withConfirm?: (confirm: () => Promise<Response>) => Promise<Response>
  onState?: (state: GenStudioTranscriptionJob['state'], jobId: string) => void | Promise<void>
  onJobAccepted?: (jobId: string, idempotencyKey: string, fileSha256: string) => void | Promise<void>
}

export interface GenStudioTranscriptionQuote {
  id: string
  quoted_credit_cost?: number
  price_version?: string
  expires_at?: string
}

/** Quote one exact audio file without confirming provider work. */
export async function quoteGenStudioTranscription(
  apiKey: string,
  request: Pick<GenStudioTranscriptionRequest, 'audioPath' | 'modelId' | 'requestIdentity' | 'idempotencyKey' | 'language' | 'wordTimestamps'>,
): Promise<{ quote: GenStudioTranscriptionQuote; idempotencyKey: string; fileSha256: string }> {
  const modelId = request.modelId.trim()
  if (!modelId || !request.requestIdentity.trim()) throw new Error('A model and stable transcription identity are required for a quote.')
  const file = await fs.readFile(request.audioPath)
  if (!file.length || file.length > GENSTUDIO_MAX_TRANSCRIPTION_BYTES) throw new Error('Transcription audio is empty or exceeds the qualification limit.')
  const fileSha256 = createHash('sha256').update(file).digest('hex')
  const idempotencyKey = request.idempotencyKey?.trim() || buildGenStudioTranscriptionIdempotencyKey({
    requestIdentity: request.requestIdentity, fileSha256, modelId, language: request.language, wordTimestamps: request.wordTimestamps,
  })
  const body = new FormData()
  body.set('file', new Blob([new Uint8Array(file)], { type: transcriptionMediaType(request.audioPath) }), path.basename(request.audioPath))
  body.set('model', modelId)
  if (request.language) body.set('language', request.language)
  body.set('word_timestamps', String(request.wordTimestamps === true))
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const quote = await submitJsonWithAdmission(apiKey, `${apiBase(baseUrl)}/v1/audio/transcriptions/quotes`, {
    method: 'POST', headers: { ...authorization(apiKey), 'Idempotency-Key': idempotencyKey }, body,
  }, {}, deadline, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS) as GenStudioTranscriptionQuote
  if (!quote.id) throw new Error('The Gateway did not return a price for this transcription.')
  return { quote, idempotencyKey, fileSha256 }
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
    /**
     * How the words are read — present ONLY when the selected model publishes
     * the delivery/emotion control and the instruction is non-empty.
     */
    delivery_instruction?: string
    /** Present ONLY when the owner asked for compressed narration (`m4a`). */
    output_format?: 'm4a'
    /** Present ONLY when set and the selected model publishes it (`pause_parameters`). */
    paragraph_pause_sec?: number
    sentence_pause_sec?: number
  }
  idempotencyKey: string
}

/** Join pauses for one TTS request, by the name the Gateway publishes. */
export type TtsPauseValues = { paragraph_pause_sec?: number; sentence_pause_sec?: number }

/** `TTSModelResponse.pause_parameters[]`: a join pause this model takes, with its own bounds. */
export interface GenStudioTtsPauseParameter {
  name: 'paragraph_pause_sec' | 'sentence_pause_sec'
  minimum: number | null
  maximum: number | null
  default: number | null
}

function parseTtsPauseParameters(value: unknown): GenStudioTtsPauseParameter[] {
  if (!Array.isArray(value)) return []
  const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return value.flatMap((row: any): GenStudioTtsPauseParameter[] =>
    row?.name === 'paragraph_pause_sec' || row?.name === 'sentence_pause_sec'
      ? [{ name: row.name, minimum: number(row.minimum), maximum: number(row.maximum), default: number(row.default) }]
      : [])
}

/**
 * The pauses to send: each wanted value the model publishes, clamped to its published range.
 * A pause the model does not publish is not sent (the Gateway would only drop it).
 */
export function resolveTtsPauses(
  published: GenStudioTtsPauseParameter[] | undefined,
  wanted: { paragraph?: number | null; sentence?: number | null },
): { pauses: TtsPauseValues; unsupported: Array<'paragraph' | 'sentence'> } {
  const pauses: TtsPauseValues = {}
  const unsupported: Array<'paragraph' | 'sentence'> = []
  for (const boundary of ['paragraph', 'sentence'] as const) {
    const value = wanted[boundary]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    const parameter = (published || []).find(p => p.name === `${boundary}_pause_sec`)
    if (!parameter) { unsupported.push(boundary); continue }
    const clamped = Math.min(parameter.maximum ?? value, Math.max(parameter.minimum ?? 0, value))
    pauses[`${boundary}_pause_sec`] = Math.round(clamped * 1000) / 1000
  }
  return { pauses, unsupported }
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
  /**
   * Whether using this voice can cost money, exactly as `story_row` publishes
   * it. Absent means the Gateway said nothing — never read as `false`.
   */
  chargeable?: boolean
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
export interface GenStudioTtsModel extends GenStudioCatalogLock, GenStudioPriceTruth, GenStudioProductAliases {
  id: string
  display_name: string
  provider_id: string
  provider_name: string
  description: string
  credits_per_1000_characters: number
  minimum_credits: number
  maximum_input_characters: number
  supports_speed: boolean
  /** Published numeric speed bounds. Absent means GenStudio did not publish a usable range. */
  minimum_speed: number | null
  maximum_speed: number | null
  supports_voice_cloning: boolean
  preview_policy: string
  generation_enabled: boolean
  standard_credits: number | null
  sale_credits: number | null
  sale_ends_at: string | null
  sale_disclaimer: string | null
  queue_class: 'direct' | 'relaxed'
  relaxed_queue_hint: GenStudioRelaxedQueueHint | null
  /** Exact language codes sold by this product. Empty means GenStudio did not publish a list. */
  supported_languages: string[]
  cost_tier?: GenStudioCostTier
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
  /**
   * The delivery/emotion control THIS model publishes, with the model's own
   * guidance inside it, or `null` when the Gateway published none for it
   * (owner, 2026-10-29). Read from the model's own `controls[]` — never from a
   * model or provider name — and re-read on every catalogue read, so a model
   * that gains or loses the capability gains or loses the setting with it.
   * `null` means: no setting is shown, and no instruction is sent.
   */
  delivery_instruction: GenStudioDeliveryInstructionControl | null
  /** `TTSModelResponse.pause_parameters[]`; empty = this model takes no join-pause request. */
  pause_parameters?: GenStudioTtsPauseParameter[]
}

/** `GET /v1/music/models` — an account-visible music product published by GenStudio. */
export interface GenStudioMusicModel extends GenStudioCatalogLock, GenStudioPriceTruth {
  id: string
  display_name: string
  /** Display only; absent means GenStudio published no provider. */
  provider_name?: string
  description: string
  coming_soon: boolean
  credits_per_request: number
  minimum_credits: number
  price_version: string
  /** Explicit published billing truth. Absent means the catalog did not publish it. */
  chargeable?: boolean
  cost_tier?: GenStudioCostTier
  standard_credits: number | null
  sale_credits: number | null
  sale_ends_at: string | null
  sale_disclaimer: string | null
  /**
   * Capability facts. `null` means GENSTUDIO PUBLISHED NOTHING — it is not
   * `false`, and it is never a local guess at what the model can do.
   *
   * These were declared non-nullable and treated as required, so a row that
   * omitted them was DROPPED — which is how `kie-ai-images::V6` (Suno V6), the
   * only published music model, disappeared from the picker entirely while the
   * endpoint was serving it. Absence is a legitimate publication, distinct from
   * a malformed value; only the latter should cost the row.
   */
  supports_instrumental: boolean | null
  supports_vocals: boolean | null
  requires_lyrics: boolean | null
  max_prompt_characters: number
  max_prompt_without_lyrics_characters: number | null
  min_prompt_characters: number | null
  max_lyrics_characters: number
  min_lyrics_characters: number | null
  max_title_characters: number
  outputs_per_request: number | null
  /** The model's own track-length bounds and default, when the lane publishes them. Absent is unknown. */
  min_duration_seconds?: number
  max_duration_seconds?: number
  default_duration_seconds?: number
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
  maximum_credits?: number | null
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
  cost_tier?: GenStudioCostTier | GenStudioLlmCostTier
}

/**
 * What GenStudio's relaxed shelf promises, published as three separate values.
 *
 * Two of them are numbers the owner moves and the third is wording he
 * rewrites, so they arrive apart and are rendered apart. Story Studio must
 * never interpolate the numbers into `message`: he may reword the sentence
 * into a shape where they no longer fit, and a client that had spliced them
 * in would then be showing a sentence he never wrote.
 *
 * Nothing here is ever authored locally. No percentage, no threshold and no
 * copy of the sentence exists anywhere in this app — a hint GenStudio does not
 * send is a hint that is not shown.
 */
export interface GenStudioRelaxedQueueHint {
  /** Read off the LIVE sale, never declared, so it cannot advertise a
   *  reduction the till would not give. */
  discount_percent: number
  /** Lifetime top-ups, in cents, that switch the lower price on permanently. */
  unlock_threshold_cents: number
  /** The owner's own copy, containing neither number. Rendered verbatim. */
  message: string
}

/**
 * Whose figure a published limit is.
 *
 * The gateway labels every limit with where it came from, and the two producers use
 * overlapping vocabularies on purpose (HUB-20):
 *
 *   - a **cloud** row says `provider` (the model's own file or API stated it),
 *     `curated` (the owner's `model-limits.local.json` filled a silence) or
 *     `gateway` (a default of the gateway's own);
 *   - a **Studio Hub** row says `model` (the checkpoint's own file states it),
 *     `worker_default` (the Hub's own fallback), `curated` (the Hub's packaged
 *     metadata) or `unknown` (nothing states it, and the value travels as null).
 *
 * A number is still a number; this is what says whether the *model* stated it. The
 * difference matters where the UI would otherwise print a worker's fallback as the
 * model's own figure — the failure this field exists to end.
 */
export type GenStudioLimitSource =
  | 'provider' | 'model' | 'curated' | 'gateway' | 'worker_default' | 'unknown'

const GENSTUDIO_LIMIT_SOURCES: readonly GenStudioLimitSource[] = [
  'provider', 'model', 'curated', 'gateway', 'worker_default', 'unknown',
]

/**
 * Read a limit's provenance, or null.
 *
 * Null means "nobody labelled it" — which is NOT a synonym for `provider`. A caller
 * that renders a sentence has to distinguish "the model said so" from "we were not
 * told", and folding an absent label into `provider` is how a worker default gets
 * printed as the model's own number.
 */
export function readPublishedLimitSource(value: unknown): GenStudioLimitSource | null {
  if (typeof value !== 'string') return null
  const token = value.trim().toLowerCase()
  return (GENSTUDIO_LIMIT_SOURCES as readonly string[]).includes(token)
    ? token as GenStudioLimitSource
    : null
}

export interface GenStudioChatModel extends GenStudioCatalogLock, GenStudioPriceTruth, GenStudioProductAliases {
  id: string
  /** Published by gateway 0.2.100+: may this model cost money? Absent = not published. */
  chargeable?: boolean
  display_name: string
  /** Published model creator/provider label. Absent until GenStudio supplies it. */
  provider_name?: string
  /**
   * The provider KIND, as the catalogue publishes it (`openrouter-main`,
   * `google-ai`, `anthropic-direct`, …).
   *
   * Carried because one adapter's behaviour differs by kind and by no other
   * published fact: the Gateway's Anthropic adapter emits OpenAI `image_url`
   * blocks, which Anthropic refuses, so an Anthropic row cannot serve an image
   * request (FINDINGS 2026-10-27 §1). That is a statement about the published
   * provider id — never a guess from a model id or a display name (§2).
   */
  provider_id?: string
  description?: string
  available: boolean
  /** GenStudio's published reason for a temporarily unavailable row. */
  /** GenStudio's published future availability time, normalized to ISO. */
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
  /** Published input character ceiling, when the chat product states one. */
  max_prompt_characters?: number
  /**
   * Maximum selectable output allowance published for this product.
   *
   * 0 means "not published" — same contract as `context_window_tokens`.
   * Story Studio never substitutes a figure of its own here; a product that
   * publishes no output ceiling is submitted without `max_output_tokens`.
   */
  max_output_tokens: number
  /**
   * Whose `max_output_tokens` that is — the model's own figure, a curated default, a
   * worker's fallback, or nothing stated at all (`null`).
   *
   * Carried so the surfaces that show the allowance can say so. A Studio Hub row's
   * 16,384 is `worker_default` when the checkpoint ships no `generation_config.json`
   * (measured live 2026-09-26), and a UI that printed it bare would be presenting the
   * Hub's fallback as the model's own ceiling.
   */
  max_output_tokens_source: GenStudioLimitSource | null
  /** Published structured-item ceiling. Null means unmeasured, never unlimited. */
  max_structured_items_per_request: number | null
  controls: string[]
  activation_blockers: string[]
  input_credits_per_million_tokens?: number
  output_credits_per_million_tokens?: number
  minimum_credits: number
  price_version: string
  cost_tier?: GenStudioLlmCostTier
  /**
   * GenStudio offers some products at a reduced price in exchange for a data
   * arrangement, and publishes both the flag and the exact sentence describing
   * it. This is NOT `sale_disclaimer`, which is a price-promotion notice on a
   * different catalogue and means something else entirely.
   *
   * The wording is never copied into this app. GenStudio keeps one constant
   * shared between its picker and its terms page, pinned by a test, precisely
   * because softening a word — dropping "by us", or "training" becoming
   * "improving" — changes what a customer was told they agreed to. A second
   * copy here would be a second source of truth, and it would drift.
   */
  discount: boolean
  /** Published verbatim, or null when this product carries no such notice. */
  discount_disclaimer: string | null
  // ── The shelf this product sells on ───────────────────────────────────
  /**
   * `relaxed` products are the same models sold cheaper for accepting a
   * slower queue. This is the ONLY thing a picker may group by: the words
   * "(Relaxed Queue)" inside a display name are copy the owner edits, so a
   * catalogue that grouped by searching for the phrase would silently regroup
   * itself the next time he reworded a product.
   *
   * Additive. A GenStudio that has never heard of the field reads `direct`
   * for every product, which is the truth — one undivided catalogue, exactly
   * as this app showed before — and never a guess.
   */
  queue_class: 'direct' | 'relaxed'
  /** Sent on relaxed rows only, and only while one is genuinely on sale.
   *  Null everywhere else, including on a GenStudio that predates the field.
   *  See `GenStudioRelaxedQueueHint` — nothing in it is written locally. */
  relaxed_queue_hint: GenStudioRelaxedQueueHint | null
  /**
   * The undiscounted per-million-token rates, present only while a sale is
   * live AND this account is entitled to it. The two rate fields above are
   * what THIS account pays, sale included — so these are the "was" prices and
   * the fields above are the "now" prices.
   *
   * Null is a real answer meaning no sale is being applied, and the picker
   * then shows one price rather than inventing a struck-through one.
   */
  standard_input_credits_per_million_tokens: number | null
  standard_output_credits_per_million_tokens: number | null
  /** Undiscounted published request minimum, when the catalogue supplies it. */
  standard_minimum_credits?: number | null
  // ── Published retirement schedule ─────────────────────────────────────
  // GenStudio records when a product stops being sellable and what replaces
  // it, and publishes the whole schedule on every catalogue row. Story Studio
  // read none of it, so the only thing it could ever say about a retirement
  // was said AFTER the fact — "this model is retired or unavailable" — at the
  // moment the customer's saved choice had already stopped working.
  //
  // Every field here is READ. Story Studio never computes a retirement date,
  // never decides when a warning starts, and never names a successor: those
  // are GenStudio's calls, and a second copy of them here would go stale the
  // day GenStudio moved a date.
  /** GenStudio has opened the warning window for this product. The window's
   *  length is GenStudio's decision, not this app's — read the flag, never
   *  re-derive it from the dates below. */
  deprecation_warning: boolean
  /** When that window opened. Null when it has not, or on an older GenStudio. */
  deprecation_warning_at: string | null
  /** GenStudio's internal target for taking the product out of service. */
  scheduled_retirement_at: string | null
  /** When the ORIGINAL provider shuts the model down. Deliberately later than
   *  `retires_at`: GenStudio withdraws first so a customer meets an absence
   *  rather than a failure. Carried, never shown — the customer's date is
   *  `retires_at`, and showing two dates would only invite the wrong one to be
   *  planned against. */
  upstream_shutdown_at: string | null
  /** The moment the product stops being available to customers. This is the
   *  date a customer needs, and it is deliberately not the same as the
   *  provider's own shutdown: GenStudio withdraws first, on purpose, so a
   *  customer meets an absence rather than a failure. */
  retires_at: string | null
  /** The product GenStudio records as this one's successor, as a catalogue id.
   *  Resolve it to a display name against the same catalogue before showing
   *  it — an id is not a thing to put in front of a customer. Null when
   *  GenStudio records no successor. */
  replacement_model_id: string | null
  input_modalities: Array<'text' | 'image'>
  supports_vision: boolean
  max_input_images: number
  accepted_image_mime_types: string[]
  max_image_bytes: number
  max_image_dimension: number
  supported_detail_levels: Array<'low' | 'high' | 'auto'>
  supports_structured_output: boolean
  /**
   * v1.4.37 — `'none'` is now representable, and that is the whole point.
   *
   * This union used to be `'json_object' | 'request_json_schema'`, and the
   * parser collapsed everything that was not `request_json_schema` into
   * `json_object`. A product publishing `structured_output_mode: 'none'` —
   * 459 of the 496 in the catalogue — therefore read to Story Studio as
   * "can return JSON objects". It cannot. GenStudio can only ask it in the
   * prompt and reject what comes back, which is why a Scene Plan on such a
   * model returns valid JSON for two packs of 40 and prose for the third.
   */
  structured_output_mode: 'none' | 'json_object' | 'request_json_schema'
  // ── Live web-search capability (published per product) ────────────────
  // Story Studio selects a web-research product by CAPABILITY ONLY. Never
  // infer any of this from a provider or model name.
  /** The product can run provider-side web searches. */
  supports_web_search: boolean
  /** The product returns citations for what it searched.
   *
   *  `null` means the provider did not state it — which is the case for every
   *  row today. It is deliberately NOT flattened to `false`: "this provider
   *  does not cite" and "this provider did not say" are different facts
   *  (AGENTS.md §6), and the gateway now publishes the distinction.
   *
   *  The one consumer that gates a FEATURE keeps testing `=== true`, and that
   *  is correct — a capability must not be enabled on an unstated value. What
   *  changes is that a reader can now tell the two apart instead of being told
   *  a provider said "no" when it said nothing. */
  returns_citations: boolean | null
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
  /** GenStudio operation this exact duration/resolution/price row belongs to. */
  operation: string
  duration_seconds: number
  resolution: string
  /**
   * The aspect ratio this exact variant has, where GenStudio publishes one.
   *
   * A Studio Hub video lane publishes canvases as pairs — its `448p` class carries
   * 704x448 (11:7) and 448x448 (1:1) — so `(duration, resolution)` alone names two
   * different pictures and this field is what tells them apart. Absent means the
   * product states none (every cloud video lane), which is not the same as 16:9 and
   * must never be defaulted to one here.
   */
  aspect_ratio?: string
  credits_per_video: number
  minimum_credits: number
  price_version: string
}

export interface GenStudioVideoModel extends GenStudioCatalogLock, GenStudioPriceTruth, GenStudioProductAliases {
  id: string
  display_name: string
  description?: string
  /**
   * The serving provider, as GenStudio publishes it.
   *
   * Video rows published NO provider field at all until gateway-kh fixed it
   * (2026-09-18), and this transport had no declaration to receive it either —
   * so the row would have read as a blank provider the moment the gateway
   * started sending one, without anything failing. `AGENTS.md`'s Provider
   * Transparency section requires a published provider be shown. Empty means
   * not published; never derived from the model id.
   */
  provider_name?: string
  available: boolean
  cost_tier?: GenStudioCostTier
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
  /**
   * The lane's own **switches**: every boolean parameter GenStudio publishes for
   * this row, with the lane's default and the lane's own sentence about it.
   *
   * A switch is a choice, not a capability, and the distinction is the reason
   * this is a separate field from `generates_audio`. `generates_audio: true`
   * says the product makes a soundtrack; it says nothing about whether the
   * caller may ask for a clip WITHOUT one. Measured on 2026-09-27: a local Studio Hub
   * video lane published `audio` (default `true`, note and all) and no cloud video
   * lane publishes any switch, so the control must be rendered from this list
   * and never from a name Story Studio knows.
   *
   * Absent means the catalogue published none — which is NOT an empty list, and
   * a caller must be able to tell them apart. `note` is relayed verbatim: the
   * lane knows what unticking its switch does and this app does not.
   */
  controls?: GenStudioVideoControl[] | null
}

/** One published boolean switch on a video row. */
export interface GenStudioVideoControl {
  name: string
  type: 'boolean'
  /** The lane's own default, or `null` when it stated none. */
  default: boolean | null
  /** The lane's own sentence, shown verbatim. `null` when it wrote none. */
  note: string | null
}

/** Story Studio supported video modes. */
export const STORY_STUDIO_VIDEO_MODES = ['image-to-video', 'text-to-video'] as const
export type StoryStudioVideoMode = typeof STORY_STUDIO_VIDEO_MODES[number]

/** Story Studio's legacy video mode default. */
export const STORY_STUDIO_VIDEO_MODE = 'image-to-video'

/** Does this model publish the mode Story Studio actually submits? */
export function supportsGenStudioVideoMode(
  model: Pick<GenStudioVideoModel, 'modes'>,
  mode?: string,
): boolean {
  if (!Array.isArray(model.modes)) return false
  if (mode) return model.modes.includes(mode)
  return model.modes.some(m => STORY_STUDIO_VIDEO_MODES.includes(m as any))
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

/** Keep variants in their published operation lane before choosing a price or pair. */
export function variantsForGenStudioVideoOperation(
  variants: readonly GenStudioVideoVariant[] | undefined | null,
  operation: string,
): GenStudioVideoVariant[] {
  return Array.isArray(variants) ? variants.filter(variant => variant.operation === operation) : []
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
 * Gateway 0.2.195 publishes the SAME job contract on every route, this one
 * included: `_contract_fields` adds `dispatch_state`, `cancellable`,
 * `cancellation_requested`, `cancelled` and `waiting` to the chat envelope,
 * and `POST /v1/chat/responses/{id}/cancel` settles a chat job the same way it
 * settles any other. The older note here — that this route publishes no
 * cancelled flag and no cancel endpoint — described a Gateway that no longer
 * exists. What the chat lane then did with those fields was the real defect:
 * it read the `cancelled` flag but never recorded it, so a cancelled writing
 * job was filed as an ordinary provider FAILURE (and could not be offered a
 * cancel at all, because the dispatch state never arrived either).
 *
 * `cancelled` is a TERMINAL state on this route too (`TERMINAL_STATES` is
 * `succeeded | failed | cancelled` for every modality). The transport maps it
 * onto Story's own vocabulary before it reaches this lane — `state: 'failed'`
 * beside `cancelled: true` — so the flag below, not the state, is what says a
 * writing job was cancelled.
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
  /** The provider's own count for this answer. Present on the settled job —
   *  `verified_token_usage` beside it says whether it was re-measured. */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
  verified_token_usage?: boolean | null
  failure_code?: string | null
  failure_detail?: string | null
  /**
   * The Gateway's own words for this failure, published verbatim
   * (`_job_envelope`, Gateway 0.2.195). Story forwards them as published and never
   * writes a substitute: absent means the Gateway published nothing, which is not
   * the same as "no reason".
   */
  failure_reason?: string | null
  /** The Gateway's classification for this failure, published verbatim. */
  failure_class?: string | null
  retry_after_seconds?: number | null
  retry_at?: string | null
  routing_status_code?: string | null
  credit_cost?: number
  cost_usd?: number
  cost_source?: 'provider'
  remaining_credits?: number
  price_version?: string | null
  /** True when this response replayed an existing job for the same key. */
  idempotent_replay?: boolean | null
  queue_position?: number | null
  queue_eta_seconds?: number | null
  queue_reason?: 'provider_pace' | null
  recovery_required?: boolean | null
  recovery_state?: string | null
  waiting?: GenStudioWaiting | null
  /**
   * The Gateway's job contract, published on this route exactly as on every
   * other (`_contract_fields`, Gateway 0.2.195). These are READ verbatim: the
   * Gateway decides what a cancel would do, and Story never derives them from
   * the state, the modality or the model.
   */
  /** `pre_dispatch` — nothing has been sent upstream yet; `dispatched` — it has. */
  dispatch_state?: 'pre_dispatch' | 'dispatched'
  /** The Gateway's own promise that a cancel is honoured RIGHT NOW. */
  cancellable?: boolean | null
  /** True once the Gateway settled this job as cancelled. Terminal. */
  cancelled?: boolean | null
  /** True once a cancel was recorded for this job. */
  cancellation_requested?: boolean | null
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
  /** `VideoJobResponse` publishes cancellation booleans and released credits. */
  released_credits?: number | null
  cancellation_requested?: boolean
  cancelled?: boolean
}

export interface GenStudioVideoRequest extends GenStudioOperationContext {
  prompt: string
  modelId: string
  sourceImagePath?: string
  /**
   * The aspect ratio to submit, from the resolved variant's own published ratio.
   *
   * Optional on purpose: a product that publishes no ratio (per variant, or at all) gets
   * no `aspect_ratio` field, so the lane's own default decides. Sending a hardcoded
   * 16:9 there is how a Studio Hub lane whose smallest widescreen canvas is 11:7 was
   * asked for a canvas it does not publish.
   */
  aspectRatio?: string
  /** Exact published operation for the selected variant. */
  operation: string
  /** Taken from a variant the model PUBLISHES. Not a literal union: the
   *  catalogue owns the list, and the caller resolves against it. */
  durationSeconds: number
  resolution: string
  /**
   * The lane's published `audio` switch, when the caller wants it OFF.
   *
   * Only `false` is ever sent, and only when the selected model publishes the
   * switch: a lane that publishes none gets no field at all, so its own default
   * decides rather than this app deciding for it. `true` travels as nothing
   * because the lane's own default is what a caller who wants sound gets — and
   * unticking it does **not** shorten the run (the model denoises picture and
   * sound together), which is why the lane's own note is shown beside the
   * switch instead of a invented promise about time saved.
   */
  audio?: boolean
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
  app_links: {
    billing: string | null
  }
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
  burst_concurrency_ceiling?: number
  service_tier?: GenStudioServiceTierStanding
  total_jobs: number
  active_jobs: number
  completed_jobs: number
  failed_jobs: number
  available_assets: number
  next_asset_expiration: string | null
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseBillingAppLink(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? value : null
  } catch {
    return null
  }
}

function parseServiceTier(value: unknown): GenStudioServiceTier | undefined {
  const tier = objectRecord(value)
  const code = typeof tier?.code === 'string' && tier.code.trim() ? tier.code : undefined
  const display_name = typeof tier?.display_name === 'string' && tier.display_name.trim()
    ? tier.display_name
    : undefined
  const threshold_cents = nonNegativeInteger(tier?.threshold_cents)
  const paid_concurrency_limit = positiveInteger(tier?.paid_concurrency_limit)
  const max_queued_jobs = positiveInteger(tier?.max_queued_jobs)
  const generation_submissions_per_minute = positiveInteger(tier?.generation_submissions_per_minute)
  const max_api_keys = positiveInteger(tier?.max_api_keys)
  return code && display_name && threshold_cents !== undefined && paid_concurrency_limit
    && max_queued_jobs && generation_submissions_per_minute && max_api_keys
    ? {
        code,
        display_name,
        threshold_cents,
        paid_concurrency_limit,
        max_queued_jobs,
        generation_submissions_per_minute,
        max_api_keys,
      }
    : undefined
}

function parseServiceTierStanding(value: unknown): GenStudioServiceTierStanding | undefined {
  const standing = objectRecord(value)
  const current = parseServiceTier(standing?.current)
  const ladder = parseServiceTier(standing?.ladder)
  const floorPublished = !!standing && Object.hasOwn(standing, 'floor')
  const floor = !floorPublished
    ? undefined
    : standing!.floor === null
      ? null
      : parseServiceTier(standing!.floor)
  const floorValid = !floorPublished || floor === null || floor !== undefined
  const lifetime_paid_cents = nonNegativeInteger(standing?.lifetime_paid_cents)
  const next_tier = standing?.next_tier === null ? null : parseServiceTier(standing?.next_tier)
  const cents_to_next_tier = standing?.cents_to_next_tier === null
    ? null
    : nonNegativeInteger(standing?.cents_to_next_tier)
  return current && ladder && floorValid && typeof standing?.overridden === 'boolean'
    && lifetime_paid_cents !== undefined && next_tier !== undefined && cents_to_next_tier !== undefined
    ? {
        current,
        ladder,
        ...(floorPublished ? { floor: floor ?? null } : {}),
        overridden: standing.overridden,
        lifetime_paid_cents,
        next_tier,
        cents_to_next_tier,
      }
    : undefined
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

/**
 * One content part in a chat turn, OpenAI-style.
 *
 * This is the wire vocabulary the Gateway's chat path actually forwards:
 * `adapters/openai_compat.py` keeps `image_url` parts and drops unknown ones,
 * `google` reuses that same normaliser, and `anthropic` refuses it. Nothing
 * here is invented — `input_image` / asset ids have no Gateway field at all
 * (FINDINGS 2026-10-27 §1).
 */
export type GenStudioChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

/** One chat turn. Text-only turns keep the plain string every existing caller sends. */
export type GenStudioChatMessage = { role: string; content: string | GenStudioChatContentPart[] }

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
   * short-form, which is the historical 2,048-token default; a product that
   * publishes no ceiling is submitted without this field.
   */
  outputBudget?: OutputBudget
  /**
   * How long this request's answer is expected to be, in output tokens.
   *
   * **A hint, and the only number here that is not an allowance.** Studio Hub sizes each chat
   * job's deadline from what the job actually is — its prompt, its expected answer, that Mac's
   * measured decode rate — and it cannot tell a 100-prompt scene pack from a one-line question
   * by reading the body. Sizing every job from `max_tokens` instead would make every job three
   * hours long, so this travels as `expected_output_tokens` and is omitted when unstated.
   */
  expectedOutputTokens?: number
  requestIdentity?: string
  idempotencyKey?: string
  /**
   * Read an existing durable request by its saved idempotency key. This is
   * recovery only: a missing or unreachable lookup never falls through to POST.
   */
  recoverByIdempotencyKey?: boolean
  /** Saved-key recovery only: a lost request is rethrown to the caller instead of resent here, so it can read every other saved key first. */
  deferLostResend?: boolean
  /** One manual Retry may repost a server-proven never-created request. */
  allowUncreatedRecovery?: boolean
  /** Retained server preview that must match the newly prepared wire request exactly. */
  recoveryRequestPreview?: GenStudioRequestPreview
  /** Server-recorded pending keys allowed to use read-only recovery. */
  allowedRecoveryKeys?: string[]
  /** Persist the derived idempotency key before a charged POST can begin. */
  onRequestPrepared?: (idempotencyKey: string, preview?: GenStudioRequestPreview) => void | Promise<void>
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
  onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
  /**
   * One picture for a vision-capable chat product, as an OpenAI-style
   * `image_url` data URI (`data:image/jpeg;base64,…`).
   *
   * The image rides INSIDE the turn's content parts because the Gateway's chat
   * path has no image-asset field and never had one — `input_image` was an
   * invented field this app refused before the wire (FINDINGS 2026-10-27 §1).
   * The Gateway forwards `image_url` parts unchanged to OpenRouter and Google;
   * its Anthropic adapter cannot convert them, so an Anthropic row is refused
   * before submission (see `chatProductAcceptsImages`).
   *
   * `sha256` is the digest of the encoded JPEG bytes behind `dataUri`, and it is
   * the only thing the idempotency key hashes: a megabyte of base64 in the key
   * would be slow to compute and impossible to read back.
   */
  inputImage?: { dataUri: string; sha256: string; detail?: 'low' | 'high' | 'auto' }
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
  /**
   * The provider's own completion-token count for THIS answer, when reported.
   *
   * Story Studio needs it because `finish_reason` alone is not trustworthy on
   * every lane: a Studio Hub worker whose own 4,096-token fallback cut a
   * chapter short still reported `finish_reason: "stop"` (measured live,
   * 2026-09-26, during the STORY-2 acceptance run), and the truncated text was
   * written to disk as a finished chapter. Usage is the signal that survived.
   */
  completion_tokens?: number | null
  /** The output ceiling the request carried, when it carried one. */
  requested_max_output_tokens?: number | null
}

/**
 * Did this answer use up the entire ceiling the request asked for?
 *
 * True only when BOTH numbers are known: a request that carried no ceiling
 * (owner decision #6) can never be judged this way, and `undefined`/`null`
 * usage stays "unknown", never "complete" by default. Equality counts: the
 * provider stops *at* the cap, so an answer that used exactly the ceiling is
 * the truncated case, not a coincidence to be explained away.
 */
function hitOutputCeiling(job: GenStudioIncompleteOutput): boolean {
  const ceiling = job.requested_max_output_tokens
  const used = job.completion_tokens
  return typeof ceiling === 'number' && Number.isInteger(ceiling) && ceiling > 0
    && typeof used === 'number' && Number.isInteger(used) && used >= ceiling
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
  return !!reason && /^(length|max_tokens|max_output_tokens|token_limit|language_provider_incomplete)$/i.test(reason.trim())
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
    const truncatedByReason = isTruncationFinishReason(finishReason)
    // A ceiling-hit answer whose provider still said "stop" (Studio Hub does
    // this) is the same defect from the customer's side: the text stops
    // mid-sentence. Detected from usage because the finish reason cannot be
    // trusted — see `GenStudioIncompleteOutput.completion_tokens`.
    const truncatedByUsage = !truncatedByReason && hitOutputCeiling(job)
    const truncated = truncatedByReason || truncatedByUsage
    super(
      truncatedByUsage
        ? 'The answer was cut off before it finished: it used the entire output-token ceiling this '
          + `request asked for (${job.completion_tokens} of ${job.requested_max_output_tokens}), even though `
          + `the provider reported finish_reason "${finishReason ?? 'none'}". Story Studio did not return the `
          + 'partial answer as a finished result. Choose a language product with a larger published '
          + 'output limit, or make the request smaller (fewer chapters, scenes, or items per run), '
          + 'then run it again.'
        : truncatedByReason
        // The user has two real levers here, so name both. "Try again" is not
        // one of them: the same request against the same ceiling truncates
        // again at the same place.
        ? 'The answer was cut off before it finished: this request hit its output-token ceiling '
          + `(The Gateway reported finish_reason "${finishReason}"). Story Studio did not return the `
          + 'partial answer as a finished result. Choose a language product with a larger published '
          + 'output limit, or make the request smaller (fewer chapters, scenes, or items per run), '
          + 'then run it again.'
        : `The Gateway reported incomplete chat output${finishReason ? ` (${finishReason})` : ''}. `
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
 * GenStudio's durable route settles a response that ran out of output as a
 * failed job with `LANGUAGE_PROVIDER_INCOMPLETE`, while older/compatible
 * envelopes may instead be `succeeded` with `finish_reason: "length"`.
 * Normalize both forms to the same typed signal so chunked narration can keep
 * parseable chapters and repair only the unfinished slots. This is deliberately
 * an exact code check: generic provider failures and ambiguous submissions
 * remain terminal and are never auto-resubmitted.
 */
function durableIncompleteChatError(job: GenStudioChatJob): GenStudioChatIncompleteError | null {
  if (typeof job.failure_code !== 'string' || job.failure_code.trim().toUpperCase() !== 'LANGUAGE_PROVIDER_INCOMPLETE') {
    return null
  }
  return new GenStudioChatIncompleteError({
    id: job.id,
    model_id: job.model_id,
    output_text: job.output_text,
    // The failure code is the durable contract; use it as the finish reason
    // only when the provider omitted the compatible field.
    finish_reason: job.finish_reason || 'LANGUAGE_PROVIDER_INCOMPLETE',
    failure_code: job.failure_code,
    state: job.state,
  })
}

/**
 * A settled, SUCCEEDED writing answer THIS APP refused: unreadable JSON, a missing body, or a
 * contract violation.
 *
 * The Gateway keeps that text and replays it for the same key, so the key can never produce a
 * usable result — the identity has to move, exactly as it must after a settled failure. Carried as
 * a type rather than left as the bare parse error so a caller holding a saved key can tell it apart
 * from a transport failure or a timeout, which must keep their key.
 *
 * Truncation is deliberately NOT this error. `GenStudioChatIncompleteError` stays itself: the same
 * request against the same ceiling truncates again at the same place (its own message says so), so
 * a fresh send is not the remedy there, and chunked narration still branches on that class.
 */
export class GenStudioChatAnswerRejectedError extends Error {
  readonly jobId: string
  readonly idempotencyKey: string

  constructor(jobId: string, idempotencyKey: string, cause: unknown) {
    // The refused answer's own words stay the message: they are what every surface shows, and what
    // the tests and the run's log line already quote.
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'GenStudioChatAnswerRejectedError'
    this.jobId = jobId
    this.idempotencyKey = idempotencyKey
  }
}

/**
 * The error to throw after a settled answer was refused. One place, so both routes answer the same
 * way and truncation keeps its own class — see `GenStudioChatAnswerRejectedError`.
 */
function rejectedAnswerError(error: unknown, jobId: string, idempotencyKey: string): unknown {
  return error instanceof GenStudioChatIncompleteError
    ? error
    : new GenStudioChatAnswerRejectedError(jobId, idempotencyKey, error)
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
  /** Present only when the live catalogue describes a temporary absence. */
  readonly availabilityReason: 'daily_quota_depleted' | 'temporary_backpressure' | null
  /** GenStudio's reported time, or a local bounded recheck timestamp. */
  readonly availableAgainAt: string | null
  /** The gateway's own reasons this product cannot be used, when it stated any. */
  readonly activationBlockers: string[]

  constructor(
    modelId: string,
    availability?: {
      reason?: 'daily_quota_depleted' | 'temporary_backpressure' | null
      availableAgainAt?: string | null
      blockers?: readonly string[] | null
    },
  ) {
    const blockers = Array.isArray(availability?.blockers)
      ? availability!.blockers!.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : []
    super(
      blockers.length
        ? `The writing model "${modelId}" isn't available right now: ${blockers.join(' ')} `
          + 'Pick another writing model and run this step again. Nothing was sent or charged.'
        : `The writing model "${modelId}" isn't available right now. Pick another writing model and run this step again. Nothing was sent or charged.`,
    )
    this.name = 'GenStudioChatProductUnavailableError'
    this.modelId = modelId
    this.availabilityReason = availability?.reason === 'daily_quota_depleted'
      || availability?.reason === 'temporary_backpressure'
      ? availability.reason
      : null
    this.availableAgainAt = typeof availability?.availableAgainAt === 'string' && availability.availableAgainAt
      ? availability.availableAgainAt
      : null
    this.activationBlockers = blockers
  }
}

/**
 * A live catalog capability refused this request before any GenStudio POST.
 * Pipeline backup may try its next explicitly selected candidate, but only
 * because adapters throw this type before handing work to the provider.
 */
export class GenStudioChatCapabilityUnavailableError extends Error {
  readonly modelId: string

  constructor(modelId: string, detail: string) {
    super(`The writing model "${modelId}" can't do this request: ${detail}. Nothing was sent or charged.`)
    this.name = 'GenStudioChatCapabilityUnavailableError'
    this.modelId = modelId
  }
}

/**
 * Every operation Story Studio records evidence for.
 *
 * v1.4.37 — `'music.generation'` is added HERE rather than to
 * `GenStudioModelCapability['operation']` on purpose. That union describes the
 * rows `/v1/models` publishes, and music is not one of them: it has its own
 * catalogue at `/v1/music/models`. Evidence recording is a different concern —
 * it covers everything this app actually does — so widening the capability
 * union to satisfy it would have made the catalogue type claim a row shape
 * GenStudio never emits.
 */
type GenStudioOperation = GenStudioModelCapability['operation'] | 'music.generation'

const genStudioAdmission = new GenStudioAdmissionPool(async (apiKey): Promise<GenStudioAccountCapacity> => {
  const overview = await readAccountJson<GenStudioAccountOverview>(
    apiKey,
    '/v1/account/overview',
  )
  if (
    !Number.isInteger(overview.paid_concurrency_limit)
    || overview.paid_concurrency_limit < 1
  ) {
    throw new Error('Gateway account overview did not include a valid paid concurrency limit')
  }
  const burstCeiling = positiveInteger(overview.burst_concurrency_ceiling)
  const tierStanding = parseServiceTierStanding(overview.service_tier)
  return {
    credit_balance: overview.credit_balance,
    paid_concurrency_limit: overview.paid_concurrency_limit,
    paid_active_jobs: overview.paid_active_jobs,
    paid_queued_jobs: overview.paid_queued_jobs,
    max_queued_jobs: overview.max_queued_jobs,
    generation_submissions_per_minute: overview.generation_submissions_per_minute,
    ...(burstCeiling ? { burst_concurrency_ceiling: burstCeiling } : {}),
    ...(tierStanding ? { service_tier: tierStanding } : {}),
  }
})

export function genStudioAdmissionSnapshot(apiKey: string) {
  return genStudioAdmission.snapshot(apiKey)
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

export async function getGenStudioAdmissionSnapshot(apiKey: string) {
  return genStudioAdmission.currentSnapshot(apiKey)
}

function queueStateForJob(job: GenStudioJob): GenStudioQueueState {
  if (job.state === 'succeeded') return 'succeeded'
  // A held failure may still be adopted: keep it a working job, not a failed one, inside the grace window.
  if (job.state === 'failed') return holdsUnknownOutcome(job) && job.cancelled !== true ? 'completing' : 'failed'
  if (job.routing_status_code === 'PAID_ACCOUNT_CONCURRENCY_QUEUED') {
    return 'waiting_account_capacity'
  }
  if (job.state === 'accepted' || job.state === 'reserved') return 'accepted'
  if (job.state === 'validating' || job.state === 'reconciling') return 'completing'
  return 'running'
}

export function normalizeGenStudioProviderQueue(job: Pick<GenStudioJob, 'queue_position' | 'queue_eta_seconds' | 'queue_reason'>): {
  queue_position: number | null
  queue_eta_seconds: number | null
  queue_reason: 'provider_pace' | null
} {
  const position = job.queue_position
  const eta = job.queue_eta_seconds
  return {
    queue_position: typeof position === 'number' && Number.isSafeInteger(position) && position >= 1 ? position : null,
    queue_eta_seconds: typeof eta === 'number' && Number.isSafeInteger(eta) && eta >= 0 ? eta : null,
    queue_reason: job.queue_reason === 'provider_pace' ? 'provider_pace' : null,
  }
}

/** How coarsely the countdown in `queue_eta_seconds` counts as "changed" for the poll loops. */
export const QUEUE_ETA_BUCKET_SECONDS = 30

export function providerQueueFingerprint(job: GenStudioJob): string {
  const queue = normalizeGenStudioProviderQueue(job)
  // **The ETA is a countdown, so its raw value changes on every poll.** Each change re-persisted the
  // whole Story job (`recordGenStudioJob` → `persistJob`: measured ≈38 ms with 60 evidence entries,
  // serialised on the project's jobs.json lock) — a deferred job polled every 1.5 s cost ~25 writes a
  // minute for a number that only needs to be right to within half a minute. Bucketed, it is
  // re-recorded when the position or reason changes, or the countdown crosses a bucket.
  const eta = queue.queue_eta_seconds === null ? '' : Math.floor(queue.queue_eta_seconds / QUEUE_ETA_BUCKET_SECONDS)
  return `${queue.queue_reason || ''}:${queue.queue_position ?? ''}:${eta}`
}

/**
 * The LIVE contract the Gateway publishes on every job envelope, plus the failure words it
 * publishes with it.
 *
 * **These change while the state does not.** The Gateway marks a job `running` when its dispatch
 * loop picks it up, publishes `waiting` while the request is queued for a Mac, and then — with the
 * state still `running` — flips `cancellable` to false and clears `waiting` the moment a Mac takes
 * the work. A poll guard that watched only the state kept the pre-dispatch answer forever, so the
 * saved evidence claimed a request could still be stopped after it had already been dispatched.
 *
 * `failure_reason` / `failure_class` belong here for the same reason: a held failure's own words can
 * change while its state does not. Nothing here invents text — an unpublished field is empty, and
 * empty is not the same as "false".
 */
export function providerContractFingerprint(job: GenStudioJob): string {
  const waiting = normalizeGenStudioWaiting(job.waiting)
  const flag = (value: boolean | null | undefined): string => (value === undefined || value === null ? '' : String(value))
  return [
    job.dispatch_state ?? '',
    flag(job.cancellable),
    flag(job.cancelled),
    flag(job.cancellation_requested),
    waiting ? `${waiting.reason ?? ''}|${waiting.next_try_at ?? ''}|${waiting.since ?? ''}` : '',
    job.failure_reason ?? '',
    job.failure_class ?? '',
  ].join('~')
}

/**
 * Everything the recorded evidence row would change on: the queue AND the live contract.
 *
 * The poll loops compare this to decide whether the row needs writing again, so a contract change
 * is written and a still-running job's answer stays current. The queue part is unchanged from
 * `providerQueueFingerprint`, so the countdown bucket still holds: the ETA keeps counting down on
 * every poll, and only a real change re-persists the project.
 */
export function providerEvidenceFingerprint(job: GenStudioJob): string {
  return `${providerQueueFingerprint(job)}|${providerContractFingerprint(job)}`
}

async function reportQueueState(
  request: GenStudioOperationContext,
  job: GenStudioJob,
): Promise<void> {
  await request.onQueueState?.(queueStateForJob(job), job.id)
}

const CONTROL_RESOURCES: Record<JobRemoteOperation, string> = {
  'chat.response': '/v1/chat/responses',
  'image.generation': '/v1/images',
  'video.generation': '/v1/videos',
  'voice.tts': '/v1/jobs',
  'audio.transcription': '/v1/transcriptions',
  'music.generation': '/v1/music/jobs',
}

function controlJobPath(operation: JobRemoteOperation, jobId: string): string {
  return `${CONTROL_RESOURCES[operation]}/${encodeURIComponent(jobId)}`
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
    `${apiBase(baseUrl)}${controlJobPath(operation, providerJobId)}`,
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
    throw new Error('Gateway status response did not match the requested provider job')
  }
  return parsed
}

/** Read an already-submitted provider task by its durable idempotency key. */
export async function getGenStudioJobByIdempotencyKey(
  operation: JobRemoteOperation,
  baseUrl: string,
  apiKey: string,
  key: string,
  request: GenStudioOperationContext = {},
  deadline: number,
): Promise<GenStudioJob & GenStudioCancellationFields> {
  const response = await requestJsonWithRetry(
    `${apiBase(baseUrl)}${CONTROL_RESOURCES[operation]}/by-idempotency-key/${encodeURIComponent(key)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
    apiKey,
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [],
    true,
    1,
  )
  return parseGenStudioCancellationResponse(response)
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
    `${apiBase(baseUrl)}${controlJobPath(operation, providerJobId)}/cancel`,
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
    throw new Error('Gateway cancellation response did not match the requested provider job')
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
      ...(result.dispatch_state !== undefined ? { dispatch_state: result.dispatch_state } : {}),
      ...(result.cancellable !== undefined ? { cancellable: result.cancellable } : {}),
      ...(result.cancelled !== undefined ? { cancelled: result.cancelled } : {}),
      ...(result.cancellation_requested !== undefined ? { cancellation_requested: result.cancellation_requested } : {}),
      ...(result.cancellation_note !== undefined ? { cancellation_note: result.cancellation_note } : {}),
      ...(result.failure_code !== undefined ? { failure_code: result.failure_code } : {}),
      ...(isValidSettlement(result.reserved_credits) ? { reserved_credits: result.reserved_credits } : {}),
      ...(isValidSettlement(result.settled_credits) ? { settled_credits: result.settled_credits } : {}),
      ...(isValidSettlement(result.released_credits) ? { released_credits: result.released_credits } : {}),
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
  const queue = await import('../services/job-queue.js')
  const storyJobId = queue.currentJobId()
  if (storyJobId && preview.idempotency_key) {
    // This evidence is the crash-safe precondition for a paid POST.  If it
    // cannot reach jobs.json, the caller must stop before submitting.
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
  const providerQueue = normalizeGenStudioProviderQueue(job)
  await queue.recordGenStudioJob(storyJobId, {
    id: job.id,
    ...(request ? { request } : {}),
    operation,
    // A held failure is still being reconciled at the gateway; recording it as `failed` would let
    // the Story job settle before the gateway's adoption window closes.
    state: job.state === 'failed' && job.cancelled !== true && holdsUnknownOutcome(job) ? 'reconciling' : job.state,
    ...(job.dispatch_state !== undefined ? { dispatch_state: job.dispatch_state } : {}),
    ...(job.recovery_required !== undefined ? { recovery_required: job.recovery_required } : {}),
    ...(job.recovery_state !== undefined ? { recovery_state: job.recovery_state } : {}),
    // Explicit null when absent: an evidence entry is merged over its predecessor, so a job that
    // stopped waiting must clear the old value instead of inheriting it.
    waiting: (() => {
      const w = normalizeGenStudioWaiting(job.waiting)
      return w ? { ...w, reason: w.reason === null ? null : customerSafeRemoteDetail(w.reason) } : null
    })(),
    model_id: job.model_id || job.model_revision_id,
    credit_cost: Number.isFinite(job.credit_cost) ? job.credit_cost : undefined,
    ...providerCostUsd(job),
    remaining_credits: Number.isFinite(job.remaining_credits) ? job.remaining_credits : undefined,
    // Settlement is forwarded ONLY when GenStudio published it. An absent field
    // stays absent so the UI can say "not settled yet" instead of inventing a
    // hold out of credit_cost.
    //
    // This forwards every settlement field exactly when GenStudio published it;
    // it never derives one from a price or another field.
    ...(isValidSettlement(job.reserved_credits) ? { reserved_credits: job.reserved_credits } : {}),
    ...(isValidSettlement(job.settled_credits) ? { settled_credits: job.settled_credits } : {}),
    ...(isValidSettlement(job.released_credits) ? { returned_credits: job.released_credits } : {}),
    ...(isValidSettlement(job.released_credits) ? { released_credits: job.released_credits } : {}),
    price_version: job.price_version,
    failure_code: job.failure_code,
    failure_class: job.failure_class,
    ...(job.failure_reason === null || (typeof job.failure_reason === 'string' && job.failure_reason.trim())
      ? { failure_reason: typeof job.failure_reason === 'string' ? customerSafeRemoteDetail(job.failure_reason) : job.failure_reason }
      : {}),
    ...(job.cancellable !== undefined ? { cancellable: job.cancellable } : {}),
    ...(job.cancelled !== undefined ? { cancelled: job.cancelled } : {}),
    ...(job.cancellation_requested !== undefined ? { cancellation_requested: job.cancellation_requested } : {}),
    ...(job.cancellation_note !== undefined ? { cancellation_note: job.cancellation_note } : {}),
    routing_status_code: job.routing_status_code,
    ...(job.retry_after_seconds === null || isValidSettlement(job.retry_after_seconds) ? { retry_after_seconds: job.retry_after_seconds } : {}),
    ...(job.retry_at === null || (typeof job.retry_at === 'string' && job.retry_at.trim()) ? { retry_at: job.retry_at } : {}),
    ...(job.last_provider_progress_at === null || (typeof job.last_provider_progress_at === 'string' && job.last_provider_progress_at.trim()) ? { last_provider_progress_at: job.last_provider_progress_at } : {}),
    ...(job.stall_recovery_at === null || (typeof job.stall_recovery_at === 'string' && job.stall_recovery_at.trim()) ? { stall_recovery_at: job.stall_recovery_at } : {}),
    // v1.4.82 — this is the boundary into the shape the job card renders, so it
    // is the last place remote prose can be made customer-safe. See
    // customerSafeRemoteDetail: text that describes our estate is replaced
    // whole; anything else passes through untouched.
    ...(job.status_detail === null || (typeof job.status_detail === 'string' && job.status_detail.trim())
      ? { status_detail: typeof job.status_detail === 'string' ? customerSafeRemoteDetail(job.status_detail) : job.status_detail }
      : {}),
    ...(job.failure_detail === null || (typeof job.failure_detail === 'string' && job.failure_detail.trim())
      ? { failure_detail: typeof job.failure_detail === 'string' ? customerSafeRemoteDetail(job.failure_detail) : job.failure_detail }
      : {}),
    location: job.location || undefined,
    ...providerQueue,
    queue_state: queueStateForJob(job),
    updated_at: new Date().toISOString(),
  })
  if (operation in CONTROL_RESOURCES) {
    await queue.reconcileRemoteCancellationFromProvider(storyJobId, operation as JobRemoteOperation, job.id, {
      state: job.state,
      ...(job.dispatch_state !== undefined ? { dispatch_state: job.dispatch_state } : {}),
      ...(job.cancellable !== undefined ? { cancellable: job.cancellable } : {}),
      ...(job.cancelled !== undefined ? { cancelled: job.cancelled } : {}),
      ...(job.cancellation_requested !== undefined ? { cancellation_requested: job.cancellation_requested } : {}),
      ...(job.cancellation_note !== undefined ? { cancellation_note: job.cancellation_note } : {}),
      ...(job.failure_code !== undefined ? { failure_code: job.failure_code } : {}),
      ...(isValidSettlement(job.reserved_credits) ? { reserved_credits: job.reserved_credits } : {}),
      ...(isValidSettlement(job.settled_credits) ? { settled_credits: job.settled_credits } : {}),
      ...(isValidSettlement(job.released_credits) ? { released_credits: job.released_credits } : {}),
    })
  }
}

interface GenStudioSubmissionEvidence {
  operation: GenStudioOperation
  preview: GenStudioRequestPreview
}

async function recordGenStudioCreditRefusal(
  evidence: GenStudioSubmissionEvidence,
  error: GenStudioApiError,
): Promise<void> {
  const queue = await import('../services/job-queue.js')
  const storyJobId = queue.currentJobId()
  const idempotencyKey = evidence.preview.idempotency_key
  if (!storyJobId || !idempotencyKey) return
  await queue.recordGenStudioJob(storyJobId, {
    id: pendingGenStudioEntryId(idempotencyKey),
    operation: evidence.operation,
    state: 'failed',
    dispatch_state: 'pre_dispatch',
    model_id: evidence.preview.model_id,
    queue_state: 'waiting_credits',
    failure_code: error.code || null,
    updated_at: new Date().toISOString(),
    request: evidence.preview,
  })
}

export function catalogHasVoice(voices: GenStudioVoice[], voiceId: unknown): boolean {
  if (typeof voiceId !== 'string' || !voiceId.trim()) return false
  return voices.some(voice => voice.id === voiceId.trim() && voice.generation_enabled !== false)
}

/**
 * Fair-turns tag (Gateway D6): `<project-slug>/<episode-id | 'project'>` of the Story job this
 * request runs under. Optional and advisory; never part of an idempotency key. Pure so it is testable.
 */
export function formatJobGroup(projectSlug: unknown, episodeId: unknown): string | undefined {
  const clean = (v: unknown) => String(v ?? '').trim().replace(/[^A-Za-z0-9._:-]+/g, '-')
  const slug = clean(projectSlug)
  return slug ? `${slug}/${clean(episodeId) || 'project'}`.slice(0, 120) : undefined
}

/** `{ job_group }` for the running queue job, `{}` outside one (a route-level call has no episode run). */
async function jobGroupField(): Promise<{ job_group?: string }> {
  const queue = await import('../services/job-queue.js')
  const id = queue.currentJobId()
  const job = id ? queue.getJob(id) : null
  const job_group = job ? formatJobGroup(job.project_slug, job.episode_id) : undefined
  return job_group ? { job_group } : {}
}

function apiBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function requestUrl(baseUrl: string, value: string): string {
  const base = new URL(`${apiBase(baseUrl)}/`)
  const resolved = new URL(value, base)
  if (resolved.origin !== base.origin) {
    throw new Error('The Gateway returned an artifact URL outside its API origin')
  }
  return resolved.toString()
}

function authorization(apiKey: string): Record<string, string> {
  if (!apiKey.trim()) throw new Error('No Gateway API Key configured. Open Settings → This Mac → Gateway API Key.')
  return { Authorization: `Bearer ${apiKey.trim()}`, 'X-Caller': STORY_CALLER }
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
    return `The Gateway published no maximum_input_characters for the selected voice model. ${consequence}`
  }
  // A number arrived, and it is unusable — zero, negative, or non-finite. That
  // is a value problem, not a missing publication, and saying so keeps the
  // "GenStudio published nothing" phrase for the case where it is true.
  return 'The Gateway published maximum_input_characters as '
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
    return splitAtLimit(part, cap)
  })
}

/** Build the exact customer API payload plus a stable retry identity. */
export function buildGenStudioSubmission(request: GenStudioTtsRequest): GenStudioSubmission {
  const voiceId = request.voiceId?.trim() || ''
  if (!voiceId) throw new Error('Select a Gateway voice before generating audio.')
  const modelId = request.modelId?.trim() || ''
  if (!modelId) {
    throw new Error(
      'Story Studio did not carry the selected voice model into this TTS submission. '
      + 'The Gateway sells speech by model and requires model_id on every request, so it '
      + 'refuses the body before any provider is contacted. That is a Story Studio defect, '
      + 'not a Gateway publication gap — the catalogue publishes the model id the '
      + 'generator already selected and quoted with.',
    )
  }
  if (!request.text.trim()) throw new Error('Gateway text cannot be empty.')
  const maxCharacters = request.maxInputCharacters
  if (maxCharacters == null || !Number.isFinite(maxCharacters) || maxCharacters <= 0) {
    throw new Error(describeMissingRequestBoundary(
      maxCharacters,
      'That is a Story Studio defect, not a Gateway publication gap — the catalogue publishes '
      + 'the field for every TTS model. Story Studio will not guess a request boundary.',
      'submission',
    ))
  }
  const characterCount = Array.from(request.text.normalize('NFC')).length
  if (characterCount > maxCharacters) {
    throw new Error(`The Gateway accepts at most ${Math.floor(maxCharacters).toLocaleString()} characters per request for this voice model.`)
  }
  const speed = resolveGenStudioTtsSpeed(
    request.speed,
    request.supportsSpeed,
    request.minimumSpeed,
    request.maximumSpeed,
  )
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
  // How the words should be read. Sent ONLY when the caller resolved a
  // non-empty instruction against the selected model's published control, so a
  // model that publishes none produces exactly the body it produced before the
  // field existed and its in-flight idempotency key still replays. It enters
  // the digest with the body, which is right: the same script read differently
  // is different work and must never replay the other reading's audio.
  const deliveryInstruction = typeof request.deliveryInstruction === 'string'
    ? request.deliveryInstruction.trim()
    : ''
  const body = {
    // The product first, because that is what GenStudio sells and prices. It
    // also enters the digest below, which is correct: the same script in the
    // same voice at a different model is different work at a different rate,
    // and must never replay the other one's result.
    model_id: modelId,
    voice_id: voiceId,
    text: request.text,
    speed,
    ...(controls ? { controls } : {}),
    ...(deliveryInstruction ? { delivery_instruction: deliveryInstruction } : {}),
    // Same conditional-spread rule as `controls`: absent for the native WAV so every existing
    // key (and in-flight recovery) is unchanged, present so the two formats never share a replay.
    ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
    // Same rule again: absent unless set, so every key minted without a pause is unchanged.
    ...(request.pauses?.paragraph_pause_sec !== undefined ? { paragraph_pause_sec: request.pauses.paragraph_pause_sec } : {}),
    ...(request.pauses?.sentence_pause_sec !== undefined ? { sentence_pause_sec: request.pauses.sentence_pause_sec } : {}),
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
  PROVIDER_BACKPRESSURE: 'LANGUAGE_PROVIDER_BACKPRESSURE',
  /** The product's provider quota is temporarily exhausted before work ran. */
  QUOTA_EXHAUSTED: 'LANGUAGE_PROVIDER_QUOTA_EXHAUSTED',
  SUBMISSION_UNCERTAIN: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
  /** The provider returned output cut short by the published token limit. */
  INCOMPLETE: 'LANGUAGE_PROVIDER_INCOMPLETE',
  /** The reply came back, but it did not prove it came from the model sold. */
  MODEL_MISMATCH: 'LANGUAGE_PROVIDER_MODEL_MISMATCH',
} as const

/**
 * Codes that say the provider may already have taken the request, so it must never be resubmitted
 * by machine. GenStudio-cloud spells them LANGUAGE_/CLOUD_…; the gateway's own is
 * PROVIDER_SUBMISSION_UNCERTAIN. One list, so no caller has to know which dialect it is reading.
 */
const SUBMISSION_UNCERTAIN_CODES: ReadonlySet<string> = new Set([
  GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN,
  'CLOUD_SUBMISSION_UNCERTAIN',
  'PROVIDER_SUBMISSION_UNCERTAIN',
])
export function isSubmissionUncertainCode(code: unknown): boolean {
  return typeof code === 'string' && SUBMISSION_UNCERTAIN_CODES.has(code.trim().toUpperCase())
}

/**
 * An operator closed the gateway's unknown-outcome hold on this job ("Resolve All Needing
 * Recovery"): the attempt is abandoned and its result is never collected. Collecting the same
 * job again answers the same failure forever, so the only way forward is a fresh request.
 */
const CLOSED_HOLD_CODES: ReadonlySet<string> = new Set(['HOLD_CLOSED', 'DISCARDED_UNCERTAIN'])
export function isClosedHoldCode(code: unknown): boolean {
  return typeof code === 'string' && CLOSED_HOLD_CODES.has(code.trim().toUpperCase())
}

/**
 * Does recorded evidence say the gateway still holds this job as an unknown outcome?
 *
 * The code alone is not enough (see `isGenStudioSubmissionUncertain`): the evidence entry also
 * carries the envelope's `recovery_required` / `recovery_state`. A retry that reads such an entry
 * as a settled failure mints a fresh identity and submits a second job while the first may still
 * be adopted by the gateway.
 */
export function evidenceHoldsUnknownOutcome(
  entry: { failure_code?: unknown; recovery_required?: unknown; recovery_state?: unknown } | null | undefined,
): boolean {
  return !!entry && (isSubmissionUncertainCode(entry.failure_code) || holdsUnknownOutcome(entry))
}

/** A temporary provider quota stop, in either dialect (`PROVIDER_QUOTA_EXHAUSTED` is the gateway's). */
const QUOTA_EXHAUSTED_CODES: ReadonlySet<string> = new Set([
  GENSTUDIO_LANGUAGE_FAILURE_CODES.QUOTA_EXHAUSTED,
  'PROVIDER_QUOTA_EXHAUSTED',
])
export function isQuotaExhaustedCode(code: unknown): boolean {
  return typeof code === 'string' && QUOTA_EXHAUSTED_CODES.has(code.trim().toUpperCase())
}

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
      return 'Your Gateway account is already running as many jobs at once as its plan allows, so this '
        + 'one is waiting for a slot. Nothing failed and nothing was charged. It starts on its own as soon as '
        + 'one of your running jobs finishes — or run fewer steps at once, or raise your account\'s '
        + 'concurrency limit, to clear the queue faster.'
    case GENSTUDIO_CAPACITY_REASONS.ACCOUNT_RATE_LIMIT:
      return 'Your Gateway account has sent more requests per minute than its plan allows, so this one '
        + 'was held back. Nothing failed and nothing was charged. Story Studio is spacing out its retries for '
        + 'you; to stop hitting the limit, run fewer steps at once or raise your account\'s per-minute rate.'
    case GENSTUDIO_CAPACITY_REASONS.ACCOUNT_QUEUE_LIMIT:
      return 'Your Gateway account\'s job queue is full, so this request could not be accepted. Nothing '
        + 'was charged. Wait for queued jobs to finish, or cancel some in your Gateway account, then Retry '
        + '— raising your account\'s queue limit also clears it.'
    case GENSTUDIO_CAPACITY_REASONS.PROVIDER_BACKPRESSURE:
      return 'The Gateway is under heavy load right now and asked Story Studio to wait before trying again. '
        + 'This is temporary and is not a problem with your account, your credits, or this request. Story '
        + 'Studio is retrying automatically at the pace Gateway asked for.'
    case GENSTUDIO_CAPACITY_REASONS.REQUEST_IN_PROGRESS:
      return 'The Gateway is already running this exact request. Story Studio did NOT send it again — a '
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
  // GenStudio-cloud spells these LANGUAGE_…; the gateway drops the prefix (PROVIDER_FAILED …).
  const normalized = code.trim().toUpperCase().replace(/^LANGUAGE_/, '')
  if (isSubmissionUncertainCode(normalized) || normalized === 'UNKNOWN_OUTCOME') return LOST_WRITING_REQUEST
  switch (normalized) {
    case 'PROVIDER_FAILED':
      return 'The writing model could not answer this request. Retry this step; if it keeps failing, pick a different writing model.'
    case 'PROVIDER_MODEL_MISMATCH':
      return 'The reply did not come from the writing model you chose, so it was refused rather than used. '
        + 'Retry this step, or pick a different writing model.'
    case 'PROVIDER_BACKPRESSURE':
    case 'PROVIDER_UNAVAILABLE':
    case 'LOCATION_NOT_READY':
      return 'No writing model was free to take this request. Retry in a few minutes, or pick a different writing model.'
    case 'PROVIDER_QUOTA_EXHAUSTED':
      return 'This writing model has used up its free allowance for now (for a pool: every model in it has). '
        + 'Retry later — free allowances usually come back within a day — or pick a different writing model.'
    default:
      return null
  }
}

/**
 * True when this error carries GenStudio's "we do not know if the provider
 * already took it" code. Such a request is never resubmitted by machine, except
 * a writing request's one fresh resend (see `lostChatRequest`).
 *
 * Two shapes carry the code, and both must answer the same way:
 *   - an error BODY on the synchronous route (`GenStudioApiError.code`);
 *   - a settled durable job's `failure_code` on `/v1/chat/responses`, which is
 *     the only place the distinction is reliably published.
 */
export function isGenStudioSubmissionUncertain(error: unknown): boolean {
  if (error instanceof GenStudioTerminalFailureError) {
    // A gateway hold (`recovery_required` / `unknown_outcome`) says the same thing whatever
    // `failure_code` it carries: the gateway publishes `UNKNOWN_OUTCOME` for a restart or a Hub
    // `uncertain` item and `SITE_CAPACITY_UNAVAILABLE` for an ambiguous read timeout, and neither
    // is in the code list. Keyed on the code alone, a held chat job read as "proven uncharged".
    return isSubmissionUncertainCode(error.failureCode) || error.unknownOutcome === true
  }
  if (!(error instanceof GenStudioApiError)) return false
  return isSubmissionUncertainCode(error.languageFailureCode) || isSubmissionUncertainCode(error.code)
}

/**
 * True when a COLLECTED writing failure is PROVEN dead: the Gateway settled the job `failed`, it
 * holds no unknown outcome, and the code is not one that says a provider may already have taken the
 * request. Collecting that key again can only answer the same failure, so a caller that saved the
 * key may release the identity and send one fresh request.
 *
 * Every other shape must keep replaying its key. A hold (`recovery_required` / `unknown_outcome`)
 * and an uncertain submission may yet produce an answer, and a cancellation is the user's own last
 * word — none of them is permission to buy a second request.
 *
 * `isClosedHoldCode` needs no separate case: an operator closing the hold (`HOLD_CLOSED`) settles
 * the job with no hold left, which is exactly what this answers true for.
 */
export function isProvenChatFailure(error: unknown): error is GenStudioChatTerminalFailureError {
  return error instanceof GenStudioChatTerminalFailureError
    && !error.cancelled
    && !error.unknownOutcome
    && !isSubmissionUncertainCode(error.failureCode)
}

/**
 * True when the Gateway SETTLED a writing answer and this app refused it — unreadable JSON, a
 * missing body, or a contract violation (`GenStudioChatAnswerRejectedError`). The job succeeded and
 * its text is retained, so replaying that key returns the same refused text on every attempt; a
 * caller holding the key may release the identity and ask once more.
 *
 * Truncation is not this: a truncated answer is `GenStudioChatIncompleteError`, which the same
 * request against the same ceiling reproduces at the same place.
 */
export function isProvenUnusableChatAnswer(error: unknown): error is GenStudioChatAnswerRejectedError {
  return error instanceof GenStudioChatAnswerRejectedError
}

/**
 * True when the Gateway PROVED it never saw this key: the read-only by-idempotency-key lookup
 * answered 404, so no job exists for it in this account.
 *
 * Only a 404 proves that. Every other unresolved lookup — a 502/504, a refused connection, a
 * timeout, a key outside `allowedRecoveryKeys`, a settings switch mid-read — proves nothing, and
 * the key must be KEPT: fresh work submitted on that evidence could pay a second time for a request
 * that did reach the Gateway.
 */
export function isProvenUncreatedChatRequest(error: unknown): boolean {
  return error instanceof GenStudioChatRecoveryUnresolvedError
    && error.cause instanceof GenStudioApiError
    && error.cause.status === 404
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
    && hasFullyReleasedZeroSettlement(error)
}

/**
 * A published temporary language quota exhaustion is safe to leave behind
 * only after the durable settlement proves the request never consumed a
 * credit. Callers still choose whether to park/recheck or surface it.
 */
export function isGenStudioLanguageQuotaExhausted(error: unknown): error is GenStudioTerminalFailureError {
  return error instanceof GenStudioTerminalFailureError
    && !error.cancelled
    && isQuotaExhaustedCode(error.failureCode)
    && hasFullyReleasedZeroSettlement(error)
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
 *  unlabelled 502 is NOT assumed to be any code.
 *
 *  THE PATTERN IS BUILT FROM THE CODE TABLE, NOT HAND-WRITTEN. It used to name
 *  two of the codes literally, so `BACKPRESSURE` — which the table and the
 *  message function both already knew — could never be recovered from a detail
 *  string, and `MODEL_MISMATCH` inherited the same blind spot the day it was
 *  added. Deriving the alternation means a code exists in exactly one place and
 *  a new one is readable everywhere the moment it is listed. */
function readLanguageFailureCode(detail: string, code?: string): string | null {
  const fromCode = typeof code === 'string' ? code.trim().toUpperCase() : ''
  const known = Object.values(GENSTUDIO_LANGUAGE_FAILURE_CODES) as string[]
  if (known.includes(fromCode)) return fromCode
  const quoted = new RegExp(`\\b(?:${known.join('|')})\\b`, 'i').exec(detail || '')
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
      ? `The Gateway did not accept this Gateway API Key: ${detail}. Save a valid Gateway API Key in Settings → This Mac.`
      : status === 402
        ? `The Gateway has insufficient credits for this request: ${detail}. Add credits, then Retry.`
        : status === 403
          ? `This Gateway API Key or account is not allowed to use the selected product: ${detail}. Check its scopes and product access.`
          : status === 422
            ? `The Gateway rejected the product request before generation: ${detail}. Review the selected model and its output contract.`
            : status === 429
              ? `The Gateway is busy or rate-limited: ${detail}. Story Studio will honor its Retry-After guidance.`
              : status === 502
                ? `The provider behind this Gateway product failed: ${detail}. No fallback route was attempted.`
                : isGenStudioGenerationPaused(status, detail)
                  ? 'Gateway generation is paused by its operator. Story Studio stopped all remaining new ' +
                    'submissions; accepted jobs and completed checkpoints are preserved. Enable generation in ' +
                    'Gateway Admin, then Retry only unfinished work.'
                  : `Gateway request failed: ${detail}`
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

/** A control request timed out before its HTTP outcome was known. */
export class GenStudioTransportTimeoutError extends Error {
  /** A transport signature (`isTransportFailure` reads `code`): a timeout is a dropped answer, not a user abort. */
  readonly code = 'ETIMEDOUT'
  constructor(timeout: DOMException) {
    // NOT `timeout.message`. Node words it "The operation was aborted due to timeout", and every
    // cancel check in Story matches /abort/ — so a 30 s gateway stall read as the owner pressing
    // Cancel, and the audio generator logged "Cancelled." and skipped the chunk without counting
    // a failure or retrying (audit 2026-10-01).
    super(`The Gateway did not answer within the request time limit (${timeout.name})`)
    this.name = 'GenStudioTransportTimeoutError'
  }
}

export function isGenStudioInsufficientCredits(error: unknown): error is GenStudioApiError {
  return error instanceof GenStudioApiError && error.status === 402
}

export function isGenStudioGenerationPaused(
  status: number,
  detail: string,
): boolean {
  return status === 503 && detail === 'GENERATION_PAUSED'
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
 * GenStudio 1.2 publishes `retry_after_seconds` and `retry_at`. Older payload
 * shapes and the `Retry-After` header remain readable so in-flight jobs from
 * a rolling deployment keep the same safe polling behavior.
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
  const retryAt = row.retry_at
  if (typeof retryAt === 'string') {
    const timestamp = Date.parse(retryAt)
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now)
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
 *   1. Walk the ladder, capped at GENSTUDIO_POLL_MAX_INTERVAL_MS, with
 *      symmetric ±20% jitter.
 *   2. A server hint is a MINIMUM on top of that (floored at 1 s, jittered
 *      upward only): the delay is whichever is longer.
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
  const attempt = Math.max(0, Math.floor(options.attempt))
  const base = pollLadderOverrideMs
    ? pollLadderOverrideMs[Math.min(attempt, pollLadderOverrideMs.length - 1)]!
    : (attempt < POLL_LADDER_MS.length ? POLL_LADDER_MS[attempt]! : GENSTUDIO_POLL_MAX_INTERVAL_MS)
  const spread = 1 + GENSTUDIO_POLL_JITTER_FRACTION * (random() * 2 - 1)
  let delay = Math.round(base * spread)
  if (hint != null) {
    // The server's hint is a MINIMUM on top of the ladder, never a replacement for it: a 5 s hint on a
    // four-hour video job must not hold the poll at 5 s once the ladder has backed off to 15 s, and a
    // hint of 0 (or a retry_at already in the past) must not become a hot loop. Jitter is upward only.
    const floored = Math.max(hint, GENSTUDIO_POLL_MIN_HINT_MS)
    delay = Math.max(delay, Math.ceil(floored * (1 + GENSTUDIO_POLL_JITTER_FRACTION * random())))
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
export function createGenStudioJobPoller(random: () => number = Math.random, now: () => number = Date.now): {
  attempts: () => number
  wait: (deadline: number, ctx: GenStudioOperationContext, job?: unknown) => Promise<void>
  /** The wait-loop exit test: settled, except a held `failed` job inside its grace window. */
  settled: (job: { state?: unknown; cancelled?: boolean | null; recovery_required?: unknown; recovery_state?: unknown }) => boolean
} {
  let attempt = 0
  let heldSince: number | null = null
  return {
    attempts: () => attempt,
    settled(job) {
      if (!isSettledGenStudioJob(job)) {
        // The job went back to work (or never failed): a later hold starts its own grace window.
        heldSince = null
        return false
      }
      if (job.state !== 'failed' || job.cancelled === true || !holdsUnknownOutcome(job)) return true
      heldSince ??= now()
      return now() - heldSince >= UNKNOWN_OUTCOME_GRACE_MS
    },
    async wait(deadline, ctx, job) {
      const delay = Math.max(genStudioPollDelayMs({
        attempt,
        remainingMs: deadline - Date.now(),
        hintMs: readGenStudioPollHintMs(job),
        random,
      }), heldSince === null ? 0 : 5_000)
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
  beforeWaitSlice?: () => void | Promise<void>,
): Promise<void> {
  const fallbackMs = Math.min(4_000, 500 * (2 ** (attempt - 1)))
  const requestedMs = retryAfterMs == null ? fallbackMs : Math.max(0, retryAfterMs)
  const wakeAt = Date.now() + Math.min(requestedMs, Math.max(0, deadline - Date.now()))
  for (;;) {
    if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
    if (Date.now() >= deadline) throw new Error('Gateway job timed out while waiting for completion')
    const left = wakeAt - Date.now()
    if (left <= 0) return
    await beforeWaitSlice?.()
    if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
    await new Promise(resolve => setTimeout(resolve, Math.min(POLL_CANCEL_CHECK_MS, left)))
  }
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
   *  `languageSubmitTimeoutMs()`. */
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
    if (init.method === 'POST') await request.beforePost?.()
    let physicalPostStarted = false
    try {
      let response: Response
      let raw: string
      // A POST is a submission from the moment it is sent until its answer (with the task id) is
      // read: a prompt update waits for that (lib/inflight-submits.ts).
      let answered: () => void = () => {}
      try {
        const send = () => {
          physicalPostStarted = true
          if (init.method === 'POST') { answered(); answered = submitSent() }
          return fetch(url, { ...init, signal: operationSignal(request.signal, deadline, operationTimeoutMs) })
        }
        response = await (init.method === 'POST' && request.withPost ? request.withPost(send) : send())
        raw = await response.text()
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new GenStudioTransportTimeoutError(error)
        }
        throw error
      } finally {
        answered?.()
      }
      let body: any = {}
      if (raw) {
        try { body = JSON.parse(raw) }
        catch { throw new Error(`The Gateway returned invalid JSON (HTTP ${response.status})`) }
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
        if (isGenStudioGenerationPaused(response.status, detail)) {
          const retryAfterMs = parseGenStudioRetryAfterMs(response.headers.get('retry-after'))
          genStudioAdmission.noteGlobalFailure(error, retryAfterMs ?? undefined)
          await request.onQueueState?.('failed')
          throw error
        }
        if (apiKey) genStudioAdmission.noteSubmissionReachable()
        if (response.status === 402) {
          if (apiKey) genStudioAdmission.noteInsufficientCredits(apiKey, error)
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
          // A gateway that still publishes `cancelled` as a state: Story's vocabulary is failed + cancelled:true.
          if (body.state === 'cancelled') { body.state = 'failed'; body.cancelled = true }
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
      // A policy/checkpoint failure is not a transport failure to retry.
      if (init.method === 'POST' && request.withPost && !physicalPostStarted) throw error
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
          || isGenStudioGenerationPaused(error.status, error.detail)
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
  throw lastError instanceof Error ? lastError : new Error('Gateway request failed after reconnect attempts')
}

async function submitJsonWithAdmission(
  apiKey: string,
  url: string,
  init: RequestInit,
  request: GenStudioOperationContext,
  deadline: number,
  operationTimeoutMs: number = GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
  noRetryStatuses: readonly number[] = [],
  evidence?: GenStudioSubmissionEvidence,
): Promise<any> {
  try {
    return await withGenStudioAdmission(
      apiKey,
      request,
      () => requestJsonWithRetry(url, init, request, deadline, apiKey, operationTimeoutMs, noRetryStatuses),
    )
  } catch (error) {
    if (evidence && isGenStudioInsufficientCredits(error)) {
      await recordGenStudioCreditRefusal(evidence, error)
    }
    throw error
  }
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
  evidence: GenStudioSubmissionEvidence,
  // This request's own expected generation time, or 0 when nothing was stated. Applied as a
  // floor under the owner's dial, never as a replacement for it.
  chatAllowanceSeconds = 0,
): Promise<any> {
  const poller = createGenStudioJobPoller()
  // Read per SUBMISSION, not per module load. The owner changing the dial
  // while a long episode is running must apply to the next request, and a
  // value captured at import time would need a restart to take effect —
  // exactly the silent no-op the concurrency route already refuses to ship.
  const timeoutMs = await effectiveChatSubmitTimeoutMs(chatAllowanceSeconds)
  for (;;) {
    try {
      return await submitJsonWithAdmission(
        apiKey, url, init, request, deadline, timeoutMs, [502, 504], evidence,
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

/**
 * The account overview plus how current the copy is. `freshness` is only ever
 * `live` or `stale` here: the overview always revalidates, so it is never
 * served from an unexpired freshness window the way a catalogue can be.
 */
export interface GenStudioAccountOverviewSnapshot {
  value: GenStudioAccountOverview
  freshness: GenStudioCatalogFreshness
  /** True while the value is only usable because a refresh failed. */
  stale: boolean
  /** When the copy was actually loaded from GenStudio. */
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

/** Trusted catalogue-shape diagnosis. Its message is safe to surface because
 * the parser authors it without interpolating the malformed wire value. */
class GenStudioCatalogFieldValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenStudioCatalogFieldValidationError'
  }
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
      cause instanceof GenStudioCatalogFieldValidationError
        ? cause.message
        : `The Gateway ${CATALOG_LABEL[kind]} catalogue could not be refreshed`
          + `${ageMs == null
            ? ' and Story Studio has no cached copy'
            : ` and the cached copy is ${Math.round(ageMs / 60_000)} minute(s) old, beyond the `
              + `${Math.round(CATALOG_STALE_MS / 60_000)}-minute staleness limit`}. `
          + 'Story Studio refused to submit work against an unverified product; nothing was requested '
          + 'and no credits were charged. Check the Gateway app is running, then Retry.',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'GenStudioCatalogUnavailableError'
    this.kind = kind
    this.ageMs = ageMs
  }
}

const catalogCache = new Map<string, CatalogCacheEntry<unknown>>()

/**
 * One in-flight catalogue refresh, and the controller that cancels it.
 *
 * The controller is kept so a force-live read can ABORT the read it supersedes.
 * Without it the superseded request stayed in flight — holding a socket for its
 * own 30 s timeout, three times over with retries — while a second request to
 * the same endpoint started beside it.
 */
interface CatalogRefresh<T> {
  promise: Promise<T>
  abort: AbortController
}

const catalogRefreshes = new Map<string, CatalogRefresh<unknown>>()
const LAST_GOOD_CATALOG_SETTING = 'genstudio_catalog_last_good_v1'
const LAST_GOOD_CATALOG_SCHEMA_VERSION = 1
let lastGoodCatalogWrite = Promise.resolve()

interface LastGoodCatalogEntry<T = unknown> {
  kind: GenStudioCatalogKind
  fetched_at: number
  value: T
}

interface LastGoodCatalogStore {
  schema_version: number
  entries: Record<string, LastGoodCatalogEntry>
}

function readLastGoodCatalogStore(value: unknown): LastGoodCatalogStore {
  if (!value || typeof value !== 'object') return { schema_version: LAST_GOOD_CATALOG_SCHEMA_VERSION, entries: {} }
  const candidate = value as Partial<LastGoodCatalogStore>
  if (candidate.schema_version !== LAST_GOOD_CATALOG_SCHEMA_VERSION || !candidate.entries || typeof candidate.entries !== 'object') {
    return { schema_version: LAST_GOOD_CATALOG_SCHEMA_VERSION, entries: {} }
  }
  return { schema_version: LAST_GOOD_CATALOG_SCHEMA_VERSION, entries: candidate.entries }
}

function usableLastGoodCatalogEntry<T>(
  value: unknown,
  kind: GenStudioCatalogKind,
  now: number,
): LastGoodCatalogEntry<T> | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<LastGoodCatalogEntry<T>>
  if (entry.kind !== kind || !Array.isArray(entry.value) || !Number.isFinite(entry.fetched_at) || entry.fetched_at! > now) return null
  if (now - entry.fetched_at! > CATALOG_STALE_MS) return null
  return {
    kind,
    fetched_at: entry.fetched_at!,
    value: entry.value,
  }
}

async function readLastGoodCatalog<T>(key: string, kind: GenStudioCatalogKind): Promise<LastGoodCatalogEntry<T> | null> {
  const store = readLastGoodCatalogStore(await getAppSetting(LAST_GOOD_CATALOG_SETTING))
  return usableLastGoodCatalogEntry<T>(store.entries[key], kind, Date.now())
}

function queueLastGoodCatalogWrite<T>(
  key: string,
  kind: GenStudioCatalogKind,
  value: T,
  loadedAt: number,
): Promise<void> {
  const write = lastGoodCatalogWrite.then(async () => {
    const store = readLastGoodCatalogStore(await getAppSetting(LAST_GOOD_CATALOG_SETTING))
    // A newly successful catalogue response replaces any older entry for this
    // account, endpoint, and modality.
    store.entries[key] = {
      kind,
      fetched_at: loadedAt,
      value,
    }
    await setAppSetting(LAST_GOOD_CATALOG_SETTING, store)
  })
  lastGoodCatalogWrite = write.catch(() => {})
  return write
}
// A forced paid-work read must not share or be overwritten by an older normal
// refresh for the same account-scoped key. The value is only a write guard;
// cache storage remains the existing maps above.
const catalogGenerations = new Map<string, number>()

function catalogCacheKey(kind: GenStudioCatalogKind | 'account-overview', baseUrl: string, apiKey: string): string {
  return `${kind}:${createHash('sha256').update(`${baseUrl}\0${apiKey}`).digest('hex')}`
}

/**
 * Forget process-local GenStudio reads, catalogues and the account overview
 * alike. Durable display catalogues are intentionally retained: each uses the
 * hashed account-and-base-URL key, so changing credentials cannot expose one
 * account's rows to another and a process restart can still show the same
 * account's last-known list during a short outage.
 */
export function clearGenStudioCatalogCache(): void {
  catalogCache.clear()
  catalogGenerations.clear()
}

/**
 * Force the next read of every catalogue to revalidate, while keeping the
 * cached copy usable as a stale fallback during a short service interruption.
 */
export function invalidateGenStudioCatalogFreshness(): void {
  for (const entry of catalogCache.values()) entry.freshUntil = 0
}

/**
 * One retrying JSON read for every GenStudio surface that is free, idempotent
 * and safe to re-request. `unreachable` names the surface, so a caller that is
 * not a catalogue does not report a catalogue failure.
 */
async function fetchRetryingJson(
  url: string,
  apiKey: string,
  unreachable = 'Gateway model catalog could not be reached after automatic reconnect attempts.',
  signal?: AbortSignal,
): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 1; attempt <= CATALOG_RETRY_ATTEMPTS; attempt++) {
    try {
      const timeout = AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS)
      return await readJson(await fetch(url, {
        headers: authorization(apiKey),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }))
    } catch (error) {
      lastError = error
      // A superseded read was aborted on purpose and is not worth retrying: the
      // read that replaces it has already started.
      if (signal?.aborted) throw error
      if (error instanceof GenStudioApiError && !retryableStatus(error.status)) throw error
    }
    if (attempt < CATALOG_RETRY_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 300 * (2 ** (attempt - 1))))
    }
  }
  throw new Error(unreachable, { cause: lastError })
}

/**
 * Unwrap a published catalogue payload, accepting EITHER shape.
 *
 * WHY THIS EXISTS (2026-09-18). Every catalogue route used to answer with a bare
 * JSON array, and that is the contract this client was built and tested against
 * — provable from the last-good cache, which stores arrays, so only an array
 * could ever have populated it. gateway-kh answers with an envelope instead:
 *
 *   { "models": [ ... ], "freshness": { ... } }        (and `voices` for /v1/voices)
 *
 * Because each reader guarded with `if (!Array.isArray(payload)) throw`, EVERY
 * live catalogue refresh began failing the moment the endpoint moved — and the
 * failure is quiet, because the last-good cache keeps the app looking alive on
 * data that is hours old until it ages past the staleness limit and the pickers
 * empty. That is the worst shape a bug can have: working, then empty.
 *
 * Accepting both costs nothing and cannot invent a row: it reads the same
 * published rows from under the key the endpoint chose. `freshness` is
 * deliberately IGNORED — Story Studio tracks its own catalogue freshness
 * elsewhere and must not acquire a second, conflicting authority for it.
 *
 * Returns `null` when neither shape holds an array, so callers keep their
 * existing loud refusal rather than silently reading zero models.
 */
export function readCatalogRows(payload: unknown, key: 'models' | 'voices' = 'models'): unknown[] | null {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const rows = (payload as Record<string, unknown>)[key]
    if (Array.isArray(rows)) return rows
  }
  return null
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
  load: (signal: AbortSignal) => Promise<T>,
  options: { displayFallback?: boolean; baseUrl?: string; apiKey?: string } = {},
): Promise<GenStudioCatalogSnapshot<T>> {
  try {
    const { entry, freshness, now } = await cachedRemoteSnapshot(
      key,
      load,
      CATALOG_FRESH_MS,
      CATALOG_STALE_MS,
      (ageMs, cause) => new GenStudioCatalogUnavailableError(kind, ageMs, cause),
    )
    if (freshness === 'live' && options.baseUrl && options.apiKey) {
      // This copy only improves the next short outage. A settings-disk fault
      // must never turn a verified live catalogue into a failed display read.
      void queueLastGoodCatalogWrite(key, kind, entry.value, entry.loadedAt).catch(() => {})
    }
    return catalogSnapshot(kind, entry, freshness, now)
  } catch (error) {
    // Authentication/scope failures are never display fallbacks: a stale list
    // must not remain visible after an account loses entitlement.
    if (!options.displayFallback || (error instanceof GenStudioApiError && (error.status === 401 || error.status === 403))) throw error
    const fallback = await readLastGoodCatalog<T>(key, kind).catch(() => null)
    if (!fallback) throw error
    const now = Date.now()
    return catalogSnapshot(kind, {
      value: fallback.value,
      loadedAt: fallback.fetched_at,
      freshUntil: fallback.fetched_at,
      staleUntil: fallback.fetched_at + CATALOG_STALE_MS,
    }, 'stale', now)
  }
}

/**
 * The cache-with-stale-fallback every GenStudio read shares.
 *
 * One in-flight refresh is shared across concurrent callers; a successful load
 * always wins; a failed refresh falls back to the last copy while it is still
 * inside `staleMs`, and only when there is no usable copy left does the
 * caller's own `unavailable` error escape. Authentication and scope failures
 * never fall back — a key that lost its entitlement must not keep being served
 * data it is no longer allowed to see.
 *
 * `freshMs` of 0 means "always revalidate, but survive a blip": every call
 * attempts a live read and the cached copy exists only as a stale fallback.
 * That is what a moving number like a credit balance wants, where serving a
 * cached value on the happy path would show the balance lagging real spend.
 */
async function cachedRemoteSnapshot<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  freshMs: number,
  staleMs: number,
  unavailable: (ageMs: number | null, cause: unknown) => Error,
): Promise<{ entry: CatalogCacheEntry<T>; freshness: GenStudioCatalogFreshness; now: number }> {
  const now = Date.now()
  const cached = catalogCache.get(key) as CatalogCacheEntry<T> | undefined
  if (cached && cached.freshUntil > now) return { entry: cached, freshness: 'fresh', now }

  let refresh = catalogRefreshes.get(key) as CatalogRefresh<T> | undefined
  if (!refresh) {
    const generation = catalogGenerations.get(key) ?? 0
    const abort = new AbortController()
    const promise = load(abort.signal).then(value => {
      const loadedAt = Date.now()
      if ((catalogGenerations.get(key) ?? 0) === generation) {
        catalogCache.set(key, {
          value,
          loadedAt,
          freshUntil: loadedAt + freshMs,
          staleUntil: loadedAt + staleMs,
        })
      }
      return value
    }).finally(() => {
      if (catalogRefreshes.get(key) === refresh) catalogRefreshes.delete(key)
    })
    // A refresh superseded by a force-live read has no awaiter left, so its
    // abort must not surface as an unhandled rejection.
    promise.catch(() => {})
    refresh = { promise, abort }
    catalogRefreshes.set(key, refresh)
  }

  try {
    const value = await refresh.promise
    const entry = catalogCache.get(key) as CatalogCacheEntry<T> | undefined
    if (entry) return { entry, freshness: 'live', now: Date.now() }
    // A newer force-live request superseded this response. It may satisfy its
    // original ordinary caller, but it must never resurrect an old cache row.
    const loadedAt = Date.now()
    return {
      entry: { value, loadedAt, freshUntil: loadedAt, staleUntil: loadedAt },
      freshness: 'live',
      now: loadedAt,
    }
  } catch (error) {
    // Never serve account data the key is not (or no longer) entitled to.
    if (error instanceof GenStudioApiError && (error.status === 401 || error.status === 403)) throw error
    // A force-live read aborted this one on purpose. The refresh that replaced
    // it is the answer this caller was already waiting for, so join that rather
    // than reporting an abort as a catalogue failure.
    // ponytail: one level per supersession; a caller only ever re-enters onto
    // the refresh that is current, and force-live reads are user-initiated.
    const replacement = catalogRefreshes.get(key) as CatalogRefresh<T> | undefined
    if (replacement && replacement !== refresh && (error as any)?.name === 'AbortError') {
      return cachedRemoteSnapshot(key, load, freshMs, staleMs, unavailable)
    }
    const settledAt = Date.now()
    const fallback = catalogCache.get(key) as CatalogCacheEntry<T> | undefined
    if (fallback && fallback.staleUntil > settledAt) {
      return { entry: fallback, freshness: 'stale', now: settledAt }
    }
    throw unavailable(fallback ? Math.max(0, settledAt - fallback.loadedAt) : null, error)
  }
}

/**
 * Read one catalogue live, deliberately superseding an older in-flight read.
 * Used only where stale price data could authorise paid work.
 */
async function forceLiveCatalogSnapshot<T>(
  kind: GenStudioCatalogKind,
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  options: { baseUrl?: string; apiKey?: string } = {},
): Promise<GenStudioCatalogSnapshot<T>> {
  const generation = (catalogGenerations.get(key) ?? 0) + 1
  catalogGenerations.set(key, generation)
  // Supersede the warm copy for THIS read — but keep it. Deleting it outright destroyed the
  // only copy an ordinary reader had, so a failed paid-decision read reported "no cached
  // copy" and left the key empty for every later read, turning one failure into a wave of
  // refusals (mini 1.4.328, 2026-10-19: 9 image jobs refused, zero Gateway failures).
  // This read still never RETURNS the old copy — see the `freshness !== 'live'` guard below.
  const superseded = catalogCache.get(key) as CatalogCacheEntry<T> | undefined
  catalogCache.delete(key)
  // Abort the read this one supersedes rather than orphaning it. A superseded
  // request used to stay in flight — one socket held for its full 30 s timeout,
  // repeated by its two retries — while this read opened a second one beside it.
  catalogRefreshes.get(key)?.abort.abort()
  catalogRefreshes.delete(key)
  try {
    const snapshot = await cachedCatalogSnapshot(kind, key, load, options)
    if ((catalogGenerations.get(key) ?? 0) !== generation) {
      throw new Error(`The Gateway ${CATALOG_LABEL[kind]} catalogue force-live read was superseded by a newer refresh.`)
    }
    if (snapshot.freshness !== 'live') {
      throw new GenStudioCatalogUnavailableError(kind, snapshot.ageMs, new Error('force-live image catalog read was not live'))
    }
    return snapshot
  } catch (error) {
    // Hand the copy back for ordinary readers, unless a newer read already wrote one.
    if (superseded && !catalogCache.has(key)) catalogCache.set(key, superseded)
    throw error
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
  options: { modelId?: string; collection?: string; search?: string; displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioVoice[]>> {
  const baseUrl = await getGenStudioUrl()
  const query = new URLSearchParams()
  if (options.modelId?.trim()) query.set('model_id', options.modelId.trim())
  if (options.collection?.trim()) query.set('collection', options.collection.trim())
  if (options.search?.trim()) query.set('search', options.search.trim())
  const suffix = query.size ? `?${query.toString()}` : ''
  return cachedCatalogSnapshot('voices', catalogCacheKey('voices', `${baseUrl}${suffix}`, apiKey), async () => {
  const payload = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/voices${suffix}`, apiKey)
  // gateway-kh answers `{ voices, models }`; the old endpoint answered an array.
  const rows = readCatalogRows(payload, 'voices')
  if (!rows) throw new Error('The Gateway returned an invalid voice catalog')
  return rows.map((value: any) => ({
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
    // `story_row` publishes this on every voice, so a voice on the owner's own
    // Macs says `false` rather than leaving the customer to guess.
    ...parseGenStudioChargeable(value),
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
  }, { displayFallback: options.displayFallback, baseUrl, apiKey })
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
  options: { displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioTtsModel[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('tts-models', catalogCacheKey('tts-models', baseUrl, apiKey), async () => {
    const payload = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/tts/models`, apiKey)
    const rows = readCatalogRows(payload)
    if (!rows) throw new Error('The Gateway returned an invalid voice model catalog')
    return rows.flatMap((value: any): GenStudioTtsModel[] => {
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
        minimum_speed: optionalCount(value?.minimum_speed) ?? null,
        maximum_speed: optionalCount(value?.maximum_speed) ?? null,
        supports_voice_cloning: value?.supports_voice_cloning === true,
        preview_policy: typeof value?.preview_policy === 'string' ? value.preview_policy.trim() : '',
        generation_enabled: value?.generation_enabled === true,
        standard_credits: publishedCredits(value?.standard_credits) ?? null,
        sale_credits: publishedCredits(value?.sale_credits) ?? null,
        sale_ends_at: nullableText(value?.sale_ends_at),
        sale_disclaimer: nullableText(value?.sale_disclaimer),
        queue_class: value?.queue_class === 'relaxed' ? 'relaxed' : 'direct',
        relaxed_queue_hint: parseRelaxedQueueHint(value?.relaxed_queue_hint),
        supported_languages: Array.isArray(value?.supported_languages)
          ? value.supported_languages
            .filter((code: unknown): code is string => typeof code === 'string' && !!code.trim())
            .map((code: string) => code.trim())
          : [],
        ...parseGenStudioCatalogLock(value),
        ...parseGenStudioPriceTruth(value),
        ...parseGenStudioChargeable(value),
        ...(parseGenStudioCostTier(value?.cost_tier) ? { cost_tier: parseGenStudioCostTier(value?.cost_tier) } : {}),
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
        // The delivery/emotion control leaves as its own request field, so it
        // is read from the same published list by its own reader rather than
        // through the generic map (lib/tts-controls.ts). `null` = this model
        // publishes none, so the setting is hidden and nothing is sent.
        delivery_instruction: parseDeliveryInstructionControl(value?.controls),
        pause_parameters: parseTtsPauseParameters(value?.pause_parameters),
        // The identifiers this product also answers to, exactly as published.
        // Without this the TTS catalogue was the one modality that dropped
        // them, so a saved preset or remembered form holding a superseded id
        // could never be matched to the live row: the model resolved to
        // nothing, which left `selectedTtsModel` null and the voice picker
        // saying "Choose a voice model first." with the saved voice stranded.
        ...parseGenStudioProductAliases(value),
      }]
    })
  }, { ...options, baseUrl, apiKey })
}

export async function listTtsModels(apiKey: string): Promise<GenStudioTtsModel[]> {
  return (await listTtsModelsSnapshot(apiKey)).value
}

/** Fetch the account-visible music catalog without deriving availability or provider identity. */
export async function listMusicModelsSnapshot(
  apiKey: string,
  options: { displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioMusicModel[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('music', catalogCacheKey('music', baseUrl, apiKey), async () => {
    const payload = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/music/models`, apiKey)
    const rows = readCatalogRows(payload)
    if (!rows) throw new Error('The Gateway returned an invalid music model catalog')
    return rows.flatMap((value: any): GenStudioMusicModel[] => {
      const id = typeof value?.id === 'string' ? value.id.trim() : ''
      const displayName = typeof value?.display_name === 'string' ? value.display_name.trim() : ''
      const hasDescription = typeof value?.description === 'string'
      const description = hasDescription ? value.description.trim() : ''
      // ABSENT AND MALFORMED ARE DIFFERENT QUESTIONS, and collapsing them is what
      // emptied the music picker. `null`/omitted means "GenStudio published
      // nothing" — legal, and read as null below. A field PRESENT with the wrong
      // type is malformed, and still costs the row.
      const isAbsent = (field: unknown): boolean => field === null || field === undefined
      const isNullableInteger = (field: unknown): boolean => isAbsent(field) || Number.isInteger(field)
      const isNullableText = (field: unknown): boolean => isAbsent(field) || typeof field === 'string'
      const isNullableFlag = (field: unknown): boolean => isAbsent(field) || typeof field === 'boolean'
      if (
        !id || !displayName || !hasDescription || typeof value?.coming_soon !== 'boolean'
        || !Number.isInteger(value?.credits_per_request) || !Number.isInteger(value?.minimum_credits)
        || typeof value?.price_version !== 'string'
        || !isNullableInteger(value?.standard_credits) || !isNullableInteger(value?.sale_credits)
        || !isNullableText(value?.sale_ends_at) || !isNullableText(value?.sale_disclaimer)
        || !isNullableFlag(value?.chargeable)
        || !isNullableFlag(value?.supports_instrumental) || !isNullableFlag(value?.supports_vocals)
        || !isNullableFlag(value?.requires_lyrics)
        || !Number.isInteger(value?.max_prompt_characters)
        || !isNullableInteger(value?.max_prompt_without_lyrics_characters)
        || !isNullableInteger(value?.min_prompt_characters) || !Number.isInteger(value?.max_lyrics_characters)
        || !isNullableInteger(value?.min_lyrics_characters) || !Number.isInteger(value?.max_title_characters)
        || !isNullableInteger(value?.outputs_per_request)
      ) return []
      // An absent figure becomes null — NEVER false or 0. `supports_vocals: false`
      // would be a capability claim the catalogue never made.
      const publishedOrNull = <T>(field: T | null | undefined): T | null => field ?? null
      return [{
        id,
        display_name: displayName,
        provider_name: optionalText(value?.provider_name),
        description,
        coming_soon: value.coming_soon,
        ...parseGenStudioCatalogLock(value),
        ...parseGenStudioPriceTruth(value),
        credits_per_request: value.credits_per_request,
        minimum_credits: value.minimum_credits,
        price_version: value.price_version.trim(),
        ...parseGenStudioChargeable(value),
        ...(parseGenStudioCostTier(value?.cost_tier) ? { cost_tier: parseGenStudioCostTier(value?.cost_tier) } : {}),
        standard_credits: publishedOrNull(value.standard_credits),
        sale_credits: publishedOrNull(value.sale_credits),
        sale_ends_at: publishedOrNull(value.sale_ends_at),
        sale_disclaimer: publishedOrNull(value.sale_disclaimer),
        supports_instrumental: publishedOrNull(value.supports_instrumental),
        supports_vocals: publishedOrNull(value.supports_vocals),
        requires_lyrics: publishedOrNull(value.requires_lyrics),
        max_prompt_characters: value.max_prompt_characters,
        max_prompt_without_lyrics_characters: publishedOrNull(value.max_prompt_without_lyrics_characters),
        min_prompt_characters: publishedOrNull(value.min_prompt_characters),
        max_lyrics_characters: value.max_lyrics_characters,
        min_lyrics_characters: publishedOrNull(value.min_lyrics_characters),
        max_title_characters: value.max_title_characters,
        outputs_per_request: publishedOrNull(value.outputs_per_request),
        ...(Number.isFinite(value?.min_duration_seconds) && value.min_duration_seconds > 0 ? { min_duration_seconds: value.min_duration_seconds } : {}),
        ...(Number.isFinite(value?.max_duration_seconds) && value.max_duration_seconds > 0 ? { max_duration_seconds: value.max_duration_seconds } : {}),
        ...(Number.isFinite(value?.default_duration_seconds) && value.default_duration_seconds > 0 ? { default_duration_seconds: value.default_duration_seconds } : {}),
      }]
    })
  }, { ...options, baseUrl, apiKey })
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
  if (!id) throw new Error('A voice is needed to save this change.')
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
    throw new Error(`The Gateway publishes no voice library named "${library}".`)
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
  const payload: any = await fetchRetryingJson(`${apiBase(baseUrl)}${voiceLibraryPath(library)}${suffix}`, apiKey)
  if (!payload || !Array.isArray(payload.voices)) {
    throw new Error('The Gateway returned an invalid voice library page')
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
    body: wellFormedJson({ public_voice_id: id }),
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
    supportsSpeed?: boolean | null
    minimumSpeed?: number | null
    maximumSpeed?: number | null
    /**
     * Already resolved against the SELECTED model's published `controls[]`
     * (lib/tts-controls.ts). Sent verbatim so the quote prices the same
     * settings generation will submit — GenStudio's own quote takes them.
     */
    controls?: TtsControlValues
  },
): Promise<GenStudioTtsQuote> {
  const voiceId = request.voiceId.trim()
  if (!voiceId) throw new Error('Select a Gateway voice before asking for a quote.')
  // GenStudio requires `model_id` on the quote body too, so a conditional
  // spread here only bought the right to send a body GenStudio must reject —
  // and its rejection is a field-level 422 nobody reads as "we forgot the
  // model". Refuse locally, in our own name, instead.
  const modelId = request.modelId?.trim() || ''
  if (!modelId) {
    throw new Error(
      'Story Studio did not carry the selected voice model into this quote. The Gateway '
      + 'prices speech by model and requires model_id on every quote request.',
    )
  }
  if (!request.text.trim()) throw new Error('There is no text to quote.')
  const baseUrl = await getGenStudioUrl()
  const body: Record<string, unknown> = { model_id: modelId, voice_id: voiceId, text: request.text }
  body.speed = resolveGenStudioTtsSpeed(
    request.speed ?? 1,
    request.supportsSpeed,
    request.minimumSpeed,
    request.maximumSpeed,
  )
  // Omitted entirely when the model publishes no controls, so a request for
  // such a model is byte-identical to the one sent before controls existed.
  if (hasTtsControlValues(request.controls)) body.controls = orderedTtsControlValues(request.controls!)
  const response = await fetch(`${apiBase(baseUrl)}/v1/tts/quotes`, {
    method: 'POST',
    headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
    body: wellFormedJson(body),
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
    maximum_credits: optionalCount(payload?.maximum_credits) ?? null,
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
    throw new Error('The Gateway returned an invalid voice preview path')
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
    throw new Error('The Gateway sent no audio for this voice preview')
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mediaType,
  }
}

/** Fetch GenStudio's provider-owned capability registry without copying it into project config. */
export async function listModelCapabilitiesSnapshot(
  apiKey: string,
  options: { displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioModelCapability[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('capabilities', catalogCacheKey('capabilities', baseUrl, apiKey), async () => {
  const payload = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/models`, apiKey)
  const rows = readCatalogRows(payload)
  if (!rows) throw new Error('The Gateway returned an invalid capability catalog')
  const modalities = new Set(['audio', 'image', 'text', 'video'])
  const operations = new Set(['voice.tts', 'audio.transcription', 'image.generation', 'chat.response', 'video.generation'])
  const availability = new Set(['available', 'unavailable', 'unknown'])
  return rows.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    revision: typeof value?.revision === 'string' ? value.revision.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    modality: value?.modality,
    operation: value?.operation,
    availability: availability.has(value?.availability) ? value.availability : 'unknown',
    cost_tier: value?.operation === 'chat.response'
      ? parseGenStudioLlmCostTier(value?.cost_tier)
      : parseGenStudioCostTier(value?.cost_tier),
    qualification_only: value?.qualification_only !== false,
    pricing_unit: typeof value?.pricing_unit === 'string' ? value.pricing_unit.trim() : undefined,
    limits: value?.limits && typeof value.limits === 'object' ? value.limits : {},
    controls: value?.controls && typeof value.controls === 'object' ? value.controls : {},
  })).filter((model: GenStudioModelCapability) => (
    !!model.id && !!model.display_name && modalities.has(model.modality) && operations.has(model.operation)
  ))
  }, { ...options, baseUrl, apiKey })
}

export async function listModelCapabilities(apiKey: string): Promise<GenStudioModelCapability[]> {
  return (await listModelCapabilitiesSnapshot(apiKey)).value
}

/**
 * Normalize the published CONTEXT-WINDOW limit onto Story Studio's `number`
 * contract, preferring the current field and accepting its deprecated alias
 * only when the current field is absent.
 *
 * THE WIRE FORM AND THE LOCAL SENTINEL ARE DIFFERENT, AND THAT IS DELIBERATE
 * (recorded 2026-09-18). gateway-kh may publish
 * `context_window_tokens: null` when a provider states no figure. Story
 * Studio's context-window sentinel for "not published" is `0`; every
 * non-integer becomes that sentinel, while the historical integer clamp is
 * preserved. This function does NOT parse `max_output_tokens`, whose malformed
 * values must be distinguished from a genuine null/omission before submission.
 *
 * Do not "fix" the context-window field into a nullable type. Its callers use
 * `0` as the established unknown sentinel, including arithmetic through
 * `availableInputTokens`.
 */
function readPublishedTokenLimit(preferred: unknown, deprecatedAlias: unknown): number {
  if (Number.isInteger(preferred)) return Math.max(1, preferred as number)
  if (Number.isInteger(deprecatedAlias)) return Math.max(1, deprecatedAlias as number)
  return 0
}

/**
 * Preserve the three authoritative chat output-limit states at ingestion:
 * omitted/null, a positive safe integer, or malformed. The first keeps the
 * existing local `0` sentinel; the second is copied exactly; the third stops
 * before any request can mistake bad catalogue data for an omission or `1`.
 *
 * The malformed value is deliberately not interpolated into the error: a wire
 * object is arbitrary remote data and may contain private provider metadata.
 */
function readPublishedChatMaxOutputTokens(value: unknown, rawModelId: unknown): number {
  if (value === null || value === undefined) return 0
  if (Number.isSafeInteger(value) && (value as number) > 0) return value as number
  const modelId = typeof rawModelId === 'string' && rawModelId.trim()
    ? rawModelId.trim().replace(/[\r\n\t]/g, ' ').slice(0, 120)
    : '(missing model id)'
  throw new GenStudioCatalogFieldValidationError(
    `Gateway chat model ${JSON.stringify(modelId)} published malformed max_output_tokens; `
    + 'expected null/omitted or a positive safe integer. No request or credit charge was made.',
  )
}

/**
 * Read GenStudio's relaxed-queue hint, or nothing at all.
 *
 * All three parts or none: a percentage with no threshold, or a threshold with
 * no sentence, is a half-stated offer, and half an offer shown to a paying
 * customer is worse than no offer shown. There is no fallback wording and no
 * fallback number here on purpose — Story Studio does not know what the relaxed
 * shelf costs or what it promises, and must never appear to.
 */
function parseRelaxedQueueHint(value: unknown): GenStudioRelaxedQueueHint | null {
  if (!value || typeof value !== 'object') return null
  const hint = value as Record<string, unknown>
  const message = nullableText(hint.message)
  if (!message) return null
  if (!Number.isFinite(hint.discount_percent) || (hint.discount_percent as number) <= 0) return null
  if (!Number.isInteger(hint.unlock_threshold_cents) || (hint.unlock_threshold_cents as number) < 0) return null
  return {
    discount_percent: hint.discount_percent as number,
    unlock_threshold_cents: hint.unlock_threshold_cents as number,
    message,
  }
}

export async function listChatModelsSnapshot(
  apiKey: string,
  options: { displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioChatModel[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('chat', catalogCacheKey('chat', baseUrl, apiKey), async () => {
  const payload = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/chat/models`, apiKey)
  const rows = readCatalogRows(payload)
  if (!rows) throw new Error('The Gateway returned an invalid chat model catalog')
  return rows.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    ...parseGenStudioProductAliases(value),
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    provider_name: publishedText(value?.provider_name),
    // Read, never derived: the provider KIND the catalogue states. A Gateway
    // that publishes none leaves it absent, and every reader must treat absence
    // as "not stated" rather than assuming a kind (§2).
    ...(publishedText(value?.provider_id) ? { provider_id: publishedText(value?.provider_id) } : {}),
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    available: value?.available === true,
    qualification_only: value?.qualification_only !== false,
    ...parseGenStudioCatalogLock(value),
    ...parseGenStudioPriceTruth(value),
    max_prompt_characters: publishedPositiveInteger(value?.max_prompt_characters),
    context_window_tokens: readPublishedTokenLimit(
      value?.context_window_tokens,
      value?.context_limit_tokens,
    ),
    // 0 means genuinely null/omitted — never malformed and never a Story
    // Studio guess. This used to
    // default to 2,048, which is the invented-fallback bug in its most
    // expensive form: every consumer downstream (the pre-network ceiling
    // check, the credit reservation, the chunking maths) would treat 2,048 as
    // a figure GenStudio had published for the product, and a chapter sized
    // against it comes back truncated after the customer has paid for it.
    max_output_tokens: readPublishedChatMaxOutputTokens(value?.max_output_tokens, value?.id),
    max_output_tokens_source: readPublishedLimitSource(value?.max_output_tokens_source),
    max_structured_items_per_request: Number.isInteger(value?.max_structured_items_per_request)
      && value.max_structured_items_per_request > 0
      ? value.max_structured_items_per_request
      : null,
    controls: Array.isArray(value?.controls) ? value.controls.filter((item: unknown) => typeof item === 'string') : [],
    activation_blockers: Array.isArray(value?.activation_blockers)
      ? value.activation_blockers.filter((item: unknown) => typeof item === 'string')
      : [],
    input_credits_per_million_tokens: publishedCredits(value?.input_credits_per_million_tokens),
    output_credits_per_million_tokens: publishedCredits(value?.output_credits_per_million_tokens),
    minimum_credits: Number.isFinite(value?.minimum_credits)
      ? Math.max(0, value.minimum_credits)
      : 0,
    price_version: typeof value?.price_version === 'string' ? value.price_version.trim() : '',
    ...(parseGenStudioLlmCostTier(value?.cost_tier) ? { cost_tier: parseGenStudioLlmCostTier(value?.cost_tier) } : {}),
    // Gateway 0.2.100+: true when the request may cost money (a pool is chargeable if any member is).
    ...parseGenStudioChargeable(value),
    // Read, never authored. An older GenStudio that publishes neither field
    // simply carries no notice — which is the truth, not a default.
    discount: value?.discount === true,
    discount_disclaimer: optionalText(value?.discount_disclaimer) ?? null,
    // The shelf, and the offer that shelf carries. Read on exactly the same
    // terms as the disclosure above: anything GenStudio does not publish is
    // absent rather than defaulted. An unrecognised `queue_class` reads
    // `direct` — the undivided catalogue this app has always shown — because
    // inventing a new section for a value nobody here understands would put a
    // heading in front of a customer that means nothing.
    queue_class: (value?.queue_class === 'relaxed' ? 'relaxed' : 'direct') as GenStudioChatModel['queue_class'],
    relaxed_queue_hint: parseRelaxedQueueHint(value?.relaxed_queue_hint),
    // The "was" prices. `publishedCredits` returns undefined for anything that
    // is not a real published figure, and null is the contract here: no sale
    // is being applied to this account, so there is no second price to strike
    // through and none is manufactured.
    standard_input_credits_per_million_tokens:
      publishedCredits(value?.standard_input_credits_per_million_tokens) ?? null,
    standard_output_credits_per_million_tokens:
      publishedCredits(value?.standard_output_credits_per_million_tokens) ?? null,
    standard_minimum_credits: publishedCredits(value?.standard_minimum_credits) ?? null,
    // Retirement schedule, read exactly as published. Same contract as the
    // disclosure above: an older GenStudio that publishes none of this carries
    // no retirement, which is the truth rather than a default. Story Studio
    // never opens a warning window of its own, and never invents a date — a
    // date this app made up is a promise GenStudio has not made, and the
    // customer cannot tell it apart from a real one.
    deprecation_warning: value?.deprecation_warning === true,
    deprecation_warning_at: readReportedTimestamp(value?.deprecation_warning_at),
    scheduled_retirement_at: readReportedTimestamp(value?.scheduled_retirement_at),
    upstream_shutdown_at: readReportedTimestamp(value?.upstream_shutdown_at),
    retires_at: readReportedTimestamp(value?.retires_at),
    // A catalogue id, carried through untouched. It is resolved to a display
    // name at the point of display, against this same catalogue.
    replacement_model_id: nullableText(value?.replacement_model_id),
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
    // An EXPLICIT 'none' is preserved; anything absent or unrecognised still
    // reads as 'json_object'. A missing field means an older GenStudio that
    // never published the property, and defaulting that to 'none' would refuse
    // every contract-bound stage on an otherwise healthy catalogue. Absent and
    // none are different claims and are no longer flattened together.
    structured_output_mode: (
      value?.structured_output_mode === 'request_json_schema'
        ? 'request_json_schema'
        : value?.structured_output_mode === 'none'
          ? 'none'
          : 'json_object'
    ) as GenStudioChatModel['structured_output_mode'],
    // Web-search capability. Every flag defaults to the SAFE value (false /
    // null) when the catalogue omits it: an older GenStudio release that has
    // never heard of web search must read as "not web-capable", never as
    // "capable and unrestricted".
    supports_web_search: value?.supports_web_search === true,
    // NOT `=== true`. `null` is a real answer here — the provider did not say —
    // and the gateway now publishes it that way for every row. Flattening it to
    // `false` would report a provider as having refused citations when it was
    // never asked. Consumers that gate a capability still require `=== true`,
    // so the outcome is unchanged; what changes is that the two facts stop
    // sharing a value.
    returns_citations: typeof value?.returns_citations === 'boolean' ? value.returns_citations : null,
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
  }, { ...options, baseUrl, apiKey })
}

export async function listChatModels(apiKey: string): Promise<GenStudioChatModel[]> {
  return (await listChatModelsSnapshot(apiKey)).value
}

export async function listVideoModelsSnapshot(
  apiKey: string,
  options: { displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioVideoModel[]>> {
  return loadVideoModelsSnapshot(apiKey, options)
}

async function loadVideoModelsSnapshot(
  apiKey: string,
  options: { displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioVideoModel[]>> {
  const baseUrl = await getGenStudioUrl()
  return cachedCatalogSnapshot('video', catalogCacheKey('video', baseUrl, apiKey), async () => {
  const payload = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/videos/models`, apiKey)
  const rows = readCatalogRows(payload)
  if (!rows) throw new Error('The Gateway returned an invalid video model catalog')
  return rows.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    ...parseGenStudioProductAliases(value),
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    // Published by gateway-kh for every model kind since 2026-09-18. Read here
    // so the fact survives the transport instead of being discarded.
    provider_name: typeof value?.provider_name === 'string' && value.provider_name.trim()
      ? value.provider_name.trim()
      : undefined,
    available: value?.available === true,
    ...parseGenStudioCatalogLock(value),
    ...parseGenStudioPriceTruth(value),
    ...parseGenStudioChargeable(value),
    ...(parseGenStudioCostTier(value?.cost_tier) ? { cost_tier: parseGenStudioCostTier(value?.cost_tier) } : {}),
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
    // positive safe-integer duration, a non-empty resolution label,
    // non-negative safe-integer prices, and a non-empty price version. A 4k
    // or 8-second product GenStudio publishes today therefore reaches the UI
    // unchanged; the old filter dropped it silently, leaving the model looking
    // as if it had no variants at all.
    variants: Array.isArray(value?.variants)
      ? value.variants.filter((item: any) => (
          Number.isSafeInteger(item?.duration_seconds)
          && item.duration_seconds > 0
          && typeof item?.operation === 'string'
          && item.operation.trim().length > 0
          && typeof item?.resolution === 'string'
          && item.resolution.trim().length > 0
          && Number.isSafeInteger(item?.credits_per_video)
          && item.credits_per_video >= 0
          && Number.isSafeInteger(item?.minimum_credits)
          && item.minimum_credits >= 0
          && typeof item?.price_version === 'string'
          && item.price_version.trim().length > 0
        )).map((item: any): GenStudioVideoVariant => ({
          operation: item.operation.trim(),
          duration_seconds: item.duration_seconds,
          resolution: item.resolution.trim(),
          // Carried only when published. A product that states no ratio per variant must not
          // acquire one in transport — the request builder omits the field instead.
          ...(typeof item.aspect_ratio === 'string' && item.aspect_ratio.trim()
            ? { aspect_ratio: item.aspect_ratio.trim() }
            : {}),
          credits_per_video: item.credits_per_video,
          minimum_credits: item.minimum_credits,
          price_version: item.price_version.trim(),
        }))
      : [],
    // Tri-state. An absent or non-boolean field is `null` ("GenStudio did not
    // say"), never coerced to `false` — claiming a model is silent when the
    // catalogue never said so is inventing a capability answer.
    generates_audio: typeof value?.generates_audio === 'boolean' ? value.generates_audio : null,
    // Every published boolean switch, carried whole: the name a caller keys a
    // value by, the lane's default, and the lane's own note. Nothing is
    // synthesised here — a row whose catalogue entry lists no switches carries
    // no `controls` key at all, which is how a caller tells "none published"
    // from "published as none". A malformed entry is dropped rather than
    // repaired: a switch this transport cannot describe is one no surface may
    // render, and inventing a default would decide a lane's behaviour.
    ...(publishedVideoControls(value?.controls).length
      ? { controls: publishedVideoControls(value?.controls) }
      : {}),
  })).filter((model: GenStudioVideoModel) => model.id && model.display_name)
  }, { ...options, baseUrl, apiKey })
}

/**
 * The published switches on one video row, filtered to what a caller can use.
 *
 * Extracted from the parse so the same rule shapes the type it produces: a
 * control needs a name to be settable and must be a boolean to be a switch. A
 * `note` and a `default` are optional and are never coerced — a lane that
 * stated no default gets `null`, so a surface falls back to its own display
 * rather than showing a value the lane never chose.
 */
export function publishedVideoControls(value: unknown): GenStudioVideoControl[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: any): GenStudioVideoControl[] => {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (!name) return []
    if (String(entry?.type ?? '').trim().toLowerCase() !== 'boolean') return []
    return [{
      name,
      type: 'boolean' as const,
      default: typeof entry?.default === 'boolean' ? entry.default : null,
      note: typeof entry?.note === 'string' && entry.note.trim() ? entry.note.trim() : null,
    }]
  })
}

export async function listVideoModels(apiKey: string): Promise<GenStudioVideoModel[]> {
  return (await listVideoModelsSnapshot(apiKey)).value
}

export function videoSourceMediaType(filename: string, bytes?: Uint8Array): string {
  // The bytes win over the name: "Archive episode" re-saves scene images as JPEG under their .png names.
  // One rule — the canonical sniffer — so PNG, JPEG AND WebP are read from the bytes,
  // not only the JPEG magic: the gateway relays `data:image/{png|jpeg|webp}`, so a
  // WebP saved under a `.png` name must declare what it really is (the type the
  // vision check and the durable reference record already use).
  const sniffed = bytes
    ? sniffImageMediaType(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    : null
  if (sniffed) return sniffed
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
  sourceSha256?: string
  /** Absent when the product published no ratio: the key then describes a request that sends none. */
  aspectRatio?: string
  operation: string
  durationSeconds: number
  resolution: string
  /**
   * The published `audio` switch, when it was set.
   *
   * **A digest component because it changes what is bought.** `false` asks for a
   * clip with no track, which is a different artifact from the one the same
   * prompt buys with sound; a key that ignored it would let a retry after
   * unticking the box re-attach to the track-bearing job and report success for
   * a request nobody made. It is written as a tri-state (`null` when unstated)
   * so "the lane defaulted" and "the caller asked for sound" are distinct
   * requests rather than the same key.
   */
  audio?: boolean
  requestIdentity?: string
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    prompt: input.prompt.trim(),
    model_id: input.modelId.trim(),
    source_sha256: input.sourceSha256 || '',
    aspect_ratio: input.aspectRatio,
    operation: input.operation,
    duration_seconds: input.durationSeconds,
    resolution: input.resolution,
    audio: typeof input.audio === 'boolean' ? input.audio : null,
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
  let reportedEvidence = ''
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || ''
    const evidenceFingerprint = providerEvidenceFingerprint(current)
    if (reportedState === current.state && reportedRoutingState === routingState && reportedEvidence === evidenceFingerprint) return
    reportedState = current.state
    reportedRoutingState = routingState
    reportedEvidence = evidenceFingerprint
    await recordGenStudioEvidence('video.generation', current)
    await reportQueueState(request, current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!poller.settled(current)) {
    await submitQueuedRemoteCancellation('video.generation', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) {
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) throw new Error('The video was not ready at the Gateway in time.')
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/videos/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
      undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
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
    undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
  ) as GenStudioVideoJob
  // Classify BEFORE polling. A job that already failed (or was cancelled)
  // cannot become a clip, and a poll loop would only re-read the same terminal
  // record forever.
  if ((initial.state === 'failed' || initial.cancelled === true) && !holdsUnknownOutcome(initial)) {
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
  if (prompt.length < 3 || prompt.length > 4_000) throw new Error('Gateway video prompts must contain 3 to 4,000 characters.')
  if (!modelId) throw new Error('Select a Gateway video model.')
  if (!STORY_STUDIO_VIDEO_MODES.includes(request.operation as any)) {
    throw new Error(`Story Studio only submits the published ${STORY_STUDIO_VIDEO_MODES.join(', ')} video operations.`)
  }
  let sourceAssetId: string | undefined
  let sourceSha256 = ''
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS

  if (request.operation === 'image-to-video') {
    if (!request.sourceImagePath) throw new Error('Gateway image-to-video request requires a source image path.')
    const source = await fs.readFile(request.sourceImagePath)
    if (!source.length) throw new Error('Gateway video source image is empty.')
    sourceSha256 = createHash('sha256').update(source).digest('hex')
    const uploadBody = new FormData()
    uploadBody.set(
      'upload',
      new Blob([new Uint8Array(source)], { type: videoSourceMediaType(request.sourceImagePath, source) }),
      path.basename(request.sourceImagePath),
    )
    const sourceAsset = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/videos/source-images`,
      { method: 'POST', headers: authorization(apiKey), body: uploadBody },
      request,
      deadline,
    ) as GenStudioVideoSourceAsset
    if (!sourceAsset.id) throw new Error('Gateway video source upload returned no asset id.')
    sourceAssetId = sourceAsset.id
  } else if (request.sourceImagePath && existsSync(request.sourceImagePath)) {
    const source = await fs.readFile(request.sourceImagePath).catch(() => Buffer.alloc(0))
    if (source.length) {
      sourceSha256 = createHash('sha256').update(source).digest('hex')
    }
  }

  // A caller that checkpointed its key before this call is authoritative: that
  // persisted key is exactly what makes a lost submit response replay instead
  // of creating a second paid job.
  const idempotencyKey = request.idempotencyKey?.trim() || buildGenStudioVideoIdempotencyKey({
    prompt,
    modelId,
    sourceSha256,
    aspectRatio: request.aspectRatio,
    operation: request.operation,
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    audio: request.audio,
    requestIdentity: request.requestIdentity,
  })

  const requestPreview = await recordGenStudioRequestPreview('video.generation', {
    method: 'POST',
    path: '/v1/videos/generations',
    modelId,
    idempotencyKey,
    messages: [{ role: 'prompt', content: prompt }],
    fields: [
      ['mode', request.operation],
      ['duration_seconds', request.durationSeconds],
      ['resolution', request.resolution],
      ...(request.aspectRatio ? [['aspect_ratio', request.aspectRatio] as [string, string]] : []),
      // Only the OFF half of a published switch is ever sent, and only when the
      // caller set it. The request preview is what the owner reads to see what
      // was actually asked for, so a silent request has to say so here — an
      // omission would make the two requests look identical in the record.
      ...(typeof request.audio === 'boolean' ? [['audio', String(request.audio)] as [string, string]] : []),
      ...(sourceAssetId ? [['reference_asset_id', sourceAssetId] as [string, string]] : []),
    ],
  })
  const jobGroup = await jobGroupField()
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
      body: wellFormedJson({
        ...jobGroup,
        prompt,
        model_id: modelId,
        mode: request.operation,
        ...(sourceAssetId ? { reference_asset_id: sourceAssetId } : {}),
        aspect_ratio: request.aspectRatio,
        duration_seconds: request.durationSeconds,
        resolution: request.resolution,
        // Omitted entirely unless the caller set a published switch: the lane's
        // own default is the right answer for a caller who stated nothing, and
        // sending `true` on every request would override a lane whose default
        // is the other way.
        ...(typeof request.audio === 'boolean' ? { audio: request.audio } : {}),
      }),
    },
    request,
    deadline,
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [],
    { operation: 'video.generation', preview: requestPreview },
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

// ── Music ─────────────────────────────────────────────────────────────────
//
// v1.4.37. The first modality where ONE settled, once-charged job yields MORE
// THAN ONE paid artefact. Measured on the first music job ever run through
// GenStudio (2026-08-23): Suno V5.5 reserved 100 credits, captured 100, and
// returned two complete tracks of 2:50 and 3:09. Both are the owner's. Taking
// only `outputs[0]` would silently throw away half of what he paid for, which
// is the whole reason `GenStudioMusicResult` carries an ARRAY and every caller
// is forced to decide what to do with all of it.
//
// GenStudio does not declare how many to expect — Suno's `outputs_per_request`
// is deliberately null so the rate card can promise "All returned variations",
// which stays true whether one, two or three come back. So the count is read
// from the response, never assumed.

/** One track from a settled music job. */
export interface GenStudioMusicTrack {
  assetId: string
  url: string
}

export interface GenStudioMusicResult {
  /** EVERY track the job returned, in the order GenStudio listed them. */
  tracks: GenStudioMusicTrack[]
  jobId: string
  modelId: string
  downloadHeaders: Record<string, string>
  creditCost: number
  remainingCredits: number
  priceVersion: string
}

/** `POST /v1/music/generations` and `GET /v1/music/jobs/{id}` response. */
export interface GenStudioMusicJob extends GenStudioSettledJobShape {
  state: GenStudioJob['state']
  model_id: string
  title: string
  instrumental: boolean
  outputs?: Array<{ asset_id?: string; url?: string }>
  credit_cost: number
  remaining_credits: number
  price_version: string
  routing_status_code?: string
  queue_position?: number | null
  queue_eta_seconds?: number | null
  queue_reason?: 'provider_pace' | null
  recovery_required?: boolean | null
  recovery_state?: string | null
  waiting?: GenStudioWaiting | null
}

export interface GenStudioMusicRequest extends GenStudioOperationContext {
  title: string
  prompt: string
  lyrics?: string
  instrumental: boolean
  /** Track length in seconds. Sent only when the caller states one; the lane's own default applies otherwise. */
  durationSeconds?: number
  modelId: string
  requestIdentity?: string
  /** `m4a` asks the lane for AAC instead of WAV. Absent = native (today's behaviour). */
  outputFormat?: 'm4a'
  /** Sent only when the caller states one (the Song Pool does, so a retake is a new seed). */
  seed?: number
  /** 1.4.270 — Gateway 0.2.165+ `priority`: 'background' runs only on idle Macs. Not part of the idempotency key. */
  priority?: 'background'
  idempotencyKey?: string
  isCancelled?: () => boolean
  onJobAccepted?: (jobId: string, idempotencyKey: string) => Promise<void> | void
  onState?: (state: string, jobId: string) => Promise<void> | void
  onReconnect?: (jobId: string, reason: string) => Promise<void> | void
}

/**
 * The idempotency key for one music request.
 *
 * `requestIdentity` is what a retry moves after a settled failure — a settled
 * job can never be reopened, so without it a retry would replay the dead key
 * forever. `instrumental` and `lyrics` are digest components because they
 * change what is bought: the same prompt with vocals is a different song.
 */
export function buildGenStudioMusicIdempotencyKey(input: {
  title: string
  prompt: string
  lyrics?: string
  instrumental: boolean
  durationSeconds?: number
  modelId: string
  requestIdentity?: string
  outputFormat?: 'm4a'
  seed?: number
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    lyrics: input.lyrics?.trim() || null,
    instrumental: input.instrumental,
    model_id: input.modelId.trim(),
    request_identity: input.requestIdentity || null,
    // Only when stated, so every key minted before a length existed is byte-identical and a retry
    // that crosses this upgrade replays its job. A different length is different work.
    ...(input.durationSeconds ? { duration_seconds: input.durationSeconds } : {}),
    // Only when set: a key built without it must stay byte-identical, so an in-flight
    // job (and every old caller) still replays on the key it was submitted with.
    ...(input.outputFormat ? { output_format: input.outputFormat } : {}),
    // Only when set, for the same reason: every key minted without a seed stays byte-identical.
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  })).digest('hex')
  return `story-music-${digest.slice(0, 44)}`
}

/**
 * Poll one accepted music job to a settled outcome. Mirrors `waitForVideoJob`:
 * terminal is `succeeded` | `failed`, with cancellation riding on the
 * `cancelled` boolean rather than a state of its own.
 */
async function waitForMusicJob(
  baseUrl: string,
  apiKey: string,
  submitted: GenStudioMusicJob,
  request: GenStudioMusicRequest,
  deadline: number,
): Promise<GenStudioMusicJob> {
  let current = submitted
  let reportedState = ''
  let reportedRoutingState = ''
  let reportedEvidence = ''
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || ''
    const evidenceFingerprint = providerEvidenceFingerprint(current as GenStudioJob)
    if (reportedState === current.state && reportedRoutingState === routingState && reportedEvidence === evidenceFingerprint) return
    reportedState = current.state
    reportedRoutingState = routingState
    reportedEvidence = evidenceFingerprint
    await recordGenStudioEvidence('music.generation', current)
    await reportQueueState(request, current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!poller.settled(current)) {
    await submitQueuedRemoteCancellation('music.generation', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
    if (Date.now() >= deadline) throw new Error('The music was not ready at the Gateway in time.')
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/music/jobs/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
      undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
    ) as GenStudioMusicJob
    await reportState()
  }
  await genStudioAdmission.notifyTerminal(apiKey)
  if (current.state === 'failed' || current.cancelled === true) {
    throw new GenStudioMusicTerminalFailureError(current)
  }
  return current
}

/**
 * Turn a settled job into every track it produced.
 *
 * Refuses an empty list rather than returning a result with no music in it: a
 * succeeded job with nothing to download is a broken assumption, and silently
 * handing back zero tracks would look to a caller exactly like a song the owner
 * chose not to keep.
 */
function musicResult(
  baseUrl: string,
  apiKey: string,
  completed: GenStudioMusicJob,
): GenStudioMusicResult {
  const tracks = (completed.outputs || [])
    .filter(o => typeof o?.asset_id === 'string' && o.asset_id.trim().length > 0)
    .map(o => ({
      assetId: String(o.asset_id).trim(),
      url: requestUrl(
        baseUrl,
        o.url || `/v1/music/jobs/${encodeURIComponent(completed.id)}/outputs/${encodeURIComponent(String(o.asset_id).trim())}`,
      ),
    }))
  if (!tracks.length) {
    throw new Error(`The Gateway finished music job ${completed.id} but sent no tracks.`)
  }
  return {
    tracks,
    jobId: completed.id,
    modelId: completed.model_id,
    downloadHeaders: authorization(apiKey),
    creditCost: completed.credit_cost,
    remainingCredits: completed.remaining_credits,
    priceVersion: completed.price_version,
  }
}

/**
 * Fetch one finished music track (a ~40 MB WAV) from the gateway, with a time limit and a retry.
 *
 * It used to be a bare `fetch`: no timeout, no retry, so a stalled socket hung the whole top-up and
 * a dropped one failed a track that was already paid for. The job is finished and its artifact is
 * on the gateway, so a retry only re-reads it; a 404/410 means the artifact was pruned, which a
 * retry cannot fix. Re-running the track after a failure replays the same idempotency key and so
 * reclaims this same job rather than buying another.
 */
export async function downloadGenStudioMusicTrack(
  url: string,
  headers: Record<string, string>,
  request: { signal?: AbortSignal; isCancelled?: () => boolean } = {},
  trackNumber = 1,
): Promise<Buffer> {
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: operationSignal(request.signal, deadline, GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          throw new GenStudioMusicArtifactUnavailableError(trackNumber, response.status)
        }
        const error = new Error(`Could not download track ${trackNumber}: HTTP ${response.status}`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (!bytes.length) throw new Error(`Track ${trackNumber} arrived empty.`)
        return bytes
      }
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      if (error instanceof GenStudioMusicArtifactUnavailableError) throw error
      lastError = error
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      if (!/timeout|timed out|fetch failed|network|socket|ECONN|HTTP (408|425|429|5\d\d)|terminated/i.test(message)
        && !(error instanceof DOMException)) throw error
    }
    if (attempt < NETWORK_RETRY_ATTEMPTS) await retryDelay(attempt, request, deadline)
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not download track ${trackNumber} after retries.`)
}

export class GenStudioMusicArtifactUnavailableError extends Error {
  constructor(readonly trackNumber: number, readonly status: number) {
    super(`Track ${trackNumber} is no longer on the gateway (HTTP ${status}); it was cleaned up before it was saved. Re-run the top-up to make it again.`)
    this.name = 'GenStudioMusicArtifactUnavailableError'
  }
}

/**
 * Read ONE already accepted music task and return its published outputs. A single authenticated
 * `GET /v1/music/jobs/{id}`: it never polls, submits, cancels, recovers by key or picks another
 * model. Anything but this exact task/model as a settled, uncancelled success with unique outputs
 * is refused with `statusCode: 409`; transport and HTTP failures propagate unchanged.
 */
export async function readSucceededGenStudioMusicJob(
  apiKey: string,
  taskId: string,
  modelId: string,
): Promise<GenStudioMusicResult> {
  const baseUrl = await getGenStudioUrl()
  const job = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/music/jobs/${encodeURIComponent(taskId)}`,
    { headers: authorization(apiKey) },
    {},
    Date.now() + GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    apiKey,
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [],
    true,
    1,
  ) as GenStudioMusicJob
  const refuse = (detail: string) => Object.assign(new Error(detail), { statusCode: 409 })
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.id !== taskId) {
    throw refuse('The Gateway answered for a different music task; nothing was imported.')
  }
  if (job.model_id !== modelId) throw refuse('The Gateway reports a different model for this music task; nothing was imported.')
  if (job.state !== 'succeeded' || job.cancelled === true) {
    throw refuse(holdsUnknownOutcome(job)
      ? 'The Gateway is still checking this music result; nothing was run twice. Try again later.'
      : `This music task is ${job.cancelled === true ? 'cancelled' : job.state}, not finished with a result; nothing was imported and no new request was made.`)
  }
  const ids = Array.isArray(job.outputs) ? job.outputs.map(o => typeof o?.asset_id === 'string' ? o.asset_id.trim() : '') : []
  if (!ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw refuse('The Gateway finished this music task without a usable output list; nothing was imported.')
  }
  return musicResult(baseUrl, apiKey, job)
}

/** Reconnect to an already accepted music task. Never submits new work. */
async function recoverMusicWithGenStudioAdmitted(
  apiKey: string,
  jobId: string,
  request: GenStudioMusicRequest,
): Promise<GenStudioMusicResult> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const initial = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/music/jobs/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
    undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
  ) as GenStudioMusicJob
  // Classify BEFORE polling. A job that already failed cannot become a song,
  // and a poll loop would only re-read the same terminal record forever.
  if ((initial.state === 'failed' || initial.cancelled === true) && !holdsUnknownOutcome(initial)) {
    await recordGenStudioEvidence('music.generation', initial)
    await reportQueueState(request, initial)
    await request.onState?.(initial.state, initial.id)
    throw new GenStudioMusicTerminalFailureError(initial)
  }
  const completed = initial.state === 'succeeded'
    ? initial
    : await waitForMusicJob(baseUrl, apiKey, initial, request, deadline)
  if (completed === initial) {
    await recordGenStudioEvidence('music.generation', initial)
    await reportQueueState(request, initial)
    await request.onState?.(initial.state, initial.id)
  }
  return musicResult(baseUrl, apiKey, completed)
}

export async function generateMusicWithGenStudio(
  apiKey: string,
  request: GenStudioMusicRequest,
): Promise<GenStudioMusicResult> {
  const title = request.title.trim()
  const prompt = request.prompt.trim()
  const modelId = request.modelId.trim()
  if (!title) throw new Error('Music needs a title.')
  if (!prompt) throw new Error('Music needs a creative direction.')
  if (!modelId) throw new Error('Select a Gateway music model.')
  // A caller that checkpointed its key before this call is authoritative: that
  // persisted key is exactly what makes a lost submit response replay instead
  // of creating a second paid job.
  const idempotencyKey = request.idempotencyKey?.trim() || buildGenStudioMusicIdempotencyKey({
    title,
    prompt,
    lyrics: request.lyrics,
    instrumental: request.instrumental,
    durationSeconds: request.durationSeconds,
    modelId,
    requestIdentity: request.requestIdentity,
    outputFormat: request.outputFormat,
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  })
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const requestPreview = await recordGenStudioRequestPreview('music.generation', {
    method: 'POST',
    path: '/v1/music/generations',
    modelId,
    idempotencyKey,
    messages: [{ role: 'prompt', content: prompt }],
    fields: [
      ['title', title],
      ['instrumental', request.instrumental],
      ...(request.durationSeconds ? [['duration_seconds', request.durationSeconds] as [string, number]] : []),
      ...(request.lyrics?.trim() ? [['lyrics_characters', request.lyrics.trim().length] as [string, number]] : []),
      ...(request.outputFormat ? [['output_format', request.outputFormat] as [string, string]] : []),
      ...(request.seed !== undefined ? [['seed', request.seed] as [string, number]] : []),
    ],
  })
  const jobGroup = await jobGroupField()
  const submitted = await submitJsonWithAdmission(
    apiKey,
    `${apiBase(baseUrl)}/v1/music/generations`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: wellFormedJson({
        ...jobGroup,
        model_id: modelId,
        title,
        prompt,
        instrumental: request.instrumental,
        ...(request.lyrics?.trim() ? { lyrics: request.lyrics.trim() } : {}),
        ...(request.durationSeconds ? { duration_seconds: request.durationSeconds } : {}),
        ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.priority ? { priority: request.priority } : {}),
      }),
    },
    request,
    deadline,
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [],
    { operation: 'music.generation', preview: requestPreview },
  ) as GenStudioMusicJob
  await recordGenStudioEvidence('music.generation', submitted, requestPreview)
  await reportQueueState(request, submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  try {
    return musicResult(baseUrl, apiKey, await waitForMusicJob(baseUrl, apiKey, submitted, request, deadline))
  } catch (error) {
    // A settled outcome is never reopened; only a lost connection reconnects,
    // and it reconnects to the job we already paid for.
    if (!shouldReconnectAcceptedTask(error, request)) throw error
    await request.onReconnect?.(submitted.id, error instanceof Error ? error.message : String(error))
    return recoverMusicWithGenStudioAdmitted(apiKey, submitted.id, request)
  }
}

/** One fleet model's live numbers from Gateway 0.2.165's `/v1/fleet/capacity`. */
export interface GenStudioFleetModelCapacity {
  eligible_macs: number
  idle_macs: number
  running: { normal: number; background: number }
  queued: { normal: number; background: number }
  /** Gateway 0.2.170+: at most this many of this model run across the fleet at once (YuE2). Absent = no cap. */
  fleet_cap?: number
}

/**
 * The fleet's live capacity for one model. `supported: false` = this Gateway has no capacity
 * endpoint (404: older than 0.2.165, so it has no background class either). `model: null` = the
 * model is not a fleet model (a cloud lane). Not cached: the Gateway caches it for 5 s itself.
 */
export async function readFleetCapacity(apiKey: string, modality: string, modelId: string): Promise<
  { supported: false } | { supported: true; model: GenStudioFleetModelCapacity | null }
> {
  const baseUrl = await getGenStudioUrl()
  const query = `modality=${encodeURIComponent(modality)}&model=${encodeURIComponent(modelId)}`
  try {
    const body = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/fleet/capacity?${query}`, apiKey,
      'Gateway fleet capacity could not be reached after automatic reconnect attempts.') as { models?: unknown }
    type Row = { id?: unknown; model_id?: unknown; eligible_macs?: unknown; idle_macs?: unknown; fleet_cap?: unknown
      running?: { normal?: unknown; background?: unknown }; queued?: { normal?: unknown; background?: unknown } }
    const bare = modelId.split('::').pop()
    const row = (Array.isArray(body?.models) ? body.models as Row[] : [])
      .find(m => m?.id === modelId || m?.model_id === bare)
    const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0)
    return {
      supported: true,
      model: row ? {
        eligible_macs: n(row.eligible_macs),
        idle_macs: n(row.idle_macs),
        running: { normal: n(row.running?.normal), background: n(row.running?.background) },
        queued: { normal: n(row.queued?.normal), background: n(row.queued?.background) },
        ...(n(row.fleet_cap) ? { fleet_cap: n(row.fleet_cap) } : {}),
      } : null,
    }
  } catch (error) {
    if (error instanceof GenStudioApiError && error.status === 404) return { supported: false }
    throw error
  }
}

async function readAccountJson<T>(apiKey: string, pathName: string): Promise<T> {
  const baseUrl = await getGenStudioUrl()
  return await fetchRetryingJson(
    `${apiBase(baseUrl)}${pathName}`,
    apiKey,
    'Gateway account data could not be reached after automatic reconnect attempts.',
  ) as T
}

/**
 * The account overview could not be refreshed AND no copy remains inside the
 * staleness window — the only state in which a usage surface may honestly say
 * the account is unreachable. A single slow or 502 response is NOT this: it is
 * retried, and then answered from the last known copy marked stale.
 */
export class GenStudioAccountUnavailableError extends Error {
  /** Age of the last cached copy, when there was one at all. */
  readonly ageMs: number | null

  constructor(ageMs: number | null, cause?: unknown) {
    super(
      'The Gateway account overview could not be refreshed'
      + `${ageMs == null
        ? ' and Story Studio has no cached copy'
        : ` and the cached copy is ${Math.round(ageMs / 60_000)} minute(s) old, beyond the `
          + `${Math.round(ACCOUNT_OVERVIEW_STALE_MS / 60_000)}-minute staleness limit`}. `
      + 'Balance and capacity are not shown rather than guessed. Work already running is '
      + 'unaffected. Check the Gateway app is running, then Retry.',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'GenStudioAccountUnavailableError'
    this.ageMs = ageMs
  }
}

/**
 * Lightweight authoritative account status used by the usage surfaces, with the
 * freshness of the copy being returned.
 *
 * This read is on the SAME resilient path as every catalogue: retried, shared
 * across concurrent callers, and backed by the last known copy during a short
 * interruption. It used to be the one bare `fetch` in this client, so a single
 * 8-second timeout emptied the balance and the header badge announced the whole
 * service was unavailable while jobs carried on generating normally.
 *
 * The freshness window is 0 on purpose: a balance moves as work is billed, so
 * every call revalidates and the cache exists only as the stale fallback.
 *
 * Admission control deliberately does NOT come through here — it reads the
 * overview raw (see `genStudioAdmission`), because deciding whether there is
 * capacity to spend is not a display and must never be settled from a cached
 * copy.
 */
export async function getGenStudioAccountOverviewSnapshot(
  apiKey: string,
): Promise<GenStudioAccountOverviewSnapshot> {
  const baseUrl = await getGenStudioUrl()
  const { entry, freshness, now } = await cachedRemoteSnapshot(
    catalogCacheKey('account-overview', baseUrl, apiKey),
    () => readAccountOverview(apiKey),
    0,
    ACCOUNT_OVERVIEW_STALE_MS,
    (ageMs, cause) => new GenStudioAccountUnavailableError(ageMs, cause),
  )
  return {
    value: entry.value,
    freshness,
    stale: freshness === 'stale',
    loadedAt: new Date(entry.loadedAt).toISOString(),
    ageMs: Math.max(0, now - entry.loadedAt),
  }
}

/** Lightweight authoritative account status used by the usage surfaces. */
export async function getGenStudioAccountOverview(apiKey: string): Promise<GenStudioAccountOverview> {
  return (await getGenStudioAccountOverviewSnapshot(apiKey)).value
}

async function readAccountOverview(apiKey: string): Promise<GenStudioAccountOverview> {
  const {
    app_links,
    credit_balance,
    credits_used_30d,
    subscription_plan_name,
    api_concurrency_limit,
    paid_concurrency_limit,
    paid_active_jobs,
    paid_queued_jobs,
    max_queued_jobs,
    generation_submissions_per_minute,
    burst_concurrency_ceiling,
    service_tier,
    total_jobs,
    active_jobs,
    completed_jobs,
    failed_jobs,
    available_assets,
    next_asset_expiration,
  } = await readAccountJson<GenStudioAccountOverview>(apiKey, '/v1/account/overview')
  const burstCeiling = positiveInteger(burst_concurrency_ceiling)
  const tierStanding = parseServiceTierStanding(service_tier)
  return {
    app_links: {
      billing: parseBillingAppLink(objectRecord(app_links)?.billing),
    },
    credit_balance,
    credits_used_30d,
    subscription_plan_name,
    api_concurrency_limit,
    paid_concurrency_limit,
    paid_active_jobs,
    paid_queued_jobs,
    max_queued_jobs,
    generation_submissions_per_minute,
    ...(burstCeiling ? { burst_concurrency_ceiling: burstCeiling } : {}),
    ...(tierStanding ? { service_tier: tierStanding } : {}),
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
  /** How current `overview` is, so the usage surfaces can say so. */
  overview_freshness: Omit<GenStudioAccountOverviewSnapshot, 'value'>
  jobs: { items: GenStudioCustomerJob[]; page: number; page_size: number; total: number; total_pages: number }
  credit_activity: { items: GenStudioCreditActivity[]; page: number; page_size: number; total: number; total_pages: number }
  /** Set when settlement history could not be read; the balance above still stands. */
  history_error?: string
}> {
  // Prove the key has account access before starting the two larger paginated
  // reads. An invalid or under-scoped key therefore produces one clear
  // failure instead of three concurrent rejected requests.
  const { value: overview, ...overviewFreshness } = await getGenStudioAccountOverviewSnapshot(apiKey)
  // GenStudio accepts a fixed page-size set. Keep this explicit so Story
  // Studio cannot drift back to an otherwise reasonable but invalid value.
  const accountPageSize = 20
  // The header badge polls this endpoint for one number — the balance — and the
  // account overview above has already produced it. Settlement history is a
  // separate, much larger read, and letting its failure collapse the whole
  // response is another way a perfectly readable account reports itself
  // unavailable. History that could not be read is reported AS SUCH, never as
  // an empty history, which the usage page would otherwise render as "none".
  let historyError = ''
  const readHistory = async <T>(pathName: string): Promise<T> => {
    try {
      return await readAccountJson<T>(apiKey, pathName)
    } catch (error) {
      if (!historyError) historyError = error instanceof Error ? error.message : String(error)
      return { items: [], page: 1, page_size: accountPageSize, total: 0, total_pages: 0 } as T
    }
  }
  const [jobs, creditActivity] = await Promise.all([
    readHistory<any>(`/v1/account/jobs?page=1&page_size=${accountPageSize}`),
    readHistory<any>(`/v1/account/credit-activity?page=1&page_size=${accountPageSize}`),
  ])
  return {
    overview,
    overview_freshness: overviewFreshness,
    jobs,
    credit_activity: creditActivity,
    ...(historyError ? { history_error: historyError } : {}),
  }
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
 * SECOND PROSE WIRE CHANGE (2026-09-26): the constant went from
 * `{ type: 'text' }` to `null`, i.e. prose now sends no `response_format` at
 * all because a Studio Hub lane refuses the explicit text object. The record
 * here therefore changes from `{response_format:{type:'text'}}` to
 * `{response_format:null}` — deliberately, and for the same reason as above:
 * a prose job that failed terminally under the old wire must not compute the
 * same key under the new one, or its key stays blocked forever against a
 * request shape that can never match again.
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
    // FROZEN COMPONENT — always null, exactly as every key ever computed has
    // hashed it. The image-asset field it used to describe is gone (the Gateway
    // never had one), but this key must not move: changing it would let a retry
    // that crosses an upgrade submit — and bill — a second job instead of
    // replaying the first. A picture is identified by its SHA-256 instead, below.
    input_image: null,
    // Only for a request that carries one, so every pre-existing key stays
    // byte-for-byte what it was. The DIGEST, never the base64 (FINDINGS §1).
    ...(request.inputImage ? { input_image_sha256: request.inputImage.sha256.toLowerCase() } : {}),
    output_contract: digestOutputContract(outputContract),
    ...(request.webSearch ? { web_search: request.webSearch } : {}),
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
 * `null` means the field is NOT SENT — since 2026-09-26 prose asks for nothing
 * and the provider's default is text. See `productResponseFormat` for the probe
 * evidence; the `{ type: 'text' }` it replaced is refused by a Studio Hub lane.
 *
 * SINGLE SOURCE OF TRUTH: `productResponseFormat` sends this value, and
 * `buildGenStudioChatIdempotencyKey` hashes this same constant — never a
 * second literal that happens to say the same thing today. The v1.0.788
 * defect (see the digest comment below) existed because the wire value and
 * the digest were two independent facts that silently drifted apart. Sharing
 * one constant makes that drift a compile-time impossibility: change this
 * value and both call sites move together.
 */
const PROSE_RESPONSE_FORMAT: Record<string, unknown> | null = null

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
 * PROSE SENDS NO `response_format` AT ALL (changed 2026-09-26). `{ type: 'text' }`
 * was sent explicitly because GenStudio once kept `response_format` a required
 * field on `/v1/chat/completions` with no default. gateway-kh does not: a
 * prose request that omits the field is answered normally on both routes
 * (probed live against the running gateway, 2026-09-26), while
 * `{ type: 'text' }` is REFUSED by a Studio Hub lane —
 * `response_format.type: must be json_object or json_schema; received str 'text'`
 * — which failed every chapter expansion on the local model during the STORY-2
 * acceptance run. "No format" is the honest way to ask for prose; the explicit
 * object was a compatibility shim for a rule the one endpoint no longer has.
 */
function productResponseFormat(
  productMode: GenStudioChatModel['structured_output_mode'],
  outputContract: TextOutputContract,
): { responseFormat: Record<string, unknown> | null; wrapperInstruction?: string } {
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
  //
  // TWO signals, because the first one lies on some lanes: a Studio Hub worker
  // whose own output ceiling cut a chapter short still reported
  // `finish_reason: "stop"` (measured live, 2026-09-26), so an answer that used
  // the entire ceiling the request asked for is incomplete even when the
  // provider says it stopped. That check moved HERE, not into the error's
  // constructor: the constructor only runs once something already decided the
  // output was incomplete, which is exactly the decision the usage signal has
  // to be able to make on its own.
  if (!isCompleteFinishReason(output.finish_reason) || hitOutputCeiling(output)) {
    throw new GenStudioChatIncompleteError(output)
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(
      'Gateway language product returned a successful envelope without usable output. '
      + 'Story Studio did not automatically resubmit a replacement; inspect the recorded Gateway '
      + 'job and settlement, then use Retry deliberately.',
    )
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
  requestedMaxOutputTokens: number | null,
): { text: string; jobId: string; modelId: string } {
  const choice = completion.choices?.[0]
  return parseLanguageOutput({
    id: completion.id,
    model_id: completion.model,
    output_text: typeof choice?.message?.content === 'string' ? choice.message.content : null,
    finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    completion_tokens: typeof completion.usage?.completion_tokens === 'number'
      ? completion.usage.completion_tokens : null,
    requested_max_output_tokens: requestedMaxOutputTokens,
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
  /**
   * The output ceiling this request carries, or `null` when the product
   * publishes none (owner decision #6, 2026-09-20).
   *
   * `null` is NOT zero and NOT a default: the field is OMITTED from the wire
   * body, the request preview and the replacement identity, and the provider
   * decides. Four shipped products publish `max_output_tokens: null`, and the
   * owner's ruling is that they are usable with no stated limit rather than
   * refused.
   */
  maxOutputTokens: number | null
  /**
   * The answer length this request expects, or `null` when the caller stated none.
   *
   * Omitted from the wire body when `null`, exactly like `maxOutputTokens` above: absent is the
   * honest spelling of "nobody said", and the Hub's own fallback (the p90 of the fleet's
   * measured answers) is the answer to that question, not a number invented here.
   */
  expectedOutputTokens: number | null
  /**
   * How long that expectation takes to generate on the fleet's slowest measured Mac, in seconds.
   * `0` when no expectation was stated. The socket timeout takes `max` of this and the owner's
   * dial (`effectiveChatSubmitTimeoutMs`), so a long pack is not cut by a default meant for a
   * paragraph. See services/output-token-budget.ts.
   */
  chatAllowanceSeconds: number
  outputContract: TextOutputContract
  /**
   * The `response_format` this request carries, or `null` when it carries none.
   *
   * `null` is prose, and it means the field is OMITTED from the wire body, the
   * request preview and the replacement identity — the provider's own default
   * is text, and a Studio Hub lane refuses an explicit `{ type: 'text' }`.
   * Same contract as `maxOutputTokens` above: absent, never a stand-in value.
   */
  responseFormat: Record<string, unknown> | null
  /** system (+ wrapper instruction) then user — but ONLY when the product
   *  publishes the `system_instruction` control. When it does not, the same
   *  text is folded into the single user turn instead, so the instruction is
   *  still delivered without sending a field the product never advertised.
   *  A turn's content is a plain string, or OpenAI-style parts when the request
   *  carries a picture. `messages` on the completions route, `input` on the
   *  responses route. */
  messages: GenStudioChatMessage[]
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
 * Provider KINDS whose Gateway adapter cannot carry image parts.
 *
 * The Gateway's Anthropic adapter reuses the OpenAI-compatible normaliser, so
 * it emits `{"type":"image_url"}` blocks that Anthropic refuses — nothing in
 * the Gateway converts them (`adapters/anthropic.py:267`, FINDINGS §1). This is
 * a statement about the PUBLISHED provider id, never a guess: a row that
 * publishes no provider id is not excluded, and the limitation that we then
 * cannot know its kind is reported rather than papered over (§2).
 */
export const IMAGE_UNSUPPORTED_PROVIDER_IDS: readonly string[] = ['anthropic-direct']

export type ChatImageEligibility = { eligible: true } | { eligible: false; reason: string }

/**
 * Whether a chat product can be sent a picture, and why not when it cannot.
 *
 * Only what the catalogue publishes decides this: `supports_vision` and
 * `provider_id`. Never a model id, a display name, or a provider label.
 */
export function chatImageEligibility(
  product: Pick<GenStudioChatModel, 'supports_vision' | 'provider_id' | 'display_name'>,
): ChatImageEligibility {
  const name = product.display_name || 'This model'
  if (product.supports_vision !== true) {
    return { eligible: false, reason: `${name} does not publish image input support.` }
  }
  if (product.provider_id && IMAGE_UNSUPPORTED_PROVIDER_IDS.includes(product.provider_id)) {
    return { eligible: false, reason: `${name} is served by a Gateway adapter that cannot convert image input yet.` }
  }
  return { eligible: true }
}

export function chatProductAcceptsImages(
  product: Pick<GenStudioChatModel, 'supports_vision' | 'provider_id' | 'display_name'>,
): boolean {
  return chatImageEligibility(product).eligible
}

/** A base64 data URI for one of the three image types the OpenAI-style part accepts. */
const CHAT_IMAGE_DATA_URI = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const SHA256_HEX = /^[0-9a-f]{64}$/i

/**
 * Turn one picture into the content part the Gateway forwards.
 *
 * Validated here, before any network call — a malformed picture is a caller
 * bug, and it must not read as a provider failure or a charge.
 */
function chatImageContentParts(
  image: NonNullable<GenStudioChatRequest['inputImage']>,
): GenStudioChatContentPart[] {
  if (!CHAT_IMAGE_DATA_URI.test(image.dataUri)) {
    throw new Error('The image must be a JPEG, PNG or WebP base64 data URI. No request or credit charge was made.')
  }
  if (!SHA256_HEX.test(image.sha256)) {
    throw new Error('The image’s SHA-256 is missing or malformed. No request or credit charge was made.')
  }
  return [{
    type: 'image_url',
    image_url: { url: image.dataUri, ...(image.detail ? { detail: image.detail } : {}) },
  }]
}

/**
 * What a retained request preview should show for each turn.
 *
 * A picture is a ~100 KB data URI, and the preview is persisted on the job's
 * evidence: hashing it into the preview keeps the description of the request
 * honest without storing — or re-scrubbing — a megabyte of base64. Text-only
 * turns are returned untouched, so every existing preview is unchanged.
 */
function previewMessages(messages: GenStudioChatMessage[], imageSha256?: string): GenStudioChatMessage[] {
  return messages.map(message => Array.isArray(message.content)
    ? {
        ...message,
        content: message.content.map(part => part.type === 'image_url'
          ? { type: 'text' as const, text: `[image: ${describeImageDataUri(part.image_url.url, imageSha256)}]` }
          : part),
      }
    : message)
}

/**
 * The picture, described rather than copied.
 *
 * The digest is part of the description because a replacement identity is
 * derived from these messages: two different pictures of the same byte count
 * must not describe themselves identically.
 */
function describeImageDataUri(url: string, imageSha256?: string): string {
  const comma = url.indexOf(',')
  const header = comma > 0 ? url.slice(5, comma) : 'image'
  const bytes = comma > 0 ? Math.floor((url.length - comma - 1) * 3 / 4) : 0
  return `${header}, ${bytes.toLocaleString()} bytes${imageSha256 ? `, sha256 ${imageSha256.toLowerCase()}` : ''}`
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
  if (!modelId) throw new Error('Select a Gateway chat model.')
  if (!request.userMessage.trim()) throw new Error('Gateway chat input cannot be empty.')
  // Request-only guards run FIRST, before the catalogue read: a malformed
  // picture is a caller bug and must never read as a provider failure.
  const imageParts = request.inputImage ? chatImageContentParts(request.inputImage) : null
  const product = findGenStudioProduct(await listChatModels(apiKey), modelId)
  if (!product || !product.available || product.qualification_only || product.locked === true) {
    throw new GenStudioChatProductUnavailableError(modelId, {
      // **The gateway's own words.** `availability_reason` and
      // `available_again_at` were read here for years and never published by
      // any catalogue, so this call always passed two nulls and the operator got
      // the generic sentence. What the gateway *does* state is
      // `activation_blockers`: the lock reason, and a location's own reason for a
      // package it cannot place.
      blockers: product?.activation_blockers,
    })
  }
  // Catalogue-dependent guard: the product itself has to state image input,
  // and its provider kind has to be one whose Gateway adapter can carry an
  // OpenAI-style `image_url` part. Both are LIVE catalogue facts (§1) — this is
  // the same rule the pickers use, enforced once more where the request is
  // built, so no caller can route around it.
  if (imageParts) {
    const eligibility = chatImageEligibility(product)
    if (!eligibility.eligible) {
      throw new Error(`${eligibility.reason} Choose a model the Gateway publishes image input for. No request or credit charge was made.`)
    }
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
  // A product that publishes NO output ceiling is USABLE, and the request
  // carries no ceiling at all — owner decision #6, 2026-09-20: "make them
  // usable by omitting max_output_tokens. no output limit is fine."
  //
  // This used to refuse here ("Story Studio cannot size this request without it
  // and will not invent a ceiling"). Refusing was the honest response to an
  // invented number but the wrong response to a provider that genuinely states
  // no limit: four shipped products publish `max_output_tokens: null`, and
  // their own provider is the authority on what they will return. Omitting the
  // field claims nothing about the product, so nothing is invented.
  //
  // A NUMBER is still validated: it must be a positive integer and, when the
  // product publishes a ceiling, must not exceed it. `/v1/chat/responses`
  // publishes NO maximum of its own for `max_output_tokens` (the old 32,768
  // route cap is gone), so the product's published ceiling remains the real and
  // only limit — the durable migration does not shrink any allowance shipped in
  // v1.0.765/766.
  const publishedCeiling = Number.isInteger(product.max_output_tokens) && product.max_output_tokens >= 1
    ? product.max_output_tokens
    : null
  const maxOutputTokens = request.maxOutputTokens
    ?? resolveOutputTokenBudget(request.outputBudget, product.max_output_tokens)
  if (maxOutputTokens !== null) {
    const malformed = !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1
    const overPublished = !malformed && publishedCeiling !== null && maxOutputTokens > publishedCeiling
    if (malformed || overPublished) {
      throw new Error(
        overPublished
          ? `This workflow requested ${maxOutputTokens.toLocaleString()} output tokens, but ${product.display_name} publishes a ${publishedCeiling!.toLocaleString()}-token limit. No request or credit charge was made.`
          : `The output-token budget for ${product.display_name} is not a usable number (${JSON.stringify(maxOutputTokens)}). No request or credit charge was made.`,
      )
    }
  }
  // **What this answer is expected to cost, which is a different question from what it may
  // cost.** An explicit hint wins; otherwise the workload tier's own `minimumTokens` already IS
  // the expectation, because that number is computed from the work being asked for
  // (`ideaOutputTokenBudget(count)`, `batchOutputTokenEstimate(words)`). Every other tier is a
  // fraction of the product's ceiling and says nothing about the answer's length, so it yields
  // `null` and the Hub uses the p90 of the fleet's own measured answers.
  const expectedOutputTokens = request.expectedOutputTokens
    ?? expectedOutputTokensFor(request.outputBudget)
  // The same expectation, turned into the time it takes — this side's own socket bound. The
  // prompt size is what this submission will actually carry, so a long pack is not measured
  // against a short one's input.
  const promptCharacters = request.system.length + request.userMessage.length
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
  const userText = !systemText || sendsSystemTurn
    ? request.userMessage
    : `${systemText}\n\n${request.userMessage}`
  return {
    modelId,
    product,
    maxOutputTokens,
    expectedOutputTokens,
    chatAllowanceSeconds: chatAllowanceSeconds(expectedOutputTokens, promptCharacters),
    outputContract,
    responseFormat,
    messages: [
      ...(sendsSystemTurn ? [{ role: 'system', content: systemText }] : []),
      {
        role: 'user',
        // Text first, then the picture: the instruction reads before the thing
        // it is about, and both OpenRouter and Google accept either order.
        content: imageParts ? [{ type: 'text' as const, text: userText }, ...imageParts] : userText,
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
    // The gateway's hold on a `failed` job crosses the boundary exactly as published, like every
    // other modality. Hand-listing the fields dropped these two, so a held writing job reached
    // `recordGenStudioEvidence` looking like a plain known failure: the stored row lost the
    // unknown-outcome evidence that `evidenceHoldsUnknownOutcome`, the Retry reader
    // (`holdsEarlierChatAnswer`) and the replacement checks read, and a Retry could redispatch
    // work whose outcome is unknown. Absent stays absent — never invented as `false`/`null`.
    ...(job.recovery_required !== undefined ? { recovery_required: job.recovery_required } : {}),
    ...(job.recovery_state !== undefined ? { recovery_state: job.recovery_state } : {}),
    // The Gateway's job contract, forwarded exactly as published. Hand-listing
    // the fields dropped these, and the recorder downstream already knows how
    // to store every one of them (`recordGenStudioEvidence`): a writing job
    // therefore reached the Jobs page with NO dispatch state, NO cancellable
    // answer and NO waiting reason, so the cancel control could never name a
    // target and the card could only say "checking". Absent stays absent —
    // never invented as `false`/`null`, and never derived from the modality.
    ...(job.dispatch_state !== undefined ? { dispatch_state: job.dispatch_state } : {}),
    ...(job.cancellable !== undefined ? { cancellable: job.cancellable } : {}),
    ...(job.cancelled !== undefined ? { cancelled: job.cancelled } : {}),
    ...(job.cancellation_requested !== undefined ? { cancellation_requested: job.cancellation_requested } : {}),
    ...(job.waiting !== undefined ? { waiting: job.waiting } : {}),
    model_id: job.model_id,
    ...(job.failure_code ? { failure_code: job.failure_code } : {}),
    ...(job.failure_detail ? { failure_detail: job.failure_detail } : {}),
    // The Gateway's own words for a failure, published verbatim on this route
    // (`_job_envelope`, Gateway 0.2.195). Forwarded as published — the recorder
    // downstream stores them and makes them customer-safe; Story never writes a
    // substitute sentence of its own, and an absent field stays absent.
    ...(job.failure_reason !== undefined ? { failure_reason: job.failure_reason } : {}),
    ...(job.failure_class !== undefined ? { failure_class: job.failure_class } : {}),
    ...(job.retry_after_seconds === null || isValidSettlement(job.retry_after_seconds) ? { retry_after_seconds: job.retry_after_seconds } : {}),
    ...(job.retry_at === null || (typeof job.retry_at === 'string' && job.retry_at.trim()) ? { retry_at: job.retry_at } : {}),
    ...(job.routing_status_code ? { routing_status_code: job.routing_status_code } : {}),
    ...(job.queue_position !== undefined ? { queue_position: job.queue_position } : {}),
    ...(job.queue_eta_seconds !== undefined ? { queue_eta_seconds: job.queue_eta_seconds } : {}),
    ...(job.queue_reason !== undefined ? { queue_reason: job.queue_reason } : {}),
    ...(Number.isFinite(job.credit_cost) ? { credit_cost: job.credit_cost } : {}),
    ...providerCostUsd(job),
    ...(Number.isFinite(job.remaining_credits) ? { remaining_credits: job.remaining_credits } : {}),
    ...(job.price_version ? { price_version: job.price_version } : {}),
  }
}

export class GenStudioChatRecoveryUnresolvedError extends Error {
  readonly idempotencyKey: string

  constructor(idempotencyKey: string, cause?: unknown) {
    super(
      `The Gateway could not find the earlier language submission for idempotency key ${idempotencyKey}. `
      + 'Story Studio kept its existing request identity and did not submit fresh work. Check the Gateway, then Retry.',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'GenStudioChatRecoveryUnresolvedError'
    this.idempotencyKey = idempotencyKey
  }
}

function sameChatPreview(
  saved: GenStudioRequestPreview | undefined,
  expected: GenStudioRequestPreview,
): boolean {
  if (!saved) return false
  return saved.method === expected.method
    && saved.path === expected.path
    && saved.model_id === expected.model_id
    && saved.response_format === expected.response_format
    && saved.idempotency_key === expected.idempotency_key
    && JSON.stringify(saved.token_limits) === JSON.stringify(expected.token_limits)
    && JSON.stringify(saved.messages) === JSON.stringify(expected.messages)
    && JSON.stringify(saved.fields) === JSON.stringify(expected.fields)
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
  prepared: Pick<PreparedChatSubmission, 'outputContract' | 'maxOutputTokens'>,
  requestPreview?: GenStudioRequestPreview,
  baseUrlOverride?: string,
): Promise<GenStudioChatResult> {
  const baseUrl = baseUrlOverride ?? await getGenStudioUrl()
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
  if (initial.state === 'failed' && !holdsUnknownOutcome(initial)) {
    await genStudioAdmission.notifyTerminal(apiKey)
    const incomplete = durableIncompleteChatError(initial)
    if (incomplete) throw incomplete
    throw new GenStudioChatTerminalFailureError(initial)
  }
  const completed = initial.state === 'succeeded'
    ? initial
    : await waitForChatJob(baseUrl, apiKey, initial, request, deadline)
  return finishChatJob(apiKey, request, { ...prepared, idempotencyKey }, completed)
}

/**
 * Poll one accepted language job to a terminal state.
 *
 * Mirrors `waitForImageJob` / the TTS `waitForJob` deliberately — same poll
 * interval, same `deadline`, same cancellation check, same
 * `recordGenStudioEvidence` + queue-state reporting, so the Jobs page shows a
 * language job exactly the way it already shows every other modality.
 *
 * Terminal is `succeeded | failed | cancelled`: Gateway 0.2.195 publishes the
 * same job contract on this route as on every other, including the
 * `cancelled` flag and `POST /v1/chat/responses/{id}/cancel`. A job the
 * Gateway cancelled is a settled, cancelled job — never a successful envelope
 * with no text in it. A LOCAL cancellation is different: it stops POLLING and
 * says so rather than pretending it stopped the job, which stays
 * GenStudio-owned and reconnectable by id.
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
  let reportedEvidence = ''
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || null
    const evidence = chatJobEvidence(current)
    const evidenceFingerprint = providerEvidenceFingerprint(evidence)
    if (reportedState === current.state && reportedRoutingState === routingState && reportedEvidence === evidenceFingerprint) return
    reportedState = current.state
    reportedRoutingState = routingState
    reportedEvidence = evidenceFingerprint
    await recordGenStudioEvidence('chat.response', evidence)
    await reportQueueState(request, evidence)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!poller.settled(current)) {
    if (request.isCancelled?.() || request.signal?.aborted) {
      await request.onQueueState?.('cancelled', current.id)
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) {
      // A slow job can never hang a pipeline step forever: the deadline is set
      // once at submission from GENSTUDIO_LONG_JOB_TIMEOUT_MS and every poll,
      // retry and backoff inside this loop is bounded by it.
      throw new Error('Gateway language job timed out while waiting for completion')
    }
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/chat/responses/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
      undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
    ) as GenStudioChatJob
    await reportState()
  }
  await genStudioAdmission.notifyTerminal(apiKey)
  if (current.state === 'failed' || current.cancelled === true) {
    const incomplete = durableIncompleteChatError(current)
    if (incomplete) throw incomplete
    throw new GenStudioChatTerminalFailureError(current)
  }
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
    undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
  ) as GenStudioChatJob
  // Classify BEFORE polling: a job that already failed cannot become output,
  // and a poll loop would only re-read the same terminal record.
  if (initial.state === 'failed' && !holdsUnknownOutcome(initial)) {
    await recordGenStudioEvidence('chat.response', chatJobEvidence(initial))
    await reportQueueState(request, chatJobEvidence(initial))
    await request.onState?.(initial.state, initial.id)
    await genStudioAdmission.notifyTerminal(apiKey)
    const incomplete = durableIncompleteChatError(initial)
    if (incomplete) throw incomplete
    throw new GenStudioChatTerminalFailureError(initial)
  }
  return waitForChatJob(baseUrl, apiKey, initial, request, deadline)
}

/** One confirmed failed request, one durable bounded replacement; never a whole-job replay. */
function isUncertainGenerationCode(code: string | null | undefined): boolean {
  return isSubmissionUncertainCode(code)
}

function replacementConnectionFingerprint(baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(JSON.stringify([apiBase(baseUrl), apiKey])).digest('hex')
}

/** Restore the immutable cap after restart, even when the asset checkpoint only has its key. */
async function restoreReplacementRequest<R extends GenStudioOperationContext>(
  kind: ReplacementKind, apiKey: string, key: string, itemKey: string, request: R,
): Promise<{ request: R; taskId?: string; key: string }> {
  const queue = await import('../services/job-queue.js')
  const job = queue.getJob(queue.currentJobId() || '')
  const isManualReplacementKey = job?.manual_failed_item_replacement?.requests.some(item => item.replacement_idempotency_key === key)
  const attempt = job?.generation_replacement_attempts?.find(item => item.kind === kind
    && (item.idempotency_key === key || (!isManualReplacementKey && item.item_key === itemKey && item.state !== 'failed')))
  if (!job || !attempt) return { request, key }
  key = attempt.idempotency_key
  const baseUrl = await getGenStudioUrl()
  if (attempt.connection_fingerprint !== replacementConnectionFingerprint(baseUrl, apiKey)) {
    throw new Error('The Gateway connection changed since this replacement was prepared. Restore its original connection to recover the saved request; no new work was submitted.')
  }
  const operation = kind === 'audio' ? 'voice.tts' : 'chat.response'
  // Read before POST, including a crash between physical acceptance and the
  // caller's manifest checkpoint. Recovery is allowed with automatic spending Off.
  try {
    const accepted = await getGenStudioJobByIdempotencyKey(operation, baseUrl, apiKey, key, request, Date.now() + GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS)
    if (attempt.task_id && attempt.task_id !== accepted.id) throw new Error('Replacement recovery returned a different provider task.')
    await queue.mutateAuthoritativeJob(job.project_slug, job.job_id, authoritative => {
      authoritative.generation_replacement_attempts = (authoritative.generation_replacement_attempts || []).map(item => {
        if (item.idempotency_key !== key) return item
        const settled = balancedReplacementSettlement(accepted)
        return { ...item, task_id: accepted.id, revision: item.revision + 1,
          state: accepted.state === 'succeeded' ? 'succeeded' : accepted.state === 'failed' ? 'failed' : 'submitted',
          ...(settled !== null && settled <= item.max_credits ? { settled_credits: settled } : {}) }
      })
      return authoritative
    })
    return { request: { ...request, replacementChargeLimit: attempt.max_credits }, taskId: accepted.id, key }
  } catch (error) {
    if (!(error instanceof GenStudioApiError) || error.status !== 404 || attempt.state !== 'committed') throw error
  }
  const setting = kind === 'audio' ? getPaidAudioReplacementSetting : getPaidWritingReplacementSetting
  const gate = kind === 'audio' ? withPaidAudioConfirmation : withPaidWritingConfirmation
  const support: any = await requestJsonWithRetry(`${apiBase(baseUrl)}/v1/account/overview`, { headers: authorization(apiKey) }, request,
    Date.now() + GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, apiKey, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], true, 1)
  if (!Array.isArray(support?.max_charge_credits_supported_operations) || !support.max_charge_credits_supported_operations.includes(operation)) throw new Error('Gateway spending-limit support must be available before replacement can resume.')
  return { key, request: { ...request, replacementChargeLimit: attempt.max_credits,
    withPost: post => gate(async () => {
      const policy = await setting()
      const live = await queue.loadAuthoritativeJob(job.project_slug, job.job_id)
      if (!policy.enabled || !live || live.status !== 'running' || live.pause_requested
        || request.isCancelled?.() || request.signal?.aborted || await getGenStudioUrl() !== baseUrl
        || replacementAllowance((live.generation_replacement_attempts || []).filter(item => item.idempotency_key !== key), kind, policy.additional_credit_ceiling ?? 0) < attempt.max_credits) {
        throw new Error('Automatic replacement stopped before submission: disabled, paused, cancelled, or spending limit changed.')
      }
      return post()
    }),
  } }
}

async function replaceConfirmedGeneration<T>(
  kind: ReplacementKind,
  apiKey: string,
  originalKey: string,
  itemKey: string,
  error: unknown,
  request: GenStudioOperationContext,
  submit: (key: string, cap: number, hooks: GenStudioOperationContext) => Promise<T>,
  quoteMaximum?: () => Promise<number | null>,
): Promise<T> {
  if (!(error instanceof GenStudioTerminalFailureError)
    || error.failureClass !== 'provider_transient' || error.cancelled
    // The SHARED hold-aware test, not the code alone: a gateway hold
    // (`recovery_required` / `unknown_outcome`) says the answer may still arrive whatever
    // code the job carries, so it is not permission to buy a second request. Keyed on the
    // code alone this read a held job as "proven uncharged" and replaced it (see
    // `isGenStudioSubmissionUncertain`).
    || isGenStudioSubmissionUncertain(error)
    || !originalKey || request.replacementChargeLimit !== undefined) throw error
  const queue = await import('../services/job-queue.js')
  const storyJob = queue.getJob(queue.currentJobId() || '')
  // The Jobs action already consumed this exact failed item's one deliberate
  // replacement. It must never start a second automatic replacement chain.
  if (!storyJob || storyJob.params?.jobs_replace_failed_items) throw error
  const setting = kind === 'audio' ? getPaidAudioReplacementSetting : getPaidWritingReplacementSetting
  const gate = kind === 'audio' ? withPaidAudioConfirmation : withPaidWritingConfirmation
  if (!(await setting()).enabled) throw error
  const operation = kind === 'audio' ? 'voice.tts' : 'chat.response'
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS
  const notice = async (state: string, reason: string) => {
    await queue.mutateAuthoritativeJob(storyJob.project_slug, storyJob.job_id, job => {
      job.result = { ...job.result, automatic_replacement: { kind, state, reason } }
      return job
    })
  }
  const refuse = async (reason: string): Promise<never> => {
    await notice('blocked', reason)
    throw new Error(`${error.message} Automatic ${kind} replacement: ${reason}`, { cause: error })
  }
  await notice('checking', 'Checking the previous request before replacement.')
  let original: GenStudioJob
  try {
    original = await getGenStudioJobByIdempotencyKey(operation, baseUrl, apiKey, originalKey, request, deadline)
  } catch { return refuse('The previous request could not be verified. Recover or check it again first.') }
  if (original.id !== error.jobId || original.state !== 'failed' || original.cancelled
    || original.failure_class !== 'provider_transient'
    || isUncertainGenerationCode(original.failure_code)
    // The LIVE read is the authority, and a hold on it is an unknown outcome — the answer
    // may still be adopted. `settledFailure` (services/failed-item-replacement.ts) and
    // `replayedSettledChatFailure` already read the hold; this guard read the code alone,
    // so a hold taken between the failure and this read bought a replacement anyway.
    || holdsUnknownOutcome(original)
    || balancedReplacementSettlement(original) === null) {
    return refuse('The previous request is not a confirmed eligible failure with settled credits.')
  }
  // Uncached and authenticated. An old API may ignore unknown request fields;
  // only explicit support allows the cap to be sent as spending authority.
  let support: any
  try {
    support = await requestJsonWithRetry(`${apiBase(baseUrl)}/v1/account/overview`,
      { headers: authorization(apiKey) }, request, deadline, apiKey, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], true, 1)
  } catch { return refuse('Gateway spending-limit support could not be checked.') }
  if (!Array.isArray(support?.max_charge_credits_supported_operations)
    || !support.max_charge_credits_supported_operations.includes(operation)) {
    return refuse('This Gateway does not yet support bounded automatic replacement. Manual Retry remains available.')
  }
  let quotedMaximum: number | null = null
  if (quoteMaximum) {
    try { quotedMaximum = await quoteMaximum() } catch { return refuse('The current audio price could not be verified.') }
    if (quotedMaximum === null || !Number.isSafeInteger(quotedMaximum) || quotedMaximum < 0) {
      return refuse('The Gateway did not publish a valid maximum audio quote.')
    }
  }
  let attempt: GenerationReplacementAttempt | undefined
  let blocked = 'The replacement allowance is exhausted, or this item already used its one replacement.'
  await gate(async () => {
    const policy = await setting()
    if (!policy.enabled || request.isCancelled?.() || request.signal?.aborted || await getGenStudioUrl() !== baseUrl) {
      blocked = 'Replacement was disabled, cancelled, or the Gateway connection changed.'
      return
    }
    await queue.mutateAuthoritativeJob(storyJob.project_slug, storyJob.job_id, job => {
      if (job.status !== 'running' || job.pause_requested) return null
      const attempts = job.generation_replacement_attempts || []
      const existing = attempts.find(item => item.kind === kind && (item.item_key === itemKey
        || item.idempotency_key === originalKey || item.task_id === original.id))
      if (existing) {
        if (existing.original_idempotency_key === originalKey && existing.state !== 'failed') attempt = existing
        return null
      }
      const available = replacementAllowance(attempts, kind, policy.additional_credit_ceiling ?? 0)
      const cap = quotedMaximum ?? available
      if (available <= 0 || cap > available) return null
      attempt = {
        kind, item_key: itemKey, connection_fingerprint: replacementConnectionFingerprint(baseUrl, apiKey),
        original_task_id: original.id, original_idempotency_key: originalKey,
        idempotency_key: generationReplacementKey(kind, originalKey), max_credits: cap, state: 'committed', revision: 1,
      }
      job.generation_replacement_attempts = [...attempts, attempt]
      return job
    })
  })
  if (!attempt) return refuse(blocked)
  const committed = attempt
  const checkpoint = async (update: Partial<GenerationReplacementAttempt>) => {
    await queue.mutateAuthoritativeJob(storyJob.project_slug, storyJob.job_id, job => {
      job.generation_replacement_attempts = (job.generation_replacement_attempts || []).map(item =>
        item.idempotency_key === committed.idempotency_key ? { ...item, ...update, revision: item.revision + 1 } : item)
      return job
    })
  }
  const hooks: GenStudioOperationContext = {
    replacementChargeLimit: committed.max_credits,
    withPost: post => gate(async () => {
      const policy = await setting()
      const live = await queue.loadAuthoritativeJob(storyJob.project_slug, storyJob.job_id)
      if (!policy.enabled || !live || live.status !== 'running' || live.pause_requested
        || request.isCancelled?.() || request.signal?.aborted || await getGenStudioUrl() !== baseUrl
        || replacementAllowance((live.generation_replacement_attempts || []).filter(item => item.idempotency_key !== committed.idempotency_key), kind, policy.additional_credit_ceiling ?? 0) < committed.max_credits) {
        throw new Error('Automatic replacement stopped before submission: disabled, paused, cancelled, or spending limit changed.')
      }
      return request.withPost ? request.withPost(post) : post()
    }),
  }
  await notice('queued', 'One failed item is being replaced within your additional-credit limit.')
  try {
    const result = await submit(committed.idempotency_key, committed.max_credits, hooks)
    await checkpoint({ state: 'succeeded' })
    await notice('complete', 'Replacement finished; saved results are being verified.')
    return result
  } catch (replacementError) {
    await notice('blocked', 'Replacement did not complete. Its saved request will be recovered before any further work.')
    // Do not let a caller's narrower free-capacity retry start another chain
    // after this item's explicitly bounded paid replacement already ran.
    throw new Error(`Automatic ${kind} replacement did not complete: ${replacementError instanceof Error ? replacementError.message : String(replacementError)}`, { cause: replacementError })
  } finally {
    // A lost response keeps the entire cap held. Only the authoritative ledger
    // releases unused allowance, including input, output/reasoning and search.
    try {
      const current = await getGenStudioJobByIdempotencyKey(operation, baseUrl, apiKey, committed.idempotency_key, {}, Date.now() + GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS)
      const settled = balancedReplacementSettlement(current)
      await checkpoint({ task_id: current.id, state: current.state === 'succeeded' ? 'succeeded' : current.state === 'failed' ? 'failed' : 'submitted',
        ...(settled !== null && settled <= committed.max_credits ? { settled_credits: settled } : {}) })
    } catch { /* Unknown outcome retains its durable cap and identity. */ }
  }
}

function replaceFailedChat(apiKey: string, request: GenStudioChatRequest, prepared: PreparedChatSubmission, error: unknown): Promise<GenStudioChatResult> {
  return replaceConfirmedGeneration('writing', apiKey, prepared.idempotencyKey, chatReplacementItemKey(prepared, request), error, request,
    async (key, _cap, hooks) => {
      return callChatViaResponses(apiKey, { ...request, ...hooks, recoverByIdempotencyKey: false }, { ...prepared, idempotencyKey: key })
    })
}

function chatReplacementItemKey(prepared: PreparedChatSubmission, request: GenStudioChatRequest): string {
  return createHash('sha256').update(JSON.stringify({ model: prepared.modelId, messages: previewMessages(prepared.messages, request.inputImage?.sha256),
    format: prepared.responseFormat, sampling: prepared.samplingFields, max: prepared.maxOutputTokens, web_search: request.webSearch })).digest('hex')
}

/** Validate a settled language job and shape the caller's result. */
async function finishChatJob(
  apiKey: string,
  request: GenStudioChatRequest,
  prepared: Pick<PreparedChatSubmission, 'outputContract' | 'maxOutputTokens' | 'idempotencyKey'>,
  completed: GenStudioChatJob,
): Promise<GenStudioChatResult> {
  let parsed: ReturnType<typeof parseLanguageOutput>
  try {
    parsed = parseLanguageOutput({
      ...completed,
      // The ceiling THIS request carried, so an answer that used all of it is
      // read as truncated even when the provider said "stop".
      completion_tokens: typeof completed.usage?.completion_tokens === 'number'
        ? completed.usage.completion_tokens : null,
      requested_max_output_tokens: prepared.maxOutputTokens,
    }, prepared.outputContract)
  } catch (error) {
    // The job is settled either way, so the account slot is free: release it
    // before rejecting the payload, or a run of unusable outputs (truncation,
    // a contract violation) silently starves the admission pool.
    await request.onQueueState?.('failed', completed.id)
    await genStudioAdmission.notifyTerminal(apiKey)
    // A content-derived key that produced an answer this app cannot read must never be used
    // again: it is what makes the next attempt replay the same unusable text. See
    // `chatKeyAfterRejectedAnswer`. A caller-supplied key (exact replay, paid replacement,
    // saved-key recovery) names one specific request and is left exactly as it was.
    if (!request.idempotencyKey?.trim()) {
      const queue = await import('../services/job-queue.js')
      queue.recordRejectedChatAnswerKey(prepared.idempotencyKey)
      queue.noteCurrentJob('The writing model\'s answer could not be read; asking again with a fresh request.')
    }
    throw rejectedAnswerError(error, completed.id, prepared.idempotencyKey)
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
  baseUrlOverride?: string,
): Promise<GenStudioChatResult> {
  try {
    return await callChatViaResponsesOnce(apiKey, request, prepared, baseUrlOverride)
  } catch (error) {
    const lost = lostChatRequest(error, request, prepared.idempotencyKey)
    return lost ? resendLostChat(apiKey, request, prepared, lost, baseUrlOverride) : replaceFailedChat(apiKey, request, prepared, error)
  }
}

/**
 * Owner decision 2026-10-12: a writing request the Gateway lost track of after it was sent (a held
 * unknown outcome, or an uncertain-submission code) is resent ONCE with a fresh identity. The owner
 * accepts the small double-charge risk on a paid writing model. A capped paid replacement is never
 * resent, and images, voice, video and transcription keep their lock (this is chat-only).
 */
function lostChatRequest(error: unknown, request: GenStudioChatRequest, key: string): GenStudioChatTerminalFailureError | null {
  return error instanceof GenStudioChatTerminalFailureError && !error.cancelled && !key.startsWith(LOST_CHAT_RESEND_PREFIX)
    && isGenStudioSubmissionUncertain(error) && request.replacementChargeLimit === undefined ? error : null
}

/**
 * The resend's key is derived from the lost job, so a restart or Retry replays this same resend
 * rather than buying a third, and its prefix marks it as already resent: a resend that is lost too
 * fails with the ordinary "lost track" message, whichever saved key a caller recovers from.
 */
const LOST_CHAT_RESEND_PREFIX = 'story-chat-resend-'
export function lostChatResendKey(key: string, lostJobId: string): string {
  return `${LOST_CHAT_RESEND_PREFIX}${createHash('sha256').update(`${key}:lost:${lostJobId}`).digest('hex').slice(0, 40)}`
}

async function resendLostChat(
  apiKey: string,
  request: GenStudioChatRequest,
  prepared: PreparedChatSubmission,
  lost: GenStudioChatTerminalFailureError,
  baseUrlOverride?: string,
): Promise<GenStudioChatResult> {
  // 1.4.300 — "Lost writing request": Off (the default) and Warn resend once as before; Block stops.
  if (await currentJobSafety('lost_writing_request',
    'The writing service lost track of a writing request after it was sent; Story sends it once more as a fresh request.', 'off') === 'block') throw lost
  const queue = await import('../services/job-queue.js')
  queue.noteCurrentJob('↻ The writing service lost track of the last writing request after it was sent, '
    + 'so Story Studio sent it once more as a fresh request (it will not resend it again by itself).')
  const resend = { ...request, recoverByIdempotencyKey: false }
  const resent = { ...prepared, idempotencyKey: lostChatResendKey(prepared.idempotencyKey, lost.jobId) }
  try {
    return await callChatViaResponsesOnce(apiKey, resend, resent, baseUrlOverride)
  } catch (error) {
    return replaceFailedChat(apiKey, resend, resent, error)
  }
}

/**
 * A safety check that failed deep in the client, for the queue job running this request. Returns its
 * mode; Off and Warn are written on that job's log (the queue's live job is not reachable from here, so
 * Warn shows as a ⚠ line rather than in the job's warning list). No running job → `outsideJob`.
 */
async function currentJobSafety(id: string, message: string, outsideJob: SafetyMode): Promise<SafetyMode> {
  const queue = await import('../services/job-queue.js')
  const job = queue.getJob(queue.currentJobId() || '')
  if (!job) return outsideJob
  const mode = await safetyMode(job.project_slug, id)
  if (mode === 'block') return mode
  const log = { output_lines: [] as string[] }
  await safetyGate(job.project_slug, id, log, message)
  for (const line of log.output_lines) queue.noteCurrentJob(line)
  if (mode === 'warn') queue.noteCurrentJobSafetyWarning(id, message)
  return mode
}

/** Bounds the walk from an old failed key to the newest attempt; ponytail: 5 Retries' worth. */
const MAX_FAILED_CHAT_REPLAY_HOPS = 5

/**
 * The POST answered with an EARLIER job for this key (`idempotent_replay`, or
 * the gateway's 200 where a new job gets 202) that already failed, settled, with
 * no gateway hold, no uncertain-submission code, and a fully released ZERO
 * settlement — so that attempt cost nothing and can never produce output or
 * charge again. A failure that charged keeps "one paid submission per click".
 */
export function replayedSettledChatFailure(job: {
  state?: unknown
  failure_code?: unknown
  cancelled?: unknown
  recovery_required?: unknown
  recovery_state?: unknown
  idempotent_replay?: unknown
  http_status?: unknown
  reserved_credits?: unknown
  settled_credits?: unknown
  released_credits?: unknown
}): boolean {
  const credits = [job.reserved_credits, job.settled_credits, job.released_credits]
  return (job.idempotent_replay === true || job.http_status === 200)
    && job.state === 'failed' && job.cancelled !== true
    && !holdsUnknownOutcome(job) && !isSubmissionUncertainCode(job.failure_code)
    && credits.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    && job.settled_credits === 0 && job.released_credits === job.reserved_credits
}

/**
 * The POST answered with an EARLIER job for this key that the Gateway has settled as CANCELLED.
 *
 * **A cancellation is terminal, so a cancelled job can never answer again.** The key is derived
 * from the request content, so a Retry re-POSTs the very same key, the Gateway replays the very
 * same cancelled job, and the step fails with "this writing request was cancelled" forever — the
 * Retry never sends anything. The Gateway's own words for it are the reason to move on: the work
 * was stopped on purpose, so a deliberate retry is a NEW request, not a replay of the stopped one.
 *
 * The settlement proof is the one the failed replay uses: a cancelled job that already charged
 * keeps "one paid submission per click", because a second request could be charged again.
 */
export function replayedCancelledChatFailure(job: {
  state?: unknown
  failure_code?: unknown
  cancelled?: unknown
  recovery_required?: unknown
  recovery_state?: unknown
  idempotent_replay?: unknown
  http_status?: unknown
  reserved_credits?: unknown
  settled_credits?: unknown
  released_credits?: unknown
}): boolean {
  const credits = [job.reserved_credits, job.settled_credits, job.released_credits]
  return (job.idempotent_replay === true || job.http_status === 200)
    && job.state === 'failed' && job.cancelled === true
    && !holdsUnknownOutcome(job) && !isSubmissionUncertainCode(job.failure_code)
    && credits.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    && job.settled_credits === 0 && job.released_credits === job.reserved_credits
}

/**
 * Owner decision 2026-10-03: a FREE writing model's failure that the gateway still holds as an
 * unknown outcome (or whose submission was uncertain) is redone with a fresh request. Free means the
 * gateway published `chargeable: false` for the model (a pool is chargeable if any member is), so a
 * second request can never be charged. Paid or unpublished chargeability keeps the lock.
 */
export function replayedHeldFreeChatFailure(job: {
  state?: unknown
  failure_code?: unknown
  cancelled?: unknown
  recovery_required?: unknown
  recovery_state?: unknown
  idempotent_replay?: unknown
  http_status?: unknown
}, chargeable: boolean | undefined): boolean {
  return chargeable === false
    && (job.idempotent_replay === true || job.http_status === 200)
    && job.state === 'failed' && job.cancelled !== true
    && (holdsUnknownOutcome(job) || isSubmissionUncertainCode(job.failure_code))
}

export function chatKeyAfterFailedReplay(key: string, failedJobId: string): string {
  return `story-chat-${createHash('sha256').update(`${key}:after-failed:${failedJobId}`).digest('hex').slice(0, 47)}`
}

/**
 * The next attempt's key after the Gateway answered this key and THIS APP rejected the answer.
 *
 * A settled, succeeded provider answer that fails `parseLanguageOutput` (unreadable JSON, or a
 * contract violation) is the one outcome the existing key derivation cannot escape: the key is
 * derived from request content, so a retry rebuilds the same key, the Gateway replays the same
 * text, and the step is rejected identically forever. DM0008 and Nature EP0013's image_prompts job
 * both ended there. The key that produced the rejected answer is recorded on the job, and this
 * derives the one to use instead — from that key alone, so a restart or a Retry recomputes the
 * same successor rather than walking into the rejected answer again.
 *
 * Deliberately NOT applied to a transport failure or an unknown outcome: those have no answer to
 * judge, and replaying the same key there is what stops a duplicate paid call.
 */
export function chatKeyAfterRejectedAnswer(key: string): string {
  return `story-chat-${createHash('sha256').update(`${key}:rejected-answer`).digest('hex').slice(0, 47)}`
}

/** The key to actually submit: the recorded one unless this app already rejected its answer. */
export function chatKeySkippingRejectedAnswers(key: string, rejected: readonly string[] | undefined): string {
  let next = key
  // Bounded by the recorded list: each step names a key that is already on it, and the successor of
  // a key never equals a key on the list (it is a fresh digest of it).
  while (rejected?.includes(next)) next = chatKeyAfterRejectedAnswer(next)
  return next
}

async function callChatViaResponsesOnce(
  apiKey: string,
  request: GenStudioChatRequest,
  prepared: PreparedChatSubmission,
  baseUrlOverride?: string,
  replayHops = 0,
): Promise<GenStudioChatResult> {
  const restored = await restoreReplacementRequest('writing', apiKey, prepared.idempotencyKey, chatReplacementItemKey(prepared, request), request)
  request = restored.request
  prepared = { ...prepared, idempotencyKey: restored.key }
  if (restored.taskId) {
    await request.onJobAccepted?.(restored.taskId, prepared.idempotencyKey)
    return finishChatJob(apiKey, request, prepared, await recoverChatJobAdmitted(apiKey, restored.taskId, request))
  }
  const baseUrl = baseUrlOverride ?? await getGenStudioUrl()
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
    // Omitted entirely when the product publishes no ceiling, so the retained
    // preview describes the request that was actually sent (owner decision #6).
    ...(prepared.maxOutputTokens === null ? {} : { tokenLimits: { max_output_tokens: prepared.maxOutputTokens } }),
    ...(prepared.expectedOutputTokens === null
      ? {}
      : { expectedOutputTokens: prepared.expectedOutputTokens }),
    idempotencyKey: prepared.idempotencyKey,
    messages: previewMessages(prepared.messages, request.inputImage?.sha256),
    fields: chatPreviewFields(request, prepared),
  })
  if (request.recoverByIdempotencyKey) {
    if (request.allowedRecoveryKeys?.length && !request.allowedRecoveryKeys.includes(prepared.idempotencyKey)) {
      throw new GenStudioChatRecoveryUnresolvedError(prepared.idempotencyKey)
    }
    return recoverChatByIdempotencyKey(apiKey, prepared.idempotencyKey, request, prepared, requestPreview, baseUrl)
  }
  await request.onRequestPrepared?.(prepared.idempotencyKey, requestPreview)
  let submitted: GenStudioChatJob
  const jobGroup = await jobGroupField()
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
        body: wellFormedJson({
          ...jobGroup,
          // `ChatResponseRequest` field names — NOT the OpenAI-compatible ones.
          model_id: prepared.modelId,
          input: prepared.messages,
          // Omitted for prose: "no format asked for" is the request, and an
          // explicit `{ type: 'text' }` is refused by a Studio Hub lane.
          ...(prepared.responseFormat === null ? {} : { response_format: prepared.responseFormat }),
          // Only the sampling fields this product publishes. Never `top_p`.
          ...prepared.samplingFields,
          // Omitted when the product publishes no ceiling — no number is
          // attributed to it and the provider decides (owner decision #6).
          ...(prepared.maxOutputTokens === null ? {} : { max_output_tokens: prepared.maxOutputTokens }),
          // The expectation, beside the ceiling and never instead of it. Absent when nobody
          // stated one, so the Gateway's Hub lane falls back to the fleet's own measured answer
          // size.
          ...(prepared.expectedOutputTokens === null
            ? {}
            : { expected_output_tokens: prepared.expectedOutputTokens }),
          ...(request.replacementChargeLimit !== undefined ? { max_charge_credits: request.replacementChargeLimit } : {}),
          // Present only for a deliberate web-search request. `web_search` is
          // available on this route too, so web research is durable as well.
          ...(request.webSearch ? { web_search: request.webSearch } : {}),
        }),
      },
      request,
      deadline,
      { operation: 'chat.response', preview: requestPreview },
      prepared.chatAllowanceSeconds,
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
    return recoverChatByIdempotencyKey(apiKey, prepared.idempotencyKey, request, prepared, requestPreview, baseUrl)
  }
  await recordGenStudioEvidence('chat.response', chatJobEvidence(submitted), requestPreview)
  // Only a key Story derived from content: a caller-supplied key (exact replay,
  // paid replacement) names one specific request and must never be moved —
  // except a free model's held failure, which the owner redoes fresh (see
  // replayedHeldFreeChatFailure); its new key reaches the caller through onJobAccepted.
  const freeHeldRedo = request.replacementChargeLimit === undefined
    && replayedHeldFreeChatFailure(submitted, prepared.product.chargeable)
  const settledRedo = !request.idempotencyKey?.trim() && request.replacementChargeLimit === undefined
    && replayedSettledChatFailure(submitted)
  // **A cancelled job is terminal too, and it answers with the same cancellation forever.** The
  // work was stopped on purpose, so a Retry of an ordinary submission is a NEW request: it moves
  // to a successor key the same way a settled failure does, instead of replaying the stopped job
  // on every click. A caller-supplied key (exact replay, a paid replacement) is never moved, and a
  // recovery-only reattach never reaches this block — it returns before the POST.
  const cancelledRedo = !request.idempotencyKey?.trim() && request.replacementChargeLimit === undefined
    && replayedCancelledChatFailure(submitted)
  if ((freeHeldRedo || settledRedo || cancelledRedo) && replayHops < MAX_FAILED_CHAT_REPLAY_HOPS) {
    // The key is derived from the request content, so a Retry of the same step
    // re-POSTs the same key and the gateway answers with the OLD failed job.
    // Without this, one failure (the gateway
    // 0.2.97/0.2.98 pool bug, a provider 400) made that step fail in a second
    // on every Retry forever. The old job is settled, held by nobody and cost
    // nothing, so nothing is in flight under this key; the fresh key is derived from the failed job's
    // id, so a restart of this run reattaches instead of buying a third.
    return callChatViaResponsesOnce(apiKey, request, {
      ...prepared, idempotencyKey: chatKeyAfterFailedReplay(prepared.idempotencyKey, submitted.id),
    }, baseUrlOverride, replayHops + 1)
  }
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
    ...(prepared.maxOutputTokens === null ? {} : { tokenLimits: { max_completion_tokens: prepared.maxOutputTokens } }),
    ...(prepared.expectedOutputTokens === null
      ? {}
      : { expectedOutputTokens: prepared.expectedOutputTokens }),
    idempotencyKey: prepared.idempotencyKey,
    messages: previewMessages(prepared.messages, request.inputImage?.sha256),
    fields: [['stream', false], ...chatPreviewFields(request, prepared)],
  })
  const jobGroup = await jobGroupField()
  await request.onRequestPrepared?.(prepared.idempotencyKey, requestPreview)
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
      body: wellFormedJson({
        ...jobGroup,
        model: prepared.modelId,
        messages: prepared.messages,
        // Omitted for prose — see the preview comment above the submission.
        ...(prepared.responseFormat === null ? {} : { response_format: prepared.responseFormat }),
        stream: false,
        // Only the sampling fields this product publishes. Never `top_p`.
        ...prepared.samplingFields,
        // Omitted when the product publishes no ceiling (owner decision #6).
        ...(prepared.maxOutputTokens === null ? {} : { max_completion_tokens: prepared.maxOutputTokens }),
        // The expectation, beside the ceiling and never instead of it (same rule as the
        // durable route above).
        ...(prepared.expectedOutputTokens === null
          ? {}
          : { expected_output_tokens: prepared.expectedOutputTokens }),
        ...(request.webSearch ? { web_search: request.webSearch } : {}),
      }),
    },
    request,
    deadline,
    { operation: 'chat.response', preview: requestPreview },
    prepared.chatAllowanceSeconds,
  ) as GenStudioChatCompletion
  // The exchange is over the moment the response lands: whatever the envelope
  // turns out to say, this account's in-flight slot is free. Release it before
  // inspecting the payload, or a run of rejected envelopes (truncated output,
  // an unusable body, a contract violation) silently starves the admission
  // pool until it times out.
  let parsed: ReturnType<typeof parseProductCompletion>
  try {
    parsed = parseProductCompletion(completion, prepared.outputContract, prepared.maxOutputTokens)
  } catch (error) {
    await request.onState?.('failed', completion.id)
    await request.onQueueState?.('failed', completion.id)
    await genStudioAdmission.notifyTerminal(apiKey)
    // Same local rejection, same loop to break as `finishChatJob`. The completions route is the
    // rollback route, but a rejected answer blocks it identically.
    if (!request.idempotencyKey?.trim()) {
      const queue = await import('../services/job-queue.js')
      queue.recordRejectedChatAnswerKey(prepared.idempotencyKey)
      queue.noteCurrentJob('The writing model\'s answer could not be read; asking again with a fresh request.')
    }
    throw rejectedAnswerError(error, completion.id, prepared.idempotencyKey)
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
 * Resolve the only provider key a server-created manual failed-item job may
 * use. Recorded successes keep their old key so GenStudio replays them for
 * free; a recorded failure receives its one persisted replacement key. A
 * changed prompt/grouping cannot silently widen the paid scope.
 */
export function manualFailedItemChatRequestKey(job: Job | null | undefined, originalKey: string): string {
  const scope = job?.manual_failed_item_replacement
  if (!scope) return originalKey

  const automatic = job.generation_replacement_attempts?.find(attempt => (
    attempt.kind === 'writing' && attempt.original_idempotency_key === originalKey
  ))
  if (automatic) {
    if (automatic.state === 'failed') {
      const deliberateFollowUp = scope.requests.find(item => (
        item.original_idempotency_key === automatic.idempotency_key
        && (item.prepared_idempotency_key || automatic.original_idempotency_key) === originalKey
      ))
      if (deliberateFollowUp) return deliberateFollowUp.replacement_idempotency_key
      throw new Error('This writing request already used its one replacement. No provider work was submitted.')
    }
    // The automatic recovery helper restores its committed/submitted request
    // after this function, including across an application restart.
    return originalKey
  }

  const replacement = scope.requests.find(item => (
    (item.prepared_idempotency_key || item.original_idempotency_key) === originalKey
  ))
  if (replacement) return replacement.replacement_idempotency_key

  const exactSuccess = job.genstudio_jobs?.some(item => item.operation === 'chat.response'
    && item.state === 'succeeded'
    && (item.request_key === originalKey || item.request?.idempotency_key === originalKey))
  if (exactSuccess) return originalKey

  throw new Error('The saved failed-item scope no longer matches this writing request. No provider work was submitted.')
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
  const queue = await import('../services/job-queue.js')
  const storyJob = queue.getJob(queue.currentJobId() || '')
  // A saved key whose answer this app already rejected cannot be reclaimed usefully: the recovery
  // would return the very text that was refused, on this attempt and every one after it. The
  // saved identity is dropped so the run asks for a new generation instead.
  const savedKey = request.idempotencyKey?.trim() || ''
  const recoveringRejectedAnswer = !!savedKey && !!storyJob?.rejected_idempotency_keys?.includes(savedKey)
  if (recoveringRejectedAnswer) {
    request = { ...request, recoverByIdempotencyKey: false, allowUncreatedRecovery: false, allowedRecoveryKeys: undefined }
  }
  // A saved key means a prior process reached the durable pre-POST checkpoint.
  // Recovery is a read-only lookup, so it must not recompute the old request's
  // budget against today's catalogue before that lookup. A lower live ceiling
  // would otherwise reject the recovery and strand the already-paid request.
  if (request.recoverByIdempotencyKey && request.idempotencyKey?.trim()) {
    const idempotencyKey = request.idempotencyKey.trim()
    if (request.allowedRecoveryKeys?.length && !request.allowedRecoveryKeys.includes(idempotencyKey)) {
      throw new GenStudioChatRecoveryUnresolvedError(idempotencyKey)
    }
    try {
      return await recoverChatByIdempotencyKey(apiKey, idempotencyKey, request, {
        outputContract: request.outputContract
          ?? (request.jsonObject === true ? JSON_OBJECT_OUTPUT_CONTRACT : PROSE_OUTPUT_CONTRACT),
        // The recovered job's own ceiling is unknown here by design (the saved key
        // outranks today's catalogue), so the usage check has nothing to compare
        // against and stays off for a recovery — `null`, not a guess.
        maxOutputTokens: null,
      })
    } catch (error) {
      // A saved request the Gateway lost track of gets its one fresh resend here, so a saved
      // identity can no longer block its step forever (Scene Plan HMH0003, 0/185 prompts).
      const lost = lostChatRequest(error, request, idempotencyKey)
      if (!lost || request.deferLostResend) throw error
      const fresh = { ...request, recoverByIdempotencyKey: false }
      const prepared = await prepareChatSubmission(apiKey, fresh).catch(() => { throw error })
      if (prepared.transport !== 'responses') throw error
      return resendLostChat(apiKey, fresh, { ...prepared, idempotencyKey }, lost)
    }
  }
  // Bind the entire verified retry to one server. The catalogue shapes the
  // exact old request too, so refuse a settings switch while it is read.
  const uncreatedRecoveryBaseUrl = request.allowUncreatedRecovery
    ? await getGenStudioUrl()
    : undefined
  let prepared = await prepareChatSubmission(apiKey, request)
  prepared = {
    ...prepared,
    idempotencyKey: manualFailedItemChatRequestKey(storyJob, prepared.idempotencyKey),
  }
  // A key whose settled answer this app already rejected must not be submitted again — the Gateway
  // would replay that same unusable text and the step would fail identically. Only a
  // content-derived key is moved: a caller-supplied key (exact replay, the one deliberate paid
  // replacement) names one specific request, and `manualFailedItemChatRequestKey` owns its scope.
  // A saved key whose answer was rejected has already dropped its recovery identity above, so it
  // is moved here too. See `chatKeyAfterRejectedAnswer`.
  if ((!request.idempotencyKey?.trim() || recoveringRejectedAnswer) && !storyJob?.manual_failed_item_replacement) {
    prepared = {
      ...prepared,
      idempotencyKey: chatKeySkippingRejectedAnswers(prepared.idempotencyKey, storyJob?.rejected_idempotency_keys),
    }
  }
  if (request.allowUncreatedRecovery) {
    const preview = request.recoveryRequestPreview
    const expected = buildGenStudioRequestPreview({
      method: 'POST',
      path: '/v1/chat/responses',
      modelId: prepared.modelId,
      responseFormat: prepared.responseFormat,
      // Omitted entirely when the product publishes no ceiling, so the retained
    // preview describes the request that was actually sent (owner decision #6).
    ...(prepared.maxOutputTokens === null ? {} : { tokenLimits: { max_output_tokens: prepared.maxOutputTokens } }),
    ...(prepared.expectedOutputTokens === null
      ? {}
      : { expectedOutputTokens: prepared.expectedOutputTokens }),
      idempotencyKey: prepared.idempotencyKey,
      messages: previewMessages(prepared.messages, request.inputImage?.sha256),
      fields: chatPreviewFields(request, prepared),
    })
    const matches = prepared.transport === 'responses'
      && preview?.idempotency_key === prepared.idempotencyKey
      && (!request.allowedRecoveryKeys?.length || request.allowedRecoveryKeys.includes(prepared.idempotencyKey))
      && sameChatPreview(preview, expected)
    if (!matches) throw new GenStudioChatRecoveryUnresolvedError(prepared.idempotencyKey)
    // The absence proof and its replacement POST must target one endpoint.
    // Settings are mutable, so a later URL read could otherwise turn a 404
    // from the original connection into a paid submission elsewhere.
    if (await getGenStudioUrl() !== uncreatedRecoveryBaseUrl) {
      throw new GenStudioChatRecoveryUnresolvedError(prepared.idempotencyKey)
    }
    try {
      return await recoverChatByIdempotencyKey(
        apiKey, prepared.idempotencyKey, request, prepared, undefined, uncreatedRecoveryBaseUrl,
      )
    } catch (error) {
      const lost = lostChatRequest(error, request, prepared.idempotencyKey)
      if (lost) return resendLostChat(apiKey, request, prepared, lost, uncreatedRecoveryBaseUrl)
      // Only a 404 is the absence proof; see `isProvenUncreatedChatRequest`.
      if (!isProvenUncreatedChatRequest(error)) throw error
    }
  }
  return prepared.transport === 'completions'
    ? callChatViaCompletions(apiKey, request, prepared)
    : callChatViaResponses(apiKey, request, prepared, uncreatedRecoveryBaseUrl)
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
  const type = videoSourceMediaType(sourceImagePath, bytes)
  if (!type.startsWith('image/')) throw new Error('Thumbnail reference must be a PNG, JPEG, WebP, or GIF image.')
  const body = new FormData()
  body.set('upload', new Blob([new Uint8Array(bytes)], { type }), path.basename(sourceImagePath))
  const baseUrl = await getGenStudioUrl()
  const response = await fetch(`${apiBase(baseUrl)}/v1/images/source-images`, {
    method: 'POST', headers: authorization(apiKey), body, signal: AbortSignal.timeout(GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS),
  })
  const value = await readJson(response)
  if (!value || typeof value.id !== 'string') throw new Error('The Gateway did not return a private reference asset id.')
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
  options: { displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioTranscriptionModel[]>> {
  const baseUrl = await getGenStudioUrl()
  const key = catalogCacheKey('transcription', baseUrl, apiKey)
  return cachedCatalogSnapshot('transcription', key, async () => {
    const payload = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/transcription/models`, apiKey)
    const rows = readCatalogRows(payload)
    if (!rows) {
      throw new Error('The Gateway returned an invalid transcription model catalog')
    }
    return rows.map((value: any) => ({
      id: typeof value?.id === 'string' ? value.id.trim() : '',
      display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
      // Provider transparency means pass through what GenStudio publishes.
      // An absent provider is unknown, never the gateway name.
      provider: typeof value?.provider === 'string' ? value.provider.trim() : '',
      // The shared contract's field, published alongside `provider` on these
      // rows. Declared and read since 2026-09-18 — before that it arrived and
      // was dropped here, which rendered every transcription row providerless.
      provider_name: publishedText(value?.provider_name),
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
      ...parseGenStudioCatalogLock(value),
      ...parseGenStudioPriceTruth(value),
      ...parseGenStudioChargeable(value),
      // GenStudio publishes a per-SECOND rate. Reading `credits_per_minute`
      // here (a field it does not publish) made every model parse as 0.
      credits_per_second: Number.isFinite(value?.credits_per_second)
        ? Math.max(0, value.credits_per_second)
        : 0,
      minimum_credits: Number.isFinite(value?.minimum_credits)
        ? Math.max(0, value.minimum_credits)
        : 0,
      price_version: typeof value?.price_version === 'string' ? value.price_version.trim() : '',
      ...(parseGenStudioCostTier(value?.cost_tier) ? { cost_tier: parseGenStudioCostTier(value?.cost_tier) } : {}),
    })).filter((model: GenStudioTranscriptionModel) => model.id && model.display_name)
  }, { ...options, baseUrl, apiKey })
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

/** Parse one direct image-catalogue response for both ordinary and force-live reads. */
async function loadImageModelsFromGenStudio(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<GenStudioImageModel[]> {
    const payload = await fetchRetryingJson(`${apiBase(baseUrl)}/v1/image/models`, apiKey, undefined, signal)
    const rows = readCatalogRows(payload)
    if (!rows) throw new Error('The Gateway returned an invalid image model catalog')
    return rows.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    ...parseGenStudioProductAliases(value),
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    provider_name: publishedText(value?.provider_name),
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    available: value?.available === true,
    qualification_only: value?.qualification_only !== false,
    ...parseGenStudioCatalogLock(value),
    ...parseGenStudioPriceTruth(value),
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
    ...parseGenStudioChargeable(value),
    ...(parseGenStudioCostTier(value?.cost_tier) ? { cost_tier: parseGenStudioCostTier(value?.cost_tier) } : {}),
    aspect_ratios: Array.isArray(value?.aspect_ratios)
      ? value.aspect_ratios.filter((ratio: unknown): ratio is string => typeof ratio === 'string' && !!ratio.trim())
      : [],
    default_aspect_ratio: typeof value?.default_aspect_ratio === 'string'
      ? value.default_aspect_ratio.trim()
      : '',
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
    // The Gateway enforces this minimum only on a request that sends references (its edit lane);
    // a model that also publishes `text-to-image` renders from a prompt alone, so a render with
    // none must not be refused here (2026-10-28: every Qwen thumbnail refused, 0 of 3).
    min_reference_images: Number.isInteger(value?.min_reference_images) && value.min_reference_images >= 0
      ? (Array.isArray(value?.operations) && value.operations.includes('text-to-image') ? 0 : value.min_reference_images)
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
    ...(publishedFlag(value?.requires_admission_permit) === undefined
      ? {}
      : { requires_admission_permit: publishedFlag(value?.requires_admission_permit) }),
    })).filter((model: GenStudioImageModel) => model.id && model.display_name)
}

/** Fetch the account-visible image catalog owned by GenStudio. */
export async function listImageModelsSnapshot(
  apiKey: string,
  options: { displayFallback?: boolean } = {},
): Promise<GenStudioCatalogSnapshot<GenStudioImageModel[]>> {
  const baseUrl = await getGenStudioUrl()
  const key = catalogCacheKey('image', baseUrl, apiKey)
  return cachedCatalogSnapshot('image', key, signal => loadImageModelsFromGenStudio(baseUrl, apiKey, signal), { ...options, baseUrl, apiKey })
}

/**
 * Force a fresh image catalogue response for a paid decision. This never joins
 * an older ordinary refresh and never accepts a stale fallback.
 */
export async function listImageModelsForceLive(
  apiKey: string,
): Promise<GenStudioCatalogSnapshot<GenStudioImageModel[]>> {
  const baseUrl = await getGenStudioUrl()
  const key = catalogCacheKey('image', baseUrl, apiKey)
  return forceLiveCatalogSnapshot('image', key, signal => loadImageModelsFromGenStudio(baseUrl, apiKey, signal), { baseUrl, apiKey })
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
  outputFormat?: 'jpeg'
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
    // Emitted only when set, like `resolution`: a key built without it stays byte-identical,
    // while asking for a different format is different work that must not replay the old job.
    ...(input.outputFormat ? { output_format: input.outputFormat } : {}),
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
  let reportedState = ''
  let reportedRoutingState = ''
  let reportedEvidence = ''
  // Same change guard as the other five wait loops. Every evidence record rewrites the project's whole
  // jobs.json on the main thread; recording each unchanged poll of every in-flight scene image kept a
  // large channel's server busy writing (story-perf findings, 2026-10-06).
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || ''
    const evidenceFingerprint = providerEvidenceFingerprint(current as GenStudioJob)
    if (reportedState === current.state && reportedRoutingState === routingState && reportedEvidence === evidenceFingerprint) return
    reportedState = current.state
    reportedRoutingState = routingState
    reportedEvidence = evidenceFingerprint
    await recordGenStudioEvidence('image.generation', current)
    await reportQueueState(request, current)
    request.onState?.(current.state)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!poller.settled(current)) {
    await submitQueuedRemoteCancellation('image.generation', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) {
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) throw new Error('The image was not ready at the Gateway in time')
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/images/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
      undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
    ) as GenStudioImageJob
    await reportState()
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
        const error = new Error(`Could not download the image from the Gateway (HTTP ${response.status})`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        const bytes = Buffer.from(await response.arrayBuffer())
        const mediaType = bytes.length < 24 ? null : sniffImageMediaType(bytes)
        if (!mediaType) throw new Error('The Gateway returned an invalid image artifact (not PNG, JPEG or WebP)')
        return `data:${mediaType};base64,${bytes.toString('base64')}`
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
  throw lastError instanceof Error ? lastError : new Error('Could not download the image from the Gateway')
}

/** The gateway relays each provider's own format, so accept what the bytes say they are. */
export function sniffImageMediaType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

/** Reconnect to an already accepted image task. Never submits new work. */
async function recoverImageWithGenStudioAdmitted(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & { onState?: (state: GenStudioJob['state']) => void } = {},
): Promise<GenStudioImageResult> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const initial = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/images/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
    undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
  ) as GenStudioImageJob
  // Classify BEFORE polling. A job that already failed (or was cancelled)
  // cannot become an artifact, and a poll loop would only re-read the same
  // terminal record; a job that already succeeded needs its bytes, not a poll.
  if ((initial.state === 'failed' || initial.cancelled === true) && !holdsUnknownOutcome(initial)) {
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
  return {
    url, jobId: completed.id, modelId: completed.model_id,
    ...(isValidSettlement(completed.settled_credits) ? { settledCredits: completed.settled_credits } : {}),
  }
}

export async function recoverImageWithGenStudio(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & { onState?: (state: GenStudioJob['state']) => void } = {},
): Promise<GenStudioImageResult> {
  return recoverImageWithGenStudioAdmitted(apiKey, jobId, request)
}

type GenStudioImageAdmissionOperation = 'text-to-image' | 'image-to-image'

interface ImagePermitWaiter {
  request: GenStudioImageRequest
  deadline: number
  acquire: () => Promise<string>
  resolve: (permitId: string) => void
  reject: (error: Error) => void
  abort?: () => void
  waiting: boolean
  monitoring: boolean
  guardPromise?: Promise<void>
  retryAt?: number
}

interface ImagePermitQueue {
  apiKey: string
  active: number
  draining: boolean
  pendingDrain: boolean
  waiters: ImagePermitWaiter[]
  wakeTimer?: ReturnType<typeof setTimeout>
  wakeAt?: number
}

const imagePermitQueues = new Map<string, ImagePermitQueue>()

function imagePermitIdempotencyKey(generationKey: string, sequence: number): string {
  const digest = createHash('sha256')
    .update(`${generationKey}:admission:${sequence}`)
    .digest('hex')
  return `story-image-permit-${digest}`
}

function imagePermitScope(baseUrl: string, apiKey: string, modelId: string, operation: GenStudioImageAdmissionOperation): string {
  return createHash('sha256')
    .update(`${baseUrl}\0${apiKey}\0${modelId}\0${operation}`)
    .digest('hex')
}

async function assertImageSubmissionAllowed(request: GenStudioImageRequest): Promise<void> {
  if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
  await request.beforeSubmit?.()
  if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
}

function isRetryableImageAdmissionPermitFailure(error: unknown): boolean {
  if (error instanceof GenStudioApiError) return error.status === 429 || error.status >= 500
  if (error instanceof GenStudioTransportTimeoutError) return true
  if (!(error instanceof TypeError)) return false
  return /fetch failed|network|socket|ECONN|timeout|timed out/i.test(error.message)
}

class ImagePermitRetryError extends Error {
  constructor(readonly waitMs: number) {
    super('The Gateway is busy; this image will be tried again shortly')
  }
}

function rejectImagePermitWaiter(queue: ImagePermitQueue, waiter: ImagePermitWaiter, error: unknown): void {
  const index = queue.waiters.indexOf(waiter)
  if (index >= 0) queue.waiters.splice(index, 1)
  if (waiter.request.signal && waiter.abort) {
    waiter.request.signal.removeEventListener('abort', waiter.abort)
  }
  waiter.reject(error instanceof Error ? error : new Error(String(error)))
}

function attachImagePermitAbort(scope: string, queue: ImagePermitQueue, waiter: ImagePermitWaiter): void {
  if (!waiter.request.signal || waiter.abort) return
  waiter.abort = () => {
    rejectImagePermitWaiter(queue, waiter, new Error('Cancelled by user'))
    void drainImagePermitQueue(scope, queue)
  }
  waiter.request.signal.addEventListener('abort', waiter.abort, { once: true })
}

function monitorQueuedImagePermit(scope: string, queue: ImagePermitQueue, waiter: ImagePermitWaiter): void {
  if (waiter.monitoring) return
  waiter.monitoring = true
  void (async () => {
    try {
      while (queue.waiters.includes(waiter)) {
        waiter.guardPromise = assertImageSubmissionAllowed(waiter.request)
        try {
          await waiter.guardPromise
        } finally {
          waiter.guardPromise = undefined
        }
        if (!queue.waiters.includes(waiter)) return
        // Retry deadlines are driven by the queue's single earliest timer.
        // That timer calls this monitor again in guard-sized slices; starting a
        // second sleep here would race the deadline and hide cancellation.
        if (waiter.retryAt) return
        const left = waiter.deadline - Date.now()
        if (left <= 0) throw new Error('Gateway job timed out while waiting for completion')
        await new Promise(resolve => setTimeout(resolve, Math.min(POLL_CANCEL_CHECK_MS, left)))
      }
    } catch (error) {
      rejectImagePermitWaiter(queue, waiter, error)
      void drainImagePermitQueue(scope, queue)
    } finally {
      waiter.monitoring = false
    }
  })()
}

function scheduleImagePermitDrain(scope: string, queue: ImagePermitQueue, waitMs: number): void {
  // Wake in cancellation/guard-sized slices. The waiter keeps its real retryAt,
  // so this never pays early, while a paused or cancelled request does not stay
  // invisible behind a long provider Retry-After.
  const bounded = Math.max(1, Math.min(waitMs, POLL_CANCEL_CHECK_MS))
  const wakeAt = Date.now() + bounded
  if (queue.wakeTimer && (queue.wakeAt || 0) <= wakeAt) return
  if (queue.wakeTimer) clearTimeout(queue.wakeTimer)
  queue.wakeAt = wakeAt
  queue.wakeTimer = setTimeout(() => {
    queue.wakeTimer = undefined
    queue.wakeAt = undefined
    void drainImagePermitQueue(scope, queue)
  }, bounded)
  queue.wakeTimer.unref?.()
}

async function drainImagePermitQueue(scope: string, queue: ImagePermitQueue): Promise<void> {
  if (queue.draining) {
    queue.pendingDrain = true
    return
  }
  if (!queue.waiters.length) {
    if (!queue.active && imagePermitQueues.get(scope) === queue) imagePermitQueues.delete(scope)
    return
  }
  queue.draining = true
  queue.pendingDrain = false
  try {
    const limit = await genStudioAdmission.currentPermitRequestLimit(queue.apiKey)
    while (queue.waiters.length) {
      const now = Date.now()
      for (const waiter of [...queue.waiters]) {
        if (waiter.deadline <= now) {
          rejectImagePermitWaiter(queue, waiter, new Error('The Gateway was too busy to start this image in time (timed out while waiting for image admission permit). Nothing was charged; press Retry when the Macs are free.'))
        }
      }
      if (!queue.waiters.length) break
      if (queue.active >= limit) {
        for (const waiter of [...queue.waiters]) {
          if (!waiter.waiting) {
            waiter.waiting = true
            try {
              await waiter.request.onQueueState?.('waiting_account_capacity')
            } catch (error) {
              rejectImagePermitWaiter(queue, waiter, error)
              continue
            }
          }
          monitorQueuedImagePermit(scope, queue, waiter)
        }
        break
      }
      const readyIndex = queue.waiters.findIndex(waiter => (waiter.retryAt || 0) <= now)
      if (readyIndex < 0) {
        const retryAt = Math.min(...queue.waiters.map(waiter => waiter.retryAt || now + 1))
        const guarded = queue.waiters.find(waiter => waiter.retryAt === retryAt)
        if (guarded) {
          guarded.guardPromise = assertImageSubmissionAllowed(guarded.request)
          try {
            await guarded.guardPromise
          } catch (error) {
            guarded.guardPromise = undefined
            rejectImagePermitWaiter(queue, guarded, error)
            continue
          }
          guarded.guardPromise = undefined
        }
        scheduleImagePermitDrain(scope, queue, retryAt - now)
        break
      }
      const waiter = queue.waiters[readyIndex]!
      if (waiter.guardPromise) {
        try {
          await waiter.guardPromise
        } catch {
          continue
        }
        if (queue.waiters[readyIndex] !== waiter) continue
      }
      queue.waiters.splice(readyIndex, 1)
      waiter.retryAt = undefined
      if (waiter.request.signal && waiter.abort) {
        waiter.request.signal.removeEventListener('abort', waiter.abort)
        waiter.abort = undefined
      }
      queue.active++
      void waiter.acquire().then(waiter.resolve, error => {
        if (error instanceof ImagePermitRetryError) {
          waiter.retryAt = Date.now() + error.waitMs
          queue.waiters.push(waiter)
          attachImagePermitAbort(scope, queue, waiter)
          monitorQueuedImagePermit(scope, queue, waiter)
          scheduleImagePermitDrain(scope, queue, error.waitMs)
          return
        }
        waiter.reject(error instanceof Error ? error : new Error(String(error)))
      }).finally(() => {
        queue.active = Math.max(0, queue.active - 1)
        void drainImagePermitQueue(scope, queue)
      })
    }
  } finally {
    queue.draining = false
    if (!queue.active && !queue.waiters.length && imagePermitQueues.get(scope) === queue) {
      if (queue.wakeTimer) clearTimeout(queue.wakeTimer)
      queue.wakeAt = undefined
      imagePermitQueues.delete(scope)
    } else if (queue.pendingDrain) {
      void drainImagePermitQueue(scope, queue)
    }
  }
}

function withImagePermitSlot(
  scope: string,
  apiKey: string,
  request: GenStudioImageRequest,
  deadline: number,
  acquire: () => Promise<string>,
): Promise<string> {
  let queue = imagePermitQueues.get(scope)
  if (!queue) {
    queue = { apiKey, active: 0, draining: false, pendingDrain: false, waiters: [] }
    imagePermitQueues.set(scope, queue)
  }
  return new Promise<string>((resolve, reject) => {
    const waiter: ImagePermitWaiter = {
      request,
      deadline,
      acquire,
      resolve,
      reject,
      waiting: false,
      monitoring: false,
    }
    attachImagePermitAbort(scope, queue!, waiter)
    queue!.waiters.push(waiter)
    void drainImagePermitQueue(scope, queue!)
  })
}

/** GenStudio permits use bounded parallel acquisition; paid image execution remains remote-owned. */
async function acquireImageAdmissionPermit(
  baseUrl: string,
  apiKey: string,
  request: GenStudioImageRequest,
  idempotencyKey: string,
  operation: GenStudioImageAdmissionOperation,
  sequence: number,
  deadline: number,
): Promise<string> {
  const body = wellFormedJson({ model_id: request.modelId.trim(), operation })
  const permitKey = imagePermitIdempotencyKey(idempotencyKey, sequence)
  let retryAttempt = 0
  const acquire = async (): Promise<string> => {
    await assertImageSubmissionAllowed(request)
    if (Date.now() >= deadline) {
      throw new Error('The Gateway was too busy to start this image in time (timed out while waiting for image admission permit). Nothing was charged; press Retry when the Macs are free.')
    }
    const reservation = await genStudioAdmission.reservePermitRequest(apiKey)
    if ('retryAfterMs' in reservation) {
      await request.onQueueState?.('waiting_account_capacity')
      throw new ImagePermitRetryError(reservation.retryAfterMs)
    }
    try {
      const permit = await requestJsonWithRetry(
          `${apiBase(baseUrl)}/v1/images/admission/permits`,
          {
            method: 'POST',
            headers: {
              ...authorization(apiKey),
              'Content-Type': 'application/json',
              'Idempotency-Key': permitKey,
            },
            body,
          },
          request,
          deadline,
          undefined,
          GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
          [],
          false,
          1,
        )
      const permitId = typeof permit?.id === 'string' ? permit.id.trim() : ''
      if (!permitId) throw new Error('The Gateway returned an invalid image admission permit')
      await request.onQueueState?.('submitting')
      return permitId
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      if (!isRetryableImageAdmissionPermitFailure(error) || Date.now() >= deadline) throw error
      await request.onQueueState?.('waiting_account_capacity')
      const hintMs = error instanceof GenStudioApiError && error.retryAfterSeconds != null
        ? error.retryAfterSeconds * 1_000
        : undefined
      const baseMs = hintMs ?? Math.min(4_000, 500 * (2 ** retryAttempt++))
      throw new ImagePermitRetryError(Math.min(
        Math.ceil(baseMs * (hintMs === undefined ? 0.8 + Math.random() * 0.4 : 1 + Math.random() * 0.1)),
        Math.max(0, deadline - Date.now()),
      ))
    } finally {
      reservation.release()
    }
  }
  const scope = imagePermitScope(baseUrl, apiKey, request.modelId.trim(), operation)
  return withImagePermitSlot(scope, apiKey, request, deadline, acquire)
}

function isAuthoritativelyUnchargedPermitFailure(error: unknown): boolean {
  return error instanceof GenStudioApiError
    && (error.status === 404 || error.status === 409)
    && (error.code === 'ADMISSION_PERMIT_NOT_FOUND' || error.code === 'ADMISSION_PERMIT_INVALID')
}

/** Submit one durable GenStudio image task and return its verified private PNG. */
async function generateImageWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioImageRequest,
): Promise<GenStudioImageResult> {
  const prompt = request.prompt.trim()
  const modelId = request.modelId.trim()
  // Bounds published on `ImageGenerationRequest.prompt` itself. The per-model
  // ceiling is `max_prompt_characters` and is enforced against the selected
  // model before this point — this check must never sit below it, or a prompt
  // GenStudio publishes as acceptable would be refused by an invented limit.
  if (prompt.length < 3 || prompt.length > 32_000) {
    throw new Error('Gateway image prompts must contain 3 to 32,000 characters.')
  }
  if (!modelId) throw new Error('Select a Gateway image model.')
  const hasDimensions = Number.isInteger(request.width) && request.width! > 0
    && Number.isInteger(request.height) && request.height! > 0
  // Sent only when the caller resolved one from the model's published
  // `output_options[]`. GenStudio applies its own `default_resolution` when the
  // field is absent, which is exactly the right behaviour for a model that
  // publishes no output options at all.
  const resolution = (request.resolution || '').trim()
  const paidBody = {
    prompt,
    model_id: modelId,
    aspect_ratio: request.aspectRatio,
    ...(resolution ? { resolution } : {}),
    ...(hasDimensions
      ? { width: request.width, height: request.height }
      : {}),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.referenceAssetIds?.length ? { reference_asset_ids: request.referenceAssetIds } : {}),
    ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
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
    outputFormat: request.outputFormat,
  })
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const operation: GenStudioImageAdmissionOperation = request.referenceAssetIds?.length
    ? 'image-to-image'
    : 'text-to-image'
  let permitSequence = 1
  let permitId = request.requiresAdmissionPermit === true
    ? await acquireImageAdmissionPermit(
      baseUrl, apiKey, request, idempotencyKey, operation, permitSequence, deadline,
    )
    : undefined
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
      ['output_format', request.outputFormat],
    ],
  })
  let submitted: GenStudioImageJob
  const jobGroup = await jobGroupField()
  for (;;) {
    await assertImageSubmissionAllowed(request)
    try {
      submitted = await requestJsonWithRetry(
        `${apiBase(baseUrl)}/v1/images/generations`,
        {
          method: 'POST',
          headers: {
            ...authorization(apiKey),
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: wellFormedJson({
            ...jobGroup,
            ...paidBody,
            ...(permitId ? { admission_permit_id: permitId } : {}),
            ...(request.priority ? { priority: request.priority } : {}),
          }),
        },
        request,
        deadline,
        apiKey,
      ) as GenStudioImageJob
      break
    } catch (error) {
      if (isGenStudioInsufficientCredits(error)) {
        await recordGenStudioCreditRefusal({ operation: 'image.generation', preview: requestPreview }, error)
      }
      if (!request.requiresAdmissionPermit || !isAuthoritativelyUnchargedPermitFailure(error)) throw error
      permitId = await acquireImageAdmissionPermit(
        baseUrl, apiKey, request, idempotencyKey, operation, ++permitSequence, deadline,
      )
    }
  }
  await recordGenStudioEvidence('image.generation', submitted, requestPreview)
  await reportQueueState(request, submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  try {
    const completed = await waitForImageJob(baseUrl, apiKey, submitted, request, deadline)
    const url = await downloadImageArtifact(baseUrl, apiKey, completed, request, deadline)
    return {
      url, jobId: completed.id, modelId: completed.model_id,
      ...(isValidSettlement(completed.settled_credits) ? { settledCredits: completed.settled_credits } : {}),
    }
  } catch (error) {
    if (!shouldReconnectAcceptedTask(error, request)) throw error
    await request.onReconnect?.(submitted.id, error instanceof Error ? error.message : String(error))
    return recoverImageWithGenStudioAdmitted(apiKey, submitted.id, request)
  }
}

export async function generateImageWithGenStudio(
  apiKey: string,
  request: GenStudioImageRequest,
): Promise<GenStudioImageResult> {
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
 * Only explicit expiry retires a quote. A malformed request, missing endpoint,
 * or already-settled conflict cannot prove that no transcription was charged.
 */
function isTerminalQuoteStatus(status: number): boolean {
  return status === 410
}

function isTerminalTranscriptionQuoteConfirmError(error: GenStudioApiError): boolean {
  return isTerminalQuoteStatus(error.status)
    // GenStudio's current confirm route maps this exact service outcome to
    // 422. Other 422s can mean malformed input and remain non-retryable.
    || (error.status === 422 && error.detail === 'transcription quote has expired')
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
  let reportedEvidence = ''
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || null
    const evidenceFingerprint = providerEvidenceFingerprint(current as GenStudioJob)
    if (reportedState === current.state && reportedRoutingState === routingState && reportedEvidence === evidenceFingerprint) return
    reportedState = current.state
    reportedRoutingState = routingState
    reportedEvidence = evidenceFingerprint
    await recordGenStudioEvidence('audio.transcription', current)
    await reportQueueState(request, current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!poller.settled(current)) {
    await submitQueuedRemoteCancellation('audio.transcription', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) {
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) {
      throw new Error('Gateway transcription timed out while waiting for completion')
    }
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/transcriptions/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
      undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
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
        const error = new Error(`Gateway SRT download failed (HTTP ${response.status})`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        const srt = await response.text()
        if (!srt.trim()) throw new Error('The Gateway returned an empty SRT artifact')
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
    : new Error('Gateway SRT download failed after reconnect attempts')
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
  let initial: GenStudioTranscriptionJob
  try {
    initial = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/transcriptions/${encodeURIComponent(jobId)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
      undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
    ) as GenStudioTranscriptionJob
  } catch (error) {
    if (error instanceof GenStudioApiError && error.status === 404) {
      throw new GenStudioTranscriptionTaskUnavailableError(jobId, error.status)
    }
    throw error
  }
  // Classify BEFORE polling. A job that already failed (or was cancelled)
  // cannot become a transcript, and a poll loop would only re-read the same
  // terminal record — the "reopen a six-day-old failure forever" bug.
  if ((initial.state === 'failed' || initial.cancelled === true) && !holdsUnknownOutcome(initial)) {
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
  if (!modelId) throw new Error('Select a Gateway transcription model.')
  if (!request.requestIdentity.trim()) throw new Error('Stable Story Studio transcription asset identity is required.')
  const file = await fs.readFile(request.audioPath)
  if (!file.length) throw new Error('Transcription audio is empty.')
  if (file.length > GENSTUDIO_MAX_TRANSCRIPTION_BYTES) {
    throw new Error('Gateway transcription input exceeds the 100 MiB qualification limit.')
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
  const quote = request.preparedQuote || await submitJsonWithAdmission(
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
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [],
    { operation: 'audio.transcription', preview: requestPreview },
  ).catch((error: unknown) => {
    if (error instanceof GenStudioApiError && isTerminalQuoteStatus(error.status)) {
      throw new GenStudioTranscriptionQuoteExpiredError(error.status, error.detail)
    }
    throw error
  }) as GenStudioTranscriptionQuote
  if (!quote.id) throw new Error('The Gateway did not return a price for this transcription.')
  const confirmIdempotencyKey = `${idempotencyKey}-confirm`
  // The confirm is the job-creating request (the quote only prices), so the group rides here.
  const jobGroup = await jobGroupField()
  const submitted = await submitJsonWithAdmission(
    apiKey,
    `${apiBase(baseUrl)}/v1/audio/transcriptions/quotes/${encodeURIComponent(quote.id)}/confirm`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Idempotency-Key': confirmIdempotencyKey,
        ...(jobGroup.job_group ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(jobGroup.job_group ? { body: wellFormedJson(jobGroup) } : {}),
    },
    { ...request, withPost: post => {
      const confirm = async () => {
        await request.beforeConfirm?.(quote)
        return post()
      }
      return request.withConfirm ? request.withConfirm(confirm) : confirm()
    } },
    deadline,
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [],
    { operation: 'audio.transcription', preview: requestPreview },
  ).catch((error: unknown) => {
    if (error instanceof GenStudioApiError && isTerminalTranscriptionQuoteConfirmError(error)) {
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
  let reportedEvidence = ''
  const reportState = async (): Promise<void> => {
    const routingState = current.routing_status_code || null
    const evidenceFingerprint = providerEvidenceFingerprint(current)
    if (reportedState === current.state && reportedRoutingState === routingState && reportedEvidence === evidenceFingerprint) return
    reportedState = current.state
    reportedRoutingState = routingState
    reportedEvidence = evidenceFingerprint
    await recordGenStudioEvidence('voice.tts', current)
    await reportQueueState(request, current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  const poller = createGenStudioJobPoller()
  while (!poller.settled(current)) {
    await submitQueuedRemoteCancellation('voice.tts', baseUrl, apiKey, current.id, deadline)
    if (request.isCancelled?.() || request.signal?.aborted) {
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) {
      throw new Error('The narration was not ready at the Gateway in time')
    }
    await poller.wait(deadline, request, current)
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/jobs/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
      undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
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
  if (completed.section_quality) request.onSectionQuality?.(completed.section_quality)
  if (!completed.audio_url) {
    throw new GenStudioTtsArtifactUnavailableError(completed.id, 0, 'the job completed without a download URL')
  }

  // The download is whatever the lane returned: WAV, or AAC when `output_format: m4a` was honoured.
  // ffmpeg identifies it by content, and Story's MP3 chapter below is written either way.
  const tempPath = path.join(os.tmpdir(), `genstudio-audio-${randomUUID()}.${request.outputFormat === 'm4a' ? 'm4a' : 'wav'}`)
  try {
    // Every download is checked before use: non-empty, then ffprobe must find an audio stream. A bad
    // one is fetched once more (the Gateway keeps its artifacts); still bad means the stored result
    // itself is unusable — EP0038, 2026-10-09: a 0-byte m4a the Gateway stored as `succeeded`, which
    // every Retry collected again and fed to ffmpeg ("moov atom not found").
    let signature: string | null = null
    for (let fetchRound = 1; fetchRound <= 2 && !signature; fetchRound++) {
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
            const error = new Error(`Could not download the audio from the Gateway (HTTP ${audioResponse.status})`)
            if (!retryableStatus(audioResponse.status)) throw error
            downloadError = error
          } else {
            const body = audioResponse.body as ReadableStream<Uint8Array> | null
            if (!body) throw new Error('The Gateway sent an empty audio download')
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
      if (!downloaded) throw downloadError instanceof Error ? downloadError : new Error('Could not download the audio from the Gateway')
      const bytes = (await fs.stat(tempPath).catch(() => null))?.size || 0
      signature = bytes > 0 ? await probeAudioSignature(tempPath) : null
      if (!signature && fetchRound === 1) await fs.rm(tempPath, { force: true }).catch(() => {})
      if (!signature && fetchRound === 2) {
        throw new GenStudioTtsArtifactUnavailableError(completed.id, 0, bytes > 0 ? `${bytes} bytes with no readable audio` : 'the stored file is empty')
      }
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    // Cloud providers already deliver MP3 (the Hub delivers WAV): re-encoding one to 96 kbps MP3 is a
    // second lossy pass and a few seconds of CPU per chunk for nothing, so keep its bytes as they are.
    if (signature?.startsWith('mp3,')) {
      const staged = `${outPath}.partial-${process.pid}`
      try {
        await fs.copyFile(tempPath, staged)
        await fs.rename(staged, outPath)
      } finally {
        await fs.rm(staged, { force: true }).catch(() => {})
      }
    } else {
      await runFfmpeg(['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-b:a', '96k', outPath])
    }
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
    undefined, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS, [], false, GENSTUDIO_JOB_READ_ATTEMPTS,
  ) as GenStudioJob
  await completeTtsJobToFile(baseUrl, apiKey, outPath, current, request, deadline)
}

export async function recoverTtsToFile(
  apiKey: string,
  outPath: string,
  jobId: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  if (request.modelId && request.maxInputCharacters && request.voiceId) {
    const submission = buildGenStudioSubmission(request)
    const key = request.idempotencyKey?.trim() || submission.idempotencyKey
    const itemKey = createHash('sha256').update(outPath + JSON.stringify(submission.body)).digest('hex')
    const restored = await restoreReplacementRequest('audio', apiKey, key, itemKey, request)
    if (restored.key !== key) {
      return generateTtsToFileAdmitted(apiKey, outPath, { ...restored.request, idempotencyKey: restored.key, modelId: request.modelId, maxInputCharacters: request.maxInputCharacters })
    }
  }
  try {
    return await recoverTtsToFileAdmitted(apiKey, outPath, jobId, request)
  } catch (error) {
    return replaceFailedTts(apiKey, outPath, request, error)
  }
}

function replaceFailedTts(apiKey: string, outPath: string, request: GenStudioTtsRequest, error: unknown): Promise<void> {
  if (!request.modelId || !request.maxInputCharacters || !request.voiceId) return Promise.reject(error)
  const submitRequest: GenStudioTtsSubmitRequest = { ...request, modelId: request.modelId, maxInputCharacters: request.maxInputCharacters }
  const originalKey = request.idempotencyKey?.trim() || buildGenStudioSubmission(submitRequest).idempotencyKey
  const itemKey = createHash('sha256').update(outPath + JSON.stringify(buildGenStudioSubmission(submitRequest).body)).digest('hex')
  return replaceConfirmedGeneration('audio', apiKey, originalKey, itemKey, error, request,
    (key, _cap, hooks) => generateTtsToFileAdmitted(apiKey, outPath, { ...submitRequest, ...hooks, idempotencyKey: key }),
    async () => {
      const quote = await requestGenStudioTtsQuote(apiKey, {
        modelId: request.modelId!, voiceId: request.voiceId!, text: request.text, speed: request.speed,
        supportsSpeed: request.supportsSpeed,
        minimumSpeed: request.minimumSpeed,
        maximumSpeed: request.maximumSpeed,
        controls: request.controls,
      })
      return quote.maximum_credits ?? null
    })
}

/** Generate a GenStudio API TTS job, then convert its private WAV response to Story's MP3 contract. */
async function generateTtsToFileAdmitted(
  apiKey: string,
  outPath: string,
  request: GenStudioTtsSubmitRequest,
  replayHops = 0,
): Promise<void> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const submission = buildGenStudioSubmission(request)
  let idempotencyKey = request.idempotencyKey?.trim() || submission.idempotencyKey
  const itemKey = createHash('sha256').update(outPath + JSON.stringify(submission.body)).digest('hex')
  const restored = await restoreReplacementRequest('audio', apiKey, idempotencyKey, itemKey, request)
  request = restored.request
  idempotencyKey = restored.key
  if (restored.taskId) {
    await request.onJobAccepted?.(restored.taskId, idempotencyKey)
    return recoverTtsToFileAdmitted(apiKey, outPath, restored.taskId, request)
  }
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
      ...(submission.body.output_format ? [['output_format', submission.body.output_format] as [string, unknown]] : []),
      ...(['paragraph_pause_sec', 'sentence_pause_sec'] as const)
        .filter(name => submission.body[name] !== undefined)
        .map(name => [name, submission.body[name]] as [string, unknown]),
      // How this take was DIRECTED, when the customer directed it. Short by
      // contract (the Gateway's own published limit), and it is a setting, not
      // script text, so it is worth keeping where a charge is reconciled.
      ...(submission.body.delivery_instruction
        ? [['delivery_instruction', submission.body.delivery_instruction] as [string, unknown]]
        : []),
      // Recorded only when the model published controls, so the operator can
      // see which settings a job went out under. The names are GenStudio's.
      ...(submission.body.controls
        ? Object.entries(submission.body.controls).map(([name, value]) => [`control ${name}`, value] as [string, unknown])
        : []),
    ],
  })
  const jobGroup = await jobGroupField()
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
      body: wellFormedJson({ ...jobGroup, ...submission.body, ...(request.replacementChargeLimit !== undefined ? { max_charge_credits: request.replacementChargeLimit } : {}) }),
    },
    request,
    deadline,
    GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS,
    [],
    { operation: 'voice.tts', preview: requestPreview },
  ) as GenStudioJob
  await recordGenStudioEvidence('voice.tts', submitted, requestPreview)
  // The chat rule (`replayedSettledChatFailure`), for narration: the key is derived from the part,
  // so once Story's record of an earlier failure is gone (a lost accept answer, a removed manifest)
  // a re-run re-POSTs it and the gateway answers with that OLD failed job. Settled, held by nobody
  // and free, nothing is in flight under it, so re-send under the identity the run's own retry
  // derives from the dead job (`nextTtsRouteRetryIdentity`): a re-run walks the same chain the
  // first run did, reattaching to what it already made, and a restart re-derives it too.
  // Only a key derived here: a caller-supplied key (a resume, a deliberate action's Retry, a paid
  // replacement) names one specific request and is never moved - the chat rule again.
  if (!request.idempotencyKey?.trim() && request.replacementChargeLimit === undefined
    && replayedSettledChatFailure(submitted) && replayHops < MAX_FAILED_CHAT_REPLAY_HOPS) {
    return generateTtsToFileAdmitted(apiKey, outPath, {
      ...request,
      requestIdentity: nextTtsRouteRetryIdentity(request.requestIdentity?.trim() || '', submitted.id),
      idempotencyKey: undefined,
    }, replayHops + 1)
  }
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
  try {
    return await generateTtsToFileAdmitted(apiKey, outPath, request)
  } catch (error) {
    return replaceFailedTts(apiKey, outPath, request, error)
  }
}
