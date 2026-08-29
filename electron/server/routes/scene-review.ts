/**
 * Scene Review routes for the timestamp-driven pipeline (v1.0.144+).
 *
 *   GET  /api/projects/:slug/scene-review/:episodeId
 *      — returns scene_plan + per-scene image-exists status + merged audio path
 *   POST /api/projects/:slug/scene-review/:episodeId/generate-image
 *      — queues one scene_image_generate for { scene_id, model }
 *   POST /api/projects/:slug/scene-review/:episodeId/generate-missing
 *      — queues one canonical continuity render for scenes lacking an image
 *   PUT  /api/projects/:slug/scene-review/:episodeId/approve
 *      — flips approval flag(s) on scene_plan.json; supports per-scene + bulk
 *   GET  /api/projects/:slug/scene-review/:episodeId/image/:sceneId
 *      — streams the scene image PNG (kept within episode dir; strict id match)
 */

import express, { Router } from 'express'
import fs from 'fs/promises'
import { existsSync, createReadStream } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'

import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { parseHttpByteRange } from '../lib/http-byte-range.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { SCENE_IMAGES_SUBFOLDER, resolveSceneImagesDir, resolveSceneImageReadPath } from '../generators/scene-image.js'
import { requireSceneClipGenStudioModel, resolveVideoAssetsDir } from '../generators/scene-clip.js'
import { decodeUploadBuffer } from './image-references.js'
import {
  assertScenePromptsRenderable,
  clearLegacyPlannerFallbackReasons,
  inspectScenePromptIntegrity,
} from '../services/scene-prompt-integrity.js'
import {
  assertSubtitleTimelineComplete,
  readSubtitleTimelineIntegrity,
} from '../services/scene-timeline-integrity.js'
import { inspectSceneReviewCompletion } from '../services/scene-review-completion.js'
import type { JobType, SceneClipVariantSelection, ScenePlan } from '../models/types.js'
import { RENDER_STATUS_FILENAME } from '../services/scene-render-status.js'

export const router = Router()

/**
 * v1.4.82 — drop this episode's cached status so the next episode-list read
 * recomputes it from disk.
 *
 * Only `approve` did this, so queueing or uploading scene images left the list
 * answering from a status computed BEFORE the change: the episode's own page
 * said one thing and the selector, the pending filter and the Production Board
 * said another. That is the "Pending only / Steps 10 of 12" vs "Greenlit 100%"
 * split-brain. Same one-liner the scene-plan, scripts and research routes use.
 */
async function invalidateEpisodeStatus(slug: string, episodeId: string): Promise<void> {
  const { episodeStatusCache } = await import('../services/episode-status-cache.js')
  episodeStatusCache.invalidate(slug, episodeId)
}

function requestedSceneClipVariant(body: Record<string, unknown>): SceneClipVariantSelection {
  const operation = typeof body.operation === 'string' ? body.operation.trim() : ''
  const hasDuration = body.duration_seconds !== undefined && body.duration_seconds !== null
  const hasResolution = body.resolution !== undefined && body.resolution !== null
  const duration_seconds = Number(body.duration_seconds)
  const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : ''
  if (!operation || !hasDuration || !hasResolution || !Number.isFinite(duration_seconds) || duration_seconds <= 0 || !resolution) {
    throw new Error('operation, duration_seconds and resolution must name one published motion variant')
  }
  return { operation, duration_seconds, resolution }
}

function streamLocalMedia(
  req: express.Request,
  res: express.Response,
  filePath: string,
  mime: string,
  size: number,
): void {
  res.setHeader('Content-Type', mime)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Accept-Ranges', 'bytes')

  const range = parseHttpByteRange(req.headers.range, size)
  if (range.kind === 'invalid') {
    res.status(416)
    res.setHeader('Content-Range', `bytes */${size}`)
    res.end()
    return
  }
  if (range.kind === 'full') {
    res.setHeader('Content-Length', String(size))
    createReadStream(filePath).pipe(res)
    return
  }

  const contentLength = range.end - range.start + 1
  res.status(206)
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  res.setHeader('Content-Length', String(contentLength))
  createReadStream(filePath, { start: range.start, end: range.end }).pipe(res)
}

