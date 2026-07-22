/**
 * Unified AI client — dispatches to registered text providers via the provider registry.
 *
 * Two call shapes are supported:
 *
 *   1. Legacy: `callAi(model, system, user, apiKeys, stream?)` — the
 *      `apiKeys` bag is a `{anthropic_api_key, openai_api_key, kie_api_key}`
 *      object pre-populated by the caller (usually `aiCreds(config)`).
 *      Compat shim from Delivery 1 keeps those fields pointing at the
 *      default account for each provider.
 *
 *   2. Account-aware: the caller passes a `ctx` with a project `slug` and
 *      optional `jobId`. The client resolves the API key through the
 *      provider registry's account resolver, emitting the `[accounts]`
 *      log line that Delivery 3's end-to-end test reads. Falls back to
 *      the `apiKeys` bag if the secrets store has no account (e.g. in
 *      unit tests without a real project on disk).
 */

import { registry } from '../providers/registry.js'
import { getApiKey } from '../services/app-secrets-store.js'
import type { TextGenerationDiagnostics } from '../providers/types.js'
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
  /** Override the provider's default output-token cap. Used by callers that
   *  emit large structured output (e.g. the scene planner's full-episode
   *  JSON) which would otherwise truncate at the conservative default. */
  maxTokens?: number
  /** Ask supporting providers to guarantee a valid JSON object response. */
  jsonMode?: boolean
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
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string },
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

  // Resolve the API key in three tiers, most-specific first:
  //   1. account-aware path (when the caller passed a real slug) — also
  //      emits the [accounts] log line naming the exact account.
  //   2. legacy apiKeys bag passed by the caller — but this bag only ever
  //      carries {anthropic, openai, kie}, so it CANNOT hold a fal / google
  //      / future-provider key. Any time tier 1 misses (slug-race sentinel,
  //      account-store hiccup, slug-less job), relying on it alone would
  //      fail for those providers.
  //   3. v1.0.177 — read the app-level key store DIRECTLY for whichever
  //      provider this model resolved to. App keys are per-machine + global,
  //      so this works without a slug and covers every registered provider.
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
    jsonMode: ctx.jsonMode,
    disableReasoning: ctx.disableReasoning,
    temperature: ctx.temperature,
    requestIdentity: ctx.requestIdentity || [ctx.slug, ctx.jobId].filter(Boolean).join(':') || undefined,
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
export async function hasAnyTextProviderKey(
  _config?: { openai_api_key?: string; kie_api_key?: string } | null,
): Promise<boolean> {
  return !!(await getApiKey('genstudio').catch(() => ''))
}
