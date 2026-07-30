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
import { resolveEpisodePathsByCode, resolveSubfolderNames, resolveScenePlanPath } from '../services/utils.js'
import { resolveSceneImageReadPath } from './scene-image.js'
import { findSubfolder } from '../lib/folder-resolver.js'
import { mediaEpisodeBaseForCode } from '../services/media-root.js'
import * as jq from '../services/job-queue.js'
import type { Job, ScenePlan } from '../models/types.js'
import { auditSceneClipCompletion, checkpointSceneClip } from '../services/scene-media-checkpoint.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { createHash } from 'crypto'
import { hashInput, readManifest, recordTask, recordTaskStrict, type TaskManifestEntry } from '../services/task-manifest.js'
import { checkpointGenStudioAsset, type GenStudioRecoveryState } from '../services/genstudio-recovery.js'
import { getApiKey } from '../services/app-secrets-store.js'
import {
  buildGenStudioVideoIdempotencyKey,
  generateVideoWithGenStudio,
  GenStudioTerminalFailureError,
  listVideoModels as listGenStudioVideoModels,
  recoverVideoWithGenStudio,
  resolveGenStudioRetryScope,
  type GenStudioVideoModel,
  type GenStudioVideoRequest,
} from '../lib/genstudio-client.js'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'

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

/**
 * Canonical "11 Video Assets" directory for an episode — the named folder
 * (media-root-aware + "✅ "-prefix-tolerant), mirroring resolveSceneImagesDir.
 * Returns the existing on-disk folder when present, else the canonical path
 * (callers mkdir before writing).
 */
export async function resolveVideoAssetsDir(slug: string, code: string, episodeDir: string): Promise<string> {
  const names = await resolveSubfolderNames(slug, code)
  const mediaBase = await mediaEpisodeBaseForCode(slug, code).catch(() => null)
  const parent = mediaBase || episodeDir
  const found = await findSubfolder(parent, names.video_assets)
  return found || path.join(parent, names.video_assets)
}

interface SceneClipGenerateParams {
  episode_id: string
  /** Stable id of the scene to animate. Must exist in scene_plan.json with a
   *  non-empty image_path (the still to animate) + motion_prompt. */
  scene_id: string
  /** Image-to-video model id — a key in config.video_models whose `modes`
   *  include 'frames'. */
  model: string
  /** Output aspect ('16:9' default → landscape; '9:16' → portrait). */
  aspect_ratio?: string
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
  if (!raw) return null
  const available = catalog.filter(model => model.available && model.modes.includes('image-to-video'))
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

export async function requireSceneClipGenStudioModel(selectedModel: string): Promise<{
  apiKey: string
  modelId: string
}> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    throw new Error('Add the scoped GenStudio API key in Settings → This Mac before generating motion clips.')
  }
  // A catalogue beyond the staleness window throws GenStudioCatalogUnavailableError
  // and is deliberately NOT caught: never submit paid video work against a
  // product Story Studio cannot currently verify is published and priced.
  const catalog = await listGenStudioVideoModels(apiKey)
  const modelId = resolveSceneClipCatalogModel(selectedModel, catalog)
  if (!modelId) {
    throw new Error(
      `Saved video model "${selectedModel}" is not available through GenStudio. `
      + 'Choose an available GenStudio image-to-video model; no fal.ai, Kie.ai, or Studio Hub fallback was attempted.',
    )
  }
  return { apiKey, modelId }
}