async function validateSceneRenderRequest(slug: string, episodeId: string, sceneIds?: string[]) {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('No scene_plan.json yet')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episodeId)
  assertScenePromptsRenderable(plan.scenes, sceneIds)
  return { paths, plan, planPath }
}

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
  /** v1.0.470 — an animated clip (mp4) exists for this scene in "11 Video Assets". */
  clip_exists?: boolean
  /** v1.0.470 — the clip exists but was rendered from a now-changed motion prompt. */
  clip_stale?: boolean
  /** Explicit Motion Review decision. Undefined is a legacy accepted clip. */
  motion_choice?: 'pending' | 'clip' | 'still'
}

/** Guard failures raised from inside a `withLock` body, where an Express
 *  `return res.status(...)` cannot short-circuit the handler. Mapped back to the
 *  same status codes by the approval route's catch. */
class SceneNotFound extends Error {
  constructor(readonly sceneId: string) { super(`Scene ${sceneId} not found`) }
}
class BadApprovalRequest extends Error {}

// ── GET /scene-review/:ep ─────────────────────────────────────────────
router.get('/projects/:slug/scene-review/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) {
      return res.json({ scene_plan: null, scenes: [], audio_path: null, stats: null })
    }
    let plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    if (clearLegacyPlannerFallbackReasons(plan.scenes)) {
      // A read path that writes. Re-read under the lock and strip the legacy
      // reasons from THAT copy, or this GET can silently undo whatever a running
      // job wrote between its own read and this migration.
      plan = await withLock(planPath, async () => {
        const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
        if (clearLegacyPlannerFallbackReasons(fresh.scenes)) await writeJsonAtomic(planPath, fresh)
        return fresh
      })
    }
    const promptIntegrity = inspectScenePromptIntegrity(plan.scenes)
    const subtitleIntegrity = await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId)

    // Annotate each scene with whether its image exists on disk. v1.0.457 —
    // check the unified named folder first, then the legacy flat scene_images/,
    // so both consolidated and not-yet-consolidated episodes show their renders.
    const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
    // v1.0.470 — clips live in the "11 Video Assets" folder as <scene_id>.mp4.
    const clipsDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyNumberedPattern = new RegExp(`^${episodeId.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_Scene\\d+_v\\d+\\.(?:png|jpe?g|webp)$`, 'i')
    const legacyUnmappedImages = (await fs.readdir(namedDir).catch(() => [] as string[]))
      .filter(filename => legacyNumberedPattern.test(filename)).length
    const scenes: ReviewSceneAugmented[] = []
    const imageReady: boolean[] = []
    let approvedCount = 0
    let withImageCount = 0
    let withClipCount = 0
    let motionReviewedCount = 0
    for (const s of plan.scenes) {
      const filename = `${s.id}.png`
      const exists = existsSync(path.join(namedDir, filename)) || existsSync(path.join(legacyDir, filename))
      imageReady.push(exists)
      if (exists) withImageCount++
      if (s.approved) approvedCount++
      // v1.0.470 — clip existence + stale (rendered from a now-changed motion prompt).
      const clipExists = existsSync(path.join(clipsDir, `${s.id}.mp4`))
      const clipStale = clipExists && (
        (typeof s.rendered_motion_prompt === 'string' && s.rendered_motion_prompt !== (s.motion_prompt || ''))
        || (typeof s.image_version === 'string' && s.clip_source_image_version !== s.image_version)
      )
      if (clipExists) withClipCount++
      if (s.motion_choice === 'still' || (clipExists && !clipStale && (s.motion_choice === 'clip' || s.motion_choice == null))) {
        motionReviewedCount++
      }
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
        // v1.0.470 — clip animation status.
        clip_exists: clipExists,
        clip_stale: clipStale,
        motion_choice: s.motion_choice,
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

    let activeJob: any = null
    try {
      activeJob = (await jq.getJobs(slug)).find((j: any) =>
        j.episode_id === episodeId
        && (j.type === 'continuity_render' || j.type === 'scene_images_batch')
        && (j.status === 'running' || j.status === 'queued' || j.status === 'paused')
      ) || null
    } catch {
      // Job metadata is non-critical for this endpoint. A stale/legacy job
      // record must not prevent Scene Review from loading the saved plan.
      activeJob = null
    }

    // A sidecar is only live when it names the same queue-owned render. This
    // protects Scene Review from a marker left behind by a crash or cleared
    // terminal history; the queue remains the source of truth for activity.
    let renderStatus: any = null
    if (activeJob) {
      try {
        const statusPath = path.join(paths.episode_dir, RENDER_STATUS_FILENAME)
        if (existsSync(statusPath)) {
          const s = JSON.parse(await fs.readFile(statusPath, 'utf-8'))
          if (s?.active && s.job_id === activeJob.job_id) renderStatus = s
        }
      } catch { /* no status / unreadable — leave null */ }
    }

    // v1.0.474 — surface the per-project animation duration floor so external
    // animators (e.g. the Chrome i2v extension) apply the SAME rule the in-app
    // bulk clip generator does: animate a scene only if approved + has a motion
    // prompt + (end_sec − start_sec) ≥ animate_min_seconds + no fresh clip.
    const cfg = await pm.getConfig(slug).catch(() => null)
    const animateMinSeconds = Math.max(0, Number((cfg as any)?.animate_min_seconds) || 0)

    const reviewCompletion = inspectSceneReviewCompletion(
      plan.scenes,
      imageReady,
      promptIntegrity.complete && subtitleIntegrity.complete,
    )

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
      animate_min_seconds: animateMinSeconds,
      prompt_integrity: promptIntegrity,
      subtitle_integrity: subtitleIntegrity,
      stats: {
        total_scenes: plan.scenes.length,
        approved: approvedCount,
        with_image: withImageCount,
        all_approved: reviewCompletion.complete,
        with_clip: withClipCount,
        motion_reviewed: motionReviewedCount,
        all_motion_reviewed: plan.scenes.length > 0 && motionReviewedCount === plan.scenes.length,
        legacy_unmapped_images: legacyUnmappedImages,
      },
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read scene review status'))
  }
})

