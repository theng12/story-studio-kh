/**
 * Scene Review routes for the timestamp-driven pipeline (v1.0.144+).
 *
 *   GET  /api/projects/:slug/scene-review/:episodeId
 *      — returns scene_plan + per-scene image-exists status + merged audio path
 *   POST /api/projects/:slug/scene-review/:episodeId/generate-image
 *      — queues one scene_image_generate for { scene_id, model }
 *   POST /api/projects/:slug/scene-review/:episodeId/generate-missing
 *      — bulk-queues scene_image_generate for every scene lacking an image
 *   PUT  /api/projects/:slug/scene-review/:episodeId/approve
 *      — flips approval flag(s) on scene_plan.json; supports per-scene + bulk
 *   GET  /api/projects/:slug/scene-review/:episodeId/image/:sceneId
 *      — streams the scene image PNG (kept within episode dir; strict id match)
 */

import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync, createReadStream } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { downloadImage } from '../lib/kie-client.js'
import { tryRecoverImageFromManifest } from '../lib/manifest-recovery.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { SCENE_IMAGES_SUBFOLDER, resolveSceneImagesDir, resolveSceneImageReadPath } from '../generators/scene-image.js'
import { decodeUploadBuffer } from './image-references.js'
import { readManifest } from '../services/task-manifest.js'
import { resolveApiKeyForProvider } from '../providers/registry.js'
import { registry } from '../providers/registry.js'
import type { ImageModelConfig, JobType, ScenePlan } from '../models/types.js'

export const router = Router()

interface ReviewSceneAugmented {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  transcript_segment: string
  visual_prompt: string
  /** v1.0.468 — image-to-video motion instruction (read-only in Scene Review). */
  motion_prompt?: string
  approved: boolean
  /** Filename in scene_images/ if present; null otherwise. UI uses this
   *  + the image streaming endpoint to render the thumbnail. */
  image_filename: string | null
  boundary_reason?: string
  /** v1.0.359 — the rendered image is STALE: it exists but was rendered from a
   *  different prompt than the scene's current `visual_prompt` (the user
   *  re-prompted in Scene Plan, or edited + saved the prompt in Scene Review,
   *  without re-rendering). Computed from ScenePlanEntry.rendered_prompt, which
   *  the renderer stamps alongside image_path. Always false for images rendered
   *  before this shipped (no rendered_prompt recorded) — no false positives. */
  stale: boolean
}

