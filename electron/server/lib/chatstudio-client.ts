/**
 * Chat Studio (local MLX LLM) client — replaces the former LM Studio client.
 *
 * Sibling of imagestudio-client / voicestudio-client: talks to the LOCAL
 * Chat Studio server (an Apple-Silicon MLX OpenAI-compatible LLM server,
 * default port 47871) the user runs on their own machine — part of the same
 * Studio family as Image/Voice/Music Studio, and self-healing (launchd
 * KeepAlive + a health watchdog) so it recovers from crashes/hangs on its
 * own. The "apiKey" slot in app-secrets carries the base URL — there's no
 * real secret; the server is on the user's LAN / loopback.
 *
 * Chat Studio exposes the standard OpenAI surface (plus a native /api/*):
 *   GET  {base}/v1/models              — list cached/loadable models
 *   POST {base}/v1/chat/completions    — chat (used by providers/text/chatstudio)
 *                                        auto-loads the requested model on demand
 *
 * This module owns the lightweight GET probes (health + model listing).
 * The chat call itself lives in the provider, which drives it through the
 * OpenAI SDK pointed at {base}/v1.
 */

import { parseEndpoints, parseEnabledEndpoints, createDispatcher, type Dispatcher } from './endpoint-pool.js'
import { studioFetch } from './studio-auth.js'

/** No universal default — it's the user's own machine. Empty = unconfigured.
 *  (Chat Studio's default port is 47871; the user provides host:port.) */
export const DEFAULT_CHATSTUDIO_BASE_URL = ''

/** First endpoint of a (possibly comma/space-separated) stored URL list. */
export function chatstudioFirst(stored: string | null | undefined): string {
  return parseEndpoints(stored)[0] || ''
}

/**
 * Normalise a stored/typed base URL to the API root that ends in `/v1`.
 * Accepts `http://host:47871`, `http://host:47871/`, or `http://host:47871/v1`
 * and always returns `http://host:47871/v1` (no trailing slash). The chat
 * provider appends nothing further; the OpenAI SDK's `baseURL` is set to it.
 */
export function chatstudioApiBase(url: string): string {
  const u = (url || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (/\/v1$/i.test(u)) return u
  return `${u}/v1`
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await studioFetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
  } finally {
    clearTimeout(timer)
  }
}

export interface ChatStudioHealth {
  ok: boolean
  modelCount?: number
  models?: string[]
  error?: string
}

// ── Short-lived health cache ──────────────────────────────────────────────
// Without this, a single-endpoint setup (dispatcher === null → no pool
// down-state) re-ran the full ~4s pre-flight probe on EVERY generation call
// against an offline Chat Studio, so a batch run "kept trying" and hung for
// seconds per attempt. The cache remembers a just-failed endpoint as offline
// for NEG_TTL and a healthy one for POS_TTL, keyed by the normalized /v1 base.
// Complements the pool's 30s down-state (which only covers multi-endpoint).
const HEALTH_CACHE_NEG_TTL_MS = 12_000
const HEALTH_CACHE_POS_TTL_MS = 5_000
const healthCache = new Map<string, { at: number; result: ChatStudioHealth }>()

/**
 * Cached wrapper around `health()`. Used by the generation pre-flight so
 * repeated attempts against the same (often offline) endpoint short-circuit
 * instead of each paying the probe timeout. The Settings "Test" and the
 * /models catalog stay on the uncached `health()` so a manual test / dropdown
 * refresh always reflects reality.
 */
export async function healthCached(baseUrl: string, timeoutMs = 2500): Promise<ChatStudioHealth> {
  const base = chatstudioApiBase(baseUrl)
  if (!base) return { ok: false, error: 'No Chat Studio URL set.' }
  const now = Date.now()
  const hit = healthCache.get(base)
  if (hit) {
    const ttl = hit.result.ok ? HEALTH_CACHE_POS_TTL_MS : HEALTH_CACHE_NEG_TTL_MS
    if (now - hit.at < ttl) return hit.result
  }
  const result = await health(baseUrl, timeoutMs)
  healthCache.set(base, { at: now, result })
  return result
}

/** Force an endpoint's cached health to "offline" — call when a live request
 *  dies with a connection error so the next pre-flight short-circuits without
 *  re-probing. */
