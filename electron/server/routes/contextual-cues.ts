import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import {
  DEFAULT_CONTEXTUAL_CUE_CONFIG,
  normalizeContextualCueConfig,
  normalizeContextualCueProposalSettings,
  normalizeContextualCueTemplate,
  readContextualCueProgress,
  removeContextualCueProgress,
  readContextualCueTimeline,
  validateContextualCueTimeline,
  writeContextualCueTimeline,
} from '../services/contextual-cues.js'
import type { ContextualCue, ContextualCueTimeline, JobType, ScenePlan } from '../models/types.js'

export const router = Router()

async function loadPlan(slug: string, episodeId: string): Promise<{ path: string; plan: ScenePlan }> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('Build Scene Plan before working with contextual cues.')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  return { path: planPath, plan }
}

router.get('/projects/:slug/contextual-cues/config', async (req, res) => {
  const config = normalizeContextualCueConfig((await pm.getConfig(req.params.slug))?.contextual_cues)
  res.json(config)
})

router.put('/projects/:slug/contextual-cues/config', async (req, res) => {
  const config = normalizeContextualCueConfig(req.body)
  const ok = await pm.updateConfig(req.params.slug, { contextual_cues: config } as any)
  if (!ok) return res.status(404).json({ detail: 'Project not found' })
  res.json(config)
})

router.get('/projects/:slug/contextual-cues/:episodeId', async (req, res) => {
  try {
    const { path, plan } = await loadPlan(req.params.slug, req.params.episodeId)
    const config = normalizeContextualCueConfig((await pm.getConfig(req.params.slug))?.contextual_cues)
    const timeline = await readContextualCueTimeline(path)
    const proposal_progress = await readContextualCueProgress(path)
    res.json({
      config,
      timeline,
      proposal_progress,
      // Once a project trusts auto_approve_cues, a cue the automatic pass held
      // back can never resolve itself (see assertContextualCueReadiness) —
      // so it should not read here as "you must resolve this before Video
      // Assembly" when that gate no longer requires it.
      validation: validateContextualCueTimeline(timeline, plan, { requireResolved: config.enabled && !config.auto_approve_cues }),
      scenes: plan.scenes.map(scene => ({ id: scene.id, scene_index: scene.scene_index, start_sec: scene.start_sec, end_sec: scene.end_sec, transcript_segment: scene.transcript_segment })),
    })
  } catch (error: any) {
    res.status(400).json({ detail: error?.message || 'Could not load contextual cues.' })
  }
})

router.post('/projects/:slug/contextual-cues/:episodeId/propose', async (req, res) => {
  const { slug, episodeId } = req.params
  const config = normalizeContextualCueConfig((await pm.getConfig(slug))?.contextual_cues)
  if (!config.enabled) return res.status(409).json({ detail: 'Enable Contextual Cues for this project before proposing cues.' })
  try { await loadPlan(slug, episodeId) } catch (error: any) { return res.status(409).json({ detail: error?.message || 'Scene Plan is required.' }) }
  if (jq.isDuplicate(slug, episodeId, 'contextual_cues' as JobType)) {
    return res.status(409).json({ detail: `Contextual Cues is already running for ${episodeId}.` })
  }
  const settings = normalizeContextualCueProposalSettings(req.body)
  if (!settings.model) return res.status(409).json({ detail: 'Choose a live GenStudio model in Contextual Cues before proposing cues.' })
  const job = jq.enqueue({
    project_slug: slug,
    type: 'contextual_cues' as JobType,
    episode_id: episodeId,
    title: `Propose contextual cues — ${episodeId}`,
    params: { episode_id: episodeId, ...settings },
  })
  res.status(201).json(job)
})

router.put('/projects/:slug/contextual-cues/:episodeId', async (req, res) => {
  try {
    const { path, plan } = await loadPlan(req.params.slug, req.params.episodeId)
    const raw = Array.isArray(req.body?.cues) ? req.body.cues : null
    if (!raw) return res.status(400).json({ detail: 'cues array is required.' })
    const now = new Date().toISOString()
    const cues = raw.map((cue: any): ContextualCue => ({
      ...cue,
      id: String(cue.id || ''), scene_id: String(cue.scene_id || ''),
      title: String(cue.title || '').trim(),
      ...(typeof cue.subtitle === 'string' && cue.subtitle.trim() ? { subtitle: cue.subtitle.trim() } : {}),
      start_sec: Number(cue.start_sec), end_sec: Number(cue.end_sec),
      kind: cue.kind === 'location_date' || cue.kind === 'person' || cue.kind === 'chapter' ? cue.kind : 'historical_context',
      placement: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(cue.placement) ? cue.placement : 'top-right',
      template: normalizeContextualCueTemplate(cue.template), entrance: cue.entrance === 'slide' || cue.entrance === 'dissolve' ? cue.entrance : 'fade',
      exit: cue.exit === 'slide' || cue.exit === 'dissolve' ? cue.exit : 'fade',
      status: cue.status === 'approved' || cue.status === 'disabled' ? cue.status : 'proposed',
      created_at: typeof cue.created_at === 'string' ? cue.created_at : now, updated_at: now,
    }))
    const timeline: ContextualCueTimeline = {
      schema_version: 1, generated_at: now, source_scene_plan_generated_at: plan.generated_at, cues,
    }
    const issues = validateContextualCueTimeline(timeline, plan)
    if (issues.length) return res.status(422).json({ detail: 'Cue timeline is not safe to save.', issues })
    await writeContextualCueTimeline(path, timeline)
    await removeContextualCueProgress(path)
    res.json({ timeline, validation: [] })
  } catch (error: any) {
    res.status(400).json({ detail: error?.message || 'Could not save contextual cues.' })
  }
})

// Exported for a tiny route contract test and to make the default visible at
// the boundary, rather than hiding it in a frontend-only assumption.
export { DEFAULT_CONTEXTUAL_CUE_CONFIG }
