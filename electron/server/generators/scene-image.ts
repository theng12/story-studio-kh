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

import { queueEpisodeAnalysisSoon } from '../services/scene-analysis.js'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { registry } from '../providers/registry.js'
import { stageGenStudioImage } from '../lib/genstudio-artifacts.js'
import { resolveOutputFormat } from '../services/generation-compression.js'
import { resolveEpisodePathsByCode, resolveSubfolderNames, resolveScenePlanPath, type ProjectFactsCache } from '../services/utils.js'
import { findSubfolder } from '../lib/folder-resolver.js'
import { mediaEpisodeBaseForCode } from '../services/media-root.js'
import * as pm from '../services/project-manager.js'
import { trashRootFor } from '../lib/trash-move.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import type { Job, ScenePlan } from '../models/types.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { checkpointSceneImage, liveSceneAutoApprove } from '../services/scene-media-checkpoint.js'
import { autoApproveOn } from '../services/preset-authority.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { resolveConfiguredAspectRatio, resolveConfiguredOutputOption, resolveImageModelConfig } from '../services/image-model-resolver.js'
import {
  resolveSceneReferences,
  sceneReferenceIds,
  sceneTakesCharacterReferences,
} from '../services/scene-reference-characters.js'
import { buildGenStudioImageIdempotencyKey } from '../lib/genstudio-client.js'
import {
  compareAndRecordImageTaskStrict,
  hashInput,
  promoteCurrentImageTaskArtifactStrict,
  readManifestStrict,
  type TaskManifestEntry,
} from '../services/task-manifest.js'
import { getApiKey } from '../services/app-secrets-store.js'
import * as jq from '../services/job-queue.js'

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
export async function resolveSceneImagesDir(
  slug: string,
  code: string,
  episodeDir: string,
  cache?: ProjectFactsCache,
): Promise<string> {
  const names = await resolveSubfolderNames(slug, code, cache)
  const mediaBase = await mediaEpisodeBaseForCode(slug, code, cache).catch(() => null)
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
  /** Server-stamped deliberate re-roll identity; survives queue Retry. */
  generation_action?: { id?: string; kind?: string }
  auto_approve_generated?: boolean
  /** Scene Review "Reference to Image": ids of THIS episode's characters whose
   *  portraits are attached as references. Resolved to files here, by
   *  ownership lookup — the client never sends a path (AGENTS.md §4). */
  reference_character_ids?: string[]
  /** Set on the one automatic remake after a failed free image check. */
  image_check_remake?: boolean
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
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id, { episodeDir: paths.episode_dir, audioDir: paths.audio_dir, scriptDir: paths.script_dir })
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
  if (!apiKey) throw new Error('Add the Gateway API Key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, model, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)

  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${model}" is not routed through the Gateway.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('Image generation through the Gateway is not available right now.')

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

  // Character references, resolved against THIS episode's own character list
  // and the model's LIVE published limits. The scene's OWN list wins; the
  // request-level selection is only the default for scenes that name none.
  // Any problem throws here, before the manifest is touched and before
  // anything is uploaded or charged.
  const referenceIds = sceneReferenceIds(scene, params.reference_character_ids || [])
  if (!referenceIds.length && (modelConfig.min_reference_images ?? 0) > 0) {
    throw new Error(
      `Scene ${scene.scene_index} has no reference characters, but ${modelConfig.label} needs at least ` +
      `${modelConfig.min_reference_images}. Add one to that scene in Scene Plan, or choose a model that renders ` +
      'from text alone. No image was requested.',
    )
  }
  if (referenceIds.length && !sceneTakesCharacterReferences(scene)) {
    throw new Error(
      `Scene ${scene.scene_index} is a ${scene.scene_type} scene, so it cannot use character references. ` +
      'Clear them in Scene Plan and retry. No image was requested.',
    )
  }
  const references = await resolveSceneReferences({
    slug: job.project_slug,
    episodeCode: episode_id,
    characterIds: referenceIds,
    modelName: modelConfig.label,
    supportsReferences: modelConfig.supports_reference_images === true,
    maxReferences: modelConfig.max_reference_images,
    maxDimension: modelConfig.reference_image_max_dimension,
    episodeDir: paths.episode_dir,
    sceneLabel: `Scene ${scene.scene_index}`,
  })
  if (references.paths.length) {
    job.output_lines.push(
      `Character references: ${references.names.join(', ')} ` +
      `(${references.paths.length} of ${modelConfig.max_reference_images} published slot(s)).`,
    )
    for (const fit of references.fitted) {
      job.output_lines.push(
        `Reference fitted: ${fit.name} ${fit.from.width}x${fit.from.height} → ${fit.to.width}x${fit.to.height} ` +
        `to meet ${model}'s published ${modelConfig.reference_image_max_dimension}px reference limit.`,
      )
    }
  }

  const actionId = params.generation_action?.kind === 'fresh' ? params.generation_action.id : ''
  // The SOURCE portraits' digests — a fitted copy is re-derived every run and
  // must not be able to move the identity (that would buy a second render).
  const referenceIdentity = references.digests.join('-')
  const requestIdentity = `${job.project_slug}:${episode_id}:scene:${scene_id}:image${actionId ? `:fresh:${actionId}` : ''}`
    + (referenceIdentity ? `:ref:${referenceIdentity}` : '')
  const submittedAt = new Date().toISOString()
  const inputHash = hashInput(referenceIdentity ? `${scene.visual_prompt}\nref:${referenceIdentity}` : scene.visual_prompt)
  const seed = modelConfig.supports_seed === false ? undefined : params.seed
  // "Smaller files" for scene images (Settings, per-project override); undefined = native PNG.
  const outputFormat = await resolveOutputFormat(job.project_slug, 'scene_images')
  const idempotencyKey = buildGenStudioImageIdempotencyKey({
    prompt: scene.visual_prompt,
    modelId: modelConfig.api_model || model,
    aspectRatio,
    ...(outputOption ? { resolution: outputOption.resolution } : { width: renderWidth, height: renderHeight }),
    seed,
    requestIdentity,
    ...(outputFormat ? { outputFormat } : {}),
  })
  const filename = `${scene_id}.png`
  const previousOwner = (await readManifestStrict(outDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema_version: 1 as const, tasks: {} as Record<string, TaskManifestEntry> }
    }
    throw error
  })).tasks[filename] || null
  const superseded = previousOwner && (previousOwner.task_id || previousOwner.idempotency_key) ? {
    superseded_image_requests: [{
      provider: previousOwner.provider,
      task_id: previousOwner.task_id,
      submitted_at: previousOwner.submitted_at,
      input_hash: previousOwner.input_hash,
      idempotency_key: previousOwner.idempotency_key,
      operation: previousOwner.operation === 'image' ? 'image' as const : undefined,
      last_state: previousOwner.last_state,
      request_scope: previousOwner.request_scope,
    }],
  } : {}
  const preparedOwner: TaskManifestEntry = {
    provider: imageProvider.meta.providerId || imageProvider.meta.id,
    task_id: '',
    submitted_at: submittedAt,
    input_hash: inputHash,
    idempotency_key: idempotencyKey,
    operation: 'image',
    last_state: 'prepared',
    ...superseded,
  }
  await compareAndRecordImageTaskStrict(outDir, filename, previousOwner, preparedOwner)
  let currentOwner = preparedOwner
  const result = await imageProvider.generateImage({
    prompt: scene.visual_prompt,
    apiKey,
    aspectRatio,
    modelId: modelConfig.api_model || model,
    providerParams,
    ...(outputOption
      ? { resolution: outputOption.resolution }
      : { width: renderWidth, height: renderHeight }),
    seed,
    ...(outputFormat ? { outputFormat } : {}),
    ...(references.paths.length ? { referenceImagePaths: references.paths } : {}),
    idempotencyIdentity: requestIdentity,
    idempotencyKey,
    priority: 'background',
    onQueueState: async state => {
      job.item_progress = {
        total: 1,
        completed: 0,
        failed: 0,
        concurrency: 1,
        active: [{
          label: `Scene ${scene.scene_index}`,
          key: `${scene_id}.png`,
          state: state === 'waiting_account_capacity' ? 'waiting_retry' : 'running',
          attempt: 1,
          max_attempts: 1,
          ...(state === 'waiting_account_capacity' ? { reason: 'Waiting for available image capacity' } : {}),
        }],
      }
      await jq.checkpointJobState(job)
    },
    isCancelled: () => jq.isCancelled(job.job_id),
    onJobAccepted: async (taskId, acceptedIdempotencyKey) => {
      const acceptedOwner: TaskManifestEntry = {
        provider: imageProvider.meta.providerId || imageProvider.meta.id,
        task_id: taskId,
        submitted_at: submittedAt,
        input_hash: inputHash,
        idempotency_key: acceptedIdempotencyKey,
        operation: 'image',
        last_state: 'accepted',
        ...superseded,
      }
      await compareAndRecordImageTaskStrict(outDir, filename, currentOwner, acceptedOwner)
      currentOwner = acceptedOwner
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
  if (result.taskId) {
    const succeededOwner: TaskManifestEntry = {
      ...currentOwner,
      task_id: result.taskId,
      last_state: 'succeeded',
    }
    await compareAndRecordImageTaskStrict(outDir, filename, currentOwner, succeededOwner)
    currentOwner = succeededOwner
  }
  const stagingPath = await stageGenStudioImage(url, outPath, { compress: !!outputFormat })
  const promoted = await promoteCurrentImageTaskArtifactStrict(
    outDir,
    filename,
    currentOwner,
    stagingPath,
    outPath,
    async () => {
      await checkpointSceneImage(planPath, scene_id, outPath, scene.visual_prompt, autoApproveOn(params.auto_approve_generated), liveSceneAutoApprove(job.project_slug))
    },
    path.join(trashRootFor(outDir, pm.getProjectDir(job.project_slug) ?? outDir, job.project_slug), 'scene-images'),
  )
  if (!promoted) throw new Error('A newer image request owns this scene; the late result was not applied.')
  const outputStat = await fs.stat(outPath)
  if (!outputStat.isFile() || outputStat.size <= 0) throw new Error(`Downloaded image is empty for scene ${scene_id}`)
  job.progress = 90

  job.output_dir = outDir
  job.progress = 100
  requireJobCompletion(job, {
    label: 'Scene image generation', expected: 1, completed: 1,
    retry_hint: 'The downloaded image is kept; Retry repairs only an incomplete registration.',
  })
  job.output_lines.push(`Done → ${path.basename(outPath)}`)
  // Free image quality check (owner 2026-10-26). Shadow mode is the default for
  // the first 2 weeks: the check runs AFTER this job so it never delays a
  // render, and records its findings for Scene Review. With the remaking switch
  // on, it runs here because a failed check decides whether one remake is due.
  try {
    const {
      runSceneImageQualityCheck, describeSceneImageCheck, sceneImageCheckConfig, enqueueImageCheckRemake,
      queueSceneImageQualityCheck,
    } = await import('../services/scene-image-quality-check.js')
    const cfg = sceneImageCheckConfig(config)
    if (cfg.enabled) {
      const checkInput = {
        sceneId: scene_id,
        imagePath: outPath,
        visualPrompt: scene.visual_prompt,
        planPath,
        config,
        remade: params.image_check_remake === true,
      }
      if (cfg.auto_remake) {
        const checkResult = await runSceneImageQualityCheck(checkInput)
        job.output_lines.push(describeSceneImageCheck(checkResult))
        if (checkResult.state === 'failed' && params.image_check_remake !== true) {
          await enqueueImageCheckRemake({
            projectSlug: job.project_slug, episodeId: episode_id, sceneId: scene_id,
            title: job.title, params,
          })
          job.output_lines.push(`Image check failed — one automatic remake queued for ${scene_id}.`)
        }
      } else {
        queueSceneImageQualityCheck(checkInput)
      }
    }
  } catch {
    // A failed check never blocks the job.
  }
  // OPT-IN stronger vision check (owner 2026-10-27): a vision-capable chat
  // product from the live catalogue, recorded BESIDE the free check. OFF by
  // default, silent in shadow mode, and it never delays a render unless one of
  // its per-axis auto-remake switches is actually acting.
  try {
    const {
      runSceneVisionCheck, describeSceneVisionCheck, sceneImageVisionConfig,
      sceneVisionAutoRemakeActive, sceneVisionAxesToRemake, queueSceneVisionCheck,
    } = await import('../services/scene-image-vision-check.js')
    const { enqueueImageCheckRemake } = await import('../services/scene-image-quality-check.js')
    if (sceneImageVisionConfig(config).enabled) {
      const visionInput = {
        sceneId: scene_id,
        imagePath: outPath,
        visualPrompt: scene.visual_prompt,
        planPath,
        config,
        remade: params.image_check_remake === true,
      }
      if (sceneVisionAutoRemakeActive(config)) {
        const visionResult = await runSceneVisionCheck(visionInput)
        job.output_lines.push(describeSceneVisionCheck(visionResult))
        const axes = sceneVisionAxesToRemake(visionResult, config)
        if (axes.length && params.image_check_remake !== true) {
          // The same one-remake-per-image dedupe the free check uses: whichever
          // check asks first owns the remake, and a second check cannot buy one.
          await enqueueImageCheckRemake({
            projectSlug: job.project_slug, episodeId: episode_id, sceneId: scene_id,
            title: job.title, params,
          })
          job.output_lines.push(`Vision check failed (${axes.join(', ')}) — one automatic remake queued for ${scene_id}.`)
        }
      } else {
        queueSceneVisionCheck(visionInput)
      }
    }
  } catch {
    // A failed check never blocks the job.
  }
  // E2–E4 — an auto-approved picture is analysed in the background (only where the channel has it on).
  if (autoApproveOn(params.auto_approve_generated)) queueEpisodeAnalysisSoon(job.project_slug, episode_id, [scene_id])
}
