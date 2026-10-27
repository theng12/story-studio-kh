/**
 * Contextual Cues — now the LABEL half of Sound & Labels (v1.4.365).
 *
 * What stayed: the `contextual_cues` JOB and its propose route. The job type
 * and step id are unchanged on purpose — queued jobs, job history, the
 * Pipeline chain link and every retry already name `contextual_cues`, and
 * renaming them would orphan all of it. (The job itself now proposes labels
 * AND sounds in one pass; see generators/contextual-cues.ts.)
 *
 * What moved: every page-facing read and write, to routes/sound-and-labels.ts,
 * so one response answers for both halves from one plan and one re-anchor pass.
 * The old paths answer 410 with the new address rather than 404, because a 404
 * reads like the feature was deleted.
 */
import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { existsSync } from 'fs'
import {
  DEFAULT_CONTEXTUAL_CUE_CONFIG,
  normalizeContextualCueConfig,
  normalizeContextualCueProposalSettings,
} from '../services/contextual-cues.js'
import type { JobType, ScenePlan } from '../models/types.js'
import { withLock } from '../lib/atomic-store.js'
import { freshActionMatch, readOperationId, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'

export const router = Router()

const RETIRED = {
  detail: 'Contextual Cues is now part of Sound & Labels. Open the Sound & Labels page for this episode.',
  moved_to: '/sound-and-labels',
}

async function loadPlan(slug: string, episodeId: string): Promise<{ path: string; plan: ScenePlan }> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('Build Scene Plan before working with on-screen text or sound.')
  const plan = JSON.parse(await import('fs/promises').then(async fs => fs.readFile(planPath, 'utf8'))) as ScenePlan
  return { path: planPath, plan }
}

// ── The proposal job (kept: queued jobs and history still name it) ─────────

router.post('/projects/:slug/contextual-cues/:episodeId/propose', async (req, res) => {
  const { slug, episodeId } = req.params
  const config = normalizeContextualCueConfig((await pm.getConfig(slug))?.contextual_cues)
  if (!config.enabled) return res.status(409).json({ detail: 'Turn on On-screen text for this project before proposing labels.' })
  try { await loadPlan(slug, episodeId) } catch (error: any) { return res.status(409).json({ detail: error?.message || 'Scene Plan is required.' }) }
  const settings = normalizeContextualCueProposalSettings(req.body)
  if (!settings.model) return res.status(409).json({ detail: 'Choose a live Gateway model in Sound & Labels before proposing.' })
  let operationId: string
  try { operationId = readOperationId(req.body, true)! } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  const params = stampFreshGenerationAction({ episode_id: episodeId, ...settings }, operationId)
  return withLock(`fresh-contextual-cues:${slug}:${operationId}`, async () => {
    const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
    if (previous) {
      if (previous.params.generation_action_fingerprint !== params.generation_action_fingerprint) {
        return res.status(409).json({ detail: 'This operation_id already belongs to a different Sound & Labels request.' })
      }
      return res.status(200).json({ ...previous, reused: true })
    }
    if (jq.isDuplicate(slug, episodeId, 'contextual_cues' as JobType)) {
      return res.status(409).json({ detail: `Sound & Labels is already running for ${episodeId}.` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'contextual_cues' as JobType,
      episode_id: episodeId,
      title: `Propose labels and sounds — ${episodeId}`,
      params,
    })
    return res.status(201).json(job)
  })
})

// ── The old page paths ─────────────────────────────────────────────────────

router.use('/projects/:slug/contextual-cues', (_req, res) => {
  res.status(410).json(RETIRED)
})

// Exported for a tiny route contract test and to make the default visible at
// the boundary, rather than hiding it in a frontend-only assumption.
export { DEFAULT_CONTEXTUAL_CUE_CONFIG }