// ── GET /scene-review/:ep ─────────────────────────────────────────────
router.get('/projects/:slug/scene-review/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) {
      return res.json({ scene_plan: null, scenes: [], audio_path: null, stats: null })
    }
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan

    // Annotate each scene with whether its image exists on disk. v1.0.457 —
    // check the unified named folder first, then the legacy flat scene_images/,
    // so both consolidated and not-yet-consolidated episodes show their renders.
    const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
    const scenes: ReviewSceneAugmented[] = []
    let approvedCount = 0
    let withImageCount = 0
    for (const s of plan.scenes) {
      const filename = `${s.id}.png`
      const exists = existsSync(path.join(namedDir, filename)) || existsSync(path.join(legacyDir, filename))
      if (exists) withImageCount++
      if (s.approved) approvedCount++
      scenes.push({
        id: s.id,
        scene_index: s.scene_index,
        start_sec: s.start_sec,
        end_sec: s.end_sec,
        transcript_segment: s.transcript_segment,
        visual_prompt: s.visual_prompt,
        motion_prompt: s.motion_prompt,  // v1.0.468 — image-to-video instruction
        approved: !!s.approved,
        image_filename: exists ? filename : null,
        boundary_reason: s.boundary_reason,
        // Stale = image on disk but its rendered_prompt no longer matches the
        // current visual_prompt. Unknown rendered_prompt (pre-feature renders)
        // → not stale, so old episodes don't all light up red.
        stale: exists
          && typeof (s as any).rendered_prompt === 'string'
          && (s as any).rendered_prompt !== s.visual_prompt,
      })
    }

    // Locate merged audio for the synced player. Walk merged_audio_dir
    // for the largest .mp3 (same heuristic as broll-assemble's
    // findNarrationPath uses).
    let audioPath: string | null = null
    if (existsSync(paths.merged_audio_dir)) {
      const files = await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])
      let bestSize = 0
      for (const f of files) {
        if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
        const stat = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
        if (stat && stat.size > bestSize) {
          bestSize = stat.size
          audioPath = path.join(paths.merged_audio_dir, f)
        }
      }
    }

    // v1.0.233 — live render status (which scene + reference images are being
    // fed into the model right now). Null/inactive when no render is running.
    let renderStatus: any = null
    try {
      const { RENDER_STATUS_FILENAME } = await import('../generators/continuity-render.js')
      const statusPath = path.join(paths.episode_dir, RENDER_STATUS_FILENAME)
      if (existsSync(statusPath)) {
        const s = JSON.parse(await fs.readFile(statusPath, 'utf-8'))
        if (s?.active) renderStatus = s
      }
    } catch { /* no status / unreadable — leave null */ }

    let activeJob: any = null
    try {
      activeJob = (await jq.getJobs(slug)).find((j: any) =>
        j.episode_id === episodeId
        && j.type === 'continuity_render'
        && (j.status === 'running' || j.status === 'queued')
      ) || null
    } catch {
      // Job metadata is non-critical for this endpoint. A stale/legacy job
      // record must not prevent Scene Review from loading the saved plan.
      activeJob = null
    }

    res.json({
      scene_plan: {
        schema_version: plan.schema_version,
        generated_at: plan.generated_at,
        planner_model: plan.planner_model,
        total_duration_sec: plan.total_duration_sec,
        research_used: plan.research_used,
      },
      scenes,
      audio_path: audioPath,
      render_status: renderStatus,
      active_render_job: activeJob,
      stats: {
        total_scenes: plan.scenes.length,
        approved: approvedCount,
        with_image: withImageCount,
        all_approved: plan.scenes.length > 0 && approvedCount === plan.scenes.length,
      },
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read scene review status'))
  }
})

function enqueueContinuityRender(
  slug: string,
  episodeId: string,
  body: any,
  opts: { singleSceneId?: string } = {},
) {
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) throw new Error('model is required')
  const singleSceneId = opts.singleSceneId || (typeof body.single_scene_id === 'string' ? body.single_scene_id : undefined)
  const dedupeParams = singleSceneId
    ? (p: any) => p.single_scene_id === singleSceneId
    : (p: any) => !p.single_scene_id
  return jq.enqueue({
    project_slug: slug,
    type: 'continuity_render' as JobType,
    episode_id: episodeId,
    title: singleSceneId ? `Repair scene — ${episodeId}` : `Continuity render — ${episodeId}`,
    dedupeParams,
    params: {
      episode_id: episodeId,
      title: typeof body.title === 'string' ? body.title : '',
      model,
      aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
      width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
      height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
      force: body.force === true,
      from_scene_id: typeof body.from_scene_id === 'string' ? body.from_scene_id : undefined,
      single_scene_id: singleSceneId,
      independent: body.independent === true,
      concurrency: body.concurrency === 'auto'
        ? 'auto'
        : (Number.isFinite(Number(body.concurrency)) ? Number(body.concurrency) : undefined),
      prompt_only: body.prompt_only === true,
    },
  })
}

// ── POST /scene-review/:ep/generate-image ─────────────────────────────
router.post('/projects/:slug/scene-review/:episodeId/generate-image', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })
  if (!model) return res.status(400).json({ detail: 'model is required' })

  // Per-scene dedupe — don't re-queue an in-flight regen of the same scene.
  if (jq.isDuplicate(slug, episodeId, 'scene_image_generate' as JobType, (p: any) => p?.scene_id === sceneId)) {
    return res.status(409).json({ detail: `Scene ${sceneId} image already generating` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'scene_image_generate' as JobType,
    episode_id: episodeId,
    title: `Scene ${sceneId.slice(0, 12)} image`,
    params: {
      episode_id: episodeId,
      title: typeof body.title === 'string' ? body.title : '',
      scene_id: sceneId,
      model,
      aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
      width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
      height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
    },
  })
  res.status(201).json(job)
})

