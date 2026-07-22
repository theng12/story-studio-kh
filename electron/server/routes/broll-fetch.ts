/**
 * Routes for the B-Roll Fetch feature.
 *
 *   GET  /api/broll-fetch/providers                — reports the disabled boundary
 *   GET  /api/broll-fetch/search                    — unavailable until GenStudio
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
import { listProvenance } from '../services/broll-provenance.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

const STOCK_FETCH_UNAVAILABLE = {
  code: 'GENSTUDIO_CAPABILITY_UNAVAILABLE',
  detail: 'Stock and SFX provider search is unavailable until GenStudio KH publishes a qualified typed asset-search route. Add files to the local pool manually and re-scan it.',
}

router.get('/broll-fetch/providers', async (_req, res) => {
  res.json({ providers: [], available: false, ...STOCK_FETCH_UNAVAILABLE })
})

/**
 * Search results carry an `already_have` flag for each entry so the UI
 * can grey out clips that are already in the target pool. When no
 * `pool_id` is given, every result gets `already_have: false` —
 * callers can still preview results without pre-selecting a pool.
 */
router.get('/broll-fetch/search', async (req, res) => {
  void req
  return res.status(501).json(STOCK_FETCH_UNAVAILABLE)
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
