/**
 * Routes for the v1.0.106+ recency-avoidance log.
 *
 *   GET    /api/projects/:slug/recency                   — full state for the UI strip
 *   PUT    /api/projects/:slug/recency/lookback          — update per-project lookback
 *   DELETE /api/projects/:slug/recency                   — clear the log (with optional ?kind=)
 *
 * The GET response gives the Script Generator everything it needs to
 * render the recency strip: the niche kind, the resolved lookback,
 * the items currently being avoided in the next prompt, and the total
 * log size (for the "manage" link).
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { getEffectiveNiche } from '../services/niche-loader.js'
import { getRecentItems, clearLog } from '../services/recency-tracker.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

router.get('/projects/:slug/recency', async (req, res) => {
  try {
    const slug = req.params.slug
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })

    const niche = await getEffectiveNiche(slug)
    if (!niche?.recencyAvoidance) {
      // Niche has no recency config — return a stable empty shape so the
      // frontend can render "no recency tracking" without special-casing.
      const cfg = await pm.getConfig(slug)
      return res.json({
        enabled: false,
        kind: null,
        label: null,
        lookback: 0,
        lookback_source: null,
        recent_items: [],
        log_size: Array.isArray(cfg?.recency_log) ? cfg!.recency_log!.length : 0,
        niche_id: niche?.id || null,
      })
    }

    const { items, lookback } = await getRecentItems(slug, niche)
    const cfg = await pm.getConfig(slug)
    const lookbackSource = typeof cfg?.recency_lookback === 'number' && cfg.recency_lookback > 0
      ? 'project'
      : typeof niche.recencyAvoidance.defaultLookback === 'number'
        ? 'niche'
        : 'default'

    res.json({
      enabled: true,
      kind: niche.recencyAvoidance.label,
      label: niche.recencyAvoidance.label,
      lookback,
      lookback_source: lookbackSource,
      recent_items: items,
      log_size: Array.isArray(cfg?.recency_log) ? cfg!.recency_log!.length : 0,
      niche_id: niche.id,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load recency state'))
  }
})

router.put('/projects/:slug/recency/lookback', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const raw = req.body?.lookback
    // Accept null / empty / 0 as "reset to niche default" by writing 0
    // (which falls through the resolution chain to the niche's default
    // or the hard-coded 30).
    let lookback: number
    if (raw === null || raw === '' || raw === undefined) {
      lookback = 0
    } else {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ detail: 'lookback must be a non-negative number' })
      }
      lookback = Math.floor(n)
    }
    await pm.updateConfig(slug, { recency_lookback: lookback } as any)
    res.json({ ok: true, lookback })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update lookback'))
  }
})

router.delete('/projects/:slug/recency', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const kindFilter = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : undefined
    const removed = await clearLog(slug, kindFilter)
    res.json({ ok: true, removed })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to clear recency log'))
  }
})
