/**
 * Unified AI client — dispatches to registered text providers via the provider registry.
 *
 * Two call shapes are supported:
 *
 * The apiKeys parameter remains for call-site compatibility but is ignored;
 * GenStudio credentials are read from the app-level secure store.
 */

import { registry } from '../providers/registry.js'
import { getApiKey } from '../services/app-secrets-store.js'
import type { TextGenerationDiagnostics } from '../providers/types.js'
import type { TextOutputContract } from './json-output-contract.js'
import type { OutputBudget } from '../services/output-token-budget.js'
import {
  resolveGenStudioModelId,
  unavailableLegacyModelMessage,
} from '../services/genstudio-model-migration.js'
import {
  GenStudioChatCapabilityUnavailableError,
  type GenStudioChatModel,
  GenStudioChatProductUnavailableError,
  GenStudioChatTerminalFailureError,
  isGenStudioLanguageQuotaExhausted,
  isGenStudioSubmissionUncertain,
  listChatModels,
} from './genstudio-client.js'
import { resolveOutputTokenBudget } from '../services/output-token-budget.js'
import {
  pipelinePolicyInputFingerprint,
  readPipelinePolicyAttemptCheckpoint,
  type AssignedPipelineModelPolicy,
  type PipelinePolicyAttemptCheckpoint,
  type PipelinePolicyCheckpointStore,
} from './pipeline-model-policy.js'
import type { GenStudioRequestPreview } from './genstudio-request-preview.js'
import { findGenStudioProduct } from '../contracts/genstudio-product-identity.js'

/**
 * A writing model that confirmed "quota used up" without a hold is asked again later
 * instead of failing the job. A free allowance is usually DAILY, so the wait doubles per
 * consecutive stop — 1, 2, 4, 8, 16, then every 30 minutes — and a success resets it.
 * One model only: a Gateway pool already falls through its own members (owner, 2026-10-03).
 */
export const QUOTA_RECHECK_MS = 60_000
export const QUOTA_MAX_RECHECK_MS = 30 * 60_000
const quotaStrikes = new Map<string, number>()
let quotaRecheckMs = QUOTA_RECHECK_MS

/** Tests only: shorten the first wait so a park → recheck cycle fits in a test. */
export function _setQuotaRecheckMsForTesting(ms: number): void {
  quotaRecheckMs = ms
}

/** True when this error (or one it wraps) is a confirmed quota stop without a hold. */
export function isUnchargedQuotaStop(error: unknown): boolean {
  for (let e: any = error, depth = 0; e && depth < 8; e = e.cause, depth++) {
    if (isGenStudioLanguageQuotaExhausted(e) && !e.cancelled
      && !isGenStudioSubmissionUncertain(e)) return true
  }
  return false
}

/** Record one more quota stop for `model` and return when to ask it again. */
export function noteQuotaStop(model: string): string {
  const key = model.trim().toLowerCase()
  const strikes = (quotaStrikes.get(key) || 0) + 1
  quotaStrikes.set(key, strikes)
  const delay = Math.min(quotaRecheckMs * 2 ** (strikes - 1), QUOTA_MAX_RECHECK_MS)
  return new Date(Date.now() + delay).toISOString()
}

export function clearQuotaStops(model: string): void {
  quotaStrikes.delete(model.trim().toLowerCase())
}

/**
 * Confirm a saved wire id is still offered, without replacing it. A model the
 * Gateway no longer lists, or lists as unusable, stops the run before any
 * submission; another model is never substituted.
 */
export function resolveLivePipelineModel(
  savedModelId: string,
  catalogue: readonly GenStudioChatModel[],
): GenStudioChatModel {
  const model = findGenStudioProduct(catalogue, savedModelId)
  if (!model) throw new GenStudioChatProductUnavailableError(savedModelId)
  if (model.qualification_only) {
    throw new GenStudioChatProductUnavailableError(savedModelId, { blockers: model.activation_blockers })
  }
  if (model.available) return model
  throw new GenStudioChatProductUnavailableError(savedModelId, {
    reason: null,
    availableAgainAt: null,
    // What the gateway said, when it said anything — the operator gets the
    // reason instead of the generic sentence.
    blockers: model.activation_blockers,
  })
}

