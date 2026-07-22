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
import { hashInput, recordTask } from '../services/task-manifest.js'
import { getApiKey } from '../services/app-secrets-store.js'
import {
  generateVideoWithGenStudio,
  listVideoModels as listGenStudioVideoModels,
  type GenStudioVideoModel,
} from '../lib/genstudio-client.js'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'

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

  const result = await generateVideoWithGenStudio(apiKey, {
    prompt: scene.motion_prompt,
    modelId,
    sourceImagePath: resolvedImagePath,
    aspectRatio: aspectRatio === 'portrait' ? '9:16' : '16:9',
    durationSeconds: 5,
    resolution: '720p',
    requestIdentity: `${job.project_slug}:${episode_id}:${scene_id}:motion`,
    isCancelled: () => jq.isCancelled(job.job_id),
  })

  job.progress = 70
  const outDir = await resolveVideoAssetsDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${scene_id}.mp4`)
  const taskId = result.jobId
  if (taskId) {
    await recordTask(outDir, `${scene_id}.mp4`, {
      provider: 'genstudio',
      task_id: taskId,
      submitted_at: new Date().toISOString(),
      input_hash: hashInput(scene.motion_prompt),
      result_url: result.videoUrl,
    })
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
