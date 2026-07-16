/**
 * Chat Studio (local MLX LLM) text provider. Self-registers on import.
 * Replaces the former LM Studio provider.
 *
 * Talks to the LOCAL Chat Studio server (Apple-Silicon MLX, OpenAI-compatible,
 * default port 47871) — part of the Studio family (Image/Voice/Music Studio)
 * and self-healing across crashes/hangs. Mirrors the local IMAGE (imagestudio)
 * and VOICE (voicestudio) providers: the "apiKey" slot carries the base URL —
 * there's no real secret, the server is on the user's own machine/LAN.
 *
 * Model id convention: `chatstudio:<repo>` (e.g. `chatstudio:mlx-community/Llama-3.2-3B-Instruct-4bit`).
 * The prefix is how callAi's dispatcher (registry.findTextProviderForModel)
 * routes the id here without colliding with cloud providers. The prefix is
 * stripped before the repo is sent to the server as the OpenAI `model`. These
 * ids are surfaced dynamically by GET /chatstudio/models (which queries the
 * running server's /v1/models) — nothing is hardcoded. Chat Studio auto-loads
 * the requested model on demand, so no separate load call is needed.
 */

import OpenAI from 'openai'
import { registry } from '../registry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import { chatstudioApiBase, getChatstudioDispatcher, healthCached, markHealthDown } from '../../lib/chatstudio-client.js'
import { runOnPool } from '../../lib/endpoint-pool.js'
import { getHubBackend, hubChatRootBase, hubHeaders } from '../../lib/studiohub-client.js'
import type { TextProvider, TextGenerationRequest } from '../types.js'

export const CHATSTUDIO_MODEL_PREFIX = 'chatstudio:'

// Request resilience. A local Mac that's asleep/offline HANGS the TCP connect
// (~75s OS timeout) instead of refusing it.
//   - PREFLIGHT_PROBE_MS: a short GET /v1/models that tears the connecting
//     socket down in seconds, converting a silent hang into a throwable
//     connection error so runOnPool can fail over (or fail fast) immediately.
//   - REQUEST_TIMEOUT_MS: generous enough for a real long generation batch, but
//     a hard ceiling so a mid-generation death can't stall indefinitely.
const CHATSTUDIO_PREFLIGHT_PROBE_MS = 4000
const CHATSTUDIO_REQUEST_TIMEOUT_MS = 240_000

