/** Asset provenance for the local B-Roll library. */
import { Router } from 'express'
import * as bp from '../services/broll-pool-manager.js'
import { listProvenance } from '../services/broll-provenance.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

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
