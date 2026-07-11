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
import { isConnectionError } from '../lib/endpoint-pool.js'
import type { ImageGenerationRequest } from '../providers/types.js'
import type { Job, ImageModelConfig } from '../models/types.js'

interface ImagePoolGenerateParams {
  pool_id: string
  prompts: string[]
  model: string
  aspect_ratio?: string
  /** Images to generate per prompt (1–4). Default 1. */
  variants?: number
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

  const stamp = Date.now()
  let made = 0
  let failed = 0
  let idx = 0

  // Studio Hub batch (§6b): in Hub mode, submit ALL images as ONE batch so the
  // Hub distributes them across the whole fleet — this loop is otherwise SERIAL
  // (one image at a time), which barely uses the fleet. Pool stills are txt2img
  // (no references). On a connection error, fall back to the serial loop.
  let batchDone = false
  const hub = await getHubBackend()
  if (hub.mode === 'hub' && hub.hubUrl && providerId === 'imagestudio' && total > 0) {
    try {
      const reqs: ImageGenerationRequest[] = []
      for (let p = 0; p < prompts.length; p++) {
        for (let v = 0; v < variants; v++) {
          reqs.push({ prompt: prompts[p]!, apiKey, aspectRatio, modelId: model, providerParams } as ImageGenerationRequest)
        }
      }
      job.output_lines.push(`Studio Hub batch — ${reqs.length} image(s) as ONE render; the Hub distributes across the fleet.`)
      await renderImageBatchViaHub(reqs, {
        label: `storystudio:pool/${pool.name}`,
        isCancelled: () => jq.isCancelled(job.job_id),
        onItemDone: async (index, result) => {
          const outName = `gen-${stamp}-${String(index + 1).padStart(4, '0')}.png`
          if (result.error || !result.url) {
            failed++
            job.output_lines.push(`✗ image ${index + 1} failed: ${result.error || 'no image'}`)
          } else {
            await downloadImage(result.url, path.join(pool.folder_path, outName))
            made++
            job.output_lines.push(`✓ ${made}/${total}`)
          }
          job.progress = Math.round(((made + failed) / total) * 90)
        },
      })
      batchDone = true
    } catch (e: any) {
      if (!isConnectionError(e)) throw e
      made = 0; failed = 0
      job.output_lines.push(`Studio Hub batch unreachable (${e?.message || e}) — falling back to per-image generation.`)
    }
  }

  if (!batchDone) for (let p = 0; p < prompts.length; p++) {
    const prompt = prompts[p]!
    for (let v = 0; v < variants; v++) {
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
      idx++
      try {
        const result = await imageProvider.generateImage({
          prompt,
          apiKey,
          aspectRatio,
          modelId: model,
          providerParams,
          isCancelled: () => jq.isCancelled(job.job_id),
        })
        if (!result.urls.length) throw new Error('provider returned no image')
        // Unique, scan-friendly name. Pool selection is by content hash, so
        // the name is cosmetic — just keep them ordered + collision-free.
        const outName = `gen-${stamp}-${String(idx).padStart(4, '0')}.png`
        await downloadImage(result.urls[0]!, path.join(pool.folder_path, outName))
        made++
        job.output_lines.push(`✓ ${made}/${total} — "${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"`)
      } catch (e: any) {
        failed++
        job.output_lines.push(`✗ prompt ${p + 1} variant ${v + 1} failed: ${e?.message || e}`)
      }
      job.progress = Math.round((idx / total) * 90)
    }
  }

  if (made === 0) throw new Error(`No images generated (${failed} failed). Check the model + API key.`)

  // Index the new files (image mode) so they're thumbnailed + selectable.
  job.output_lines.push('Indexing new images into the pool…')
  const scan = await scanPoolFolder(pool.folder_path, undefined, 'image')
  job.progress = 100
  job.output_lines.push(
    `Done — generated ${made} image(s)${failed ? `, ${failed} failed` : ''}; pool indexed (+${scan.added.length} new).`,
  )
}