export interface CallAiContext {
  /** Project slug — enables account-aware key resolution. */
  slug?: string
  /** Job id — surfaced in the resolver's log line. */
  jobId?: string
  /** Specific account to use (defaults to provider's default). */
  accountId?: string
  /** Abort signal — passed to the provider SDK so a user-cancelled job tears
   *  down the streaming completion instead of running to max_tokens. */
  signal?: AbortSignal
  /** An exact output-token cap. Prefer `outputBudget` unless the caller can
   *  genuinely compute a hard number — an explicit value above the selected
   *  product's published limit is refused before the request is submitted. */
  maxTokens?: number
  /**
   * The SHAPE of this workflow's output — short / standard / long / maximum —
   * sized at submission time from the SELECTED product's published
   * `max_output_tokens`. This is how a long-form workflow avoids being cut off
   * at the conservative 2,048-token short-form default without hardcoding a
   * number that goes stale. See services/output-token-budget.ts, which also
   * documents what a bigger budget does to credit reservations.
   */
  outputBudget?: OutputBudget
  /**
   * How long this request's answer is expected to be, in output tokens — the hint Studio Hub
   * sizes the job's chat deadline from. **Not a ceiling**: `maxTokens`/`outputBudget` say what
   * may be sent, this says what is coming. See services/output-token-budget.ts.
   */
  expectedOutputTokens?: number
  /** Ask supporting providers to guarantee a valid JSON object response. */
  jsonMode?: boolean
  /** Exact prose, JSON Object, or strict JSON-schema workflow contract. */
  outputContract?: TextOutputContract
  /** Skip reasoning tokens for deterministic extraction/formatting work. */
  disableReasoning?: boolean
  /** Sampling temperature forwarded to providers that support it. */
  temperature?: number
  /** Stable logical request identity for durable provider submissions. */
  requestIdentity?: string
  /** Reconcile a saved GenStudio chat idempotency key without a new submission. */
  recoverByIdempotencyKey?: boolean
  /** Saved-key recovery: hand a lost request back to the caller instead of resending it. */
  deferLostResend?: boolean
  /** Explicit Retry-only path for a server-proven not-created request. */
  allowUncreatedRecovery?: boolean
  recoveryRequestPreview?: GenStudioRequestPreview
  /** Server-owned durable key for a proven recovery; never client input. */
  idempotencyKey?: string
  allowedRecoveryKeys?: string[]
  /** Receives provider finish reason and token usage without changing callAi's return type. */
  onDiagnostics?: (diagnostics: TextGenerationDiagnostics) => void
  /** Receives the exact Pipeline product selected for this logical request. */
  onModelSelected?: (model: string) => void | Promise<void>
  /** Revalidate the selected product's live capability before its charged call. */
  beforeModelAttempt?: (model: string) => void | Promise<void>
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
  onRequestPrepared?: (idempotencyKey: string, preview?: GenStudioRequestPreview) => void | Promise<void>
  /** Durable Pipeline candidate checkpoint, supplied by a job executor. */
  pipelinePolicyCheckpoint?: PipelinePolicyCheckpointStore
  /** Stable key for this logical request; falls back to requestIdentity. */
  pipelinePolicyCheckpointKey?: string
  pipelinePolicyInputFingerprint?: string
  /**
   * v1.0.283 — optional image attachments for vision-capable models. Each
   * entry is a base64 data URL. Forwarded to the provider's `callText`
   * (which repackages into the SDK's multimodal content-array). Only
   * meaningful for OpenAI's gpt-4o family + LM Studio when a vision model
   * is loaded; non-vision providers silently ignore. Used by shared vision
   * workflows such as image analysis and reference-assisted generation.
   */
  images?: string[]
}

