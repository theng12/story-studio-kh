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
import { registry } from '../providers/registry.js'
import { saveGenStudioImage } from '../lib/genstudio-artifacts.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as bp from '../services/broll-pool-manager.js'
import { scanPoolFolder } from '../lib/broll-indexer.js'
import type { Job } from '../models/types.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { hashInput, readManifest, recordTask, recordTaskStrict, type TaskManifestEntry } from '../services/task-manifest.js'
import {
  isTerminalGenStudioImageTaskFailure,
  resolveImageRetryScope,
  terminalImageManifestEntry,
  tryRecoverImageFromManifestEntry,
} from '../lib/manifest-recovery.js'
import { GenStudioImageTerminalFailureError } from '../lib/genstudio-client.js'
import { resolveConfiguredAspectRatio, resolveConfiguredOutputOption, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { getApiKey } from '../services/app-secrets-store.js'

interface ImagePoolGenerateParams {
  pool_id: string
  prompts: string[]
  model: string
  aspect_ratio?: string
  /** Resolution label of the chosen published `output_options[]` row. */
  resolution?: string
  seed?: number
  /** Images to generate per prompt (1–4). Default 1. */
  variants?: number
  /** Durable identity retained by manual/local retries. */
  run_id?: string
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
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add the GenStudio API key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, model, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)
  const aspectRatio = resolveConfiguredAspectRatio(modelConfig, params.aspect_ratio)
  // Validated once for the whole pool, before the first charged submit.
  const outputOption = resolveConfiguredOutputOption(modelConfig, aspectRatio, params.resolution)

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
  const remaining = items.filter(item => !initialReady.has(item.filename))
  const generationIdentity = `image-pool:${poolId}:${runId}`
  let made = 0
  let failed = 0
  let processed = items.length - remaining.length
  const successfulFiles = new Set(initialReady)
  const failedFiles = new Set<string>()

  const providerId = imageProvider.meta.providerId || imageProvider.meta.id
  const recordState = async (
    filename: string,
    entry: { taskId: string; submittedAt: string; inputHash: string; scope: string; idempotencyKey?: string },
    state: string,
    strict = false,
  ): Promise<void> => {
    const payload: TaskManifestEntry = {
      provider: providerId,
      task_id: entry.taskId,
      submitted_at: entry.submittedAt,
      input_hash: entry.inputHash,
      request_scope: entry.scope,
      ...(entry.idempotencyKey ? { idempotency_key: entry.idempotencyKey } : {}),
      operation: 'image',
      last_state: state,
    }
    if (strict) await recordTaskStrict(pool.folder_path, filename, payload)
    else await recordTask(pool.folder_path, filename, payload)
  }

  const saveResult = async (item: typeof items[number], result: { url?: string }): Promise<void> => {
    if (!result.url) throw new Error('provider returned no image')
    await saveGenStudioImage(result.url, path.join(pool.folder_path, item.filename))
    if (!await isUsable(item.filename)) throw new Error('downloaded image is empty')
    successfulFiles.add(item.filename)
    failedFiles.delete(item.filename)
  }

  for (const item of remaining) {
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    let acceptedTaskId = ''
    let acceptedKey = ''
    let attemptScope = ''
    let attemptHash = ''
    let attemptSubmittedAt = ''
    try {
      const manifest = await readManifest(pool.folder_path)
      const entry = manifest.tasks[item.filename] || null
      // The run id keeps one deliberate generation stable across retries; a
      // terminal provider failure promotes it to a NEW, deterministic retry
      // identity so Retry submits fresh work instead of replaying a dead job.
      const baseScope = `run:${runId}`
      let scope = resolveImageRetryScope(entry, baseScope).scope
      let inputHash = hashInput(`${scope}\n${item.prompt}`)
      const reclaimable = entry
        && (entry.request_scope ? entry.input_hash === inputHash : true)
        && !isTerminalGenStudioImageTaskFailure(entry)
        ? entry
        : null
      const recovery = await tryRecoverImageFromManifestEntry(
        reclaimable,
        apiKey,
        modelConfig,
        () => jq.isCancelled(job.job_id),
      )
      if (recovery.kind === 'uncertain') {
        // An unconfirmed outcome must never become a second paid submission.
        throw new Error(
          `Could not confirm GenStudio task ${recovery.taskId.slice(0, 12)}… (${recovery.reason}). ` +
          'No duplicate image was submitted; Retry reconnects to the same job.',
        )
      }
      let carried: TaskManifestEntry | null = entry
      if (recovery.kind === 'terminal-failed' || recovery.kind === 'artifact-unavailable') {
        carried = terminalImageManifestEntry(entry!, recovery)
        await recordTask(pool.folder_path, item.filename, carried)
        scope = resolveImageRetryScope(carried, baseScope).scope
        inputHash = hashInput(`${scope}\n${item.prompt}`)
        job.output_lines.push(
          `↻ item ${item.index + 1}: saved GenStudio task ${recovery.taskId.slice(0, 12)}… is terminal; ` +
          'submitting one fresh job under a new retry identity.',
        )
      }
      const submittedAt = carried?.request_scope === scope && carried.submitted_at
        ? carried.submitted_at
        : new Date().toISOString()
      attemptScope = scope
      attemptHash = inputHash
      attemptSubmittedAt = submittedAt
      if (recovery.kind === 'recovered' && recovery.urls[0]) {
        await saveResult(item, { url: recovery.urls[0] })
        await recordState(item.filename, {
          taskId: recovery.taskId, submittedAt, inputHash, scope,
        }, 'succeeded')
        made++
        job.output_lines.push(`✓ ${successfulFiles.size}/${total} — recovered accepted task ${recovery.taskId.slice(0, 12)}… (no charge)`)
        processed++
        job.progress = Math.round((processed / total) * 90)
        continue
      }
      // Identity on disk before the charged POST: a lost response replays the
      // same idempotency key rather than paying for a second image.
      await recordState(item.filename, { taskId: '', submittedAt, inputHash, scope }, 'prepared', true)
      const result = await imageProvider.generateImage({
          prompt: item.prompt,
          apiKey,
          aspectRatio,
          modelId: modelConfig.api_model || model,
        providerParams,
        ...(outputOption ? { resolution: outputOption.resolution } : {}),
        seed: params.seed,
        idempotencyIdentity: `${generationIdentity}:${item.filename}:${scope}`,
          isCancelled: () => jq.isCancelled(job.job_id),
          onJobAccepted: async (taskId, idempotencyKey) => {
            acceptedTaskId = taskId
            acceptedKey = idempotencyKey
            await recordState(item.filename, {
              taskId, submittedAt, inputHash, scope, idempotencyKey,
            }, 'accepted', true)
          },
        })
        if (!result.urls.length) throw new Error('provider returned no image')
        await saveResult(item, { url: result.urls[0] })
        if (result.taskId) {
          await recordState(item.filename, {
            taskId: result.taskId, submittedAt, inputHash, scope, idempotencyKey: acceptedKey,
          }, 'succeeded')
        }
        made++
        job.output_lines.push(`✓ ${successfulFiles.size}/${total} — "${item.prompt.slice(0, 60)}${item.prompt.length > 60 ? '…' : ''}"`)
      } catch (e: any) {
        if (e instanceof GenStudioImageTerminalFailureError && attemptScope) {
          await recordState(item.filename, {
            taskId: e.jobId || acceptedTaskId,
            submittedAt: attemptSubmittedAt,
            inputHash: attemptHash,
            scope: attemptScope,
            idempotencyKey: acceptedKey,
          }, 'failed')
        }
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
  requireJobCompletion(job, {
    label: 'Image pool generation', expected: total, completed: total - missing.length,
    missing,
    retry_hint: 'Generated images were kept under stable names; Retry submits only missing items.',
  })
  job.output_lines.push(
    `Done — ${total}/${total} image(s) verified; pool indexed (+${scan.added.length} new).`,
  )
}
