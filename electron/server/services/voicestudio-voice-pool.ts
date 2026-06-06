/**
 * Voice Studio voice-library pool resolver (v1.0.293).
 *
 * Problem this solves
 * ===================
 * Each Voice Studio instance maintains its OWN voice library, stored in the
 * Pinokio app's data directory on that Mac. When the user uploads a clone
 * reference like "Vincent" on m1, the Voice Studio backend assigns it a
 * locally-unique UUID (e.g. `7626576fe87f`). The same reference uploaded on
 * m4 gets a DIFFERENT UUID even though the audio is identical.
 *
 * Story Studio's audio dispatcher (v1.0.255+) routes TTS chunks across the
 * configured endpoint pool for parallelism. But the form stored a single
 * UUID (the one from the endpoint the picker happened to be querying), so
 * chunks dispatched to a different endpoint failed:
 *
 *     ValueError: Voice 7626576fe87f not found in library
 *
 * The Voice Studio API is **read-only** for voices — no POST /api/voices,
 * no upload, no sync. We can't make the libraries identical from this side.
 * But every voice has a user-controlled `name` field, and if the user
 * uploads the same reference clip under the same name on each Mac, we can
 * use NAME as the cross-endpoint key and resolve to the local UUID at TTS-
 * call time.
 *
 * This module:
 *   - Queries `/api/voices` on every configured endpoint
 *   - Aggregates results into a per-name map of {endpointUrl: voiceUuid}
 *   - Surfaces an `availableOn` list per voice so the picker can show
 *     availability badges and the dispatcher can pin or skip endpoints
 *   - Caches the result with a 60s TTL keyed on the endpoint-list string,
 *     so the rapid-fire calls during a single audio job don't probe
 *     every endpoint per chunk
 *
 * Caveats
 * =======
 * - Two endpoints with a voice of the same NAME but DIFFERENT audio (e.g.
 *   the user re-uploaded a different clip with the same name) → they'll
 *   be treated as one voice. Output may sound subtly inconsistent across
 *   chunks. We surface duration_seconds in the aggregate so a future UI
 *   could warn on mismatch; not enforced today.
 * - Endpoint health is NOT checked here — that's the dispatcher's concern.
 *   This module just reports what each endpoint THINKS it has. An
 *   unreachable endpoint's voices are silently dropped.
 */

import { parseEndpoints } from '../lib/endpoint-pool.js'
import { listVoices, type VoiceStudioLibraryVoice } from '../lib/voicestudio-client.js'

export interface PooledVoice {
  /** The user-given voice name. Used as the cross-endpoint key. */
  name: string
  /** Map of endpoint base URL → that endpoint's local UUID for this voice. */
  idByEndpoint: Record<string, string>
  /** List of endpoint URLs this voice exists on (just `Object.keys(idByEndpoint)`). */
  availableOn: string[]
  /** True when this voice exists on every endpoint in the configured pool. */
  availableEverywhere: boolean
  /** First-endpoint sample audio_url + metadata for previewing in the picker.
   *  Picked from whichever endpoint listed the voice first; assumes the
   *  audio is the same across instances (which the user must ensure by
   *  uploading the same WAV on each Mac). */
  sample: {
    audio_url?: string
    duration_seconds?: number
    language?: string
    gender?: string
    sample_rate?: number
    channels?: number
    has_transcript?: boolean
  }
}

export interface VoicePoolResult {
  /** Every endpoint URL that was queried (whether it responded or not). */
  endpoints: string[]
  /** Endpoints that responded with a valid voice list. */
  reachableEndpoints: string[]
  /** Endpoints that errored (offline, wrong URL, etc.). */
  unreachableEndpoints: Array<{ url: string; error: string }>
  /** Aggregated voices keyed by name. */
  voicesByName: Record<string, PooledVoice>
  /** Convenience: a flat array sorted by name. */
  voices: PooledVoice[]
}

// ── Cache ────────────────────────────────────────────────────────────────
// Keyed on the canonical endpoint string so reordering or whitespace in
// the stored URL list doesn't bypass the cache. TTL is 60s — long enough
// to cover a multi-minute audio job's chunks, short enough that adding a
// new voice in Voice Studio shows up within a minute on the picker.
interface CacheEntry { result: VoicePoolResult; expiresAt: number }
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

function cacheKey(endpoints: string[]): string {
  return [...endpoints].sort().join('|')
}

