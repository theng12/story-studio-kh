/**
 * Durable Scene Review image batch.
 *
 * Story Studio owns the verified scene list, per-image checkpoints, and retry
 * scope. GenStudio owns text-to-image admission, account concurrency, queueing,
 * and execution. No reference-chain or direct-provider mode exists here.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { FITTED_REFERENCE_DIRNAME, fitReferenceImage } from '../lib/reference-image-fit.js'
import { registry } from '../providers/registry.js'
import { stageGenStudioImage } from '../lib/genstudio-artifacts.js'
import { resolveOutputFormat } from '../services/generation-compression.js'
import { isDecodableImage } from '../lib/image-validation.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import {
  compareAndRecordImageTaskStrict,
  claimMissingImageTaskStrict,
  hashInput,
  promoteCurrentImageTaskArtifactStrict,
  readManifest,
  type TaskManifestEntry,
} from '../services/task-manifest.js'
import { getCharacter } from '../services/character-manager.js'
import { SCENE_IMAGES_SUBFOLDER, resolveSceneImagesDir } from './scene-image.js'
import type { Job, ScenePlan, ScenePlanEntry } from '../models/types.js'
import { awaitingApprovalLabel } from '../contracts/episode-step-jobs.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { resolveStyleBible } from '../lib/style-bible.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { auditSceneImageCompletion, checkpointSceneImage, countScenesAwaitingApproval } from '../services/scene-media-checkpoint.js'
import { selectSceneImageBatch } from '../services/scene-image-batch-selection.js'
import { resolveConfiguredAspectRatio, resolveConfiguredOutputOption, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { getApiKey } from '../services/app-secrets-store.js'
import {
  imageManifestIdentityHash,
  hasPipelineRepairImageAttempt,
  isTerminalGenStudioImageTaskFailure,
  resolveManualImageReplacement,
  resolveImageRetryScope,
  terminalImageManifestEntry,
  tryRecoverImageFromManifestEntry,
} from '../lib/manifest-recovery.js'
import { buildGenStudioImageIdempotencyKey, GenStudioImageTerminalFailureError, hasFullyReleasedZeroSettlement, isGenStudioInsufficientCredits, refreshGenStudioAdmission } from '../lib/genstudio-client.js'
import { checkpointGenStudioAsset } from '../services/genstudio-recovery.js'
import {
  assertReleasedZeroSettlementImageRetrySubmit,
  authoritativePaidImageSettledCredits,
  buildPaidImageOriginalIdentity,
  capturePaidImageReferenceIdentity,
  decidePaidImageReplacement,
  isReleasedZeroSettlementImageRetry,
  isRetryableZeroSettlementImageFailureCode,
  readPaidImageOriginalRequest,
  revalidatePaidImageOutputPath,
  type PaidImageOutputSelector,
} from '../services/image-paid-replacement.js'
import { resolveGenStudioLocalFanout } from '../lib/genstudio-runtime.js'
import { deactivateSceneRenderStatus, RENDER_STATUS_FILENAME, writeSceneRenderStatus } from '../services/scene-render-status.js'
import { fleetBusyRetryPlan, freeMacWaitLine, isFleetBusyFailure, isFreeMacPlan } from '../lib/genstudio-fleet-busy.js'
import { imageRouteRetryDelayMs } from '../services/image-route-retry.js'
import { isFreeFleetModelId } from '../contracts/provider-task-state.js'

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
  /** Server-stamped identity shared by one explicit fresh Pipeline action. */
  generation_action?: { id: string; kind: 'fresh' }
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
  /** Server-stamped authority for one explicit recovery-first customer action. */
  manual_image_finish?: {
    action_id: string
    replace_uncertain: boolean
    source_job_id?: string
    uncertain_scene_ids?: string[]
    uncertain_identity_hashes?: Record<string, string>
    expected_uncertain_identity_hashes?: Record<string, string>
    still_generating_scene_ids?: string[]
  }
  /** One upfront Pipeline repair authority, propagated unchanged through its chain. */
  pipeline_repair?: { action_id: string }
}

export function shouldPauseContinuityForStall(state: {
  stallPauseRequested: boolean
  inFlightCount: number
  pauseRequested: boolean
  fleetWaitingCount: number
  capacityWaitingCount: number
  elapsedMs: number
  freeFleet?: boolean
}): boolean {
  return !state.freeFleet
    && !state.stallPauseRequested
    && state.inFlightCount > 0
    && !state.pauseRequested
    && state.fleetWaitingCount === 0
    && state.capacityWaitingCount === 0
    && state.elapsedMs >= 10 * 60_000
}

interface ContinuityCfg {
  anchor_character_ids: string[]
  style_bible: string
  negative_prompt: string
  /**
   * The Character Sheet's one live reference switch ("Use episode anchor").
   *
   * Read as an OR of the two names the sidecar has carried, exactly as the
   * frontend's `normalizeContinuityConfig` reads it: the page writes
   * `use_episode_sheet` AND mirrors it into `references.sheet`, and older
   * episode files carry only the mirror. Reading one name would silently
   * ignore the customer's choice on whichever files carry the other.
   */
  use_episode_reference: boolean
}
function defaultCfg(): ContinuityCfg {
  return {
    anchor_character_ids: [],
    style_bible: '',
    negative_prompt: '',
    use_episode_reference: false,
  }
}

/**
 * The per-episode reference images this generator may attach, in the order it
 * prefers them. Exactly ONE is ever submitted.
 *
 * `composition.png` first: it is the explainer LAYOUT template that
 * `generators/composition-template.ts` renders for this episode, and it exists
 * only because somebody deliberately produced it for this purpose.
 * `master.png` is the image the customer uploads by hand into the same folder
 * from the Character Sheet, and is the fallback when no template was made.
 */
export const EPISODE_REFERENCE_DIRNAME = 'img2img-references'
export const EPISODE_REFERENCE_FILENAMES = ['composition.png', 'master.png'] as const

/** What one render batch decided to do about the episode reference. */
export interface EpisodeReferencePlan {
  /** The single reference to attach, or '' when this render stays text-only. */
  sourcePath: string
  /** A line for the job output whenever the switch was NOT honoured verbatim. */
  note: string
}

/**
 * Decide whether this render attaches the episode reference — and when it does
 * not, say why out loud.
 *
 * Pure, and exported, so the honest-degrade behaviour is provable without
 * driving a charged batch at a model that refuses references. The silence
 * case is deliberate and is exactly one: the switch is OFF, so there is
 * nothing to report. Every other "no reference was sent" outcome produces a
 * note, because a feature that quietly does nothing is indistinguishable from
 * a feature that is broken.
 *
 * @param availablePaths existing reference files, already in preference order.
 * @param maxReferences the model's PUBLISHED `max_reference_images`. FLUX.2
 *   Klein publishes 0 and must degrade to a text-only render, not fail.
 */
export function planEpisodeReference(input: {
  enabled: boolean
  availablePaths: string[]
  supportsReferences: boolean
  maxReferences: number
  modelName: string
}): EpisodeReferencePlan {
  if (!input.enabled) return { sourcePath: '', note: '' }
  const candidate = input.availablePaths[0]
  if (!candidate) {
    return {
      sourcePath: '',
      note: `Episode anchor is switched on, but no reference image exists at ${EPISODE_REFERENCE_DIRNAME}/ ` +
        `(${EPISODE_REFERENCE_FILENAMES.join(' or ')}). Rendering from the prompt text only.`,
    }
  }
  // Capability only, never price: a free model on the owner's Macs uses the anchor like a paid one.
  if (!input.supportsReferences || input.maxReferences < 1) {
    const reason = `publishes no reference-image support (max_reference_images: ${Math.max(0, input.maxReferences)})`
    return {
      sourcePath: '',
      note: `Episode anchor is switched on, but '${input.modelName}' ${reason}. ` +
        'Rendering from the prompt text only — choose a reference-capable model to use the anchor.',
    }
  }
  return { sourcePath: candidate, note: '' }
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
  return fleetBusyRetryPlan(e, 'image', attemptNum - 1)
}

