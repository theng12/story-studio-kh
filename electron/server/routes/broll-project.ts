/**
 * Per-project B-Roll routes — pick a selection for an episode, queue
 * an assembly job that renders narration + chosen B-Roll into a video.
 *
 *   POST /api/projects/:slug/broll/pick      — generate + persist selection
 *   POST /api/projects/:slug/broll/assemble  — queue render job
 *
 * The selection algorithm itself lives in lib/broll-selector.ts (pure).
 * This route layer reads the project's subscribed pool, the episode's
 * narration duration, and the channel's usage log, then calls the
 * selector and writes the result to the per-episode sidecar.
 */
import { Router } from 'express'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as bp from '../services/broll-pool-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import { selectBroll } from '../lib/broll-selector.js'
import { saveSelectionSidecar, getSelectionSidecar } from '../services/broll-selection-sidecar.js'
import { recentlyUsedClipShas } from '../services/broll-selection.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { resolveAuthoritativeBrollNarration } from '../services/video-visual-source.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { imagePoolPromptsOutputContract } from '../lib/story-output-contracts.js'
import { withLock } from '../lib/atomic-store.js'
import {
  freshActionFingerprint,
  freshActionMatch,
  readManualGenerationRedoIntent,
  readOperationId,
  stampFreshGenerationAction,
} from '../lib/fresh-generation-action.js'
import { readManifestStrict } from '../services/task-manifest.js'
import { isUnsettledProviderEntry } from '../lib/provider-task-state.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { listImageModelsForceLive } from '../lib/genstudio-client.js'
import { findGenStudioProduct } from '../contracts/genstudio-product-identity.js'
import {
  publishedAvailabilityProblem,
  resolvePublishedAspectRatio,
  resolvePublishedOutputOption,
} from '../services/image-model-resolver.js'
import type { Job, JobType, BrollUsageEntry } from '../models/types.js'
import { buildImagePoolPreparedReceipt, type ImagePoolPreparedReceipt } from '../generators/image-pool-generate.js'
import { readPaidImageOriginalRequest } from '../services/image-paid-replacement.js'
import { parsePromptCharCap, promptCharacterCount } from '../services/prompt-char-cap.js'

export const router = Router()

// ── Helpers ────────────────────────────────────────────────────────────

async function resolveTitle(slug: string, episodeCode: string): Promise<string> {
  try {
    const ideas = await im.getIdeas(slug, 'accepted')
    return ideas.find(i => i.episode_code === episodeCode)?.title || ''
  } catch { return '' }
}

/**
 * Read the one authoritative narration duration shared with the producer.
 * Returns 0 when nothing is on disk; ambiguity and stale merges fail loudly.
 */
async function readNarrationDurationSec(slug: string, episodeCode: string, title: string): Promise<number> {
  const paths = await resolveEpisodePaths(slug, episodeCode, title)
  const narrationPath = await resolveAuthoritativeBrollNarration(paths, episodeCode)
  if (!narrationPath) return 0
  return await getAudioDuration(narrationPath) || 0
}

type ImagePoolRedoItem = {
  itemKey: string
  prompt: string
  taskId: string
  requestKey: string
  inputHash: string
  evidenceFingerprint: string
  sourceBodyFingerprint: string
  receiptFingerprint: string
  label: string
}

type ManualImagePaymentReceipt = {
  version: 1
  model_id: string
  model_price_version: string
  output_resolution: string
  output_aspect_ratio: string
  output_price_version: string
  confirmed_paid_image: true
}

function readManualImagePaymentReceipt(value: unknown): ManualImagePaymentReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const receipt = value as Record<string, unknown>
  const expected = [
    'confirmed_paid_image', 'model_id', 'model_price_version', 'output_aspect_ratio',
    'output_price_version', 'output_resolution', 'version',
  ]
  if (Object.keys(receipt).sort().join('\0') !== expected.join('\0')
    || receipt.version !== 1 || receipt.confirmed_paid_image !== true) return null
  for (const key of ['model_id', 'model_price_version', 'output_resolution', 'output_aspect_ratio', 'output_price_version']) {
    if (typeof receipt[key] !== 'string' || !(receipt[key] as string).trim()) return null
  }
  return receipt as ManualImagePaymentReceipt
}

function imageEvidenceRequestKey(entry: NonNullable<Job['genstudio_jobs']>[number]): string | null {
  const values = [entry.request_key, entry.request?.idempotency_key]
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
  return values.length && new Set(values).size === 1 ? values[0]! : null
}

function imagePoolSourcePackage(job: Readonly<Job>, poolId: string): {
  runId: string
  prompts: string[]
  variants: number
  model: string
  aspectRatio: string
  resolution?: string
  seed?: number
} | null {
  const params = job.params || {}
  const runId = typeof params.run_id === 'string' ? params.run_id.trim() : ''
  const prompts = Array.isArray(params.prompts)
    ? params.prompts.map((prompt: unknown) => typeof prompt === 'string' ? prompt.trim() : '').filter(Boolean)
    : []
  const model = typeof params.model === 'string' ? params.model.trim() : ''
  const aspectRatio = typeof params.aspect_ratio === 'string' ? params.aspect_ratio.trim() : ''
  const variants = Math.max(1, Math.min(4, Math.floor(Number(params.variants) || 1)))
  if (job.type !== 'image_pool_generate' || job.episode_id !== poolId
    || params.pool_id !== poolId || !runId || path.basename(runId) !== runId
    || !prompts.length || !model || !aspectRatio) return null
  return {
    runId, prompts, variants, model, aspectRatio,
    ...(typeof params.resolution === 'string' && params.resolution.trim() ? { resolution: params.resolution.trim() } : {}),
    ...(Number.isInteger(params.seed) ? { seed: params.seed } : {}),
  }
}

