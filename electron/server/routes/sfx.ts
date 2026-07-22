/**
 * SFX / Sound layer routes — the REST surface for the Video Assembly "Sound"
 * section. The plan is a per-episode sidecar (services/sfx-plan.ts); these
 * endpoints read/write it and resolve cues against local pool clips. Automatic
 * direction remains unavailable until GenStudio exposes a typed SFX route.
 *
 *   GET    /projects/:slug/episodes/:code/sfx-plan            — read plan
 *   PUT    /projects/:slug/episodes/:code/sfx-plan            — save edited plan
 *   DELETE /projects/:slug/episodes/:code/sfx-plan            — remove (revert)
 *   POST   /projects/:slug/episodes/:code/sfx-plan/generate   — unavailable boundary
 *   POST   /projects/:slug/episodes/:code/sfx-plan/resolve    — local pool re-match
 *   GET    /projects/:slug/episodes/:code/sfx-candidates      — pool clips (picker)
 */
import { Router } from 'express'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  readPlan,
  writePlan,
  resolveSfxPlanPath,
  deletePlanAt,
  normalizePlan,
  emptyPlan,
} from '../services/sfx-plan.js'
import { gatherSfxCandidates, resolvePlan } from '../services/sfx-resolver.js'

export const router = Router()

const SFX_GENERATION_UNAVAILABLE = {
  code: 'GENSTUDIO_CAPABILITY_UNAVAILABLE',
  detail: 'Automatic SFX direction and provider fetching are unavailable until GenStudio KH publishes a qualified SFX API. Add sound files to a local SFX pool and create or edit cues manually.',
}

// ── Read / write / delete the plan ───────────────────────────────────────────

router.get('/projects/:slug/episodes/:code/sfx-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    const plan = await readPlan(req.params.slug, code, paths.episode_dir)
    res.json(plan ?? emptyPlan())
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read SFX plan'))
  }
})

router.put('/projects/:slug/episodes/:code/sfx-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    const plan = normalizePlan(req.body)
    const savedAt = await writePlan(req.params.slug, code, paths.episode_dir, plan)
    res.json({ ok: true, path: savedAt, plan })
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to save SFX plan' })
  }
})

router.delete('/projects/:slug/episodes/:code/sfx-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    await deletePlanAt(await resolveSfxPlanPath(req.params.slug, code, paths.episode_dir))
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete SFX plan'))
  }
})

// ── Candidate clips for the swap picker ──────────────────────────────────────

router.get('/projects/:slug/episodes/:code/sfx-candidates', async (_req, res) => {
  try {
    res.json({ candidates: await gatherSfxCandidates() })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list SFX candidates'))
  }
})

// ── Generate (director LLM) + resolve to pool clips ──────────────────────────

router.post('/projects/:slug/episodes/:code/sfx-plan/generate', async (req, res) => {
  void req
  return res.status(501).json(SFX_GENERATION_UNAVAILABLE)
})

// ── Re-resolve the current plan against the pools (no LLM) ────────────────────

router.post('/projects/:slug/episodes/:code/sfx-plan/resolve', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(slug, code)
    const body = req.body || {}
    const current = body && (body.beds || body.spots)
      ? normalizePlan(body)
      : (await readPlan(slug, code, paths.episode_dir)) ?? emptyPlan()
    const candidates = await gatherSfxCandidates()
    const plan = resolvePlan(current, candidates)
    await writePlan(slug, code, paths.episode_dir, plan)
    res.json({ ok: true, plan, candidate_count: candidates.length, fetched: [] })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'SFX resolve failed'))
  }
})