/** The exact scene-image directory used by Continuity execution and recovery admission. */
export async function resolveContinuityRenderOutputDir(
  projectSlug: string,
  episodeId: string,
  episodeDir?: string,
): Promise<string> {
  const resolvedEpisodeDir = episodeDir || (await resolveEpisodePathsByCode(projectSlug, episodeId)).episode_dir
  return resolveSceneImagesDir(projectSlug, episodeId.toUpperCase(), resolvedEpisodeDir)
}

/** e.g. "Scene 65 couldn't be made after 3 tries: <reason>. Press Retry to try again." */
export function unresolvedSceneImagesMessage(
  job: Pick<Job, 'auto_retry'>,
  scenes: ReadonlyArray<{ id: string; scene_index: number }>,
  issues: ReadonlyArray<{ item_id: string; reason?: string }>,
): string {
  const tries = Math.max(1, job.auto_retry?.attempt || 1)
  const retriesLeft = Boolean(job.auto_retry?.eligible && tries < (job.auto_retry.max_attempts || 1))
  const shown = issues.slice(0, 5).map(issue => {
    const index = scenes.find(scene => scene.id === issue.item_id)?.scene_index
    const reason = (issue.reason || 'the image was not saved').trim().replace(/\.+$/, '')
    return `${index ? `Scene ${index}` : issue.item_id} couldn't be made after ${tries} ${tries === 1 ? 'try' : 'tries'}: ${reason}.`
  })
  return [
    `Scene images incomplete: ${scenes.length - issues.length} of ${scenes.length} made; finished images are saved.`,
    ...shown,
    issues.length > shown.length ? `${issues.length - shown.length} more scene(s) couldn't be made either.` : '',
    retriesLeft ? 'Story Studio will try again automatically.' : 'Press Retry to try again.',
  ].filter(Boolean).join(' ')
}

