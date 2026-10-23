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

import { queueEpisodeAnalysisSoon } from '../services/scene-analysis.js'
import express, { Router } from 'express'
import fs from 'fs/promises'
import { existsSync, createReadStream } from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { freshActionMatch, readOperationId, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'

import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { resolveEpisodeMergedAudioChoice } from '../lib/merged-audio-selection.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { parseHttpByteRange } from '../lib/http-byte-range.js'
import { decodableImageSignature, isDecodableImage, peekDecodableImageSignature } from '../lib/image-validation.js'
import { assertPlayableSceneClip } from '../lib/scene-clip-media.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { SCENE_IMAGES_SUBFOLDER, resolveSceneImagesDir, resolveSceneImageReadPath } from '../generators/scene-image.js'
import {
  requireSceneClipGenStudioCatalogModel,
  requireSceneClipGenStudioModel,
  resolveVideoAssetsDir,
  selectSceneClipNarrationVariant,
} from '../generators/scene-clip.js'
import { publishedVideoControls, type GenStudioVideoControl } from '../lib/genstudio-client.js'
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
import { allowedSubtitleCueGapSec } from '../services/scene-plan-pacing.js'
import { inspectSceneReviewCompletion } from '../services/scene-review-completion.js'
import { checkpointSceneClip, motionPresentationSelection, resolveSketchDrawSettings, sceneClipStaleReason, sceneWindowSeconds, isSceneClipFresh } from '../services/scene-media-checkpoint.js'
import { readChannelProfileAsset } from '../services/channel-profile.js'
import { resolveEpisodeMotionSceneIds } from '../services/episode-motion-scope.js'
import { readVideoVisualSource } from '../services/video-visual-source.js'
import { parseSavedScenePlanPacing } from '../contracts/pacing.js'
import type { JobType, SceneClipVariantSelection, ScenePlan, ScenePlanEntry } from '../models/types.js'
import { RENDER_STATUS_FILENAME } from '../services/scene-render-status.js'
import { revalidatePreview, streamTo } from '../lib/stream-file.js'
import { ensureThumbnail } from '../lib/thumbnail-cache.js'
import { safetyModeFromConfig } from '../services/safety-checks.js'
import { inspectExistingTranscriptSource } from '../services/subtitle-correction.js'

export const router = Router()

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

type SceneClipDurationMode = 'manual' | 'follow_narration'
type SceneClipDurations = Record<string, { duration_seconds: number; narration_duration_seconds: number }>

/**
 * The published `audio` switch for a queued clip, or `undefined` when the request set none.
 *
 * **Validated against the model the request is actually billed at**, because a switch is a
 * choice the lane publishes rather than one Story Studio knows about: a value for a switch
 * this model does not offer is refused here, naming the model, instead of being queued and
 * quietly dropped at execution time. Absent is not `false` — no field means the lane's own
 * default applies, which is a different request from asking for sound.
 */
function requestedSceneClipAudio(
  body: Record<string, unknown>,
  model: { display_name?: string, controls?: GenStudioVideoControl[] | null },
): boolean | undefined {
  const value = body.audio
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'boolean') {
    throw new Error('audio must be true or false when it is sent')
  }
  const published = publishedVideoControls(model.controls)
  if (!published.some(control => control.name === 'audio')) {
    throw new Error(
      `${model.display_name || 'This model'} publishes no audio switch, so a clip from it cannot `
      + 'be asked for with or without sound. Choose a model that publishes one.',
    )
  }
  return value
}

function requestedSceneClipDurationMode(body: Record<string, unknown>): SceneClipDurationMode {
  if (body.duration_mode === undefined || body.duration_mode === null || body.duration_mode === 'manual') return 'manual'
  if (body.duration_mode === 'follow_narration') return 'follow_narration'
  throw new Error('duration_mode must be "manual" or "follow_narration"')
}

function narrationDurationSeconds(scene: ScenePlanEntry): number {
  const duration = scene.end_sec - scene.start_sec
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Scene ${scene.id} has no valid narration window.`)
  }
  return duration
}

function sceneClipDurations(
  scenes: readonly ScenePlanEntry[],
  durationForNarration: (narrationDuration: number) => number,
): SceneClipDurations {
  return Object.fromEntries(scenes.map(scene => {
    const narration_duration_seconds = narrationDurationSeconds(scene)
    return [scene.id, {
      duration_seconds: durationForNarration(narration_duration_seconds),
      narration_duration_seconds,
    }]
  }))
}

async function readScenePlanForClipDurations(slug: string, episodeId: string): Promise<ScenePlan> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('No scene_plan.json yet')
  return JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
}

async function assertSceneIsWithinMotionScope(
  slug: string,
  episodeId: string,
  sceneId: string,
  plan: ScenePlan,
): Promise<void> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const scope = await resolveEpisodeMotionSceneIds(slug, episodeId, plan.scenes, paths.episode_dir)
  if (!scope.scene_ids.includes(sceneId)) {
    throw new Error(`Scene ${sceneId} is outside this episode's saved motion scope.`)
  }
}

async function scenesEligibleForClipBatch(
  slug: string,
  episodeId: string,
  plan: ScenePlan,
  sceneIds?: ReadonlySet<string>,
): Promise<ScenePlanEntry[]> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
  const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
  const clipsDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
  const cfg = await pm.getConfig(slug).catch(() => null)
  const animateMinSeconds = Math.max(0, Number((cfg as any)?.animate_min_seconds) || 0)
  return plan.scenes.filter(scene => (
    (!sceneIds || sceneIds.has(scene.id))
      &&
    scene.motion_choice !== 'still'
      && scene.approved === true
      && !!scene.motion_prompt?.trim()
      && (scene.end_sec - scene.start_sec) >= animateMinSeconds
      && (existsSync(path.join(namedDir, `${scene.id}.png`)) || existsSync(path.join(legacyDir, `${scene.id}.png`)))
      // Existing clips, stale included, require the visible individual
      // Regenerate action. Batch work never silently spends over recovery.
      && !existsSync(path.join(clipsDir, `${scene.id}.mp4`))
  ))
}

const SCENE_STAT_CONCURRENCY = 32
const SCENE_DECODE_CONCURRENCY = 4

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Media URLs carry the asset's `size-mtime` as `?v=`. A URL that names the
 * exact bytes may be cached for as long as the browser likes: a replaced file
 * gets a new version from the review payload and therefore a new URL. A request
 * without a version keeps the old contract and is never cached.
 */
function mediaCacheControl(req: express.Request): string {
  return typeof req.query.v === 'string' && req.query.v.length > 0
    ? 'private, max-age=31536000, immutable'
    : 'no-store'
}

function streamLocalMedia(
  req: express.Request,
  res: express.Response,
  filePath: string,
  mime: string,
  size: number,
): void {
  res.setHeader('Content-Type', mime)
  res.setHeader('Cache-Control', mediaCacheControl(req))
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
    streamTo(res, createReadStream(filePath))
    return
  }

  const contentLength = range.end - range.start + 1
  res.status(206)
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  res.setHeader('Content-Length', String(contentLength))
  streamTo(res, createReadStream(filePath, { start: range.start, end: range.end }))
}

