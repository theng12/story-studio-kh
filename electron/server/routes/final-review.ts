/**
 * Review routes — the optional final-video review marks (owner, 2026-10-29).
 *
 * Deliberately global, not under /projects/:slug: the Review page lists every
 * review-enabled channel in one read, so it is the same shape as the global
 * Publishing Overview route. Every handler here is behind server mode's
 * session cookie when the app is reached over Tailscale (see app.ts).
 *
 * These routes authorise nothing. A mark is a review note; no upload, schedule
 * or pipeline step reads it, and turning review off leaves production exactly
 * as it was.
 */

import { Router } from 'express'

import { respondWithError } from '../lib/humanize-backend-error.js'
import * as pm from '../services/project-manager.js'
import {
  deleteFinalReview,
  finalReviewEnabled,
  listFinalReviews,
  writeFinalReview,
} from '../services/final-review.js'
import { findYouTubeSourceVideoPath } from '../services/youtube-source-video.js'
import { resolveEpisodePaths, resolveEpisodeTitleByCode } from '../services/utils.js'

export const router = Router()

// GET /api/review/finals[?slug=<channel>] — finished videos, newest first.
router.get('/review/finals', async (req, res) => {
  try {
    const slug = typeof req.query.slug === 'string' ? req.query.slug.trim() : ''
    if (slug && !await pm.getProject(slug)) {
      return res.status(404).json({ detail: 'Project not found' })
    }
    res.json(await listFinalReviews(slug ? { slug } : {}))
  } catch (e: any) {
    respondWithError(res, e, 'Could not list finished videos')
  }
})

// POST /api/review/finals/:slug/:code
//   { decision: 'approved' | 'needs_changes' | 'auto_passed' | 'clear', expected_size, expected_mtime_ms, expected_ino }
//
// `expected_*` is the file the reviewer was looking at. When the final on disk
// no longer matches it, the mark is refused rather than stamped onto bytes
// nobody watched.
router.post('/review/finals/:slug/:code', async (req, res) => {
  try {
    const { slug, code } = req.params
    const decision = req.body?.decision
    if (decision !== 'approved' && decision !== 'needs_changes' && decision !== 'auto_passed' && decision !== 'clear') {
      return res.status(400).json({ detail: 'decision must be "approved", "needs_changes", "auto_passed", or "clear".' })
    }
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project not found' })
    if (!finalReviewEnabled(config)) {
      return res.status(409).json({ detail: 'Review is off for this channel. Turn it on first; nothing else in production depends on it.' })
    }
    const title = await resolveEpisodeTitleByCode(slug, code)
    if (!title) return res.status(404).json({ detail: `No accepted episode ${code} was found in this channel.` })
    const paths = await resolveEpisodePaths(slug, code, title)
    const finalPath = await findYouTubeSourceVideoPath(paths, slug, code, title)
    if (!finalPath) return res.status(404).json({ detail: `${code} has no finished final video to review.` })

    if (decision === 'clear') {
      res.json({ ok: true, review: await deleteFinalReview(finalPath) })
      return
    }

    const expectedSize = req.body?.expected_size
    const expectedMtime = req.body?.expected_mtime_ms
    const expectedIno = req.body?.expected_ino
    if (typeof expectedSize !== 'number' || typeof expectedMtime !== 'number' || typeof expectedIno !== 'number') {
      return res.status(400).json({ detail: 'expected_size, expected_mtime_ms and expected_ino are required so a mark names the exact file that was reviewed.' })
    }

    res.json({ ok: true, review: await writeFinalReview(finalPath, decision, { size: expectedSize, mtime_ms: expectedMtime, ino: expectedIno }) })
  } catch (e: any) {
    respondWithError(res, e, 'Could not save the review mark')
  }
})

// DELETE /api/review/finals/:slug/:code — clear any mark on a final video.
router.delete('/review/finals/:slug/:code', async (req, res) => {
  try {
    const { slug, code } = req.params
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project not found' })
    const title = await resolveEpisodeTitleByCode(slug, code)
    if (!title) return res.status(404).json({ detail: `No accepted episode ${code} was found in this channel.` })
    const paths = await resolveEpisodePaths(slug, code, title)
    const finalPath = await findYouTubeSourceVideoPath(paths, slug, code, title)
    if (!finalPath) return res.status(404).json({ detail: `${code} has no finished final video.` })
    res.json({ ok: true, review: await deleteFinalReview(finalPath) })
  } catch (e: any) {
    respondWithError(res, e, 'Could not clear the review mark')
  }
})

// PUT /api/review/channels/:slug { enabled?: boolean, auto_pass?: boolean } — optional per-channel switches.
router.put('/review/channels/:slug', async (req, res) => {
  try {
    const enabled = req.body?.enabled
    const autoPass = req.body?.auto_pass
    if (typeof enabled !== 'boolean' && typeof autoPass !== 'boolean') {
      return res.status(400).json({ detail: 'enabled or auto_pass must be a boolean.' })
    }
    const currentConfig = await pm.getConfig(req.params.slug)
    if (!currentConfig) return res.status(404).json({ detail: 'Project not found' })
    // The auto-pass fields are not in the reserved types.ts declaration yet;
    // updateConfig passes them through, so read them through a local view.
    const existing = (currentConfig.final_review ?? {}) as {
      enabled?: boolean
      auto_pass?: boolean
      auto_pass_enabled_at?: string
    }
    const nextEnabled = typeof enabled === 'boolean' ? enabled : existing?.enabled ?? false
    const nextAutoPass = typeof autoPass === 'boolean' ? autoPass : existing?.auto_pass ?? false
    let autoPassEnabledAt = existing?.auto_pass_enabled_at
    if (typeof autoPass === 'boolean') {
      if (autoPass && !autoPassEnabledAt) {
        autoPassEnabledAt = new Date().toISOString()
      } else if (!autoPass) {
        autoPassEnabledAt = undefined
      }
    }
    const nextReview = {
      enabled: nextEnabled,
      auto_pass: nextAutoPass,
      ...(autoPassEnabledAt ? { auto_pass_enabled_at: autoPassEnabledAt } : {}),
    }
    const updated = await pm.updateConfig(req.params.slug, { final_review: nextReview })
    if (!updated) return res.status(404).json({ detail: 'Project not found' })
    res.json({
      ok: true,
      slug: req.params.slug,
      review_enabled: nextReview.enabled,
      auto_pass_enabled: nextReview.auto_pass,
    })
  } catch (e: any) {
    respondWithError(res, e, 'Could not change the review setting')
  }
})