async function currentImagePoolRedoItems(job: Readonly<Job>, pool: { id: string; folder_path: string }): Promise<ImagePoolRedoItem[]> {
  const source = imagePoolSourcePackage(job, pool.id)
  if (!source) return []
  const manifest = await readManifestStrict(pool.folder_path)
  const recovery = job.params?.genstudio_recovery?.assets
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return []
  const preparedReceipts = job.params?.image_pool_generation_receipts
  if (preparedReceipts?.version !== 1 || !preparedReceipts.items
    || typeof preparedReceipts.items !== 'object' || Array.isArray(preparedReceipts.items)) return []
  const sourceBodyFingerprint = freshActionFingerprint({
    pool_id: pool.id,
    prompts: source.prompts,
    model: source.model,
    aspect_ratio: source.aspectRatio,
    ...(source.resolution ? { resolution: source.resolution } : {}),
    ...(source.seed !== undefined ? { seed: source.seed } : {}),
    variants: source.variants,
    run_id: source.runId,
  })
  const items: ImagePoolRedoItem[] = []
  for (let promptIndex = 0; promptIndex < source.prompts.length; promptIndex += 1) {
    for (let variantIndex = 0; variantIndex < source.variants; variantIndex += 1) {
      const index = promptIndex * source.variants + variantIndex
      const itemKey = `gen-${source.runId}-${String(index + 1).padStart(4, '0')}.png`
      if (path.basename(itemKey) !== itemKey) continue
      const entry = manifest.tasks[itemKey]
      const checkpoint = (recovery as Record<string, any>)[itemKey]
      const receipt = preparedReceipts.items[itemKey] as ImagePoolPreparedReceipt | undefined
      const expectedPath = path.resolve(pool.folder_path, itemKey)
      if (!entry || entry.operation !== 'image' || !entry.task_id?.trim()
        || !entry.idempotency_key?.trim() || !entry.input_hash?.trim()
        || !checkpoint || checkpoint.operation !== 'image'
        || checkpoint.job_id !== entry.task_id
        || checkpoint.idempotency_key !== entry.idempotency_key
        || checkpoint.input_hash !== entry.input_hash
        || path.resolve(String(checkpoint.output_path || '')) !== expectedPath
        || !isUnsettledProviderEntry({ state: checkpoint.state })) continue
      if (!receipt || receipt.version !== 1 || receipt.item_key !== itemKey
        || receipt.prompt_index !== promptIndex || receipt.variant_index !== variantIndex
        || receipt.run_id !== source.runId || receipt.variants !== source.variants
        || receipt.model !== source.model || receipt.aspect_ratio !== source.aspectRatio
        || (receipt.requested_resolution || undefined) !== (source.resolution || undefined)
        || receipt.seed !== source.seed || typeof receipt.provider_model_id !== 'string'
        || receipt.provider_model_id !== receipt.provider_model_id.trim()
        || !receipt.provider_model_id || typeof receipt.request_scope !== 'string'
        || (receipt.output_format !== undefined && receipt.output_format !== 'jpeg')) continue
      const selectorMarker = receipt.request_scope.indexOf(':selector:')
      if (selectorMarker < 1) continue
      let expectedReceipt: ImagePoolPreparedReceipt
      try {
        const original = readPaidImageOriginalRequest(entry, pool.folder_path, {
          prompt: source.prompts[promptIndex]!,
          baseScope: receipt.request_scope.slice(0, selectorMarker),
        })
        if (original.selector.aspect_ratio !== receipt.aspect_ratio
          || original.selector.resolution !== receipt.resolution) continue
        expectedReceipt = buildImagePoolPreparedReceipt({
          itemKey,
          promptIndex,
          variantIndex,
          runId: source.runId,
          variants: source.variants,
          model: source.model,
          providerModelId: receipt.provider_model_id,
          prompt: source.prompts[promptIndex]!,
          aspectRatio: source.aspectRatio,
          ...(source.resolution ? { requestedResolution: source.resolution } : {}),
          ...(receipt.resolution ? { resolution: receipt.resolution } : {}),
          ...(source.seed !== undefined ? { seed: source.seed } : {}),
          ...(receipt.output_format ? { outputFormat: receipt.output_format } : {}),
          selector: original.selector,
          baseScope: receipt.request_scope.slice(0, selectorMarker),
          generationIdentity: `image-pool:${pool.id}:${source.runId}`,
        })
      } catch { continue }
      const receiptFingerprint = freshActionFingerprint(receipt)
      if (freshActionFingerprint(expectedReceipt) !== receiptFingerprint
        || receipt.input_hash !== entry.input_hash
        || receipt.idempotency_key !== entry.idempotency_key) continue
      const evidence = (job.genstudio_jobs || []).filter(candidate => candidate.operation === 'image.generation'
        && (candidate.id === entry.task_id || imageEvidenceRequestKey(candidate) === entry.idempotency_key))
      if (evidence.length !== 1 || evidence[0]!.id !== entry.task_id
        || imageEvidenceRequestKey(evidence[0]!) !== entry.idempotency_key
        || !isUnsettledProviderEntry(evidence[0]!)) continue
      const evidenceFingerprint = freshActionFingerprint({
        source_job_id: job.job_id,
        item_key: itemKey,
        task_id: entry.task_id,
        idempotency_key: entry.idempotency_key,
        input_hash: entry.input_hash,
        source_body_fingerprint: sourceBodyFingerprint,
      })
      items.push({
        itemKey,
        prompt: source.prompts[promptIndex]!,
        taskId: entry.task_id,
        requestKey: entry.idempotency_key,
        inputHash: entry.input_hash,
        evidenceFingerprint,
        sourceBodyFingerprint,
        receiptFingerprint,
        label: `Prompt ${promptIndex + 1} · variant ${variantIndex + 1}`,
      })
    }
  }
  return items
}

