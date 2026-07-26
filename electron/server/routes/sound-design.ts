import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import * as pm from '../services/project-manager.js'
import * as pools from '../services/broll-pool-manager.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import {
  DEFAULT_SOUND_DESIGN_CONFIG,
  normalizeSoundDesignConfig,
  normalizeSoundDesignSettings,
  readSoundDesignTimeline,
  validateSoundDesignTimeline,
  writeSoundDesignTimeline,
} from '../services/sound-design.js'
import type { ScenePlan, SoundDesignCue, SoundDesignTimeline } from '../models/types.js'

export const router = Router()

async function loadPlan(slug: string, episodeId: string): Promise<{ path: string; plan: ScenePlan }> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('Build Scene Plan before working with Sound Design.')
  return { path: planPath, plan: JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan }
}

async function candidates(): Promise<Array<{ pool_id: string; filename: string; tags: string[] }>> {
  const out: Array<{ pool_id: string; filename: string; tags: string[] }> = []
  for (const pool of await pools.listPools()) {
    if (pools.poolMedia(pool) !== 'audio' || !(await pools.isPoolOnline(pool.id))) continue
    for (const clip of await pools.listClips(pool.id, { includeMissing: false })) {
      out.push({ pool_id: pool.id, filename: clip.filename, tags: clip.tags || [] })
    }
  }
  return out
}

router.get('/projects/:slug/sound-design/config', async (req, res) => {
  res.json(normalizeSoundDesignConfig((await pm.getConfig(req.params.slug))?.sound_design))
})

router.put('/projects/:slug/sound-design/config', async (req, res) => {
  const config = normalizeSoundDesignConfig(req.body)
  if (!await pm.updateConfig(req.params.slug, { sound_design: config } as any)) return res.status(404).json({ detail: 'Project not found' })
  res.json(config)
})

router.get('/projects/:slug/sound-design/:episodeId/candidates', async (_req, res) => {
  try { res.json({ candidates: await candidates() }) }
  catch (error: any) { res.status(500).json({ detail: error?.message || 'Could not list local sound assets.' }) }
})

router.get('/projects/:slug/sound-design/:episodeId', async (req, res) => {
  try {
    const { path, plan } = await loadPlan(req.params.slug, req.params.episodeId)
    const config = normalizeSoundDesignConfig((await pm.getConfig(req.params.slug))?.sound_design)
    const timeline = await readSoundDesignTimeline(path)
    res.json({
      config,
      timeline,
      validation: timeline ? validateSoundDesignTimeline(timeline, plan, timeline.settings, { requireResolved: config.enabled }) : [],
      duration_sec: Math.max(0, ...plan.scenes.map(scene => Number(scene.end_sec) || 0)),
    })
  } catch (error: any) { res.status(400).json({ detail: error?.message || 'Could not load Sound Design.' }) }
})

router.put('/projects/:slug/sound-design/:episodeId', async (req, res) => {
  try {
    const { path, plan } = await loadPlan(req.params.slug, req.params.episodeId)
    const raw = Array.isArray(req.body?.cues) ? req.body.cues : null
    if (!raw) return res.status(400).json({ detail: 'cues array is required.' })
    const now = new Date().toISOString()
    const cues = raw.map((cue: any): SoundDesignCue => ({
      id: String(cue.id || ''),
      kind: cue.kind === 'bed' ? 'bed' : 'spot',
      label: String(cue.label || '').trim(),
      start_sec: Number(cue.start_sec),
      ...(cue.kind === 'bed' ? { end_sec: Number(cue.end_sec) } : {}),
      ...(typeof cue.pool_id === 'string' && cue.pool_id ? { pool_id: cue.pool_id } : {}),
      clip: String(cue.clip || ''),
      gain_db: Number(cue.gain_db),
      status: cue.status === 'approved' || cue.status === 'excluded' || cue.status === 'matched' ? cue.status : 'proposed',
      created_at: typeof cue.created_at === 'string' ? cue.created_at : now,
      updated_at: now,
    }))
    const timeline: SoundDesignTimeline = {
      schema_version: 1,
      generated_at: now,
      source_scene_plan_generated_at: plan.generated_at,
      settings: normalizeSoundDesignSettings(req.body?.settings),
      cues,
    }
    const issues = validateSoundDesignTimeline(timeline, plan, timeline.settings)
    if (issues.length) return res.status(422).json({ detail: 'Sound Design timeline is not safe to save.', issues })
    await writeSoundDesignTimeline(path, timeline)
    res.json({ timeline, validation: [] })
  } catch (error: any) { res.status(400).json({ detail: error?.message || 'Could not save Sound Design.' }) }
})

export { DEFAULT_SOUND_DESIGN_CONFIG }