export async function runContinuityRenderJob(job: Job): Promise<jq.JobExecutorResult> {
  const params = job.params as ContinuityRenderParams
  const pipelineRepairActionId = params.pipeline_repair?.action_id
  const manualFinish = params.manual_image_finish || (pipelineRepairActionId
    ? { action_id: pipelineRepairActionId, replace_uncertain: false }
    : undefined)
  if (manualFinish && !params.manual_image_finish) params.manual_image_finish = manualFinish
  const { episode_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) {
    throw new Error(`No scene_plan.json at ${planPath}. Run Scene Plan first.`)
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id, { episodeDir: paths.episode_dir, audioDir: paths.audio_dir })
  const requestedIds = params.scene_ids?.length
    ? params.scene_ids
    : (params.single_scene_id ? [params.single_scene_id] : undefined)
  assertScenePromptsRenderable(plan.scenes, requestedIds)
  const scenes = [...plan.scenes].sort((a, b) => a.scene_index - b.scene_index)
  if (!scenes.length) throw new Error('scene_plan.json has no scenes.')
  if (params.scene_ids?.length) {
    const planIds = new Set(scenes.map(scene => scene.id))
    const unknownIds = [...new Set(params.scene_ids.filter(id => !planIds.has(id)))]
    if (unknownIds.length) {
      throw new Error(`Unknown scene ID(s) in the requested batch: ${unknownIds.join(', ')}. Refresh Scene Review and try again.`)
    }
  }

  // v1.4.72+ — the Character Sheet contributes text context AND, when the
  // customer switches it on, ONE reference image for every character scene.
  //
  // The comment that used to sit here said reference-image execution was
  // "intentionally absent until GenStudio publishes that capability". GenStudio
  // published it: ten of the eleven live image products accept references
  // (`max_reference_images` 1 or 8), the client already maps the capability,
  // and `providers/image/genstudio.ts` already uploads and submits them. The
  // only thing missing was this generator asking for it.
  let cfg = defaultCfg()
  const continuityPath = path.join(paths.episode_dir, 'continuity.json')
  if (existsSync(continuityPath)) {
    try {
      const raw = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
      cfg = {
        anchor_character_ids: Array.isArray(raw?.anchor_character_ids) ? raw.anchor_character_ids : [],
        style_bible: typeof raw?.style_bible === 'string' ? raw.style_bible.trim() : '',
        negative_prompt: typeof raw?.negative_prompt === 'string' ? raw.negative_prompt.trim() : '',
        use_episode_reference: raw?.use_episode_sheet === true
          || raw?.references?.sheet === true
          || raw?.references?.composition === true,
      }
    } catch { /* keep defaults */ }
  }

  // Resolve model + provider (mirrors the per-scene generator).
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add the Gateway API Key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, model, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)
  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${model}" is not routed through the Gateway.`)
  }
  // The owner's own Macs: nothing is charged, so paid-replacement safeguards
  // (frozen-request validation, the paid replacement decision) do not apply.
  const freeFleet = isFreeFleetModelId(modelConfig.api_model || model)
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('Image generation through the Gateway is not available right now.')
  // "Smaller files" for scene images (Settings, per-project override); undefined = native PNG.
  const sceneOutputFormat = await resolveOutputFormat(job.project_slug, 'scene_images')

  // v1.4.11 — the stored `cfg.negative_prompt` is no longer copied in here.
  // *"we are never using negative prompts at all. so don't include it
  // anyways."* It was also going nowhere: the GenStudio image provider builds
  // its request field by field (providers/image/genstudio.ts) and never reads
  // `providerParams` for content, so anything put here was dropped before the
  // request was sent. The value stays in continuity.json — a stored setting is
  // not this generator's to delete — it simply is not sent.
  const providerParams = { ...((modelConfig as any).provider_params || {}) }

  // ── The one episode reference image ───────────────────────────────────
  //
  // Read from the LIVE catalogue entry the resolver just carried through —
  // never inferred from the model's name, and never a hardcoded count. The
  // owner's decision for this step is ONE reference, so the published
  // `max_reference_images` is used as a can/cannot gate here rather than as a
  // budget: FLUX.2 Klein publishes 0 and must degrade to a text-only render
  // with the reason said out loud, not fail the batch and not silently
  // pretend the switch did something.
  const supportsReferences = modelConfig.supports_reference_images === true
  const maxReferences = modelConfig.max_reference_images ?? (supportsReferences ? 1 : 0)
  const referenceDir = path.join(paths.episode_dir, EPISODE_REFERENCE_DIRNAME)
  const availableReferences = EPISODE_REFERENCE_FILENAMES
    .map(name => path.join(referenceDir, name))
    .filter(candidate => existsSync(candidate))
  const referencePlan = planEpisodeReference({
    enabled: cfg.use_episode_reference,
    availablePaths: availableReferences,
    supportsReferences,
    maxReferences,
    modelName: model,
  })
  if (referencePlan.note) job.output_lines.push(referencePlan.note)

  // Fit it to the model's published pixel ceiling BEFORE anything is charged.
  // Every reference-capable product publishes 1024px while the default 1K
  // output row is 1280x720, so an app-generated composition template is always
  // over the line; see lib/reference-image-fit.ts for why resizing it is this
  // app's job and not the owner's.
  let episodeReferencePaths: string[] = []
  if (referencePlan.sourcePath) {
    const fitted = await fitReferenceImage(
      referencePlan.sourcePath,
      modelConfig.reference_image_max_dimension,
      path.join(referenceDir, FITTED_REFERENCE_DIRNAME),
    )
    episodeReferencePaths = [fitted.path]
    job.output_lines.push(
      `Episode reference: ${path.basename(referencePlan.sourcePath)} attached to every character scene` +
      (fitted.resized
        ? ` — resized ${fitted.from!.width}x${fitted.from!.height} → ${fitted.to!.width}x${fitted.to!.height} ` +
          `to fit ${model}'s published ${modelConfig.reference_image_max_dimension}px reference limit.`
        : '.'),
    )
  }
  /**
   * A stable identity for WHICH reference is on this request.
   *
   * The local task manifest reconnects to a saved GenStudio job when the
   * scope + prompt hash match, and neither of those moves when the customer
   * switches the episode anchor on. Without this, flipping the switch and
   * re-rendering would reclaim the previous TEXT-ONLY job "for free" and hand
   * back the old image while the log claimed a reference had been applied.
   *
   * Derived from the submitted file's CONTENT, so a regenerated composition
   * template is correctly a different render, while re-running the same batch
   * twice still reconnects instead of paying twice. Empty when nothing is
   * attached — which keeps the hash and the idempotency identity byte-identical
   * to what every already-rendered episode recorded, so this change cannot
   * invalidate a single existing manifest entry.
   */
  const referenceIdentity = episodeReferencePaths.length
    ? createHash('sha256').update(await fs.readFile(episodeReferencePaths[0]!)).digest('hex').slice(0, 16)
    : ''

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
  const outDir = await resolveContinuityRenderOutputDir(job.project_slug, episode_id, paths.episode_dir)
  job.output_dir = outDir
  await fs.mkdir(outDir, { recursive: true })
  const taskManifest = await readManifest(outDir)
  const legacyImageDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)

  // Resume only from images that fully decode. A non-empty but truncated file
  // must re-enter the missing-scene scope; otherwise every Retry keeps
  // skipping the same corrupt asset and Video Assembly fails later.
  const usableRenderedIds = new Set<string>()
  const preservedCommittedArtifactIds = new Set<string>()
  for (const scene of scenes) {
    const candidates = [
      path.join(outDir, `${scene.id}.png`),
      path.join(legacyImageDir, `${scene.id}.png`),
      ...(typeof scene.image_path === 'string' ? [scene.image_path] : []),
    ]
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      if (await isDecodableImage(candidate)) {
        const filename = `${scene.id}.png`
        const entry = taskManifest.tasks[filename]
        const submitPermission = entry
          ? await jq.getPaidImageReplacementSubmitPermission(job, filename, outDir, filename, entry)
          : null
        const artifactPermission = entry
          ? jq.getPaidImageReplacementArtifactPermission(job, filename, outDir, filename, entry)
          : null
        if (artifactPermission) {
          await jq.checkpointPaidImageReplacementAttempt(job, filename, {
            state: 'succeeded', replacement_task_id: artifactPermission.replacement_task_id,
          })
        }
        if (submitPermission?.state === 'committed') preservedCommittedArtifactIds.add(scene.id)
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
  const paidProjectRoot = pm.getProjectDir(job.project_slug) || path.join(pm.projectsRoot(), job.project_slug)
  const paidSelector = outputOption ? {
    resolution: outputOption.resolution,
    aspect_ratio: outputOption.aspect_ratio,
    width: outputOption.width,
    height: outputOption.height,
    reference_mode: 'normal',
  } satisfies PaidImageOutputSelector : null
  const logicalPaidScope = (entry: TaskManifestEntry | null | undefined, fallback: string): string => {
    const saved = entry?.request_scope || ''
    const marker = saved.indexOf(':selector:')
    return marker > 0 ? saved.slice(0, marker) : fallback
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
  /** The last real reason each failed scene gave, shown to the owner in plain words. */
  const failureReasons = new Map<string, string>()
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
    referenceImagePaths: string[]
  } => ({
    params: providerParams,
    includeCharacter: isCharacterScene(scene),
    // "Drops the guide's descriptors AND its reference images" is the whole
    // rule, so the episode reference obeys it too. The composition template is
    // a layout with the guide character standing in it; attaching it to a
    // cutaway would put that character back into the very frames v1.0.336
    // exists to keep them out of.
    //
    // `isCharacterScene` is deliberately called twice rather than hoisted into
    // a local. It is a pure two-comparison predicate, and the literal spelling
    // `includeCharacter: isCharacterScene(scene)` is what the tripwire in
    // __tests__/no-negative-prompts.test.ts matches on. That guard is the only
    // thing keeping the anchored character out of cutaways; tidying the line
    // and then widening the guard's regex to suit would quietly retire it.
    referenceImagePaths: isCharacterScene(scene) ? episodeReferencePaths : [],
  })
  if (episodeReferencePaths.length) {
    const cutaways = scenes.filter(scene => !isCharacterScene(scene)).length
    if (cutaways) {
      job.output_lines.push(
        `${cutaways} non-character scene(s) render without the episode reference, as they do without the character text.`,
      )
    }
  }

  const admission = await refreshGenStudioAdmission(apiKey)
  const concurrency = resolveGenStudioLocalFanout(
      scenes.length,
      admission.burst_concurrency_ceiling,
      jq.getImageFanoutOverride(),
    )

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
      `Gateway image batch — ${imageProvider.meta.name} / ${model} · ` +
      `${toRender.length}/${scenes.length} scene(s) · ${mode}. ` +
      'Gateway controls account concurrency and execution.',
    )

    const inFlight = new Map<number, string>()
    // Scenes deliberately sitting out a busy-fleet wait. Nothing is happening
    // and nothing is wrong — the one case a bare spinner misreports as a hang.
    const fleetWaiting = new Map<number, { attempt: number; maxAttempts: number; retryAt: string; reason: string }>()
    const capacityWaiting = new Set<number>()
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
        active: [...inFlight.entries()].sort(([left], [right]) => left - right).map(([sceneIndex, filename]) => {
          const waiting = fleetWaiting.get(sceneIndex)
          const awaitingCapacity = capacityWaiting.has(sceneIndex)
          return {
            label: `Scene ${sceneIndex}`,
            key: filename,
            state: waiting || awaitingCapacity ? 'waiting_retry' as const : 'running' as const,
            attempt: waiting?.attempt ?? 1,
            max_attempts: waiting?.maxAttempts ?? 1,
            ...(waiting
              ? { retry_at: waiting.retryAt, reason: waiting.reason }
              : awaitingCapacity ? { reason: 'Waiting for available image capacity' } : {}),
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
      in_flight: [...inFlight.keys()].sort((a, b) => a - b),
      updated_at: new Date().toISOString(),
    })

    const fallbackTargets = toRender.filter(scene => !successfulSceneIds.has(scene.id) && !preservedCommittedArtifactIds.has(scene.id))
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
      if (!shouldPauseContinuityForStall({
        stallPauseRequested,
        inFlightCount: inFlight.size,
        pauseRequested: jq.isPauseRequested(job.job_id),
        fleetWaitingCount: fleetWaiting.size,
        capacityWaitingCount: capacityWaiting.size,
        elapsedMs: Date.now() - lastCompletedAt,
        freeFleet,
      })) return
      stallPauseRequested = true
      void jq.pauseJobForStall(job.job_id, 'No scene image completed for 10 minutes while provider work was active.')
    }, 30_000)
    stallTimer.unref()
    let paidImageWaitRequested = false
    try {
      let idx = 0
      let active = 0
      let fatalError: unknown
      let finishAll!: () => void
      const allWorkersDone = new Promise<void>((res) => { finishAll = res })
      // Resolve once all work is claimed (or the job is cancelled) AND every
      // worker has drained — so a cancelled run can't hang waiting on workers.
      const maybeFinish = () => {
        if ((fatalError || paidImageWaitRequested || idx >= fallbackTargets.length || jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)) && active === 0) finishAll()
      }
      const worker = async (): Promise<void> => {
        active++
        try {
        while (idx < fallbackTargets.length) {
          if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id) || fatalError || paidImageWaitRequested) return
          const scene = fallbackTargets[idx++]!
          const outPath = path.join(outDir, `${scene.id}.png`)
          const sref = buildScenePromptContext(scene)
          const finalPrompt = composePrompt(scene.visual_prompt, sref.includeCharacter)
          // Empty for a text-only scene, which is what keeps this scene's
          // recorded hash and idempotency identity identical to the ones every
          // already-rendered episode holds on disk.
          const sceneReferenceTag = sref.referenceImagePaths.length ? referenceIdentity : ''
          const hashRequest = (scope: string): string =>
            hashInput(sceneReferenceTag ? `${scope}\n${finalPrompt}\nref:${sceneReferenceTag}` : `${scope}\n${finalPrompt}`)
          const filename = `${scene.id}.png`
          const providerId = imageProvider.meta.providerId || imageProvider.meta.id
          // v1.4.27 — attempts for THIS scene. Only a busy fleet earns another
          // one; every other outcome, good or bad, leaves the loop on the first
          // pass. `savedEntry` is the manifest entry the NEXT attempt reasons
          // from: the run-start snapshot to begin with, then whatever the
          // attempt that just failed actually wrote to disk.
          let savedEntry: TaskManifestEntry | null = taskManifest.tasks[filename] || null
          const freshGenerationAction = params.generation_action?.kind === 'fresh'
            ? params.generation_action
            : null
          // An episode-recovery successor may start after the original job
          // wrote its durable queue checkpoint but before its task manifest
          // was visible on disk. Rehydrate the same explicit action from that
          // checkpoint; do not invent a second request identity.
          const actionCheckpoint = freshGenerationAction
            ? job.params?.genstudio_recovery?.assets?.[filename]
            : undefined
          if (!savedEntry && freshGenerationAction && actionCheckpoint?.operation === 'image' && actionCheckpoint.idempotency_key) {
            savedEntry = {
              provider: providerId,
              task_id: actionCheckpoint.job_id || '',
              submitted_at: actionCheckpoint.updated_at,
              idempotency_key: actionCheckpoint.idempotency_key,
              input_hash: actionCheckpoint.input_hash || '',
              request_scope: freshGenerationAction.id,
              operation: 'image',
              last_state: actionCheckpoint.state,
            }
          }
          // A Finish click owns this scene's first fresh request only. A later
          // fully refunded terminal failure may enter ordinary recovery after
          // the shared live policy approves it, without changing other scenes.
          let sceneManualFinish = manualFinish
          let attemptNum = 1
          let zeroSettlementRetryPending = false
          for (;;) {
            // Cancel and Pause are re-read at the top of EVERY attempt, not
            // just every scene: a resubmission must never start after the owner
            // has already stopped the run.
            if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id) || fatalError || paidImageWaitRequested) return
            inFlight.set(scene.scene_index, filename)
            syncItemProgress()
            await pushStatus()
            // Captured so the failure path can record WHICH GenStudio job died.
            let acceptedTaskId = ''
            let acceptedIdempotencyKey = ''
            let attemptScope = ''
            let attemptHash = ''
            let attemptOriginalFields: Partial<TaskManifestEntry> = {}
            let attemptRequestFields: Pick<TaskManifestEntry, 'model_id' | 'image_seed'> | null = null
            let isPaidReplacement = false
            let attemptPaidSelector: PaidImageOutputSelector | null = null
            let attemptBaseScope = ''
            let attemptPaidOwningRoot = ''
            let attemptOwner: TaskManifestEntry | null = savedEntry
            let releasedZeroSettlementRetry = false
            try {
              // The base scope names the deliberate user action. A force re-render
              // owns a fresh one; an ordinary resume/repair deliberately reuses
              // 'missing' so a still-usable saved job is reclaimed for free.
              const baseScope = manualFinish
                ? `manual-finish:${manualFinish.action_id}`
                : force
                ? (params.generation_action?.id || params.render_attempt_id || job.job_id)
                : 'missing'
              const manifestEntry = savedEntry
              const paidReferenceRoot = paidProjectRoot
              const paidOutputRoot = outDir
              attemptPaidOwningRoot = paidReferenceRoot
              // `manual_image_finish` intentionally persists for the job so a
              // restart can recover its first request. Once that request is
              // terminal, its request scope is durable proof that this scene
              // already consumed the one explicit Finish attempt. Its retry
              // stays in the same action scope, but now follows ordinary
              // automatic policy and live-submit checks.
              const manualFinishScope = manualFinish ? `manual-finish:${manualFinish.action_id}` : ''
              const belongsToManualFinish = (scope: string | undefined): boolean => Boolean(
                manualFinishScope && (scope === manualFinishScope || scope?.startsWith(`${manualFinishScope}:`)),
              )
              if (
                sceneManualFinish
                && pipelineRepairActionId !== sceneManualFinish.action_id
                && isTerminalGenStudioImageTaskFailure(manifestEntry)
                && belongsToManualFinish(manifestEntry?.request_scope)
              ) {
                sceneManualFinish = undefined
              }
              attemptBaseScope = baseScope
              const durablePermission = manifestEntry
                ? await jq.getPaidImageReplacementSubmitPermission(job, filename, outDir, filename, manifestEntry)
                : null
              const submittedRecoveryCandidate = manifestEntry
                ? jq.getPaidImageReplacementRecoveryEntry(job, filename, outDir, filename, manifestEntry)
                : null
              const submittedRecoveryEntry = submittedRecoveryCandidate
                && (!durablePermission || !submittedRecoveryCandidate.idempotency_key)
                ? submittedRecoveryCandidate
                : null
              // A `prepared` entry has only reserved an idempotency key. It may
              // be replayed after GenStudio authoritatively says that exact key
              // is absent, but only by a recovery/resume action. An explicit
              // fresh re-render owns a new provider identity instead.
              let preparedReplay = Boolean(
                !freshGenerationAction
                && !force
                && !sceneManualFinish?.replace_uncertain
                && !manifestEntry?.task_id
                && manifestEntry?.idempotency_key
                && manifestEntry?.input_hash
                && manifestEntry?.request_scope
                && manifestEntry.last_state === 'prepared',
              )
              if (!freshGenerationAction && !force && !sceneManualFinish?.replace_uncertain
                && manifestEntry?.last_state === 'prepared' && !manifestEntry.task_id && !manifestEntry.idempotency_key) {
                throw new Error('The saved prepared image request has no idempotency key. No provider work was submitted.')
              }
              const useFrozenOriginal = preparedReplay || (!sceneManualFinish
                && (!!durablePermission || !!submittedRecoveryEntry || !!(manifestEntry?.original_output_selector
                  && isTerminalGenStudioImageTaskFailure(manifestEntry))))
              const originalSelector = (useFrozenOriginal ? manifestEntry?.original_output_selector : null) || (paidSelector ? {
                ...paidSelector,
                reference_mode: sref.referenceImagePaths.length ? 'reference-guided' as const : 'normal' as const,
              } : null)
              attemptPaidSelector = originalSelector
              const capturedReferences = useFrozenOriginal && manifestEntry?.original_reference_inputs && manifestEntry.original_reference_identity_hash
                ? { inputs: manifestEntry.original_reference_inputs, identity_hash: manifestEntry.original_reference_identity_hash }
                : originalSelector
                  ? capturePaidImageReferenceIdentity(
                    paidReferenceRoot,
                    sref.referenceImagePaths.map((referencePath, index) => ({ role: `episode-reference-${index + 1}`, path: referencePath })),
                  )
                : null
              let replacementScope = durablePermission?.replacement_scope || ''
              if (preparedReplay && (replacementScope || submittedRecoveryEntry)) {
                throw new Error('Prepared image recovery cannot be combined with a paid replacement request.')
              }
              // When a prepared record has the complete original paid-image
              // facts, validate them before reusing its identity. Older
              // manifests lack these additive fields; their retained key is
              // still replayed only after the provider proves it absent, but
              // we never claim an unrecorded payload is identical.
              // Free fleet: frozen facts that no longer validate (the prompt or style
              // changed since preparation) are simply not reused; the request is
              // rebuilt from the current scene below once the Gateway proves the
              // old key absent. Paid work stays fail-closed.
              const validatedPreparedOriginal = preparedReplay
                && manifestEntry?.original_output_selector
                && Array.isArray(manifestEntry.original_reference_inputs)
                && manifestEntry.original_reference_identity_hash
                && manifestEntry.original_output_path
                ? (() => {
                    try {
                      return readPaidImageOriginalRequest(
                        manifestEntry!,
                        paidReferenceRoot,
                        { prompt: finalPrompt, baseScope: logicalPaidScope(manifestEntry, baseScope) },
                        paidOutputRoot,
                      )
                    } catch (error) {
                      if (freeFleet) return null
                      throw error
                    }
                  })()
                : null
              // Free fleet skips the paid decision: a control read that throws or is
              // not "failed" made it answer "recover-original" forever (TN0355 scene 65).
              // The ordinary path below derives a new retry identity from the dead task.
              if (!freeFleet && !sceneManualFinish && !zeroSettlementRetryPending && !replacementScope && !submittedRecoveryEntry && originalSelector && manifestEntry && isTerminalGenStudioImageTaskFailure(manifestEntry)
                && manifestEntry.original_output_selector) {
                const decision = await decidePaidImageReplacement({
                  job,
                  asset: {
                    assetKey: filename, manifestDir: outDir, manifestKey: filename, outputPath: outPath,
                    owningRoot: paidReferenceRoot, referenceRoot: paidReferenceRoot, outputRoot: paidOutputRoot,
                    trustedOriginal: { prompt: finalPrompt, baseScope: logicalPaidScope(manifestEntry, baseScope) },
                    modelId: modelConfig.api_model || model, apiKey,
                  },
                })
                if (decision.action === 'wait') {
                  paidImageWaitRequested = true
                  await jq.checkpointJobState(job)
                  return
                }
                if (decision.action === 'recover-original') {
                  if (await isDecodableImage(outPath)) {
                    successfulSceneIds.add(scene.id)
                    usableRenderedIds.add(scene.id)
                    break
                  }
                  throw new Error('The original task may still be recoverable; no replacement was submitted.')
                }
                if (decision.action === 'blocked') {
                  await jq.checkpointPaidImageReplacementBlockedIfPresent(job, filename, decision.reason, decision.public_reason)
                  jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
                  throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
                }
                if (decision.action === 'safe-zero-settlement-retry') zeroSettlementRetryPending = true
                if (decision.action === 'commit') replacementScope = decision.scope
              }
              // A terminal saved job promotes the scope to a NEW retry identity,
              // derived deterministically from the dead job id — never a clock.
              const retryEntry = manifestEntry?.request_scope?.includes(':selector:')
                ? { ...manifestEntry, request_scope: logicalPaidScope(manifestEntry, baseScope) }
                : manifestEntry
              const retryScope = resolveImageRetryScope(retryEntry, baseScope)
              let logicalScope = retryScope.scope
              let identity = originalSelector && capturedReferences
                ? buildPaidImageOriginalIdentity({ prompt: finalPrompt, selector: originalSelector, references: capturedReferences.inputs, baseScope: logicalScope })
                : null
              let requestScope = preparedReplay
                ? manifestEntry!.request_scope!
                : replacementScope || (submittedRecoveryEntry ? manifestEntry!.replacement_scope! : '') || identity?.requestScope || logicalScope
              const expectedInputHash = preparedReplay
                ? manifestEntry!.input_hash!
                : identity?.inputHash || hashRequest(requestScope)
              if (sceneManualFinish && pipelineRepairActionId === sceneManualFinish.action_id
                && isTerminalGenStudioImageTaskFailure(manifestEntry)
                && hasPipelineRepairImageAttempt(manifestEntry, pipelineRepairActionId)) {
                throw new Error('This Pipeline repair action already used its one fresh attempt for this scene image.')
              }
              let manualSupersession = sceneManualFinish && manifestEntry && isTerminalGenStudioImageTaskFailure(manifestEntry)
                ? resolveManualImageReplacement(manifestEntry, sceneManualFinish.action_id)
                : null
              // Reconnect ONLY to a saved job that belongs to this exact request
              // AND has not already settled. Hash equality alone once let a
              // six-day-old failed job satisfy every future Retry.
              const hashMatches = manifestEntry?.input_hash === expectedInputHash
              const hasDurableSavedIdentity = Boolean(manifestEntry?.task_id || manifestEntry?.idempotency_key)
              const explicitFreshAction = Boolean(freshGenerationAction)
              const freshActionId = freshGenerationAction?.id || ''
              // A fresh click must not reclaim a prior click's artifact just
              // because it shares the same scene file. Its own successor job,
              // however, may rejoin the request that carries this action scope.
              const belongsToFreshAction = Boolean(freshActionId && (
                manifestEntry?.request_scope === freshActionId
                || manifestEntry?.request_scope?.startsWith(`${freshActionId}:`)
              ))
              const recoverable = submittedRecoveryEntry || (
                !replacementScope
                  && (explicitFreshAction
                    ? belongsToFreshAction && hasDurableSavedIdentity
                    : (!isTerminalGenStudioImageTaskFailure(manifestEntry)
                      && (sceneManualFinish ? hasDurableSavedIdentity : hashMatches)))
                  ? manifestEntry
                  : null
              )
              let recovery = await tryRecoverImageFromManifestEntry(
                recoverable,
                apiKey,
                modelConfig,
                () => jq.isCancelled(job.job_id),
                {
                  observeCurrentState: Boolean(sceneManualFinish),
                  allowPreparedReplayOnAbsent: preparedReplay,
                },
              )
              if (recovery.kind === 'still-generating') {
                if (sceneManualFinish) {
                  sceneManualFinish.still_generating_scene_ids = [...new Set([
                    ...(sceneManualFinish.still_generating_scene_ids || []), scene.id,
                  ])]
                  await jq.checkpointJobState(job)
                }
                job.output_lines.push(
                  `Scene ${scene.scene_index}: the earlier request is still being made at the Gateway; waiting for it instead of sending a new one.`,
                )
                try {
                  recovery = await tryRecoverImageFromManifestEntry(
                    recoverable,
                    apiKey,
                    modelConfig,
                    () => jq.isCancelled(job.job_id),
                  )
                } finally {
                  if (sceneManualFinish) {
                    sceneManualFinish.still_generating_scene_ids = (sceneManualFinish.still_generating_scene_ids || [])
                      .filter(sceneId => sceneId !== scene.id)
                    await jq.checkpointJobState(job)
                  }
                }
              }
              if (recovery.kind === 'uncertain') {
                // Never turn "I could not confirm the outcome" into a second paid
                // submission. Fail this scene; Retry reconnects to the same job.
                if (submittedRecoveryEntry) throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
                if (sceneManualFinish?.replace_uncertain && manifestEntry) {
                  if (sceneManualFinish.expected_uncertain_identity_hashes?.[scene.id] !== imageManifestIdentityHash(manifestEntry)) {
                    throw new Error('The uncertain image request changed after confirmation. Check saved results again.')
                  }
                  manualSupersession = resolveManualImageReplacement(manifestEntry, sceneManualFinish.action_id)
                } else {
                  if (sceneManualFinish) {
                    sceneManualFinish.uncertain_scene_ids = [...new Set([
                      ...(sceneManualFinish.uncertain_scene_ids || []), scene.id,
                    ])]
                    sceneManualFinish.uncertain_identity_hashes = {
                      ...(sceneManualFinish.uncertain_identity_hashes || {}),
                      [scene.id]: imageManifestIdentityHash(manifestEntry!),
                    }
                    await jq.checkpointJobState(job)
                  }
                  throw new Error(
                    `Could not confirm the earlier Gateway request (${recovery.reason}). ` +
                    'No duplicate image was submitted; Scene Review can offer Replace anyway.',
                  )
                }
              }
              let carried: TaskManifestEntry | null = manifestEntry
              if (recovery.kind === 'terminal-failed' || recovery.kind === 'artifact-unavailable') {
                if (submittedRecoveryEntry) {
                  if (submittedRecoveryEntry.idempotency_key) {
                    await checkpointGenStudioAsset(job, filename, {
                      operation: 'image', idempotency_key: submittedRecoveryEntry.idempotency_key,
                      job_id: recovery.taskId, output_path: outPath, input_hash: manifestEntry!.input_hash!, state: 'failed',
                    })
                  }
                  await jq.checkpointPaidImageReplacementAttempt(job, filename, {
                    state: 'failed', replacement_task_id: recovery.taskId, reason: recovery.reason,
                  })
                  throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
                }
                // A deliberate single-scene replacement is one paid attempt.
                // Its Jobs Retry may recover its saved provider task, but a
                // known-terminal task cannot silently promote that same click
                // to a second billable request. The next explicit click owns a
                // new generation_action and therefore a new provider identity.
                if (attemptNum === 1 && belongsToFreshAction) {
                  throw new Error('This explicit scene regeneration already used its one image request. Start a new regeneration to submit another image.')
                }
                // GenStudio just told us the saved job settled. Persist that
                // outcome FIRST, then promote to a fresh identity from it, so the
                // same retry scope is reproducible after a crash.
                carried = terminalImageManifestEntry(manifestEntry!, recovery)
                await compareAndRecordImageTaskStrict(outDir, filename, manifestEntry, carried)
                // The provider has now conclusively settled the prepared key.
                // Its next request is a terminal-retry replacement, never a
                // replay of that old reservation.
                preparedReplay = false
                savedEntry = carried
                attemptOwner = carried
                if (sceneManualFinish && pipelineRepairActionId !== sceneManualFinish.action_id
                  && belongsToManualFinish(carried.request_scope)) sceneManualFinish = undefined
                if (!freeFleet && !sceneManualFinish && originalSelector && carried.idempotency_key) {
                  const decision = await decidePaidImageReplacement({
                    job,
                    asset: {
                      assetKey: filename, manifestDir: outDir, manifestKey: filename, outputPath: outPath,
                      owningRoot: paidReferenceRoot, referenceRoot: paidReferenceRoot, outputRoot: paidOutputRoot,
                      trustedOriginal: { prompt: finalPrompt, baseScope: logicalPaidScope(carried, baseScope) },
                      modelId: modelConfig.api_model || model, apiKey,
                    },
                  })
                  if (decision.action === 'wait') {
                    paidImageWaitRequested = true
                    return
                  }
                  if (decision.action === 'blocked') {
                    await jq.checkpointPaidImageReplacementBlockedIfPresent(job, filename, decision.reason, decision.public_reason)
                    jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
                    throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
                  }
                  if (decision.action === 'safe-zero-settlement-retry') zeroSettlementRetryPending = true
                }
                const carriedRetry = carried.request_scope?.includes(':selector:')
                  ? { ...carried, request_scope: logicalPaidScope(carried, baseScope) }
                  : carried
                logicalScope = resolveImageRetryScope(carriedRetry, baseScope).scope
                identity = originalSelector && capturedReferences
                  ? buildPaidImageOriginalIdentity({ prompt: finalPrompt, selector: originalSelector, references: capturedReferences.inputs, baseScope: logicalScope })
                  : null
                requestScope = identity?.requestScope || logicalScope
                job.output_lines.push(
                  `Scene ${scene.scene_index}: saved Gateway task ${recovery.taskId.slice(0, 12)}… is terminal ` +
                  `(${recovery.kind === 'artifact-unavailable' ? 'artifact expired' : 'failed'}); ` +
                  'submitting one fresh job under a new retry identity.',
                )
                if (sceneManualFinish) {
                  if (pipelineRepairActionId === sceneManualFinish.action_id
                    && hasPipelineRepairImageAttempt(carried, pipelineRepairActionId)) {
                    throw new Error('This Pipeline repair action already used its one fresh attempt for this scene image.')
                  }
                  manualSupersession = resolveManualImageReplacement(carried, sceneManualFinish.action_id)
                }
              }
              if (manualSupersession) {
                logicalScope = manualSupersession.scope
                identity = originalSelector && capturedReferences
                  ? buildPaidImageOriginalIdentity({ prompt: finalPrompt, selector: originalSelector, references: capturedReferences.inputs, baseScope: logicalScope })
                  : null
                requestScope = identity?.requestScope || logicalScope
              }
              const inputHash = preparedReplay
                ? manifestEntry!.input_hash!
                : replacementScope || submittedRecoveryEntry
                ? manifestEntry!.input_hash!
                : identity?.inputHash || (requestScope === retryScope.scope ? expectedInputHash : hashRequest(requestScope))
              attemptScope = requestScope
              attemptHash = inputHash
              // Reuse the prepared entry's timestamp so a replayed submission
              // keeps one submitted_at instead of drifting forward each attempt.
              const sameScope = carried?.request_scope === requestScope ? carried : null
              const submittedAt = sameScope?.submitted_at || new Date().toISOString()
              const verifiedReplacement = replacementScope
                ? readPaidImageOriginalRequest(
                    manifestEntry!, paidReferenceRoot,
                    { prompt: finalPrompt, baseScope: logicalPaidScope(manifestEntry, baseScope) }, paidOutputRoot,
                  )
                : null
              const requestReferences = verifiedReplacement
                ? verifiedReplacement.references.map(reference => reference.path)
                : validatedPreparedOriginal
                  ? validatedPreparedOriginal.references.map(reference => reference.path)
                  : sref.referenceImagePaths
              const requestSelector = verifiedReplacement?.selector || validatedPreparedOriginal?.selector || originalSelector
              const requestIdentity = replacementScope
                ? replacementScope
                : `${job.project_slug}:${episode_id}:scene:${scene.id}:image:${requestScope}`
              const currentModelId = modelConfig.api_model || model
              const savedPreparedModelId = preparedReplay ? manifestEntry?.model_id?.trim() : ''
              const hasSavedPreparedSeed = preparedReplay && manifestEntry?.image_seed !== undefined
              const savedPreparedSeed = manifestEntry?.image_seed === null ? undefined : manifestEntry?.image_seed
              let requestModelId = savedPreparedModelId || currentModelId
              let requestSeed = hasSavedPreparedSeed ? savedPreparedSeed : params.seed
              const keyFor = (
                outputFormat: 'jpeg' | undefined,
                modelId = requestModelId,
                seed = requestSeed,
              ) => buildGenStudioImageIdempotencyKey({
                prompt: finalPrompt,
                modelId,
                aspectRatio: requestSelector?.aspect_ratio || aspectRatio,
                ...(requestSelector ? { resolution: requestSelector.resolution } : { width: renderWidth, height: renderHeight }),
                seed,
                requestIdentity,
                ...(outputFormat ? { outputFormat } : {}),
              })
              // A prepared request replays in the format it was prepared with: the owner may have
              // flipped "smaller files" since, and that must not strand a request that is ready to go.
              const replayFormats = preparedReplay
                ? [sceneOutputFormat, undefined, 'jpeg' as const].filter(f => keyFor(f) === manifestEntry!.idempotency_key)
                : []
              let requestOutputFormat = replayFormats.length ? replayFormats[0] : sceneOutputFormat
              let calculatedPreparedKey = keyFor(requestOutputFormat)
              const savedPreparedFactsChanged = preparedReplay && (
                Boolean(savedPreparedModelId && savedPreparedModelId !== currentModelId)
                || (hasSavedPreparedSeed && !Object.is(savedPreparedSeed, params.seed))
              )
              const canRenewAbsentFreePreparation = preparedReplay
                && recovery.kind === 'no-saved-job'
                && freeFleet
              const recoveredPreparedIdentityVerified = recovery.kind === 'recovered'
                && (Boolean(validatedPreparedOriginal)
                  || calculatedPreparedKey === manifestEntry!.idempotency_key)
              if (canRenewAbsentFreePreparation
                && (calculatedPreparedKey !== manifestEntry!.idempotency_key || savedPreparedFactsChanged)) {
                // The Gateway proved this exact old reservation never became a task. Free fleet
                // work can therefore adopt the current preset facts without risking a charge or
                // duplicating provider work. Paid requests remain fail-closed below.
                requestModelId = currentModelId
                requestSeed = params.seed
                requestOutputFormat = sceneOutputFormat
                calculatedPreparedKey = keyFor(requestOutputFormat, requestModelId, requestSeed)
                preparedReplay = false
                job.output_lines.push(
                  `Scene ${scene.scene_index}: the old free-Mac request was never submitted; refreshing its saved request before continuing.`,
                )
              // A completed exact-key lookup may reuse its artifact only when the frozen
              // originals validate or this scene still reconstructs the exact saved request.
              } else if (preparedReplay && !recoveredPreparedIdentityVerified
                && (calculatedPreparedKey !== manifestEntry!.idempotency_key || savedPreparedFactsChanged)) {
                throw new Error('The saved prepared image request no longer matches this scene. No provider work was submitted.')
              }
              const preparedKey = preparedReplay ? manifestEntry!.idempotency_key! : calculatedPreparedKey
              const preparedRequestFields = {
                model_id: requestModelId,
                image_seed: requestSeed ?? null,
              }
              attemptRequestFields = recovery.kind === 'recovered' ? {
                ...(manifestEntry?.model_id !== undefined ? { model_id: manifestEntry.model_id } : {}),
                ...(manifestEntry?.image_seed !== undefined ? { image_seed: manifestEntry.image_seed } : {}),
              } : preparedRequestFields
              const originalFields = identity && originalSelector && capturedReferences ? {
                original_output_selector: originalSelector,
                original_reference_inputs: capturedReferences.inputs,
                original_reference_identity_hash: capturedReferences.identity_hash,
                original_output_path: revalidatePaidImageOutputPath(paidOutputRoot, outPath),
              } : {}
              attemptOriginalFields = originalFields
              isPaidReplacement = !!replacementScope || !!submittedRecoveryEntry
              let currentOwner: TaskManifestEntry | null = carried

              let result: { urls: string[]; taskId?: string; settledCredits?: number }
              if (recovery.kind === 'recovered') {
                result = { urls: recovery.urls, taskId: recovery.taskId }
                if (!submittedRecoveryEntry && manifestEntry) {
                  const recoveredOwner: TaskManifestEntry = {
                    ...manifestEntry,
                    provider: providerId,
                    task_id: recovery.taskId,
                    operation: 'image',
                    last_state: 'succeeded',
                  }
                  await compareAndRecordImageTaskStrict(outDir, filename, manifestEntry, recoveredOwner)
                  currentOwner = recoveredOwner
                  attemptOwner = recoveredOwner
                }
              } else {
                // Persist the request identity BEFORE the POST. If the response is
                // lost, the next attempt reads this scope back, rebuilds the same
                // idempotency key, and re-attaches instead of paying twice.
                if (!replacementScope) {
                  const preparedOwner: TaskManifestEntry = {
                    provider: providerId,
                    task_id: '',
                    submitted_at: submittedAt,
                    input_hash: inputHash,
                    request_scope: requestScope,
                    idempotency_key: preparedKey,
                    operation: 'image',
                    last_state: 'prepared',
                    ...preparedRequestFields,
                    ...originalFields,
                    ...(manualSupersession ? { superseded_image_requests: [manualSupersession.superseded] } : {}),
                  }
                  let claimed = true
                  if (sceneManualFinish) {
                    claimed = await claimMissingImageTaskStrict(outDir, filename, outPath, carried, preparedOwner)
                  } else {
                    await compareAndRecordImageTaskStrict(outDir, filename, carried, preparedOwner)
                  }
                  if (!claimed) {
                    successfulSceneIds.add(scene.id)
                    usableRenderedIds.add(scene.id)
                    break
                  }
                  currentOwner = preparedOwner
                  attemptOwner = preparedOwner
                  await checkpointGenStudioAsset(job, filename, {
                    operation: 'image', idempotency_key: preparedKey,
                    output_path: outPath, input_hash: inputHash, state: 'prepared',
                  })
                }
                // Pause is distinct from cancellation: recovery GETs above are
                // allowed to finish, but no new paid POST may cross this point.
                jq.throwIfPauseRequested(job.job_id)
                result = await imageProvider.generateImage({
                  prompt: finalPrompt,
                  apiKey,
                  aspectRatio: requestSelector?.aspect_ratio || aspectRatio,
                  modelId: requestModelId,
                  providerParams: sref.params,
                  ...(requestReferences.length ? { referenceImagePaths: requestReferences } : {}),
                  ...(requestSelector
                    ? { resolution: requestSelector.resolution }
                    : { width: renderWidth, height: renderHeight }),
                  seed: requestSeed,
                  ...(requestOutputFormat ? { outputFormat: requestOutputFormat } : {}),
                  idempotencyIdentity: requestIdentity,
                  idempotencyKey: preparedKey,
                  ...(replacementScope && manifestEntry ? {
                    beforeSubmit: () => jq.assertPaidImageReplacementSubmitPermission(
                      job, filename, outDir, filename, manifestEntry,
                    ),
                  } : zeroSettlementRetryPending ? {
                    beforeSubmit: assertReleasedZeroSettlementImageRetrySubmit,
                  } : {}),
                  onQueueState: async state => {
                    if (state === 'waiting_account_capacity') capacityWaiting.add(scene.scene_index)
                    else capacityWaiting.delete(scene.scene_index)
                    syncItemProgress()
                    await jq.checkpointJobProgress(job)
                  },
                  isCancelled: () => jq.isCancelled(job.job_id),
                  onJobAccepted: async (taskId, idempotencyKey) => {
                    acceptedTaskId = taskId
                    acceptedIdempotencyKey = idempotencyKey
                    if (replacementScope) {
                      const currentPaid = job.paid_image_replacement_attempts?.find(attempt => attempt.asset_key === filename)
                      if (currentPaid?.state === 'committed') {
                        await jq.checkpointPaidImageReplacementAttempt(job, filename, {
                          state: 'submitted', replacement_task_id: taskId,
                        })
                      } else if (currentPaid?.state !== 'submitted' || currentPaid.replacement_task_id !== taskId) {
                        throw new Error('Paid image replacement replay returned a different provider task.')
                      }
                    } else {
                      const acceptedOwner: TaskManifestEntry = {
                        provider: providerId,
                        task_id: taskId,
                        submitted_at: submittedAt,
                        input_hash: inputHash,
                        request_scope: requestScope,
                        idempotency_key: idempotencyKey,
                        operation: 'image',
                        last_state: 'accepted',
                        ...preparedRequestFields,
                        ...originalFields,
                        ...(manualSupersession ? { superseded_image_requests: [manualSupersession.superseded] } : {}),
                      }
                      await compareAndRecordImageTaskStrict(outDir, filename, currentOwner, acceptedOwner)
                      currentOwner = acceptedOwner
                      attemptOwner = acceptedOwner
                    }
                    await checkpointGenStudioAsset(job, filename, {
                      operation: 'image',
                      idempotency_key: idempotencyKey,
                      job_id: taskId,
                      output_path: outPath,
                      input_hash: inputHash,
                      state: 'accepted',
                    })
                  },
                  onReconnect: (taskId) => {
                    job.output_lines.push(
                      `Scene ${scene.scene_index}: reconnecting accepted Gateway task ${taskId.slice(0, 12)}…`,
                    )
                  },
                })
                if (result.taskId && !replacementScope) {
                  const succeededOwner: TaskManifestEntry = {
                    provider: providerId,
                    task_id: result.taskId,
                    submitted_at: submittedAt,
                    input_hash: inputHash,
                    request_scope: requestScope,
                    ...(acceptedIdempotencyKey ? { idempotency_key: acceptedIdempotencyKey } : {}),
                    operation: 'image',
                    last_state: 'succeeded',
                    ...preparedRequestFields,
                    ...originalFields,
                    ...(manualSupersession ? { superseded_image_requests: [manualSupersession.superseded] } : {}),
                  }
                  await compareAndRecordImageTaskStrict(outDir, filename, currentOwner, succeededOwner)
                  currentOwner = succeededOwner
                  attemptOwner = succeededOwner
                }
              }
              if (!result.urls.length) throw new Error('The Gateway returned no image')
              if (!currentOwner) throw new Error('Scene image request ownership was not recorded.')
              const stagingPath = await stageGenStudioImage(result.urls[0]!, outPath, { compress: !!sceneOutputFormat })
              const promoted = await promoteCurrentImageTaskArtifactStrict(
                outDir,
                filename,
                currentOwner,
                stagingPath,
                outPath,
                () => persistImagePath(
                  scene.id,
                  outPath,
                  sceneManualFinish && recovery.kind === 'recovered' && !hashMatches ? '' : scene.visual_prompt,
                ),
              )
              if (!promoted) throw new Error('A newer image request owns this scene; the late result was not applied.')
              if (isPaidReplacement) {
                const actualSettledCredits = authoritativePaidImageSettledCredits(result.settledCredits)
                await jq.checkpointPaidImageReplacementAttempt(job, filename, {
                  state: 'succeeded', replacement_task_id: result.taskId || acceptedTaskId,
                  ...(actualSettledCredits !== undefined ? { actual_settled_credits: actualSettledCredits } : {}),
                })
              }
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
                  ...(attemptRequestFields || {}),
                  ...attemptOriginalFields,
                }
                if (isPaidReplacement) {
                  const actualSettledCredits = authoritativePaidImageSettledCredits(e.settledCredits)
                  await jq.checkpointPaidImageReplacementAttempt(job, filename, {
                    state: 'failed', replacement_task_id: failedTaskId,
                    reason: e.message,
                    ...(actualSettledCredits !== undefined ? { actual_settled_credits: actualSettledCredits } : {}),
                  })
                } else {
                  await compareAndRecordImageTaskStrict(outDir, filename, attemptOwner, failedEntry)
                  attemptOwner = failedEntry
                  if (failedTaskId && acceptedIdempotencyKey) {
                    await checkpointGenStudioAsset(job, filename, {
                      operation: 'image', idempotency_key: acceptedIdempotencyKey,
                      job_id: failedTaskId, output_path: outPath, input_hash: attemptHash, state: 'failed',
                    })
                  }
                  // Finish's first POST is the owner's explicit attempt. Once
                  // GenStudio has conclusively returned that whole reservation,
                  // it may continue only through the same live policy that
                  // protects ordinary automatic recovery.
                  const manualZeroSettlementRetry = Boolean(
                    sceneManualFinish
                    && !e.cancelled
                    && hasFullyReleasedZeroSettlement(e)
                    && isRetryableZeroSettlementImageFailureCode(e.failureCode),
                  )
                  const decision = (!sceneManualFinish || manualZeroSettlementRetry) && attemptPaidSelector
                    ? await decidePaidImageReplacement({
                        job,
                        asset: {
                          assetKey: filename, manifestDir: outDir, manifestKey: filename, outputPath: outPath,
                          owningRoot: attemptPaidOwningRoot, referenceRoot: attemptPaidOwningRoot, outputRoot: outDir,
                          trustedOriginal: { prompt: finalPrompt, baseScope: logicalPaidScope(failedEntry, attemptBaseScope) },
                          modelId: modelConfig.api_model || model, apiKey,
                        },
                      })
                    : null
                  if (decision) {
                    job.output_lines.push(`Scene ${scene.scene_index}: paid replacement decision — ${decision.action}.`)
                  }
                  releasedZeroSettlementRetry = isReleasedZeroSettlementImageRetry(e, decision)
                  zeroSettlementRetryPending ||= releasedZeroSettlementRetry
                  if (sceneManualFinish && releasedZeroSettlementRetry) sceneManualFinish = undefined
                  if (decision?.action === 'wait') {
                    paidImageWaitRequested = true
                    return
                  }
                  if (decision?.action === 'blocked') {
                    await jq.checkpointPaidImageReplacementBlockedIfPresent(job, filename, decision.reason, decision.public_reason)
                    jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
                    job.output_lines.push(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
                  }
                }
                if (e.cancelled) cancelledSceneIds.add(scene.id)
                // A no-worker fleet failure uses the shared bounded backoff.
                // Fully refunded failures remain retryable with backoff while the
                // current policy verifies each terminal task and zero settlement.
                // A task id is required because the
                // next identity is DERIVED from the dead job id: without one the
                // scope cannot be promoted, and the retry would replay a
                // settled-failed key, which returns the same failure forever.
                const plan = sceneManualFinish ? null : continuityFleetBusyRetryPlan(e, attemptNum)
                  || (releasedZeroSettlementRetry
                    ? { waitMs: imageRouteRetryDelayMs(attemptNum - 1), reason: 'The failed image was fully refunded', maxAttempts: attemptNum + 1 }
                    : null)
                if (plan && failedTaskId && !jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {
                  fleetWaiting.set(scene.scene_index, {
                    attempt: attemptNum,
                    maxAttempts: plan.maxAttempts,
                    retryAt: new Date(Date.now() + plan.waitMs).toISOString(),
                    reason: plan.reason,
                  })
                  syncItemProgress()
                  job.output_lines.push(isFreeMacPlan(plan) ? freeMacWaitLine(`Scene ${scene.scene_index}`, e, plan.waitMs) :
                    `Scene ${scene.scene_index}: ${plan.reason.toLowerCase()} — nothing was charged. ` +
                    `Waiting ${Math.round(plan.waitMs / 1000)}s and trying again ` +
                    `(attempt ${attemptNum + 1}${releasedZeroSettlementRetry ? '' : ` of ${plan.maxAttempts}`}).`,
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
                failureReasons.set(scene.id, isPaidReplacement ? jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE : String(e?.message || e))
                job.output_lines.push(isPaidReplacement
                  ? jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE
                  : `Scene ${scene.scene_index} failed: ${e?.message || e}`)
              } else {
                job.output_lines.push(`Scene ${scene.scene_index} cancelled by customer; Gateway settlement is preserved and this is not counted as a provider failure.`)
              }
              break
            } finally {
              inFlight.delete(scene.scene_index)
              syncItemProgress()
              await pushStatus()
              // Progress only (results are recorded with their evidence): may share a rewrite (S4).
              await jq.checkpointJobProgress(job)
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
        if (idx >= fallbackTargets.length || paidImageWaitRequested || jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id) || fatalError) return
        const want = Math.min(maxWorkers, fallbackTargets.length - idx + active)
        while (active < want) void worker()
      }
      ensureWorkers()
      maybeFinish()  // nothing to render → resolve immediately

      await allWorkersDone
      if (fatalError && !paidImageWaitRequested) throw fatalError
    } finally {
      clearInterval(stallTimer)
      await deactivateSceneRenderStatus(job.project_slug, episode_id, job.job_id).catch(() => {})
    }

    if (paidImageWaitRequested) return { kind: 'paid-image-wait' }

    job.output_dir = outDir
    syncItemProgress()
    const mediaAudit = await auditSceneImageCompletion(planPath, toRender.map(scene => scene.id), [outDir])
    // Exact scene IDs remain separate from their display reasons so Jobs can
    // link to the owning Scene Review row without parsing prose.
    const issuesById = new Map(mediaAudit.issues.map(issue => [issue.item_id, issue]))
    for (const sceneId of failedSceneIds) {
      const audited = issuesById.get(sceneId)
      issuesById.set(sceneId, audited
        ? { ...audited, reason: failureReasons.get(sceneId) || audited.reason }
        : { item_id: sceneId, state: 'invalid', reason: failureReasons.get(sceneId) || 'generation failed' })
    }
    for (const scene of toRender) {
      if (successfulSceneIds.has(scene.id) || preservedCommittedArtifactIds.has(scene.id)) continue
      if (!issuesById.has(scene.id)) issuesById.set(scene.id, { item_id: scene.id, state: 'invalid', reason: 'not saved' })
    }
    const issues = [...issuesById.values()]
    const missing = issues.filter(issue => issue.state === 'missing').map(issue => issue.item_id)
    const invalid = issues.filter(issue => issue.state === 'invalid')
      .map(issue => `${issue.item_id}${issue.reason ? ` (${issue.reason})` : ''}`)
    const unresolved = new Set(issues.map(issue => issue.item_id))
    if (unresolved.size > 0) {
      job.params.scene_ids = toRender.filter(scene => unresolved.has(scene.id)).map(scene => scene.id)
      // The scope is already narrowed to failed IDs. Do not let an older image
      // suppress a failed explicit re-render on the next attempt.
      job.params.missing_only = false
    }
    requireJobCompletion(job, {
      label: 'Scene image generation', expected: toRender.length,
      completed: toRender.length - unresolved.size,
      item_name: 'image',
      missing,
      invalid,
      issues,
      message: unresolvedSceneImagesMessage(job, toRender, issues),
    })
    job.output_lines.push(`Done — ${toRender.length}/${toRender.length} target scene(s) verified; ${skipped} skipped.`)
    // Scene Review now waits on the owner, not on work: say so (Jobs, the Board and a notification).
    const awaiting = await countScenesAwaitingApproval(planPath)
    if (awaiting) {
      job.result = { ...(job.result || {}), awaiting_approval: awaiting }
      job.output_lines.push(`${awaitingApprovalLabel(awaiting)} — open Scene Review.`)
    }
    return
}