export async function callAi(
  model: string,
  system: string,
  userMsg: string,
  _apiKeys: Record<string, string | undefined>,
  stream = false,
  ctx: CallAiContext = {},
): Promise<string> {
  // Catch the "model field dropped from upstream request" class of bug
  // (would otherwise crash inside provider.supportsModel as
  // `undefined.startsWith(...)` — opaque error every caller had to trace by
  // hand). Cheap defensive guard at the only choke point.
  if (typeof model !== 'string' || !model) {
    throw new Error('callAi: model is required')
  }

  const resolvedModelId = resolveGenStudioModelId('chat', model)
  if (!resolvedModelId) throw new Error(unavailableLegacyModelMessage('chat', model))
  model = `genstudio-chat:${resolvedModelId}`

  // Find which provider handles this model
  const provider = registry.findTextProviderForModel(model)
  if (!provider || provider.meta.id !== 'genstudio') {
    throw new Error(`Gateway text provider is unavailable for ${model}. No legacy provider fallback was attempted.`)
  }

  // GenStudio is the sole execution boundary; its encrypted app-level key is
  // intentionally independent of old project configuration.
  const apiKey = await getApiKey('genstudio').catch(() => '')

  const effectiveSystem = system

  const result = await provider.callText({
    model,
    system: effectiveSystem,
    userMessage: userMsg,
    apiKey,
    stream,
    signal: ctx.signal,
    maxTokens: ctx.maxTokens,
    outputBudget: ctx.outputBudget,
    expectedOutputTokens: ctx.expectedOutputTokens,
    jsonMode: ctx.jsonMode,
    outputContract: ctx.outputContract,
    disableReasoning: ctx.disableReasoning,
    temperature: ctx.temperature,
    // The request body is already part of the GenStudio idempotency digest.
    // Keep the fallback stable across Story job retries instead of including
    // the transient local queue id.
    requestIdentity: ctx.requestIdentity || ctx.slug || undefined,
    recoverByIdempotencyKey: ctx.recoverByIdempotencyKey === true,
    deferLostResend: ctx.deferLostResend === true,
    allowUncreatedRecovery: ctx.allowUncreatedRecovery === true,
    recoveryRequestPreview: ctx.recoveryRequestPreview,
    idempotencyKey: ctx.idempotencyKey,
    allowedRecoveryKeys: ctx.allowedRecoveryKeys,
    onDiagnostics: ctx.onDiagnostics,
    onJobAccepted: ctx.onJobAccepted,
    onRequestPrepared: ctx.onRequestPrepared,
    images: ctx.images,
  })

  return result
}

const CONNECTION_ERROR_RE = /Connection error|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up|timed out|timeout/i

/**
 * Small local models (Gemma, Llama 3B, etc.) sometimes emit literal control
 * characters (raw \n, \r, \t, 0x01–0x1F) inside JSON string values, which
 * makes JSON.parse throw "Bad control character in string literal".
 * This sanitizer replaces them with their escape sequences — but only inside
 * string literals, so structural whitespace between tokens is left alone.
 */
export function sanitizeJsonControlChars(s: string): string {
  return s.replace(/"(?:[^"\\]|\\.)*"/g, (str) =>
    str
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, ''),
  )
}

/**
 * Parse structured LLM output without ever treating a partial response as
 * complete. JSON mode can still arrive wrapped in a fence or with a harmless
 * trailing comma, so accept only those presentation defects and leave every
 * truncated or otherwise malformed response for the caller's completion audit.
 */