// ── POST /scene-review/:ep/generate-missing ───────────────────────────
// Bulk-queue scene_image_generate jobs for every scene that doesn't
// already have an image on disk. Skips scenes already in flight.
router.post('/projects/:slug/scene-review/:episodeId/generate-missing', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })

  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan

    // v1.0.457 — "missing" means missing from BOTH the unified named folder and
    // the legacy flat folder, so an un-consolidated episode isn't re-queued.
    const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
    let queued = 0
    let skipped = 0
    const queuedIds: string[] = []
    for (const s of plan.scenes) {
      const filename = `${s.id}.png`
      if (existsSync(path.join(namedDir, filename)) || existsSync(path.join(legacyDir, filename))) { skipped++; continue }
      if (jq.isDuplicate(slug, episodeId, 'scene_image_generate' as JobType, (p: any) => p?.scene_id === s.id)) {
        skipped++
        continue
      }
      jq.enqueue({
        project_slug: slug,
        type: 'scene_image_generate' as JobType,
        episode_id: episodeId,
        title: `Scene ${s.scene_index} image`,
        params: {
          episode_id: episodeId,
          title: typeof body.title === 'string' ? body.title : '',
          scene_id: s.id,
          model,
          aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
          width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
          height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
        },
      })
      queued++
      queuedIds.push(s.id)
    }
    res.json({ ok: true, queued, skipped, queued_scene_ids: queuedIds })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to queue scene-image jobs'))
  }
})

// ── POST /scene-review/:ep/continuity-render ──────────────────────────
// continuity-chain only — enqueue ONE render job. Two modes:
//   - sequential (default): every scene in order, each img2img-anchored to the
//     previous render + the character sheet/characters (per continuity.json).
//   - independent (body.independent === true): every scene against the static
//     references only (sheet + style + characters, NO prev-render), rendered
//     concurrently through a bounded pool (body.concurrency, default 3) — much
//     faster, trades frame-to-frame continuity for speed.
// Resumable in both modes: pass { force: true } to re-render scenes that
// already have an image.
router.post('/projects/:slug/scene-review/:episodeId/continuity-render', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })

  const singleSceneId = typeof body.single_scene_id === 'string' ? body.single_scene_id : undefined
  // v1.0.244 — scene-aware dedupe. The queue runs ONE continuity_render at a
  // time, so multiple jobs just queue and run back-to-back. A per-scene render
  // (the "Generate (refs)" button → single_scene_id) should therefore only
  // conflict with another render of the SAME scene — different scenes can be
  // fired off in sequence and will queue. A full/parallel render (no
  // single_scene_id) still dedupes against another full render. The old guard
  // blocked ANY second render per episode, which 409'd the per-scene workflow.
  const dedupeParams = singleSceneId
    ? (p: any) => p.single_scene_id === singleSceneId
    : (p: any) => !p.single_scene_id
  if (jq.isDuplicate(slug, episodeId, 'continuity_render' as JobType, dedupeParams)) {
    return res.status(409).json({
      detail: singleSceneId
        ? `That scene is already queued/rendering for ${episodeId}.`
        : `A full render is already running for ${episodeId}.`,
    })
  }

  let job
  try {
    job = jq.enqueue({
      project_slug: slug,
      type: 'continuity_render' as JobType,
      episode_id: episodeId,
      title: singleSceneId ? `Render scene — ${episodeId}` : `Continuity render — ${episodeId}`,
      // Atomic backstop for the pre-check above (the queue's single
      // serialisation point): same scene-aware predicate so concurrent route
      // hits can't both enqueue the same scene.
      dedupeParams,
      params: {
        episode_id: episodeId,
        title: typeof body.title === 'string' ? body.title : '',
        model,
        aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
        // v1.0.261 — explicit render size (local Image Studio models only).
        width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
        height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
        force: body.force === true,
        from_scene_id: typeof body.from_scene_id === 'string' ? body.from_scene_id : undefined,
        single_scene_id: singleSceneId,
        // v1.0.344 — render an explicit SET of scenes in one parallel job (Scene
        // Review "Regenerate selected ⚡" / "all unapproved ⚡"). Distributes
        // across the whole Mac pool instead of N serial single-scene jobs.
        scene_ids: Array.isArray(body.scene_ids)
          ? body.scene_ids.filter((s: any) => typeof s === 'string')
          : undefined,
        // v1.0.241 — independent/parallel mode (no prev-render reference).
        independent: body.independent === true,
        concurrency: body.concurrency === 'auto'
          ? 'auto'
          : (Number.isFinite(Number(body.concurrency)) ? Number(body.concurrency) : undefined),
        // v1.0.254 — prompt-only (text2img): send no reference images at all.
        prompt_only: body.prompt_only === true,
      },
    })
  } catch (e: any) {
    // Lost the atomic dedupe race — surface as a clean 409 (no async error
    // boundary in this app, so an unhandled throw would hang the request).
    if (e instanceof jq.DuplicateJobError) {
      return res.status(409).json({
        detail: singleSceneId
          ? `That scene is already queued/rendering for ${episodeId}.`
          : `A full render is already running for ${episodeId}.`,
      })
    }
    throw e
  }
  res.status(201).json(job)
})

