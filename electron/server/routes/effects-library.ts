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
 *          Living pictures and outlined effects are drawn on the scene's own
 *          moving clip, inside their outline, as the episode render does.
 *   POST /api/projects/:slug/effects-library/:episodeId/outlines
 *        → 1.4.284: store a scene's outline image (body `{ scene_id, label?,
 *          data_base64 }`; white = the part that moves). Checked for size,
 *          colour, emptiness and the scene picture's shape; a hard edge is
 *          feathered. Answers `{ mask }`, the name a `region.mask` uses.
 *          E1 (1.4.287): or `{ scene_id, label?, shapes, feather_px? }` — the
 *          outline drawing tool's ellipses, rectangles and polygons (0..1 of
 *          the picture), drawn at the scene picture's size and stored the same way.
 *          The exact preview also takes `transition_id`: this scene and the next,
 *          joined by that transition through the render's own builder.
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
import { EFFECT_STACK_GROUPS, isSceneStageOverlay, normalizeRegion, normalizeSceneOverlay, type SceneOverlayDocument } from '../contracts/scene-effects.js'
import { withLock } from '../lib/atomic-store.js'
import { OUTLINE_MASK_DIR, drawRegionMask, outlineMaskPath, saveOutlineMask } from '../services/outline-masks.js'
import {
  EXACT_PREVIEW_MAX_SEC,
  EXACT_PREVIEW_SHORT_EDGE,
  effectPreviewCacheEntry,
  effectPreviewStageKey,
  renderEffectPreview,
  renderTransitionPreview,
  resolvePreviewMotion,
  resolvePreviewOverlays,
} from './video.js'
import { canvasForShortEdge } from '../lib/render-canvas.js'
import { probeVideoStream } from '../lib/scene-clip-compat.js'
import os from 'os'
import path from 'path'
import { findActivePreset, flattenVideoAssemblyBundle } from './pipeline.js'
import { normalizeEffectsLook } from '../contracts/effects-look.js'
import { isHiddenMotion } from '../contracts/scene-effect-presets.js'
import { cachedFileForToken, invalidate } from '../services/preview-cache.js'
import { hasDrawtextFilter } from '../lib/ffmpeg-utils.js'
import * as pm from '../services/project-manager.js'

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
    const outlines = (await fs.readdir(`${episodeDir}/${OUTLINE_MASK_DIR}`).catch(() => [] as string[])).filter(name => name.endsWith('.png')).sort()
    res.json({
      file,
      read_error: readError,
      outlines,
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
  episodeDir: string,
): string[] {
  const issues: string[] = []
  const check = (where: string, effects: AppliedEffect[], oneScene = false) => {
    for (const applied of effects) {
      const entry = library.find(candidate => candidate.id === applied.id)
      if (!entry) { issues.push(`${where}: "${applied.id}" is not in the effects library`); continue }
      try {
        const doc = parseSceneOverlayDocument({ ...entry.document, ...(applied.params || {}), kind: entry.document.kind, timing: entry.document.timing })
        // 1.4.284 — outlines belong to one scene's picture. E1: a Living Picture on a wider scope
        // moves every scene with an outline of its name (or inside its shapes), so only an
        // uploaded outline — one scene's file — is refused there.
        const wideLiving = doc.kind === 'living-region' && !doc.region?.mask
        if (isSceneStageOverlay(doc) && !oneScene && !wideLiving) issues.push(`${where}: ${entry.name} has an outline, so it only works in a single scene's stack`)
        else if (doc.kind === 'living-region' && !oneScene) { /* fine: the render names the scenes it moves */ }
        else if (doc.kind === 'living-region' && !doc.region) issues.push(`${where}: ${entry.name} needs an outline (upload one for this scene, or give it shapes)`)
        else if (doc.region?.mask && !existsSync(outlineMaskPath(episodeDir, doc.region.mask))) {
          issues.push(`${where}: ${entry.name} uses the outline "${doc.region.mask}", which has not been uploaded for this episode`)
        }
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
    check(`Scene ${stack.scene_id}`, stack.effects, true)
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
    const issues = validateStacks(file, req.body, library, sceneIds, episodeDir)
    if (issues.length) return res.status(400).json({ detail: `The effects were not saved: ${issues.join('. ')}.`, issues })
    const saved = await withLock(`${episodeDir}/${EPISODE_EFFECTS_FILENAME}`, () => writeEpisodeEffects(episodeDir, file))
    res.json({ file: saved })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not save this episode\'s effects.'))
  }
})

