/**
 * Last-session restore endpoints — read / write / clear the small JSON that
 * remembers where the operator was so the next launch (clean or after a
 * crash) lands them back on the same page.
 *
 * See `services/last-session.ts` for the storage shape and the allowlist of
 * routes whose page-mount is safe to re-trigger automatically.
 */

import { Router } from 'express'
import {
  readLastSession,
  patchLastSession,
  clearRouteState,
  isRestorableRoute,
} from '../services/last-session.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

router.get('/last-session', async (_req, res) => {
  try {
    res.json(await readLastSession())
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read last session'))
  }
})

router.post('/last-session', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const projectSlug = typeof body.projectSlug === 'string' ? body.projectSlug : undefined
  const route = typeof body.route === 'string' ? body.route : undefined

  if (!projectSlug || !route) {
    return res.status(400).json({ detail: 'projectSlug and route required' })
  }
  // Server-side allowlist guard. The renderer-side plugin already filters,
  // but a buggy refactor that started saving "/" or an OAuth callback would
  // wipe useful state — reject it here so corrupted writes never reach disk.
  if (route === '/' || !isRestorableRoute(route)) {
    return res.status(400).json({ detail: 'route not restorable' })
  }

  try {
    const saved = await patchLastSession({ projectSlug, route, ts: Date.now() })
    res.json(saved)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save last session'))
  }
})

router.patch('/last-session', async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (typeof body.unclean_shutdown_dismissed === 'boolean') {
    patch.unclean_shutdown_dismissed = body.unclean_shutdown_dismissed
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ detail: 'no patchable fields supplied' })
  }
  try {
    const saved = await patchLastSession(patch)
    res.json(saved)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update last session'))
  }
})

router.delete('/last-session', async (_req, res) => {
  try {
    const next = await clearRouteState()
    res.json(next)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to clear last session'))
  }
})
