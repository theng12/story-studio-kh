/**
 * Research phase routes for the timestamp-driven pipeline (v1.0.142+).
 *
 *   GET    /api/research/sources                              — adapter status (configured + display info)
 *   GET    /api/projects/:slug/research/:episodeId            — read existing research.json
 *   POST   /api/projects/:slug/research/:episodeId/run        — queue a research_run job
 *   PUT    /api/projects/:slug/research/:episodeId            — replace the research.json (user-edited claims/status)
 *   POST   /api/projects/:slug/research/:episodeId/verify     — attest / withdraw attestation (v1.0.760)
 *   DELETE /api/projects/:slug/research/:episodeId            — remove the sidecar
 */

import { Router } from 'express'
import fs from 'fs/promises'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  RESEARCH_ADAPTERS,
  normalizeResearchSourceProvider,
} from '../services/research/index.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import {
  hasResearchEvidence,
  readResearchVerification,
  withResearchUnverified,
  withResearchVerified,
} from '../lib/research-verification.js'
import type { JobType, ResearchOutput, ResearchSourceProvider } from '../models/types.js'

export const router = Router()

// ── GET /research/sources ─────────────────────────────────────────────
// Compatibility endpoint retained for older Story Studio clients. Research
// now has one execution route only: the customer's GenStudio LLM catalog.
router.get('/research/sources', async (_req, res) => {
  try {
    const results = await Promise.all(
      Object.entries(RESEARCH_ADAPTERS).map(async ([id, adapter]) => ({
        id: id as ResearchSourceProvider,
        display_name: adapter.displayName,
        helper_text: adapter.helperText,
        configured: await adapter.isConfigured(),
      })),
    )
    res.json({ sources: results })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list research sources'))
  }
})

// ── GET /projects/:slug/research/:episodeId ───────────────────────────
// Read existing research.json sidecar. Returns 404 with a sentinel
// `{ exists: false }` body so the frontend can render the empty-state
// without a try/catch + showError dance.
router.get('/projects/:slug/research/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    // Title hint isn't necessary for path resolution — pass empty.
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { jsonPath: sidecarPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    try {
      const raw = await fs.readFile(sidecarPath, 'utf-8')
      const parsed = JSON.parse(raw) as ResearchOutput
      res.json({ exists: true, research: parsed, sidecar_path: sidecarPath })
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        return res.json({ exists: false, sidecar_path: sidecarPath })
      }
      throw e
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read research sidecar'))
  }
})

