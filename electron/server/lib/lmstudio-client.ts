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

import { parseEndpoints, createDispatcher, type Dispatcher } from './endpoint-pool.js'

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

/**
 * v1.0.304 — list models across the WHOLE endpoint pool, not just the first.
 * The model picker used to probe only `lmstudioFirst()` (endpoints[0]); if that
 * one Mac was asleep, every LM Studio model vanished from the dropdown even
 * though the other 13 endpoints were up ("all the models froze"). This probes
 * every endpoint concurrently (best-effort, short timeout — a dead one
 * contributes nothing and never blocks) and returns the UNION of loaded model
 * ids, first endpoint's order preserved.
 */
export async function listModelsPooled(
  stored: string | null | undefined,
  timeoutMs = 2500,
): Promise<string[]> {
  const eps = parseEndpoints(stored)
  if (eps.length === 0) return []
  if (eps.length === 1) return listModels(eps[0]!, timeoutMs)
  const lists = await Promise.all(eps.map(u => listModels(u, timeoutMs).catch(() => [])))
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const id of list) {
      if (!seen.has(id)) { seen.add(id); out.push(id) }
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// Multi-endpoint dispatcher (v1.0.295).
//
// Mirrors the pool pattern from Image Studio / Voice Studio: same module
// owns the Dispatcher lifecycle so the text provider doesn't have to.
// The cache is MODULE-SCOPED, not job-scoped, because LM Studio calls
// happen across many independent code paths (cowriter sessions, idea
// generation, two-pass scene planner) and we want least-busy tracking to
// span all of them — if cowriter has a long stream in flight on m1 and
// the user kicks off scene-plan Pass 2, those parallel calls should
// notice and prefer m4.
//
// Down-state is sticky (a marked-down endpoint stays out of rotation)
// because re-probing a known-bad endpoint on every call is wasteful and
// the connection error gives an honest failover-immediately signal. The
// trade-off is that an endpoint that came back UP after a transient
// outage stays excluded until the cache is reset. The remedy is to call
// `resetLmstudioDispatcher` at the start of a fresh long-running
// workload (scene plan run, batch idea gen) so each one gets a clean
// view of which endpoints are alive.
// ─────────────────────────────────────────────────────────────────────────

const dispatcherCache = new Map<string, Dispatcher>()

/** Canonical key for the cache so trailing-slash / spacing variations
 *  collapse to the same dispatcher. Sorting also makes ["a","b"] and
 *  ["b","a"] share state — order in the stored setting is irrelevant. */
function endpointsKey(eps: string[]): string {
  return [...eps].sort().join(',')
}

/**
 * Return the cached Dispatcher for this LM Studio endpoint list, plus the
 * normalized endpoint list. Returns `dispatcher: null` for the single-
 * endpoint case so the provider's fast path stays identical to v1.0.294
 * (no pool overhead when there's nothing to dispatch).
 */
export function getLmstudioDispatcher(
  stored: string | null | undefined,
): { dispatcher: Dispatcher | null; endpoints: string[] } {
  const eps = parseEndpoints(stored)
  if (eps.length <= 1) return { dispatcher: null, endpoints: eps }
  const key = endpointsKey(eps)
  let d = dispatcherCache.get(key)
  if (!d) {
    d = createDispatcher(eps)
    dispatcherCache.set(key, d)
  }
  return { dispatcher: d, endpoints: eps }
}

/**
 * Drop the cached dispatcher for this endpoint list so any "marked down"
 * state from prior runs is cleared. Call this at the START of a fresh
 * long-running workload — scene plan Pass 2, batch idea generation — so
 * endpoints that have come back up since the last connection error get
 * a fair retry. Safe to call when no dispatcher exists (no-op).
 */
export function resetLmstudioDispatcher(stored: string | null | undefined): void {
  const eps = parseEndpoints(stored)
  if (eps.length === 0) return
  dispatcherCache.delete(endpointsKey(eps))
}