export function clearVoicePoolCache(): void {
  cache.clear()
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Resolve the voice-name → per-endpoint-UUID map for the given Voice Studio
 * endpoint list. Use this from the voices route (to populate the picker)
 * AND from the audio dispatcher (to resolve voice IDs per chunk).
 *
 * `stored` is the raw value from `getApiKey('voicestudio')` — comma /
 * whitespace separated. Empty / null → returns an empty pool (caller
 * should fall back to the historical single-endpoint behaviour).
 */
export async function resolveVoicePool(stored: string | null | undefined): Promise<VoicePoolResult> {
  const endpoints = parseEndpoints(stored)
  if (endpoints.length === 0) {
    return {
      endpoints: [], reachableEndpoints: [], unreachableEndpoints: [],
      voicesByName: {}, voices: [],
    }
  }

  const key = cacheKey(endpoints)
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) {
    return hit.result
  }

  // Query each endpoint in parallel — they're independent reads, ~8s
  // timeout each via listVoices(). Worst case one endpoint stalls
  // entirely; the other still returns its voices and we proceed
  // partial. The aggregate just won't include the stalled endpoint's
  // voices, and chunks dispatched there will fail at TTS time with the
  // Voice Studio server's own error.
  const perEndpoint = await Promise.all(
    endpoints.map(async (url) => {
      try {
        const voices = await listVoices(url)
        return { url, voices, error: null as null }
      } catch (e: any) {
        return { url, voices: [] as VoiceStudioLibraryVoice[], error: e?.message ?? String(e) }
      }
    }),
  )

  const reachable: string[] = []
  const unreachable: Array<{ url: string; error: string }> = []
  const byName: Record<string, PooledVoice> = {}

  for (const { url, voices, error } of perEndpoint) {
    if (error !== null) {
      unreachable.push({ url, error })
      continue
    }
    reachable.push(url)
    for (const v of voices) {
      if (!v.name || !v.id) continue
      const existing = byName[v.name]
      if (existing) {
        existing.idByEndpoint[url] = v.id
        existing.availableOn = Object.keys(existing.idByEndpoint)
      } else {
        byName[v.name] = {
          name: v.name,
          idByEndpoint: { [url]: v.id },
          availableOn: [url],
          availableEverywhere: false, // computed below after the full pass
          sample: {
            audio_url: v.audio_url,
            duration_seconds: v.duration_seconds,
            language: v.language,
            gender: v.gender,
            sample_rate: v.sample_rate,
            channels: v.channels,
            has_transcript: v.has_transcript,
          },
        }
      }
    }
  }

  // Mark availableEverywhere now that we know the full endpoint list.
  // Compare against `reachable` (not `endpoints`) so an unreachable mac
  // doesn't pin every voice to "not everywhere" — the user's INTENT was
  // that the unreachable mac has the same voices; we just couldn't verify.
  // This means a temporarily-offline Mac doesn't make the picker change.
  // Trade-off: when a Mac comes back online with DIFFERENT voices the next
  // probe will surface that via the per-voice availableOn list.
  const reachableCount = reachable.length
  for (const v of Object.values(byName)) {
    v.availableEverywhere = reachableCount > 0 && v.availableOn.length === reachableCount
  }

  const voices = Object.values(byName).sort((a, b) => a.name.localeCompare(b.name))
  const result: VoicePoolResult = {
    endpoints,
    reachableEndpoints: reachable,
    unreachableEndpoints: unreachable,
    voicesByName: byName,
    voices,
  }
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS })
  return result
}

/**
 * Resolve a voice name to a SINGLE endpoint URL + UUID, given a preferred
 * endpoint URL the dispatcher wants to use.
 *
 *   - If the voice exists on `preferredEndpoint` → return that endpoint's UUID
 *   - Otherwise → pick ANY endpoint that has the voice (Option B fallback —
 *     pinning the chunk to a non-preferred endpoint loses some parallelism
 *     for this chunk but avoids the "voice not found" error)
 *   - If the voice doesn't exist anywhere → return null (caller errors out)
 *
 * Used in the audio dispatcher's `runOnPool` worker, called once per chunk.
 */
export function pickEndpointForVoice(
  pool: VoicePoolResult,
  voiceName: string,
  preferredEndpoint: string,
): { endpoint: string; voiceId: string } | null {
  const v = pool.voicesByName[voiceName]
  if (!v) return null
  const onPreferred = v.idByEndpoint[preferredEndpoint]
  if (onPreferred) return { endpoint: preferredEndpoint, voiceId: onPreferred }
  // Fall back to whatever endpoint has it (deterministic — alphabetical).
  const fallbackEndpoint = v.availableOn[0]
  if (!fallbackEndpoint) return null
  const fallbackId = v.idByEndpoint[fallbackEndpoint]
  if (!fallbackId) return null
  return { endpoint: fallbackEndpoint, voiceId: fallbackId }
}

// ── Voice-field convention (v1.0.293+) ──────────────────────────────────
//
// To distinguish a name-keyed voice ("Vincent" — resolves per-endpoint
// via the pool) from a legacy UUID ("7626576fe87f" — pins to the
// endpoint that actually has that UUID), the form stores them with
// distinct prefixes:
//
//   "vsname:<name>" → name-keyed, pool-resolved
//   "<uuid>"        → legacy raw UUID, single-endpoint pinned
//
// Helpers below parse + format these strings.

export const VSNAME_PREFIX = 'vsname:'

export function isVoiceName(field: string | null | undefined): boolean {
  return typeof field === 'string' && field.startsWith(VSNAME_PREFIX)
}

export function parseVoiceName(field: string | null | undefined): string | null {
  if (!isVoiceName(field)) return null
  return (field as string).slice(VSNAME_PREFIX.length)
}

export function formatVoiceName(name: string): string {
  return `${VSNAME_PREFIX}${name}`
}
