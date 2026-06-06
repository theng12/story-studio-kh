/**
 * LM Studio (local LLM) text provider — v1.0.280+. Self-registers on import.
 *
 * Talks to a LOCAL OpenAI-compatible chat server the user runs themselves
 * (LM Studio, Ollama OpenAI shim, llama.cpp server, …). Mirrors the local
 * IMAGE (imagestudio) and VOICE (voicestudio) providers: the "apiKey" slot
 * carries the base URL — there's no real secret, the server is on the
 * user's own machine/LAN.
 *
 * Model id convention: `lmstudio:<model-slug>` (e.g. `lmstudio:google/gemma-3-4b-it`).
 * The prefix is how callAi's dispatcher (registry.findTextProviderForModel)
 * routes the id here without colliding with cloud providers — chosen over a
 * `-suffix` precisely because a suffix like `gpt-oss-20b-lmstudio` would still
 * match OpenAI's `startsWith('gpt-')` claim. The prefix is stripped before the
 * slug is sent to the server. These ids are surfaced dynamically by GET /models
 * (which queries the running server's /v1/models) — nothing is hardcoded.
 */

import OpenAI from 'openai'
import { registry } from '../registry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import { lmstudioApiBase, getLmstudioDispatcher } from '../../lib/lmstudio-client.js'
import { runOnPool } from '../../lib/endpoint-pool.js'
import type { TextProvider, TextGenerationRequest } from '../types.js'

export const LMSTUDIO_MODEL_PREFIX = 'lmstudio:'

const lmstudioProvider: TextProvider = {
  meta: {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    // The apiKey slot carries the base URL (same pattern as imagestudio /
    // voicestudio). providerId pins the secrets bucket to 'lmstudio'.
    apiKeyField: 'lmstudio_base_url',
    providerId: 'lmstudio',
  },

  supportsModel(modelId: string): boolean {
    return typeof modelId === 'string' && modelId.startsWith(LMSTUDIO_MODEL_PREFIX)
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    const { model, system, userMessage, apiKey, stream, maxTokens, signal, images } = request

    // v1.0.295 — multi-endpoint dispatch. `apiKey` carries a possibly comma-
    // separated list of base URLs (one per Mac running LM Studio). Single-
    // endpoint setups return dispatcher: null and the call goes straight
    // through with no pool overhead — byte-for-byte identical to v1.0.294.
    const { dispatcher, endpoints } = getLmstudioDispatcher(apiKey)
    const fallbackUrl = endpoints[0] || ''
    if (!fallbackUrl) {
      throw new Error(
        'No LM Studio URL configured. Set your local server URL in ' +
        'Settings → Local Models → LM Studio (e.g. http://localhost:1234), then start the server.',
      )
    }

    const slug = model.startsWith(LMSTUDIO_MODEL_PREFIX)
      ? model.slice(LMSTUDIO_MODEL_PREFIX.length)
      : model
    if (!slug) throw new Error(`Invalid LM Studio model id: ${model}`)

    const reqOpts = signal ? { signal } : undefined
    // v1.0.283 — multimodal content. Vision-capable local models (Llava,
    // Qwen-VL, Llama-3.2-Vision, etc.) consume the same OpenAI-format
    // image_url content-array as cloud GPT-4o. Text-only local models will
    // return an error from the server, which surfaces cleanly. The Co-writer
    // UI soft-warns for local models when images are attached, since we
    // can't know capability from the model slug alone.
    const userContent: any = images && images.length > 0
      ? [
        { type: 'text', text: userMessage },
        ...images.map((dataUrl: string) => ({ type: 'image_url', image_url: { url: dataUrl } })),
      ]
      : userMessage
    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: userContent },
    ]

    // The runOnPool wrapper picks least-busy, retries on connection error
    // against the next endpoint, and rethrows content errors immediately.
    // For single-endpoint setups (dispatcher === null) it's a pass-through.
    return runOnPool(dispatcher, fallbackUrl, async (endpointUrl) => {
      const baseUrl = lmstudioApiBase(endpointUrl)
      // LM Studio ignores the Authorization header, but the OpenAI SDK requires
      // a non-empty apiKey — pass a placeholder.
      const client = new OpenAI({ apiKey: 'lm-studio', baseURL: baseUrl })
      try {
        if (stream) {
          const collected: string[] = []
          const response = await client.chat.completions.create({
            model: slug,
            max_tokens: maxTokens || 16000,
            messages,
            stream: true,
          }, reqOpts)
          for await (const chunk of response) {
            const delta = chunk.choices[0]?.delta?.content
            if (delta) collected.push(delta)
          }
          return collected.join('')
        }
        const response = await client.chat.completions.create({
          model: slug,
          max_tokens: maxTokens || 8000,
          messages,
        }, reqOpts)
        return response.choices[0]?.message?.content || ''
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          throw new Error('Cancelled by user', { cause: err })
        }
        const msg = redactSecrets(err instanceof Error ? err.message : String(err), apiKey)
        // Connection-refused / fetch-failed → that specific endpoint is down.
        // Let runOnPool's isConnectionError matcher detect it via the wrapped
        // message and fail over to the next endpoint. (We rethrow with the
        // same regex-matchable phrasing so the matcher can do its job.)
        if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|network|Connection error|socket hang up|timed?\s*out|timeout/i.test(msg)) {
          throw new Error(
            `Can't reach LM Studio at ${endpointUrl}: ${msg}. Connection error — failing over if other endpoints are configured.`,
            { cause: err },
          )
        }
        if (/404|not found|No models loaded|model_not_found/i.test(msg)) {
          // Content error — model isn't loaded on THIS endpoint. With multi-
          // endpoint setups the user said they keep the same models loaded
          // everywhere, so this is a real failure: don't waste the pool, just
          // throw. (If the user later wants per-endpoint model maps, this is
          // where to add a "try next endpoint with same model" branch.)
          throw new Error(
            `LM Studio at ${endpointUrl} has no model "${slug}" loaded. Load it on every endpoint ` +
            `in your pool (or pick another model from the dropdown), then retry.`,
            { cause: err },
          )
        }
        throw new Error(`LM Studio error at ${endpointUrl}: ${msg}`, { cause: err })
      }
    })
  },
}

// Self-register
registry.registerText(lmstudioProvider)