async function validateSceneRenderRequest(
  slug: string,
  episodeId: string,
  sceneIds?: string[],
  validatePrompts = true,
) {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('No scene_plan.json yet')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episodeId, { episodeDir: paths.episode_dir, audioDir: paths.audio_dir })
  if (validatePrompts) assertScenePromptsRenderable(plan.scenes, sceneIds)
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
  /** `size-mtime` of the decodable image, or null. The page keys and busts
   *  its thumbnail on this, so an unchanged image is never re-fetched. */
  image_version: string | null
  /** `size-mtime` of the animated clip, or null when there is none. */
  clip_version: string | null
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
  clip_stale_reason?: string | null
  clip_renderer?: ScenePlanEntry['clip_renderer']
}

/** Guard failures raised from inside a `withLock` body, where an Express
 *  `return res.status(...)` cannot short-circuit the handler. Mapped back to the
 *  same status codes by the approval route's catch. */
class SceneNotFound extends Error {
  constructor(readonly sceneId: string) { super(`Scene ${sceneId} not found`) }
}
class BadApprovalRequest extends Error {}
/** A decision Motion Review can explain and refuse (stale/missing clip), not an app fault. */
class ClipChoiceRefused extends Error {}

// Channel-owned presentation choices; provider presets do not overwrite these.
router.get('/projects/:slug/motion-presentation', async (req, res) => {
  try {
    const config = await pm.getConfig(req.params.slug)
    const project = await pm.getProject(req.params.slug)
    if (!config || !project) return res.status(404).json({ detail: 'Channel not found' })
    const logo = await readChannelProfileAsset(req.params.slug, 'logo')
    res.json({ ...motionPresentationSelection(config.motion_presentation), channel_name: project.name, has_logo: !!logo?.bytes.length })
  } catch (error: any) { res.status(409).json({ detail: error.message }) }
})
router.put('/projects/:slug/motion-presentation', async (req, res) => {
  try {
    const { renderer, pen } = req.body || {}
    if (!['image_to_video', 'sketch_draw'].includes(renderer) || !['none', 'plain', 'name', 'logo'].includes(pen)) {
      return res.status(400).json({ detail: 'Choose an available motion renderer and pen.' })
    }
    if (pen === 'logo' && !await readChannelProfileAsset(req.params.slug, 'logo')) {
      return res.status(409).json({ detail: 'This channel has no profile logo. Add one in Channel Profile or choose another pen.' })
    }
    if (!await pm.updateConfig(req.params.slug, { motion_presentation: { renderer, pen } } as any)) {
      return res.status(404).json({ detail: 'Channel not found' })
    }
    res.json({ renderer, pen })
  } catch (error: any) { res.status(409).json({ detail: error.message }) }
})

async function enqueueSketchDraw(req: express.Request<{ slug: string; episodeId: string }>, res: express.Response, single: boolean): Promise<void> {
  const { slug, episodeId } = req.params
  try {
    if ((await readVideoVisualSource(slug, episodeId)).source !== 'scene_plan') throw new Error('Motion Review is not used for Image Pool episodes.')
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
    const scoped = await resolveEpisodeMotionSceneIds(slug, episodeId, plan.scenes, paths.episode_dir)
    const scope = new Set(scoped.scene_ids)
    const sceneId = typeof req.body?.scene_id === 'string' ? req.body.scene_id.trim() : ''
    if (single && (!/^[A-Za-z0-9_-]+$/.test(sceneId) || !scope.has(sceneId))) throw new Error('Choose a scene inside the saved motion scope.')
    const settings = plan.scenes.some(scene => scene.clip_renderer === 'sketch_draw')
      ? await resolveSketchDrawSettings(slug, episodeId) : undefined
    const config = await pm.getConfig(slug)
    const floor = Math.max(0, Number(config?.animate_min_seconds) || 0)
    const clipsDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const filterContext = { slug, episodeId, episodeDir: paths.episode_dir, sketchSettings: settings }
    const ids: string[] = []
    const skipped_reasons: Array<{ scene_id: string; reason: string }> = []
    for (const scene of plan.scenes) {
      if (!scope.has(scene.id) || (single && scene.id !== sceneId)) continue
      const skip = (reason: string) => { skipped_reasons.push({ scene_id: scene.id, reason }) }
      if (!scene.approved) { skip('image is not approved'); continue }
      if (!single && scene.motion_choice === 'still') { skip('marked Still'); continue }
      let window: number
      try { window = sceneWindowSeconds(scene) }
      catch { skip(`invalid Scene Plan window for ${scene.id}`); continue }
      if (window < floor) { skip(`shorter than this channel's ${floor}s animation minimum`); continue }
      // Presence only: a full image decode belongs to generation, never to queue admission.
      const image = await resolveSceneImageReadPath(slug, episodeId.toUpperCase(), paths.episode_dir, scene.id)
      const imageStat = image ? await fs.stat(image).catch(() => null) : null
      if (!image || !imageStat?.isFile() || imageStat.size <= 0) { skip('missing image'); continue }
      if (!single && scene.clip_renderer === 'sketch_draw'
        && await isSceneClipFresh(scene, path.join(clipsDir, `${scene.id}.mp4`), filterContext)) {
        skip('already fresh')
        continue
      }
      ids.push(scene.id)
    }
    if (!ids.length) {
      if (single) throw new Error(`Scene ${sceneId} cannot start Sketch Draw: ${skipped_reasons[0]?.reason || 'it is outside the current motion scope'}.`)
      res.json({ ok: true, queued: 0, skipped: skipped_reasons.length, skipped_reasons, queued_scene_ids: [] })
      return
    }
    const type = single ? 'scene_clip_generate' : 'scene_clips_batch'
    const job = await jq.enqueue({ project_slug: slug, type, episode_id: episodeId,
      title: single ? `Sketch Draw — ${sceneId}` : `Sketch Draw — ${episodeId}`,
      dedupeParams: single ? (p: any) => p.scene_id === sceneId && p.renderer === 'sketch_draw' : undefined,
      params: { renderer: 'sketch_draw', episode_id: episodeId, ...(single ? { scene_id: sceneId } : {}),
        motion_scene_ids: ids, visual_source: 'scene_plan', auto_approve_clip: req.body?.auto_approve_clip === true },
    })
    await invalidateEpisodeStatus(slug, episodeId)
    res.status(single ? 201 : 200).json(single ? job : { ok: true, queued: ids.length,
      skipped: skipped_reasons.length, skipped_reasons, job_id: job.job_id, queued_scene_ids: ids })
  } catch (error: any) { res.status(409).json({ detail: error.message || 'Could not queue Sketch Draw. Retry after repairing the named scene.' }) }
}

