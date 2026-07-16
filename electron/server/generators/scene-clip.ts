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
import { registry, resolveApiKeyForProvider } from '../providers/registry.js'
import { downloadVideo } from '../lib/download-video.js'
import { resolveEpisodePathsByCode, resolveSubfolderNames, resolveScenePlanPath } from '../services/utils.js'
import { resolveSceneImageReadPath } from './scene-image.js'
import { findSubfolder } from '../lib/folder-resolver.js'
import { mediaEpisodeBaseForCode } from '../services/media-root.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import type { Job, VideoModelConfig, ScenePlan } from '../models/types.js'
import { resolveVideoStudioModel } from '../lib/videostudio-client.js'
import { checkpointSceneClip } from '../services/scene-media-checkpoint.js'
import { requireJobCompletion } from '../services/job-completion.js'

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

  // Resolve the i2v model + provider.
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  const videoModels: Record<string, VideoModelConfig> = (config as any).video_models || {}
  const modelConfig = videoModels[model] || await resolveVideoStudioModel(model)
  if (!modelConfig) throw new Error(`Unknown video model: ${model}. Add one in Settings → Models.`)
  if (!modelConfig.modes?.includes('frames')) {
    throw new Error(`"${modelConfig.label || model}" is not an image-to-video model (no 'frames' mode). Pick an i2v model.`)
  }

  const providerId = modelConfig.provider || 'kie-video'
  const provider = registry.getVideoProvider(providerId)
  if (!provider) throw new Error(`No video provider registered for: ${providerId}`)

  const apiKey = provider.meta.requiresApiKey === false
    ? 'studio-managed'
    : await resolveApiKeyForProvider(job.project_slug, provider.meta, {
        model,
        jobId: job.job_id,
      })
  if (!apiKey) throw new Error(`No API key configured for ${provider.meta.name}. Add one in Settings → API Keys.`)

  const aspectRatio = (params.aspect_ratio === '9:16' || params.aspect_ratio === 'portrait') ? 'portrait' : 'landscape'

  job.output_lines.push(`Scene ${scene.scene_index} (${scene_id}) — animate via ${provider.meta.name} / ${model}`)
  job.output_lines.push(`Motion: ${scene.motion_prompt.slice(0, 200)}${scene.motion_prompt.length > 200 ? '…' : ''}`)
  job.progress = 10

  const result = await provider.generateVideo({
    mode: 'frames',
    prompt: scene.motion_prompt,
    apiKey,
    aspectRatio,
    numberOfVideos: 1,
    modelId: model,
    startImagePath: resolvedImagePath,
    // Pass the model's provider_params so fal gets its `slug` + default_duration
    // (kie reads its routing too). ai-video omits this — a latent fal bug we avoid.
    providerParams: (modelConfig as any).provider_params || {},
    isCancelled: () => jq.isCancelled(job.job_id),
  })

  job.progress = 70
  if (!result.videoUrls.length) {
    throw new Error(`${provider.meta.name} returned no video for scene ${scene_id}`)
  }

  const outDir = await resolveVideoAssetsDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${scene_id}.mp4`)
  await downloadVideo(result.videoUrls[0]!, outPath, (received) => {
    // Coarse 70→95 progress band while the clip downloads.
    if (received > 0 && (job.progress ?? 0) < 95) job.progress = Math.min(95, (job.progress ?? 0) + 1)
  })
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
  for (const scene of plan.scenes) {
    const image = scene.image_path && existsSync(scene.image_path)
      ? scene.image_path
      : await resolveSceneImageReadPath(job.project_slug, episode_id.toUpperCase(), paths.episode_dir, scene.id)
    if (!image || !scene.motion_prompt?.trim()) continue
    const clipPath = path.join(clipsDir, `${scene.id}.mp4`)
    const freshClip = existsSync(clipPath)
      && scene.rendered_motion_prompt === scene.motion_prompt
      && (scene.image_version == null || scene.clip_source_image_version === scene.image_version)
    if (!freshClip) ready.push(scene)
  }
  if (!ready.length) {
    job.output_lines.push('All ready scenes already have fresh image-to-video clips.')
    job.progress = 100
    return
  }

  const originalParams = job.params
  job.output_lines.push(`Motion Clips: ${ready.length} scene(s), processed in order to avoid provider bursts.`)
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
  job.params = originalParams
  job.output_lines.push(`Motion Clips complete: ${ready.length} generated and selected for assembly.`)
}