function imagePoolManualClientFingerprint(
  body: Record<string, unknown>, sourceJobId: string, sourceItemKey: string,
  payment: ManualImagePaymentReceipt,
): string {
  return freshActionFingerprint({
    pool_id: typeof body.pool_id === 'string' ? body.pool_id : '',
    model: typeof body.model === 'string' ? body.model.trim() : '',
    aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio.trim() : '',
    ...(typeof body.resolution === 'string' && body.resolution.trim() ? { resolution: body.resolution.trim() } : {}),
    ...(Number.isInteger(body.seed) ? { seed: body.seed } : {}),
    variants: Math.max(1, Math.min(4, Math.floor(Number(body.variants) || 1))),
    source_item_key: sourceItemKey,
    manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
    manual_image_payment: payment,
  })
}

function acceptedImagePoolManualReplay(
  job: Readonly<Job>, operationId: string, clientFingerprint: string,
  poolId: string, sourceJobId: string, sourceItemKey: string,
): boolean {
  const redo = job.params?.manual_redo
  const action = job.params?.generation_action
  const binding = action?.manual_redo_binding
  return job.type === 'image_pool_generate' && job.episode_id === poolId
    && action?.id === operationId && action?.kind === 'fresh'
    && redo?.version === 1 && redo?.intent === 'replace_unresolved' && redo?.lane === 'image-pool'
    && redo?.source_job_id === sourceJobId && redo?.source_item_key === sourceItemKey
    && redo?.client_request_fingerprint === clientFingerprint
    && binding?.version === 1 && binding?.source_type === 'image_pool_generate'
    && binding?.operation === 'image.generation' && binding?.resource_kind === 'custom'
    && binding?.resource_identity === redo?.resource_identity
    && binding?.destination_type === 'image_pool_generate' && binding?.destination_episode_id === poolId
}

// ── POST /broll/pick ───────────────────────────────────────────────────