const chatstudioProvider: TextProvider = {
  meta: {
    id: 'chatstudio',
    name: 'Chat Studio (Local)',
    // The apiKey slot carries the base URL (same pattern as imagestudio /
    // voicestudio). providerId pins the secrets bucket to 'chatstudio'.
    apiKeyField: 'chatstudio_base_url',
    providerId: 'chatstudio',
  },

  supportsModel(modelId: string): boolean {
    return typeof modelId === 'string' && modelId.startsWith(CHATSTUDIO_MODEL_PREFIX)
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    const { model, system, userMessage, apiKey, stream, maxTokens, signal, images } = request

    const slug = model.startsWith(CHATSTUDIO_MODEL_PREFIX)
      ? model.slice(CHATSTUDIO_MODEL_PREFIX.length)
      : model
    if (!slug) throw new Error(`Invalid Chat Studio model id: ${model}`)

    const reqOpts = signal ? { signal } : undefined
    // Multimodal content. Chat Studio currently runs models text-only, so any
    // attached images will be ignored/error server-side; we keep the same
    // OpenAI content-array packing so a future vision-capable build works
    // without a client change.
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

    // Run one completion against a given endpoint list (`stored` = comma/space
    // URL string). Used for BOTH the direct Chat Studio pool AND the Studio Hub
    // chat gateway — identical OpenAI-compatible transport, only the base URL
    // differs (plus an optional X-Hub-Token header for the Hub).
    const runAgainst = (
      stored: string,
      tokenHeader?: Record<string, string>,
      opts?: { skipPreflight?: boolean },
    ): Promise<string> => {
      // Multi-endpoint dispatch. `stored` carries a possibly comma-separated
      // list of base URLs. Single-endpoint setups return dispatcher: null and
      // the call goes straight through with no pool overhead.
      const { dispatcher, endpoints } = getChatstudioDispatcher(stored)
      const fallbackUrl = endpoints[0] || ''
      if (!fallbackUrl) {
        throw new Error(
          'No Chat Studio URL configured. Set your local server URL in ' +
          'Settings → Local Models → Chat Studio (e.g. http://localhost:47871), then start the server.',
        )
      }
      // runOnPool picks least-busy, retries on connection error against the next
      // endpoint, and rethrows content errors immediately. For single-endpoint
      // setups (dispatcher === null) it's a pass-through.
      return runOnPool(dispatcher, fallbackUrl, async (endpointUrl) => {
        if (signal?.aborted) throw new Error('Cancelled by user')
        // Pre-flight reachability probe. A sleeping Mac HANGS the connect; this
        // short-timeout GET fails in ~4s and throws a connection error that
        // runOnPool recognises, so we fail over to a healthy endpoint (or fail
        // fast on a single endpoint) instead of blocking for minutes.
        // healthCached short-circuits when this endpoint failed its probe within
        // the last few seconds, so a batch run against an offline server no longer
        // re-pays the ~4s timeout on every chunk (single-endpoint setups have no
        // pool down-state to lean on).
        //
        // SKIPPED for the Studio Hub gateway: it's a single always-on local
        // process, and its /v1/models probe aggregates chat models across the
        // WHOLE fleet (including offline Macs), so a cold first call can exceed
        // the short probe window and be mis-read as "down". A genuinely dead Hub
        // instead surfaces as a connection error from the completion below.
        if (!opts?.skipPreflight) {
          const probe = await healthCached(endpointUrl, CHATSTUDIO_PREFLIGHT_PROBE_MS)
          if (!probe.ok) {
            throw new Error(
              `Chat Studio at ${endpointUrl} is unreachable: ${probe.error || 'no response'}. ` +
              `Connection error — failing over if other endpoints are configured.`,
            )
          }
        }
        const baseUrl = chatstudioApiBase(endpointUrl)
        // Chat Studio accepts any non-empty key; pass a placeholder. timeout +
        // maxRetries:0 bound the call — runOnPool owns failover. defaultHeaders
        // carries the Hub's X-Hub-Token when routing through the gateway.
        const client = new OpenAI({
          apiKey: 'chat-studio',
          baseURL: baseUrl,
          timeout: CHATSTUDIO_REQUEST_TIMEOUT_MS,
          maxRetries: 0,
          ...(tokenHeader && Object.keys(tokenHeader).length ? { defaultHeaders: tokenHeader } : {}),
        })
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
          // v1.0.497 — Chat Studio (FastAPI) returns errors as {"detail": "..."}
          // rather than OpenAI's {"error": {...}} shape, so the OpenAI SDK reports
          // a useless "502 status code (no body)" and swallows the real diagnostic
          // ("OpenRouter returned HTTP 429: … rate-limited upstream, retry
          // shortly"). The SDK still parses the JSON body onto err.error — pull
          // the detail out and prefer it as the message.
          const apiDetail = typeof err?.error?.detail === 'string' ? err.error.detail.trim() : ''
          const httpStatus = typeof err?.status === 'number' ? err.status : undefined
          const msg = redactSecrets(apiDetail || (err instanceof Error ? err.message : String(err)), stored)
          // Cloud-provider rate limit proxied through Chat Studio. The ENDPOINT is
          // healthy — phrased so endpoint-pool's isConnectionError does NOT match:
          // no failover (other endpoints proxy the same upstream), no mark-down,
          // no health-cache poisoning. The scene planner's retry loop backs off
          // longer when it sees this phrasing.
          if (httpStatus === 429 || /\brate.?limit/i.test(msg)) {
            throw new Error(
              `Chat Studio's cloud provider rate-limited this request: ${msg} ` +
              `— wait a minute and retry, or switch to a different provider/model in the dropdown.`,
              { cause: err },
            )
          }
          // Other upstream cloud-provider failure surfaced by Chat Studio with a
          // real diagnostic (5xx + detail). Same reasoning: the endpoint is up.
          if (apiDetail && httpStatus && httpStatus >= 500) {
            throw new Error(`Chat Studio cloud-provider request failed: ${apiDetail}`, { cause: err })
          }
          // Connection-refused / fetch-failed → that endpoint is down. Rethrow
          // with regex-matchable phrasing so runOnPool's matcher fails over.
          if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|network|Connection error|socket hang up|timed?\s*out|timeout/i.test(msg)) {
            // The endpoint died between the pre-flight probe and this call — cache
            // it offline so the next attempt short-circuits instead of re-probing.
            markHealthDown(endpointUrl, msg)
            throw new Error(
              `Can't reach Chat Studio at ${endpointUrl}: ${msg}. Connection error — failing over if other endpoints are configured.`,
              { cause: err },
            )
          }
          if (/404|409|not found|no models? loaded|model_not_found|not cached|cannot load|failed to load/i.test(msg)) {
            // This endpoint is alive but doesn't have the model cached/loadable
            // (Chat Studio returns 409 from ensure_loaded for an uncached repo).
            // The "has no model … loaded" phrasing is matched by endpoint-pool's
            // isModelNotReadyError so runOnPool marks this endpoint down and
            // tries another in the pool.
            throw new Error(
              `Chat Studio at ${endpointUrl} has no model "${slug}" loaded or cached — failing over ` +
              `to another endpoint in the pool. If every endpoint reports the same, download ` +
              `the model in Chat Studio on at least one Mac (or pick a different model from ` +
              `the dropdown), then retry.`,
              { cause: err },
            )
          }
          throw new Error(`Chat Studio error at ${endpointUrl}: ${msg}`, { cause: err })
        }
      })
    }

    // Studio Hub routing is strict: Hub and Direct are explicit settings, so a
    // Hub outage is reported and never starts duplicate direct work.
    const hub = await getHubBackend()
    if (hub.mode === 'hub') {
      if (!hub.hubUrl) throw new Error('Studio Hub routing is selected, but no Hub URL is configured.')
      return runAgainst(hubChatRootBase(hub.hubUrl), hubHeaders(hub.hubToken), { skipPreflight: true })
    }
    const { cachedStudioFleetToken } = await import('../../lib/studio-auth.js')
    const studioToken = await cachedStudioFleetToken()
    return runAgainst(apiKey, studioToken ? { 'X-Studio-Token': studioToken } : undefined)
  },
}

// Self-register
registry.registerText(chatstudioProvider)