// ── POST /projects/:slug/research/:episodeId/run ──────────────────────
// Queue a research_run job. Returns the job descriptor; the frontend
// then watches /jobs SSE for completion + reads back via the GET above.
router.post('/projects/:slug/research/:episodeId/run', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const body = req.body || {}
  let sourceProvider: ResearchSourceProvider
  try {
    // Old presets and queued requests may still say `perplexity`. Treat that
    // value as a migration alias, never as permission to call Perplexity.
    sourceProvider = normalizeResearchSourceProvider(body.source_provider)
  } catch (e: unknown) {
    return res.status(400).json({
      detail: e instanceof Error ? e.message : 'Unknown research source',
    })
  }
  const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
  const specificQuestions = typeof body.specific_questions === 'string'
    ? body.specific_questions
    : undefined
  const maxSources = typeof body.max_sources === 'number' ? body.max_sources : undefined
  const title = typeof body.title === 'string' ? body.title : ''
  // Optional model from the published GenStudio LLM catalog.
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined

  if (!topic) {
    return res.status(400).json({ detail: 'topic is required' })
  }

  if (jq.isDuplicate(slug, episodeId, 'research_run' as JobType)) {
    return res.status(409).json({ detail: `Research already running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'research_run' as JobType,
    episode_id: episodeId,
    title: `Research — ${episodeId}`,
    params: {
      episode_id: episodeId,
      title,
      source_provider: sourceProvider,
      topic,
      specific_questions: specificQuestions,
      max_sources: maxSources,
      model,
    },
  })
  res.status(201).json(job)
})

// ── PUT /projects/:slug/research/:episodeId ───────────────────────────
// Replace the sidecar. Used by the Research page when the user flips
// claim status (verified / ignored / unreviewed) or edits text in-app
// and clicks Save. Validates the shape minimally — the frontend is
// trusted but we sanity-check schema_version + array fields.
router.put('/projects/:slug/research/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const body = req.body as Partial<ResearchOutput> | undefined
  if (!body || body.schema_version !== 1) {
    return res.status(400).json({ detail: 'Invalid research payload (missing schema_version: 1)' })
  }
  if (!Array.isArray(body.claims) || !Array.isArray(body.citations)) {
    return res.status(400).json({ detail: 'Invalid research payload (claims + citations must be arrays)' })
  }

  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { dir, jsonPath: sidecarPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    await fs.mkdir(dir, { recursive: true })
    // Editing claims never grants an attestation. Normalize whatever the client
    // sent through the shared reader so a hand-crafted `verification` block
    // can't fake `verified_by` or smuggle in a truthy non-boolean.
    const normalized: ResearchOutput = {
      ...(body as ResearchOutput),
      verification: readResearchVerification(body),
    }
    await fs.writeFile(sidecarPath, JSON.stringify(normalized, null, 2), 'utf-8')
    await invalidateEpisodeStatus(slug, episodeId)
    res.json({ ok: true, sidecar_path: sidecarPath, verification: normalized.verification })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save research sidecar'))
  }
})

// ── POST /projects/:slug/research/:episodeId/verify ───────────────────
// Deliberate human attestation (or withdrawal of one).
//
//   { verified: true }  — "I read this research and checked its claims
//                          against the cited sources." Recorded as
//                          verified_by: 'human'.
//   { verified: false } — un-verify, e.g. after spotting a bad claim.
//
// Verification is per generated output: any regeneration resets it (see
// generators/research.ts), so an old attestation can never carry onto claims
// nobody has read. Auto-verification by the unattended Pipeline is a separate
// path and is stamped verified_by: 'pipeline-auto'.
router.post('/projects/:slug/research/:episodeId/verify', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const wantVerified = (req.body || {}).verified !== false
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { jsonPath: sidecarPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    let existing: ResearchOutput
    try {
      existing = JSON.parse(await fs.readFile(sidecarPath, 'utf-8')) as ResearchOutput
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        return res.status(409).json({
          detail: `No research exists for ${episodeId}, so there is nothing to verify. `
            + 'Run research for this episode first, then verify it.',
        })
      }
      throw e
    }
    // Never let an empty sidecar be attested — that would satisfy the
    // completion gate with no evidence behind it.
    if (wantVerified && !hasResearchEvidence(existing)) {
      return res.status(409).json({
        detail: `Research for ${episodeId} has no summary and no claims, so there is nothing to verify. `
          + 'Re-run research for this episode, then verify it.',
      })
    }
    const next = wantVerified
      ? withResearchVerified(existing, 'human')
      : withResearchUnverified(existing)
    await fs.writeFile(sidecarPath, JSON.stringify(next, null, 2), 'utf-8')
    await invalidateEpisodeStatus(slug, episodeId)
    res.json({ ok: true, verification: next.verification, sidecar_path: sidecarPath })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update research verification'))
  }
})

/** Verification flips rewrite research.json in place; drop the cached episode
 *  status so the Production Board and pending filters see it immediately. */
async function invalidateEpisodeStatus(slug: string, episodeId: string): Promise<void> {
  try {
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, episodeId)
  } catch { /* best-effort — the cache also re-checks research.json's mtime */ }
}

// ── DELETE /projects/:slug/research/:episodeId ────────────────────────
// Drop the sidecar. ENOENT is treated as success — idempotent.
router.delete('/projects/:slug/research/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const { jsonPath: sidecarPath } = await resolveResearchPaths(paths.episode_dir, episodeId)
    try {
      await fs.unlink(sidecarPath)
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
    }
    await invalidateEpisodeStatus(slug, episodeId)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete research sidecar'))
  }
})
