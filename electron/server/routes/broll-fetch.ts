/**
 * Routes for the B-Roll Fetch feature.
 *
 *   GET  /api/broll-fetch/providers                — which adapters are configured
 *   GET  /api/broll-fetch/search?provider&q&pool_id
 *                                                  — search a provider, annotate
 *                                                    results with already_have
 *                                                    against the target pool
 *   GET  /api/broll-pools/:id/provenance           — list provenance sidecars for
 *                                                    one pool (drives the asset log)
 *
 * The "queue a fetch job" endpoint lives in `routes/broll-pools.ts`
 * alongside the existing normalize / autotag queue endpoints — its
 * pool-scoped URL matches that family.
 */
import { Router } from 'express'
import * as bp from '../services/broll-pool-manager.js'
import { ADAPTERS, getAdapter } from '../services/broll-fetchers/index.js'
import type { FetchProvider, FetchResult } from '../services/broll-fetchers/types.js'
import { listProvenance, hasFetchedClip } from '../services/broll-provenance.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

type PoolMedia = 'video' | 'image' | 'audio'

interface ConfiguredProvider {
  provider: FetchProvider
  configured: boolean
  /** Human-readable display name for the UI dropdown / chips. */
  name: string
  /** Pool media this provider feeds. The Fetch panel only shows a provider
   *  when it matches the selected pool's media (Freesound → audio pools;
   *  Pexels/Pixabay/NASA → video pools). */
  media: PoolMedia
}

const DISPLAY_NAMES: Record<FetchProvider, string> = {
  pexels: 'Pexels',
  pixabay: 'Pixabay',
  nasa: 'NASA',
  freesound: 'Freesound',
}

// Which pool media each provider feeds. Video providers serve `video` pools;
// Freesound serves `audio` (SFX) pools. (No fetch provider targets `image`
// pools yet — those are hand-curated.)
const PROVIDER_MEDIA: Record<FetchProvider, PoolMedia> = {
  pexels: 'video',
  pixabay: 'video',
  nasa: 'video',
  freesound: 'audio',
}

router.get('/broll-fetch/providers', async (_req, res) => {
  try {
    const out: ConfiguredProvider[] = []
    for (const [id, adapter] of Object.entries(ADAPTERS) as Array<[FetchProvider, typeof ADAPTERS[FetchProvider]]>) {
      out.push({
        provider: id,
        name: DISPLAY_NAMES[id],
        media: PROVIDER_MEDIA[id],
        configured: await adapter.isConfigured(),
      })
    }
    res.json({ providers: out })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list providers'))
  }
})

/**
 * Search results carry an `already_have` flag for each entry so the UI
 * can grey out clips that are already in the target pool. When no
 * `pool_id` is given, every result gets `already_have: false` —
 * callers can still preview results without pre-selecting a pool.
 */
interface AnnotatedResult extends FetchResult {
  already_have: boolean
}

// v1.0.134+ — Search-response cache. Pixabay's API terms (ticked when
// applying for a key) explicitly require: "API responses will be cached
// to avoid identical requests within 24 hours." Honored only in spirit
// before this (a single-user app rarely fires the same search twice in
// a day). This makes it literal — and the same cache covers Pexels for
// free, conserving quota against their 200 req/hr free-tier limit.
//
// Key shape: `${provider}::${normalized_q}::${perPage}::${page}`.
// Normalized q is lowercased + trimmed + collapsed whitespace so
// "ocean sunset" and "Ocean   Sunset" hit the same entry.
//
// Storage: module-level Map, in-memory only. On a single-user app the
// map stays tiny (well under 100 entries in a day) so no LRU bound is
// needed. Process restart clears — fine for a TTL cache, and aligns
// with how the user mentally models "fresh app launch = fresh search."
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h, matches Pixabay terms
interface SearchCacheEntry {
  results: FetchResult[]
  cachedAt: number
}
const _searchCache = new Map<string, SearchCacheEntry>()

function searchCacheKey(provider: string, q: string, perPage: number, page: number): string {
  const normalized = q.toLowerCase().trim().replace(/\s+/g, ' ')
  return `${provider}::${normalized}::${perPage}::${page}`
}