export async function generateSceneClipJob(job: Job): Promise<void> {
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

  // Re-check the live catalog at execution time. A queued historical job may
  // outlive a route/catalog refresh, but it must never revive a direct route.
  const { apiKey, modelId } = await requireSceneClipGenStudioModel(model)

  const aspectRatio = (params.aspect_ratio === '9:16' || params.aspect_ratio === 'portrait') ? 'portrait' : 'landscape'

  job.output_lines.push(`Scene ${scene.scene_index} (${scene_id}) — animate via GenStudio KH / ${modelId}`)
  job.output_lines.push(`Motion: ${scene.motion_prompt.slice(0, 200)}${scene.motion_prompt.length > 200 ? '…' : ''}`)
  job.progress = 10

  // Resolve the output folder BEFORE submitting: the request identity has to be
  // persisted beside the expected clip before any paid POST leaves this process.
  const outDir = await resolveVideoAssetsDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })
  const manifestKey = `${scene_id}.mp4`
  const outPath = path.join(outDir, manifestKey)
  const requestAspect = aspectRatio === 'portrait' ? '9:16' : '16:9'
  const durationSeconds = 5 as const
  const resolution = '720p' as const

  const manifest = await readManifest(outDir)
  const savedEntry = manifest.tasks[manifestKey]?.provider === 'genstudio'
    ? manifest.tasks[manifestKey]!
    : null
  const sourceSha256 = createHash('sha256')
    .update(await fs.readFile(resolvedImagePath))
    .digest('hex')
  const baseIdentity = `${job.project_slug}:${episode_id}:${scene_id}:motion`
  // A terminal saved job promotes the scope to a NEW retry identity, derived
  // deterministically from the dead job id — never a clock, never a random.
  const retry = resolveGenStudioRetryScope(savedEntry, 'missing', isTerminalGenStudioClipTaskFailure)
  const requestScope = retry.scope
  const requestIdentity = requestScope === 'missing' ? baseIdentity : `${baseIdentity}:${requestScope}`
  const inputHash = hashInput(JSON.stringify({
    requestIdentity,
    prompt: scene.motion_prompt,
    modelId,
    sourceSha256,
    aspectRatio: requestAspect,
    durationSeconds,
    resolution,
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
      `Previous GenStudio video task ${(retry.previousTaskId || '').slice(0, 12)}… is terminal; `
      + 'submitting one fresh job under a new retry identity.',
    )
  }
  const idempotencyKey = recoveryEntry?.idempotency_key || buildGenStudioVideoIdempotencyKey({
    prompt: scene.motion_prompt.trim(),
    modelId,
    sourceSha256,
    aspectRatio: requestAspect,
    durationSeconds,
    resolution,
    requestIdentity,
  })
  const submittedAt = recoveryEntry?.submitted_at || new Date().toISOString()
  const preparedState = (recoveryEntry?.last_state || 'prepared') as GenStudioRecoveryState

  function clipManifestEntry(overrides: Partial<TaskManifestEntry>): TaskManifestEntry {
    return {
      provider: 'genstudio',
      task_id: '',
      submitted_at: submittedAt,
      input_hash: inputHash,
      idempotency_key: idempotencyKey,
      operation: 'video',
      request_scope: requestScope,
      ...overrides,
    }
  }

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
  job.output_lines.push(`GenStudio request: ${scene_id} -> ${idempotencyKey}`)

  const videoRequest: GenStudioVideoRequest = {
    prompt: scene.motion_prompt,
    modelId,
    sourceImagePath: resolvedImagePath,
    aspectRatio: requestAspect,
    durationSeconds,
    resolution,
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
      job.output_lines.push(`GenStudio task: ${scene_id} -> ${providerJobId}`)
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
      job.output_lines.push(`Connection interrupted; reconnecting accepted GenStudio task ${providerJobId}.`)
    },
  }

  let result: Awaited<ReturnType<typeof generateVideoWithGenStudio>>
  try {
    if (recoveryEntry?.task_id) {
      job.output_lines.push(`Reclaiming accepted GenStudio task ${recoveryEntry.task_id.slice(0, 12)}… for ${manifestKey}.`)
      result = await recoverVideoWithGenStudio(apiKey, recoveryEntry.task_id, videoRequest)
    } else {
      result = await generateVideoWithGenStudio(apiKey, videoRequest)
    }
  } catch (error) {
    // Record a settled provider failure locally. Without this the next Retry
    // has no way to know the saved job can never succeed.
    if (error instanceof GenStudioTerminalFailureError && error.modality === 'video') {
      await recordTask(outDir, manifestKey, clipManifestEntry({
        task_id: error.jobId || recoveryEntry?.task_id || '',
        last_state: 'failed',
      }))
      await checkpointGenStudioAsset(job, manifestKey, {
        operation: 'video',
        idempotency_key: idempotencyKey,
        ...(error.jobId ? { job_id: error.jobId } : {}),
        state: 'failed',
      })
    }
    throw error
  }

  job.progress = 70
  if (result.jobId) {
    await recordTask(outDir, manifestKey, clipManifestEntry({
      task_id: result.jobId,
      result_url: result.videoUrl,
      last_state: 'succeeded',
    }))
  }
  await downloadVideo(result.videoUrl, outPath, (received) => {
    // Coarse 70→95 progress band while the clip downloads.
    if (received > 0 && (job.progress ?? 0) < 95) job.progress = Math.min(95, (job.progress ?? 0) + 1)
  }, result.downloadHeaders)
  const outputStat = await fs.stat(outPath)
  if (!outputStat.isFile() || outputStat.size <= 0) throw new Error(`Downloaded clip is empty for scene ${scene_id}`)
  job.progress = 95

  await checkpointSceneClip(
    planPath,
    scene_id,
    outPath,
    scene.motion_prompt,
    scene.image_version,
    params.auto_approve_clip === true,
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
  const params = job.params as SceneClipGenerateParams
  const { episode_id, model } = params
  if (!episode_id || !model) throw new Error('episode_id and model are required')
  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('No scene_plan.json yet — run Scene Plan first.')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  const clipsDir = await resolveVideoAssetsDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  const ready = [] as ScenePlan['scenes']
  const requiredIds: string[] = []
  const blockers: string[] = []
  for (const scene of plan.scenes) {
    if (scene.motion_choice === 'still') continue
    requiredIds.push(scene.id)
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
      && scene.rendered_motion_prompt === scene.motion_prompt
      && (scene.image_version == null || scene.clip_source_image_version === scene.image_version)
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
    job.progress = 100
    requireJobCompletion(job, {
      label: 'Motion clip generation', expected: requiredIds.length, completed: requiredIds.length,
    })
    job.output_lines.push('All required scenes already have fresh, selected image-to-video clips.')
    return
  }

  const originalParams = job.params
  job.output_lines.push(`Motion Clips: ${ready.length} scene(s), processed in order to avoid provider bursts.`)
  try {
    for (let index = 0; index < ready.length; index++) {
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
      const scene = ready[index]!
      job.params = {
        episode_id,
        scene_id: scene.id,
        model,
        aspect_ratio: params.aspect_ratio || '16:9',
        auto_approve_clip: true,
      }
      await generateSceneClipJob(job)
      job.progress = Math.round(((index + 1) / ready.length) * 100)
    }
  } finally {
    job.params = originalParams
  }
  const audit = await auditSceneClipCompletion(planPath, requiredIds, clipsDir)
  requireJobCompletion(job, {
    label: 'Motion clip generation', expected: audit.expected, completed: audit.completed,
    missing: audit.missing, invalid: audit.invalid,
    retry_hint: 'Completed clips were kept; Retry generates only missing or stale clips.',
  })
  job.output_lines.push(`Motion Clips complete: ${requiredIds.length}/${requiredIds.length} verified and selected for assembly.`)
}
