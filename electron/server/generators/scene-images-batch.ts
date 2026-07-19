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
import { registry, resolveApiKeyForProvider } from '../providers/registry.js'
import { downloadImage } from '../lib/kie-client.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { resolveSceneImagesDir } from './scene-image.js'
import { getHubBackend } from '../lib/studiohub-client.js'
import { renderImageBatchViaHub } from '../providers/image/imagestudio.js'
import type { ImageGenerationRequest } from '../providers/types.js'
import type { Job, ImageModelConfig, ScenePlan, ScenePlanEntry } from '../models/types.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { auditSceneImageCompletion, checkpointSceneImage } from '../services/scene-media-checkpoint.js'
import {
  acceptHubImageRecovery,
  completeHubImageRecovery,
  finishHubImageRecoveryPoll,
  getReconnectableHubImageRecovery,
  prepareHubImageRecovery,
} from '../services/hub-image-recovery.js'

interface SceneImagesBatchParams {
  episode_id: string
  model: string
  aspect_ratio?: string
  width?: number
  height?: number
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

  const logicalRecoveryId = `scene-images:${job.project_slug}:${episode_id.toUpperCase()}`
  const savedRecovery = getReconnectableHubImageRecovery(job, logicalRecoveryId)
  const repairOnly = params.hub_repair_only === true
  // An accepted batch's item indexes belong to the original target list. Keep
  // that exact list while reconnecting even when some files already reached
  // disk. A terminal batch is reused only by explicit read-only Repair.
  const reconnectIds = savedRecovery && (
    savedRecovery.state === 'prepared' || savedRecovery.state === 'accepted' || repairOnly
  ) ? savedRecovery.target_ids : null
  // Which scenes: accepted checkpoint, explicit id list, or every missing image.
  const idSet = reconnectIds?.length
    ? new Set(reconnectIds)
    : Array.isArray(params.scene_ids) && params.scene_ids.length ? new Set(params.scene_ids) : null
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
  let modelConfig: ImageModelConfig | undefined = config.image_models?.[model]
  if (!modelConfig) {
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
    endpoint: modelConfig.endpoint, poll: modelConfig.poll, type: modelConfig.type,
    api_model: modelConfig.api_model, aspect_field: (modelConfig as any).aspect_field,
  }
  const apiKey = await resolveApiKeyForProvider(job.project_slug, imageProvider.meta, { model, jobId: job.job_id })
  if (!apiKey && providerId !== 'imagestudio') {
    throw new Error(`No API key configured for ${imageProvider.meta.name}. Add one in App Settings → API Keys.`)
  }

  const aspectRatio = params.aspect_ratio || '16:9'
  const renderWidth = typeof params.width === 'number' && params.width > 0 ? params.width : undefined
  const renderHeight = typeof params.height === 'number' && params.height > 0 ? params.height : undefined
  const total = targets.length
  let done = 0, made = 0, failed = 0
  const successfulSceneIds = new Set<string>()
  const failedSceneIds = new Set<string>()

  const buildReq = (scene: ScenePlanEntry): ImageGenerationRequest => ({
    prompt: scene.visual_prompt!,
    apiKey, aspectRatio, modelId: model, providerParams,
    width: renderWidth, height: renderHeight,
    isCancelled: () => jq.isCancelled(job.job_id),
  } as ImageGenerationRequest)

  // Download + write image_path back to the plan. Re-read fresh each time to
  // avoid clobbering a concurrent write (onItemDone is serialised, but the
  // fallback loop + other jobs may touch the same file).
  const saveScene = async (scene: ScenePlanEntry, url: string): Promise<void> => {
    const outPath = path.join(outDir, `${scene.id}.png`)
    await downloadImage(url, outPath)
    await checkpointSceneImage(planPath, scene.id, outPath, scene.visual_prompt)
    successfulSceneIds.add(scene.id)
    failedSceneIds.delete(scene.id)
  }

  job.output_lines.push(`Scene images — ${imageProvider.meta.name} / ${model} · ${total} scene(s)`)

  const hub = await getHubBackend()
  let batched = false
  if (hub.mode === 'hub' && hub.hubUrl && providerId === 'imagestudio') {
    try {
      const requests = targets.map(buildReq)
      const recovery = await prepareHubImageRecovery(job, {
        logicalId: logicalRecoveryId,
        targetIds: targets.map(scene => scene.id),
        hubUrl: hub.hubUrl,
        requestIdentity: requests,
        repairOnly,
      })
      job.output_lines.push(recovery.batch_id
        ? `Studio Hub recovery — reconnecting batch ${recovery.batch_id} for ${total} scene(s).`
        : `Studio Hub batch — submitting ${total} scene(s) as ONE idempotent render; the Hub distributes across the fleet.`)
      await renderImageBatchViaHub(requests, {
        label: `storystudio:${job.project_slug}/${episode_id.toUpperCase()}`,
        isCancelled: () => jq.isCancelled(job.job_id),
        recovery: {
          clientRequestId: recovery.client_request_id,
          batchId: recovery.batch_id,
          repairOnly,
          onAccepted: async (batchId, replayed) => {
            await acceptHubImageRecovery(job, recovery, batchId)
            job.output_lines.push(replayed
              ? `Studio Hub safely replayed the saved request as existing batch ${batchId}.`
              : `Studio Hub accepted batch ${batchId}; recovery checkpoint saved.`)
          },
          onFinished: status => finishHubImageRecoveryPoll(job, recovery, status),
        },
        onItemDone: async (index, result) => {
          const scene = targets[index]
          if (!scene) return
          if (result.error || !result.url) {
            failed++
            failedSceneIds.add(scene.id)
            job.output_lines.push(`Scene ${scene.scene_index} failed: ${result.error || 'no image'}`)
          } else {
            await saveScene(scene, result.url)
            made++
            job.output_lines.push(`Scene ${scene.scene_index}/${plan.scenes.length} (${scene.id}) ✓`)
          }
          done++
          job.progress = Math.round((done / total) * 100)
        },
      })
      batched = true
    } catch (e: any) {
      job.output_lines.push(
        `Studio Hub batch failed: ${e?.message || e}. ` +
        `${successfulSceneIds.size} verified checkpoint(s) were kept; Direct fallback is disabled.`,
      )
      throw e
    }
  }

  if (!batched) {
    for (const scene of targets.filter(item => !successfulSceneIds.has(item.id))) {
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
      try {
        const result = await imageProvider.generateImage(buildReq(scene))
        if (!result.urls.length) throw new Error('provider returned no image')
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
  const recovery = getReconnectableHubImageRecovery(job, logicalRecoveryId)
  if (unresolved.size === 0 && recovery) await completeHubImageRecovery(job, recovery)
  if (repairOnly) {
    job.result = {
      repair_only: true,
      total_expected: targets.length,
      recovered: targets.length - unresolved.size,
      still_missing: unresolved.size,
    }
    job.output_lines.push(
      unresolved.size === 0
        ? `Repair complete — all ${targets.length} Hub image artifact(s) are verified on disk.`
        : `Repair recovered every available Hub artifact; ${unresolved.size} scene(s) still need a deliberate Retry.`,
    )
    return
  }
  requireJobCompletion(job, {
    label: 'Scene image generation', expected: targets.length, completed: targets.length - unresolved.size,
    missing: mediaAudit.missing,
    invalid: [...invalid],
    retry_hint: 'Successful images were saved; Retry renders only the missing scenes.',
  })
  job.output_lines.push(`Done — ${made} rendered; ${targets.length}/${targets.length} target image(s) verified.`)
}
