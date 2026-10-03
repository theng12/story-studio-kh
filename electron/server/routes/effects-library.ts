/**
 * Effects Library — one episode's effect stacks, and the exact preview.
 *
 *   GET  /api/projects/:slug/effects-library/:episodeId
 *        → the episode's `scene_effects.json`, its Scene Plan scenes (id, number,
 *          window, theme, whether a still exists) and the library catalogue.
 *   PUT  /api/projects/:slug/effects-library/:episodeId
 *        → validate and save the stacks. Strict at this boundary: an unknown
 *          effect, a field the effect does not have, or a scene that is not in
 *          the plan is refused BY NAME rather than saved and silently skipped.
 *   POST /api/projects/:slug/effects-library/:episodeId/exact-preview
 *        → Render Exact Preview: the real FFmpeg graph — camera move, loops,
 *          filters — over the chosen scene's still, 6 s at 960x540. Streams
 *          through the existing `GET /video-editor/preview-effect?token=`.
 */

import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'

import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { resolveSceneImageReadPath } from '../generators/scene-image.js'
import { scanEpisodeAssets } from '../generators/video.js'
import type { ScenePlan } from '../models/types.js'
import { listSceneEffectLibrary } from '../services/style-effect-loader.js'
import {
  EPISODE_EFFECTS_FILENAME,
  emptyEpisodeEffects,
  normalizeEpisodeEffects,
  readEpisodeEffects,
  writeEpisodeEffects,
  type AppliedEffect,
} from '../services/episode-effects.js'
import { SceneEffectValidationError, parseSceneOverlayDocument } from '../contracts/scene-effects-schema.js'
import { BUILT_IN_EFFECT_STACKS } from '../contracts/scene-effect-presets.js'
import { EFFECT_STACK_GROUPS } from '../contracts/scene-effects.js'
import { withLock } from '../lib/atomic-store.js'
import {
  EXACT_PREVIEW_MAX_SEC,
  EXACT_PREVIEW_SHORT_EDGE,
  renderEffectPreview,
  resolvePreviewMotion,
  resolvePreviewOverlays,
} from './video.js'

export const router = Router()

const SCENE_ID = /^[A-Za-z0-9_-]+$/

async function episodeContext(slug: string, episodeId: string): Promise<{ episodeDir: string; plan: ScenePlan | null }> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  let plan: ScenePlan | null = null
  if (existsSync(planPath)) {
    try { plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan } catch { plan = null }
  }
  return { episodeDir: paths.episode_dir, plan }
}

function planScenes(plan: ScenePlan | null) {
  return (plan?.scenes || []).map(scene => ({
    id: scene.id,
    scene_index: scene.scene_index,
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    has_image: !!scene.image_path,
    theme: typeof (scene as any).theme === 'string' && (scene as any).theme.trim() ? String((scene as any).theme).trim() : null,
    // A short line to recognise the scene by — never the whole transcript.
    label: String((scene as any).title || scene.transcript_segment || scene.visual_prompt || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  }))
}

router.get('/projects/:slug/effects-library/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const { episodeDir, plan } = await episodeContext(slug, episodeId)
    let file = emptyEpisodeEffects()
    let readError: string | null = null
    try { file = await readEpisodeEffects(episodeDir) } catch (error: any) { readError = error?.message || String(error) }
    const library = await listSceneEffectLibrary()
    res.json({
      file,
      read_error: readError,
      has_scene_plan: !!plan,
      scenes: planScenes(plan),
      stack_groups: EFFECT_STACK_GROUPS,
      effect_stacks: BUILT_IN_EFFECT_STACKS,
      overlays: library.overlays,
      refusals: library.refusals,
    })
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not load this episode\'s effects.'))
  }
})

