/**
 * Durable Scene Review image batch.
 *
 * Story Studio owns the verified scene list, per-image checkpoints, and retry
 * scope. GenStudio owns text-to-image admission, account concurrency, queueing,
 * and execution. No reference-chain or direct-provider mode exists here.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { registry } from '../providers/registry.js'
import { saveGenStudioImage } from '../lib/genstudio-artifacts.js'
import { isDecodableImage } from '../lib/image-validation.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { recordTask, hashInput, readManifest } from '../services/task-manifest.js'
import { getCharacter } from '../services/character-manager.js'
import { resolveSceneImagesDir } from './scene-image.js'
import type { Job, ScenePlan, ScenePlanEntry } from '../models/types.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { auditSceneImageCompletion, checkpointSceneImage } from '../services/scene-media-checkpoint.js'
import { selectSceneImageBatch } from '../services/scene-image-batch-selection.js'
import { resolveImageModelConfig } from '../services/image-model-resolver.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { tryRecoverImageFromManifest } from '../lib/manifest-recovery.js'
import { resolveGenStudioLocalFanout } from '../lib/genstudio-runtime.js'

interface ContinuityRenderParams {
  episode_id: string
  title?: string
  model: string
  aspect_ratio?: string
  /** Re-render scenes that already have an image on disk (default: false —
   *  skip them so a cancelled/crashed run resumes). */
  force?: boolean
  /** Stable identity for one deliberate regeneration action and all retries. */
  render_attempt_id?: string
  /** Render only this stable scene ID. */
  single_scene_id?: string
  /** Render an explicit stable-ID set in one durable batch. */
  scene_ids?: string[]
  /** Keep an explicit scene selection as the repair scope, but re-check disk
   *  before every attempt and render only IDs that are still missing. Used by
   *  Generate All Missing and its automatic local retries. */
  missing_only?: boolean
  /** Approve each image only after its verified media checkpoint succeeds. */
  auto_approve_generated?: boolean
  /** Optional provider-published output dimensions. */
  width?: number
  height?: number
  /** Provider-published inference steps and optional reproducible seed. */
  image_steps?: number
  seed?: number
}

interface ContinuityCfg {
  anchor_character_ids: string[]
  style_bible: string
  negative_prompt: string
}
function defaultCfg(): ContinuityCfg {
  return {
    anchor_character_ids: [],
    style_bible: '',
    negative_prompt: '',
  }
}

/** Live render-status sidecar for Scene Review progress. */
export const RENDER_STATUS_FILENAME = '.render_status.json'

