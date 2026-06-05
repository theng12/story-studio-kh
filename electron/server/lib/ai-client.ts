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

import { registry, resolveApiKeyForProvider, providerIdForMeta } from '../providers/registry.js'
import { SUPPORTED_MODELS, LEGACY_MODEL_ALIASES } from '../models/types.js'
import { trackFromText } from '../services/usage-tracker.js'
import { getApiKey } from '../services/app-secrets-store.js'

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
  /**
   * v1.0.283 — optional image attachments for vision-capable models. Each
   * entry is a base64 data URL. Forwarded to the provider's `callText`
   * (which repackages into the SDK's multimodal content-array). Only
   * meaningful for OpenAI's gpt-4o family + LM Studio when a vision model
   * is loaded; non-vision providers silently ignore. Used by the Co-writer
   * (frontend gates the model picker to vision-capable models when images
   * are attached, so we never reach a non-vision provider with images set).
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

  // Normalise retired ids (direct Anthropic / kie DeepSeek) to their current
  // equivalents so projects/jobs with a stale persisted model keep working.
  // One choke point covers both UI and headless/pipeline callers.
  model = LEGACY_MODEL_ALIASES[model] ?? model

  // Find which provider handles this model
  const provider = registry.findTextProviderForModel(model)
  if (!provider) {
    // Fallback: check SUPPORTED_MODELS for backward compat
    const providerName = SUPPORTED_MODELS[model]
    if (!providerName) throw new Error(`Unsupported model: ${model}`)
    throw new Error(`No text provider registered for: ${providerName} (model: ${model})`)
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
  let apiKey = ''
  if (ctx.slug) {
    apiKey = await resolveApiKeyForProvider(ctx.slug, provider.meta, {
      model,
      jobId: ctx.jobId,
      accountId: ctx.accountId,
    })
  }
  if (!apiKey) {
    const keyField = provider.meta.apiKeyField as keyof typeof apiKeys
    apiKey = apiKeys[keyField] || ''
  }
  if (!apiKey) {
    // Final fallback: the app-level secrets store, keyed by the provider's
    // canonical id (kie / fal / google / …). Never throws — returns
    // '' when unset, so the provider's own "no key" error still fires.
    try {
      apiKey = await getApiKey(providerIdForMeta(provider.meta)) || ''
    } catch { /* fall through to provider's own no-key error */ }
  }

  // Brand persona injection: when the caller didn't provide a system
  // prompt and we have a slug, prepend the project's brand persona (if
  // any). Call sites that build their own system prompt (e.g. the
  // episode generator's systemPrompt(format, standards, brand)) are
  // expected to inject the persona themselves and pass a non-empty
  // system here, so this only kicks in for the metadata / ideas / one-shot
  // route paths that historically passed `''`.
  let effectiveSystem = system
  if ((!system || !system.trim()) && ctx.slug) {
    try {
      const { getBrandForSlug } = await import('./brand-prompt.js')
      const brand = await getBrandForSlug(ctx.slug)
      if (brand?.narration?.persona?.trim()) {
        effectiveSystem = brand.narration.persona.trim()
      }
    } catch { /* brand layer must never break a generation */ }
  }

  const result = await provider.callText({
    model,
    system: effectiveSystem,
    userMessage: userMsg,
    apiKey,
    stream,
    signal: ctx.signal,
    maxTokens: ctx.maxTokens,
    images: ctx.images,
  })

  // Track usage
  trackFromText(model, effectiveSystem + userMsg, result)

  return result
}

/**
 * True when ANY text-generation provider has a usable key — either merged
 * into the project config (per-project openai/kie) or in the app-level
 * secrets store (openai / kie / deepseek / openrouter). Used by route
 * pre-flight guards so a user whose only key is app-level DeepSeek/OpenRouter
 * isn't falsely blocked. (Direct Anthropic was retired; kie.ai covers Claude.)
 */
export async function hasAnyTextProviderKey(
  config?: { openai_api_key?: string; kie_api_key?: string } | null,
): Promise<boolean> {
  if (config?.openai_api_key || config?.kie_api_key) return true
  const { getApiKey } = await import('../services/app-secrets-store.js')
  for (const p of ['openai', 'kie', 'deepseek', 'openrouter']) {
    if (await getApiKey(p).catch(() => '')) return true
  }
  return false
}