export function parseStructuredJson(raw: string): unknown {
  const text = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const objectStart = text.indexOf('{')
  const arrayStart = text.indexOf('[')
  const starts = [objectStart, arrayStart].filter(index => index >= 0)
  if (!starts.length) throw new Error('LLM returned no JSON value')
  const start = Math.min(...starts)
  const end = text[start] === '{' ? text.lastIndexOf('}') : text.lastIndexOf(']')
  if (end < start) throw new Error('LLM returned incomplete JSON')
  const candidate = sanitizeJsonControlChars(text.slice(start, end + 1))
  try {
    return JSON.parse(candidate)
  } catch (firstError) {
    // Never invent data or close an incomplete structure. This only repairs
    // the common `{"key": "value",}` / `["value",]` model formatting slip.
    const repaired = candidate.replace(/,\s*([}\]])/g, '$1')
    if (repaired === candidate) throw firstError
    return JSON.parse(repaired)
  }
}

/**
 * callAi with bounded retries for LOCAL Chat Studio inference only. Cloud and
 * cloud-proxied models are one-shot because another completion may consume
 * quota or create a duplicate billable request. Non-connection errors are
 * always re-thrown immediately.
 */
export async function callAiWithRetry(
  model: string,
  system: string,
  userMsg: string,
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string },
  stream = false,
  ctx: CallAiContext = {},
  maxAttempts = 3,
): Promise<string> {
  const effectiveMaxAttempts = 1
  let lastErr: unknown
  for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
    if (ctx.signal?.aborted) throw new Error('Aborted')
    try {
      return await callAi(model, system, userMsg, apiKeys, stream, ctx)
    } catch (e: any) {
      if (!CONNECTION_ERROR_RE.test(e?.message ?? '')) throw e
      lastErr = e
      if (attempt < effectiveMaxAttempts) await new Promise(r => setTimeout(r, attempt * 1000))
    }
  }
  throw lastErr
}

/**
 * Run one Pipeline writing request on the ONE model chosen for this run.
 * There is no fallback across models — a Gateway pool does that itself. The
 * durable checkpoint only lets a restarted job reconnect to its own accepted
 * request instead of submitting (and paying for) it again.
 */
export async function callAiWithModelPolicy(
  policy: AssignedPipelineModelPolicy,
  system: string,
  userMsg: string,
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string },
  stream = false,
  ctx: CallAiContext = {},
): Promise<string> {
  const fingerprint = ctx.pipelinePolicyInputFingerprint || pipelinePolicyInputFingerprint({ system, userMsg, outputBudget: ctx.outputBudget, maxTokens: ctx.maxTokens, outputContract: ctx.outputContract, images: ctx.images })
  const checkpointKey = ctx.pipelinePolicyCheckpointKey || ctx.requestIdentity || 'pipeline-request'
  const apiKey = await getApiKey('genstudio').catch(() => '')
  return executePipelineModelPolicy(policy, async (candidate, recovery, checkpointAccepted, checkpointPrepared) => {
    // Reattachment is a GET by the durable provider key. Do not re-size or
    // re-validate the old request against a catalogue that may have changed
    // after its POST; that would strand a request whose key we already saved.
    if (!recovery?.idempotencyKey) {
      const live = resolveLivePipelineModel(candidate, apiKey ? await listChatModels(apiKey) : [])
      assertPipelineModelRequestCapabilities(live, ctx)
      await ctx.beforeModelAttempt?.(candidate)
    }
    await ctx.onModelSelected?.(candidate)
    const onJobAccepted = async (jobId: string, idempotencyKey: string) => {
      await checkpointAccepted?.(idempotencyKey)
      await ctx.onJobAccepted?.(jobId, idempotencyKey)
    }
    const onRequestPrepared = async (idempotencyKey: string, preview?: GenStudioRequestPreview) => {
      await checkpointPrepared?.(idempotencyKey)
      await ctx.onRequestPrepared?.(idempotencyKey, preview)
    }
    const attemptContext: CallAiContext = recovery?.idempotencyKey
      ? { ...ctx, ...(ctx.allowUncreatedRecovery ? { recoverByIdempotencyKey: false } : { recoverByIdempotencyKey: true }), idempotencyKey: recovery.idempotencyKey, allowedRecoveryKeys: [recovery.idempotencyKey], onJobAccepted, onRequestPrepared }
      : { ...ctx, onJobAccepted, onRequestPrepared }
    return callAiWithRetry(candidate, system, userMsg, apiKeys, stream, attemptContext)
  }, ctx.pipelinePolicyCheckpoint, checkpointKey, fingerprint)
}

