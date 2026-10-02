import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import {
  DEFAULT_CONTEXTUAL_CUE_CONFIG,
  normalizeContextualCueConfig,
  normalizeContextualCueProposalSettings,
  normalizeContextualCueTemplate,
  normalizeCuePlacement,
  normalizeCuePositionPair,
  readContextualCueProgress,
  readContextualCueTimeline,
  validateContextualCueTimeline,
  writeContextualCueTimeline,
} from '../services/contextual-cues.js'
import type { ContextualCue, ContextualCueTimeline, JobType, ScenePlan } from '../models/types.js'
import { withLock } from '../lib/atomic-store.js'
import { findFreshActionJob, readOperationId, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'

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
    res.status(400).json(humanizeBackendError(error, 'Could not load contextual cues.'))
  }
})

router.post('/projects/:slug/contextual-cues/:episodeId/propose', async (req, res) => {
  const { slug, episodeId } = req.params
  const config = normalizeContextualCueConfig((await pm.getConfig(slug))?.contextual_cues)
  if (!config.enabled) return res.status(409).json({ detail: 'Enable Contextual Cues for this project before proposing cues.' })
  try { await loadPlan(slug, episodeId) } catch (error: any) { return res.status(409).json({ detail: error?.message || 'Scene Plan is required.' }) }
  const settings = normalizeContextualCueProposalSettings(req.body)
  if (!settings.model) return res.status(409).json({ detail: 'Choose a live GenStudio model in Contextual Cues before proposing cues.' })
  let operationId: string
  try { operationId = readOperationId(req.body, true)! } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  const params = stampFreshGenerationAction({ episode_id: episodeId, ...settings }, operationId)
  return withLock(`fresh-contextual-cues:${slug}:${operationId}`, async () => {
    const previous = findFreshActionJob(await jq.getJobs(slug), operationId)
    if (previous) {
      if (previous.params.generation_action_fingerprint !== params.generation_action_fingerprint) {
        return res.status(409).json({ detail: 'This operation_id already belongs to a different contextual-cue request.' })
      }
      return res.status(200).json({ ...previous, reused: true })
    }
    if (jq.isDuplicate(slug, episodeId, 'contextual_cues' as JobType)) {
      return res.status(409).json({ detail: `Contextual Cues is already running for ${episodeId}.` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'contextual_cues' as JobType,
      episode_id: episodeId,
      title: `Propose contextual cues — ${episodeId}`,
      params,
    })
    return res.status(201).json(job)
  })
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
      placement: normalizeCuePlacement(cue.placement),
      ...normalizeCuePositionPair(cue.position_x_pct, cue.position_y_pct),
      template: normalizeContextualCueTemplate(cue.template), entrance: cue.entrance === 'slide' || cue.entrance === 'dissolve' ? cue.entrance : 'fade',
      exit: cue.exit === 'slide' || cue.exit === 'dissolve' ? cue.exit : 'fade',
      status: cue.status === 'approved' || cue.status === 'disabled' ? cue.status : 'proposed',
      created_at: typeof cue.created_at === 'string' ? cue.created_at : now, updated_at: now,
    }))
    // A hold reason stays with its cue while that cue is still awaiting review.
    const stillProposed = new Set(cues.filter((cue: ContextualCue) => cue.status === 'proposed').map((cue: ContextualCue) => cue.id))
    const holds = ((await readContextualCueTimeline(path))?.auto_approval_holds || []).filter(hold => stillProposed.has(hold.cue_id))
    const timeline: ContextualCueTimeline = {
      schema_version: 1, generated_at: now, source_scene_plan_generated_at: plan.generated_at, cues,
      ...(holds.length ? { auto_approval_holds: holds } : {}),
    }
    const issues = validateContextualCueTimeline(timeline, plan)
    // Only errors refuse the save. A warning is a note for the person editing
    // — it comes back with the saved timeline so the page can show it, rather
    // than standing between them and their own work.
    const blocking = issues.filter(issue => issue.severity !== 'warning')
    if (blocking.length) return res.status(422).json({ detail: 'Cue timeline is not safe to save.', issues: blocking })
    await writeContextualCueTimeline(path, timeline)
    // A partial proposal's progress is kept whether or not a job is running
    // (owner decision 2026-10-03): those batches are already paid for, and the
    // next proposal re-reads this timeline before it writes, so the edit
    // saved here survives it.
    res.json({ timeline, validation: issues })
  } catch (error: any) {
    // v1.3.3 — this route sent `error.message` straight out, so a disk failure
    // reached the page as "EACCES: permission denied, open '/…/contextual_cues
    // .json.54526.1787002021329.rc2eu3.tmp'". Auto-save made that visible on
    // every keystroke rather than once per deliberate click. The humanizer
    // rewrites the errno shapes, redacts secrets and logs the raw trace, and
    // passes ordinary domain messages ("Build Scene Plan before working with
    // contextual cues.") through untouched. The 400 is kept deliberately: the
    // frontend and the route's own tests treat it as "this save was refused".
    res.status(400).json(humanizeBackendError(error, 'Could not save contextual cues.'))
  }
})

// Exported for a tiny route contract test and to make the default visible at
// the boundary, rather than hiding it in a frontend-only assumption.
export { DEFAULT_CONTEXTUAL_CUE_CONFIG }
