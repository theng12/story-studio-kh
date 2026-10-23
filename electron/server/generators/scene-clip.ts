/**
 * Per-scene image-to-video clip generator (v1.0.470 — Phase 2 of the
 * motion-prompt feature).
 *
 * Mirrors generateSceneImageJob, but instead of producing a still it ANIMATES
 * an already-generated scene image into a short clip:
 *   - Input:  scene id + its `image_path` (the still) + its `motion_prompt`
 *             (the image-to-video instruction written by the scene planner)
 *   - Output: single mp4 at <11 Video Assets>/<scene_id>.mp4
 *   - Side effect: records `clip_path` + `rendered_motion_prompt` back onto the
 *     scene in scene_plan.json (re-read-before-write, like the image path)
 *
 * The image-to-video providers (fal-video / kie-video) already exist — this
 * just wires the per-scene image + motion prompt into them. The clip lives in
 * the dedicated "11 Video Assets" folder (heavy media → migrates to media_root).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { downloadVideo } from '../lib/download-video.js'
import { assertPlayableSceneClip } from '../lib/scene-clip-media.js'
import { resolveEpisodePathsByCode, resolveSubfolderNames, resolveScenePlanPath, type ProjectFactsCache } from '../services/utils.js'
import { resolveSceneImageReadPath } from './scene-image.js'
import { findSubfolder } from '../lib/folder-resolver.js'
import { mediaEpisodeBaseForCode } from '../services/media-root.js'
import * as jq from '../services/job-queue.js'
import type { Job, SceneClipVariantSelection, ScenePlan } from '../models/types.js'
import { auditSceneClipCompletion, checkpointSceneClip, assertSketchDrawClip, isSceneClipFresh, resolveSketchDrawSettings, sceneClipStaleReason, sceneWindowSeconds } from '../services/scene-media-checkpoint.js'
import { NATIVE_CLIP_QUALITY, renderSketchDraw } from '../lib/native-scene-clip.js'
import { NATIVE_SCENE_CLIP_VERSION } from '../lib/native-scene-clip-version.js'
import { assertDecodableImage } from '../lib/image-validation.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { normalizeMotionScope, resolveMotionScope, type MotionScope } from '../contracts/motion-scope.js'
import { motionSceneIdsForNewRequest } from '../services/scene-motion-prompt-scope.js'
import { createHash } from 'crypto'
import os from 'os'
import { hashInput, readManifest, recordTask, recordTaskStrict, type TaskManifestEntry } from '../services/task-manifest.js'
import { checkpointGenStudioAsset, type GenStudioRecoveryState } from '../services/genstudio-recovery.js'
import { getApiKey } from '../services/app-secrets-store.js'
import {
  buildGenStudioVideoIdempotencyKey,
  cheapestGenStudioVideoVariant,
  describeGenStudioVideoVariant,
  findGenStudioVideoVariant,
  generateVideoWithGenStudio,
  GenStudioTerminalFailureError,
  listVideoModels as listGenStudioVideoModels,
  publishedVideoControls,
  recoverVideoWithGenStudio,
  resolveGenStudioRetryScope,
  supportsGenStudioVideoMode,
  STORY_STUDIO_VIDEO_MODE,
  variantsForGenStudioVideoOperation,
  type GenStudioVideoVariant,
  type GenStudioVideoModel,
  type GenStudioVideoRequest,
  isGenStudioInsufficientCredits,
} from '../lib/genstudio-client.js'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'
import { isRetiredVideoModelId } from '../contracts/retired-video-models.js'
import { fleetBusyRetryPlan, freeMacWaitLine, isFleetBusyFailure, isFreeMacPlan } from '../lib/genstudio-fleet-busy.js'

/**
 * Local `last_state` values that mean the saved GenStudio video job can never
 * yield a clip again. Mirrors `isTerminalGenStudioTaskFailure` in
 * generators/audio.ts — the proven pattern.
 *
 * NOTE: there is no `cancelled` JobState in GenStudio; cancellation arrives as
 * a boolean and is normalised into `failed` before it reaches the manifest.
 */
const TERMINAL_CLIP_TASK_STATES: ReadonlySet<string> = new Set(['failed', 'artifact_expired'])

/**
 * An accepted GenStudio video task can be safely reconnected after a restart or
 * a lost network response. A terminal provider failure cannot: its idempotency
 * key intentionally resolves to the same failed GenStudio job forever, so
 * reusing it can never produce a new clip.
 */
export function isTerminalGenStudioClipTaskFailure(entry: {
  task_id?: string
  last_state?: string
} | null | undefined): boolean {
  return Boolean(entry?.task_id && entry.last_state && TERMINAL_CLIP_TASK_STATES.has(entry.last_state))
}

/** One scheduled re-ask for this clip, or `null` to fail it exactly as before. */
export interface SceneClipFleetBusyPlan {
  waitMs: number
  reason: string
  maxAttempts: number
}

/**
 * v1.4.31 — the ONE failure Motion Review asks about a second time: GenStudio
 * had no free MACHINE for the clip.
 *
 * WHY HERE. GenStudio places every job on a fleet machine, and with none free
 * it settles the job FAILED with `SITE_PLACEMENT_EXHAUSTED` after a
 * fifteen-minute placement window. A generator that does not recognise that
 * DROPS the item and tells the owner to re-run it by hand. Two operations have
 * already done it: transcription lost 122 of 353 items in one burst, and TTS
 * lost 5 over three days that nobody noticed for nine, because the only symptom
 * is a missing asset a later manual retry quietly fills in. A motion batch runs
 * every non-still scene in an episode through this function in one queue job,
 * and a refusal here does not merely drop one clip — it throws out of
 * `generateSceneClipsBatchJob` and ends the whole run.
 *
 * WHY RESUBMITTING IS FREE. GenStudio raises this code from one place and says
 * there what became of the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so another attempt is a
 * fresh charge for work that never happened — not a second charge for the same
 * work. The argument does not extend one inch further, and it matters more here
 * than anywhere else in the app: VIDEO is the most expensive thing Story Studio
 * buys, so a failure code that might describe work a provider already did gets
 * no plan and fails the clip exactly as it does today.
 *
 * MODALITY. `'video'`, read from `GenStudioVideoTerminalFailureError`, which
 * builds its base with `super('video', job, …)` in lib/genstudio-client.ts —
 * not the `'image'` this generator's still-image neighbours pass. A saturated
 * image or TTS queue says nothing about whether THIS clip's credits came back.
 *
 * This deliberately does NOT reuse `generators/images.ts`'s `imageRetryPlan`,
 * which ALSO retries a declined route (`CLOUD_PROVIDER_EXHAUSTED`) on a
 * seconds-long schedule and hardcodes the image modality. Motion Review has
 * never had a route retry; importing that to save a few lines would smuggle a
 * second, unasked-for behaviour change into a fix about a busy fleet — on the
 * priciest modality there is. `sceneImagesBatchFleetBusyRetryPlan` is the right
 * shape but is likewise pinned to `'image'`.
 *
 * Exported as a pure function so the decision is testable on its own, without
 * driving a real episode of paid clips against a saturated fleet to observe it.
 *
 * @param attemptNum the 1-based attempt that just failed.
 */
