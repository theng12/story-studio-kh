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
      const includeFull = req.query.full === '1' || req.query.full === 'true'
      const fullLog = includeFull && Array.isArray(cfg?.recency_log)
        ? [...cfg!.recency_log!].sort((a, b) => b.used_at.localeCompare(a.used_at))
        : undefined
      const kindCounts: Record<string, number> = {}
      if (includeFull && Array.isArray(cfg?.recency_log)) {
        for (const e of cfg!.recency_log!) {
          kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1
        }
      }
      return res.json({
        enabled: false,
        kind: null,
        label: null,
        lookback: 0,
        lookback_source: null,
        recent_items: [],
        log_size: Array.isArray(cfg?.recency_log) ? cfg!.recency_log!.length : 0,
        niche_id: niche?.id || null,
        ...(includeFull ? { full_log: fullLog, kind_counts: kindCounts } : {}),
      })
    }

    const { items, lookback } = await getRecentItems(slug, niche)
    const cfg = await pm.getConfig(slug)
    const lookbackSource = typeof cfg?.recency_lookback === 'number' && cfg.recency_lookback > 0
      ? 'project'
      : typeof niche.recencyAvoidance.defaultLookback === 'number'
        ? 'niche'
        : 'default'

    // v1.0.108+ — when ?full=1, also return the entire log (every
    // entry, every kind, every episode) for the management page. The
    // default response stays compact for the Script Generator strip.
    const includeFull = req.query.full === '1' || req.query.full === 'true'
    const fullLog = includeFull && Array.isArray(cfg?.recency_log)
      ? [...cfg!.recency_log!].sort((a, b) => b.used_at.localeCompare(a.used_at))
      : undefined
    // Distinct kinds in the log — drives the filter dropdown on the page.
    const kindCounts: Record<string, number> = {}
    if (includeFull && Array.isArray(cfg?.recency_log)) {
      for (const e of cfg!.recency_log!) {
        kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1
      }
    }

    res.json({
      enabled: true,
      kind: niche.recencyAvoidance.label,
      label: niche.recencyAvoidance.label,
      lookback,
      lookback_source: lookbackSource,
      recent_items: items,
      log_size: Array.isArray(cfg?.recency_log) ? cfg!.recency_log!.length : 0,
      niche_id: niche.id,
      ...(includeFull ? { full_log: fullLog, kind_counts: kindCounts } : {}),
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

/**
 * v1.0.108+ — surgical delete of a single (episode, kind, item) entry.
 * Lets the user remove a specific item from the log without nuking the
 * whole thing, e.g. "I want to re-use Psalm 91 for episode 4 even
 * though episode 1 used it." After delete, the cycler's avoid-list no
 * longer excludes that item.
 */
router.delete('/projects/:slug/recency/entry', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const episode_code = typeof req.body?.episode_code === 'string' ? req.body.episode_code.trim() : ''
    const kind = typeof req.body?.kind === 'string' ? req.body.kind.trim() : ''
    const item = typeof req.body?.item === 'string' ? req.body.item.trim() : ''
    if (!episode_code || !kind || !item) {
      return res.status(400).json({ detail: 'episode_code, kind, and item are required' })
    }
    const cfg = await pm.getConfig(slug)
    if (!cfg) return res.status(404).json({ detail: 'Project config not found' })
    const log = Array.isArray(cfg.recency_log) ? cfg.recency_log : []
    const next = log.filter(e => !(e.episode_code === episode_code && e.kind === kind && e.item === item))
    if (next.length === log.length) return res.status(404).json({ detail: 'Entry not found in log' })
    await pm.updateConfig(slug, { recency_log: next } as any)
    res.json({ ok: true, removed: 1 })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete log entry'))
  }
})