/** Every problem with a stack, named, or an empty list. */
function validateStacks(
  file: ReturnType<typeof normalizeEpisodeEffects>,
  raw: any,
  library: Awaited<ReturnType<typeof listSceneEffectLibrary>>['overlays'],
  sceneIds: Set<string> | null,
): string[] {
  const issues: string[] = []
  const check = (where: string, effects: AppliedEffect[]) => {
    for (const applied of effects) {
      const entry = library.find(candidate => candidate.id === applied.id)
      if (!entry) { issues.push(`${where}: "${applied.id}" is not in the effects library`); continue }
      try {
        parseSceneOverlayDocument({ ...entry.document, ...(applied.params || {}), kind: entry.document.kind, timing: entry.document.timing })
      } catch (error: any) {
        const detail = error instanceof SceneEffectValidationError ? error.issues.join('; ') : String(error?.message || error)
        issues.push(`${where}: ${entry.name} — ${detail}`)
      }
    }
  }
  check('Whole episode', file.episode)
  for (const rule of file.themes) check(`Theme "${rule.theme}"`, rule.effects)
  for (const stack of file.scenes) {
    if (sceneIds && !sceneIds.has(stack.scene_id)) issues.push(`Scene "${stack.scene_id}" is not in this episode's Scene Plan`)
    check(`Scene ${stack.scene_id}`, stack.effects)
  }
  // Anything the lenient normaliser dropped (bad id shape, not an object) is
  // reported too, so a save never quietly loses an entry.
  const count = (list: unknown) => (Array.isArray(list) ? list.length : 0)
  const sent = count(raw?.episode)
    + (Array.isArray(raw?.themes) ? raw.themes.reduce((n: number, t: any) => n + count(t?.effects), 0) : 0)
    + (Array.isArray(raw?.scenes) ? raw.scenes.reduce((n: number, t: any) => n + count(t?.effects), 0) : 0)
  const kept = file.episode.length + file.themes.reduce((n, t) => n + t.effects.length, 0) + file.scenes.reduce((n, t) => n + t.effects.length, 0)
  if (sent !== kept) issues.push(`${sent - kept} effect entr${sent - kept === 1 ? 'y was' : 'ies were'} not readable (missing id, or more than 24 in one stack)`)
  return issues
}

router.put('/projects/:slug/effects-library/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const { episodeDir, plan } = await episodeContext(slug, episodeId)
    const file = normalizeEpisodeEffects(req.body)
    const library = (await listSceneEffectLibrary()).overlays
    const sceneIds = plan ? new Set(plan.scenes.map(scene => scene.id)) : null
    const issues = validateStacks(file, req.body, library, sceneIds)
    if (issues.length) return res.status(400).json({ detail: `The effects were not saved: ${issues.join('. ')}.`, issues })
    const saved = await withLock(`${episodeDir}/${EPISODE_EFFECTS_FILENAME}`, () => writeEpisodeEffects(episodeDir, file))
    res.json({ file: saved })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not save this episode\'s effects.'))
  }
})

router.post('/projects/:slug/effects-library/:episodeId/exact-preview', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const body = req.body || {}
    const library = await listSceneEffectLibrary()
    const overlays = resolvePreviewOverlays({ ...body, order: body.custom_order ? 'custom' : 'groups' }, library)
    const motion = resolvePreviewMotion({ motion_id: typeof body.motion_id === 'string' ? body.motion_id : 'ken-burns' }, library)
    let backdrop: string | null = null
    const { episodeDir, plan } = await episodeContext(slug, episodeId)
    const sceneId = typeof body.scene_id === 'string' && SCENE_ID.test(body.scene_id) ? body.scene_id : plan?.scenes[0]?.id
    if (sceneId) {
      const stored = plan?.scenes.find(scene => scene.id === sceneId)?.image_path
      backdrop = await resolveSceneImageReadPath(slug, episodeId.toUpperCase(), episodeDir, sceneId, stored).catch(() => null)
    }
    if (!backdrop) {
      // No Scene Plan still: the episode's first scene image of any kind, then the gradient.
      try { backdrop = (await scanEpisodeAssets(slug, episodeId)).scenes[0]?.path || null } catch { backdrop = null }
    }
    const preview = await renderEffectPreview(motion, overlays, backdrop, body.aspect_ratio, {
      shortEdge: EXACT_PREVIEW_SHORT_EDGE,
      durationSec: Math.min(EXACT_PREVIEW_MAX_SEC, Number(body.duration_sec) || EXACT_PREVIEW_MAX_SEC),
    })
    res.json({
      url: `/api/projects/${encodeURIComponent(slug)}/video-editor/preview-effect?token=${encodeURIComponent(preview.token)}`,
      token: preview.token,
      width: preview.width,
      height: preview.height,
      duration_sec: preview.duration_sec,
      render_ms: preview.render_ms,
      // 'native' = the same Metal camera renderer the episode uses; 'ffmpeg' = the
      // fallback when that helper is not installed (same move, slower to draw).
      camera_engine: preview.camera_engine,
      backdrop: backdrop ? 'scene' : 'gradient',
    })
  } catch (error: any) {
    if (error instanceof SceneEffectValidationError) return res.status(400).json({ detail: error.message })
    res.status(500).json(humanizeBackendError(error, 'The exact preview could not be rendered'))
  }
})