export function sceneClipFleetBusyRetryPlan(e: unknown, attemptNum: number): SceneClipFleetBusyPlan | null {
  if (!isFleetBusyFailure(e, 'video')) return null
  return fleetBusyRetryPlan(e, 'video', attemptNum - 1)
}

/**
 * Canonical "11 Video Assets" directory for an episode — the named folder
 * (media-root-aware + "✅ "-prefix-tolerant), mirroring resolveSceneImagesDir.
 * Returns the existing on-disk folder when present, else the canonical path
 * (callers mkdir before writing).
 */
export async function resolveVideoAssetsDir(
  slug: string,
  code: string,
  episodeDir: string,
  cache?: ProjectFactsCache,
): Promise<string> {
  const names = await resolveSubfolderNames(slug, code, cache)
  const mediaBase = await mediaEpisodeBaseForCode(slug, code, cache).catch(() => null)
  const parent = mediaBase || episodeDir
  const found = await findSubfolder(parent, names.video_assets)
  return found || path.join(parent, names.video_assets)
}

interface SceneClipGenerateParams {
  renderer?: 'image_to_video' | 'sketch_draw'
  episode_id: string
  /** Stable id of the scene to animate. Must exist in scene_plan.json with a
   *  non-empty image_path (the still to animate) + motion_prompt. */
  scene_id: string
  /** Image-to-video model id — a key in config.video_models whose `modes`
   *  include 'frames'. */
  model: string
  /** Exact GenStudio-published output aspect ratio. */
  aspect_ratio?: string
  /** Exact GenStudio-published pair saved when the job was queued. */
  operation?: string
  duration_seconds?: number
  resolution?: string
  /**
   * The published `audio` switch for this clip, when the operator set it.
   *
   * Only a switch the SELECTED model publishes is honoured; anything else is dropped below,
   * with a line in the job log, rather than sent to a lane that would ignore or refuse it.
   * Absent means the lane's own default — which is why `undefined` and `true` are different
   * requests in the idempotency digest rather than the same one written twice.
   */
  audio?: boolean
  /** Exact per-scene requests accepted at enqueue time. Follow narration
   * resolves these from the authoritative Scene Plan windows. */
  scene_durations?: Record<string, {
    duration_seconds: number
    narration_duration_seconds: number
  }>
  duration_mode?: 'manual' | 'follow_narration'
  /** Exact eligible IDs accepted for a new bulk motion request. */
  motion_scene_ids?: string[]
  /** Explicit episode scope accepted before a Pipeline replan. The new plan
   * resolves this once into motion_scene_ids before any clip request. */
  motion_scope?: MotionScope
  /** Source chosen when this clip request was accepted; the queue validates it before work starts. */
  visual_source?: 'scene_plan' | 'image_pool'
  /** Unattended pipeline runs approve their generated clip automatically. */
  auto_approve_clip?: boolean
}

// One-way migration aid only — NEVER a source of execution authority for
// new work. `resolveSceneClipCatalogModel` is called exclusively with an
// already-selected/saved `model` id (every caller — generateSceneClipJob
// and the three routes/scene-review.ts endpoints — throws before this point
// if no model was supplied; there is no "pick a default" path through these
// hints). A legacy id only resolves when it fuzzy-matches EXACTLY ONE live,
// `available` GenStudio image-to-video product; any other outcome (zero or
// multiple matches) returns null and the caller surfaces a clear error
// instead of guessing. Keep this list from ever being consulted for a
// model that wasn't explicitly chosen by the user in the past.
// model-drift-allow: retired direct-provider ids, kept only so a saved legacy
// selection can be fuzzy-matched onto a live GenStudio product. They are never
// consulted for new work and can never select their former provider.
const LEGACY_VIDEO_NAME_HINTS: Readonly<Record<string, readonly string[]>> = {
  'fal-veo-3.1-i2v': ['veo', '3.1'],
  'fal-hailuo-02-i2v': ['hailuo', '02'],
  'fal-wan-i2v': ['wan'],
  'kie-kling-3': ['kling', '3'],
  'kie-veo3-fast': ['veo', '3', 'fast'],
  'kie-veo3': ['veo', '3'],
  'kie-veo3-lite': ['veo', '3', 'lite'],
}

function searchableModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim()
}

/**
 * Resolve a saved selection only against GenStudio's live, account-visible
 * image-to-video catalog. Legacy fal/Kie ids are migration hints only: they
 * can never select their former direct provider.
 */
export function resolveSceneClipCatalogModel(
  selectedModel: string,
  catalog: readonly GenStudioVideoModel[],
): string | null {
  const raw = selectedModel.trim().replace(/^genstudio-video:/, '')
  if (!raw || isRetiredVideoModelId(raw)) return null
  // The image-to-video restriction is applied HERE, at the selection call
  // site, rather than by discarding other published modes during the parse.
  const available = catalog.filter(model => model.available && model.locked !== true && supportsGenStudioVideoMode(model))
  const canonical = resolveGenStudioModelId('video', raw)
  const exact = available.find(model => model.id === canonical || model.id === raw)
  if (exact) return exact.id
  const hints = LEGACY_VIDEO_NAME_HINTS[raw]
  if (!hints) return null
  const matches = available.filter(model => {
    const name = searchableModelName(`${model.id} ${model.display_name}`)
    return hints.every(hint => name.includes(searchableModelName(hint)))
  })
  return matches.length === 1 ? matches[0]!.id : null
}

/**
 * Select the exact current catalogue row for a queued clip. Every durable job
 * carries its published operation, duration, and resolution; incomplete or
 * retired selections stop before any provider POST.
 */
