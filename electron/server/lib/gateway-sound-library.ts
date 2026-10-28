/**
 * The Gateway's shared sound library, read-only (v1.4.365).
 *
 * Smart Sound shipped in the Gateway with `GET /v1/sounds/search`,
 * `POST`/`GET /v1/sounds/library` and `GET /v1/sounds/quota` — but nothing in
 * Story Studio ever called one, so the only sounds a customer could place were
 * files he had already put in an SFX folder himself. This is the missing half.
 *
 * Two rules shape everything here:
 *
 *   1. **A sound source is not a model provider.** These are free, read-only
 *      GETs to the one paired Gateway — the same machine the paid lanes already
 *      talk to — plus a download POST that the customer now triggers by picking
 *      a clip. Nothing here charges a credit or routes a generation.
 *   2. **The licence travels with the clip.** Every result carries
 *      `licence`/`author`/`source_url` from the Gateway, and the cue that keeps
 *      the clip stores them verbatim. Nothing is derived, guessed, or filled in
 *      with a placeholder — a clip whose licence cannot be named is not offered.
 *
 * CC0-first ordering is the Gateway's, not ours: it sorts by
 * `(0 if cc0 else 1, title)` before answering, so this file never re-ranks.
 */
import { getGenStudioUrl } from '../services/app-settings.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { STORY_CALLER } from './machine-name.js'
import type { SoundDesignCredit } from '../models/types.js'

/** What the page draws in its picker. Structurally the Gateway's search result. */
export interface GatewaySoundResult {
  source: string
  source_id: string
  title: string
  author?: string | null
  licence: string
  licence_version?: string | null
  duration_ms?: number | null
  attribution?: string | null
  source_url?: string | null
}

export interface GatewaySoundLibrary {
  results: GatewaySoundResult[]
  /** True when the Gateway answered from its own library because upstream quota is gone. */
  library_only: boolean
  /** False when the Gateway has no sound-source key — a real answer, not an empty list. */
  configured: boolean
  /** Anything the caller should show instead of implying "there are no sounds". */
  note?: string
}

const REQUEST_TIMEOUT_MS = 20_000

async function gatewayRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const [baseUrl, apiKey] = await Promise.all([getGenStudioUrl(), getApiKey('genstudio')])
  if (!apiKey.trim()) throw new Error('No Gateway API Key configured. Open Settings → This Mac → Gateway API Key.')
  const url = `${baseUrl.trim().replace(/\/+$/, '')}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'X-Caller': STORY_CALLER,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = (body as any)?.detail || (body as any)?.message
      throw new Error(typeof detail === 'string' && detail ? detail : `The Gateway answered ${response.status}.`)
    }
    return body as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Search for sounds.
 *
 * A Gateway with no key configured answers `results: []` exactly like a search
 * that found nothing, so this asks the quota route FIRST and says which it is.
 * That distinction is the whole point: an empty picker beside "approved" was
 * the defect.
 */
export async function fetchSoundLibrary(query: string): Promise<GatewaySoundLibrary> {
  let configured = true
  let note: string | undefined
  try {
    const quota = await gatewayRequest<{ sources?: Record<string, { configured?: boolean }> }>('/v1/sounds/quota')
    const sources = Object.values(quota?.sources || {})
    // No sources at all, or every one of them unconfigured, means the Gateway
    // cannot search — say it rather than return an empty list.
    configured = sources.length > 0 && sources.some(source => source?.configured === true)
    if (!configured) note = 'The Gateway has no sound source configured, so its library cannot be searched. Add a key in the Gateway’s SFX tab, or use your own sound folders.'
  } catch {
    // A Gateway that cannot answer the quota route is not necessarily unable to
    // search; the search below reports its own failure if so.
    configured = true
  }
  const search = await gatewayRequest<{ results?: GatewaySoundResult[]; library_only?: boolean }>(
    `/v1/sounds/search?q=${encodeURIComponent(query || '')}`,
  )
  const results = (search?.results || []).filter(result => typeof result?.licence === 'string' && result.licence.trim())
  return {
    results,
    library_only: search?.library_only === true,
    configured,
    ...(note ? { note } : {}),
    ...(!note && !results.length && configured ? { note: 'The Gateway found no commercially-safe sounds for that search.' } : {}),
  }
}

/**
 * Keep a chosen clip in the Gateway's library and return the credit facts.
 *
 * The Gateway downloads, hashes, probes and stores the bytes, and answers the
 * metadata it stored — including the licence it re-checked against the upstream
 * detail response. This function relays that answer; it never builds a credit
 * of its own.
 */
export async function keepSoundInLibrary(source: string, sourceId: string): Promise<{ sha256: string; credit: SoundDesignCredit; duration_sec?: number }> {
  const meta = await gatewayRequest<Record<string, unknown>>('/v1/sounds/library', {
    method: 'POST',
    body: JSON.stringify({ source, source_id: sourceId }),
  })
  const licence = typeof meta.licence === 'string' ? meta.licence.trim() : ''
  const sha256 = typeof meta.sha256 === 'string' ? meta.sha256.trim() : ''
  if (!licence) throw new Error('The Gateway stored that clip without a licence, so it cannot be credited. Nothing was added.')
  if (!sha256) throw new Error('The Gateway did not return an identifier for that clip. Nothing was added.')
  return {
    sha256,
    credit: {
      licence,
      ...(typeof meta.licence_version === 'string' && meta.licence_version ? { licence_version: meta.licence_version } : {}),
      ...(typeof meta.author === 'string' && meta.author ? { author: meta.author } : {}),
      ...(typeof meta.source_url === 'string' && meta.source_url ? { source_url: meta.source_url } : {}),
      ...(typeof meta.source === 'string' && meta.source ? { source: meta.source } : {}),
      ...(typeof meta.title === 'string' && meta.title ? { title: meta.title } : {}),
    },
    ...(typeof meta.duration_seconds === 'number' ? { duration_sec: meta.duration_seconds } : {}),
  }
}

/** Every clip already kept in the Gateway library, so a cached pick costs no download. */
export async function listKeptSounds(): Promise<Array<{ sha256: string; credit: SoundDesignCredit; duration_sec?: number }>> {
  const body = await gatewayRequest<{ clips?: Array<Record<string, unknown>> }>('/v1/sounds/library')
  return (body?.clips || []).flatMap(clip => {
    const licence = typeof clip.licence === 'string' ? clip.licence.trim() : ''
    const sha256 = typeof clip.sha256 === 'string' ? clip.sha256.trim() : ''
    if (!licence || !sha256) return []
    return [{
      sha256,
      credit: {
        licence,
        ...(typeof clip.licence_version === 'string' && clip.licence_version ? { licence_version: clip.licence_version } : {}),
        ...(typeof clip.author === 'string' && clip.author ? { author: clip.author } : {}),
        ...(typeof clip.source_url === 'string' && clip.source_url ? { source_url: clip.source_url } : {}),
        ...(typeof clip.source === 'string' && clip.source ? { source: clip.source } : {}),
        ...(typeof clip.title === 'string' && clip.title ? { title: clip.title } : {}),
      },
      ...(typeof clip.duration_seconds === 'number' ? { duration_sec: clip.duration_seconds } : {}),
    }]
  })
}