async function enqueueContinuityRender(
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
  return await jq.enqueue({
    project_slug: slug,
    type: 'continuity_render' as JobType,
    episode_id: episodeId,
    title: singleSceneId ? `Render scene — ${episodeId}` : `Scene image batch — ${episodeId}`,
    dedupeParams,
    params: {
      episode_id: episodeId,
      title: typeof body.title === 'string' ? body.title : '',
      model,
      aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
      resolution: typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : undefined,
      width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
      height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
      seed: Number.isInteger(body.seed) ? body.seed : undefined,
      force: body.force === true,
      render_attempt_id: typeof body.render_attempt_id === 'string' && body.render_attempt_id.trim()
        ? body.render_attempt_id.trim()
        : (body.force === true ? randomUUID() : undefined),
      single_scene_id: singleSceneId,
      scene_ids: Array.isArray(body.scene_ids)
        ? body.scene_ids.filter((s: any) => typeof s === 'string')
        : undefined,
      missing_only: body.missing_only === true,
      auto_approve_generated: body.auto_approve_generated === true,
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

  try {
    await validateSceneRenderRequest(slug, episodeId, [sceneId])
    // Per-scene dedupe — don't re-queue an in-flight regen of the same scene.
    if (jq.isDuplicate(slug, episodeId, 'scene_image_generate' as JobType, (p: any) => p?.scene_id === sceneId)) {
      return res.status(409).json({ detail: `Scene ${sceneId} image already generating` })
    }

    const job = await jq.enqueue({
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
        resolution: typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : undefined,
        width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
        height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
          seed: Number.isInteger(body.seed) ? body.seed : undefined,
        auto_approve_generated: body.auto_approve_generated === true,
      },
    })
    await invalidateEpisodeStatus(slug, episodeId)
    res.status(201).json(job)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Scene image is not ready to generate'))
  }
})

// ── POST /scene-review/:ep/generate-missing ───────────────────────────
// Queue one canonical continuity_render job for every missing scene. The
// renderer itself batches local Hub work across the fleet and preserves
// verified partial outputs, so Scene Review and Pipeline share one owner.
router.post('/projects/:slug/scene-review/:episodeId/generate-missing', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })

  try {
    const { paths, plan } = await validateSceneRenderRequest(slug, episodeId)

    // v1.0.457 — "missing" means missing from BOTH the unified named folder and
    // the legacy flat folder, so an un-consolidated episode isn't re-queued.
    const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
    let skipped = 0
    const aspect_ratio = typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9'
    const width = typeof body.width === 'number' && body.width > 0 ? body.width : undefined
    const height = typeof body.height === 'number' && body.height > 0 ? body.height : undefined

    // Scenes with no image AND no individual render already in flight.
    const missing = plan.scenes.filter((s) => {
      const filename = `${s.id}.png`
      if (existsSync(path.join(namedDir, filename)) || existsSync(path.join(legacyDir, filename))) { skipped++; return false }
      if (jq.isDuplicate(slug, episodeId, 'scene_image_generate' as JobType, (p: any) => p?.scene_id === s.id)) { skipped++; return false }
      return true
    })

    if (missing.length === 0) {
      return res.json({ ok: true, queued: 0, skipped, queued_scene_ids: [] })
    }

    const existing = jq.getActiveBulkSceneRenderJob(slug, episodeId)
    if (existing) {
      return res.json({
        ok: true,
        queued: 0,
        skipped,
        reused: true,
        job_id: existing.job_id,
        queued_scene_ids: missing.map((s) => s.id),
      })
    }

    try {
      const job = await enqueueContinuityRender(slug, episodeId, {
        ...body,
        model,
        aspect_ratio,
        width,
        height,
        scene_ids: missing.map((s) => s.id),
        missing_only: true,
      })
      await invalidateEpisodeStatus(slug, episodeId)
      return res.json({
        ok: true,
        queued: missing.length,
        skipped,
        batched: true,
        job_id: job.job_id,
        queued_scene_ids: missing.map((s) => s.id),
      })
    } catch (e: any) {
      // Another request won the atomic enqueue race. Reuse that owner instead
      // of surfacing a false failure or submitting a second Hub workload.
      if (e instanceof jq.DuplicateJobError) {
        const winner = jq.getActiveBulkSceneRenderJob(slug, episodeId)
        if (winner) {
          return res.json({
            ok: true,
            queued: 0,
            skipped,
            reused: true,
            job_id: winner.job_id,
            queued_scene_ids: missing.map((s) => s.id),
          })
        }
      }
      throw e
    }
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Failed to queue scene-image jobs'))
  }
})

