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
  hasFullyReleasedZeroSettlement,
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
  onRequestPrepared?: (idempotencyKey: string) => void | Promise<void>
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
    throw new Error(`GenStudio text provider is unavailable for ${model}. No legacy provider fallback was attempted.`)
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
    jsonMode: ctx.jsonMode,
    outputContract: ctx.outputContract,
    disableReasoning: ctx.disableReasoning,
    temperature: ctx.temperature,
    // The request body is already part of the GenStudio idempotency digest.
    // Keep the fallback stable across Story job retries instead of including
    // the transient local queue id.
    requestIdentity: ctx.requestIdentity || ctx.slug || undefined,
    recoverByIdempotencyKey: ctx.recoverByIdempotencyKey === true,
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
 * Execute an explicit Pipeline language-product policy. A distribute policy
 * uses its durable per-episode assignment; a backup policy advances only
 * after GenStudio proves the assigned request was never charged, or after a
 * pre-submit product-unavailable refusal. Network, timeout, refusal and
 * accepted/unknown outcomes remain on the original candidate so retries can
 * reconnect to the same request identity.
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
  return executePipelineModelPolicy(policy, async (candidate, recovery, checkpointAccepted, checkpointPrepared) => {
    // Reattachment is a GET by the durable provider key. Do not re-size or
    // re-validate the old request against a catalogue that may have changed
    // after its POST; that would strand a request whose key we already saved.
    if (!recovery?.idempotencyKey) {
      const apiKey = await getApiKey('genstudio').catch(() => '')
      const live = apiKey ? (await listChatModels(apiKey)).find(model => model.id === candidate) : null
      if (!live || !live.available) throw new GenStudioChatProductUnavailableError(candidate)
      assertPipelineModelRequestCapabilities(live, ctx)
      await ctx.beforeModelAttempt?.(candidate)
    }
    await ctx.onModelSelected?.(candidate)
    const onJobAccepted = async (jobId: string, idempotencyKey: string) => {
      await checkpointAccepted?.(idempotencyKey)
      await ctx.onJobAccepted?.(jobId, idempotencyKey)
    }
    const onRequestPrepared = async (idempotencyKey: string) => {
      await checkpointPrepared?.(idempotencyKey)
      await ctx.onRequestPrepared?.(idempotencyKey)
    }
    const attemptContext: CallAiContext = recovery?.idempotencyKey
      ? { ...ctx, ...(ctx.allowUncreatedRecovery ? { recoverByIdempotencyKey: false } : { recoverByIdempotencyKey: true }), idempotencyKey: recovery.idempotencyKey, allowedRecoveryKeys: [recovery.idempotencyKey], onJobAccepted, onRequestPrepared }
      : { ...ctx, onJobAccepted, onRequestPrepared }
    return callAiWithRetry(candidate, system, userMsg, apiKeys, stream, attemptContext)
  }, ctx.pipelinePolicyCheckpoint, checkpointKey, fingerprint)
}

