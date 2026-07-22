/**
 * Scene-plan images — BATCH (v1.0.535).
 *
 * The bulk "Generate all missing" action enqueues N `scene_image_generate` jobs,
 * which run ONE AT A TIME (each type is a singleton in the queue) — i.e. serial,
 * one Hub job at a time, using a single studio. In Studio Hub mode this job
 * instead generates every requested/missing scene image in ONE Hub batch, so the
 * Hub work-steals them across the WHOLE fleet. Text2img only (the timestamp
 * scene-image path carries no references). Results stream in and are written back
 * to scene_plan.json as each scene finishes. On a Hub connection error, falls
 * back to per-scene generation via the same provider.
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync, statSync } from 'fs'
import { registry } from '../providers/registry.js'
import { downloadImage } from '../lib/kie-client.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { resolveSceneImagesDir } from './scene-image.js'
import type { ImageGenerationRequest } from '../providers/types.js'
import type { Job, ScenePlan, ScenePlanEntry } from '../models/types.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { auditSceneImageCompletion, checkpointSceneImage } from '../services/scene-media-checkpoint.js'
import { resolveImageModelConfig } from '../services/image-model-resolver.js'
import { hashInput, recordTask } from '../services/task-manifest.js'
import { getApiKey } from '../services/app-secrets-store.js'

interface SceneImagesBatchParams {
  episode_id: string
  model: string
  aspect_ratio?: string
  width?: number
  height?: number
  image_steps?: number
  seed?: number
  auto_approve_generated?: boolean
  /** Specific scenes to render; when omitted, every scene missing an image. */
  scene_ids?: string[]
  /** Internal Jobs-page recovery mode: reconnect/download only, never submit. */
  hub_repair_only?: boolean
}

export async function generateSceneImagesBatchJob(job: Job): Promise<void> {
  const params = job.params as SceneImagesBatchParams
  const { episode_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error(`No scene_plan.json at ${planPath}. Run Scene Plan first.`)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id)
  assertScenePromptsRenderable(plan.scenes, params.scene_ids)

  const outDir = await resolveSceneImagesDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })

  const repairOnly = params.hub_repair_only === true
  if (repairOnly) {
    throw new Error(
      'Legacy Studio Hub batch repair is retired. No Hub request was made. ' +
      'Use the image Repair action for a saved GenStudio job, or Retry to submit deliberate new GenStudio work.',
    )
  }
  const idSet = Array.isArray(params.scene_ids) && params.scene_ids.length ? new Set(params.scene_ids) : null
  const targets = plan.scenes.filter((s) => {
    if (idSet) return idSet.has(s.id)
    try {
      const stat = statSync(path.join(outDir, `${s.id}.png`))
      return !stat.isFile() || stat.size <= 0
    } catch { return true }
  })
  if (!targets.length) {
    job.output_lines.push('No scenes to render (all have images or no prompt).')
    job.progress = 100
    return
  }

  // Resolve the configured image model + provider (mirrors scene-image.ts).
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  const modelConfig = resolveImageModelConfig(config, model)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)

  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${model}" is not routed through GenStudio KH.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('GenStudio KH image provider is unavailable.')
  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint, poll: modelConfig.poll, type: modelConfig.type,
    api_model: modelConfig.api_model, aspect_field: (modelConfig as any).aspect_field,
  }
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add the GenStudio API key in Settings before generating images.')

  const aspectRatio = params.aspect_ratio || '16:9'
  const renderWidth = typeof params.width === 'number' && params.width > 0 ? params.width : undefined
  const renderHeight = typeof params.height === 'number' && params.height > 0 ? params.height : undefined
  const total = targets.length
  let done = 0, made = 0, failed = 0
  const successfulSceneIds = new Set<string>()
  const failedSceneIds = new Set<string>()

  const buildReq = (scene: ScenePlanEntry): ImageGenerationRequest => ({
    prompt: scene.visual_prompt!,
    apiKey, aspectRatio, modelId: modelConfig.api_model || model, providerParams,
    width: renderWidth, height: renderHeight,
    steps: params.image_steps,
    seed: params.seed,
    idempotencyIdentity: `${job.job_id}:${scene.id}`,
    onJobAccepted: async (taskId) => {
      await recordTask(outDir, `${scene.id}.png`, {
        provider: imageProvider.meta.providerId || imageProvider.meta.id,
        task_id: taskId,
        submitted_at: new Date().toISOString(),
        input_hash: hashInput(scene.visual_prompt!),
      })
    },
    isCancelled: () => jq.isCancelled(job.job_id),
  } as ImageGenerationRequest)

  // Download + write image_path back to the plan. Re-read fresh each time to
  // avoid clobbering a concurrent write (onItemDone is serialised, but the
  // fallback loop + other jobs may touch the same file).
  const saveScene = async (scene: ScenePlanEntry, url: string): Promise<void> => {
    const outPath = path.join(outDir, `${scene.id}.png`)
    await downloadImage(url, outPath)
    await checkpointSceneImage(planPath, scene.id, outPath, scene.visual_prompt, params.auto_approve_generated === true)
    successfulSceneIds.add(scene.id)
    failedSceneIds.delete(scene.id)
  }

  job.output_lines.push(`Scene images — ${imageProvider.meta.name} / ${model} · ${total} scene(s)`)

  for (const scene of targets.filter(item => !successfulSceneIds.has(item.id))) {
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    try {
      const result = await imageProvider.generateImage(buildReq(scene))
      if (!result.urls.length) throw new Error('GenStudio KH returned no image')
      await saveScene(scene, result.urls[0]!)
      made++
      job.output_lines.push(`Scene ${scene.scene_index}/${plan.scenes.length} (${scene.id}) ✓`)
    } catch (e: any) {
      failed++
      failedSceneIds.add(scene.id)
      job.output_lines.push(`Scene ${scene.scene_index} failed: ${e?.message || e}`)
    } finally {
      done++
      job.progress = Math.round((done / total) * 100)
    }
  }

  job.output_dir = outDir
  job.progress = 100
  const mediaAudit = await auditSceneImageCompletion(planPath, targets.map(scene => scene.id), [outDir])
  const invalid = new Set<string>(mediaAudit.invalid)
  for (const scene of targets) if (!successfulSceneIds.has(scene.id)) invalid.add(scene.id)
  for (const sceneId of failedSceneIds) invalid.add(sceneId)
  const unresolved = new Set(mediaAudit.missing)
  for (const item of invalid) unresolved.add(item.replace(/ \(.+\)$/, ''))
  if (unresolved.size > 0) {
    job.params.scene_ids = targets.filter(scene => unresolved.has(scene.id)).map(scene => scene.id)
  }
  requireJobCompletion(job, {
    label: 'Scene image generation', expected: targets.length, completed: targets.length - unresolved.size,
    missing: mediaAudit.missing,
    invalid: [...invalid],
    retry_hint: 'Successful images were saved; Retry renders only the missing scenes.',
  })
  job.output_lines.push(`Done — ${made} rendered; ${targets.length}/${targets.length} target image(s) verified.`)
}