export function selectSceneClipGenStudioVariant(
  variants: readonly GenStudioVideoVariant[] | undefined,
  requestedVariant?: Partial<SceneClipVariantSelection>,
): GenStudioVideoVariant {
  const operation = requestedVariant?.operation
  if (!requestedVariant || operation !== STORY_STUDIO_VIDEO_MODE) {
    throw new Error(`A queued motion clip variant operation is required and must be ${STORY_STUDIO_VIDEO_MODE}.`)
  }
  const intended = variantsForGenStudioVideoOperation(variants, operation)
  const cheapest = cheapestGenStudioVideoVariant(intended)
  if (!cheapest) throw new Error('The Gateway publishes no priced duration/resolution variant for this model.')
  const duration = requestedVariant.duration_seconds
  const resolution = requestedVariant.resolution
  if (typeof duration !== 'number' || !Number.isFinite(duration) || typeof resolution !== 'string' || !resolution.trim()) {
    throw new Error('A queued motion clip variant must include both duration_seconds and resolution.')
  }
  const matches = intended.filter(variant => (
    variant.duration_seconds === duration && variant.resolution.trim() === resolution.trim()
  ))
  if (!matches.length) {
    throw new Error(`The Gateway does not publish a ${duration}s at ${resolution.trim()} option for this model.`)
  }
  // **A duration and resolution can name more than one row, and the aspect ratio is what
  // separates them.** A Studio Hub video lane publishes canvases as pairs — its 448p class
  // carries 704x448 (11:7) and 448x448 (1:1) — so choosing the first match would submit the
  // landscape request against the square row. Where the catalogue states a ratio per row, the
  // requested ratio selects the row; a ratio the catalogue does not publish for this duration
  // and resolution is a loud refusal naming the ones it does.
  const requestedAspect = typeof requestedVariant.aspect_ratio === 'string'
    ? requestedVariant.aspect_ratio.trim()
    : ''
  const stated = matches.filter(variant => typeof variant.aspect_ratio === 'string' && variant.aspect_ratio.trim())
  if (!requestedAspect || !stated.length) return matches[0]
  const ratioMatch = stated.find(variant => variant.aspect_ratio!.trim() === requestedAspect)
  if (ratioMatch) return ratioMatch
  throw new Error(
    `The Gateway does not publish ${requestedAspect} at ${duration}s ${resolution.trim()} for this model; `
    + `that duration and resolution offer: ${stated.map(variant => variant.aspect_ratio!.trim()).join(', ')}.`,
  )
}

/** Round narration UP to a currently published duration at the chosen
 * resolution; exceeding the published ceiling deliberately chooses that
 * ceiling so assembly can hold the final frame for the visible shortfall. */
export function selectSceneClipNarrationVariant(
  variants: readonly GenStudioVideoVariant[] | undefined,
  resolution: string,
  narrationDurationSeconds: number,
  aspectRatio?: string,
): GenStudioVideoVariant {
  if (!Number.isFinite(narrationDurationSeconds) || narrationDurationSeconds <= 0) {
    throw new Error('Scene narration duration must be a positive number.')
  }
  const normalizedResolution = resolution.trim().toLowerCase()
  const forResolution = variantsForGenStudioVideoOperation(variants, STORY_STUDIO_VIDEO_MODE)
    .filter(variant => variant.resolution.trim().toLowerCase() === normalizedResolution)
  // The requested ratio keeps this on one canvas where the catalogue states a ratio per row,
  // so a portrait request is not measured against the landscape row's durations.
  const requested = typeof aspectRatio === 'string' ? aspectRatio.trim() : ''
  const ratioMatched = requested
    ? forResolution.filter(variant => typeof variant.aspect_ratio === 'string' && variant.aspect_ratio.trim() === requested)
    : []
  const candidates = (ratioMatched.length ? ratioMatched : forResolution)
    .sort((a, b) => a.duration_seconds - b.duration_seconds)
  if (!candidates.length) {
    throw new Error(`The Gateway publishes no priced image-to-video duration at ${resolution.trim()} for this model.`)
  }
  return candidates.find(variant => variant.duration_seconds >= narrationDurationSeconds) || candidates.at(-1)!
}

/** Resolve a live, selected image-to-video product without inventing a
 * duration/resolution choice. */
export async function requireSceneClipGenStudioCatalogModel(
  selectedModel: string,
): Promise<{ apiKey: string; modelId: string; model: GenStudioVideoModel }> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    throw new Error('Add a Gateway API Key in Settings → This Mac before generating motion clips.')
  }
  const catalog = await listGenStudioVideoModels(apiKey)
  const modelId = resolveSceneClipCatalogModel(selectedModel, catalog)
  if (!modelId) {
    throw new Error(
      isRetiredVideoModelId(selectedModel)
        ? `Saved video model "${selectedModel}" has been retired and was not requested. `
          + 'Choose an available Gateway image-to-video model, or leave the scene still.'
        : `Saved video model "${selectedModel}" is not available through the Gateway. `
          + 'Choose an available Gateway image-to-video model; no other route was attempted.',
    )
  }
  return { apiKey, modelId, model: catalog.find(model => model.id === modelId)! }
}

/** Resolve the selected model and its exact current published variant. */
export async function requireSceneClipGenStudioModel(
  selectedModel: string,
  requestedVariant?: Partial<SceneClipVariantSelection>,
): Promise<{
  apiKey: string
  modelId: string
  model: GenStudioVideoModel
  variant: GenStudioVideoVariant
}> {
  const { apiKey, modelId, model } = await requireSceneClipGenStudioCatalogModel(selectedModel)
  const variant = selectSceneClipGenStudioVariant(model.variants, requestedVariant)
  return { apiKey, modelId, model, variant }
}

