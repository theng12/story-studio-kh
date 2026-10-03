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
import { resolveOutputFormat } from '../services/generation-compression.js'
import { isDecodableImage } from '../lib/image-validation.js'
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
import { GenStudioImageTerminalFailureError, buildGenStudioImageIdempotencyKey, isGenStudioInsufficientCredits } from '../lib/genstudio-client.js'
import { FLEET_BUSY_RETRY_DELAYS_MS, isFleetBusyFailure } from '../lib/genstudio-fleet-busy.js'
import { imageRouteRetryDelayMs } from '../services/image-route-retry.js'
import { resolveConfiguredAspectRatio, resolveConfiguredOutputOption, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { checkpointGenStudioAsset } from '../services/genstudio-recovery.js'
import {
  assertReleasedZeroSettlementImageRetrySubmit,
  authoritativePaidImageSettledCredits,
  buildPaidImageOriginalIdentity,
  capturePaidImageReferenceIdentity,
  decidePaidImageReplacement,
  isReleasedZeroSettlementImageRetry,
  readPaidImageOriginalRequest,
  revalidatePaidImageOutputPath,
  type PaidImageOutputSelector,
} from '../services/image-paid-replacement.js'

/**
 * The modality every request in this generator belongs to.
 *
 * A refusal here arrives as `GenStudioImageTerminalFailureError`, which builds
 * its base with `super('image', job, …)` in lib/genstudio-client.ts. Named here
 * rather than spelled inline at the call site so the test can assert it against
 * a LIVE error instance: if that string is ever renamed upstream, the test fails
 * loudly instead of the guard below silently matching nothing and quietly
 * turning the retry back off. A saturated TTS or video queue says nothing about
 * whether THIS image's credits came back.
 */
export const IMAGE_POOL_GENSTUDIO_MODALITY = 'image'

/** One scheduled re-ask for a pool image, or `null` to fail it exactly as before. */
export interface ImagePoolFleetBusyPlan {
  waitMs: number
  reason: string
  maxAttempts: number
}

/**
 * v1.4.34 — the ONE failure this generator asks about a second time: GenStudio
 * had no free MACHINE for the image. The eighth and last generator to learn it.
 *
 * WHY HERE. GenStudio places every job on a machine in the Mac-mini fleet, and
 * with none free it settles the job FAILED with `SITE_PLACEMENT_EXHAUSTED` after
 * a fifteen-minute placement window. This generator's item loop already
 * continues past a failure, so a busy fleet does not end the run — it silently
 * subtracts images from it. A pool grow of "40 images" that quietly returns 31
 * is the same defect that cost the owner 122 of 353 transcription items in a
 * single burst on 22 August, and 5 TTS sections over 13-15 August that nobody
 * noticed for NINE DAYS, because the only symptom is a missing asset a later
 * manual retry quietly fills in. A pool is even easier to under-count than an
 * episode: nothing but the final tally says how many images should be there.
 *
 * WHY RESUBMITTING IS FREE. GenStudio raises this code from one place, having
 * already held the job in that fifteen-minute window, and states there what
 * became of the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so another attempt is a
 * fresh charge for work that never happened — not a second charge for the same
 * work. The argument does not extend one inch further. Every other terminal
 * code may describe work a provider already performed and billed; it gets no
 * plan here and fails the item exactly as it does today. A "Repair & Retry all"
 * button was removed in v1.0.114 for precisely that, which is why what this
 * function REFUSES matters more than the one case it allows.
 *
 * This deliberately does NOT reuse `generators/images.ts`'s `imageRetryPlan`.
 * That one also retries a declined ROUTE (`CLOUD_PROVIDER_EXHAUSTED`) on a
 * seconds-long schedule; pool generation has never had a route retry, and
 * importing it to save four lines would smuggle a second, unasked-for behaviour
 * change into a fix about a busy fleet.
 *
 * The waits are the shared minutes-long schedule, bounded by its own length: a
 * two-second retry after a fifteen-minute placement window merely rejoins the
 * same jam and burns the attempt.
 *
 * Exported as a pure function so the decision is testable on its own, without
 * driving a paid pool grow against a saturated fleet to observe it.
 *
 * @param attemptNum the 1-based attempt that just failed.
 */
export function imagePoolFleetBusyRetryPlan(
  e: unknown,
  attemptNum: number,
): ImagePoolFleetBusyPlan | null {
  if (!isFleetBusyFailure(e, IMAGE_POOL_GENSTUDIO_MODALITY)) return null
  const waitMs: number | undefined = FLEET_BUSY_RETRY_DELAYS_MS[attemptNum - 1]
  if (waitMs === undefined) return null
  return { waitMs, reason: 'High demand right now', maxAttempts: FLEET_BUSY_RETRY_DELAYS_MS.length + 1 }
}

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

export async function generateImagePoolImages(job: Job): Promise<jq.JobExecutorResult> {
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
  if (!apiKey) throw new Error('Add the Gateway key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, model, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)
  const aspectRatio = resolveConfiguredAspectRatio(modelConfig, params.aspect_ratio)
  // Validated once for the whole pool, before the first charged submit.
  const outputOption = resolveConfiguredOutputOption(modelConfig, aspectRatio, params.resolution)
  const paidSelector = outputOption ? {
    resolution: outputOption.resolution, aspect_ratio: outputOption.aspect_ratio,
    width: outputOption.width, height: outputOption.height, reference_mode: 'normal',
  } satisfies PaidImageOutputSelector : null
  const emptyReferences = capturePaidImageReferenceIdentity(pool.folder_path, [])
  const logicalPaidScope = (entry: TaskManifestEntry | null | undefined, fallback: string): string => {
    const saved = entry?.request_scope || ''
    const marker = saved.indexOf(':selector:')
    return marker > 0 ? saved.slice(0, marker) : fallback
  }

  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${model}" is not routed through the Gateway.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('Image generation through the Gateway is not available right now.')
  // "Smaller files" for the image pool (Settings, per-project override); undefined = native PNG.
  const outputFormat = await resolveOutputFormat(job.project_slug, 'image_pool')
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
  if (initialReady.size) {
    const manifest = await readManifest(pool.folder_path)
    for (const filename of initialReady) {
      const entry = manifest.tasks[filename]
      const submitPermission = entry
        ? await jq.getPaidImageReplacementSubmitPermission(job, filename, pool.folder_path, filename, entry)
        : null
      const artifactPermission = entry
        ? jq.getPaidImageReplacementArtifactPermission(job, filename, pool.folder_path, filename, entry)
        : null
      if (submitPermission || artifactPermission) {
        if (await isDecodableImage(path.join(pool.folder_path, filename))) {
          if (artifactPermission) {
            await jq.checkpointPaidImageReplacementAttempt(job, filename, {
              state: 'succeeded', replacement_task_id: artifactPermission.replacement_task_id,
            })
          }
        } else {
          initialReady.delete(filename)
        }
      }
    }
  }
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
    entry: { taskId: string; submittedAt: string; inputHash: string; scope: string; idempotencyKey?: string; original?: Partial<TaskManifestEntry> },
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
      ...entry.original,
    }
    if (strict) await recordTaskStrict(pool.folder_path, filename, payload)
    else await recordTask(pool.folder_path, filename, payload)
  }

  const saveResult = async (item: typeof items[number], result: { url?: string }): Promise<void> => {
    if (!result.url) throw new Error('provider returned no image')
    await saveGenStudioImage(result.url, path.join(pool.folder_path, item.filename), undefined, { compress: !!outputFormat })
    if (!await isUsable(item.filename)) throw new Error('downloaded image is empty')
    successfulFiles.add(item.filename)
    failedFiles.delete(item.filename)
  }

  /**
   * Sleep before asking a busy fleet again — in short slices, so a Cancel or a
   * Pause pressed four minutes into a five-minute wait is honoured within
   * seconds instead of at the end of it.
   */
  const waitForFleetCapacity = async (ms: number): Promise<void> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)) return
      await new Promise(resolve => setTimeout(resolve, Math.min(2_000, deadline - Date.now())))
    }
  }

  itemLoop:
  for (const item of remaining) {
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    // v1.4.35 — Pause is read here, before the next PAID submit. The loop had
    // only ever read Cancel, so pressing Pause let it carry on buying images
    // one after another until the pool finished. `throwIfPauseRequested` raises
    // JobPausedError, which the queue settles as `paused` rather than `error`:
    // images already accepted are allowed to finish and save, and Resume
    // submits only what is still missing from disk.
    jq.throwIfPauseRequested(job.job_id)
    // v1.4.34 — attempts for THIS item. Only a busy fleet earns another one;
    // every other outcome, good or bad, leaves this inner loop on the first
    // pass. Nothing here changes the shape of the run: an item that exhausts
    // its waits fails exactly as it does today, the catch below still records
    // it, and the outer loop still goes on to the remaining items.
    let attemptNum = 1
    let zeroSettlementRetryPending = false
    let retryItem = true
    while (retryItem) {
      retryItem = false
      // Cancel is re-read at the top of EVERY attempt, not just every item: a
      // resubmission must never start after the owner has already stopped the
      // run, and a fleet wait runs into minutes.
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
      let acceptedTaskId = ''
      let acceptedKey = ''
      let attemptScope = ''
      let attemptHash = ''
      let attemptSubmittedAt = ''
      let attemptOriginal: Partial<TaskManifestEntry> = {}
      let attemptBaseScope = ''
      let paidReplacement = false
      let releasedZeroSettlementRetry = false
      try {
        // Re-read per attempt, from DISK — not from a copy taken before the
        // run. The failed entry the catch below writes is what promotes the
        // next identity, so an in-process retry and a crash-replay read the
        // same bytes and derive the SAME scope, never two for one retry.
        const manifest = await readManifest(pool.folder_path)
        const entry = manifest.tasks[item.filename] || null
        const originalSelector = entry?.original_output_selector || paidSelector
        // The run id keeps one deliberate generation stable across retries; a
        // terminal provider failure promotes it to a NEW, deterministic retry
        // identity so Retry submits fresh work instead of replaying a dead job.
        const baseScope = `run:${runId}`
        attemptBaseScope = baseScope
        const durablePermission = entry
          ? await jq.getPaidImageReplacementSubmitPermission(job, item.filename, pool.folder_path, item.filename, entry)
          : null
        const submittedRecoveryCandidate = entry
          ? jq.getPaidImageReplacementRecoveryEntry(job, item.filename, pool.folder_path, item.filename, entry)
          : null
        const submittedRecoveryEntry = submittedRecoveryCandidate
          && (!durablePermission || !submittedRecoveryCandidate.idempotency_key)
          ? submittedRecoveryCandidate
          : null
        let replacementScope = durablePermission?.replacement_scope || ''
        if (!replacementScope && !submittedRecoveryEntry && originalSelector && entry && isTerminalGenStudioImageTaskFailure(entry) && entry.original_output_selector) {
          const decision = await decidePaidImageReplacement({
            job,
            asset: {
              assetKey: item.filename, manifestDir: pool.folder_path, manifestKey: item.filename,
              outputPath: path.join(pool.folder_path, item.filename), owningRoot: pool.folder_path,
              trustedOriginal: { prompt: item.prompt, baseScope: logicalPaidScope(entry, baseScope) },
              modelId: modelConfig.api_model || model, apiKey,
            },
          })
          if (decision.action === 'wait') {
            await jq.checkpointJobState(job)
            return { kind: 'paid-image-wait' }
          }
          if (decision.action === 'recover-original') {
            if (await isUsable(item.filename)) continue itemLoop
            throw new Error('The original task may still be recoverable; no replacement was submitted.')
          }
          if (decision.action === 'blocked') {
            await jq.checkpointPaidImageReplacementBlockedIfPresent(job, item.filename, decision.reason, decision.public_reason)
            jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
            throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
          }
          if (decision.action === 'safe-zero-settlement-retry') zeroSettlementRetryPending = true
          if (decision.action === 'commit') replacementScope = decision.scope
        }
        const retryEntry = entry?.request_scope?.includes(':selector:')
          ? { ...entry, request_scope: logicalPaidScope(entry, baseScope) }
          : entry
        let logicalScope = resolveImageRetryScope(retryEntry, baseScope).scope
        let identity = originalSelector
          ? buildPaidImageOriginalIdentity({ prompt: item.prompt, selector: originalSelector, references: emptyReferences.inputs, baseScope: logicalScope })
          : null
        let scope = replacementScope || (submittedRecoveryEntry ? entry!.replacement_scope! : '') || identity?.requestScope || logicalScope
        let inputHash = replacementScope || submittedRecoveryEntry ? entry!.input_hash! : identity?.inputHash || hashInput(`${scope}\n${item.prompt}`)
        const reclaimable = submittedRecoveryEntry || (entry
          && (entry.request_scope ? entry.input_hash === inputHash : true)
          && !replacementScope && !isTerminalGenStudioImageTaskFailure(entry)
          ? entry
          : null)
        const recovery = await tryRecoverImageFromManifestEntry(
          reclaimable,
          apiKey,
          modelConfig,
          () => jq.isCancelled(job.job_id),
        )
        if (recovery.kind === 'uncertain') {
          // An unconfirmed outcome must never become a second paid submission.
          if (submittedRecoveryEntry) throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
          throw new Error(
            `Could not confirm Gateway task ${recovery.taskId.slice(0, 12)}… (${recovery.reason}). ` +
            'No duplicate image was submitted; Retry reconnects to the same job.',
          )
        }
        let carried: TaskManifestEntry | null = entry
        if (recovery.kind === 'terminal-failed' || recovery.kind === 'artifact-unavailable') {
          if (submittedRecoveryEntry) {
            if (submittedRecoveryEntry.idempotency_key) {
              await checkpointGenStudioAsset(job, item.filename, {
                operation: 'image', idempotency_key: submittedRecoveryEntry.idempotency_key,
                job_id: recovery.taskId, state: 'failed', output_path: path.join(pool.folder_path, item.filename),
                input_hash: entry!.input_hash!,
              })
            }
            await jq.checkpointPaidImageReplacementAttempt(job, item.filename, {
              state: 'failed', replacement_task_id: recovery.taskId, reason: recovery.reason,
            })
            throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
          }
          carried = terminalImageManifestEntry(entry!, recovery)
          await recordTaskStrict(pool.folder_path, item.filename, carried)
          if (originalSelector && carried.idempotency_key) {
            const decision = await decidePaidImageReplacement({
              job,
              asset: {
                assetKey: item.filename, manifestDir: pool.folder_path, manifestKey: item.filename,
                outputPath: path.join(pool.folder_path, item.filename), owningRoot: pool.folder_path,
                trustedOriginal: { prompt: item.prompt, baseScope: logicalPaidScope(carried, baseScope) },
                modelId: modelConfig.api_model || model, apiKey,
              },
            })
            if (decision.action === 'wait') {
              await jq.checkpointJobState(job)
              return { kind: 'paid-image-wait' }
            }
            if (decision.action === 'blocked') {
              await jq.checkpointPaidImageReplacementBlockedIfPresent(job, item.filename, decision.reason, decision.public_reason)
              jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
              throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
            }
            if (decision.action === 'safe-zero-settlement-retry') zeroSettlementRetryPending = true
          }
          const carriedRetry = carried.request_scope?.includes(':selector:')
            ? { ...carried, request_scope: logicalPaidScope(carried, baseScope) }
            : carried
          logicalScope = resolveImageRetryScope(carriedRetry, baseScope).scope
          identity = originalSelector
            ? buildPaidImageOriginalIdentity({ prompt: item.prompt, selector: originalSelector, references: emptyReferences.inputs, baseScope: logicalScope })
            : null
          scope = identity?.requestScope || logicalScope
          inputHash = identity?.inputHash || hashInput(`${scope}\n${item.prompt}`)
          job.output_lines.push(
            `↻ item ${item.index + 1}: saved Gateway task ${recovery.taskId.slice(0, 12)}… is terminal; ` +
            'submitting one fresh job under a new retry identity.',
          )
        }
        const submittedAt = carried?.request_scope === scope && carried.submitted_at
          ? carried.submitted_at
          : new Date().toISOString()
        attemptScope = scope
        attemptHash = inputHash
        attemptSubmittedAt = submittedAt
        paidReplacement = !!replacementScope || !!submittedRecoveryEntry
        attemptOriginal = identity && originalSelector ? {
          original_output_selector: originalSelector,
          original_reference_inputs: emptyReferences.inputs,
          original_reference_identity_hash: emptyReferences.identity_hash,
          original_output_path: revalidatePaidImageOutputPath(pool.folder_path, path.join(pool.folder_path, item.filename)),
        } : {}
        if (recovery.kind === 'recovered' && recovery.urls[0]) {
          await saveResult(item, { url: recovery.urls[0] })
          if (submittedRecoveryEntry) {
            await jq.checkpointPaidImageReplacementAttempt(job, item.filename, {
              state: 'succeeded', replacement_task_id: recovery.taskId,
            })
          } else {
            await recordState(item.filename, {
              taskId: recovery.taskId, submittedAt, inputHash, scope,
            }, 'succeeded')
          }
          made++
          job.output_lines.push(`✓ ${successfulFiles.size}/${total} — recovered accepted task ${recovery.taskId.slice(0, 12)}… (no charge)`)
          processed++
          job.progress = Math.round((processed / total) * 90)
          // Labelled because this `continue` now sits inside the per-item
          // attempt loop: it means "this item is finished", exactly as it did
          // before, and must not be read as "take another attempt".
          continue itemLoop
        }
        // Identity on disk before the charged POST: a lost response replays the
        // same idempotency key rather than paying for a second image.
        const preparedKey = buildGenStudioImageIdempotencyKey({
          prompt: item.prompt,
          modelId: modelConfig.api_model || model,
          aspectRatio,
          ...(outputOption ? { resolution: outputOption.resolution } : {}),
          seed: params.seed,
          requestIdentity: replacementScope || `${generationIdentity}:${item.filename}:${scope}`,
          ...(outputFormat ? { outputFormat } : {}),
        })
        if (!replacementScope) {
          await recordState(item.filename, {
            taskId: '', submittedAt, inputHash, scope, idempotencyKey: preparedKey, original: attemptOriginal,
          }, 'prepared', true)
          await checkpointGenStudioAsset(job, item.filename, {
            operation: 'image', idempotency_key: preparedKey, state: 'prepared',
            output_path: path.join(pool.folder_path, item.filename),
          })
        }
        if (replacementScope) {
          readPaidImageOriginalRequest(entry!, pool.folder_path, {
            prompt: item.prompt, baseScope: logicalPaidScope(entry, baseScope),
          })
        }
        const result = await imageProvider.generateImage({
          prompt: item.prompt,
          apiKey,
          aspectRatio,
          modelId: modelConfig.api_model || model,
          providerParams,
          ...(outputOption ? { resolution: outputOption.resolution } : {}),
          seed: params.seed,
          ...(outputFormat ? { outputFormat } : {}),
          idempotencyIdentity: replacementScope || `${generationIdentity}:${item.filename}:${scope}`,
          idempotencyKey: preparedKey,
          ...(replacementScope && entry ? {
            beforeSubmit: () => jq.assertPaidImageReplacementSubmitPermission(
              job, item.filename, pool.folder_path, item.filename, entry,
            ),
          } : zeroSettlementRetryPending ? {
            beforeSubmit: assertReleasedZeroSettlementImageRetrySubmit,
          } : {}),
          onQueueState: async state => {
            job.item_progress = {
              total,
              completed: processed,
              failed: 0,
              concurrency: 1,
              active: [{
                label: item.filename,
                key: item.filename,
                state: state === 'waiting_account_capacity' ? 'waiting_retry' : 'running',
                attempt: 1,
                max_attempts: 1,
                ...(state === 'waiting_account_capacity' ? { reason: 'Waiting for available image capacity' } : {}),
              }],
            }
            await jq.checkpointJobState(job)
          },
          isCancelled: () => jq.isCancelled(job.job_id),
          onJobAccepted: async (taskId, idempotencyKey) => {
            acceptedTaskId = taskId
            acceptedKey = idempotencyKey
            if (replacementScope) {
              const currentPaid = job.paid_image_replacement_attempts?.find(attempt => attempt.asset_key === item.filename)
              if (currentPaid?.state === 'committed') {
                await jq.checkpointPaidImageReplacementAttempt(job, item.filename, { state: 'submitted', replacement_task_id: taskId })
              } else if (currentPaid?.state !== 'submitted' || currentPaid.replacement_task_id !== taskId) {
                throw new Error('Paid image replacement replay returned a different provider task.')
              }
            } else await recordState(item.filename, {
              taskId, submittedAt, inputHash, scope, idempotencyKey, original: attemptOriginal,
            }, 'accepted', true)
            await checkpointGenStudioAsset(job, item.filename, {
              operation: 'image', idempotency_key: idempotencyKey, job_id: taskId,
              state: 'accepted', output_path: path.join(pool.folder_path, item.filename),
            })
          },
        })
        const completedTaskId = result.taskId || acceptedTaskId
        if (replacementScope) {
          if (result.taskId && acceptedTaskId && result.taskId !== acceptedTaskId) {
            throw new Error('Paid image replacement returned different provider tasks at acceptance and completion.')
          }
          if (!completedTaskId) throw new Error('Paid image replacement completed without a provider task identity.')
          const completedEntry = (await readManifest(pool.folder_path)).tasks[item.filename]
          const paidAttempt = completedEntry
            ? jq.getPaidImageReplacementArtifactPermission(job, item.filename, pool.folder_path, item.filename, completedEntry)
            : null
          if (paidAttempt?.replacement_task_id !== completedTaskId) {
            throw new Error('Paid image replacement completed under a different provider task.')
          }
        }
        if (!result.urls.length) throw new Error('provider returned no image')
        await saveResult(item, { url: result.urls[0] })
        if (replacementScope) {
          const actualSettledCredits = authoritativePaidImageSettledCredits(result.settledCredits)
          await jq.checkpointPaidImageReplacementAttempt(job, item.filename, {
            state: 'succeeded', replacement_task_id: completedTaskId,
            ...(actualSettledCredits !== undefined ? { actual_settled_credits: actualSettledCredits } : {}),
          })
        } else if (result.taskId) {
          await recordState(item.filename, {
            taskId: result.taskId, submittedAt, inputHash, scope, idempotencyKey: acceptedKey, original: attemptOriginal,
          }, 'succeeded')
          await checkpointGenStudioAsset(job, item.filename, {
            operation: 'image', idempotency_key: acceptedKey || preparedKey, job_id: result.taskId,
            state: 'succeeded', output_path: path.join(pool.folder_path, item.filename),
          })
        }
        made++
        job.output_lines.push(`✓ ${successfulFiles.size}/${total} — "${item.prompt.slice(0, 60)}${item.prompt.length > 60 ? '…' : ''}"`)
      } catch (e: any) {
        // Running out of money is not a busy fleet. This rethrow stays first and
        // unchanged: no wait, no resubmission, the whole run stops.
        if (isGenStudioInsufficientCredits(e)) throw e
        if (e instanceof GenStudioImageTerminalFailureError && attemptScope) {
          const failedTaskId = e.jobId || acceptedTaskId
          // Persist the settled failure BEFORE deciding to retry, so the next
          // attempt — in this run or in a later manual Retry — reads it back
          // and promotes a fresh identity instead of replaying this dead job.
          if (paidReplacement) {
            const actualSettledCredits = authoritativePaidImageSettledCredits(e.settledCredits)
            await jq.checkpointPaidImageReplacementAttempt(job, item.filename, {
              state: 'failed', replacement_task_id: failedTaskId, reason: e.message,
              ...(actualSettledCredits !== undefined ? { actual_settled_credits: actualSettledCredits } : {}),
            })
          } else {
            await recordState(item.filename, {
              taskId: failedTaskId, submittedAt: attemptSubmittedAt, inputHash: attemptHash,
              scope: attemptScope, idempotencyKey: acceptedKey, original: attemptOriginal,
            }, 'failed', true)
            if (failedTaskId && acceptedKey) {
              await checkpointGenStudioAsset(job, item.filename, {
                operation: 'image', idempotency_key: acceptedKey, job_id: failedTaskId,
                state: 'failed', output_path: path.join(pool.folder_path, item.filename), input_hash: attemptHash,
              })
            }
            if (attemptOriginal.original_output_selector) {
              const failedEntry = (await readManifest(pool.folder_path)).tasks[item.filename]!
              const decision = await decidePaidImageReplacement({
                job,
                asset: {
                  assetKey: item.filename, manifestDir: pool.folder_path, manifestKey: item.filename,
                  outputPath: path.join(pool.folder_path, item.filename), owningRoot: pool.folder_path,
                  trustedOriginal: { prompt: item.prompt, baseScope: logicalPaidScope(failedEntry, attemptBaseScope) },
                  modelId: modelConfig.api_model || model, apiKey,
                },
              })
              releasedZeroSettlementRetry = isReleasedZeroSettlementImageRetry(e, decision)
              zeroSettlementRetryPending ||= releasedZeroSettlementRetry
              if (decision.action === 'wait') {
                await jq.checkpointJobState(job)
                return { kind: 'paid-image-wait' }
              }
              if (decision.action === 'blocked') {
                await jq.checkpointPaidImageReplacementBlockedIfPresent(job, item.filename, decision.reason, decision.public_reason)
                jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
                job.output_lines.push(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
              }
            }
          }
          // ── "Every machine was busy" — wait, then ask again ──
          // Fleet-busy failures follow the shared backoff. A fully refunded,
          // policy-approved terminal failure keeps retrying with backoff.
          // A dead task id is REQUIRED because the next
          // identity is derived from it: without one `resolveImageRetryScope`
          // cannot promote the scope, and the retry would replay a
          // settled-failed key, which returns the same failure forever.
          const retryPlan = imagePoolFleetBusyRetryPlan(e, attemptNum)
            || (releasedZeroSettlementRetry
              ? { waitMs: imageRouteRetryDelayMs(attemptNum - 1), reason: 'The failed image was fully refunded', maxAttempts: attemptNum + 1 }
              : null)
          if (retryPlan && failedTaskId && !jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {
            job.output_lines.push(
              `item ${item.index + 1}: ${retryPlan.reason.toLowerCase()} — nothing was charged, ` +
              'the credits came back whole. ' +
              `Waiting ${Math.round(retryPlan.waitMs / 1000)}s and asking again ` +
              `(attempt ${attemptNum + 1}${releasedZeroSettlementRetry ? '' : ` of ${retryPlan.maxAttempts}`}).`,
            )
            await waitForFleetCapacity(retryPlan.waitMs)
            // Re-read after the wait. Minutes passed, and a Cancel or a Pause
            // pressed during them is the owner's last word — the item then
            // fails exactly as it does today rather than being resubmitted.
            if (!jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {
              attemptNum++
              retryItem = true
            }
          }
        }
        // Unchanged when the waits are spent or never applied: the item is
        // recorded failed and the run carries on to the next one.
        if (!retryItem) {
          failed++
          failedFiles.add(item.filename)
          job.output_lines.push(paidReplacement
            ? jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE
            : `✗ item ${item.index + 1} failed: ${e?.message || e}`)
        }
      }
      // An item still waiting on the fleet has not settled, so it must not
      // count towards progress yet — otherwise a retried run reports more items
      // done than it has images for.
      if (!retryItem) {
        processed++
        job.progress = Math.round((processed / total) * 90)
      }
    }
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
