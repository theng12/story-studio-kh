/**
 * LM Studio (local LLM) client — v1.0.280+.
 *
 * Sibling of imagestudio-client / voicestudio-client: talks to a LOCAL
 * OpenAI-compatible LLM server the user runs on their own machine
 * (LM Studio, Ollama's OpenAI shim, llama.cpp server, etc.). The "apiKey"
 * slot in app-secrets carries the base URL — there's no real secret; the
 * server is on the user's LAN / loopback. Reusing the secrets store gives
 * us the same per-machine, user-controlled URL semantics as the two modal
 * wrappers.
 *
 * LM Studio exposes the standard OpenAI surface:
 *   GET  {base}/v1/models              — list loaded models
 *   POST {base}/v1/chat/completions    — chat (used by providers/text/lmstudio)
 *
 * This module owns the lightweight GET probes (health + model listing).
 * The chat call itself lives in the provider, which drives it through the
 * OpenAI SDK pointed at {base}/v1.
 */

import { parseEndpoints } from './endpoint-pool.js'

/** No universal default — it's the user's own machine. Empty = unconfigured. */
export const DEFAULT_LMSTUDIO_BASE_URL = ''

/** First endpoint of a (possibly comma/space-separated) stored URL list. */
export function lmstudioFirst(stored: string | null | undefined): string {
  return parseEndpoints(stored)[0] || ''
}

/**
 * Normalise a stored/typed base URL to the API root that ends in `/v1`.
 * Accepts `http://host:1234`, `http://host:1234/`, or `http://host:1234/v1`
 * and always returns `http://host:1234/v1` (no trailing slash). The chat
 * provider appends nothing further; the OpenAI SDK's `baseURL` is set to it.
 */
export function lmstudioApiBase(url: string): string {
  let u = (url || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (/\/v1$/i.test(u)) return u
  return `${u}/v1`
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
  } finally {
    clearTimeout(timer)
  }
}

export interface LmStudioHealth {
  ok: boolean
  modelCount?: number
  models?: string[]
  error?: string
}

/**
 * Reachability + loaded-model probe in one GET. Short timeout so the
 * Settings "Test" round-trip and the /models catalog call never hang when
 * the server is off.
 */
export async function health(baseUrl: string, timeoutMs = 2500): Promise<LmStudioHealth> {
  const base = lmstudioApiBase(baseUrl)
  if (!base) return { ok: false, error: 'No LM Studio URL set.' }
  try {
    const res = await fetchWithTimeout(`${base}/models`, timeoutMs)
    if (!res.ok) {
      return { ok: false, error: `LM Studio responded ${res.status} ${res.statusText}` }
    }
    const json: any = await res.json().catch(() => null)
    const models = extractModelIds(json)
    return { ok: true, modelCount: models.length, models }
  } catch (e: any) {
    const msg = e?.name === 'AbortError'
      ? 'Timed out reaching LM Studio. Is the local server started?'
      : (e?.message || String(e))
    return { ok: false, error: msg }
  }
}

/** Parse the OpenAI `{ data: [{ id }] }` model list into a string[] of ids. */
function extractModelIds(json: any): string[] {
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  const ids: string[] = []
  for (const m of data) {
    const id = typeof m?.id === 'string' ? m.id : (typeof m === 'string' ? m : '')
    if (id) ids.push(id)
  }
  return ids
}

/**
 * List the model ids the LM Studio server currently has loaded/available.
 * Returns [] on any failure (server off, parse error) — callers treat an
 * empty list as "nothing to surface" rather than an error.
 */
export async function listModels(baseUrl: string, timeoutMs = 2500): Promise<string[]> {
  const h = await health(baseUrl, timeoutMs)
  return h.ok && h.models ? h.models : []
}
