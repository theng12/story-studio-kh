/**
 * Image Pool generator (v1.0.410) — grow an Image Pool by generating new
 * stills from prompts and dropping them into the pool folder.
 *
 * Reuses the project's configured image model + key resolution (same path as
 * the per-scene generator) so any provider works — kie.ai, OpenAI Images,
 * OpenRouter, or a local Image Studio modal. Each generated PNG lands in the
 * pool's folder with a `gen-…` name, then the folder is re-scanned (image
 * mode) so the new images are indexed + thumbnailed and immediately available
 * to the slideshow selector. The pool stays the single source of truth — no
 * separate "generated" bucket.
 *
 * Runs in a PROJECT context (job.project_slug) so config.image_models + API
 * keys resolve; the target pool is app-level (by id).
 */

import fs from 'fs/promises'
import path from 'path'
import { registry, resolveApiKeyForProvider } from '../providers/registry.js'
import { downloadImage } from '../lib/kie-client.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as bp from '../services/broll-pool-manager.js'
import { scanPoolFolder } from '../lib/broll-indexer.js'
import { getHubBackend } from '../lib/studiohub-client.js'
import { renderImageBatchViaHub } from '../providers/image/imagestudio.js'
import type { ImageGenerationRequest } from '../providers/types.js'
import type { Job, ImageModelConfig } from '../models/types.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { hashInput, readManifest, recordTask } from '../services/task-manifest.js'
import { tryRecoverImageFromManifest } from '../lib/manifest-recovery.js'
import {
  acceptHubImageRecovery,
  completeHubImageRecovery,
  finishHubImageRecoveryPoll,
  getReconnectableHubImageRecovery,
  prepareHubImageRecovery,
  type HubImageRecoveryCheckpoint,
} from '../services/hub-image-recovery.js'
import { resolveImageModelConfig } from '../services/image-model-resolver.js'

interface ImagePoolGenerateParams {
  pool_id: string
  prompts: string[]
  model: string
  aspect_ratio?: string
  image_steps?: number
  seed?: number
  /** Images to generate per prompt (1–4). Default 1. */
  variants?: number
  /** Durable identity retained by manual/local retries. */
  run_id?: string
  /** Internal Jobs-page recovery mode: reconnect/download only, never submit. */
  hub_repair_only?: boolean
}