export async function runContinuityRenderJob(job: Job): Promise<void> {
  const params = job.params as ContinuityRenderParams
  const { episode_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) {
    throw new Error(`No scene_plan.json at ${planPath}. Run Scene Plan first.`)
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id)
  const requestedIds = params.scene_ids?.length
    ? params.scene_ids
    : (params.single_scene_id ? [params.single_scene_id] : undefined)
  assertScenePromptsRenderable(plan.scenes, requestedIds)
  const scenes = [...plan.scenes].sort((a, b) => a.scene_index - b.scene_index)
  if (!scenes.length) throw new Error('scene_plan.json has no scenes.')

  // Character Sheet contributes text context only. Reference-image execution
  // is intentionally absent until GenStudio publishes that capability.
  let cfg = defaultCfg()
  const continuityPath = path.join(paths.episode_dir, 'continuity.json')
  if (existsSync(continuityPath)) {
    try {
      const raw = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
      cfg = {
        anchor_character_ids: Array.isArray(raw?.anchor_character_ids) ? raw.anchor_character_ids : [],
        style_bible: typeof raw?.style_bible === 'string' ? raw.style_bible.trim() : '',
        negative_prompt: typeof raw?.negative_prompt === 'string' ? raw.negative_prompt.trim() : '',
      }
    } catch { /* keep defaults */ }
  }

  // Resolve model + provider (mirrors the per-scene generator).
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  const modelConfig = resolveImageModelConfig(config, model)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)
  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${model}" is not routed through GenStudio KH.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('GenStudio KH image provider is unavailable.')

  const providerParams = { ...((modelConfig as any).provider_params || {}) }
  if (cfg.negative_prompt) (providerParams as any).negative_prompt = cfg.negative_prompt

  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add the GenStudio API key in Settings before generating images.')

  // Anchor character descriptions reinforce identity as text.
  const characterDescs: Array<{ name: string; description: string }> = []
  for (const id of cfg.anchor_character_ids) {
    try {
      const ch = await getCharacter(job.project_slug, id)
      const name = (ch as any)?.name || id
      const desc = typeof (ch as any)?.description === 'string' ? (ch as any).description.trim() : ''
      if (desc) characterDescs.push({ name, description: desc })
    } catch { /* skip a missing/corrupt character */ }
  }

  // v1.0.243 — compose the final render prompt: [scene action/setting from the
  // planner] + [anchor character descriptors] + [Style Bible]. Sections are
  // omitted when empty, so a project with none of the extras renders exactly
  // the bare visual_prompt as before.
  const charText = characterDescs.length
    ? characterDescs.map(c => `${c.name}: ${c.description}`).join('; ')
    : ''
  const styleBible = cfg.style_bible?.trim() || ''
  // v1.0.336 — non-character scenes (event / map / artifact / environment) drop
  // the guide's descriptor text so the prompt describes ONLY the subject. Plans
  // with no scene_type behave as before (the guide everywhere).
  const isCharacterScene = (s: ScenePlanEntry): boolean => !s.scene_type || s.scene_type === 'character'
  const NONCHARACTER_NEGATIVE = 'person, people, child, boy, kid, human figure, character, portrait'
  const composePrompt = (visualPrompt: string, includeCharacter = true): string => {
    const parts = [visualPrompt.trim()]
    if (includeCharacter && charText) parts.push(`Character details — ${charText}.`)
    if (styleBible) parts.push(`Style: ${styleBible}`)
    return parts.join('\n\n')
  }
  if (charText || styleBible || cfg.negative_prompt) {
    job.output_lines.push(
      `Prompt layer: ${[charText && 'character text', styleBible && 'style bible', cfg.negative_prompt && 'negative prompt'].filter(Boolean).join(' + ')}.`,
    )
  }

  // v1.0.457 — unified scene-image location (named "NN Scene Images" folder),
  // shared with the Scene Generator + media-root-aware.
  const outDir = await resolveSceneImagesDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })

  // Resume only from images that fully decode. A non-empty but truncated file
  // must re-enter the missing-scene scope; otherwise every Retry keeps
  // skipping the same corrupt asset and Video Assembly fails later.
  const usableRenderedIds = new Set<string>()
  for (const scene of scenes) {
    const candidates = [path.join(outDir, `${scene.id}.png`)]
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      if (await isDecodableImage(candidate)) {
        usableRenderedIds.add(scene.id)
        break
      }
      job.output_lines.push(`Scene ${scene.scene_index} (${scene.id}) has a corrupt image; it will be regenerated.`)
    }
  }
  const hasRenderedImage = (id: string): boolean => usableRenderedIds.has(id)

  const aspectRatio = params.aspect_ratio || '16:9'
  const renderWidth = typeof params.width === 'number' && params.width > 0 ? params.width : undefined
  const renderHeight = typeof params.height === 'number' && params.height > 0 ? params.height : undefined
  if (renderWidth && renderHeight) {
    job.output_lines.push(`Requested render size: ${renderWidth}×${renderHeight}.`)
  }
  const force = params.force === true
  // Render exactly one stable scene ID when requested.
  let singleIndex = 0
  if (params.single_scene_id) {
    const one = scenes.find(s => s.id === params.single_scene_id)
    if (one) singleIndex = one.scene_index
    else throw new Error(`single_scene_id ${params.single_scene_id} not found in scene_plan.json`)
  }
  const mode = params.missing_only === true
    ? 'missing-only repair (skip recovered)'
    : singleIndex > 0
      ? `single scene ${singleIndex}`
      : force
        ? 'force re-render'
        : 'resume (skip existing)'

  const failedSceneIds: string[] = []
  const successfulSceneIds = new Set<string>()

  // Live status sidecar — written before each render, cleared when the job ends.
  // Serialise writes so concurrent batch workers never interleave partial JSON.
  const statusPath = path.join(paths.episode_dir, RENDER_STATUS_FILENAME)
  let statusChain: Promise<void> = Promise.resolve()
  const writeStatus = (s: Record<string, unknown>): Promise<void> => {
    statusChain = statusChain.then(async () => {
      try { await fs.writeFile(statusPath, JSON.stringify(s, null, 2), 'utf-8') } catch { /* best-effort */ }
    })
    return statusChain
  }

  // Persist a rendered image_path back to scene_plan.json. Serialised through a
  // promise chain so concurrent workers cannot clobber the shared plan file.
  let planChain: Promise<void> = Promise.resolve()
  const persistImagePath = (sceneId: string, outPath: string, renderedPrompt: string): Promise<void> => {
    const operation = planChain.catch(() => {}).then(async () => {
      await checkpointSceneImage(planPath, sceneId, outPath, renderedPrompt, params.auto_approve_generated === true)
    })
    planChain = operation.catch(() => {})
    return operation
  }

  const buildScenePromptContext = (scene: ScenePlanEntry): {
    params: typeof providerParams
    includeCharacter: boolean
  } => {
    const isChar = isCharacterScene(scene)
    const params = isChar
      ? providerParams
      : { ...providerParams, negative_prompt: [(providerParams as any).negative_prompt, NONCHARACTER_NEGATIVE].filter(Boolean).join(', ') }
    return { params, includeCharacter: isChar }
  }

  const concurrency = resolveGenStudioLocalFanout(scenes.length)

  // GenStudio-owned text-to-image batch.
    const toRender = selectSceneImageBatch(scenes, {
      sceneIds: params.scene_ids,
      missingOnly: params.missing_only,
      singleIndex,
      force,
      hasRenderedImage,
    })
    const skipped = scenes.length - toRender.length

    job.output_lines.push(
      `GenStudio image batch — ${imageProvider.meta.name} / ${model} · ` +
      `${toRender.length}/${scenes.length} scene(s) · ${mode}. ` +
      'GenStudio controls account concurrency and execution.',
    )

    const inFlight = new Set<number>()
    let done = 0
    const pushStatus = () => writeStatus({
      active: true,
      mode: 'batch',
      provider: imageProvider.meta.name,
      model,
      total: scenes.length,
      to_render: toRender.length,
      rendered_so_far: done,
      in_flight: [...inFlight].sort((a, b) => a - b),
      updated_at: new Date().toISOString(),
    })

    const taskManifest = await readManifest(outDir)
    const fallbackTargets = toRender.filter(scene => !successfulSceneIds.has(scene.id))
    try {
      let idx = 0
      let active = 0
      let finishAll!: () => void
      const allWorkersDone = new Promise<void>((res) => { finishAll = res })
      // Resolve once all work is claimed (or the job is cancelled) AND every
      // worker has drained — so a cancelled run can't hang waiting on workers.
      const maybeFinish = () => {
        if ((idx >= fallbackTargets.length || jq.isCancelled(job.job_id)) && active === 0) finishAll()
      }
      const worker = async (): Promise<void> => {
        active++
        try {
        while (idx < fallbackTargets.length) {
          if (jq.isCancelled(job.job_id)) return
          const scene = fallbackTargets[idx++]!
          const outPath = path.join(outDir, `${scene.id}.png`)
          const sref = buildScenePromptContext(scene)
          const finalPrompt = composePrompt(scene.visual_prompt, sref.includeCharacter)
          inFlight.add(scene.scene_index)
          await pushStatus()
          try {
            const filename = `${scene.id}.png`
            const requestScope = force
              ? (params.render_attempt_id || job.job_id)
              : 'missing'
            const expectedInputHash = hashInput(`${requestScope}\n${finalPrompt}`)
            const manifestEntry = taskManifest.tasks[filename] || null
            const recoverable = manifestEntry?.input_hash === expectedInputHash ? manifestEntry : null
            const recovered = await tryRecoverImageFromManifest(
              recoverable,
              apiKey,
              modelConfig,
              () => jq.isCancelled(job.job_id),
            )
            const result = recovered
              ? { urls: recovered.urls, taskId: recovered.taskId }
              : await imageProvider.generateImage({
                prompt: finalPrompt,
                apiKey,
                aspectRatio,
                modelId: modelConfig.api_model || model,
                providerParams: sref.params,
                width: renderWidth,
                height: renderHeight,
                steps: params.image_steps,
                seed: params.seed,
                idempotencyIdentity: `${job.project_slug}:${episode_id}:scene:${scene.id}:image:${requestScope}`,
                isCancelled: () => jq.isCancelled(job.job_id),
                onJobAccepted: async (taskId) => {
                  await recordTask(outDir, filename, {
                    provider: imageProvider.meta.providerId || imageProvider.meta.id,
                    task_id: taskId,
                    submitted_at: new Date().toISOString(),
                    input_hash: expectedInputHash,
                  })
                },
                onReconnect: (taskId) => {
                  job.output_lines.push(
                    `Scene ${scene.scene_index}: reconnecting accepted GenStudio task ${taskId.slice(0, 12)}…`,
                  )
                },
              })
            if (!result.urls.length) throw new Error('GenStudio KH returned no image')
            if (result.taskId) {
              await recordTask(outDir, filename, {
                provider: imageProvider.meta.providerId || imageProvider.meta.id,
                task_id: result.taskId,
                submitted_at: new Date().toISOString(),
                input_hash: expectedInputHash,
              })
            }
            await saveGenStudioImage(result.urls[0]!, outPath)
            await persistImagePath(scene.id, outPath, scene.visual_prompt)
            successfulSceneIds.add(scene.id)
            job.output_lines.push(
              `Scene ${scene.scene_index}/${scenes.length} (${scene.id}) ✓` +
              `${recovered ? ` — recovered task ${recovered.taskId.slice(0, 12)}…` : ''}`,
            )
          } catch (e: any) {
            // One failed scene does not block the rest of the durable batch.
            failedSceneIds.push(scene.id)
            job.output_lines.push(`Scene ${scene.scene_index} failed: ${e?.message || e}`)
          } finally {
            inFlight.delete(scene.scene_index)
            done++
            job.progress = Math.round((done / Math.max(1, toRender.length)) * 100)
            await pushStatus()
          }
        }
        } finally { active--; maybeFinish() }
      }

      // Stage enough work to keep the account busy. The shared GenStudio
      // admission pool—not this worker count—enforces live account capacity,
      // submission rate, and queue headroom.
      const maxWorkers = concurrency
      const ensureWorkers = () => {
        if (idx >= fallbackTargets.length || jq.isCancelled(job.job_id)) return
        const want = Math.min(maxWorkers, fallbackTargets.length - idx + active)
        while (active < want) void worker()
      }
      ensureWorkers()
      maybeFinish()  // nothing to render → resolve immediately

      await allWorkersDone
    } finally {
      await writeStatus({ active: false, updated_at: new Date().toISOString() })
    }

    job.output_dir = outDir
    job.progress = 100
    const mediaAudit = await auditSceneImageCompletion(planPath, toRender.map(scene => scene.id), [outDir])
    const invalid = new Set<string>(mediaAudit.invalid)
    for (const sceneId of failedSceneIds) invalid.add(sceneId)
    for (const scene of toRender) if (!successfulSceneIds.has(scene.id)) invalid.add(scene.id)
    const unresolved = new Set(mediaAudit.missing)
    for (const item of invalid) unresolved.add(item.replace(/ \(.+\)$/, ''))
    if (unresolved.size > 0) {
      job.params.scene_ids = toRender.filter(scene => unresolved.has(scene.id)).map(scene => scene.id)
      // The scope is already narrowed to failed IDs. Do not let an older image
      // suppress a failed explicit re-render on the next attempt.
      job.params.missing_only = false
    }
    requireJobCompletion(job, {
      label: 'Scene image generation', expected: toRender.length,
      completed: toRender.length - unresolved.size,
      missing: mediaAudit.missing,
      invalid: [...invalid],
      retry_hint: 'Successful images were saved; Retry resumes with only missing scenes.',
    })
    job.output_lines.push(`Done — ${toRender.length}/${toRender.length} target scene(s) verified; ${skipped} skipped.`)
    return
}