/** Local-only path: no catalogue, credentials, task manifest or paid request. */
export async function generateSketchDrawSceneClip(job: Job, render = renderSketchDraw): Promise<void> {
  const { episode_id: episodeId, scene_id: sceneId } = job.params as SceneClipGenerateParams
  if (!episodeId || !sceneId || !/^[A-Za-z0-9_-]+$/.test(sceneId)) throw new Error('episode_id and a valid scene_id are required')
  const assertActive = () => {
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    jq.throwIfPauseRequested(job.job_id)
  }
  assertActive()
  const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
  const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  const scene = plan.scenes.find(item => item.id === sceneId)
  if (!scene) throw new Error(`Scene ${sceneId} no longer exists. Retry after repairing Scene Plan.`)
  if (!scene.approved) throw new Error(`Scene ${sceneId} needs image approval before Sketch Draw.`)
  // Resolve only this episode's own stable-id image; a stored foreign path is never substituted.
  const imagePath = await resolveSceneImageReadPath(job.project_slug, episodeId.toUpperCase(), paths.episode_dir, sceneId)
  if (!imagePath) throw new Error(`Scene ${sceneId} has no image. Generate or upload its image, then Retry.`)
  await assertDecodableImage(imagePath, `Image for ${sceneId}`)
  const imageBytes = await fs.readFile(imagePath)
  const sourceSha256 = createHash('sha256').update(imageBytes).digest('hex')
  let window: number
  try { window = sceneWindowSeconds(scene) }
  catch { throw new Error(`Scene ${sceneId} has an invalid Scene Plan window. Repair its timeline, then Retry.`) }
  const settings = await resolveSketchDrawSettings(job.project_slug, episodeId)
  const frames = Math.round(window * settings.fps)
  if (!Number.isSafeInteger(frames) || frames < 1) throw new Error(`Scene ${sceneId} has no renderable frames. Repair Scene Plan and Retry.`)
  const outDir = await resolveVideoAssetsDir(job.project_slug, episodeId.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })
  // Evidence lives in app temp, never in the customer's Video Assets folder. A success
  // removes it; a failure keeps it there for review and never touches the accepted clip.
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-sketch-'))
  let activated = false
  try {
    const candidatePath = path.join(workDir, 'candidate.mp4')
    const snapshotPath = path.join(workDir, 'source.png')
    await fs.writeFile(snapshotPath, imageBytes)
    const pen = settings.pen.mode === 'logo'
      ? { mode: 'logo' as const, logo: path.join(workDir, 'logo.png') }
      : settings.pen
    if (pen.mode === 'logo') await fs.writeFile(pen.logo, settings.logoBytes!)
    const helperJob = { kind: 'sketch' as const, input: snapshotPath, output: candidatePath,
      width: settings.width, height: settings.height, fps: settings.fps, frames,
      paper: '#ffffff', pen, quality: NATIVE_CLIP_QUALITY }
    job.output_lines.push(`Scene ${sceneId}: Sketch Draw locally, ${frames} frames at ${settings.fps} fps (${window}s).`)
    job.progress = 10
    assertActive()
    await render(helperJob, { trackChild: jq.trackChild })
    assertActive()
    const duration = await assertSketchDrawClip(candidatePath, { ...settings, frames })
    assertActive()
    const outPath = path.join(outDir, `${sceneId}.mp4`)
    // Settings are NOT passed here: the checkpoint resolves them live under its lock, so a
    // pen/name/logo/fps change during the render refuses activation instead of baking it in.
    await checkpointSceneClip(planPath, sceneId, outPath, '',
      undefined, job.params.auto_approve_clip === true, {
        renderer: 'sketch_draw', source_image_sha256: sourceSha256,
        scene_window_seconds: window, duration_seconds: duration,
        shortfall_mode: 'hold', sketch: { helper_version: NATIVE_SCENE_CLIP_VERSION,
          fps: settings.fps, frames, width: settings.width, height: settings.height,
          pen_fingerprint: settings.penFingerprint },
        candidate_path: candidatePath,
        context: { slug: job.project_slug, episodeId, episodeDir: paths.episode_dir, imagePath }, assertActive,
      })
    activated = true
    job.output_dir = outDir
    // The checkpoint re-read the plan and current settings under its lock; the candidate was
    // verified once before activation. No second decode of the published file is needed.
    requireJobCompletion(job, { label: 'Sketch Draw', expected: 1, completed: 1,
      retry_hint: 'Retry renders only missing or stale scenes; verified clips are kept.' })
    job.progress = 100
    job.output_lines.push(`Sketch Draw saved for ${sceneId}.`)
  } catch (error) {
    job.output_lines.push(`Sketch Draw evidence retained in app temp: ${workDir}`)
    throw error
  } finally {
    if (activated) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function generateSketchDrawBatch(job: Job, render = renderSketchDraw): Promise<void> {
  const params = job.params as SceneClipGenerateParams
  const episodeId = params.episode_id
  if (!episodeId) throw new Error('episode_id is required')
  const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
  const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  const ids = params.motion_scene_ids
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id))
    || new Set(ids).size !== ids.length) throw new Error('Sketch Draw requires the saved scoped scene IDs. Submit the motion batch again.')
  const clipsDir = await resolveVideoAssetsDir(job.project_slug, episodeId.toUpperCase(), paths.episode_dir)
  // Eligibility uses one snapshot; the completion audit below re-resolves live settings so a
  // pen/fps change during the batch is reported as stale by scene name, never as success.
  const filterContext = { slug: job.project_slug, episodeId, episodeDir: paths.episode_dir,
    sketchSettings: plan.scenes.some(scene => scene.clip_renderer === 'sketch_draw')
      ? await resolveSketchDrawSettings(job.project_slug, episodeId).catch(() => undefined) : undefined }
  const requiredIds: string[] = []
  const freshIds: string[] = []
  const stillIds = new Set<string>()
  for (const sceneId of ids) {
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (scene?.motion_choice === 'still') { stillIds.add(sceneId); continue }
    if (scene?.clip_renderer === 'sketch_draw' && scene.image_sha256
      && await isSceneClipFresh(scene, path.join(clipsDir, `${sceneId}.mp4`), filterContext)) freshIds.push(sceneId)
    else requiredIds.push(sceneId)
  }
  const originalParams = job.params
  // Motion Review's Generate leaves clips for the customer to review; only an explicit request chooses them.
  const autoApprove = originalParams.auto_approve_clip === true
  const failures: string[] = []
  try {
    // A fresh but pending retry is approved from its existing evidence; it is never rendered again.
    for (const sceneId of autoApprove ? freshIds : []) {
      const scene = plan.scenes.find(item => item.id === sceneId)
      if (!scene || scene.motion_choice === 'clip') continue
      try {
        await checkpointSceneClip(planPath, sceneId, path.join(clipsDir, `${sceneId}.mp4`), '',
          undefined, true, {
            renderer: 'sketch_draw', source_image_sha256: scene.clip_source_image_sha256,
            scene_window_seconds: scene.clip_scene_window_seconds, sketch: scene.clip_sketch,
            shortfall_mode: 'hold',
            context: { slug: job.project_slug, episodeId, episodeDir: paths.episode_dir },
          })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.push(`${sceneId}: ${reason}`)
        job.output_lines.push(`Scene ${sceneId} could not be approved from its existing clip: ${reason}`)
      }
    }
    for (const sceneId of requiredIds) {
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
      jq.throwIfPauseRequested(job.job_id)
      const scene = plan.scenes.find(item => item.id === sceneId)
      if (scene?.motion_choice === 'still') continue
      try {
        if (!scene) throw new Error('missing from Scene Plan')
        job.params = { ...originalParams, scene_id: sceneId, auto_approve_clip: autoApprove }
        await generateSketchDrawSceneClip(job, render)
      } catch (error) {
        if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id) || error instanceof jq.JobPausedError) throw error
        const reason = error instanceof Error ? error.message : String(error)
        failures.push(`${sceneId}: ${reason}`)
        job.output_lines.push(`Scene ${sceneId} failed: ${reason}. Other verified clips are kept.`)
      }
    }
  } finally { job.params = originalParams }
  // Live settings resolved once now (not the pre-render snapshot): catches a channel change
  // during this batch and names affected scenes through the audit.
  const auditSettings = await resolveSketchDrawSettings(job.project_slug, episodeId).catch(() => undefined)
  const audit = await auditSceneClipCompletion(planPath, ids, clipsDir, {},
    { slug: job.project_slug, episodeId, episodeDir: paths.episode_dir, sketchSettings: auditSettings, stillIds: [...stillIds], requireSelected: autoApprove })
  requireJobCompletion(job, { label: 'Sketch Draw batch', expected: audit.expected, completed: audit.completed,
    missing: audit.missing, invalid: [...audit.invalid, ...failures],
    retry_hint: 'Retry renders only missing, invalid or stale scenes. Every verified clip is kept.' })
  if (!requiredIds.length) job.output_lines.push(autoApprove
    ? 'Every required scene already has a fresh, selected Sketch Draw clip.'
    : 'Every required scene already has a fresh Sketch Draw clip to review.')
  job.output_dir = clipsDir
  job.progress = 100
}