// ── GET /scene-review/:ep ─────────────────────────────────────────────
router.get('/projects/:slug/scene-review/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    const visualSource = await readVideoVisualSource(slug, episodeId)
    if (!existsSync(planPath)) {
      return res.json({ scene_plan: null, scenes: [], audio_path: null, stats: null, visual_source: visualSource.source })
    }
    let plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    if (clearLegacyPlannerFallbackReasons(plan.scenes)) {
      // A read path that writes. Re-read under the lock and strip the legacy
      // reasons from THAT copy, or this GET can silently undo whatever a running
      // job wrote between its own read and this migration.
      plan = await withLock(planPath, async () => {
        const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
        if (clearLegacyPlannerFallbackReasons(fresh.scenes)) await writeJsonAtomic(planPath, fresh, { compact: true })
        return fresh
      })
    }
    const promptIntegrity = inspectScenePromptIntegrity(plan.scenes)
    const cfg = await pm.getConfig(slug).catch(() => null)
    const captionGapMode = safetyModeFromConfig(cfg, 'caption_gap')
    const planningTranscript = await inspectExistingTranscriptSource(paths.subtitles_dir, episodeId)
    const subtitleIntegrity = await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId, {
      max_cue_gap_sec: allowedSubtitleCueGapSec(),
      cue_source_path: planningTranscript.path,
    }).then(integrity => ({
      ...integrity,
      caption_gap_mode: captionGapMode,
      complete: integrity.missing_sections.length === 0
        && (captionGapMode !== 'block' || !integrity.blocking_cue_gaps?.length),
    }))
    let motionScope: Awaited<ReturnType<typeof resolveEpisodeMotionSceneIds>> = {
      motion_scope: { mode: 'off' },
      motion_level: 2,
      scene_ids: [],
      crossing_scene_ids: [],
    }
    let motionScopeError: string | undefined
    // Scene Review must remain available to repair a stale selected scope. Image
    // Pool has no motion pass, so it does not need continuity motion settings.
    if (visualSource.source !== 'image_pool') {
      try {
        motionScope = await resolveEpisodeMotionSceneIds(slug, episodeId, plan.scenes, paths.episode_dir)
      } catch (error: any) {
        motionScopeError = error?.message || String(error)
      }
    }

    // Annotate each scene with whether its image exists on disk. v1.0.457 —
    // check the unified named folder first, then the legacy flat scene_images/,
    // so both consolidated and not-yet-consolidated episodes show their renders.
    const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
    // v1.0.470 — clips live in the "11 Video Assets" folder as <scene_id>.mp4.
    const clipsDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyNumberedPattern = new RegExp(`^${episodeId.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_Scene\\d+_v\\d+\\.(?:png|jpe?g|webp)$`, 'i')
    // One readdir per folder; a name not listed is missing without a stat (S6: the page polls every
    // 3.5 s and a 300-scene plan cost ~600 probes per poll).
    // Resolved once per review read: every scene's freshness uses the same live channel selection.
    const reviewSketchSettings = plan.scenes.some(scene => scene.clip_renderer === 'sketch_draw')
      ? await resolveSketchDrawSettings(slug, episodeId).catch(() => undefined)
      : undefined
    const reviewContext = { slug, episodeId, episodeDir: paths.episode_dir, sketchSettings: reviewSketchSettings }
    const listed = async (dir: string) => new Set(await fs.readdir(dir).catch(() => [] as string[]))
    const [namedFiles, legacyFiles, clipFiles] = await Promise.all([listed(namedDir), listed(legacyDir), listed(clipsDir)])
    const legacyUnmappedImages = [...namedFiles].filter(filename => legacyNumberedPattern.test(filename)).length
    const scenes: ReviewSceneAugmented[] = []
    const imageReady: boolean[] = []
    let approvedCount = 0
    let withImageCount = 0
    let withClipCount = 0
    let motionReviewedCount = 0
    // One probe per scene, run in bounded parallel. A 288-scene episode
    // awaited ~700 file checks one after another here; in the live app every
    // sequential await queues behind other work, and this read took 2–2.7 s
    // (measured 2026-09-12) while the page polled it every 3.5 s.
    //
    // Two phases on purpose. Stats and cache hits are cheap and go wide; a
    // scene whose image has changed needs a full pixel decode in this process,
    // and those stay narrow — a cold read of 288 scenes decoding 16 at once is
    // the memory spike the crash history warns about.
    const probes = await mapWithConcurrency(plan.scenes, SCENE_STAT_CONCURRENCY, async (s) => {
      const filename = `${s.id}.png`
      const named = path.join(namedDir, filename)
      const legacy = path.join(legacyDir, filename)
      // Same rule as before: the named folder first, the legacy flat folder
      // whenever the named copy is absent OR unusable (a truncated download
      // beside a good legacy twin must still count as an image).
      const candidates: Array<{ imagePath: string; peeked: Awaited<ReturnType<typeof peekDecodableImageSignature>> }> = []
      for (const imagePath of [named, legacy]) {
        if (!(imagePath === named ? namedFiles : legacyFiles).has(filename)) continue
        const peeked = await peekDecodableImageSignature(imagePath)
        if (peeked.state === 'missing') continue
        candidates.push({ imagePath, peeked })
        if (peeked.state === 'known' && peeked.signature !== null) break
      }
      const known = candidates.find(candidate => candidate.peeked.state === 'known' && candidate.peeked.signature !== null)
      const clipStat = clipFiles.has(`${s.id}.mp4`) ? await fs.stat(path.join(clipsDir, `${s.id}.mp4`)).catch(() => null) : null
      const clipVersion = clipStat?.isFile() ? `${clipStat.size}-${Math.trunc(clipStat.mtimeMs)}` : null
      return {
        imageVersion: known && known.peeked.state === 'known' ? known.peeked.signature : null,
        // Decode only what a stat could not settle, in named-then-legacy order.
        decodePaths: known ? [] : candidates.filter(candidate => candidate.peeked.state === 'pending').map(candidate => candidate.imagePath),
        clipVersion,
      }
    })
    await mapWithConcurrency(
      probes.filter(probe => probe.decodePaths.length > 0),
      SCENE_DECODE_CONCURRENCY,
      async (probe) => {
        for (const imagePath of probe.decodePaths) {
          probe.imageVersion = await decodableImageSignature(imagePath)
          if (probe.imageVersion !== null) break
        }
      },
    )
    for (const [index, s] of plan.scenes.entries()) {
      const filename = `${s.id}.png`
      const { imageVersion, clipVersion } = probes[index]!
      const imageExists = imageVersion !== null
      imageReady.push(imageExists)
      if (imageExists) withImageCount++
      if (s.approved) approvedCount++
      // v1.0.470 — clip existence + stale (rendered from a now-changed motion prompt).
      const clipExists = clipVersion !== null
      const clipStaleReason = clipExists ? await sceneClipStaleReason(s, reviewContext) : null
      const clipStale = !!clipStaleReason
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
        image_filename: imageExists ? filename : null,
        image_version: imageVersion,
        clip_version: clipVersion,
        boundary_reason: s.boundary_reason,
        // Stale = image on disk but its rendered_prompt no longer matches the
        // current visual_prompt. Unknown rendered_prompt (pre-feature renders)
        // → not stale, so old episodes don't all light up red.
        stale: imageExists
          && typeof (s as any).rendered_prompt === 'string'
          && (s as any).rendered_prompt !== s.visual_prompt,
        // v1.0.470 — clip animation status.
        clip_exists: clipExists,
        clip_stale: clipStale,
        clip_stale_reason: clipStaleReason,
        clip_renderer: s.clip_renderer,
        motion_choice: s.motion_choice,
      })
    }

    // Locate merged audio for the synced player. The owner's explicit choice
    // wins when he made one (v1.4.314); otherwise this keeps its long-standing
    // "largest .mp3" rule so an episode nobody pinned is unchanged.
    let audioPath: string | null = null
    let audioVersion: string | null = null
    if (existsSync(paths.merged_audio_dir)) {
      const files = await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])
      const choice = await resolveEpisodeMergedAudioChoice(paths.merged_audio_dir, episodeId)
      // A pin that no longer names a real track leaves the player empty rather
      // than quietly playing a different narration.
      if (choice.source !== 'invalid') {
        const pinned = choice.source === 'selected' ? choice.filename : null
        let bestSize = 0
        for (const f of files) {
          if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
          if (pinned && f !== pinned) continue
          const stat = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
          if (stat && stat.size > bestSize) {
            bestSize = stat.size
            audioPath = path.join(paths.merged_audio_dir, f)
            audioVersion = `${stat.size}-${Math.trunc(stat.mtimeMs)}`
          }
        }
      }
    }

    let activeJob: any = null
    try {
      activeJob = (await jq.findJobs(slug, (j: any) =>
        j.episode_id === episodeId
        && (j.type === 'continuity_render' || j.type === 'scene_images_batch')
        && (j.status === 'running' || j.status === 'queued' || j.status === 'paused'),
      ))[0] || null
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
        pacing: plan.pacing === undefined ? undefined : parseSavedScenePlanPacing(plan.pacing),
      },
      scenes,
      audio_path: audioPath,
      audio_version: audioVersion,
      render_status: renderStatus,
      active_render_job: activeJob,
      animate_min_seconds: animateMinSeconds,
      motion_scope: motionScope.motion_scope,
      motion_scene_ids: motionScope.scene_ids,
      motion_crossing_scene_ids: motionScope.crossing_scene_ids,
      visual_source: visualSource.source,
      ...(motionScopeError ? { motion_scope_error: motionScopeError } : {}),
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

