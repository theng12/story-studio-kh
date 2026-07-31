/**
 * Per-scene image generator for the timestamp-driven pipeline (v1.0.144+).
 *
 * Unlike the legacy `generateImages` job (which reads a docx of
 * prompts and produces N variants per scene), this generator handles
 * ONE scene at a time:
 *   - Input: scene id + visual_prompt (from the saved scene_plan.json)
 *   - Output: single PNG at <episode_dir>/scene_images/<scene_id>.png
 *   - Side effect: updates the matching scene_plan.json entry's
 *     `image_path` so the Scene Review page can find it immediately
 *
 * Why per-scene + per-job:
 *   - The user reviews scenes one at a time and re-rolls individual
 *     ones; each re-roll is a fresh provider call we want isolated
 *     in the queue + log panel.
 *   - The "Generate all missing" bulk action just enqueues N of these,
 *     each with its own scene_id; queue handles concurrency + retry.
 *   - Image filename = scene id (stable across split/merge), so the
 *     Scene Review page can re-look-up the image by id without
 *     tracking positional shifts.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { registry } from '../providers/registry.js'
import { saveGenStudioImage } from '../lib/genstudio-artifacts.js'
import { resolveEpisodePathsByCode, resolveSubfolderNames, resolveScenePlanPath } from '../services/utils.js'
import { findSubfolder } from '../lib/folder-resolver.js'
import { mediaEpisodeBaseForCode } from '../services/media-root.js'
import * as pm from '../services/project-manager.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import type { Job, ScenePlan } from '../models/types.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { checkpointSceneImage } from '../services/scene-media-checkpoint.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { resolveConfiguredAspectRatio, resolveConfiguredOutputOption, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { recordTask, hashInput } from '../services/task-manifest.js'
import { getApiKey } from '../services/app-secrets-store.js'

/** Legacy flat folder at the episode root where continuity / scene-review
 *  renders USED to live. v1.0.457 unified them into the named "NN Scene Images"
 *  folder (see resolveSceneImagesDir); this constant is now only used as a READ
 *  fallback for episodes not yet consolidated. */
export const SCENE_IMAGES_SUBFOLDER = 'scene_images'

/**
 * v1.0.457 — canonical scene-image directory: the named "{code} - NN Scene
 * Images" folder (same one the Scene Generator uses), media-root-aware and
 * "✅ "-prefix tolerant. Continuity / scene-review renders now WRITE here too,
 * so there's a single scene-image location per episode and it migrates to the
 * external media root with everything else. Returns the existing on-disk folder
 * when present, else the canonical path (callers mkdir before writing).
 */
export async function resolveSceneImagesDir(slug: string, code: string, episodeDir: string): Promise<string> {
  const names = await resolveSubfolderNames(slug, code)
  const mediaBase = await mediaEpisodeBaseForCode(slug, code).catch(() => null)
  const parent = mediaBase || episodeDir
  const found = await findSubfolder(parent, names.images)
  return found || path.join(parent, names.images)
}

/**
 * v1.0.457 — resolve a single scene's image path for READING. Prefers the
 * unified named folder, falls back to the legacy flat scene_images/ folder, then
 * to the stored absolute image_path (which may be stale across Macs). Returns
 * the first that exists on disk, or null when none do.
 */
export async function resolveSceneImageReadPath(
  slug: string,
  code: string,
  episodeDir: string,
  sceneId: string,
  storedImagePath?: string | null,
): Promise<string | null> {
  const namedDir = await resolveSceneImagesDir(slug, code, episodeDir)
  const named = path.join(namedDir, `${sceneId}.png`)
  if (existsSync(named)) return named
  const flat = path.join(episodeDir, SCENE_IMAGES_SUBFOLDER, `${sceneId}.png`)
  if (existsSync(flat)) return flat
  if (storedImagePath && existsSync(storedImagePath)) return storedImagePath
  return null
}

interface SceneImageGenerateParams {
  episode_id: string
  title?: string
  /** Stable id of the scene to (re)generate. Must exist in
   *  scene_plan.json — we look up the visual_prompt + write the
   *  image_path back to the same entry. */
  scene_id: string
  /** Which image model to call. Same shape as the legacy images
   *  job's `model` param — must be a key in config.image_models. */
  model: string
  /** Aspect ratio for the image generation. Defaults to 16:9 for the
   *  timestamp-driven pipeline (videos are always landscape). */
  aspect_ratio?: string
  /** Resolution label of the chosen published `output_options[]` row. */
  resolution?: string
  /** v1.0.261 — explicit output pixel size (local Image Studio only). When set,
   *  overrides the aspect preset so a single re-roll matches the batch's render
   *  size. Cloud providers ignore these. */
  width?: number
  height?: number
  seed?: number
  auto_approve_generated?: boolean
}

