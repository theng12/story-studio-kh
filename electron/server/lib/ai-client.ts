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
  /** Receives provider finish reason and token usage without changing callAi's return type. */
  onDiagnostics?: (diagnostics: TextGenerationDiagnostics) => void
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
    onDiagnostics: ctx.onDiagnostics,
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
 * True when ANY text-generation provider has a usable key — either merged
 * into the project config (per-project openai/kie) or in the app-level
 * secrets store (openai / kie / deepseek / openrouter). Used by route
 * pre-flight guards so a user whose only key is app-level DeepSeek/OpenRouter
 * isn't falsely blocked. (Direct Anthropic was retired; kie.ai covers Claude.)
 */
export async function hasAnyTextProviderKey(_config?: unknown): Promise<boolean> {
  return !!(await getApiKey('genstudio').catch(() => ''))
}