export async function generateSceneClipJob(job: Job): Promise<void> {
  if (job.params?.renderer === 'sketch_draw') return generateSketchDrawSceneClip(job)
  const params = job.params as SceneClipGenerateParams
  const { episode_id, scene_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!scene_id) throw new Error('scene_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error(`No scene_plan.json at ${planPath}. Run Scene Plan first.`)

  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  const scene = plan.scenes.find(s => s.id === scene_id)
  if (!scene) throw new Error(`Scene ${scene_id} not in scene_plan.json (was it deleted?)`)
  const resolvedImagePath = scene.image_path && existsSync(scene.image_path)
    ? scene.image_path
    : await resolveSceneImageReadPath(job.project_slug, episode_id.toUpperCase(), paths.episode_dir, scene_id)
  if (!resolvedImagePath) {
    throw new Error(`Scene ${scene_id} has no generated image to animate — generate the image first.`)
  }
  if (!scene.motion_prompt || !scene.motion_prompt.trim()) {
    throw new Error(`Scene ${scene_id} has no motion_prompt — write one on the Scene Plan page first.`)
  }

  // The ratio is resolved BEFORE the variant, because the variant is a *row* of the catalogue and
  // the ratio is part of which row this is. A queued job whose ratio and resolution are not one
  // published row is refused here, naming the rows that exist, rather than submitted and refused
  // by the lane — or worse, submitted and answered with a different shape.
  const requestAspect = typeof params.aspect_ratio === 'string' ? params.aspect_ratio.trim() : ''
  if (!requestAspect) {
    throw new Error(`An aspect ratio is required for ${model}; The Gateway publishes no default aspect ratio for video models.`)
  }

  // Re-check the live catalog at execution time. A queued historical job may
  // outlive a route/catalog refresh, but it must never revive a direct route.
  const savedDuration = params.scene_durations?.[scene_id]
  const requestedVariant = params.operation === undefined && params.duration_seconds === undefined && params.resolution === undefined
    ? undefined
    : {
      operation: params.operation,
      duration_seconds: savedDuration?.duration_seconds ?? params.duration_seconds,
      resolution: params.resolution,
      aspect_ratio: requestAspect,
    }
  const { apiKey, modelId, model: catalogModel, variant } = await requireSceneClipGenStudioModel(model, requestedVariant)
  if (!catalogModel.aspect_ratios.some(ratio => ratio.trim() === requestAspect)) {
    throw new Error(`Gateway model ${modelId} does not publish aspect ratio ${requestAspect}.`)
  }
  // The ratio actually submitted: the resolved row's own published one where the catalogue states
  // it, otherwise the ratio the caller asked for. It is the same value the selector used to choose
  // the row, so what is submitted and what was priced cannot be two different canvases.
  const submittedAspect = typeof variant.aspect_ratio === 'string' && variant.aspect_ratio.trim()
    ? variant.aspect_ratio.trim()
    : requestAspect

  // The published `audio` switch, resolved against the row this clip is actually billed at.
  // A model that publishes no switch gets no field — its own default decides — and a value
  // for a switch this model does not publish is dropped with a line saying so, because a
  // silently-forwarded field is a request nobody can account for afterwards.
  const publishesAudioSwitch = publishedVideoControls(catalogModel.controls)
    .some(control => control.name === 'audio')
  if (typeof params.audio === 'boolean' && !publishesAudioSwitch) {
    job.output_lines.push(
      `Ignoring audio=${params.audio}: ${modelId} publishes no audio switch, so its own default applies.`,
    )
  }
  const audioChoice = publishesAudioSwitch && typeof params.audio === 'boolean' ? params.audio : undefined

  job.output_lines.push(`Scene ${scene.scene_index} (${scene_id}) — animate via the Gateway / ${modelId}`)
  // The operation, duration, and resolution actually submitted are a current published
  // row. Say so, with its price: an enforced limit the user was never told
  // about is what turns a clear constraint into a mystery.
  job.output_lines.push(
    `Variant: ${variant.operation} / ${describeGenStudioVideoVariant(variant)} — the Gateway's published option for this model `
    + `(${variant.credits_per_video} credits, minimum ${variant.minimum_credits}, price ${variant.price_version}).`,
  )
  job.output_lines.push(`Motion: ${scene.motion_prompt.slice(0, 200)}${scene.motion_prompt.length > 200 ? '…' : ''}`)
  job.progress = 10

  // Resolve the output folder BEFORE submitting: the request identity has to be
  // persisted beside the expected clip before any paid POST leaves this process.
  const outDir = await resolveVideoAssetsDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })
  const manifestKey = `${scene_id}.mp4`
  const outPath = path.join(outDir, manifestKey)
  // From the model's published catalogue, never a constant in this file.
  const durationSeconds = variant.duration_seconds
  const resolution = variant.resolution
  const operation = variant.operation

  const manifest = await readManifest(outDir)
  // Mutable, and that is the point. After a settled failure this is replaced by
  // the EXACT entry just written to disk, so the identity the next attempt
  // derives is reproducible from the manifest alone. scene-images-batch had the
  // opposite shape — an in-memory entry built from pre-run state while disk
  // held the current attempt's — which was harmless until a retry read it and
  // then produced two identities for one retry.
  let savedEntry = manifest.tasks[manifestKey]?.provider === 'genstudio'
    ? manifest.tasks[manifestKey]!
    : null
  const sourceSha256 = createHash('sha256')
    .update(await fs.readFile(resolvedImagePath))
    .digest('hex')
  const baseIdentity = `${job.project_slug}:${episode_id}:${scene_id}:motion`

  /**
   * Sleep before re-asking a busy fleet — in short slices, so a Cancel or a
   * Pause pressed during a five-minute wait is honoured within seconds instead
   * of at the end of it. This generator owns no stall watchdog and nothing
   * external watches it — the job queue's stall circuit breaker has exactly one
   * caller in the app, continuity-render.ts, which had to suppress its own
   * 10-minute pause while waiting because a busy fleet is precisely what trips
   * it. There is no such timer here to suppress.
   */
  const waitForFleetCapacity = async (ms: number): Promise<void> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)) return
      await new Promise(resolve => setTimeout(resolve, Math.min(2_000, deadline - Date.now())))
    }
  }

  // v1.4.31 — attempts for THIS clip. Only a busy fleet earns another one; every
  // other outcome, good or bad, leaves this loop on the first pass.
  let attemptNum = 1
  let result: Awaited<ReturnType<typeof generateVideoWithGenStudio>>
  for (;;) {
    // Cancel is re-read at the top of EVERY attempt, not just once per clip: a
    // resubmission must never start after the owner has already stopped the
    // run, and a fleet wait runs into minutes.
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    // A terminal saved job promotes the scope to a NEW retry identity, derived
    // deterministically from the dead job id — never a clock, never a random.
    // Re-resolved per attempt so a fleet-busy retry picks up the identity the
    // failed manifest entry below derives, never the dead one.
    const retry = resolveGenStudioRetryScope(savedEntry, 'missing', isTerminalGenStudioClipTaskFailure)
    const requestScope = retry.scope
    const requestIdentity = requestScope === 'missing' ? baseIdentity : `${baseIdentity}:${requestScope}`
    const inputHash = hashInput(JSON.stringify({
      requestIdentity,
      prompt: scene.motion_prompt,
      modelId,
      sourceSha256,
      aspectRatio: submittedAspect,
      operation,
      durationSeconds,
      resolution,
      // The switch is part of what this request IS. A saved task with a track must never
      // satisfy a silent retry of the same scene, and both hash and key are what decide
      // whether a recovered job belongs to this request.
      audio: audioChoice ?? null,
    }))
    // Reconnect ONLY to a saved job that belongs to this exact request AND has
    // not already settled. Hash equality alone would let an old failed job
    // satisfy every future Retry.
    const recoveryEntry = savedEntry
      && savedEntry.input_hash === inputHash
      && !isTerminalGenStudioClipTaskFailure(savedEntry)
      ? savedEntry
      : null
    if (retry.isRetry) {
      job.output_lines.push(
        `The earlier video request ${(retry.previousTaskId || '').slice(0, 12)}… has ended; `
        + 'sending one new request.',
      )
    }
    const idempotencyKey = recoveryEntry?.idempotency_key || buildGenStudioVideoIdempotencyKey({
      prompt: scene.motion_prompt.trim(),
      modelId,
      sourceSha256,
      aspectRatio: submittedAspect,
      operation,
      durationSeconds,
      resolution,
      audio: audioChoice,
      requestIdentity,
    })
    const submittedAt = recoveryEntry?.submitted_at || new Date().toISOString()
    const preparedState = (recoveryEntry?.last_state || 'prepared') as GenStudioRecoveryState

    const clipManifestEntry = (overrides: Partial<TaskManifestEntry>): TaskManifestEntry => ({
      provider: 'genstudio',
      task_id: '',
      submitted_at: submittedAt,
      input_hash: inputHash,
      idempotency_key: idempotencyKey,
      operation: 'video',
      variant_operation: operation,
      request_scope: requestScope,
      ...overrides,
    })

    // Persist the request identity BEFORE the POST. If the response is lost, the
    // next attempt reads this key back and re-attaches instead of paying twice.
    await recordTaskStrict(outDir, manifestKey, clipManifestEntry({
      task_id: recoveryEntry?.task_id || '',
      last_state: preparedState,
    }))
    await checkpointGenStudioAsset(job, manifestKey, {
      operation: 'video',
      idempotency_key: idempotencyKey,
      ...(recoveryEntry?.task_id ? { job_id: recoveryEntry.task_id } : {}),
      state: preparedState,
    })

    const videoRequest: GenStudioVideoRequest = {
      prompt: scene.motion_prompt,
      modelId,
      sourceImagePath: resolvedImagePath,
      aspectRatio: submittedAspect,
      operation,
      durationSeconds,
      resolution,
      ...(typeof audioChoice === 'boolean' ? { audio: audioChoice } : {}),
      requestIdentity,
      idempotencyKey,
      isCancelled: () => jq.isCancelled(job.job_id),
      onJobAccepted: async (providerJobId, acceptedIdempotencyKey) => {
        await recordTaskStrict(outDir, manifestKey, clipManifestEntry({
          task_id: providerJobId,
          idempotency_key: acceptedIdempotencyKey,
          last_state: 'accepted',
        }))
        await checkpointGenStudioAsset(job, manifestKey, {
          operation: 'video',
          idempotency_key: acceptedIdempotencyKey,
          job_id: providerJobId,
          state: 'accepted',
        })
        job.output_lines.push(`${scene_id} sent to the Gateway.`)
      },
      onState: async (state, providerJobId) => {
        await recordTaskStrict(outDir, manifestKey, clipManifestEntry({
          task_id: providerJobId,
          last_state: state,
        }))
        await checkpointGenStudioAsset(job, manifestKey, {
          operation: 'video',
          idempotency_key: idempotencyKey,
          job_id: providerJobId,
          state: state as GenStudioRecoveryState,
        })
      },
      onReconnect: (providerJobId) => {
        job.output_lines.push(`Connection interrupted; reconnecting accepted Gateway task ${providerJobId}.`)
      },
    }

    try {
      if (recoveryEntry?.task_id) {
        job.output_lines.push(`Reclaiming accepted Gateway task ${recoveryEntry.task_id.slice(0, 12)}… for ${manifestKey}.`)
        result = await recoverVideoWithGenStudio(apiKey, recoveryEntry.task_id, videoRequest)
      } else {
        result = await generateVideoWithGenStudio(apiKey, videoRequest)
      }
      job.progress = 70
      // Recorded here, inside the attempt, so the succeeded entry carries the
      // identity of the attempt that actually produced the clip — not a
      // superseded one from before a fleet-busy wait.
      if (result.jobId) {
        await recordTask(outDir, manifestKey, clipManifestEntry({
          task_id: result.jobId,
          result_url: result.videoUrl,
          last_state: 'succeeded',
        }))
      }
      break
    } catch (error) {
      // Record a settled provider failure locally. Without this the next Retry
      // has no way to know the saved job can never succeed.
      if (error instanceof GenStudioTerminalFailureError && error.modality === 'video') {
        const failedTaskId = error.jobId || recoveryEntry?.task_id || ''
        const failedEntry = clipManifestEntry({
          task_id: failedTaskId,
          last_state: 'failed',
        })
        await recordTask(outDir, manifestKey, failedEntry)
        await checkpointGenStudioAsset(job, manifestKey, {
          operation: 'video',
          idempotency_key: idempotencyKey,
          ...(error.jobId ? { job_id: error.jobId } : {}),
          state: 'failed',
        })
        // Mirror the disk EXACTLY — `writeTaskEntry` replaces the entry whole,
        // so these are the same bytes. `resolveGenStudioRetryScope` reads this
        // at the top of the next attempt, which is what makes an in-process
        // retry and a crash-replay derive the SAME identity instead of two.
        savedEntry = failedEntry
        // ── "Every machine was busy" — wait, then ask again ──
        // The only failure this generator resubmits; see
        // `sceneClipFleetBusyRetryPlan` for why it costs nothing and why
        // nothing else qualifies. A task id is required because the next
        // identity is DERIVED from the dead job id: without one the scope
        // cannot be promoted, and the retry would replay a settled-failed key,
        // which returns the same failure forever.
        const retryPlan = sceneClipFleetBusyRetryPlan(error, attemptNum)
        if (retryPlan && failedTaskId && !jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {
          job.output_lines.push(isFreeMacPlan(retryPlan) ? freeMacWaitLine(`Scene ${scene.scene_index}`, error, retryPlan.waitMs) :
            `Scene ${scene.scene_index}: ${retryPlan.reason.toLowerCase()} — the clip was never started, `
            + 'so nothing was charged and the credits were returned. '
            + `Waiting ${Math.round(retryPlan.waitMs / 1000)}s and trying again `
            + `(attempt ${attemptNum + 1} of ${retryPlan.maxAttempts}).`,
          )
          await waitForFleetCapacity(retryPlan.waitMs)
          // Re-read after the wait. Minutes passed, and a Cancel or a Pause
          // pressed during them is the owner's last word — the clip then fails
          // exactly as it does today rather than being resubmitted.
          if (!jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {
            attemptNum++
            continue
          }
        }
      }
      throw error
    }
  }

  // Keep the last usable clip active until the replacement has decoded and
  // matched its paid duration. A rejected candidate remains beside it for
  // review, and no retry is submitted from this validation failure.
  const candidatePath = path.join(outDir, `.${scene_id}.${job.job_id}.candidate.mp4`)
  await downloadVideo(result.videoUrl, candidatePath, (received) => {
    // Coarse 70→95 progress band while the clip downloads.
    if (received > 0 && (job.progress ?? 0) < 95) job.progress = Math.min(95, (job.progress ?? 0) + 1)
  }, result.downloadHeaders)
  const outputStat = await fs.stat(candidatePath)
  if (!outputStat.isFile() || outputStat.size <= 0) throw new Error(`Downloaded clip is empty for scene ${scene_id}`)
  const measuredDurationSeconds = await assertPlayableSceneClip(candidatePath, durationSeconds)
  await fs.rename(candidatePath, outPath)
  job.progress = 95

  await checkpointSceneClip(
    planPath,
    scene_id,
    outPath,
    scene.motion_prompt,
    scene.image_version,
    params.auto_approve_clip === true,
    {
      requested_duration_seconds: durationSeconds,
      duration_seconds: measuredDurationSeconds,
      ...(params.duration_mode === 'follow_narration'
        ? { shortfall_mode: 'hold' as const }
        : {}),
    },
  )

  job.output_dir = outDir
  job.progress = 100
  requireJobCompletion(job, {
    label: 'Scene motion clip generation', expected: 1, completed: 1,
    retry_hint: 'The downloaded clip is kept; Retry repairs only an incomplete registration.',
  })
  job.output_lines.push(`✓ Clip saved: ${path.basename(outPath)}`)
}

/** Durable one-click step: animate every ready scene inside one queue job so
 * final assembly cannot overtake a fan-out of independent clip jobs. */
export async function generateSceneClipsBatchJob(job: Job): Promise<void> {
  if (job.params?.renderer === 'sketch_draw') return generateSketchDrawBatch(job)
  const params = job.params as SceneClipGenerateParams
  const { episode_id, model } = params
  if (!episode_id || !model) throw new Error('episode_id and model are required')
  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('No scene_plan.json yet — run Scene Plan first.')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  if (!plan.scenes.length) throw new Error('scene_plan.json has no scenes — run Scene Plan first.')
  const clipsDir = await resolveVideoAssetsDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  const ready = [] as ScenePlan['scenes']
  const blockers: string[] = []
  // A new request snapshots only scenes without a saved clip. On recovery,
  // preserve that accepted paid-work boundary even if a prompt/image changed
  // while the queue was waiting. Legacy jobs have no map and retain their
  // historical reconciliation behavior.
  let snapshotIds = Array.isArray(params.motion_scene_ids) ? params.motion_scene_ids : null
  if (params.motion_scene_ids !== undefined && snapshotIds === null) {
    throw new Error('Motion clip request has invalid scene IDs. Submit the scoped motion batch again.')
  }
  // Pipeline can rebuild Scene Plan earlier in the same chain, so it cannot
  // freeze IDs from the plan it is replacing. Its accepted scope is still an
  // immutable job parameter: resolve that scope against the newly saved plan
  // exactly once, then checkpoint the resulting IDs before preflight or paid
  // provider work. Jobs from older versions have neither field and keep their
  // established whole-plan recovery behavior.
  if (snapshotIds === null && params.motion_scope !== undefined) {
    const motionScope = normalizeMotionScope(params.motion_scope)
    snapshotIds = motionSceneIdsForNewRequest(
      plan.scenes,
      resolveMotionScope(plan.scenes, motionScope).scene_ids,
    )
    params.motion_scope = motionScope
    params.motion_scene_ids = snapshotIds
    await jq.checkpointJobState(job)
  }
  const requestedSceneIds = snapshotIds
    ? new Set(snapshotIds)
    : params.scene_durations ? new Set(Object.keys(params.scene_durations)) : null
  if (snapshotIds && (snapshotIds.some(id => typeof id !== 'string' || !id.trim()) || requestedSceneIds!.size !== snapshotIds.length)) {
    throw new Error('Motion clip request has invalid scene IDs. Submit the scoped motion batch again.')
  }
  const planIds = new Set(plan.scenes.map(scene => scene.id))
  const missingSnapshotIds = snapshotIds?.filter(id => !planIds.has(id)) || []
  if (missingSnapshotIds.length) {
    throw new Error(`Requested motion scenes no longer exist: ${missingSnapshotIds.join(', ')}. Submit the scoped motion batch again.`)
  }
  const requiredIds: string[] = requestedSceneIds ? [...requestedSceneIds] : []
  for (const scene of plan.scenes) {
    if (requestedSceneIds && !requestedSceneIds.has(scene.id)) continue
    if (scene.motion_choice === 'still') continue
    if (!requestedSceneIds) requiredIds.push(scene.id)
    const image = scene.image_path && existsSync(scene.image_path)
      ? scene.image_path
      : await resolveSceneImageReadPath(job.project_slug, episode_id.toUpperCase(), paths.episode_dir, scene.id)
    if (!image) { blockers.push(`${scene.id} (missing image)`); continue }
    const imageStat = await fs.stat(image).catch(() => null)
    if (!imageStat?.isFile() || imageStat.size <= 0) { blockers.push(`${scene.id} (empty image)`); continue }
    if (!scene.motion_prompt?.trim()) { blockers.push(`${scene.id} (missing motion prompt)`); continue }
    const clipPath = path.join(clipsDir, `${scene.id}.mp4`)
    const clipStat = await fs.stat(clipPath).catch(() => null)
    const freshClip = !!clipStat?.isFile() && clipStat.size > 0
      && !await sceneClipStaleReason(scene, { slug: job.project_slug, episodeId: episode_id, episodeDir: paths.episode_dir })
      && scene.motion_choice === 'clip'
    if (!freshClip) ready.push(scene)
  }
  if (blockers.length) {
    requireJobCompletion(job, {
      label: 'Motion clip preflight', expected: requiredIds.length,
      completed: requiredIds.length - blockers.length,
      invalid: blockers,
      retry_hint: 'Generate the missing image/motion prompts or mark those scenes Still, then Retry.',
    })
  }
  if (!ready.length) {
    const expectedDurations = Object.fromEntries(requiredIds.flatMap(sceneId => {
      const duration = params.scene_durations?.[sceneId]?.duration_seconds ?? params.duration_seconds
      return typeof duration === 'number' ? [[sceneId, duration]] : []
    }))
    const audit = await auditSceneClipCompletion(planPath, requiredIds, clipsDir, expectedDurations,
      { slug: job.project_slug, episodeId: episode_id, episodeDir: paths.episode_dir })
    job.progress = 100
    requireJobCompletion(job, {
      label: 'Motion clip generation', expected: audit.expected, completed: audit.completed,
      missing: audit.missing, invalid: audit.invalid,
      retry_hint: 'Saved clips that fail verification are preserved; use the visible per-scene Regenerate action to replace them.',
    })
    job.output_lines.push('All required scenes already have fresh, selected image-to-video clips.')
    return
  }

  const originalParams = job.params
  job.output_lines.push(`Motion Clips: ${ready.length} scene(s), processed in order to avoid provider bursts.`)
  const clipFailures: string[] = []
  try {
    for (let index = 0; index < ready.length; index++) {
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
      jq.throwIfPauseRequested(job.job_id)
      const scene = ready[index]!
      job.params = {
        ...job.params,
        episode_id,
        scene_id: scene.id,
        model,
        aspect_ratio: params.aspect_ratio,
        operation: params.operation,
        duration_seconds: params.scene_durations?.[scene.id]?.duration_seconds ?? params.duration_seconds,
        resolution: params.resolution,
        auto_approve_clip: true,
      }
      try {
        await generateSceneClipJob(job)
      } catch (error) {
        // v1.4.35 — one refused clip no longer ends the episode's whole motion
        // pass.
        //
        // This loop had NO per-scene catch, so a single failure on scene 3 of
        // 50 threw out of the batch and the remaining 47 were never attempted —
        // not failed, not reported, simply never tried. 1.4.31 made a busy
        // fleet wait, which meant the batch survived a busy moment, but it
        // still died outright on any other refusal. Every comparable generator
        // in this app (images.ts, image-pool-generate.ts) records the item and
        // carries on, and `auditSceneClipCompletion` below already names every
        // missing clip — so continuing loses no information and gains 47 clips.
        //
        // Three things still stop the whole run, because continuing would be
        // wrong for each: the owner cancelled, the owner paused, or the account
        // is out of credits (every subsequent scene would fail identically and
        // charge nothing but time).
        if (error instanceof jq.JobPausedError || jq.isPauseRequested(job.job_id)) throw error
        if (jq.isCancelled(job.job_id)) throw error
        if (isGenStudioInsufficientCredits(error)) throw error
        const reason = error instanceof Error ? error.message : String(error)
        clipFailures.push(`${scene.id}: ${reason}`)
        job.output_lines.push(`✗ ${scene.id} failed: ${reason}. Continuing with the remaining scene(s).`)
      }
      job.progress = Math.round(((index + 1) / ready.length) * 100)
    }
  } finally {
    // v1.4.35 — carry the recovery checkpoint back out.
    //
    // `checkpointGenStudioAsset` writes `genstudio_recovery` onto whatever
    // object `job.params` currently points at — which, inside this loop, is the
    // per-scene object built above. Restoring `originalParams` wholesale threw
    // every one of those checkpoints away, so batch-mode crash recovery lost
    // the hints it is entirely made of. (It cost no money: the retry identity
    // derives from the on-disk task manifest, which was always written
    // correctly. It cost recovery quality.) The per-scene object now spreads
    // the current params first, so the checkpoint accumulates across scenes,
    // and it is handed back here rather than discarded.
    const carried = (job.params as Record<string, unknown> | undefined)?.genstudio_recovery
    job.params = carried
      ? { ...originalParams, genstudio_recovery: carried }
      : originalParams
  }
  if (clipFailures.length) {
    job.output_lines.push(
      `${clipFailures.length} of ${ready.length} clip(s) failed; the rest were generated. `
      + 'Retry re-submits only what is still missing.',
    )
  }
  const expectedDurations = Object.fromEntries(requiredIds.flatMap(sceneId => {
    const duration = params.scene_durations?.[sceneId]?.duration_seconds ?? params.duration_seconds
    return typeof duration === 'number' ? [[sceneId, duration]] : []
  }))
  const audit = await auditSceneClipCompletion(planPath, requiredIds, clipsDir, expectedDurations,
      { slug: job.project_slug, episodeId: episode_id, episodeDir: paths.episode_dir })
  requireJobCompletion(job, {
    label: 'Motion clip generation', expected: audit.expected, completed: audit.completed,
    missing: audit.missing, invalid: audit.invalid,
    retry_hint: 'Completed clips were kept; Retry generates only missing or stale clips.',
  })
  job.output_lines.push(`Motion Clips complete: ${requiredIds.length}/${requiredIds.length} verified and selected for assembly.`)
}
