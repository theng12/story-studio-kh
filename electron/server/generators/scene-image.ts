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
import { resolveApiKeyForProvider } from '../providers/registry.js'
import { downloadImage } from '../lib/kie-client.js'
import { resolveEpisodePathsByCode, resolveSubfolderNames, resolveScenePlanPath } from '../services/utils.js'
import { findSubfolder } from '../lib/folder-resolver.js'
import { mediaEpisodeBaseForCode } from '../services/media-root.js'
import * as pm from '../services/project-manager.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import type { Job, ImageModelConfig, ScenePlan } from '../models/types.js'

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
  /** v1.0.261 — explicit output pixel size (local Image Studio only). When set,
   *  overrides the aspect preset so a single re-roll matches the batch's render
   *  size. Cloud providers ignore these. */
  width?: number
  height?: number
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
  const scene = plan.scenes.find(s => s.id === scene_id)
  if (!scene) throw new Error(`Scene ${scene_id} not in scene_plan.json (was it deleted?)`)
  if (!scene.visual_prompt?.trim()) {
    throw new Error(`Scene ${scene_id} has no visual_prompt — edit on the Scene Plan page first.`)
  }

  // Resolve the configured image model + its provider.
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  let modelConfig: ImageModelConfig | undefined = config.image_models?.[model]
  if (!modelConfig) {
    // v1.0.258 — local Image Studio models (`imagestudio:<repo>`) are dynamic
    // and not in config.image_models; synthesize a minimal config (mirrors
    // images.ts / continuity-render) so per-scene text2img works locally too.
    const { repoForModelId } = await import('../lib/imagestudio-client.js')
    const repo = repoForModelId(model)
    if (repo) {
      modelConfig = {
        label: repo, credits_per_image: 0, prompt_char_cap: 1000,
        endpoint: '', poll: '', type: 'local', api_model: repo,
        provider: 'imagestudio', supports_reference_images: true,
      } as any
    }
  }
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)

  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) throw new Error(`No image provider registered for: ${providerId}`)

  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
    aspect_field: (modelConfig as any).aspect_field,
  }
  const apiKey = await resolveApiKeyForProvider(job.project_slug, imageProvider.meta, {
    model,
    jobId: job.job_id,
  })
  // v1.0.151+ — Image Studio is a local Pinokio modal; the "apiKey"
  // slot carries its Tailscale base URL. Empty value falls back to the
  // discovered tailnet default inside the provider — skip the no-key
  // throw so that path is allowed to run.
  if (!apiKey && providerId !== 'imagestudio') {
    throw new Error(
      `No API key configured for ${imageProvider.meta.name}. Add one in App Settings → API Keys.`,
    )
  }

  job.output_lines.push(`Scene ${scene.scene_index} (${scene_id}) — ${imageProvider.meta.name} / ${model}`)
  job.output_lines.push(`Prompt: ${scene.visual_prompt.slice(0, 200)}${scene.visual_prompt.length > 200 ? '…' : ''}`)
  job.progress = 10

  const aspectRatio = params.aspect_ratio || '16:9'
  const renderWidth = typeof params.width === 'number' && params.width > 0 ? params.width : undefined
  const renderHeight = typeof params.height === 'number' && params.height > 0 ? params.height : undefined
  if (renderWidth && renderHeight) {
    job.output_lines.push(`Render size: ${renderWidth}×${renderHeight} (local models).`)
  }
  const result = await imageProvider.generateImage({
    prompt: scene.visual_prompt,
    apiKey,
    aspectRatio,
    modelId: model,
    providerParams,
    width: renderWidth,
    height: renderHeight,
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
  const outDir = await resolveSceneImagesDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${scene_id}.png`)
  await downloadImage(url, outPath)
  job.progress = 90

  // Update scene_plan.json with the resolved image_path so the Scene
  // Review page picks it up on next refresh. Re-read first to avoid
  // racing other in-flight scene-image jobs on the same plan.
  const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  const target = fresh.scenes.find(s => s.id === scene_id)
  if (target) {
    target.image_path = outPath
    // v1.0.359 — stamp the prompt this image was rendered from so Scene Review
    // can flag it stale if visual_prompt changes later (re-prompt without render).
    target.rendered_prompt = target.visual_prompt
    // Reset approval if it was set against a prior image — user
    // should re-approve after a regen.
    target.approved = false
    await fs.writeFile(planPath, JSON.stringify(fresh, null, 2), 'utf-8')
  }

  job.output_dir = outDir
  job.progress = 100
  job.output_lines.push(`Done → ${path.basename(outPath)}`)
}