/** The chosen scene's still (else the first), else any scene image, else null for the gradient. */
async function sceneBackdrop(slug: string, episodeId: string, requestedScene: unknown): Promise<string | null> {
  let backdrop: string | null = null
  const { episodeDir, plan } = await episodeContext(slug, episodeId)
  const sceneId = typeof requestedScene === 'string' && SCENE_ID.test(requestedScene) ? requestedScene : plan?.scenes[0]?.id
  if (sceneId) {
    const stored = plan?.scenes.find(scene => scene.id === sceneId)?.image_path
    backdrop = await resolveSceneImageReadPath(slug, episodeId.toUpperCase(), episodeDir, sceneId, stored).catch(() => null)
  }
  if (!backdrop) {
    // No Scene Plan still: the episode's first scene image of any kind, then the gradient.
    try { backdrop = (await scanEpisodeAssets(slug, episodeId)).scenes[0]?.path || null } catch { backdrop = null }
  }
  return backdrop
}

router.post('/projects/:slug/effects-library/:episodeId/outlines', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const sceneId = typeof body.scene_id === 'string' && SCENE_ID.test(body.scene_id) ? body.scene_id : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required: the outline belongs to one scene\'s picture.' })
  const shapes = body.shapes !== undefined ? normalizeRegion({ shapes: body.shapes, feather_px: body.feather_px }) : null
  if (body.shapes !== undefined && !shapes?.shapes?.length) return res.status(400).json({ detail: 'shapes must hold at least one ellipse, rectangle or polygon (3+ points) in 0..1 of the picture.' })
  if (!shapes && (typeof body.data_base64 !== 'string' || !body.data_base64)) return res.status(400).json({ detail: 'data_base64 is required (the outline image, white = the part that moves).' })
  try {
    const { episodeDir, plan } = await episodeContext(slug, episodeId)
    const scene = plan?.scenes.find(candidate => candidate.id === sceneId)
    if (plan && !scene) return res.status(400).json({ detail: `Scene "${sceneId}" is not in this episode's Scene Plan.` })
    const stillPath = await resolveSceneImageReadPath(slug, episodeId.toUpperCase(), episodeDir, sceneId, scene?.image_path).catch(() => null)
    let data: Buffer
    if (shapes) {
      // Drawn at the scene picture's own size (the checks compare shapes), feathered as asked.
      const probed = stillPath ? await probeVideoStream(stillPath) : null
      const still = probed?.width && probed?.height ? { width: Number(probed.width), height: Number(probed.height) } : null
      if (!still) return res.status(400).json({ detail: 'This scene has no picture yet, so there is nothing to draw an outline on.' })
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-outline-draw-'))
      try {
        const png = path.join(dir, 'drawn.png')
        const drawn = await drawRegionMask({ region: shapes, episodeDir, still, outPng: png })
        if (!drawn.ok) return res.status(400).json({ detail: `The outline could not be drawn: ${drawn.reason}.` })
        data = await fs.readFile(png)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    } else {
      data = Buffer.from(body.data_base64.replace(/^data:[^,]*,/, ''), 'base64')
    }
    const saved = await saveOutlineMask({
      episodeDir, sceneId, label: typeof body.label === 'string' ? body.label : undefined,
      data, stillPath,
      channel: { slug, projectDir: pm.getProjectDir(slug) || path.dirname(episodeDir) },
    })
    res.json({ mask: saved.name, ...saved })
  } catch (error: any) {
    res.status(400).json({ detail: String(error?.message || error) })
  }
})