// ── POST /scene-review/:ep/repair-image/:sceneId ─────────────────────
// Continuity-chain repair for one missing scene. If a provider task_id was
// recorded, try to recover/download that already-paid result first. If there
// is no recoverable task, queue a fresh single-scene continuity render with
// the usual reference stack.
router.post('/projects/:slug/scene-review/:episodeId/repair-image/:sceneId', async (req, res) => {
  const { slug, episodeId, sceneId } = req.params
  if (!/^[A-Za-z0-9_-]+$/.test(sceneId)) return res.status(400).json({ detail: 'invalid scene id' })
  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })

  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(s => s.id === sceneId)
    if (!scene) return res.status(404).json({ detail: `scene ${sceneId} not found in scene_plan.json` })

    // v1.0.457 — recover into the unified named folder; treat an image in either
    // the named or legacy flat folder as "already has one".
    const outDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const outPath = path.join(outDir, `${sceneId}.png`)
    const legacyOut = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER, `${sceneId}.png`)
    const hasImage = existsSync(outPath) || existsSync(legacyOut)
    if (hasImage) {
      return res.status(400).json({ detail: 'Scene already has an image. Use Regenerate to create a fresh one.' })
    }

    const config = await pm.getConfig(slug)
    const modelConfig = (config?.image_models?.[model] || { poll: '/jobs/recordInfo' }) as ImageModelConfig
    const providerId = (modelConfig as any).provider || 'kie'
    const imageProvider = registry.getImageProvider(providerId)
    const apiKey = imageProvider
      ? await resolveApiKeyForProvider(slug, imageProvider.meta, { model })
      : ''
    const manifest = await readManifest(outDir)
    const entry = manifest.tasks[`${sceneId}.png`] || null
    const recovered = await tryRecoverImageFromManifest(entry, apiKey, modelConfig)
    if (recovered?.urls?.length) {
      await fs.mkdir(outDir, { recursive: true })
      await downloadImage(recovered.urls[0]!, outPath)
      scene.image_path = outPath
      scene.approved = false
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8')
      return res.json({
        ok: true,
        recovered: true,
        scene_id: sceneId,
        task_id: recovered.taskId,
      })
    }

    const job = enqueueContinuityRender(slug, episodeId, {
      ...body,
      force: true,
      single_scene_id: sceneId,
    }, { singleSceneId: sceneId })
    res.status(201).json({ ok: true, recovered: false, queued: true, job })
  } catch (e: any) {
    if (e instanceof jq.DuplicateJobError) {
      return res.status(409).json({ detail: `That scene is already queued/rendering for ${episodeId}.` })
    }
    res.status(500).json(humanizeBackendError(e, 'Failed to repair continuity scene image'))
  }
})