/** Shared bounded candidate loop for adapters that call GenStudio directly. */
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
  const assigned = policy.assigned_model
  const candidates = policy.mode === 'backup'
    ? [assigned, ...policy.models.filter(model => model !== assigned)]
    : [assigned]
  if (policy.mode === 'backup' && !checkpoint) {
    throw new Error('Pipeline backup policy requires durable checkpoint storage before any candidate can run.')
  }
  if (checkpoint && !inputFingerprint) {
    throw new Error('Pipeline model policy checkpoint requires an input fingerprint before any candidate can run.')
  }
  const rawSaved = checkpoint?.read(checkpointKey)
  const saved = rawSaved === undefined || rawSaved === null ? null : readPipelinePolicyAttemptCheckpoint(rawSaved)
  if (rawSaved !== undefined && rawSaved !== null && !saved) {
    throw new Error('Pipeline model policy checkpoint is invalid; no candidate was submitted.')
  }
  const compatible = saved && saved.input_fingerprint === inputFingerprint
    && saved.candidates.length === candidates.length
    && saved.candidates.every((candidate, index) => candidate === candidates[index])
    && saved.candidates[saved.candidate_index] === saved.candidate_model
  if (saved && !compatible) {
    throw new Error('Pipeline model policy checkpoint does not match this logical request; no candidate was submitted.')
  }
  if (saved?.status === 'exhausted') {
    throw new Error('Every selected Pipeline backup was proved unaccepted; choose a new run before retrying.')
  }
  const startIndex = compatible && saved
    ? (saved.status === 'failed_unaccepted' ? saved.candidate_index + 1 : saved.candidate_index)
    : 0
  if (startIndex >= candidates.length) {
    const exhausted = saved!
    await checkpoint?.write(checkpointKey, { ...exhausted, status: 'exhausted', updated_at: new Date().toISOString() })
    throw new Error('Every selected Pipeline backup was proved unaccepted; choose a new run before retrying.')
  }
  let lastError: unknown
  for (let candidateIndex = Math.max(0, startIndex); candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex]!
    const previous = compatible && saved && saved.candidate_index === candidateIndex ? saved : null
    let acceptedIdempotencyKey = previous?.idempotency_key
    const checkpointState = (status: PipelinePolicyAttemptCheckpoint['status'], idempotencyKey?: string): PipelinePolicyAttemptCheckpoint => ({
      input_fingerprint: inputFingerprint,
      candidates: [...candidates],
      candidate_index: candidateIndex,
      candidate_model: candidate,
      status,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : acceptedIdempotencyKey ? { idempotency_key: acceptedIdempotencyKey } : {}),
      updated_at: new Date().toISOString(),
    })
    try {
      await checkpoint?.write(checkpointKey, checkpointState('in_flight'))
      const checkpointAccepted = checkpoint
        ? async (idempotencyKey: string) => {
          if (!idempotencyKey.trim()) throw new Error('GenStudio accepted a Pipeline request without an idempotency key.')
          acceptedIdempotencyKey = idempotencyKey
          await checkpoint.write(checkpointKey, checkpointState('accepted', idempotencyKey))
        }
        : undefined
      const checkpointPrepared = checkpoint
        ? async (idempotencyKey: string) => {
          if (!idempotencyKey.trim()) throw new Error('GenStudio prepared a Pipeline request without an idempotency key.')
          acceptedIdempotencyKey = idempotencyKey
          await checkpoint.write(checkpointKey, checkpointState('in_flight', idempotencyKey))
        }
        : undefined
      return await attempt(
        candidate,
        previous?.idempotency_key ? { idempotencyKey: previous.idempotency_key } : undefined,
        checkpointAccepted,
        checkpointPrepared,
      ).then(async result => {
        await checkpoint?.write(checkpointKey, checkpointState('succeeded'))
        return result
      })
    } catch (error) {
      lastError = error
      const provenUnchargedTerminal = error instanceof GenStudioChatTerminalFailureError
        && !error.cancelled
        && !isGenStudioSubmissionUncertain(error)
        && hasFullyReleasedZeroSettlement(error)
      // A catalog refusal is only a pre-submit proof when this candidate has
      // never been accepted. A durable terminal settlement can prove that an
      // accepted request released its entire reservation, so it may advance.
      if (!provenUnchargedTerminal && (acceptedIdempotencyKey || !isSafePipelineModelAdvance(error))) {
        await checkpoint?.write(checkpointKey, checkpointState('unknown'))
        throw error
      }
      await checkpoint?.write(checkpointKey, checkpointState('failed_unaccepted'))
      if (candidateIndex === candidates.length - 1) {
        await checkpoint?.write(checkpointKey, checkpointState('exhausted'))
        throw error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Pipeline model policy exhausted without a result')
}

/** Validate only the live, published requirements this request actually asks for. */
export function assertPipelineModelRequestCapabilities(candidate: GenStudioChatModel, ctx: Pick<CallAiContext, 'jsonMode' | 'outputContract' | 'maxTokens' | 'outputBudget' | 'images'>): void {
  const outputContract = ctx.outputContract
  const requiresStructuredOutput = ctx.jsonMode === true || (outputContract && outputContract.mode !== 'prose')
  if (requiresStructuredOutput && (!candidate.supports_structured_output || candidate.structured_output_mode === 'none')) {
    throw new GenStudioChatCapabilityUnavailableError(candidate.id, 'it publishes no structured-output support for this request')
  }
  const requestedTokens = ctx.maxTokens ?? resolveOutputTokenBudget(ctx.outputBudget, candidate.max_output_tokens)
  if (!Number.isInteger(requestedTokens) || requestedTokens < 1 || requestedTokens > candidate.max_output_tokens) {
    throw new GenStudioChatCapabilityUnavailableError(candidate.id, `this request needs ${requestedTokens.toLocaleString()} output tokens, above its published ${candidate.max_output_tokens.toLocaleString()} limit`)
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
      && !isGenStudioSubmissionUncertain(error)
      && hasFullyReleasedZeroSettlement(error))
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