router.post('/projects/:slug/effects-library/:episodeId/exact-preview', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const body = req.body || {}
    const library = await listSceneEffectLibrary()
    if (typeof body.transition_id === 'string' && body.transition_id) {
      // E1 — this scene and the next, each with its camera move, joined by the transition.
      const { plan } = await episodeContext(slug, episodeId)
      const index = Math.max(0, plan?.scenes.findIndex(scene => scene.id === body.scene_id) ?? 0)
      const nextId = plan?.scenes[index + 1]?.id ?? plan?.scenes[0]?.id
      const imgA = await sceneBackdrop(slug, episodeId, body.scene_id)
      const imgB = nextId ? await sceneBackdrop(slug, episodeId, nextId) : imgA
      const { w: W, h: H } = canvasForShortEdge(EXACT_PREVIEW_SHORT_EDGE, body.aspect_ratio)
      const motion = resolvePreviewMotion({ motion_id: typeof body.motion_id === 'string' ? body.motion_id : 'ken-burns' }, library)
      const preview = await renderTransitionPreview({
        id: body.transition_id, imgA, imgB, W, H, fps: 24, motion, ext: 'mp4',
        transitionSec: Math.max(0.5, Math.min(3, Number(body.duration_sec) || 1.5)),
      })
      return res.json({
        url: `/api/projects/${encodeURIComponent(slug)}/video-editor/preview-effect?token=${encodeURIComponent(preview.token)}`,
        token: preview.token, width: W, height: H, duration_sec: preview.duration_sec, render_ms: preview.render_ms,
        camera_engine: preview.camera_engine, backdrop: imgA ? 'scene' : 'gradient',
      })
    }
    const resolved = resolvePreviewOverlays({ ...body, order: body.custom_order ? 'custom' : 'groups' }, library)
    // Living pictures and outlined effects are drawn on the scene's own clip, inside their outline.
    const overlays = resolved.filter(doc => !isSceneStageOverlay(doc))
    const motion = resolvePreviewMotion({ motion_id: typeof body.motion_id === 'string' ? body.motion_id : 'ken-burns' }, library)
    const backdrop = await sceneBackdrop(slug, episodeId, body.scene_id)
    const { episodeDir, plan } = await episodeContext(slug, episodeId)
    // E1 — a Living Picture meant for the whole episode previews with this scene's outline of its name.
    const sceneId = typeof body.scene_id === 'string' && SCENE_ID.test(body.scene_id) ? body.scene_id : plan?.scenes[0]?.id
    const stageDocs = resolved.filter(isSceneStageOverlay).map(doc => {
      if (doc.kind !== 'living-region' || doc.region || !sceneId) return doc
      const mask = `${sceneId.replace(/[^A-Za-z0-9_-]/g, '')}-${doc.outline || doc.motion}.png`
      return existsSync(outlineMaskPath(episodeDir, mask)) ? normalizeSceneOverlay({ ...doc, region: { mask } }) : doc
    })
    const notes: string[] = []
    if (stageDocs.length && !backdrop) notes.push('Living pictures need the scene\'s own picture; this episode has none, so they are not shown.')
    const preview = await renderEffectPreview(motion, overlays, backdrop, body.aspect_ratio, {
      shortEdge: EXACT_PREVIEW_SHORT_EDGE,
      durationSec: Math.min(EXACT_PREVIEW_MAX_SEC, Number(body.duration_sec) || EXACT_PREVIEW_MAX_SEC),
    }, stageDocs.length ? {
      items: stageDocs.map((document, i) => ({ uid: `preview-${i + 1}`, name: document.kind === 'living-region' ? `Living picture (${document.motion})` : `${document.kind === 'atmosphere-loop' ? document.variant : document.kind} in its outline`, document })),
      episodeDir,
      log: line => notes.push(line),
    } : undefined)
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
      ...(stageDocs.length ? { living: preview.living, notes } : {}),
    })
  } catch (error: any) {
    if (error instanceof SceneEffectValidationError) return res.status(400).json({ detail: error.message })
    res.status(500).json(humanizeBackendError(error, 'The exact preview could not be rendered'))
  }
})

// ── The effects gallery (1.4.283, owner: "it's just there to see") ─────────
//
// One 6-second loop per effect (camera still) and per camera move, over this
// episode's scene. Rendered on first view through the preview cache — its own
// two-render gate, never the job queue, so a Video Assembly is never waiting
// on it — and reused until the effect's document changes (the cache key is the
// document), the scene changes, or someone presses Refresh previews.

const GALLERY_SHORT_EDGE = 360
const GALLERY_SEC = 6
const NO_EPISODE = '-'

async function galleryBackdrop(slug: string, episodeId: string, scene: unknown): Promise<string | null> {
  if (episodeId === NO_EPISODE) return null
  return sceneBackdrop(slug, episodeId, scene).catch(() => null)
}

/** 1.4.284 — the gallery has no outline of its own, so a living picture shows over a soft centre oval. */
const GALLERY_OUTLINE = { shapes: [{ type: 'ellipse', cx: 0.5, cy: 0.55, rx: 0.22, ry: 0.28 }], feather_px: 24 }

function galleryStage(docs: SceneOverlayDocument[], id: string) {
  return docs.map((document, i) => ({ uid: `gallery-${i + 1}`, name: id, document }))
}

/** What one gallery clip draws: an overlay over a still picture, or a camera move with nothing on top. */
function galleryItem(kind: string, id: string, library: Awaited<ReturnType<typeof listSceneEffectLibrary>>) {
  if (kind === 'overlay') {
    const overlays = resolvePreviewOverlays({ overlays: [{ id }] }, library)
      .map(doc => doc.kind === 'living-region' && !doc.region ? normalizeSceneOverlay({ ...doc, region: GALLERY_OUTLINE }) : doc)
      // E1 — a 6-second clip would almost never catch a star once every three minutes: one per clip.
      .map(doc => doc.kind === 'shooting-star' ? normalizeSceneOverlay({ ...doc, period_sec: GALLERY_SEC, chance: 1 }) : doc)
    return { motion: null, overlays }
  }
  if (kind === 'motion') return { motion: resolvePreviewMotion({ motion_id: id }, library), overlays: [] }
  throw new SceneEffectValidationError([`unknown gallery kind "${kind}"`])
}