// ── POST /scene-review/:ep/upload-image/:sceneId ──────────────────────
// v1.0.232 — set a scene's image DIRECTLY from an uploaded file (e.g. a
// free image grabbed from the web), instead of generating it. Saved as the
// scene's render in scene_images/{id}.png and recorded in scene_plan.json.
router.post('/projects/:slug/scene-review/:episodeId/upload-image/:sceneId', async (req, res) => {
  const { slug, episodeId, sceneId } = req.params
  // Strict id (matches the planner's freshId scheme) — prevents path traversal.
  if (!/^[A-Za-z0-9_-]+$/.test(sceneId)) return res.status(400).json({ detail: 'invalid scene id' })
  const buf = decodeUploadBuffer(req.body)
  if (!buf.ok) return res.status(buf.status).json({ detail: buf.detail })
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(s => s.id === sceneId)
    if (!scene) return res.status(404).json({ detail: `scene ${sceneId} not found in scene_plan.json` })

    // v1.0.457 — save uploads into the unified named folder.
    const outDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const outPath = path.join(outDir, `${sceneId}.png`)
    await fs.writeFile(outPath, buf.data)

    scene.image_path = outPath
    scene.approved = false   // user re-approves after a manual swap
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8')
    res.json({ ok: true, scene_id: sceneId })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save uploaded scene image'))
  }
})

// ── PUT /scene-review/:ep/approve ─────────────────────────────────────
// Flip approval flags. Body shapes:
//   { scene_id: '<id>', approved: true|false }   — single scene
//   { all: true|false }                          — bulk all
router.put('/projects/:slug/scene-review/:episodeId/approve', async (req, res) => {
  const { slug, episodeId } = req.params

  const body = req.body || {}
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan

    let changed = 0
    if (typeof body.all === 'boolean') {
      // Bulk path. Only approve scenes that have an image on disk —
      // approving a scene without an image is meaningless (the
      // assembler in 1.0.145 will reject it).
      const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
      const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
      for (const s of plan.scenes) {
        const hasImage = existsSync(path.join(namedDir, `${s.id}.png`)) || existsSync(path.join(legacyDir, `${s.id}.png`))
        const target = body.all && hasImage  // bulk-deny works regardless
        const final = body.all ? target : false
        if (s.approved !== final) {
          s.approved = final
          changed++
        }
      }
    } else if (typeof body.scene_id === 'string') {
      const target = plan.scenes.find(s => s.id === body.scene_id)
      if (!target) return res.status(404).json({ detail: `Scene ${body.scene_id} not found` })
      target.approved = !!body.approved
      changed++
    } else {
      return res.status(400).json({ detail: 'Either { scene_id, approved } or { all } is required' })
    }

    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8')
    const approvedCount = plan.scenes.filter(s => s.approved).length
    res.json({
      ok: true,
      changed,
      stats: {
        total_scenes: plan.scenes.length,
        approved: approvedCount,
        all_approved: plan.scenes.length > 0 && approvedCount === plan.scenes.length,
      },
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update approval'))
  }
})

// ── GET /scene-review/:ep/image/:sceneId ─────────────────────────────
// Stream a scene image by scene id. Strict whitelist on the id format
// (alphanumeric + underscore + dash only) so this can never escape
// the scene_images dir.
router.get('/projects/:slug/scene-review/:episodeId/image/:sceneId', async (req, res) => {
  const { slug, episodeId, sceneId } = req.params
  if (!/^[A-Za-z0-9_-]+$/.test(sceneId)) {
    return res.status(400).json({ detail: 'Invalid scene id' })
  }
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    // v1.0.457 — serve from the unified named folder, falling back to the legacy
    // flat folder so both consolidated and not-yet-consolidated episodes work.
    const imagePath = await resolveSceneImageReadPath(slug, episodeId.toUpperCase(), paths.episode_dir, sceneId)
    if (!imagePath) return res.status(404).json({ detail: 'Image not found' })
    res.setHeader('Content-Type', 'image/png')
    // No-cache so regen + reload picks up the new file without
    // a query-string buster on every request.
    res.setHeader('Cache-Control', 'no-store')
    createReadStream(imagePath).pipe(res)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve scene image'))
  }
})