// ── POST /scene-review/:ep/generate-clip ──────────────────────────────
// v1.0.470 — Phase 2: animate ONE scene's image into a clip via an i2v model.
router.post('/projects/:slug/scene-review/:episodeId/generate-clip', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })
  if (!model) return res.status(400).json({ detail: 'model is required' })
  let requestedVariant: SceneClipVariantSelection
  try { requestedVariant = requestedSceneClipVariant(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }

  try {
    const { modelId, variant } = await requireSceneClipGenStudioModel(model, requestedVariant)
    if (jq.isDuplicate(slug, episodeId, 'scene_clip_generate' as JobType, (p: any) => p?.scene_id === sceneId)) {
      return res.status(409).json({ detail: `Scene ${sceneId} clip already generating` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'scene_clip_generate' as JobType,
      episode_id: episodeId,
      title: `Scene ${sceneId.slice(0, 12)} clip`,
      params: {
        episode_id: episodeId,
        scene_id: sceneId,
        model: `genstudio-video:${modelId}`,
        aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
        operation: variant.operation,
        duration_seconds: variant.duration_seconds,
        resolution: variant.resolution,
        auto_approve_clip: body.auto_approve_clip === true,
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(409).json(humanizeBackendError(e, 'GenStudio motion model is unavailable'))
  }
})

// One durable episode-level owner used by Pipeline and Job Retry. Unlike the
// per-scene fan-out below, this runs a strict preflight before any provider
// submission and verifies the complete selected motion stage at the end.
router.post('/projects/:slug/scene-review/:episodeId/generate-clips-batch', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  let requestedVariant: SceneClipVariantSelection
  try { requestedVariant = requestedSceneClipVariant(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }
  try {
    const { modelId, variant } = await requireSceneClipGenStudioModel(model, requestedVariant)
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'scene_clips_batch' as JobType,
      episode_id: episodeId,
      title: `Motion clips — ${episodeId}`,
      params: {
        episode_id: episodeId,
        model: `genstudio-video:${modelId}`,
        aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
        operation: variant.operation,
        duration_seconds: variant.duration_seconds,
        resolution: variant.resolution,
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    if (e instanceof jq.DuplicateJobError) return res.status(409).json({ detail: e.message })
    res.status(409).json(humanizeBackendError(e, 'GenStudio motion model is unavailable'))
  }
})

// ── POST /scene-review/:ep/generate-missing-clips ─────────────────────
// v1.0.470 — bulk-queue scene_clip_generate for every scene that HAS an image
// + a motion prompt but no clip yet (or whose clip is stale). Skips in-flight.
router.post('/projects/:slug/scene-review/:episodeId/generate-missing-clips', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  let requestedVariant: SceneClipVariantSelection
  try { requestedVariant = requestedSceneClipVariant(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }

  try {
    const { modelId, variant } = await requireSceneClipGenStudioModel(model, requestedVariant)
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan

    const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
    const clipsDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    // v1.0.474 — animation gating:
    //  • approved-only: never spend a clip on an image you haven't greenlit.
    //  • duration floor (animate_min_seconds, per-project): short scenes (e.g.
    //    2–3s beats) stay stills — no point animating them.
    //  • motion_prompt presence stays the per-scene include/exclude override.
    const cfg = await pm.getConfig(slug).catch(() => null)
    const animateMinSeconds = Math.max(0, Number((cfg as any)?.animate_min_seconds) || 0)
    let queued = 0
    let skipped = 0
    const queuedIds: string[] = []
    for (const s of plan.scenes) {
      const hasImage = existsSync(path.join(namedDir, `${s.id}.png`)) || existsSync(path.join(legacyDir, `${s.id}.png`))
      const hasMotion = !!(s.motion_prompt && s.motion_prompt.trim())
      const longEnough = (s.end_sec - s.start_sec) >= animateMinSeconds
      const clipExists = existsSync(path.join(clipsDir, `${s.id}.mp4`))
      const clipStale = clipExists && (
        (typeof s.rendered_motion_prompt === 'string' && s.rendered_motion_prompt !== (s.motion_prompt || ''))
        || (typeof s.image_version === 'string' && s.clip_source_image_version !== s.image_version)
      )
      // Animate scenes that are approved + ready (image + motion) + long enough,
      // and not already freshly clipped. Skip in-flight.
      if (!s.approved || !hasImage || !hasMotion || !longEnough || (clipExists && !clipStale)) { skipped++; continue }
      if (jq.isDuplicate(slug, episodeId, 'scene_clip_generate' as JobType, (p: any) => p?.scene_id === s.id)) { skipped++; continue }
      await jq.enqueue({
        project_slug: slug,
        type: 'scene_clip_generate' as JobType,
        episode_id: episodeId,
        title: `Scene ${s.scene_index} clip`,
        params: {
          episode_id: episodeId,
          scene_id: s.id,
          model: `genstudio-video:${modelId}`,
          aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
          operation: variant.operation,
          duration_seconds: variant.duration_seconds,
          resolution: variant.resolution,
        },
      })
      queued++
      queuedIds.push(s.id)
    }
    res.json({ ok: true, queued, skipped, queued_scene_ids: queuedIds })
  } catch (e: any) {
    res.status(409).json(humanizeBackendError(e, 'GenStudio motion model is unavailable'))
  }
})

// ── POST /scene-review/:ep/continuity-render ──────────────────────────
// Queue one GenStudio-owned text-to-image batch. The route name and job type
// remain stable internal identifiers; reference chaining and caller-selected
// concurrency no longer exist.
router.post('/projects/:slug/scene-review/:episodeId/continuity-render', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })

  const singleSceneId = typeof body.single_scene_id === 'string' ? body.single_scene_id : undefined
  const requestedSceneIds = Array.isArray(body.scene_ids)
    ? body.scene_ids.filter((s: any) => typeof s === 'string')
    : (singleSceneId ? [singleSceneId] : undefined)
  try {
    await validateSceneRenderRequest(slug, episodeId, requestedSceneIds)
  } catch (e: any) {
    return res.status(400).json(humanizeBackendError(e, 'Scene images are not ready to render'))
  }
  // Scene-aware dedupe allows different single-scene corrections to queue while
  // preserving one canonical owner for a full episode batch.
  const dedupeParams = singleSceneId
    ? (p: any) => p.single_scene_id === singleSceneId
    : (p: any) => !p.single_scene_id
  const existingBulk = !singleSceneId ? jq.getActiveBulkSceneRenderJob(slug, episodeId) : null
  if (existingBulk) {
    return res.json({ ...existingBulk, reused: true })
  }
  if (jq.isDuplicate(slug, episodeId, 'continuity_render' as JobType, dedupeParams)) {
    return res.status(409).json({
      detail: singleSceneId
        ? `That scene is already queued/rendering for ${episodeId}.`
        : `A full render is already running for ${episodeId}.`,
    })
  }

  let job
  try {
    job = await jq.enqueue({
      project_slug: slug,
      type: 'continuity_render' as JobType,
      episode_id: episodeId,
      title: singleSceneId ? `Render scene — ${episodeId}` : `Scene image batch — ${episodeId}`,
      // Atomic backstop for the pre-check above (the queue's single
      // serialisation point): same scene-aware predicate so concurrent route
      // hits can't both enqueue the same scene.
      dedupeParams,
      params: {
        episode_id: episodeId,
        title: typeof body.title === 'string' ? body.title : '',
        model,
        aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '16:9',
        resolution: typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : undefined,
        width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
        height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
          seed: Number.isInteger(body.seed) ? body.seed : undefined,
        force: body.force === true,
        render_attempt_id: typeof body.render_attempt_id === 'string' && body.render_attempt_id.trim()
          ? body.render_attempt_id.trim()
          : (body.force === true ? randomUUID() : undefined),
        single_scene_id: singleSceneId,
        scene_ids: requestedSceneIds,
        auto_approve_generated: body.auto_approve_generated === true,
      },
    })
  } catch (e: any) {
    // Lost the atomic dedupe race — surface as a clean 409 (no async error
    // boundary in this app, so an unhandled throw would hang the request).
    if (e instanceof jq.DuplicateJobError) {
      if (!singleSceneId) {
        const winner = jq.getActiveBulkSceneRenderJob(slug, episodeId)
        if (winner) return res.json({ ...winner, reused: true })
      }
      return res.status(409).json({
        detail: singleSceneId
          ? `That scene is already queued/rendering for ${episodeId}.`
          : `A full render is already running for ${episodeId}.`,
      })
    }
    throw e
  }
  await invalidateEpisodeStatus(slug, episodeId)
  res.status(201).json(job)
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

    // The image file is on disk; stamping the plan is a read-modify-write and
    // takes the same lock every other writer of this file takes.
    await withLock(planPath, async () => {
      const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      const target = fresh.scenes.find(item => item.id === sceneId)
      if (!target) throw new Error(`scene ${sceneId} not found in scene_plan.json`)
      target.image_path = outPath
      // v1.0.473 — stamp rendered_prompt = visual_prompt so an externally-ingested
      // image (made FROM this prompt) isn't mis-flagged stale in Scene Review.
      target.rendered_prompt = target.visual_prompt
      target.image_version = new Date().toISOString()
      target.motion_choice = 'pending'
      target.approved = false   // user re-approves after a manual swap
      await writeJsonAtomic(planPath, fresh)
    })
    await invalidateEpisodeStatus(slug, episodeId)
    res.json({ ok: true, scene_id: sceneId })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save uploaded scene image'))
  }
})