/**
 * One attempt on the policy's single model, with a durable checkpoint so a
 * restart reconnects to an accepted request by its saved key. A checkpoint
 * written by an older build may name a different model it had already moved
 * to; that request is reconnected on its own model rather than abandoned.
 */
export async function executePipelineModelPolicy<T>(
  policy: AssignedPipelineModelPolicy,
  attempt: (
    model: string,
    recovery?: { idempotencyKey: string },
    checkpointAccepted?: (idempotencyKey: string) => Promise<void>,
    checkpointPrepared?: (idempotencyKey: string) => Promise<void>,
  ) => Promise<T>,
  checkpoint?: PipelinePolicyCheckpointStore,
  checkpointKey = 'pipeline-request',
  inputFingerprint = '',
): Promise<T> {
  if (checkpoint && !inputFingerprint) {
    throw new Error('Pipeline model policy checkpoint requires an input fingerprint before any request can run.')
  }
  const rawSaved = checkpoint?.read(checkpointKey)
  const saved = rawSaved === undefined || rawSaved === null ? null : readPipelinePolicyAttemptCheckpoint(rawSaved)
  if (rawSaved !== undefined && rawSaved !== null && !saved) {
    throw new Error('Pipeline model policy checkpoint is invalid; nothing was submitted.')
  }
  if (saved && saved.input_fingerprint !== inputFingerprint) {
    throw new Error('Pipeline model policy checkpoint does not match this logical request; nothing was submitted.')
  }
  if (saved?.status === 'failed_terminal') {
    throw new Error(`The previously submitted Pipeline request for "${saved.candidate_model}" reached a terminal failure. Start a new run instead of replaying its failed request key.`)
  }
  // A request that was never accepted or reached a confirmed terminal failure starts fresh;
  // an unresolved request reconnects to its own key.
  const startFresh = !saved || ['failed_unaccepted', 'exhausted', 'waiting'].includes(saved.status)
  const model = startFresh ? policy.assigned_model : saved.candidate_model
  let acceptedIdempotencyKey = startFresh ? undefined : saved?.idempotency_key
  const recovery = acceptedIdempotencyKey ? { idempotencyKey: acceptedIdempotencyKey } : undefined
  const state = (status: PipelinePolicyAttemptCheckpoint['status']): PipelinePolicyAttemptCheckpoint => ({
    input_fingerprint: inputFingerprint,
    candidates: [model],
    candidate_index: 0,
    candidate_model: model,
    status,
    ...(acceptedIdempotencyKey ? { idempotency_key: acceptedIdempotencyKey } : {}),
    updated_at: new Date().toISOString(),
  })
  try {
    await checkpoint?.write(checkpointKey, state('in_flight'))
    const checkpointAccepted = checkpoint
      ? async (idempotencyKey: string) => {
        if (!idempotencyKey.trim()) throw new Error('The Gateway accepted a Pipeline request without an idempotency key.')
        acceptedIdempotencyKey = idempotencyKey
        await checkpoint.write(checkpointKey, state('accepted'))
      }
      : undefined
    const checkpointPrepared = checkpoint
      ? async (idempotencyKey: string) => {
        if (!idempotencyKey.trim()) throw new Error('Gateway prepared a Pipeline request without an idempotency key.')
        acceptedIdempotencyKey = idempotencyKey
        await checkpoint.write(checkpointKey, state('in_flight'))
      }
      : undefined
    const result = await attempt(model, recovery, checkpointAccepted, checkpointPrepared)
    await checkpoint?.write(checkpointKey, state('succeeded'))
    return result
  } catch (error) {
    const confirmedTerminal = error instanceof GenStudioChatTerminalFailureError
      && !error.cancelled
      && !isGenStudioSubmissionUncertain(error)
    if (confirmedTerminal || (!acceptedIdempotencyKey && isSafePipelineModelAdvance(error))) {
      // This key is terminal: a later Retry or quota recheck needs a fresh
      // request instead of replaying its known failure.
      acceptedIdempotencyKey = undefined
      await checkpoint?.write(checkpointKey, state('failed_unaccepted'))
    } else {
      await checkpoint?.write(checkpointKey, state('unknown'))
    }
    throw error
  }
}

