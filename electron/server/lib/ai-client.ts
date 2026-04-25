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

  const result = await provider.callText({
    model,
    system,
    userMessage: userMsg,
    apiKey,
    stream,
    signal: ctx.signal,
  })

  // Track usage
  trackFromText(model, system + userMsg, result)

  return result
}