// ── POST /scene-review/:ep/upload-clip/:sceneId ───────────────────────
// v1.0.473 — set a scene's animated CLIP directly from an externally-generated
// mp4 (e.g. a Chrome-extension image→motion-prompt→video flow), instead of
// generating it in-app via fal/kie. Saved as <11 Video Assets>/<id>.mp4 — the
// SAME location + filename the in-app generator writes and the timestamp
// assembler scans for (it detects a scene's clip by file existence, not by
// scene_plan.clip_path) — so external clips and fal/kie clips are fully
// interchangeable per scene, and either makes the clip flow into the final video.
//
// Raw binary body (Content-Type: video/mp4 or application/octet-stream) because
// the app-wide JSON limit is 10mb; this route takes its own 256mb cap. No body
// metadata needed: scene id is in the URL and the motion prompt is read from the
// plan.
const clipUpload = express.raw({ type: ['video/mp4', 'application/octet-stream'], limit: '256mb' })
router.post('/projects/:slug/scene-review/:episodeId/upload-clip/:sceneId', clipUpload, async (req, res) => {
  const { slug, episodeId, sceneId } = req.params
  // Strict id (matches the planner's freshId scheme) — prevents path traversal.
  if (!/^[A-Za-z0-9_-]+$/.test(sceneId)) return res.status(400).json({ detail: 'invalid scene id' })
  const buf = req.body
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).json({ detail: 'Empty body — POST the clip as raw bytes with Content-Type: video/mp4.' })
  }
  // Basic mp4 sniff: a standard mp4 carries an "ftyp" box at byte offset 4.
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') {
    return res.status(400).json({ detail: 'Body is not an mp4 (no ftyp box). Send a valid .mp4 clip.' })
  }
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(s => s.id === sceneId)
    if (!scene) return res.status(404).json({ detail: `scene ${sceneId} not found in scene_plan.json` })

    const outDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const outPath = path.join(outDir, `${sceneId}.mp4`)
    // Atomic write (tmp → rename) so the assembler never reads a half-written mp4.
    const tmp = path.join(outDir, `.tmp_${sceneId}_${process.pid}.mp4`)
    await fs.writeFile(tmp, buf)
    await fs.rename(tmp, outPath)

    // Stamp the plan for the Scene Review UI (clip presence + staleness). The
    // assembler keys off file existence, so the write above is what actually
    // makes the clip flow into the final video — this just keeps the UI honest.
    // Re-read to avoid racing a concurrent in-app clip job on the same plan.
    // The re-read alone only NARROWED that window — without the lock another
    // writer can still land between this read and the write below.
    await withLock(planPath, async () => {
      const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      const target = fresh.scenes.find(s => s.id === sceneId)
      if (!target) return
      target.clip_path = outPath
      target.rendered_motion_prompt = target.motion_prompt
      target.clip_source_image_version = target.image_version
      target.motion_choice = 'pending'
      await writeJsonAtomic(planPath, fresh)
    })
    res.json({ ok: true, scene_id: sceneId, saved_as: path.basename(outPath), bytes: buf.length })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save uploaded clip'))
  }
})