/** Validate only the live, published requirements this request actually asks for. */
export function assertPipelineModelRequestCapabilities(candidate: GenStudioChatModel, ctx: Pick<CallAiContext, 'jsonMode' | 'outputContract' | 'maxTokens' | 'outputBudget' | 'images'>): void {
  const outputContract = ctx.outputContract
  const requiresStructuredOutput = ctx.jsonMode === true || (outputContract && outputContract.mode !== 'prose')
  if (requiresStructuredOutput && (!candidate.supports_structured_output || candidate.structured_output_mode === 'none')) {
    throw new GenStudioChatCapabilityUnavailableError(candidate.id, 'it publishes no structured-output support for this request')
  }
  const requestedTokens = ctx.maxTokens ?? resolveOutputTokenBudget(ctx.outputBudget, candidate.max_output_tokens)
  // A product that publishes NO ceiling is usable, and this request carries no
  // ceiling: `null` is the answer, not a smaller number Story Studio chose
  // (owner decision #6, 2026-09-20). Only a NUMBER is validated — it must be a
  // positive integer and must not exceed a ceiling the product actually
  // published. The old check compared against `candidate.max_output_tokens`
  // unconditionally, so `0` (the parser's "not published") made every request
  // look oversized and refused the product outright.
  const publishedCeiling = Number.isInteger(candidate.max_output_tokens) && candidate.max_output_tokens >= 1
    ? candidate.max_output_tokens
    : null
  const malformed = requestedTokens !== null && (!Number.isInteger(requestedTokens) || requestedTokens < 1)
  const overPublished = !malformed && requestedTokens !== null && publishedCeiling !== null
    && requestedTokens > publishedCeiling
  if (malformed || overPublished) {
    throw new GenStudioChatCapabilityUnavailableError(
      candidate.id,
      publishedCeiling === null
        ? `this request needs ${JSON.stringify(requestedTokens)} output tokens, which is not a usable number`
        : `this request needs ${(requestedTokens as number).toLocaleString()} output tokens, above its published ${publishedCeiling.toLocaleString()} limit`,
    )
  }
  if (ctx.images?.length && (!candidate.supports_vision || ctx.images.length > candidate.max_input_images)) {
    throw new GenStudioChatCapabilityUnavailableError(candidate.id, 'it does not publish support for these image inputs')
  }
}

export function isSafePipelineModelAdvance(error: unknown): boolean {
  return error instanceof GenStudioChatProductUnavailableError
    || error instanceof GenStudioChatCapabilityUnavailableError
    || (error instanceof GenStudioChatTerminalFailureError
      && !error.cancelled
      && !isGenStudioSubmissionUncertain(error))
}

/**
 * True when ANY text-generation provider has a usable key — either merged
 * into the project config (per-project openai/kie) or in the app-level
 * secrets store (openai / kie / deepseek / openrouter). Used by route
 * pre-flight guards so a user whose only key is app-level DeepSeek/OpenRouter
 * isn't falsely blocked. (Direct Anthropic was retired; kie.ai covers Claude.)
 */
export async function hasAnyTextProviderKey(_config?: unknown): Promise<boolean> {
  return !!(await getApiKey('genstudio').catch(() => ''))
}