router.get('/projects/:slug/effects-library/:episodeId/gallery/:kind/:id', async (req, res) => {
  const { slug, episodeId, kind, id } = req.params
  try {
    const library = await listSceneEffectLibrary()
    const { motion, overlays } = galleryItem(kind, id, library)
    if (overlays.some(o => o.kind === 'lower-third') && !await hasDrawtextFilter()) {
      return res.status(501).json({ detail: 'This FFmpeg build cannot draw text, so this effect has no preview.' })
    }
    const backdrop = await galleryBackdrop(slug, episodeId, req.query.scene)
    const aspect = typeof req.query.aspect_ratio === 'string' ? req.query.aspect_ratio : undefined
    const stageDocs = overlays.filter(isSceneStageOverlay)
    const preview = await renderEffectPreview(motion, overlays.filter(doc => !isSceneStageOverlay(doc)), backdrop, aspect,
      { shortEdge: GALLERY_SHORT_EDGE, durationSec: GALLERY_SEC },
      stageDocs.length ? { items: galleryStage(stageDocs, id), episodeDir: null } : undefined)
    const file = cachedFileForToken(preview.token)
    if (!file) return res.status(500).json({ detail: 'The preview was rendered but could not be read back.' })
    res.set('Content-Type', file.endsWith('.mp4') ? 'video/mp4' : 'video/webm')
    // The URL carries the effect's version, so a browser copy is safe to keep.
    res.set('Cache-Control', 'private, max-age=86400')
    res.sendFile(file)
  } catch (error: any) {
    if (error instanceof SceneEffectValidationError) return res.status(400).json({ detail: error.message })
    res.status(500).json(humanizeBackendError(error, 'The effect preview could not be rendered'))
  }
})

/** Drop this scene's gallery clips so the next view renders them fresh. Renders nothing itself. */
router.post('/projects/:slug/effects-library/:episodeId/gallery/refresh', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const library = await listSceneEffectLibrary()
    const backdrop = await galleryBackdrop(slug, episodeId, req.body?.scene)
    const aspect = typeof req.body?.aspect_ratio === 'string' ? req.body.aspect_ratio : undefined
    let dropped = 0
    const items = [
      ...library.overlays.map(o => galleryItem('overlay', o.id, library)),
      ...library.scene_motions.filter(m => !isHiddenMotion(m)).map(m => galleryItem('motion', m.id, library)),
    ]
    for (const [i, item] of items.entries()) {
      const stage = item.overlays.filter(isSceneStageOverlay)
      const entry = effectPreviewCacheEntry(item.motion, item.overlays.filter(doc => !isSceneStageOverlay(doc)), backdrop, aspect, { shortEdge: GALLERY_SHORT_EDGE, durationSec: GALLERY_SEC })
      // The Living Picture tile is keyed with its outline too (1.4.287: it used to be missed here).
      const stageKey = stage.length && backdrop && existsSync(backdrop)
        ? await effectPreviewStageKey(galleryStage(stage, i < library.overlays.length ? library.overlays[i]!.id : ''), null)
        : ''
      if (invalidate(entry.key + stageKey, entry.ext)) dropped++
    }
    res.json({ ok: true, dropped })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'The previews could not be refreshed'))
  }
})

/**
 * What this channel's Pipeline batch renders: the built-in effects and camera
 * moves of its active Video Assembly preset, read through the same flattening
 * and the same one-route rules the render and the preflight answer use.
 */
router.get('/projects/:slug/effects-library-in-use', async (req, res) => {
  const { slug } = req.params
  try {
    const config = await pm.getConfig(slug)
    const { preset } = findActivePreset(config, 'video_assembly')
    if (!preset) return res.json({ overlays: [], motions: [], source: null })
    const flat = flattenVideoAssemblyBundle(preset.data ?? preset, '', '') as Record<string, any>
    const look = normalizeEffectsLook(flat, { migrateLegacy: true }).look as Record<string, any>
    const overlays = look.scene_effects?.enabled
      ? (look.scene_effects.overlays || []).filter((o: any) => o?.enabled).map((o: any) => o.id)
      : []
    const motions = [flat.scene_animation?.type, ...(flat.animation_randomize && flat.animation_randomize !== 'off' ? flat.animation_pool || [] : [])]
      .filter((id): id is string => typeof id === 'string' && !!id)
    res.json({ overlays: [...new Set(overlays)], motions: [...new Set(motions)], source: preset.name || preset.id })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not read what this channel uses'))
  }
})