export async function generateSceneImageJob(job: Job): Promise<void> {
  const params = job.params as SceneImageGenerateParams
  const { episode_id, scene_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!scene_id) throw new Error('scene_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) {
    throw new Error(`No scene_plan.json at ${planPath}. Run Scene Plan first.`)
  }

  // Load + locate the scene by id.
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id)
  assertScenePromptsRenderable(plan.scenes, [scene_id])
  const scene = plan.scenes.find(s => s.id === scene_id)
  if (!scene) throw new Error(`Scene ${scene_id} not in scene_plan.json (was it deleted?)`)
  if (!scene.visual_prompt?.trim()) {
    throw new Error(`Scene ${scene_id} has no visual_prompt — edit on the Scene Plan page first.`)
  }

  // Resolve the configured image model + its provider.
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  // The key is resolved first: model capabilities come from the live
  // GenStudio catalogue, not from a synthesised constant.
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add the GenStudio API key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, model, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)

  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${model}" is not routed through GenStudio KH.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('GenStudio KH image provider is unavailable.')

  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
    aspect_field: (modelConfig as any).aspect_field,
  }

  job.output_lines.push(`Scene ${scene.scene_index} (${scene_id}) — ${imageProvider.meta.name} / ${model}`)
  job.output_lines.push(`Prompt: ${scene.visual_prompt.slice(0, 200)}${scene.visual_prompt.length > 200 ? '…' : ''}`)
  job.progress = 10

  const aspectRatio = resolveConfiguredAspectRatio(modelConfig, params.aspect_ratio)
  // The published `(resolution, aspect_ratio)` row, validated before the
  // charged submit. `undefined` = this model publishes no output options and
  // the render proceeds on aspect ratio alone, exactly as it did before.
  const outputOption = resolveConfiguredOutputOption(modelConfig, aspectRatio, params.resolution)
  const renderWidth = typeof params.width === 'number' && params.width > 0 ? params.width : undefined
  const renderHeight = typeof params.height === 'number' && params.height > 0 ? params.height : undefined
  if (outputOption) {
    job.output_lines.push(
      `Output: ${outputOption.resolution} ${outputOption.aspect_ratio} — ${outputOption.width}×${outputOption.height}px.`,
    )
  } else if (renderWidth && renderHeight) {
    job.output_lines.push(`Render size: ${renderWidth}×${renderHeight} (local models).`)
  }
  const outDir = await resolveSceneImagesDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${scene_id}.png`)
  const result = await imageProvider.generateImage({
    prompt: scene.visual_prompt,
    apiKey,
    aspectRatio,
    modelId: modelConfig.api_model || model,
    providerParams,
    ...(outputOption
      ? { resolution: outputOption.resolution }
      : { width: renderWidth, height: renderHeight }),
    seed: params.seed,
    idempotencyIdentity: `${job.project_slug}:${episode_id}:scene:${scene_id}:image`,
    isCancelled: () => false,
    onJobAccepted: async (taskId) => {
      await recordTask(outDir, `${scene_id}.png`, {
        provider: imageProvider.meta.providerId || imageProvider.meta.id,
        task_id: taskId,
        submitted_at: new Date().toISOString(),
        input_hash: hashInput(scene.visual_prompt),
      })
    },
  })

  job.progress = 70
  if (!result.urls.length) {
    throw new Error(`${imageProvider.meta.name} returned no URLs for scene ${scene_id}`)
  }

  // Use the first URL only — one image per scene (no variant
  // proliferation; the user re-rolls if unhappy).
  const url = result.urls[0]!
  // v1.0.457 — write into the unified named "NN Scene Images" folder (not the
  // legacy flat scene_images/), so there's one scene-image location per episode
  // and it migrates to the external media root with everything else.
    await saveGenStudioImage(url, outPath)
  const outputStat = await fs.stat(outPath)
  if (!outputStat.isFile() || outputStat.size <= 0) throw new Error(`Downloaded image is empty for scene ${scene_id}`)
  job.progress = 90

  await checkpointSceneImage(planPath, scene_id, outPath, scene.visual_prompt, params.auto_approve_generated === true)

  job.output_dir = outDir
  job.progress = 100
  requireJobCompletion(job, {
    label: 'Scene image generation', expected: 1, completed: 1,
    retry_hint: 'The downloaded image is kept; Retry repairs only an incomplete registration.',
  })
  job.output_lines.push(`Done → ${path.basename(outPath)}`)
}