export function markHealthDown(baseUrl: string, error = 'Connection lost.'): void {
  const base = chatstudioApiBase(baseUrl)
  if (!base) return
  healthCache.set(base, { at: Date.now(), result: { ok: false, error } })
}

/** Clear cached health for an endpoint list (or all if omitted) so a fresh
 *  long-running workload re-probes recovered servers immediately. */
export function clearHealthCache(stored?: string | null): void {
  if (stored == null) { healthCache.clear(); return }
  for (const u of parseEndpoints(stored)) healthCache.delete(chatstudioApiBase(u))
}

/**
 * Reachability + available-model probe in one GET. Short timeout so the
 * Settings "Test" round-trip and the /models catalog call never hang when
 * the server is off.
 */
export async function health(baseUrl: string, timeoutMs = 2500): Promise<ChatStudioHealth> {
  const base = chatstudioApiBase(baseUrl)
  if (!base) return { ok: false, error: 'No Chat Studio URL set.' }
  try {
    const res = await fetchWithTimeout(`${base}/models`, timeoutMs)
    if (!res.ok) {
      return { ok: false, error: `Chat Studio responded ${res.status} ${res.statusText}` }
    }
    const json: any = await res.json().catch(() => null)
    const models = extractModelIds(json)
    return { ok: true, modelCount: models.length, models }
  } catch (e: any) {
    const msg = e?.name === 'AbortError'
      ? 'Timed out reaching Chat Studio. Is the local server started?'
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
 * List the model ids the Chat Studio server currently has available (cached).
 * Returns [] on any failure (server off, parse error) — callers treat an
 * empty list as "nothing to surface" rather than an error.
 */
export async function listModels(baseUrl: string, timeoutMs = 2500): Promise<string[]> {
  const h = await health(baseUrl, timeoutMs)
  return h.ok && h.models ? h.models : []
}

/**
 * List models across the WHOLE endpoint pool, not just the first — so a
 * sleeping endpoints[0] doesn't make every Chat Studio model vanish from the
 * dropdown. Probes every enabled endpoint concurrently (best-effort, short
 * timeout) and returns the UNION of model ids, first endpoint's order kept.
 */
export async function listModelsPooled(
  stored: string | null | undefined,
  timeoutMs = 2500,
): Promise<string[]> {
  const eps = parseEnabledEndpoints(stored)
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
// Catalog (v1.0.497) — cloud/local split.
//
// Chat Studio ≥1.15 proxies FREE cloud LLM providers (OpenRouter, NVIDIA NIM,
// Groq, Cerebras, Gemini, HF Router, SambaNova, GitHub Models) and its
// /v1/models now dumps EVERY upstream model (~450 rows) — far too much for a
// dropdown, and indistinguishable from the local MLX models. The native
// /api/providers endpoint carries the CURATED per-provider model list
// (label, free flag, `repo` = the id to send) plus `key_set` (credential
// configured). We surface: all local models + the curated cloud models,
// and skip the raw provider:* dump entirely.
// ─────────────────────────────────────────────────────────────────────────

/** Model-id prefix Chat Studio uses for cloud-proxied models. */
export const CHATSTUDIO_CLOUD_ID_PREFIX = 'provider:'

export interface ChatStudioCatalogEntry {
  /** Raw Chat Studio model id (local repo, or `provider:<key>:<model>`). */
  id: string
  /** Human label ("Llama 3.3 70B Instruct (free)" or the local repo id). */
  label: string
  cloud: boolean
  /** Cloud provider key/name ('openrouter' / 'OpenRouter') — cloud only. */
  provider_key?: string
  provider_name?: string
  free?: boolean
  /** False when the provider's API key isn't configured in Chat Studio yet. */
  key_set?: boolean
}

/** Root API base (no /v1) for Chat Studio's native /api/* endpoints. */
function chatstudioRootBase(url: string): string {
  return chatstudioApiBase(url).replace(/\/v1$/i, '')
}

/**
 * Cloud/local model catalog for ONE endpoint. Locals come from /v1/models
 * (ids without the `provider:` prefix); clouds come from /api/providers'
 * curated lists. Providers without a key still surface (key_set:false) so the
 * picker can show them as "needs key" — same pattern as Image Studio v1.0.477.
 * Old Chat Studio builds without /api/providers → locals only (their
 * /v1/models had no provider:* ids anyway).
 */
export async function listCatalog(baseUrl: string, timeoutMs = 2500): Promise<ChatStudioCatalogEntry[]> {
  const root = chatstudioRootBase(baseUrl)
  if (!root) return []
  const entries: ChatStudioCatalogEntry[] = []

  const h = await health(baseUrl, timeoutMs)
  if (!h.ok) return []
  for (const id of h.models || []) {
    if (id.startsWith(CHATSTUDIO_CLOUD_ID_PREFIX)) continue // curated below
    entries.push({ id, label: id, cloud: false })
  }

  try {
    const res = await fetchWithTimeout(`${root}/api/providers`, timeoutMs)
    if (res.ok) {
      const json: any = await res.json().catch(() => null)
      for (const p of Array.isArray(json?.providers) ? json.providers : []) {
        const keySet = !!p?.key_set
        for (const m of Array.isArray(p?.models) ? p.models : []) {
          const repo = typeof m?.repo === 'string' ? m.repo : ''
          if (!repo) continue
          entries.push({
            id: repo,
            label: typeof m?.label === 'string' && m.label ? m.label : (m?.id || repo),
            cloud: true,
            provider_key: typeof p?.key === 'string' ? p.key : undefined,
            provider_name: typeof p?.name === 'string' ? p.name : undefined,
            free: m?.free !== false,
            key_set: keySet,
          })
        }
      }
    }
  } catch { /* old build / endpoint missing — locals only */ }

  return entries
}

/**
 * Catalog across the WHOLE enabled endpoint pool (union by id, first seen
 * wins) — mirrors listModelsPooled so a sleeping endpoints[0] doesn't hide
 * everything. Cloud entries are endpoint-independent, so the union is cheap.
 */
export async function listCatalogPooled(
  stored: string | null | undefined,
  timeoutMs = 2500,
): Promise<ChatStudioCatalogEntry[]> {
  const eps = parseEnabledEndpoints(stored)
  if (eps.length === 0) return []
  if (eps.length === 1) return listCatalog(eps[0]!, timeoutMs)
  const lists = await Promise.all(eps.map(u => listCatalog(u, timeoutMs).catch(() => [])))
  const seen = new Set<string>()
  const out: ChatStudioCatalogEntry[] = []
  for (const list of lists) {
    for (const e of list) {
      if (!seen.has(e.id)) { seen.add(e.id); out.push(e) }
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// Multi-endpoint dispatcher.
//
// Mirrors the pool pattern from Image Studio / Voice Studio: same module
// owns the Dispatcher lifecycle so the text provider doesn't have to. The
// cache is MODULE-SCOPED so least-busy tracking spans every code path
// (idea generation, prompt generation, and scene planning). Down-state
// is sticky; call `resetChatstudioDispatcher` at the start of a fresh
// long-running workload (scene plan run, batch idea gen) so endpoints that
// recovered get a fair retry.
// ─────────────────────────────────────────────────────────────────────────

const dispatcherCache = new Map<string, Dispatcher>()

/** Canonical key so trailing-slash / spacing / order variations collapse. */
function endpointsKey(eps: string[]): string {
  return [...eps].sort().join(',')
}

/**
 * Return the cached Dispatcher for this Chat Studio endpoint list plus the
 * normalized endpoints. Returns `dispatcher: null` for the single-endpoint
 * case so the provider's fast path has no pool overhead.
 */
export function getChatstudioDispatcher(
  stored: string | null | undefined,
): { dispatcher: Dispatcher | null; endpoints: string[] } {
  const eps = parseEnabledEndpoints(stored)
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
 * state from prior runs is cleared. Call at the START of a fresh long-running
 * workload so recovered endpoints get a fair retry. No-op when none exists.
 */
export function resetChatstudioDispatcher(stored: string | null | undefined): void {
  const eps = parseEnabledEndpoints(stored)
  if (eps.length === 0) return
  dispatcherCache.delete(endpointsKey(eps))
  // Also drop cached health so a recovered server is re-probed at run start
  // rather than staying "offline" from a stale negative-cache entry.
  clearHealthCache(stored)
}
