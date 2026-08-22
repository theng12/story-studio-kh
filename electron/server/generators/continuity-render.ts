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
import { recordTask, recordTaskStrict, hashInput, readManifest, type TaskManifestEntry } from '../services/task-manifest.js'
import { getCharacter } from '../services/character-manager.js'
import { resolveSceneImagesDir } from './scene-image.js'
import type { Job, ScenePlan, ScenePlanEntry } from '../models/types.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { resolveStyleBible } from '../lib/style-bible.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { auditSceneImageCompletion, checkpointSceneImage } from '../services/scene-media-checkpoint.js'
import { selectSceneImageBatch } from '../services/scene-image-batch-selection.js'
import { resolveConfiguredAspectRatio, resolveConfiguredOutputOption, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { getApiKey } from '../services/app-secrets-store.js'
import {
  isTerminalGenStudioImageTaskFailure,
  resolveImageRetryScope,
  terminalImageManifestEntry,
  tryRecoverImageFromManifestEntry,
} from '../lib/manifest-recovery.js'
import { GenStudioImageTerminalFailureError, isGenStudioInsufficientCredits } from '../lib/genstudio-client.js'
import { checkpointGenStudioAsset } from '../services/genstudio-recovery.js'
import { resolveGenStudioLocalFanout } from '../lib/genstudio-runtime.js'
import { deactivateSceneRenderStatus, RENDER_STATUS_FILENAME, writeSceneRenderStatus } from '../services/scene-render-status.js'
import { FLEET_BUSY_RETRY_DELAYS_MS, isFleetBusyFailure } from '../lib/genstudio-fleet-busy.js'

interface ContinuityRenderParams {
  episode_id: string
  title?: string
  model: string
  aspect_ratio?: string
  /** Resolution label of the chosen published `output_options[]` row. */
  resolution?: string
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
  /** Optional reproducible seed. */
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

/** One scheduled re-ask for a scene, or `null` to fail it exactly as before. */
export interface ContinuityFleetBusyPlan {
  waitMs: number
  reason: string
  maxAttempts: number
}

/**
 * v1.4.27 — the ONE Scene Review failure worth asking again about: GenStudio
 * had no free MACHINE for the job.
 *
 * WHY HERE, AND WHY NOW. Every image in this app is fleet-placed, and Scene
 * Review is the batch that drives the volume — 7,419 image attempts in thirty
 * days across the app. It has simply not met a saturated fleet yet. The two
 * operations that did both lost work silently: transcription dropped 122 of
 * 353 items in a single burst, and TTS dropped 5 over three days that nobody
 * noticed for nine, because the only symptom is a missing asset a later manual
 * retry quietly fills in. A 333-scene render meeting the same wall would lose
 * scenes the same silent way, and the owner would be told to re-run by hand.
 *
 * WHY RESUBMITTING IS FREE. GenStudio raises this code from one place, having
 * already held the job in a fifteen-minute placement window, and says there
 * what became of the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so another attempt is a
 * fresh charge for work that never happened — not a second charge for the same
 * work. That argument does not extend one inch further. Every other terminal
 * code may describe work a provider already performed, returns `null` here,
 * and fails the scene exactly as it does today rather than being paid for
 * twice. A "Repair & Retry all" button was removed in v1.0.114 for precisely
 * that, which is why what this function REFUSES matters more than what it
 * allows. Note in particular that it does not adopt the seconds-long
 * declined-route retry `generators/images.ts` also carries: Scene Review has
 * never had one, and widening the fleet fix into a second behaviour change is
 * not this change's business.
 *
 * The waits are the shared minutes-long schedule, bounded by its own length,
 * because a two-second retry after a fifteen-minute placement window just
 * rejoins the same jam and burns the attempt.
 *
 * Exported as a pure function so the decision is testable on its own, without
 * driving a 333-scene batch against a saturated fleet to observe it.
 *
 * @param attemptNum the 1-based attempt that just failed.
 */
export function continuityFleetBusyRetryPlan(e: unknown, attemptNum: number): ContinuityFleetBusyPlan | null {
  // The modality matters: a busy TTS queue says nothing about whether THIS
  // image's credits came back.
  if (!isFleetBusyFailure(e, 'image')) return null
  const waitMs: number | undefined = FLEET_BUSY_RETRY_DELAYS_MS[attemptNum - 1]
  if (waitMs === undefined) return null
  return { waitMs, reason: 'Every machine was busy', maxAttempts: FLEET_BUSY_RETRY_DELAYS_MS.length + 1 }
}

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
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add the GenStudio API key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, model, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)
  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${model}" is not routed through GenStudio KH.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('GenStudio KH image provider is unavailable.')

  // v1.4.11 — the stored `cfg.negative_prompt` is no longer copied in here.
  // *"we are never using negative prompts at all. so don't include it
  // anyways."* It was also going nowhere: the GenStudio image provider builds
  // its request field by field (providers/image/genstudio.ts) and never reads
  // `providerParams` for content, so anything put here was dropped before the
  // request was sent. The value stays in continuity.json — a stored setting is
  // not this generator's to delete — it simply is not sent.
  const providerParams = { ...((modelConfig as any).provider_params || {}) }

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
  // v1.0.795 — the Style Bible has two tiers: this episode's continuity.json,
  // else the project's standing default (config.json `default_style_bible`).
  // Resolved through the SAME helper the planner uses (lib/style-bible.ts) so
  // the text baked into each visual_prompt at plan time and the text appended
  // here at render time can never be two different looks. A project with no
  // default and an episode with no Style Bible resolves to '' exactly as before.
  const resolvedStyle = await resolveStyleBible({ slug: job.project_slug, episodeDir: paths.episode_dir })
  const styleBible = resolvedStyle.text
  // v1.0.336 — non-character scenes (event / map / artifact / environment) drop
  // the guide's descriptor text so the prompt describes ONLY the subject. Plans
  // with no scene_type behave as before (the guide everywhere).
  const isCharacterScene = (s: ScenePlanEntry): boolean => !s.scene_type || s.scene_type === 'character'
  const composePrompt = (visualPrompt: string, includeCharacter = true): string => {
    const parts = [visualPrompt.trim()]
    if (includeCharacter && charText) parts.push(`Character details — ${charText}.`)
    if (styleBible) parts.push(`Style: ${styleBible}`)
    return parts.join('\n\n')
  }
  // The log names only layers that are actually in the prompt. It used to add
  // "+ negative prompt", which told him something had been applied when nothing
  // had been sent.
  if (charText || styleBible) {
    const styleLabel = resolvedStyle.source === 'project' ? 'style bible (project default)' : 'style bible'
    job.output_lines.push(
      `Prompt layer: ${[charText && 'character text', styleBible && styleLabel].filter(Boolean).join(' + ')}.`,
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

  const aspectRatio = resolveConfiguredAspectRatio(modelConfig, params.aspect_ratio)
  // Validated once for the whole render, before the first charged submit.
  const outputOption = resolveConfiguredOutputOption(modelConfig, aspectRatio, params.resolution)
  const renderWidth = typeof params.width === 'number' && params.width > 0 ? params.width : undefined
  const renderHeight = typeof params.height === 'number' && params.height > 0 ? params.height : undefined
  if (outputOption) {
    job.output_lines.push(
      `Output: ${outputOption.resolution} ${outputOption.aspect_ratio} — ${outputOption.width}×${outputOption.height}px per scene.`,
    )
  } else if (renderWidth && renderHeight) {
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
  const cancelledSceneIds = new Set<string>()
  const successfulSceneIds = new Set<string>()

  // Live status sidecar — shared serialization prevents terminal cleanup from
  // overwriting a newer render marker after it has checked ownership.
  const statusPath = path.join(paths.episode_dir, RENDER_STATUS_FILENAME)
  const writeStatus = async (s: Record<string, unknown>): Promise<void> => {
    try { await writeSceneRenderStatus(statusPath, s) } catch { /* display-only best effort */ }
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

  /**
   * v1.4.11 — a non-character scene drops the guide's descriptors and its
   * reference images, and that is now the ONLY thing keeping the anchored
   * character out of a cutaway.
   *
   * It used to also append a hardcoded negative prompt — `person, people,
   * child, boy, kid, human figure, character, portrait` — to every event, map,
   * environment and artifact scene. The owner's ruling: *"we are never using
   * negative prompts at all. so don't include it anyways."* It was overreach
   * besides: the intent in v1.0.336 was "not the GUIDE character", and what it
   * actually said was "no humans", so a battle, a market or a coronation typed
   * as `event` was rendered with every person banned from the frame. Dropping
   * the reference stack is the part that was doing the real work.
   */
  const buildScenePromptContext = (scene: ScenePlanEntry): {
    params: typeof providerParams
    includeCharacter: boolean
  } => ({ params: providerParams, includeCharacter: isCharacterScene(scene) })

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
    // Scenes deliberately sitting out a busy-fleet wait. Nothing is happening
    // and nothing is wrong — the one case a bare spinner misreports as a hang.
    const fleetWaiting = new Map<number, { attempt: number; maxAttempts: number; retryAt: string; reason: string }>()
    const syncItemProgress = () => {
      const completed = usableRenderedIds.size
      const settling = inFlight.size
      const failed = failedSceneIds.length
      const customerCancelled = cancelledSceneIds.size
      job.progress = Math.round((completed / Math.max(1, scenes.length)) * 100)
      job.item_progress = {
        total: scenes.length,
        completed,
        failed,
        settling,
        cancelled: customerCancelled,
        not_submitted: Math.max(0, scenes.length - completed - settling - failed - customerCancelled),
        concurrency,
        active: [...inFlight].sort((a, b) => a - b).map(sceneIndex => {
          const waiting = fleetWaiting.get(sceneIndex)
          return {
            label: `Scene ${sceneIndex}`,
            key: `scene-${sceneIndex}`,
            state: waiting ? 'waiting_retry' as const : 'running' as const,
            attempt: waiting?.attempt ?? 1,
            max_attempts: waiting?.maxAttempts ?? 1,
            ...(waiting ? { retry_at: waiting.retryAt, reason: waiting.reason } : {}),
          }
        }),
      }
    }
    const pushStatus = () => writeStatus({
      active: true,
      job_id: job.job_id,
      mode: 'batch',
      provider: imageProvider.meta.name,
      model,
      total: scenes.length,
      to_render: toRender.length,
      rendered_so_far: usableRenderedIds.size,
      in_flight: [...inFlight].sort((a, b) => a - b),
      updated_at: new Date().toISOString(),
    })

    const taskManifest = await readManifest(outDir)
    const fallbackTargets = toRender.filter(scene => !successfulSceneIds.has(scene.id))
    syncItemProgress()
    let lastCompletedAt = Date.now()
    let stallPauseRequested = false
    /**
     * Sleep before re-asking a busy fleet — in short slices, so a Cancel or a
     * Pause pressed during a five-minute wait is honoured within seconds
     * instead of at the end of it.
     */
    const waitForFleetCapacity = async (ms: number): Promise<void> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)) return
        await new Promise(resolve => setTimeout(resolve, Math.min(2_000, deadline - Date.now())))
      }
    }
    const stallTimer = setInterval(() => {
      if (stallPauseRequested || inFlight.size === 0 || jq.isPauseRequested(job.job_id)) return
      // A scene waiting out a busy fleet is not a stall: we know exactly why
      // nothing is completing, said so in the output, and the waits are
      // bounded. Pausing the job here would cancel the very retry that fixes it.
      if (fleetWaiting.size > 0) return
      if (Date.now() - lastCompletedAt < 10 * 60_000) return
      stallPauseRequested = true
      void jq.pauseJobForStall(job.job_id, 'No scene image completed for 10 minutes while provider work was active.')
    }, 30_000)
    stallTimer.unref()
    try {
      let idx = 0
      let active = 0
      let fatalError: unknown
      let finishAll!: () => void
      const allWorkersDone = new Promise<void>((res) => { finishAll = res })
      // Resolve once all work is claimed (or the job is cancelled) AND every
      // worker has drained — so a cancelled run can't hang waiting on workers.
      const maybeFinish = () => {
        if ((fatalError || idx >= fallbackTargets.length || jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)) && active === 0) finishAll()
      }
      const worker = async (): Promise<void> => {
        active++
        try {
        while (idx < fallbackTargets.length) {
          if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id) || fatalError) return
          const scene = fallbackTargets[idx++]!
          const outPath = path.join(outDir, `${scene.id}.png`)
          const sref = buildScenePromptContext(scene)
          const finalPrompt = composePrompt(scene.visual_prompt, sref.includeCharacter)
          const filename = `${scene.id}.png`
          const providerId = imageProvider.meta.providerId || imageProvider.meta.id
          // v1.4.27 — attempts for THIS scene. Only a busy fleet earns another
          // one; every other outcome, good or bad, leaves the loop on the first
          // pass. `savedEntry` is the manifest entry the NEXT attempt reasons
          // from: the run-start snapshot to begin with, then whatever the
          // attempt that just failed actually wrote to disk.
          let savedEntry: TaskManifestEntry | null = taskManifest.tasks[filename] || null
          let attemptNum = 1
          for (;;) {
            // Cancel and Pause are re-read at the top of EVERY attempt, not
            // just every scene: a resubmission must never start after the owner
            // has already stopped the run.
            if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id) || fatalError) return
            inFlight.add(scene.scene_index)
            syncItemProgress()
            await pushStatus()
            // Captured so the failure path can record WHICH GenStudio job died.
            let acceptedTaskId = ''
            let acceptedIdempotencyKey = ''
            let attemptScope = ''
            let attemptHash = ''
            try {
              // The base scope names the deliberate user action. A force re-render
              // owns a fresh one; an ordinary resume/repair deliberately reuses
              // 'missing' so a still-usable saved job is reclaimed for free.
              const baseScope = force
                ? (params.render_attempt_id || job.job_id)
                : 'missing'
              const manifestEntry = savedEntry
              // A terminal saved job promotes the scope to a NEW retry identity,
              // derived deterministically from the dead job id — never a clock.
              const retryScope = resolveImageRetryScope(manifestEntry, baseScope)
              let requestScope = retryScope.scope
              const expectedInputHash = hashInput(`${requestScope}\n${finalPrompt}`)
              // Reconnect ONLY to a saved job that belongs to this exact request
              // AND has not already settled. Hash equality alone once let a
              // six-day-old failed job satisfy every future Retry.
              const hashMatches = manifestEntry?.input_hash === expectedInputHash
              const recoverable = hashMatches && !isTerminalGenStudioImageTaskFailure(manifestEntry)
                ? manifestEntry
                : null
              const recovery = await tryRecoverImageFromManifestEntry(
                recoverable,
                apiKey,
                modelConfig,
                () => jq.isCancelled(job.job_id),
              )
              if (recovery.kind === 'uncertain') {
                // Never turn "I could not confirm the outcome" into a second paid
                // submission. Fail this scene; Retry reconnects to the same job.
                throw new Error(
                  `Could not confirm GenStudio task ${recovery.taskId.slice(0, 12)}… (${recovery.reason}). ` +
                  'No duplicate image was submitted; Retry reconnects to the same job.',
                )
              }
              let carried: TaskManifestEntry | null = manifestEntry
              if (recovery.kind === 'terminal-failed' || recovery.kind === 'artifact-unavailable') {
                // GenStudio just told us the saved job settled. Persist that
                // outcome FIRST, then promote to a fresh identity from it, so the
                // same retry scope is reproducible after a crash.
                carried = terminalImageManifestEntry(manifestEntry!, recovery)
                await recordTask(outDir, filename, carried)
                requestScope = resolveImageRetryScope(carried, baseScope).scope
                job.output_lines.push(
                  `Scene ${scene.scene_index}: saved GenStudio task ${recovery.taskId.slice(0, 12)}… is terminal ` +
                  `(${recovery.kind === 'artifact-unavailable' ? 'artifact expired' : 'failed'}); ` +
                  'submitting one fresh job under a new retry identity.',
                )
              }
              const inputHash = requestScope === retryScope.scope
                ? expectedInputHash
                : hashInput(`${requestScope}\n${finalPrompt}`)
              attemptScope = requestScope
              attemptHash = inputHash
              // Reuse the prepared entry's timestamp so a replayed submission
              // keeps one submitted_at instead of drifting forward each attempt.
              const sameScope = carried?.request_scope === requestScope ? carried : null
              const submittedAt = sameScope?.submitted_at || new Date().toISOString()

              let result: { urls: string[]; taskId?: string }
              if (recovery.kind === 'recovered') {
                result = { urls: recovery.urls, taskId: recovery.taskId }
                await recordTask(outDir, filename, {
                  provider: providerId,
                  task_id: recovery.taskId,
                  submitted_at: submittedAt,
                  input_hash: inputHash,
                  request_scope: requestScope,
                  operation: 'image',
                  last_state: 'succeeded',
                })
              } else {
                // Persist the request identity BEFORE the POST. If the response is
                // lost, the next attempt reads this scope back, rebuilds the same
                // idempotency key, and re-attaches instead of paying twice.
                await recordTaskStrict(outDir, filename, {
                  provider: providerId,
                  task_id: '',
                  submitted_at: submittedAt,
                  input_hash: inputHash,
                  request_scope: requestScope,
                  operation: 'image',
                  last_state: 'prepared',
                })
                // Pause is distinct from cancellation: recovery GETs above are
                // allowed to finish, but no new paid POST may cross this point.
                jq.throwIfPauseRequested(job.job_id)
                result = await imageProvider.generateImage({
                  prompt: finalPrompt,
                  apiKey,
                  aspectRatio,
                  modelId: modelConfig.api_model || model,
                  providerParams: sref.params,
                  ...(outputOption
                    ? { resolution: outputOption.resolution }
                    : { width: renderWidth, height: renderHeight }),
                  seed: params.seed,
                  idempotencyIdentity: `${job.project_slug}:${episode_id}:scene:${scene.id}:image:${requestScope}`,
                  isCancelled: () => jq.isCancelled(job.job_id),
                  onJobAccepted: async (taskId, idempotencyKey) => {
                    acceptedTaskId = taskId
                    acceptedIdempotencyKey = idempotencyKey
                    await recordTaskStrict(outDir, filename, {
                      provider: providerId,
                      task_id: taskId,
                      submitted_at: submittedAt,
                      input_hash: inputHash,
                      request_scope: requestScope,
                      idempotency_key: idempotencyKey,
                      operation: 'image',
                      last_state: 'accepted',
                    })
                    await checkpointGenStudioAsset(job, filename, {
                      operation: 'image',
                      idempotency_key: idempotencyKey,
                      job_id: taskId,
                      state: 'accepted',
                    })
                  },
                  onReconnect: (taskId) => {
                    job.output_lines.push(
                      `Scene ${scene.scene_index}: reconnecting accepted GenStudio task ${taskId.slice(0, 12)}…`,
                    )
                  },
                })
                if (result.taskId) {
                  await recordTask(outDir, filename, {
                    provider: providerId,
                    task_id: result.taskId,
                    submitted_at: submittedAt,
                    input_hash: inputHash,
                    request_scope: requestScope,
                    ...(acceptedIdempotencyKey ? { idempotency_key: acceptedIdempotencyKey } : {}),
                    operation: 'image',
                    last_state: 'succeeded',
                  })
                }
              }
              if (!result.urls.length) throw new Error('GenStudio KH returned no image')
              await saveGenStudioImage(result.urls[0]!, outPath)
              await persistImagePath(scene.id, outPath, scene.visual_prompt)
              successfulSceneIds.add(scene.id)
              usableRenderedIds.add(scene.id)
              lastCompletedAt = Date.now()
              job.output_lines.push(
                `Scene ${scene.scene_index}/${scenes.length} (${scene.id}) ✓` +
                `${recovery.kind === 'recovered' ? ` — recovered task ${recovery.taskId.slice(0, 12)}… (no charge)` : ''}`,
              )
              break
            } catch (e: any) {
              if (e instanceof jq.JobPausedError || jq.isPauseRequested(job.job_id)) return
              if (isGenStudioInsufficientCredits(e)) {
                fatalError = e
                return
              }
              if (e instanceof GenStudioImageTerminalFailureError) {
                const failedTaskId = e.jobId || acceptedTaskId
                // Record a settled provider failure locally. Without this the next
                // Retry has no way to know the saved job can never succeed.
                const failedEntry: TaskManifestEntry = {
                  provider: providerId,
                  task_id: failedTaskId,
                  submitted_at: new Date().toISOString(),
                  input_hash: attemptHash,
                  request_scope: attemptScope,
                  ...(acceptedIdempotencyKey ? { idempotency_key: acceptedIdempotencyKey } : {}),
                  operation: 'image',
                  last_state: 'failed',
                }
                await recordTask(outDir, filename, failedEntry)
                await checkpointGenStudioAsset(job, filename, {
                  operation: 'image',
                  idempotency_key: acceptedIdempotencyKey || `story-image-${scene.id}`,
                  job_id: failedTaskId,
                  state: 'failed',
                })
                if (e.cancelled) cancelledSceneIds.add(scene.id)
                // ── "Every machine was busy" — wait, then ask again ──
                // The only failure this generator resubmits; see
                // `continuityFleetBusyRetryPlan` for why it costs nothing and
                // why nothing else qualifies. A task id is required because the
                // next identity is DERIVED from the dead job id: without one the
                // scope cannot be promoted, and the retry would replay a
                // settled-failed key, which returns the same failure forever.
                const plan = continuityFleetBusyRetryPlan(e, attemptNum)
                if (plan && failedTaskId && !jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {
                  fleetWaiting.set(scene.scene_index, {
                    attempt: attemptNum,
                    maxAttempts: plan.maxAttempts,
                    retryAt: new Date(Date.now() + plan.waitMs).toISOString(),
                    reason: plan.reason,
                  })
                  syncItemProgress()
                  job.output_lines.push(
                    `Scene ${scene.scene_index}: ${plan.reason.toLowerCase()} — nothing was charged. ` +
                    `Waiting ${Math.round(plan.waitMs / 1000)}s and trying again ` +
                    `(attempt ${attemptNum + 1} of ${plan.maxAttempts}).`,
                  )
                  // The failed entry is already on disk, so the scope the next
                  // attempt derives from it is reproducible after a crash
                  // mid-wait: a replayed retry re-attaches to the job GenStudio
                  // already has instead of buying a second render.
                  savedEntry = failedEntry
                  try {
                    await waitForFleetCapacity(plan.waitMs)
                  } finally {
                    fleetWaiting.delete(scene.scene_index)
                  }
                  // Re-read after the wait. Minutes passed, and a Cancel or a
                  // Pause pressed during them is the owner's last word.
                  if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)) return
                  attemptNum++
                  continue
                }
              }
              // One failed scene does not block the rest of the durable batch.
              if (!cancelledSceneIds.has(scene.id)) {
                failedSceneIds.push(scene.id)
                job.output_lines.push(`Scene ${scene.scene_index} failed: ${e?.message || e}`)
              } else {
                job.output_lines.push(`Scene ${scene.scene_index} cancelled by customer; GenStudio settlement is preserved and this is not counted as a provider failure.`)
              }
              break
            } finally {
              inFlight.delete(scene.scene_index)
              syncItemProgress()
              await pushStatus()
              await jq.checkpointJobState(job)
            }
          }
        }
        } finally { active--; maybeFinish() }
      }

      // Stage enough work to keep the account busy. The shared GenStudio
      // admission pool—not this worker count—enforces live account capacity,
      // submission rate, and queue headroom.
      const maxWorkers = concurrency
      const ensureWorkers = () => {
        if (idx >= fallbackTargets.length || jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id) || fatalError) return
        const want = Math.min(maxWorkers, fallbackTargets.length - idx + active)
        while (active < want) void worker()
      }
      ensureWorkers()
      maybeFinish()  // nothing to render → resolve immediately

      await allWorkersDone
      if (fatalError) throw fatalError
    } finally {
      clearInterval(stallTimer)
      await deactivateSceneRenderStatus(job.project_slug, episode_id, job.job_id).catch(() => {})
    }

    job.output_dir = outDir
    syncItemProgress()
    const mediaAudit = await auditSceneImageCompletion(planPath, toRender.map(scene => scene.id), [outDir])
    // One scene can reach this audit from three directions (media audit, the
    // per-scene failure list, and the "never succeeded" sweep). Key everything
    // by the bare scene ID so the error message names each scene exactly once,
    // preferring the audit's annotated form ("id (reason)") when it exists.
    const bareId = (item: string): string => item.replace(/ \(.+\)$/, '')
    const missingIds = new Set(mediaAudit.missing.map(bareId))
    const invalidById = new Map<string, string>()
    for (const item of mediaAudit.invalid) invalidById.set(bareId(item), item)
    for (const sceneId of failedSceneIds) {
      if (!missingIds.has(sceneId) && !invalidById.has(sceneId)) invalidById.set(sceneId, sceneId)
    }
    for (const scene of toRender) {
      if (successfulSceneIds.has(scene.id)) continue
      if (!missingIds.has(scene.id) && !invalidById.has(scene.id)) invalidById.set(scene.id, scene.id)
    }
    const invalid = [...invalidById.values()]
    const unresolved = new Set(missingIds)
    for (const item of invalid) unresolved.add(bareId(item))
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
      invalid,
      retry_hint: 'Successful images were saved; Retry resumes with only missing scenes.',
    })
    job.output_lines.push(`Done — ${toRender.length}/${toRender.length} target scene(s) verified; ${skipped} skipped.`)
    return
}