export async function generateImagePoolImages(job: Job): Promise<void> {
  const params = job.params as ImagePoolGenerateParams
  const poolId = params.pool_id
  const prompts = (params.prompts || []).map(p => String(p || '').trim()).filter(Boolean)
  const model = params.model
  if (!poolId) throw new Error('pool_id is required')
  if (!prompts.length) throw new Error('At least one prompt is required')
  if (!model) throw new Error('model is required')
  const variants = Math.max(1, Math.min(4, Math.floor(Number(params.variants) || 1)))
  const aspectRatio = params.aspect_ratio || '16:9'

  const pool = await bp.getPool(poolId)
  if (!pool) throw new Error(`Pool '${poolId}' not found`)
  if (bp.poolMedia(pool) !== 'image') throw new Error(`Pool '${poolId}' is not an image pool`)

  const { existsSync } = await import('fs')
  if (!existsSync(pool.folder_path)) {
    throw new Error(`Pool folder offline — connect ${pool.folder_path} before generating into it.`)
  }

  // Resolve the project's image model + provider (mirrors generators/scene-image.ts,
  // including the synthesized config for dynamic local Image Studio models).
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  const modelConfig = resolveImageModelConfig(config, model)
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
  const apiKey = await resolveApiKeyForProvider(job.project_slug, imageProvider.meta, { model, jobId: job.job_id })
  if (!apiKey && providerId !== 'imagestudio') {
    throw new Error(`No API key configured for ${imageProvider.meta.name}. Add one in Settings → API Keys.`)
  }

  const total = prompts.length * variants
  job.output_lines.push(
    `Generating ${total} image(s) into "${pool.name}" — ${imageProvider.meta.name} / ${model} · ${prompts.length} prompt(s) × ${variants}`,
  )

  const runId = typeof params.run_id === 'string' && params.run_id.trim()
    ? params.run_id.trim()
    : `${Date.now()}-${job.job_id}`
  job.params.run_id = runId
  const items = prompts.flatMap((prompt, promptIndex) =>
    Array.from({ length: variants }, (_, variantIndex) => {
      const index = promptIndex * variants + variantIndex
      return {
        index,
        prompt,
        filename: `gen-${runId}-${String(index + 1).padStart(4, '0')}.png`,
      }
    }),
  )
  const isUsable = async (filename: string): Promise<boolean> => {
    const stat = await fs.stat(path.join(pool.folder_path, filename)).catch(() => null)
    return !!stat?.isFile() && stat.size > 0
  }
  const initialReady = new Set<string>()
  for (const item of items) if (await isUsable(item.filename)) initialReady.add(item.filename)
  let remaining = items.filter(item => !initialReady.has(item.filename))
  const logicalRecoveryId = `image-pool:${poolId}:${runId}`
  const repairOnly = params.hub_repair_only === true
  const savedRecovery = getReconnectableHubImageRecovery(job, logicalRecoveryId)
  if (savedRecovery && (savedRecovery.state === 'prepared' || savedRecovery.state === 'accepted' || repairOnly)) {
    const savedIds = new Set(savedRecovery.target_ids)
    remaining = items.filter(item => savedIds.has(item.filename))
  }
  let made = 0
  let failed = 0
  let processed = items.length - remaining.length
  const successfulFiles = new Set(initialReady)
  const failedFiles = new Set<string>()

  const saveResult = async (item: typeof items[number], result: { url?: string; taskId?: string }): Promise<void> => {
    if (!result.url) throw new Error('provider returned no image')
    if (result.taskId) {
      await recordTask(pool.folder_path, item.filename, {
        provider: imageProvider.meta.providerId || imageProvider.meta.id,
        task_id: result.taskId,
        submitted_at: new Date().toISOString(),
        input_hash: hashInput(item.prompt),
      })
    }
    await downloadImage(result.url, path.join(pool.folder_path, item.filename))
    if (!await isUsable(item.filename)) throw new Error('downloaded image is empty')
    successfulFiles.add(item.filename)
    failedFiles.delete(item.filename)
  }

  // Studio Hub batch (§6b): in Hub mode, submit ALL images as ONE batch so the
  // Hub distributes them across the whole fleet — this loop is otherwise SERIAL
  // (one image at a time), which barely uses the fleet. Pool stills are txt2img
  // (no references). Hub mode is strict; failure preserves verified files and
  // stops instead of switching transports.
  let batchDone = false
  let batchRecovery: HubImageRecoveryCheckpoint | null = null
  const hub = await getHubBackend()
  if (repairOnly && (hub.mode !== 'hub' || !hub.hubUrl || providerId !== 'imagestudio')) {
    throw new Error('Studio Hub image Repair is read-only and requires the saved Hub backend to be active.')
  }
  if (hub.mode === 'hub' && hub.hubUrl && providerId === 'imagestudio' && remaining.length > 0) {
    try {
      const batchItems = [...remaining]
      const reqs: ImageGenerationRequest[] = batchItems.map(item => ({
        prompt: item.prompt, apiKey, aspectRatio, modelId: model, providerParams,
      } as ImageGenerationRequest))
      batchRecovery = await prepareHubImageRecovery(job, {
        logicalId: logicalRecoveryId,
        targetIds: batchItems.map(item => item.filename),
        hubUrl: hub.hubUrl,
        requestIdentity: reqs,
        repairOnly,
      })
      job.output_lines.push(batchRecovery.batch_id
        ? `Studio Hub recovery — reconnecting batch ${batchRecovery.batch_id} for ${reqs.length} image(s).`
        : `Studio Hub batch — ${reqs.length} image(s) as ONE idempotent render; the Hub distributes across the fleet.`)
      await renderImageBatchViaHub(reqs, {
        label: `storystudio:pool/${pool.name}`,
        isCancelled: () => jq.isCancelled(job.job_id),
        recovery: {
          clientRequestId: batchRecovery.client_request_id,
          batchId: batchRecovery.batch_id,
          repairOnly,
          onAccepted: async (batchId, replayed) => {
            await acceptHubImageRecovery(job, batchRecovery!, batchId)
            job.output_lines.push(replayed
              ? `Studio Hub safely replayed the saved request as existing batch ${batchId}.`
              : `Studio Hub accepted batch ${batchId}; recovery checkpoint saved.`)
          },
          onFinished: status => finishHubImageRecoveryPoll(job, batchRecovery!, status),
        },
        onItemDone: async (index, result) => {
          const item = batchItems[index]
          if (!item) return
          if (result.error || !result.url) {
            failed++
            failedFiles.add(item.filename)
            job.output_lines.push(`✗ image ${index + 1} failed: ${result.error || 'no image'}`)
          } else {
            try {
              await saveResult(item, result)
              made++
              job.output_lines.push(`✓ ${successfulFiles.size}/${total}`)
            } catch (e: any) {
              failed++
              failedFiles.add(item.filename)
              job.output_lines.push(`✗ image ${index + 1} could not be checkpointed: ${e?.message || e}`)
            }
          }
          processed++
          job.progress = Math.round((processed / total) * 90)
        },
      })
      batchDone = true
    } catch (e: any) {
      job.output_lines.push(
        `Studio Hub batch failed: ${e?.message || e}. ` +
        `${successfulFiles.size} verified checkpoint(s) were kept; Direct fallback is disabled.`,
      )
      throw e
    }
  }

  if (!batchDone) for (const item of remaining) {
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    try {
      const manifest = await readManifest(pool.folder_path)
      const recovered = await tryRecoverImageFromManifest(
        manifest.tasks[item.filename] || null,
        apiKey,
        modelConfig,
        () => jq.isCancelled(job.job_id),
      )
      if (recovered?.urls[0]) {
        await saveResult(item, { url: recovered.urls[0], taskId: recovered.taskId })
        made++
        job.output_lines.push(`✓ ${successfulFiles.size}/${total} — recovered accepted task ${recovered.taskId.slice(0, 12)}…`)
        processed++
        job.progress = Math.round((processed / total) * 90)
        continue
      }
      const result = await imageProvider.generateImage({
          prompt: item.prompt,
          apiKey,
          aspectRatio,
          modelId: model,
        providerParams,
        steps: params.image_steps,
        seed: params.seed,
        idempotencyIdentity: `${logicalRecoveryId}:${item.filename}`,
          isCancelled: () => jq.isCancelled(job.job_id),
          onJobAccepted: async (taskId) => {
            await recordTask(pool.folder_path, item.filename, {
              provider: imageProvider.meta.providerId || imageProvider.meta.id,
              task_id: taskId,
              submitted_at: new Date().toISOString(),
              input_hash: hashInput(item.prompt),
            })
          },
        })
        if (!result.urls.length) throw new Error('provider returned no image')
        await saveResult(item, { url: result.urls[0], taskId: result.taskId })
        made++
        job.output_lines.push(`✓ ${successfulFiles.size}/${total} — "${item.prompt.slice(0, 60)}${item.prompt.length > 60 ? '…' : ''}"`)
      } catch (e: any) {
        failed++
        failedFiles.add(item.filename)
        job.output_lines.push(`✗ item ${item.index + 1} failed: ${e?.message || e}`)
      }
      processed++
      job.progress = Math.round((processed / total) * 90)
  }

  // Index the new files (image mode) so they're thumbnailed + selectable.
  job.output_lines.push('Indexing new images into the pool…')
  const scan = await scanPoolFolder(pool.folder_path, undefined, 'image')
  job.progress = 100
  const missing: string[] = []
  for (const item of items) if (!await isUsable(item.filename)) missing.push(item.filename)
  for (const filename of failedFiles) if (!missing.includes(filename)) missing.push(filename)
  if (batchRecovery && missing.length === 0) await completeHubImageRecovery(job, batchRecovery)
  if (repairOnly) {
    job.result = {
      repair_only: true,
      total_expected: items.length,
      recovered: items.length - missing.length,
      still_missing: missing.length,
    }
    job.output_lines.push(
      missing.length === 0
        ? `Repair complete — all ${items.length} Hub image artifact(s) are verified on disk.`
        : `Repair recovered every available Hub artifact; ${missing.length} image(s) still need a deliberate Retry.`,
    )
    return
  }
  requireJobCompletion(job, {
    label: 'Image pool generation', expected: total, completed: total - missing.length,
    missing,
    retry_hint: 'Generated images were kept under stable names; Retry submits only missing items.',
  })
  job.output_lines.push(
    `Done — ${total}/${total} image(s) verified; pool indexed (+${scan.added.length} new).`,
  )
}
