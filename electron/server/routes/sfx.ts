/**
 * SFX / Sound layer routes — the REST surface for the Video Assembly "Sound"
 * section. The plan is a per-episode sidecar (services/sfx-plan.ts); these
 * endpoints read/write it, run the director LLM, and resolve cues to pool clips.
 *
 *   GET    /projects/:slug/episodes/:code/sfx-plan            — read plan
 *   PUT    /projects/:slug/episodes/:code/sfx-plan            — save edited plan
 *   DELETE /projects/:slug/episodes/:code/sfx-plan            — remove (revert)
 *   POST   /projects/:slug/episodes/:code/sfx-plan/generate   — director + resolve
 *   POST   /projects/:slug/episodes/:code/sfx-plan/resolve    — re-match to pools
 *   GET    /projects/:slug/episodes/:code/sfx-candidates      — pool clips (picker)
 */
import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  readPlan,
  writePlan,
  resolveSfxPlanPath,
  deletePlanAt,
  normalizePlan,
  emptyPlan,
} from '../services/sfx-plan.js'
import { runSfxDirector, type SfxIntensity } from '../services/sfx-director.js'
import { gatherSfxCandidates } from '../services/sfx-resolver.js'
import { resolveWithFetch } from '../services/sfx-autofetch.js'

export const router = Router()

async function collectApiKeys() {
  const [a, o, k] = await Promise.all([
    getApiKey('anthropic').catch(() => ''),
    getApiKey('openai').catch(() => ''),
    getApiKey('kie').catch(() => ''),
  ])
  return { anthropic_api_key: a, openai_api_key: o, kie_api_key: k }
}

const IMAGE_MODEL = /^(imagestudio|kie|fal|runware|replicate):/i

function intensityOf(v: any): SfxIntensity {
  return v === 'minimal' || v === 'rich' ? v : 'moderate'
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
  try {
    const slug = req.params.slug
    const code = req.params.code.toUpperCase()
    const body = req.body || {}
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return res.status(400).json({ detail: 'model is required' })
    if (IMAGE_MODEL.test(model)) {
      return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model. Pick one in Settings → Models.` })
    }

    const paths = await resolveEpisodePathsByCode(slug, code)
    const stitched = path.join(paths.subtitles_dir, `${code}_stitched.srt`)
    if (!existsSync(stitched)) {
      return res.status(409).json({ detail: `No stitched subtitles for ${code}. Run the Subtitles step (and Scene Plan’s stitch) first — the sound director needs the timed transcript.` })
    }
    const cues = parseSrt(await fs.readFile(stitched, 'utf-8'))
    if (!cues.length) {
      return res.status(409).json({ detail: 'The stitched subtitle track has no cues.' })
    }

    const apiKeys = await collectApiKeys()
    const proposed = await runSfxDirector({
      cues,
      model,
      apiKeys,
      intensity: intensityOf(body.intensity),
      visual_hints: Array.isArray(body.visual_hints) ? body.visual_hints : undefined,
      slug,
    })
    // Resolve against the SFX pools; optionally auto-fetch missing cues from
    // Freesound (this is what seeds the pool over time).
    const r = await resolveWithFetch(proposed, {
      autoFetch: body.auto_fetch === true,
      fetchPoolId: typeof body.fetch_pool_id === 'string' ? body.fetch_pool_id : undefined,
    })
    await writePlan(slug, code, paths.episode_dir, r.plan)
    res.json({ ok: true, plan: r.plan, candidate_count: r.candidate_count, fetched: r.fetched, fetch_skipped_reason: r.fetch_skipped_reason })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'SFX director failed'))
  }
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
    const r = await resolveWithFetch(current, {
      autoFetch: body.auto_fetch === true,
      fetchPoolId: typeof body.fetch_pool_id === 'string' ? body.fetch_pool_id : undefined,
    })
    await writePlan(slug, code, paths.episode_dir, r.plan)
    res.json({ ok: true, plan: r.plan, candidate_count: r.candidate_count, fetched: r.fetched, fetch_skipped_reason: r.fetch_skipped_reason })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'SFX resolve failed'))
  }
})
