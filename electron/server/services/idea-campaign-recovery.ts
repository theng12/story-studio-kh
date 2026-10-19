/**
 * Durable per-batch identity for the Idea Campaign.
 *
 * WHY THIS EXISTS
 * ---------------
 * The provider derives its own idempotency key from the request BODY
 * (`buildGenStudioChatIdempotencyKey`), which protects a byte-identical re-send but nothing when the
 * body changes: a retry that re-derives a different prompt, count or budget mints a new key and the
 * request accepted under the old one is abandoned — paid for, never collected.
 *
 * So the whole dispatch is captured BEFORE it can be charged, and a captured batch that was never
 * resolved is COLLECTED by the key the provider itself generated, through the provider's read-only
 * by-idempotency-key lookup. That lookup deliberately runs before any live catalogue read (see
 * `genstudio-client`'s recovery branch), so a changed or unavailable catalogue cannot strand it.
 *
 * WHAT MUST BE CAPTURED
 * ---------------------
 * Not just the text: the count, the model, the request identity, the output budget and the
 * output contract, plus whatever the answer needs to be normalised — the reserved assignments
 * (coverage) or the variety slots (freeform). Replaying the key without the contract would collect
 * an answer the caller cannot parse; replaying the text without the key would pay twice.
 */
import type { Job } from '../models/types.js'
import type { OutputBudget } from './output-token-budget.js'
import type { TextOutputContract } from '../lib/json-output-contract.js'

/** The one in-flight batch record, held in the job's params so it survives a restart with the job. */
export const IDEA_BATCH_PARAM = 'idea_batch'

export interface IdeaBatchRecord {
  /** Stable within the campaign; the namespace that survives a Retry. */
  ordinal: number
  /** The EXACT prompt sent. Replaying it verbatim is what makes the provider key come back the same. */
  prompt: string
  count: number
  model: string
  /** The identity the request went out under, captured so a replay keeps it byte for byte. */
  request_identity: string
  outputBudget: OutputBudget
  outputContract: TextOutputContract
  /** Coverage: the reserved assignments, whole, so an answer can be normalised without re-planning. */
  assignments?: unknown[]
  /** Freeform: the variety slots issued with this batch. */
  slots?: unknown[]
  /** Assignment keys or slot labels this batch reserved. */
  keys: string[]
  /** The provider key, recorded when the request was prepared — the generated one, never invented. */
  idempotency_key?: string
  /** The provider's own job id once accepted, so an accepted-but-unknown request can be collected. */
  provider_job_id?: string
  /** Idea ids appended for this batch. Present means the batch is resolved and must not be replayed. */
  idea_ids?: string[]
  /** The batch was answered and must never be replayed — set even when nothing usable came back. */
  resolved?: boolean
  /**
   * The key this batch was sent under, collected, and found PROVEN dead (settled `failed`, no hold).
   * Collecting that key again answers the same failure forever, so the identity is released — the
   * live `idempotency_key`/`provider_job_id` are cleared and `request_identity` moves to a fresh one
   * — and this keeps what failed, so the release is auditable and the same key is never released
   * twice. Only a proven failure qualifies: a held or uncertain outcome keeps its key.
   */
  settled_failed?: {
    idempotency_key: string
    provider_job_id?: string
    failure_code?: string | null
    failure_detail?: string | null
  }
}

/**
 * What the job holds for the next batch. `malformed` is deliberately its own answer: a record that
 * is present but unreadable is not the same as no record, and must not quietly become a fresh send.
 */
export type IdeaBatchRecordState =
  | { state: 'absent' }
  | { state: 'resolved'; record: IdeaBatchRecord }
  | { state: 'pending'; record: IdeaBatchRecord }
  | { state: 'malformed'; raw: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Read the stored record and say exactly which of the four states it is in. */
export function ideaBatchRecordState(params: unknown): IdeaBatchRecordState {
  const raw = isRecord(params) ? (params as Record<string, unknown>)[IDEA_BATCH_PARAM] : undefined
  if (raw === undefined || raw === null) return { state: 'absent' }
  if (!isRecord(raw)) return { state: 'malformed', raw }
  if (raw.resolved === true || (Array.isArray(raw.idea_ids) && raw.idea_ids.length)) {
    // Terminal, and never replayed, so only its terminal-ness needs to be trustworthy.
    return { state: 'resolved', record: raw as unknown as IdeaBatchRecord }
  }
  const { ordinal, count, model, prompt, keys, request_identity, outputBudget, outputContract } = raw
  const budgetOk = typeof outputBudget === 'string' || isRecord(outputBudget)
  if (!Number.isInteger(ordinal) || (ordinal as number) < 1
    || !Number.isInteger(count) || (count as number) < 1
    || typeof model !== 'string' || !model
    || typeof prompt !== 'string'
    || typeof request_identity !== 'string' || !request_identity
    || !budgetOk
    || !isRecord(outputContract)
    || !Array.isArray(keys) || keys.some(key => typeof key !== 'string')) {
    return { state: 'malformed', raw }
  }
  return { state: 'pending', record: raw as unknown as IdeaBatchRecord }
}

/** The recorded batch, whatever its state — used only to keep the ordinal moving forward. */
export function readIdeaBatch(params: unknown): IdeaBatchRecord | null {
  const state = ideaBatchRecordState(params)
  return state.state === 'pending' || state.state === 'resolved' ? state.record : null
}

/** Write the record into the job's params. The caller persists (the job's own checkpoint). */
export function writeIdeaBatch(job: Job, record: IdeaBatchRecord): void {
  ;(job.params as Record<string, unknown>)[IDEA_BATCH_PARAM] = record
}

/** The ordinal this campaign has reached; a fresh campaign starts at 1. */
export function nextIdeaBatchOrdinal(params: unknown): number {
  return (readIdeaBatch(params)?.ordinal ?? 0) + 1
}

/**
 * Release a batch identity the Gateway PROVED dead, and move it to a fresh one.
 *
 * Collecting a settled-failed key answers the same failure for as long as that job exists — the
 * provider derives the key from the request body, so a byte-identical replay is the ONLY thing that
 * finds it. The way forward is a different identity, and the next one is derived from the dead job
 * so an in-process retry and a crash-replay of the same release derive ONE identity, never two.
 *
 * The captured body is deliberately untouched: the caller still sends this batch's own prompt,
 * slots or assignments, exactly as a replay would — only the identity moves. The failure itself is
 * kept on the record, so what died is still readable afterwards.
 */
export function releaseSettledFailedIdeaBatch(
  record: IdeaBatchRecord,
  failure: NonNullable<IdeaBatchRecord['settled_failed']>,
): void {
  record.settled_failed = failure
  delete record.idempotency_key
  delete record.provider_job_id
  record.request_identity = `${record.request_identity.replace(/:fresh:[^:]*$/, '')}:fresh:${failure.provider_job_id || failure.idempotency_key}`
}

/** The durable identity one batch's appended ideas are filed under. Namespaced, so campaigns cannot collide. */
export function ideaBatchAppendKey(campaignId: string, ordinal: number): string {
  return `${campaignId}:batch:${ordinal}`
}

/**
 * The batch to collect now: the captured one that was never resolved, or null when a fresh one is
 * due. A malformed record is NOT null here — it is surfaced for the caller to fail closed on.
 */
export function pendingIdeaBatch(params: unknown): IdeaBatchRecord | null {
  const state = ideaBatchRecordState(params)
  return state.state === 'pending' ? state.record : null
}
