/**
 * Shared route middleware.
 *
 * v1.0.338 — requireProject: ONE project-existence guard for every
 * /api/projects/:slug/* endpoint, mounted in routes/index.ts before all
 * routers. Before this, the same one-liner —
 *   if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
 * — was hand-copied ~167 times across 30+ route files, with drift in the
 * error message and coverage gaps in newer endpoints. The guard makes the
 * 404 contract uniform: any project-scoped request for an unknown slug is
 * rejected here with the exact same envelope the inline checks used.
 *
 * Inline checks left in route files are now redundant but harmless (they
 * can never fire — the guard runs first); they're being removed
 * opportunistically rather than in one risky sweep.
 */

import type { Request, Response, NextFunction } from 'express'
import * as pm from '../services/project-manager.js'

/**
 * Path segments under /api/projects/ that are ROUTES, not project slugs.
 * (A project actually named "import" or "templates" was already shadowed
 * by these routes before the guard existed — this preserves that.)
 */
export const RESERVED_PROJECT_SEGMENTS = new Set(['import', 'templates'])

export async function requireProject(req: Request, res: Response, next: NextFunction): Promise<void> {
  // app.use-path params are typed string | string[] in Express 5; a repeated
  // :slug segment can't occur in our mount path, so first-value is exact.
  const raw = req.params.slug
  const slug = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  if (!slug || RESERVED_PROJECT_SEGMENTS.has(slug)) { next(); return }
  // The /jobs subtree is deliberately tolerant of unknown projects: the
  // frontend polls it optimistically and the SSE stream may outlive a
  // deleted project — a 404 here would put EventSource into a retry loop.
  // (Pinned by routes.test.ts "Jobs endpoint returns empty list (not 404)".)
  // req.path inside a use-mounted middleware is the REMAINDER after the
  // mount match, e.g. "/jobs/stream".
  if (req.path === '/jobs' || req.path.startsWith('/jobs/')) { next(); return }
  if (!await pm.getProject(slug)) {
    res.status(404).json({ detail: 'Project not found' })
    return
  }
  next()
}