// ── PUT /scene-review/:ep/motion-choice ──────────────────────────────
// Motion Review never edits timing. It only decides whether assembly should
// use the reviewed image-to-video clip or deliberately retain the still.
router.put('/projects/:slug/scene-review/:episodeId/motion-choice', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const choice = body.choice
  if (choice !== 'clip' && choice !== 'still') {
    return res.status(400).json({ detail: 'choice must be "clip" or "still"' })
  }
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const clipsDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    if (!(body.all === true ? plan.scenes : plan.scenes.filter((scene) => scene.id === body.scene_id)).length) {
      return res.status(404).json({ detail: 'Scene not found' })
    }

    const changed = await withLock(planPath, async () => {
      const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      const targets = body.all === true
        ? fresh.scenes
        : fresh.scenes.filter((scene) => scene.id === body.scene_id)

      let changed = 0
      for (const scene of targets) {
        if (choice === 'clip') {
          const clipPath = path.join(clipsDir, `${scene.id}.mp4`)
          if (!existsSync(clipPath)) continue
          const stale = (typeof scene.rendered_motion_prompt === 'string'
            && scene.rendered_motion_prompt !== (scene.motion_prompt || ''))
            || (typeof scene.image_version === 'string'
              && scene.clip_source_image_version !== scene.image_version)
          if (stale) continue
        }
        if (scene.motion_choice !== choice) {
          scene.motion_choice = choice
          changed++
        }
      }
      await writeJsonAtomic(planPath, fresh)
      return changed
    })
    res.json({ ok: true, changed })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save Motion Review decision'))
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
    // The approve/deny sweep re-reads under the lock, and the stats reported back
    // are computed from the document that was actually saved — not from a copy
    // read before a concurrent render checkpoint landed.
    const { plan, changed } = await withLock(planPath, async () => {
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
        if (!target) throw new SceneNotFound(String(body.scene_id))
        target.approved = !!body.approved
        changed++
      } else {
        throw new BadApprovalRequest()
      }

      await writeJsonAtomic(planPath, plan)
      return { plan, changed }
    })
    const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
    const imageReady = plan.scenes.map(s =>
      existsSync(path.join(namedDir, `${s.id}.png`)) || existsSync(path.join(legacyDir, `${s.id}.png`)),
    )
    const promptIntegrity = inspectScenePromptIntegrity(plan.scenes)
    const subtitleIntegrity = await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId)
    const reviewCompletion = inspectSceneReviewCompletion(
      plan.scenes,
      imageReady,
      promptIntegrity.complete && subtitleIntegrity.complete,
    )
    await invalidateEpisodeStatus(slug, episodeId)
    res.json({
      ok: true,
      changed,
      stats: {
        total_scenes: plan.scenes.length,
        approved: reviewCompletion.approved,
        with_image: reviewCompletion.withImage,
        all_approved: reviewCompletion.complete,
      },
    })
  } catch (e: any) {
    if (e instanceof SceneNotFound) return res.status(404).json({ detail: `Scene ${e.sceneId} not found` })
    if (e instanceof BadApprovalRequest) {
      return res.status(400).json({ detail: 'Either { scene_id, approved } or { all } is required' })
    }
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

// ── GET /scene-review/:ep/clip/:sceneId ───────────────────────────────
// v1.0.470 — stream a scene's animated clip (mp4) for inline preview. Same
// strict id whitelist as the image route so it can't escape the clips dir.
router.get('/projects/:slug/scene-review/:episodeId/clip/:sceneId', async (req, res) => {
  const { slug, episodeId, sceneId } = req.params
  if (!/^[A-Za-z0-9_-]+$/.test(sceneId)) {
    return res.status(400).json({ detail: 'Invalid scene id' })
  }
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const clipsDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const clipPath = path.join(clipsDir, `${sceneId}.mp4`)
    if (!existsSync(clipPath)) return res.status(404).json({ detail: 'Clip not found' })
    const stat = await fs.stat(clipPath)
    streamLocalMedia(req, res, clipPath, 'video/mp4', stat.size)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve scene clip'))
  }
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
    streamLocalMedia(req, res, audioPath, mime, bestSize)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve merged audio'))
  }
})