router.get('/broll-fetch/search', async (req, res) => {
  try {
    const provider = String(req.query.provider || '') as FetchProvider
    if (!provider || !(provider in ADAPTERS)) {
      return res.status(400).json({ detail: `Unknown provider: ${provider}` })
    }
    const q = String(req.query.q || '').trim()
    if (!q) return res.status(400).json({ detail: 'Query (q) is required.' })
    const poolId = req.query.pool_id ? String(req.query.pool_id) : null
    const perPage = req.query.per_page ? Math.min(Math.max(parseInt(String(req.query.per_page), 10) || 20, 1), 50) : 20
    const page = req.query.page ? Math.max(parseInt(String(req.query.page), 10) || 1, 1) : 1

    const adapter = getAdapter(provider)
    if (!await adapter.isConfigured()) {
      return res.status(400).json({
        detail: `${DISPLAY_NAMES[provider]} API key not configured. Add it under App Settings → API Keys.`,
        code: 'PROVIDER_NOT_CONFIGURED',
        provider,
      })
    }

    // Gate by pool media — a provider only feeds pools of its media type
    // (Freesound → audio, Pexels/Pixabay/NASA → video). Refuse a mismatch
    // up front so the UI can't accidentally drop video into an SFX pool.
    let pool = null as Awaited<ReturnType<typeof bp.getPool>>
    if (poolId) {
      pool = await bp.getPool(poolId)
      if (!pool) return res.status(404).json({ detail: `Pool not found: ${poolId}` })
      const poolMedia = bp.poolMedia(pool)
      if (PROVIDER_MEDIA[provider] !== poolMedia) {
        return res.status(400).json({
          detail: `${DISPLAY_NAMES[provider]} provides ${PROVIDER_MEDIA[provider]} clips, but this is a ${poolMedia} pool.`,
          code: 'PROVIDER_MEDIA_MISMATCH',
          provider,
        })
      }
    }

    // v1.0.134+ — Cache check before hitting upstream. `cached: true` is
    // surfaced on the response so the Network tab + frontend can see
    // which searches were served locally vs round-tripped.
    const cacheKey = searchCacheKey(provider, q, perPage, page)
    let results: FetchResult[]
    let cached = false
    const hit = _searchCache.get(cacheKey)
    if (hit && Date.now() - hit.cachedAt < SEARCH_CACHE_TTL_MS) {
      results = hit.results
      cached = true
    } else {
      // Stale entry? Drop it before re-fetch so a long-running process
      // doesn't accumulate dead entries that never roll off naturally.
      if (hit) _searchCache.delete(cacheKey)
      try {
        results = await adapter.search(q, { perPage, page })
      } catch (e: any) {
        return res.status(502).json(humanizeBackendError(e, `${DISPLAY_NAMES[provider]} search failed`))
      }
      _searchCache.set(cacheKey, { results, cachedAt: Date.now() })
    }

    // Annotate against the target pool (already resolved above when a
    // pool_id was supplied). When browsing without a pool, every result is
    // `already_have: false`.
    const annotated: AnnotatedResult[] = []
    if (pool) {
      // Single sidecar-listing call, then in-memory check per result.
      // That's O(N + M) total instead of O(N*M) for separate lookups.
      const allProv = await listProvenance(pool.folder_path)
      const haveKeys = new Set(allProv.map(p => `${p.source}::${p.source_id}`))
      for (const r of results) {
        annotated.push({ ...r, already_have: haveKeys.has(`${r.provider}::${r.source_id}`) })
      }
    } else {
      for (const r of results) annotated.push({ ...r, already_have: false })
    }

    res.json({ provider, query: q, page, per_page: perPage, results: annotated, cached })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Search failed'))
  }
})

router.get('/broll-pools/:id/provenance', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: 'Pool not found' })
    const records = await listProvenance(pool.folder_path)
    // Sort newest-first — matches "what did I fetch recently?" reading order
    records.sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : -1))
    res.json({ pool_id: pool.id, count: records.length, records })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load provenance'))
  }
})

// Re-export the hasFetchedClip helper for any future caller that needs
// a one-off check without listing all sidecars. Not used by these
// routes (the search route uses listProvenance for batch efficiency).
export { hasFetchedClip }