// ── POST /scene-review/:ep/assemble ──────────────────────────────────
// v1.0.145+ — Queue the final timestamp-driven video assembly. The
// generator enforces the greenlight (rejects when not all_approved),
// so the route is permissive — POST always queues + the job either
// runs or errors out with a clear message. Surfaces the
// `not_yet_approved` state in the pre-flight response so the UI
// doesn't need to round-trip the user through a doomed job.
router.post('/projects/:slug/scene-review/:episodeId/assemble', async (req, res) => {
  const { slug, episodeId } = req.params

  // Pre-flight: refuse here when the plan isn't ready, instead of
  // queuing a job that's going to fail in the executor.
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) {
      return res.status(400).json({ detail: 'No scene_plan.json yet — run Scene Plan first.' })
    }
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const notApproved = plan.scenes.filter(s => !s.approved)
    if (notApproved.length > 0) {
      return res.status(400).json({
        detail: `Greenlight blocked — ${notApproved.length}/${plan.scenes.length} scene(s) not approved.`,
        code: 'NOT_GREENLIT',
      })
    }
  } catch (e: any) {
    return res.status(500).json(humanizeBackendError(e, 'Greenlight check failed'))
  }

  if (jq.isDuplicate(slug, episodeId, 'timestamp_video_assemble' as JobType)) {
    return res.status(409).json({ detail: `Timestamp video assembly already queued for ${episodeId}` })
  }

  const body = req.body || {}
  // v1.0.265 — optional A/V controls. Passed through verbatim; the generator
  // validates + clamps each (and ignores absent ones, preserving prior output).
  const obj = (v: any) => (v && typeof v === 'object' ? v : undefined)
  const job = jq.enqueue({
    project_slug: slug,
    type: 'timestamp_video_assemble' as JobType,
    episode_id: episodeId,
    title: `Assemble timestamp video — ${episodeId}`,
    params: {
      episode_id: episodeId,
      title: typeof body.title === 'string' ? body.title : '',
      music: obj(body.music),
      ambient: obj(body.ambient),
      subtitles: obj(body.subtitles),
      export_settings: obj(body.export_settings),
      transition: obj(body.transition),
    },
  })
  res.status(201).json(job)
})

// ── GET /scene-review/:ep/audio ───────────────────────────────────────
// Stream the merged audio so the page's <audio> element can synced-play
// the scene timeline. Same whitelisted path resolution as the image
// route — never serves anything outside merged_audio_dir.
router.get('/projects/:slug/scene-review/:episodeId/audio', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    if (!existsSync(paths.merged_audio_dir)) return res.status(404).json({ detail: 'No merged audio' })
    // Pick the largest audio file (same heuristic as the status endpoint).
    let audioPath: string | null = null
    let bestSize = 0
    const files = await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])
    for (const f of files) {
      if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
      const stat = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
      if (stat && stat.size > bestSize) {
        bestSize = stat.size
        audioPath = path.join(paths.merged_audio_dir, f)
      }
    }
    if (!audioPath) return res.status(404).json({ detail: 'No merged audio file' })
    const ext = path.extname(audioPath).toLowerCase()
    const mime = ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg'
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'no-store')
    createReadStream(audioPath).pipe(res)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve merged audio'))
  }
})