interface ManualFinishMarker {
  action_id: string
  replace_uncertain: boolean
  source_job_id?: string
  expected_uncertain_identity_hashes?: Record<string, string>
  request_fingerprint?: string
}

/**
 * A named ratio is an explicit choice; absent or blank is MISSING and is left
 * for the shared Story default in the image resolver. Routes must never turn
 * "the caller named none" into a literal 16:9, which a model may not publish.
 */
function normalizedAspectRatio(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finishRequestFingerprint(
  slug: string,
  episodeId: string,
  body: Record<string, any>,
  marker: ManualFinishMarker,
  sceneIds: string[],
): string {
  return createHash('sha256').update(JSON.stringify({
    slug,
    episodeId,
    action_id: marker.action_id,
    replace_uncertain: marker.replace_uncertain,
    source_job_id: marker.source_job_id || '',
    scene_ids: [...sceneIds].sort(),
    model: typeof body.model === 'string' ? body.model.trim() : '',
    aspect_ratio: normalizedAspectRatio(body.aspect_ratio) ?? '',
    resolution: typeof body.resolution === 'string' ? body.resolution.trim() : '',
    width: typeof body.width === 'number' ? body.width : null,
    height: typeof body.height === 'number' ? body.height : null,
    seed: Number.isInteger(body.seed) ? body.seed : null,
    auto_approve_generated: body.auto_approve_generated === true,
  })).digest('hex')
}

async function enqueueContinuityRender(
  slug: string,
  episodeId: string,
  body: any,
  opts: {
    singleSceneId?: string
    manualFinish?: ManualFinishMarker
  } = {},
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
    params: continuityRenderParams(episodeId, body, singleSceneId, Array.isArray(body.scene_ids)
      ? body.scene_ids.filter((s: any) => typeof s === 'string')
      : undefined, opts.manualFinish),
  })
}

function continuityRenderParams(
  episodeId: string,
  body: any,
  singleSceneId: string | undefined,
  sceneIds: string[] | undefined,
  manualFinish?: ManualFinishMarker,
) {
  // A forced single-scene render is an explicit paid replacement. Its caller
  // owns the id so a lost response can rejoin the same provider attempt.
  // Missing-only and episode-batch recovery deliberately retain their legacy
  // queue semantics.
  const operationId = singleSceneId && body.force === true ? readOperationId(body, true) : null
  const aspectRatio = normalizedAspectRatio(body.aspect_ratio)
  const params = {
    episode_id: episodeId,
    title: typeof body.title === 'string' ? body.title : '',
    model: typeof body.model === 'string' ? body.model.trim() : '',
    // Missing is omitted, not stored as a ratio the model may not publish.
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    resolution: typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : undefined,
    width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
    height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
    seed: Number.isInteger(body.seed) ? body.seed : undefined,
    force: body.force === true,
    render_attempt_id: operationId || (typeof body.render_attempt_id === 'string' && body.render_attempt_id.trim()
      ? body.render_attempt_id.trim()
      : (body.force === true ? randomUUID() : undefined)),
    single_scene_id: singleSceneId,
    scene_ids: sceneIds,
    missing_only: body.missing_only === true,
    auto_approve_generated: body.auto_approve_generated === true,
    ...(manualFinish ? { manual_image_finish: manualFinish } : {}),
  }
  return operationId ? stampFreshGenerationAction(params, operationId) : params
}