router.post('/projects/:slug/broll/pick', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const {
      episode_id,
      pool_id,
      selection_mode = 'random',
      tags = [],
      pacing_mode = 'rotate',
      segment_seconds = 8,
      broll_lookback,
      // v1.0.89+ — manual picks + motion + transition settings. All
      // optional; when absent the renderer falls back to static no-
      // transition output matching the v1.0.88 behaviour.
      manual_selection,        // Array<{ filename, target_duration }>
      motion_mode,             // 'fixed' | 'rotate' | 'random'
      motion_default,          // 'static' | 'zoom-in' | ...
      motion_pool,             // string[] when motion_mode is rotate/random
      transition_id,           // 'none' | 'crossfade' | ... (TransitionDef id)
      transition_duration,     // 0.1 - 2.0 seconds
    } = req.body || {}

    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })
    const effectivePoolId = pool_id || (config as any).broll_pool_id
    if (!effectivePoolId) {
      return res.status(400).json({ detail: 'No B-Roll pool subscribed. Pick one on the B-Roll Picker page or pass pool_id in the request body.' })
    }

    const pool = await bp.getPool(effectivePoolId)
    if (!pool) return res.status(404).json({ detail: `Pool '${effectivePoolId}' not found` })
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — plug in the SSD at ${pool.folder_path} before generating a selection.` })
    }

    const title = await resolveTitle(slug, episode_id)
    const narrationSec = await readNarrationDurationSec(slug, episode_id, title)
    if (!narrationSec) {
      // Format-aware copy: broll-narration is single-chapter so audio-
      // merge usually isn't needed; sleep-story / reasons-explainer hits
      // this same code path though, so mention merge when narration is
      // expected to be multi-chapter. Either way the action is the same:
      // run Audio Generator first.
      return res.status(400).json({
        detail: `No narration audio found for ${episode_id}. Run the Audio Generator first — the B-Roll selector sizes the sequence to match narration duration, so audio has to exist before clips can be picked.`,
      })
    }

    const clips = await bp.listClips(effectivePoolId, { includeMissing: false })

    // Cross-episode repeat avoidance — exclude shas from the configured
    // lookback window. lookback=0 means no cross-episode exclusion.
    const effectiveLookback = typeof broll_lookback === 'number'
      ? broll_lookback
      : ((config as any).broll_lookback ?? 10)
    const usageLog: BrollUsageEntry[] = Array.isArray((config as any).broll_usage_log)
      ? (config as any).broll_usage_log
      : []
    // Last N distinct episodes (not log entries — one entry per clip).
    const recentShas = recentlyUsedClipShas(usageLog, effectiveLookback, episode_id)

    // Manual mode short-circuits the selector entirely — the caller has
    // already chosen the clips + per-clip durations in the UI. We still
    // validate every filename exists in the pool so a typo or stale
    // sidecar can't blow up the assembly run later. Repeat-avoidance is
    // user's call in manual mode; we don't second-guess it.
    let result: { selection: any[]; warnings: string[]; pool_size_after_filter: number }
    if (selection_mode === 'manual' && Array.isArray(manual_selection) && manual_selection.length) {
      const bySha = new Map(clips.map(c => [c.filename, c]))
      const valid: any[] = []
      const missing: string[] = []
      for (const entry of manual_selection) {
        const c = bySha.get(entry.filename)
        if (!c) { missing.push(entry.filename); continue }
        const requested = typeof entry.target_duration === 'number'
          ? Math.max(0.5, Math.min(c.duration, entry.target_duration))
          : Math.min(c.duration, 15)
        valid.push({ filename: c.filename, sha256: c.sha256, target_duration: requested })
      }
      const warnings: string[] = []
      if (missing.length) warnings.push(`Skipped ${missing.length} clip(s) not present in the pool: ${missing.slice(0, 5).join(', ')}`)
      result = { selection: valid, warnings, pool_size_after_filter: clips.length }
    } else {
      result = selectBroll({
        pool: clips.map(c => ({
          filename: c.filename,
          duration: c.duration,
          sha256: c.sha256,
          tags: c.tags || [],
          normalized: c.normalized,
          missing: c.missing,
        })),
        target_duration: narrationSec,
        selection_mode,
        tags,
        pacing_mode,
        segment_seconds,
        exclude_shas: recentShas,
      })
    }

    // Validate motion settings. Unknown ids fall back to 'static' rather
    // than failing the call — selector behaviour shouldn't gate on a
    // typo in a UI setting.
    const validMotions = new Set(['static', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'])
    const safeMotion = (s: any): string => (typeof s === 'string' && validMotions.has(s)) ? s : 'static'
    const safeMotionMode = (motion_mode === 'rotate' || motion_mode === 'random') ? motion_mode : 'fixed'
    const safeMotionPool = Array.isArray(motion_pool)
      ? motion_pool.map(safeMotion).filter((m: string) => m !== 'static' || motion_pool.length === 1)
      : ['static']
    const safeTransitionDur = typeof transition_duration === 'number'
      ? Math.max(0.1, Math.min(2.0, transition_duration))
      : 0.5

    await saveSelectionSidecar(slug, episode_id, title, {
      schema_version: 1,
      episode_code: episode_id,
      pool_id: effectivePoolId,
      selection_mode,
      pacing_mode,
      segment_seconds,
      tags,
      broll_volume: typeof req.body?.broll_volume === 'number' ? req.body.broll_volume : 0,
      selection: result.selection,
      target_duration: narrationSec,
      generated_at: new Date().toISOString(),
      warnings: result.warnings,
      motion_mode: safeMotionMode,
      motion_default: safeMotion(motion_default),
      motion_pool: safeMotionPool.length ? safeMotionPool : ['static'],
      transition_id: typeof transition_id === 'string' ? transition_id : 'none',
      transition_duration: safeTransitionDur,
    })
    // The repeat-avoidance window is a project setting: remember the last one used.
    if (typeof broll_lookback === 'number' && broll_lookback >= 0 && broll_lookback !== (config as any).broll_lookback) {
      await pm.updateConfig(slug, { broll_lookback } as any)
    }

    res.json({
      selection: result.selection.map(s => ({
        ...s,
        pool_id: effectivePoolId,
      })),
      target_duration: narrationSec,
      pool_size_after_filter: result.pool_size_after_filter,
      warnings: result.warnings,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'B-Roll selection failed'))
  }
})

// ── GET /broll/selection/:episode_id ───────────────────────────────────
// The episode's saved B-Roll pick (or `selection: null`), so the picker page
// shows what Assemble will render after a reload or an episode switch.
// Image Pool picks share the file but are not B-Roll, so they read as none.
router.get('/projects/:slug/broll/selection/:episode_id', async (req, res) => {
  const { slug, episode_id } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const sidecar = await getSelectionSidecar(slug, episode_id, await resolveTitle(slug, episode_id))
    if (!sidecar || sidecar.media === 'image' || (sidecar.episode_code && sidecar.episode_code !== episode_id)) {
      return res.json({ episode_id, selection: null })
    }
    res.json({
      ...sidecar,
      episode_id,
      selection: sidecar.selection.map(s => ({ ...s, pool_id: sidecar.pool_id })),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read the saved B-Roll pick'))
  }
})

// ── POST /image-pool/pick ──────────────────────────────────────────────
// v1.0.404 — Image Pool (slideshow) selection. Reuses the B-Roll selector in
// 'timed' pacing (N seconds per image) sized to narration length, with
// cross-episode no-repeat from a SEPARATE image usage log + the pool's own
// dedup window. Writes the shared selection sidecar, stamped media:'image' so
// the assembler picks the still-image path.
router.post('/projects/:slug/image-pool/pick', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const { episode_id, pool_id, tags = [], selection_mode = 'random', seconds_per_image, dedup_lookback } = req.body || {}
    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })

    const effectivePoolId = pool_id || (config as any).image_pool_id
    if (!effectivePoolId) {
      return res.status(400).json({ detail: 'No image pool selected. Pass pool_id (or set one on the project).' })
    }

    const pool = await bp.getPool(effectivePoolId)
    if (!pool) return res.status(404).json({ detail: `Pool '${effectivePoolId}' not found` })
    if (bp.poolMedia(pool) !== 'image') {
      return res.status(400).json({ detail: `Pool '${effectivePoolId}' is a video pool — pick an Image Pool for the slideshow.` })
    }
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — connect ${pool.folder_path} before picking images.` })
    }

    const ss = pool.slideshow || bp.defaultSlideshowSettings()
    const perImage = Math.max(1, Number(seconds_per_image) || ss.seconds_per_image)
    const lookback = Math.max(0, typeof dedup_lookback === 'number' ? dedup_lookback : ss.dedup_lookback)

    const title = await resolveTitle(slug, episode_id)
    const narrationSec = await readNarrationDurationSec(slug, episode_id, title)
    if (!narrationSec) {
      return res.status(400).json({ detail: `No narration audio found for ${episode_id}. Run the Audio Generator first — the slideshow is sized to narration length.` })
    }

    const clips = await bp.listClips(effectivePoolId, { includeMissing: false })

    // Separate usage log so image dedup is independent of B-Roll's. lookback=0
    // disables cross-episode exclusion. Usage is recorded at assemble time.
    const usageLog: BrollUsageEntry[] = Array.isArray((config as any).image_pool_usage_log)
      ? (config as any).image_pool_usage_log
      : []
    const recentShas = recentlyUsedClipShas(usageLog, lookback, episode_id)

    const mode = (selection_mode === 'tagged' || selection_mode === 'themed') ? selection_mode : 'random'
    const result = selectBroll({
      pool: clips.map(c => ({
        filename: c.filename,
        // Stills have duration 0; give the selector the per-image seconds so
        // 'timed' pacing has a sane non-zero segment to work with.
        duration: c.duration || perImage,
        sha256: c.sha256,
        tags: c.tags || [],
        normalized: c.normalized,
        missing: c.missing,
      })),
      target_duration: narrationSec,
      selection_mode: mode,
      tags,
      pacing_mode: 'timed',
      segment_seconds: perImage,
      exclude_shas: recentShas,
    })

    await saveSelectionSidecar(slug, episode_id, title, {
      schema_version: 1,
      episode_code: episode_id,
      pool_id: effectivePoolId,
      media: 'image',
      fit: ss.fit,
      selection_mode: mode,
      pacing_mode: 'timed',
      segment_seconds: perImage,
      tags,
      broll_volume: 0,  // stills are silent; narration + music come from merged audio
      selection: result.selection,
      target_duration: narrationSec,
      generated_at: new Date().toISOString(),
      warnings: result.warnings,
      // Slow Ken Burns when motion is on: a varied pool of gentle zoom/pan.
      motion_mode: ss.motion ? 'random' : 'fixed',
      motion_default: ss.motion ? 'zoom-in' : 'static',
      motion_pool: ss.motion ? ['zoom-in', 'zoom-out', 'pan-left', 'pan-right'] : ['static'],
      transition_id: ss.transition_sec > 0 ? 'crossfade' : 'none',
      transition_duration: ss.transition_sec > 0 ? ss.transition_sec : 0.5,
    })

    res.json({
      selection: result.selection.map(s => ({ ...s, pool_id: effectivePoolId })),
      target_duration: narrationSec,
      images: result.selection.length,
      seconds_per_image: perImage,
      dedup_lookback: lookback,
      pool_size_after_filter: result.pool_size_after_filter,
      warnings: result.warnings,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Image Pool selection failed'))
  }
})

