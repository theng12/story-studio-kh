/**
 * Character unification migration routes.
 *
 *   GET  /api/character-migration/plan    → dry run, writes nothing
 *   POST /api/character-migration/run     → execute; requires { confirm: true }
 *
 * Copy-only + reversible — see services/character-migration.ts and
 * docs/character-unification-spec.md. Without `confirm: true` the run endpoint
 * behaves as a dry run (reported in the run shape) so a misfired POST can never
 * mutate the stores.
 */

import { Router } from 'express'
import * as mig from '../services/character-migration.js'

export const router = Router()

router.get('/character-migration/plan', async (_req, res) => {
  try {
    res.json(await mig.planMigration())
  } catch (e: any) {
    res.status(500).json({ detail: `Migration plan failed: ${e.message}` })
  }
})

router.post('/character-migration/run', async (req, res) => {
  try {
    const confirm = req.body?.confirm === true
    res.json(await mig.runMigration({ confirm }))
  } catch (e: any) {
    res.status(500).json({ detail: `Migration run failed: ${e.message}` })
  }
})