// ── POST /scene-review/:ep/generate-image ─────────────────────────────
router.post('/projects/:slug/scene-review/:episodeId/generate-image', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const operationId = typeof body.operation_id === 'string' ? body.operation_id.trim() : ''
  const aspectRatio = normalizedAspectRatio(body.aspect_ratio)
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })
  if (!model) return res.status(400).json({ detail: 'model is required' })
  if (!OPERATION_ID.test(operationId)) return res.status(400).json({ detail: 'operation_id must be a UUID for an explicit image re-roll.' })
  const sameActionRequest = (candidate: any) => candidate.type === 'scene_image_generate'
    && candidate.episode_id === episodeId
    && candidate.params?.generation_action?.id === operationId
    && candidate.params?.scene_id === sceneId
    && candidate.params?.model === model
    && candidate.params?.aspect_ratio === aspectRatio
    && candidate.params?.resolution === (typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : undefined)
    && candidate.params?.width === (typeof body.width === 'number' && body.width > 0 ? body.width : undefined)
    && candidate.params?.height === (typeof body.height === 'number' && body.height > 0 ? body.height : undefined)
    && candidate.params?.seed === (Number.isInteger(body.seed) ? body.seed : undefined)
    && candidate.params?.auto_approve_generated === (body.auto_approve_generated === true)

  try {
    const actionJobs = await jq.findJobs(slug, job =>
      job.type === 'scene_image_generate'
      && job.episode_id === episodeId
      && job.params?.generation_action?.id === operationId,
    )
    if (actionJobs.length) {
      const existing = actionJobs[0]!
      if (!sameActionRequest(existing)) return res.status(409).json({ detail: 'operation_id already belongs to a different scene image request.' })
      return res.status(201).json({ ...existing, reused: true })
    }
    if ((await readVideoVisualSource(slug, episodeId)).source !== 'scene_plan') {
      return res.status(409).json({ detail: 'Scene image generation is not used for Image Pool episodes.' })
    }
    await validateSceneRenderRequest(slug, episodeId, [sceneId])
    let job: Awaited<ReturnType<typeof jq.enqueue>>
    try {
      job = await jq.enqueue({
        project_slug: slug,
        type: 'scene_image_generate' as JobType,
        episode_id: episodeId,
        title: `Scene ${sceneId.slice(0, 12)} image`,
        dedupeParams: (params: any) => params?.scene_id === sceneId,
        params: {
          episode_id: episodeId,
          title: typeof body.title === 'string' ? body.title : '',
          scene_id: sceneId,
          model,
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          resolution: typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : undefined,
          width: typeof body.width === 'number' && body.width > 0 ? body.width : undefined,
          height: typeof body.height === 'number' && body.height > 0 ? body.height : undefined,
          seed: Number.isInteger(body.seed) ? body.seed : undefined,
          generation_action: { id: operationId, kind: 'fresh' },
          auto_approve_generated: body.auto_approve_generated === true,
        },
      })
    } catch (error) {
      if (error instanceof jq.DuplicateJobError) {
        const replay = (await jq.findJobs(slug, candidate =>
          candidate.type === 'scene_image_generate'
          && candidate.episode_id === episodeId
          && candidate.params?.generation_action?.id === operationId,
        ))[0]
        if (replay && sameActionRequest(replay)) return res.status(201).json({ ...replay, reused: true })
        if (replay) return res.status(409).json({ detail: 'operation_id already belongs to a different scene image request.' })
        return res.status(409).json({ detail: `Scene ${sceneId} image already generating` })
      }
      throw error
    }
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
async function enqueueMissingScenes(
  req: express.Request,
  res: express.Response,
  manualFinish?: ManualFinishMarker & { scene_ids?: string[] },
) {
  const slug = String(req.params.slug)
  const episodeId = String(req.params.episodeId)
  const body = req.body || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })

  try {
    if (manualFinish) {
      if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
      const replay = (await jq.findJobs(slug, job =>
        job.type === 'continuity_render'
        && job.episode_id === episodeId
        && job.params?.manual_image_finish?.action_id === manualFinish.action_id,
      ))[0]
      if (replay) {
        const fingerprint = finishRequestFingerprint(slug, episodeId, body, manualFinish, replay.params.scene_ids || [])
        if (replay.params.manual_image_finish?.request_fingerprint !== fingerprint) {
          return res.status(409).json({ detail: 'This finish action id already belongs to a different request.' })
        }
        return res.json({ ok: true, queued: 0, skipped: 0, reused: true, job_id: replay.job_id, queued_scene_ids: replay.params.scene_ids || [] })
      }
    }
    const { paths, plan } = await validateSceneRenderRequest(slug, episodeId, undefined, false)

    // v1.0.457 — "missing" means missing from BOTH the unified named folder and
    // the legacy flat folder, so an un-consolidated episode isn't re-queued.
    const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    const legacyDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
    let skipped = 0
    const aspect_ratio = normalizedAspectRatio(body.aspect_ratio)
    const width = typeof body.width === 'number' && body.width > 0 ? body.width : undefined
    const height = typeof body.height === 'number' && body.height > 0 ? body.height : undefined

    // Scenes with no image AND no individual render already in flight.
    const allowed = manualFinish?.scene_ids ? new Set(manualFinish.scene_ids) : null
    const missing = [] as typeof plan.scenes
    for (const s of plan.scenes) {
      if (allowed && !allowed.has(s.id)) continue
      const filename = `${s.id}.png`
      const namedPath = path.join(namedDir, filename)
      const legacyPath = path.join(legacyDir, filename)
      if (await isDecodableImage(namedPath) || await isDecodableImage(legacyPath)) { skipped++; continue }
      if (jq.isDuplicate(slug, episodeId, 'scene_image_generate' as JobType, (p: any) => p?.scene_id === s.id)) { skipped++; continue }
      missing.push(s)
    }

    if (missing.length === 0) {
      return res.json({ ok: true, queued: 0, skipped, queued_scene_ids: [] })
    }

    assertScenePromptsRenderable(plan.scenes, missing.map(scene => scene.id))

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
    if ((await readVideoVisualSource(slug, episodeId)).source !== 'scene_plan') {
      return res.status(409).json({ detail: 'Scene image generation is not used for Image Pool episodes.' })
    }

    try {
      const manualMarker: ManualFinishMarker | undefined = manualFinish
        ? {
            action_id: manualFinish.action_id,
            replace_uncertain: manualFinish.replace_uncertain,
            ...(manualFinish.source_job_id ? { source_job_id: manualFinish.source_job_id } : {}),
            ...(manualFinish.expected_uncertain_identity_hashes
              ? { expected_uncertain_identity_hashes: manualFinish.expected_uncertain_identity_hashes }
              : {}),
          }
        : undefined
      if (manualMarker) {
        manualMarker.request_fingerprint = finishRequestFingerprint(slug, episodeId, body, manualMarker, missing.map(scene => scene.id))
      }
      const job = await enqueueContinuityRender(slug, episodeId, {
        ...body,
        model,
        aspect_ratio,
        width,
        height,
        scene_ids: missing.map((s) => s.id),
        missing_only: true,
      }, manualMarker ? { manualFinish: manualMarker } : {})
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
}

router.post('/projects/:slug/scene-review/:episodeId/generate-missing', (req, res) =>
  enqueueMissingScenes(req, res))

const FINISH_ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

router.post('/projects/:slug/scene-review/:episodeId/finish-missing', async (req, res) => {
  const actionId = typeof req.body?.action_id === 'string' ? req.body.action_id.trim() : ''
  if (!FINISH_ACTION_ID.test(actionId)) return res.status(400).json({ detail: 'A valid finish action id is required.' })
  return enqueueMissingScenes(req, res, { action_id: actionId, replace_uncertain: false })
})

router.post('/projects/:slug/scene-review/:episodeId/replace-uncertain', async (req, res) => {
  const actionId = typeof req.body?.action_id === 'string' ? req.body.action_id.trim() : ''
  const sourceJobId = typeof req.body?.source_job_id === 'string' ? req.body.source_job_id.trim() : ''
  if (!FINISH_ACTION_ID.test(actionId)) return res.status(400).json({ detail: 'A valid finish action id is required.' })
  if (!await pm.getProject(String(req.params.slug))) return res.status(404).json({ detail: 'Project not found' })
  // Hydrate this project's durable jobs before resolving the private receipt.
  // getJobs returns a public/redacted view; getJob below deliberately reads the
  // in-memory durable copy after hydration so a restart cannot erase authority.
  await jq.findJobs(String(req.params.slug), () => false)
  const sourceJob = jq.getJob(sourceJobId)
  const uncertainSceneIds = sourceJob?.params?.manual_image_finish?.uncertain_scene_ids
  const uncertainIdentityHashes = sourceJob?.params?.manual_image_finish?.uncertain_identity_hashes
  if (!sourceJob || sourceJob.project_slug !== req.params.slug || sourceJob.episode_id !== req.params.episodeId
    || sourceJob.type !== 'continuity_render' || !Array.isArray(uncertainSceneIds) || uncertainSceneIds.length === 0
    || !uncertainIdentityHashes || typeof uncertainIdentityHashes !== 'object') {
    return res.status(409).json({ detail: 'The uncertain image request is no longer current. Check saved results again.' })
  }
  return enqueueMissingScenes(req, res, {
    action_id: actionId,
    replace_uncertain: true,
    source_job_id: sourceJob.job_id,
    scene_ids: uncertainSceneIds.filter((value: unknown): value is string => typeof value === 'string'),
    expected_uncertain_identity_hashes: Object.fromEntries(
      uncertainSceneIds.flatMap((sceneId: unknown) => typeof sceneId === 'string' && typeof uncertainIdentityHashes[sceneId] === 'string'
        ? [[sceneId, uncertainIdentityHashes[sceneId]]]
        : []),
    ),
  })
})

// ── POST /scene-review/:ep/generate-clip ──────────────────────────────
// v1.0.470 — Phase 2: animate ONE scene's image into a clip via an i2v model.
router.post('/projects/:slug/scene-review/:episodeId/generate-clip', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  if (body.renderer === 'sketch_draw') return enqueueSketchDraw(req, res, true)
  const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!sceneId) return res.status(400).json({ detail: 'scene_id is required' })
  if (!model) return res.status(400).json({ detail: 'model is required' })
  let durationMode: SceneClipDurationMode
  try { durationMode = requestedSceneClipDurationMode(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }
  let requestedVariant: SceneClipVariantSelection | undefined
  if (durationMode === 'manual') {
    try { requestedVariant = requestedSceneClipVariant(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }
  }

  try {
    const visualSource = await readVideoVisualSource(slug, episodeId)
    if (visualSource.source !== 'scene_plan') throw new Error('Motion Review is not used for Image Pool episodes.')
    const plan = await readScenePlanForClipDurations(slug, episodeId)
    await assertSceneIsWithinMotionScope(slug, episodeId, sceneId, plan)
    let variant: SceneClipVariantSelection
    let sceneDurations: SceneClipDurations | undefined
    let modelId: string
    // The published switch is resolved against the SAME catalogue row the variant is priced at.
    let audio: boolean | undefined
    if (durationMode === 'follow_narration') {
      const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : ''
      if (!resolution) return res.status(400).json({ detail: 'resolution is required when following narration' })
      const scene = plan.scenes.find(item => item.id === sceneId)
      if (!scene) return res.status(404).json({ detail: `scene ${sceneId} not found in scene_plan.json` })
      const selected = await requireSceneClipGenStudioCatalogModel(model)
      const followVariant = selectSceneClipNarrationVariant(selected.model.variants, resolution, narrationDurationSeconds(scene))
      modelId = selected.modelId
      variant = followVariant
      audio = requestedSceneClipAudio(body, selected.model)
      sceneDurations = sceneClipDurations([scene], narration => selectSceneClipNarrationVariant(selected.model.variants, resolution, narration).duration_seconds)
    } else {
      const selected = await requireSceneClipGenStudioModel(model, requestedVariant)
      modelId = selected.modelId
      variant = selected.variant
      audio = requestedSceneClipAudio(body, selected.model)
      const scene = plan.scenes.find(item => item.id === sceneId)
      if (scene) sceneDurations = sceneClipDurations([scene], () => variant.duration_seconds)
    }
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
        aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : undefined,
        operation: variant.operation,
        duration_seconds: variant.duration_seconds,
        resolution: variant.resolution,
        duration_mode: durationMode,
        visual_source: visualSource.source,
        ...(sceneDurations ? { scene_durations: sceneDurations } : {}),
        ...(typeof audio === 'boolean' ? { audio } : {}),
        auto_approve_clip: body.auto_approve_clip === true,
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(409).json(humanizeBackendError(e, 'The motion model is not available right now'))
  }
})

// One durable episode-level owner used by Pipeline and Job Retry. Unlike the
// per-scene fan-out below, this runs a strict preflight before any provider
// submission and verifies the complete selected motion stage at the end.
router.post('/projects/:slug/scene-review/:episodeId/generate-clips-batch', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  if (body.renderer === 'sketch_draw') return enqueueSketchDraw(req, res, false)
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  let durationMode: SceneClipDurationMode
  try { durationMode = requestedSceneClipDurationMode(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }
  let requestedVariant: SceneClipVariantSelection | undefined
  if (durationMode === 'manual') {
    try { requestedVariant = requestedSceneClipVariant(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }
  }
  try {
    const visualSource = await readVideoVisualSource(slug, episodeId)
    if (visualSource.source !== 'scene_plan') throw new Error('Motion Review is not used for Image Pool episodes.')
    const plan = await readScenePlanForClipDurations(slug, episodeId)
    const scoped = await resolveEpisodeMotionSceneIds(slug, episodeId, plan.scenes)
    const eligible = await scenesEligibleForClipBatch(slug, episodeId, plan, new Set(scoped.scene_ids))
    if (!eligible.length) throw new Error('No scenes are eligible under this episode’s motion scope. Choose a scope and approve ready scenes first.')
    let variant: SceneClipVariantSelection
    let sceneDurations: SceneClipDurations | undefined
    let modelId: string
    let audio: boolean | undefined
    if (durationMode === 'follow_narration') {
      const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : ''
      if (!resolution) return res.status(400).json({ detail: 'resolution is required when following narration' })
      const selected = await requireSceneClipGenStudioCatalogModel(model)
      sceneDurations = sceneClipDurations(eligible, narration => selectSceneClipNarrationVariant(selected.model.variants, resolution, narration).duration_seconds)
      const first = Object.values(sceneDurations)[0]
      if (!first) return res.status(400).json({ detail: 'No scenes are available to follow narration' })
      const followVariant = selectSceneClipNarrationVariant(selected.model.variants, resolution, first.narration_duration_seconds)
      modelId = selected.modelId
      variant = followVariant
      audio = requestedSceneClipAudio(body, selected.model)
    } else {
      const selected = await requireSceneClipGenStudioModel(model, requestedVariant)
      modelId = selected.modelId
      variant = selected.variant
      audio = requestedSceneClipAudio(body, selected.model)
      sceneDurations = sceneClipDurations(eligible, () => variant.duration_seconds)
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'scene_clips_batch' as JobType,
      episode_id: episodeId,
      title: `Motion clips — ${episodeId}`,
      params: {
        episode_id: episodeId,
        model: `genstudio-video:${modelId}`,
        aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : undefined,
        operation: variant.operation,
        duration_seconds: variant.duration_seconds,
        resolution: variant.resolution,
        duration_mode: durationMode,
        motion_scene_ids: eligible.map(scene => scene.id),
        visual_source: visualSource.source,
        ...(sceneDurations ? { scene_durations: sceneDurations } : {}),
        ...(typeof audio === 'boolean' ? { audio } : {}),
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    if (e instanceof jq.DuplicateJobError) return res.status(409).json({ detail: e.message })
    res.status(409).json(humanizeBackendError(e, 'The motion model is not available right now'))
  }
})

// ── POST /scene-review/:ep/generate-missing-clips ─────────────────────
// v1.0.470 — bulk-queue scene_clip_generate for every scene that HAS an image
// + a motion prompt but no clip yet. Existing clips use the visible individual
// Regenerate action. Skips in-flight.
router.post('/projects/:slug/scene-review/:episodeId/generate-missing-clips', async (req, res) => {
  const { slug, episodeId } = req.params
  const body = req.body || {}
  if (body.renderer === 'sketch_draw') return enqueueSketchDraw(req, res, false)
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  let durationMode: SceneClipDurationMode
  try { durationMode = requestedSceneClipDurationMode(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }
  let requestedVariant: SceneClipVariantSelection | undefined
  if (durationMode === 'manual') {
    try { requestedVariant = requestedSceneClipVariant(body) } catch (e: any) { return res.status(400).json({ detail: e.message }) }
  }

  try {
    const visualSource = await readVideoVisualSource(slug, episodeId)
    if (visualSource.source !== 'scene_plan') throw new Error('Motion Review is not used for Image Pool episodes.')
    let variant: SceneClipVariantSelection | undefined
    let modelId: string
    let followVariants: ReturnType<typeof selectSceneClipNarrationVariant>[] | undefined
    let followResolution = ''
    let audio: boolean | undefined
    if (durationMode === 'follow_narration') {
      followResolution = typeof body.resolution === 'string' ? body.resolution.trim() : ''
      if (!followResolution) return res.status(400).json({ detail: 'resolution is required when following narration' })
      const selected = await requireSceneClipGenStudioCatalogModel(model)
      modelId = selected.modelId
      // Kept only as a type-preserving container for the live published rows;
      // each eligible scene resolves its own exact row below.
      followVariants = selected.model.variants
      audio = requestedSceneClipAudio(body, selected.model)
    } else {
      const selected = await requireSceneClipGenStudioModel(model, requestedVariant)
      modelId = selected.modelId
      variant = selected.variant
      audio = requestedSceneClipAudio(body, selected.model)
    }
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scoped = await resolveEpisodeMotionSceneIds(slug, episodeId, plan.scenes, paths.episode_dir)
    const scopedIds = new Set(scoped.scene_ids)
    if (!scopedIds.size) return res.status(400).json({ detail: 'No scenes are eligible under this episode’s motion scope.' })

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
      if (!scopedIds.has(s.id)) { skipped++; continue }
      const hasImage = existsSync(path.join(namedDir, `${s.id}.png`)) || existsSync(path.join(legacyDir, `${s.id}.png`))
      const hasMotion = !!(s.motion_prompt && s.motion_prompt.trim())
      const longEnough = (s.end_sec - s.start_sec) >= animateMinSeconds
      const clipExists = existsSync(path.join(clipsDir, `${s.id}.mp4`))
      // Animate scenes that are approved + ready (image + motion) + long enough,
      // with no saved clip. Existing clips must use the visible individual
      // Regenerate action; skip in-flight work too.
      if (!s.approved || s.motion_choice === 'still' || !hasImage || !hasMotion || !longEnough || clipExists) { skipped++; continue }
      if (jq.isDuplicate(slug, episodeId, 'scene_clip_generate' as JobType, (p: any) => p?.scene_id === s.id)) { skipped++; continue }
      const selectedVariant = durationMode === 'follow_narration'
        ? selectSceneClipNarrationVariant(followVariants, followResolution, narrationDurationSeconds(s))
        : variant!
      const durations = sceneClipDurations([s], () => selectedVariant.duration_seconds)
      await jq.enqueue({
        project_slug: slug,
        type: 'scene_clip_generate' as JobType,
        episode_id: episodeId,
        title: `Scene ${s.scene_index} clip`,
        params: {
          episode_id: episodeId,
          scene_id: s.id,
          model: `genstudio-video:${modelId}`,
          aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : undefined,
          operation: selectedVariant.operation,
          duration_seconds: selectedVariant.duration_seconds,
          resolution: selectedVariant.resolution,
          duration_mode: durationMode,
          motion_scene_ids: [s.id],
          visual_source: visualSource.source,
          scene_durations: durations,
          ...(typeof audio === 'boolean' ? { audio } : {}),
        },
      })
      queued++
      queuedIds.push(s.id)
    }
    res.json({ ok: true, queued, skipped, queued_scene_ids: queuedIds })
  } catch (e: any) {
    res.status(409).json(humanizeBackendError(e, 'The motion model is not available right now'))
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
  let params: ReturnType<typeof continuityRenderParams>
  try {
    params = continuityRenderParams(episodeId, body, singleSceneId, requestedSceneIds)
  } catch (e: any) {
    return res.status(400).json({ detail: e?.message || 'operation_id must be a valid UUID.' })
  }
  const actionParams = params as { generation_action?: { id?: string }; generation_action_fingerprint?: string }
  const operationId = actionParams.generation_action?.id
  const sameActionRequest = (candidate: any) => candidate.type === 'continuity_render'
    && candidate.episode_id === episodeId
    && candidate.params?.generation_action?.id === operationId
    && candidate.params?.generation_action_fingerprint === actionParams.generation_action_fingerprint
  if (operationId) {
    const existing = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
    if (existing) {
      if (!sameActionRequest(existing)) return res.status(409).json({ detail: 'operation_id already belongs to a different continuity render request.' })
      return res.status(201).json({ ...existing, reused: true })
    }
  }
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
  if ((await readVideoVisualSource(slug, episodeId)).source !== 'scene_plan') {
    return res.status(409).json({ detail: 'Scene image generation is not used for Image Pool episodes.' })
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
      params,
    })
  } catch (e: any) {
    // Lost the atomic dedupe race — surface as a clean 409 (no async error
    // boundary in this app, so an unhandled throw would hang the request).
    if (e instanceof jq.DuplicateJobError) {
      if (operationId) {
        const replay = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
        if (replay && sameActionRequest(replay)) return res.status(201).json({ ...replay, reused: true })
        if (replay) return res.status(409).json({ detail: 'operation_id already belongs to a different continuity render request.' })
      }
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
  try {
    if ((await readVideoVisualSource(slug, episodeId)).source !== 'scene_plan') {
      return res.status(409).json({ detail: 'Scene image replacement is not used for Image Pool episodes.' })
    }
    const buf = decodeUploadBuffer(req.body)
    if (!buf.ok) return res.status(buf.status).json({ detail: buf.detail })
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
      target.image_sha256 = createHash('sha256').update(buf.data).digest('hex')
      target.motion_choice = 'pending'
      target.approved = false   // user re-approves after a manual swap
      await writeJsonAtomic(planPath, fresh, { compact: true })
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
    if ((await readVideoVisualSource(slug, episodeId)).source !== 'scene_plan') {
      return res.status(409).json({ detail: 'Motion Review is not used for Image Pool episodes.' })
    }
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(400).json({ detail: 'No scene_plan.json yet' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(s => s.id === sceneId)
    if (!scene) return res.status(404).json({ detail: `scene ${sceneId} not found in scene_plan.json` })
    // Validate the window before touching the accepted clip, so a bad plan cannot replace it.
    try { sceneWindowSeconds(scene) }
    catch { throw new Error(`Scene ${sceneId} has an invalid Scene Plan window. Repair its timeline, then upload again.`) }

    const outDir = await resolveVideoAssetsDir(slug, episodeId.toUpperCase(), paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const outPath = path.join(outDir, `${sceneId}.mp4`)
    // Atomic write (tmp → rename) so the assembler never reads a half-written mp4.
    const tmp = path.join(outDir, `.tmp_${sceneId}_${process.pid}.mp4`)
    await fs.writeFile(tmp, buf)
    const measuredDurationSeconds = await assertPlayableSceneClip(tmp)
    await fs.rename(tmp, outPath)

    // The checkpoint decodes the uploaded video before exposing it to Scene
    // Review. It also clears any paid-duration receipt and Follow hold from a
    // replaced external clip while recording its measured duration.
    await checkpointSceneClip(
      planPath,
      sceneId,
      outPath,
      scene.motion_prompt || '',
      scene.image_version,
      false,
      { renderer: 'external', duration_seconds: measuredDurationSeconds },
    )
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

    const approvalSketchSettings = plan.scenes.some(scene => scene.clip_renderer === 'sketch_draw')
      ? await resolveSketchDrawSettings(slug, episodeId).catch(() => undefined)
      : undefined
    const approvalContext = { slug, episodeId, episodeDir: paths.episode_dir, sketchSettings: approvalSketchSettings }

    const changed = await withLock(planPath, async () => {
      const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      const targets = body.all === true
        ? fresh.scenes
        : fresh.scenes.filter((scene) => scene.id === body.scene_id)

      let changed = 0
      for (const scene of targets) {
        if (choice === 'clip') {
          const clipPath = path.join(clipsDir, `${scene.id}.mp4`)
          const clipStat = await fs.stat(clipPath).catch(() => null)
          if (!clipStat?.isFile() || clipStat.size <= 0) {
            if (body.all !== true) throw new ClipChoiceRefused(`Scene ${scene.id} has no usable clip. Generate it before choosing Use Clip.`)
            continue
          }
          const stale = await sceneClipStaleReason(scene, approvalContext)
          if (stale) {
            if (body.all !== true) throw new ClipChoiceRefused(`Scene ${scene.id} cannot use its clip: ${stale}. Re-generate this scene, then choose Use Clip.`)
            continue
          }
        }
        if (scene.motion_choice !== choice) {
          scene.motion_choice = choice
          changed++
        }
      }
      await writeJsonAtomic(planPath, fresh, { compact: true })
      return changed
    })
    res.json({ ok: true, changed })
  } catch (e: any) {
    if (e instanceof ClipChoiceRefused) return res.status(409).json(humanizeBackendError(e, 'Failed to save Motion Review decision'))
    return res.status(500).json(humanizeBackendError(e, 'Failed to save Motion Review decision'))
  }
})

// ── PUT /scene-review/:ep/approve ─────────────────────────────────────
// Flip approval flags. Body shapes:
//   { scene_id: '<id>', approved: true|false }   — single scene
//   { all: true|false }                          — bulk all
/** `<scene id>.png` present in the named or legacy scene folder: two readdirs instead of 2 × N existsSync. */
async function sceneImageNames(slug: string, episodeId: string, episodeDir: string): Promise<(sceneId: string) => boolean> {
  const namedDir = await resolveSceneImagesDir(slug, episodeId.toUpperCase(), episodeDir)
  const legacyDir = path.join(episodeDir, SCENE_IMAGES_SUBFOLDER)
  const [named, legacy] = await Promise.all([namedDir, legacyDir].map(async dir => new Set(await fs.readdir(dir).catch(() => [] as string[]))))
  return sceneId => named.has(`${sceneId}.png`) || legacy.has(`${sceneId}.png`)
}

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
        const hasImage = await sceneImageNames(slug, episodeId, paths.episode_dir)
        for (const s of plan.scenes) {
          const target = body.all && hasImage(s.id)  // bulk-deny works regardless
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

      await writeJsonAtomic(planPath, plan, { compact: true })
      return { plan, changed }
    })
    const hasImage = await sceneImageNames(slug, episodeId, paths.episode_dir)
    const imageReady = plan.scenes.map(s => hasImage(s.id))
    const promptIntegrity = inspectScenePromptIntegrity(plan.scenes)
    const subtitleIntegrity = await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId)
    const reviewCompletion = inspectSceneReviewCompletion(
      plan.scenes,
      imageReady,
      promptIntegrity.complete && subtitleIntegrity.complete,
    )
    await invalidateEpisodeStatus(slug, episodeId)
    // E2–E4 — approved pictures are analysed in the background, once each (only where the channel has it on).
    if (body.all === true) queueEpisodeAnalysisSoon(slug, episodeId)
    else if (typeof body.scene_id === 'string' && body.approved) queueEpisodeAnalysisSoon(slug, episodeId, [body.scene_id])
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
    // `?thumb=1`: the grids ask for a small cached JPEG instead of the full-resolution still. Any
    // failure to make one (full disk, unreadable image) falls through to the original.
    const projectDir = req.query.thumb ? pm.getProjectDir(slug) : null
    if (projectDir) {
      try {
        const thumb = await ensureThumbnail({ projectDir, group: episodeId.toUpperCase(), id: sceneId, source: imagePath })
        const stat = await fs.stat(thumb)
        res.setHeader('Content-Type', 'image/jpeg')
        if (revalidatePreview(req, res, stat)) return
        res.setHeader('Content-Length', String(stat.size))
        streamTo(res, createReadStream(thumb))
        return
      } catch (error: any) {
        console.warn(`[scene-review] thumbnail for ${sceneId} unavailable, serving the original: ${error?.message || error}`)
      }
    }
    res.setHeader('Content-Type', 'image/png')
    // Versioned URLs (`?v=size-mtime`, from the review payload) are immutable;
    // an unversioned request stays uncached so a plain reload sees a regen.
    res.setHeader('Cache-Control', mediaCacheControl(req))
    // Chunked on purpose: a render can replace this file between a stat and
    // the stream, and a declared length that no longer matches aborts the
    // response mid-image.
    streamTo(res, createReadStream(imagePath))
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
    // The owner's explicit choice when he made one (v1.4.314), else the largest
    // file — the same answer the status endpoint above gives, so the player and
    // the scene list never describe different tracks.
    let audioPath: string | null = null
    let bestSize = 0
    const files = await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])
    const choice = await resolveEpisodeMergedAudioChoice(paths.merged_audio_dir, episodeId)
    const pinned = choice.source === 'selected' ? choice.filename : null
    if (choice.source !== 'invalid') {
      for (const f of files) {
        if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
        if (pinned && f !== pinned) continue
        const stat = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
        if (stat && stat.size > bestSize) {
          bestSize = stat.size
          audioPath = path.join(paths.merged_audio_dir, f)
        }
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
