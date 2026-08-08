/**
 * Generate every requested missing Scene Plan image through GenStudio.
 * Results are checkpointed into scene_plan.json as each scene finishes.
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync, statSync } from 'fs'
import { registry } from '../providers/registry.js'
import { saveGenStudioImage } from '../lib/genstudio-artifacts.js'
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
import { resolveConfiguredAspectRatio, resolveConfiguredOutputOption, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { hashInput, readManifest, recordTask, recordTaskStrict, type TaskManifestEntry } from '../services/task-manifest.js'
import { resolveImageRetryScope, terminalImageManifestEntry } from '../lib/manifest-recovery.js'
import { GenStudioImageTerminalFailureError } from '../lib/genstudio-client.js'
import { getApiKey } from '../services/app-secrets-store.js'

interface SceneImagesBatchParams {
  episode_id: string
  model: string
  aspect_ratio?: string
  /** Resolution label of the chosen published `output_options[]` row. */
  resolution?: string
  width?: number
  height?: number
  seed?: number
  auto_approve_generated?: boolean
  /** Specific scenes to render; when omitted, every scene missing an image. */
  scene_ids?: string[]
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
    endpoint: modelConfig.endpoint, poll: modelConfig.poll, type: modelConfig.type,
    api_model: modelConfig.api_model, aspect_field: (modelConfig as any).aspect_field,
  }

  const aspectRatio = resolveConfiguredAspectRatio(modelConfig, params.aspect_ratio)
  // Validated once for the whole batch, before the first charged submit.
  const outputOption = resolveConfiguredOutputOption(modelConfig, aspectRatio, params.resolution)
  if (outputOption) {
    job.output_lines.push(
      `Output: ${outputOption.resolution} ${outputOption.aspect_ratio} — ${outputOption.width}×${outputOption.height}px per scene.`,
    )
  }
  const renderWidth = typeof params.width === 'number' && params.width > 0 ? params.width : undefined
  const renderHeight = typeof params.height === 'number' && params.height > 0 ? params.height : undefined
  const total = targets.length
  let done = 0, made = 0, failed = 0
  const successfulSceneIds = new Set<string>()
  const failedSceneIds = new Set<string>()

  const providerId = imageProvider.meta.providerId || imageProvider.meta.id
  // A terminal GenStudio job is never reused here: replaying its idempotency
  // key would only re-read the same failure. The saved manifest state promotes
  // the request identity deterministically, so a retry is genuinely fresh while
  // a lost submit response still re-attaches to the job already paid for.
  const taskManifest = await readManifest(outDir)

  interface SceneAttempt { scope: string; inputHash: string; submittedAt: string }

  const resolveAttempt = (scene: ScenePlanEntry): SceneAttempt => {
    const entry = taskManifest.tasks[`${scene.id}.png`] || null
    const scope = resolveImageRetryScope(entry, 'batch').scope
    const inputHash = hashInput(`${scope}\n${scene.visual_prompt!}`)
    const submittedAt = entry?.request_scope === scope && entry.submitted_at
      ? entry.submitted_at
      : new Date().toISOString()
    return { scope, inputHash, submittedAt }
  }

  const recordState = async (
    scene: ScenePlanEntry,
    attempt: SceneAttempt,
    state: string,
    taskId: string,
    idempotencyKey = '',
    strict = false,
  ): Promise<void> => {
    const payload: TaskManifestEntry = {
      provider: providerId,
      task_id: taskId,
      submitted_at: attempt.submittedAt,
      input_hash: attempt.inputHash,
      request_scope: attempt.scope,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      operation: 'image',
      last_state: state,
    }
    if (strict) await recordTaskStrict(outDir, `${scene.id}.png`, payload)
    else await recordTask(outDir, `${scene.id}.png`, payload)
  }

  const buildReq = (
    scene: ScenePlanEntry,
    attempt: SceneAttempt,
    onAccept: (taskId: string, idempotencyKey: string) => void,
  ): ImageGenerationRequest => ({
    prompt: scene.visual_prompt!,
    apiKey, aspectRatio, modelId: modelConfig.api_model || model, providerParams,
    ...(outputOption
      ? { resolution: outputOption.resolution }
      : { width: renderWidth, height: renderHeight }),
    seed: params.seed,
    idempotencyIdentity: `${job.project_slug}:${episode_id}:scene:${scene.id}:image:${attempt.scope}`,
    onJobAccepted: async (taskId, idempotencyKey) => {
      onAccept(taskId, idempotencyKey)
      await recordState(scene, attempt, 'accepted', taskId, idempotencyKey, true)
    },
    isCancelled: () => jq.isCancelled(job.job_id),
  } as ImageGenerationRequest)

  // Download + write image_path back to the plan. Re-read fresh each time to
  // avoid clobbering a concurrent write (onItemDone is serialised, but the
  // fallback loop + other jobs may touch the same file).
  const saveScene = async (scene: ScenePlanEntry, url: string): Promise<void> => {
    const outPath = path.join(outDir, `${scene.id}.png`)
    await saveGenStudioImage(url, outPath)
    await checkpointSceneImage(planPath, scene.id, outPath, scene.visual_prompt, params.auto_approve_generated === true)
    successfulSceneIds.add(scene.id)
    failedSceneIds.delete(scene.id)
  }

  job.output_lines.push(`Scene images — ${imageProvider.meta.name} / ${model} · ${total} scene(s)`)

  for (const scene of targets.filter(item => !successfulSceneIds.has(item.id))) {
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    const attempt = resolveAttempt(scene)
    let acceptedTaskId = ''
    let acceptedKey = ''
    try {
      // Identity on disk before the charged POST.
      await recordState(scene, attempt, 'prepared', '', '', true)
      const result = await imageProvider.generateImage(buildReq(scene, attempt, (taskId, key) => {
        acceptedTaskId = taskId
        acceptedKey = key
      }))
      if (!result.urls.length) throw new Error('GenStudio KH returned no image')
      await saveScene(scene, result.urls[0]!)
      await recordState(scene, attempt, 'succeeded', result.taskId || acceptedTaskId, acceptedKey)
      made++
      job.output_lines.push(`Scene ${scene.scene_index}/${plan.scenes.length} (${scene.id}) ✓`)
    } catch (e: any) {
      // Persist a settled failure so the next Retry mints a fresh identity
      // instead of replaying this dead GenStudio job.
      if (e instanceof GenStudioImageTerminalFailureError) {
        const entry = taskManifest.tasks[`${scene.id}.png`]
        await recordState(scene, attempt, 'failed', e.jobId || acceptedTaskId, acceptedKey)
        if (entry) {
          taskManifest.tasks[`${scene.id}.png`] = terminalImageManifestEntry(entry, {
            kind: 'terminal-failed', taskId: e.jobId || acceptedTaskId, failureCode: e.failureCode, reason: e.message,
          })
        }
      }
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