router.get('/projects/:slug/image-pool/manual-redo-sources', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const poolId = typeof req.query.pool_id === 'string' ? req.query.pool_id : ''
    const pool = poolId ? await bp.getPool(poolId) : null
    if (!pool || bp.poolMedia(pool) !== 'image') return res.status(404).json({ detail: 'Image pool not found' })
    const sources: Array<{ source_job_id: string; item_key: string; label: string; finished_at?: string }> = []
    const jobs = await jq.findJobs(slug, job => job.type === 'image_pool_generate' && job.episode_id === poolId)
    for (const job of jobs) {
      if (job.status !== 'error' && job.status !== 'cancelled') continue
      let items: ImagePoolRedoItem[] = []
      try { items = await currentImagePoolRedoItems(job, pool) } catch { continue }
      for (const item of items) {
        sources.push({
          source_job_id: job.job_id,
          item_key: item.itemKey,
          label: item.label,
          ...(job.finished_at ? { finished_at: job.finished_at } : {}),
        })
      }
    }
    res.json({ sources })
  } catch (e: any) {
    res.status(e?.status || e?.statusCode || 500).json(humanizeBackendError(e, 'Could not read Image Pool replacement sources'))
  }
})

// ── POST /image-pool/generate ──────────────────────────────────────────
// v1.0.410 — grow an Image Pool by generating new stills from prompts and
// dropping them into the pool folder (then indexing them). Runs in this
// project's context so config.image_models + API keys resolve.
router.post('/projects/:slug/image-pool/generate', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
      ? req.body as Record<string, unknown>
      : {}
    let manualRedo
    try {
      manualRedo = readManualGenerationRedoIntent(body)
    } catch (error) {
      return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid manual replacement.' })
    }
    const poolId = typeof body.pool_id === 'string' ? body.pool_id : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (manualRedo) {
      let operationId: string
      try {
        operationId = readOperationId(body, true)!
      } catch (error) {
        return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
      }
      const sourceItemKey = typeof body.source_item_key === 'string' ? body.source_item_key.trim() : ''
      if (!poolId || !model) return res.status(400).json({ detail: 'pool_id and model are required' })
      if (!sourceItemKey) return res.status(409).json({ detail: 'Choose exactly one unresolved Image Pool item.' })
      if (Object.prototype.hasOwnProperty.call(body, 'prompts')) {
        return res.status(400).json({ detail: 'Manual replacement prompts are derived from the selected source item.' })
      }
      const payment = readManualImagePaymentReceipt(body.manual_image_payment)
      if (!payment) return res.status(409).json({ detail: 'Confirm the exact current published image price before creating another version.' })
      const clientFingerprint = imagePoolManualClientFingerprint(body, manualRedo.source_job_id, sourceItemKey, payment)
      return withLock(`fresh-image-pool:${slug}:${operationId}`, async () => {
        const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
        if (previous) {
          if (!acceptedImagePoolManualReplay(previous, operationId, clientFingerprint,
            poolId, manualRedo.source_job_id, sourceItemKey)) {
            return res.status(409).json({ detail: 'This operation_id already belongs to a different Image Pool action.' })
          }
          return res.status(200).json({ job_id: previous.job_id, status: previous.status, reused: true })
        }

        const pool = await bp.getPool(poolId)
        if (!pool) return res.status(404).json({ detail: `Pool '${poolId}' not found` })
        if (bp.poolMedia(pool) !== 'image') return res.status(400).json({ detail: `Pool '${poolId}' is not an image pool` })
        if (!existsSync(pool.folder_path)) {
          return res.status(409).json({ detail: `Pool folder offline — connect ${pool.folder_path} first.` })
        }
        const source = (await jq.findJobs(slug, job => job.job_id === manualRedo.source_job_id))[0]
        let sourceItems: ImagePoolRedoItem[] = []
        try { if (source) sourceItems = await currentImagePoolRedoItems(source, pool) } catch {
          return res.status(409).json({ detail: 'The selected Image Pool source manifest is unavailable or invalid.' })
        }
        const item = sourceItems.find(candidate => candidate.itemKey === sourceItemKey)
        if (!source || !item) {
          return res.status(409).json({ detail: 'The selected item has no exact unresolved Image Pool evidence.' })
        }

        const apiKey = await getApiKey('genstudio').catch(() => '')
        if (!apiKey) return res.status(409).json({ detail: 'The current published image catalogue is unavailable.' })
        const catalogSnapshot = await listImageModelsForceLive(apiKey)
        if (catalogSnapshot.freshness !== 'live' || catalogSnapshot.stale) {
          return res.status(409).json({ detail: 'The current published image catalogue could not be verified live.' })
        }
        const catalog = catalogSnapshot.value
        const selectedModel = findGenStudioProduct(catalog, model)
        if (!selectedModel) return res.status(409).json({ detail: 'The selected image model is not currently published.' })
        const availability = publishedAvailabilityProblem(selectedModel)
        if (availability) return res.status(409).json({ detail: availability })
        let aspectRatio: string
        let outputOption
        try {
          aspectRatio = resolvePublishedAspectRatio(selectedModel,
            typeof body.aspect_ratio === 'string' ? body.aspect_ratio : undefined)
          outputOption = resolvePublishedOutputOption(selectedModel, aspectRatio,
            typeof body.resolution === 'string' ? body.resolution : undefined)
        } catch (error) {
          return res.status(409).json({ detail: error instanceof Error ? error.message : 'The published output option changed.' })
        }
        if (!outputOption || payment.model_id !== model || payment.model_id !== selectedModel.id
          || payment.model_price_version !== selectedModel.price_version
          || payment.output_resolution !== outputOption.resolution
          || payment.output_aspect_ratio !== outputOption.aspect_ratio
          || payment.output_price_version !== outputOption.price_version) {
          return res.status(409).json({ detail: 'The published image price or output option changed. Review it and confirm again.' })
        }
        const promptCap = parsePromptCharCap(selectedModel.max_prompt_characters)
        const promptCharacters = promptCharacterCount(item.prompt)
        if (promptCap && promptCharacters > promptCap) {
          return res.status(409).json({
            detail: `${selectedModel.display_name} accepts up to ${promptCap.toLocaleString()} prompt characters; `
              + `the selected source prompt is ${promptCharacters.toLocaleString()}. Choose another model.`,
          })
        }
        const minReferences = Number.isInteger(selectedModel.min_reference_images)
          ? Math.max(0, Number(selectedModel.min_reference_images))
          : 0
        if (minReferences > 0) {
          return res.status(409).json({
            detail: `${selectedModel.display_name} requires at least ${minReferences} reference image${minReferences === 1 ? '' : 's'}; `
              + 'this Image Pool action copies a text prompt without reference images. Choose a text-to-image model.',
          })
        }
        const variants = Math.max(1, Math.min(4, Math.floor(Number(body.variants) || 1)))
        const resourceIdentity = `image-pool:${poolId}:${item.itemKey}:${item.evidenceFingerprint}`
        const params = stampFreshGenerationAction({
          pool_id: poolId,
          prompts: [item.prompt],
          model,
          aspect_ratio: aspectRatio,
          ...(outputOption ? { resolution: outputOption.resolution } : {}),
          ...(selectedModel.supports_seed !== false && Number.isInteger(body.seed) ? { seed: body.seed } : {}),
          variants,
          run_id: `manual-${operationId}`,
          manual_redo: {
            version: 1 as const,
            intent: manualRedo.intent,
            source_job_id: source.job_id,
            source_item_key: item.itemKey,
            lane: 'image-pool',
            source_body_fingerprint: item.sourceBodyFingerprint,
            evidence_fingerprint: item.evidenceFingerprint,
            client_request_fingerprint: clientFingerprint,
            resource_identity: resourceIdentity,
            requested_at: new Date().toISOString(),
            published_price: {
              model_id: selectedModel.id,
              model_price_version: selectedModel.price_version,
              model_credits_per_image: selectedModel.credits_per_image,
              output_price_version: outputOption?.price_version,
              output_credits_per_image: outputOption?.credits_per_image,
            },
          },
        }, operationId)
        try {
          const job = await jq.enqueueManualGenerationRedo({
            project_slug: slug,
            type: 'image_pool_generate' as JobType,
            episode_id: poolId,
            title: `Image Pool separate attempt — ${item.label}`,
            params,
          }, {
            sourceJobId: source.job_id,
            sourceType: 'image_pool_generate' as JobType,
            operation: 'image.generation',
            resource: {
              kind: 'custom',
              identity: resourceIdentity,
              matches: candidate => {
                const current = imagePoolSourcePackage(candidate, poolId)
                return !!current && freshActionFingerprint({
                  pool_id: poolId,
                  prompts: current.prompts,
                  model: current.model,
                  aspect_ratio: current.aspectRatio,
                  ...(current.resolution ? { resolution: current.resolution } : {}),
                  ...(current.seed !== undefined ? { seed: current.seed } : {}),
                  variants: current.variants,
                  run_id: current.runId,
                }) === item.sourceBodyFingerprint
              },
            },
            sourceLabel: 'Image Pool generation item',
            evidenceLabel: 'Gateway image request',
            hasCurrentEvidence: (candidate, entries) => {
              const checkpoint = candidate.params?.genstudio_recovery?.assets?.[item.itemKey]
              const currentReceipt = candidate.params?.image_pool_generation_receipts?.items?.[item.itemKey]
              const matches = entries.filter(entry => entry.id === item.taskId
                || imageEvidenceRequestKey(entry) === item.requestKey)
              return checkpoint?.operation === 'image'
                && checkpoint.job_id === item.taskId
                && checkpoint.idempotency_key === item.requestKey
                && checkpoint.input_hash === item.inputHash
                && freshActionFingerprint(currentReceipt) === item.receiptFingerprint
                && matches.length === 1 && matches[0]!.id === item.taskId
                && imageEvidenceRequestKey(matches[0]!) === item.requestKey
                && isUnsettledProviderEntry(matches[0]!)
            },
          })
          return res.status(201).json({ job_id: job.job_id, status: job.status })
        } catch (error: any) {
          return res.status(error?.status || error?.statusCode || 409).json({
            detail: error?.message || 'The separate Image Pool attempt was refused.',
          })
        }
      })
    }
    const prompts = Array.isArray(body.prompts)
      ? body.prompts.map((p: any) => String(p || '').trim()).filter(Boolean)
      : []
    if (!poolId) return res.status(400).json({ detail: 'pool_id is required' })
    if (!model) return res.status(400).json({ detail: 'model is required' })
    if (!prompts.length) return res.status(400).json({ detail: 'At least one prompt is required' })

    const pool = await bp.getPool(poolId)
    if (!pool) return res.status(404).json({ detail: `Pool '${poolId}' not found` })
    if (bp.poolMedia(pool) !== 'image') return res.status(400).json({ detail: `Pool '${poolId}' is not an image pool` })
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — connect ${pool.folder_path} first.` })
    }
    // One generate run per pool at a time (it appends files + rescans).
    if (jq.isDuplicate(slug, poolId, 'image_pool_generate' as JobType)) {
      return res.status(409).json({ detail: `Generation already running for pool ${pool.name}` })
    }

    const job = await jq.enqueue({
      project_slug: slug,
      type: 'image_pool_generate' as JobType,
      episode_id: poolId,  // pool id threaded via the episode slot (app-level target)
      title: `Generate ${prompts.length} image(s) → ${pool.name}`,
      params: {
        pool_id: poolId,
        prompts,
        model,
        // Absent/blank is MISSING, not 16:9: the image resolver applies the
        // shared Story default against the live catalogue.
        ...(typeof body.aspect_ratio === 'string' && body.aspect_ratio.trim()
          ? { aspect_ratio: body.aspect_ratio.trim() }
          : {}),
        ...(typeof body.resolution === 'string' ? { resolution: body.resolution } : {}),
        seed: Number.isInteger(body.seed) ? body.seed : undefined,
        variants: Number.isFinite(Number(body.variants)) ? Number(body.variants) : 1,
        run_id: typeof body.run_id === 'string' ? body.run_id : undefined,
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Image generation failed to queue'))
  }
})

/**
 * Read the suggested prompts out of one answer.
 *
 * Tolerant on purpose, in this order: the JSON array (which the declared
 * contract now wraps in `{"prompts": [...]}` — slicing from the first `[` to
 * the last `]` reaches it either way), then a plain line-split for an answer
 * that arrived as text anyway. Exported so the contract and this reader are
 * tested against the same payload.
 */
export function parseSuggestedPrompts(raw: string, count: number): string[] {
  let prompts: string[] = []
  const s = String(raw || '').trim()
  const a = s.indexOf('['); const b = s.lastIndexOf(']')
  if (a >= 0 && b > a) {
    try {
      const arr = JSON.parse(s.slice(a, b + 1))
      if (Array.isArray(arr)) prompts = arr.filter((x: any) => typeof x === 'string')
    } catch { /* fall through to line split */ }
  }
  if (!prompts.length) {
    prompts = s.split('\n').map(l => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean)
  }
  return prompts.map(p => p.trim()).filter(Boolean).slice(0, count)
}

// ── POST /image-pool/suggest-prompts ───────────────────────────────────
// v1.0.410 — LLM helper: turn a short topic into a list of image prompts the
// user can review/edit before generating. Uses the project's text-model key
// resolution (callAi tiers). Returns { prompts: string[] }.
router.post('/projects/:slug/image-pool/suggest-prompts', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const body = req.body || {}
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const count = Math.max(1, Math.min(50, Math.floor(Number(body.count) || 10)))
    if (!topic) return res.status(400).json({ detail: 'topic is required' })
    if (!model) return res.status(400).json({ detail: 'model is required' })

    const { callAi, callAiWithRetry } = await import('../lib/ai-client.js')
    const system = 'You write concise, vivid text-to-image prompts. Output ONLY a JSON object of the form {"prompts": ["…", "…"]} — no prose, no numbering, no code fence.'
    const user = `Write ${count} distinct text-to-image prompts for: "${topic}". `
      + `Each prompt is one self-contained sentence describing a single image (subject, setting, mood, lighting). `
      + `Vary the scenes so a slideshow of them feels diverse. Put all ${count} strings in the "prompts" array.`
    // Standard: a JSON object carrying N self-contained image prompts.
    const raw = await callAiWithRetry(model, system, user, {}, false, {
      slug, outputBudget: 'standard',
      // Declared because the route reads the array out of the answer. The
      // line-splitting fallback below stays, but it is a safety net now rather
      // than the thing this route quietly relies on.
      outputContract: imagePoolPromptsOutputContract(),
    })

    const prompts = parseSuggestedPrompts(raw, count)
    if (!prompts.length) return res.status(502).json({ detail: 'The model returned no usable prompts — try again or a different model.' })
    res.json({ prompts })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Prompt suggestion failed'))
  }
})

// ── POST /broll/assemble ───────────────────────────────────────────────

router.post('/projects/:slug/broll/assemble', async (req, res) => {
  const { slug } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    // v1.0.127+ — subtitles_enabled + subtitles_style flow through to the
    // executor's job params. Both optional; missing → defaults applied
    // inside broll-assemble (enabled=true preserves legacy behaviour for
    // any caller that didn't update; style absent → no force_style).
    const {
      episode_id,
      broll_volume = 0,
      subtitles_enabled,
      subtitles_style,
    } = req.body || {}
    if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })

    const title = await resolveTitle(slug, episode_id)
    const sidecar = await getSelectionSidecar(slug, episode_id, title)
    if (!sidecar || !sidecar.selection?.length) {
      return res.status(400).json({ detail: 'No B-Roll selection on disk for this episode. Click "Pick B-Roll" first.' })
    }

    if (jq.isDuplicate(slug, episode_id, 'broll_assemble' as JobType)) {
      return res.status(409).json({ detail: `B-Roll assembly already queued/running for ${episode_id}` })
    }

    const job = await jq.enqueue({
      project_slug: slug,
      type: 'broll_assemble' as JobType,
      episode_id,
      title: `Assemble B-Roll Video — ${episode_id}`,
      params: {
        episode_id,
        title,
        broll_volume,
        // Forward optional subtitle controls; broll-assemble defaults to
        // enabled=true + no style override when these are absent.
        ...(typeof subtitles_enabled === 'boolean' ? { subtitles_enabled } : {}),
        ...(subtitles_style ? { subtitles_style } : {}),
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'B-Roll assembly failed to queue'))
  }
})
