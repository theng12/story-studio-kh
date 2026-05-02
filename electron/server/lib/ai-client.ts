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

import { registry, resolveApiKeyForProvider } from '../providers/registry.js'
import { SUPPORTED_MODELS } from '../models/types.js'
import { trackFromText } from '../services/usage-tracker.js'

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
}

export async function callAi(
  model: string,
  system: string,
  userMsg: string,
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string },
  stream = false,
  ctx: CallAiContext = {},
): Promise<string> {
  // Find which provider handles this model
  const provider = registry.findTextProviderForModel(model)
  if (!provider) {
    // Fallback: check SUPPORTED_MODELS for backward compat
    const providerName = SUPPORTED_MODELS[model]
    if (!providerName) throw new Error(`Unsupported model: ${model}`)
    throw new Error(`No text provider registered for: ${providerName} (model: ${model})`)
  }

  // Resolve the API key — prefer the account-aware path when the caller
  // provided a slug, so the [accounts] log line names the exact account.
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
  })

  // Track usage
  trackFromText(model, effectiveSystem + userMsg, result)

  return result
}
