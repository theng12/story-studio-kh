/**
 * The timeline's render path (v1.4.402) — dispatch, reuse, assemble.
 *
 * One queue job per segment (`timeline_image` / `timeline_sketch` /
 * `timeline_chart` / `timeline_stock` / `timeline_video`) produced by the
 * existing media paths (Gateway image/video clients, the local chart
 * renderer, the footage library), then one local FFmpeg job
 * (`timeline_assemble`) that puts them together in timeline order, each
 * segment trimmed or looped to its exact duration.
 *
 * Durable state lives beside the timeline in `episode-timeline-render.json`:
 * a segment that reached `done` with an output still on disk is REUSED on the
 * next dispatch, never re-bought, and its provider request identity (persisted
 * before the charged POST) makes a crash-replay the same Gateway job instead
 * of a second charge. `credits: null` from the shared preflight quote blocks
 * the render entirely — a render must know what it charges.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { probeForUpload } from '../lib/ffprobe-check.js'
import { resolveRenderCanvas } from '../lib/render-canvas.js'
import { downloadVideo } from '../lib/download-video.js'
import { stageGenStudioImage } from '../lib/genstudio-artifacts.js'
import {
  buildGenStudioImageIdempotencyKey,
  buildGenStudioVideoIdempotencyKey,
  generateImageWithGenStudio,
  generateVideoWithGenStudio,
  GenStudioTerminalFailureError,
  listImageModelsSnapshot,
  listVideoModelsSnapshot,
  variantsForGenStudioVideoOperation,
  type GenStudioImageModel,
  type GenStudioVideoModel,
  type GenStudioVideoVariant,
} from '../lib/genstudio-client.js'
import { renderChartPng } from './chart-render.js'
import { fetchFootage, resolveFootage } from './footage-library.js'
import { readEpisodeTimeline } from './episode-timeline.js'
import { readScenePlanForEpisode } from './local-screening-episode-reader.js'
import { resolveEpisodePathsByCode } from './utils.js'
import { getApiKey } from './app-secrets-store.js'
import { DuplicateJobError, checkpointJobState, enqueue, isCancelled } from './job-queue.js'
import { resolveSceneImageReadPath } from '../generators/scene-image.js'
import type { Job, JobType } from '../models/types.js'
import type {
  EpisodeTimeline,
  EpisodeTimelineSegment,
  TimelineMediaType,
} from '../contracts/episode-timeline.js'

export const EPISODE_TIMELINE_RENDER_SIDECAR = 'episode-timeline-render.json'
/** The assembler's frame rate — mirrors `DEFAULT_FPS` in generators/video.ts. */
const ASSEMBLE_FPS = 30
/** Provider states after which the next attempt must buy under a new identity. */
const TERMINAL_REQUEST_STATES: ReadonlySet<string> = new Set(['failed', 'artifact_expired'])

export type TimelineSegmentRenderStatus = 'rendering' | 'done' | 'error'

export interface TimelineSegmentRenderRequest {
  input_hash: string
  idempotency_key: string
  attempt: number
  task_id?: string
  last_state?: string
}

export interface TimelineSegmentRenderRecord {
  media_type: TimelineMediaType
  fingerprint: string
  status: TimelineSegmentRenderStatus
  output_path?: string
  error?: string
  /** What the Gateway actually settled for this segment; `null` when not checked. */
  charged_credits?: number | null
  request?: TimelineSegmentRenderRequest
  updated_at: string
}

export interface TimelineAssemblyRenderRecord {
  fingerprint: string
  status: 'done' | 'error'
  output_path?: string
  error?: string
  updated_at: string
}

export interface TimelineRenderState {
  schema_version: 1
  episode_id: string
  segments: Record<string, TimelineSegmentRenderRecord>
  assembly?: TimelineAssemblyRenderRecord
}

async function statePath(slug: string, episodeId: string): Promise<string> {
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  return path.join(paths.episode_dir, EPISODE_TIMELINE_RENDER_SIDECAR)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

export async function readTimelineRenderState(slug: string, episodeId: string): Promise<TimelineRenderState> {
  try {
    const raw = JSON.parse(await fs.readFile(await statePath(slug, episodeId), 'utf8'))
    if (raw && typeof raw === 'object' && raw.schema_version === 1) return raw as TimelineRenderState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { schema_version: 1, episode_id: episodeId, segments: {} }
}

/** Read–modify–write under the episode's render lock; every writer goes through here. */
export async function updateTimelineRenderState(
  slug: string,
  episodeId: string,
  mutate: (state: TimelineRenderState) => void,
): Promise<TimelineRenderState> {
  return withLock(`timeline-render:${slug}:${episodeId}`, async () => {
    const state = await readTimelineRenderState(slug, episodeId)
    mutate(state)
    const filePath = await statePath(slug, episodeId)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await writeJsonAtomic(filePath, state, { mode: 0o644 })
    return state
  })
}

/** Segment outputs live here — episode-local, next to the timeline sidecar. */
export async function timelineRenderDir(slug: string, episodeId: string): Promise<string> {
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  return path.join(paths.episode_dir, 'timeline-render')
}

/**
 * The segment's identity for reuse: its editorial content, plus the image
 * model for a still (that model is part of what was bought for it). The video
 * model is chosen live at execution and is not part of the identity — a
 * catalogue change never re-buys a finished segment.
 */
export function fingerprintSegment(segment: EpisodeTimelineSegment, imageModelId?: string): string {
  return createHash('sha256').update(JSON.stringify({
    media_type: segment.media_type,
    start_sec: segment.start_sec,
    end_sec: segment.end_sec,
    prompt: segment.prompt ?? null,
    motion_prompt: segment.motion_prompt ?? null,
    chart: segment.chart ?? null,
    footage_sha256: segment.footage_sha256 ?? null,
    ...(segment.media_type === 't2i' ? { image_model_id: imageModelId ?? null } : {}),
  })).digest('hex')
}

export function timelineSegmentJobType(mediaType: TimelineMediaType): JobType {
  switch (mediaType) {
    case 't2i': return 'timeline_image'
    case 'sketch': return 'timeline_sketch'
    case 'chart': return 'timeline_chart'
    case 'stock': return 'timeline_stock'
    default: return 'timeline_video'
  }
}

export function timelineVideoOperation(mediaType: TimelineMediaType): 'text-to-video' | 'image-to-video' {
  return mediaType === 't2v' ? 'text-to-video' : 'image-to-video'
}

function clockSec(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function segmentWhere(timeline: EpisodeTimeline, segment: EpisodeTimelineSegment): string {
  const index = timeline.segments.indexOf(segment)
  return `Segment ${index + 1} (${clockSec(segment.start_sec)}–${clockSec(segment.end_sec)})`
}

// ── The video buy the preflight quotes and the executor charges ─────────────
/**
 * The cheapest published variant for this operation across available models.
 * Assembly loops a shorter clip to the segment's exact duration, so duration
 * does not gate the buy — the published price is the only deciding row.
 * `null` means the Gateway currently publishes no buyable row.
 */
export function selectTimelineVideoBuy(
  videos: readonly GenStudioVideoModel[],
  operation: string,
): { model: GenStudioVideoModel; variant: GenStudioVideoVariant } | null {
  const candidates: Array<{ model: GenStudioVideoModel; variant: GenStudioVideoVariant }> = []
  for (const model of videos) {
    if (!model.available) continue
    for (const variant of variantsForGenStudioVideoOperation(model.variants, operation)) {
      if (variant.duration_seconds > 0 && variant.credits_per_video >= 0) {
        candidates.push({ model, variant })
      }
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) =>
    a.variant.credits_per_video - b.variant.credits_per_video
    || b.variant.duration_seconds - a.variant.duration_seconds
    || a.model.id.localeCompare(b.model.id))
  return candidates[0]!
}

// ── Dispatch ────────────────────────────────────────────────────────────────
export interface TimelineDispatchResult {
  dispatched: Array<{ segment_id: string; media_type: TimelineMediaType; job_type: JobType; job_id: string }>
  reused: string[]
  already_queued: string[]
}

/**
 * One job per segment that still needs work. A `done` segment whose fingerprint
 * matches and whose output is still on disk is reused; a segment already
 * queued/running under the same id is reported, never double-enqueued.
 */
export async function dispatchTimelineSegments(
  slug: string,
  episodeId: string,
  options: { image_model_id: string; segment_ids?: string[] },
): Promise<TimelineDispatchResult> {
  const timeline = await readEpisodeTimeline(slug, episodeId)
  if (!timeline) {
    throw Object.assign(
      new Error('This episode has no timeline yet — build it from the scene plan first.'),
      { statusCode: 404, expose: true },
    )
  }
  const wanted = options.segment_ids?.length ? new Set(options.segment_ids) : null
  const state = await readTimelineRenderState(slug, episodeId)
  const result: TimelineDispatchResult = { dispatched: [], reused: [], already_queued: [] }
  for (const segment of timeline.segments) {
    if (wanted && !wanted.has(segment.id)) continue
    const fingerprint = fingerprintSegment(segment, options.image_model_id)
    const record = state.segments[segment.id]
    if (
      record?.status === 'done'
      && record.fingerprint === fingerprint
      && record.output_path
      && await fileExists(record.output_path)
    ) {
      result.reused.push(segment.id)
      continue
    }
    const type = timelineSegmentJobType(segment.media_type)
    try {
      const job = await enqueue({
        project_slug: slug,
        type,
        episode_id: episodeId,
        title: `Timeline ${segment.media_type} ${clockSec(segment.start_sec)}–${clockSec(segment.end_sec)}`,
        params: {
          segment_id: segment.id,
          media_type: segment.media_type,
          ...(segment.media_type === 't2i' ? { image_model_id: options.image_model_id } : {}),
        },
        dedupeParams: params => params?.segment_id === segment.id,
      })
      result.dispatched.push({
        segment_id: segment.id,
        media_type: segment.media_type,
        job_type: type,
        job_id: job.job_id,
      })
    } catch (error) {
      if (error instanceof DuplicateJobError) {
        result.already_queued.push(segment.id)
        continue
      }
      throw error
    }
  }
  return result
}

function assemblyFingerprint(timeline: EpisodeTimeline, state: TimelineRenderState): string {
  return createHash('sha256').update(JSON.stringify(
    timeline.segments.map(segment => [segment.id, state.segments[segment.id]?.fingerprint ?? 'missing']),
  )).digest('hex')
}

/**
 * Queue the one assembly job once every segment has its output on disk and the
 * assembly is missing, stale (a segment re-rendered) or previously failed.
 * Duplicate races collapse into `DuplicateJobError`, which is a no-op here.
 */
export async function maybeEnqueueTimelineAssembly(slug: string, episodeId: string): Promise<boolean> {
  const timeline = await readEpisodeTimeline(slug, episodeId)
  if (!timeline) return false
  const state = await readTimelineRenderState(slug, episodeId)
  for (const segment of timeline.segments) {
    const record = state.segments[segment.id]
    if (!record || record.status !== 'done' || !record.output_path || !(await fileExists(record.output_path))) {
      return false
    }
  }
  const fingerprint = assemblyFingerprint(timeline, state)
  const assembly = state.assembly
  if (
    assembly?.status === 'done'
    && assembly.fingerprint === fingerprint
    && assembly.output_path
    && await fileExists(assembly.output_path)
  ) return false
  try {
    await enqueue({
      project_slug: slug,
      type: 'timeline_assemble',
      episode_id: episodeId,
      title: 'Timeline assembly',
      params: { fingerprint },
    })
    return true
  } catch (error) {
    if (error instanceof DuplicateJobError) return false
    throw error
  }
}

/** What the Timeline page shows per segment: durable state only; live jobs overlay it in the UI. */
export async function timelineRenderSummary(slug: string, episodeId: string): Promise<{
  segments: Record<string, {
    status: 'not_rendered' | TimelineSegmentRenderStatus
    media_type: TimelineMediaType
    output_path?: string
    error?: string
    charged_credits?: number | null
    updated_at?: string
  }>
  assembly: { status: 'none' | 'done' | 'error'; output_path?: string; error?: string; updated_at?: string }
}> {
  const timeline = await readEpisodeTimeline(slug, episodeId)
  const state = await readTimelineRenderState(slug, episodeId)
  const segments: Record<string, any> = {}
  for (const segment of timeline?.segments ?? []) {
    const record = state.segments[segment.id]
    segments[segment.id] = record
      ? {
          status: record.status,
          media_type: record.media_type,
          ...(record.output_path ? { output_path: record.output_path } : {}),
          ...(record.error ? { error: record.error } : {}),
          ...(record.charged_credits !== undefined ? { charged_credits: record.charged_credits } : {}),
          ...(record.updated_at ? { updated_at: record.updated_at } : {}),
        }
      : { status: 'not_rendered', media_type: segment.media_type }
  }
  const assembly = state.assembly
  return {
    segments,
    assembly: assembly
      ? {
          status: assembly.status,
          ...(assembly.output_path ? { output_path: assembly.output_path } : {}),
          ...(assembly.error ? { error: assembly.error } : {}),
          ...(assembly.updated_at ? { updated_at: assembly.updated_at } : {}),
        }
      : { status: 'none' },
  }
}

// ── Per-segment execution ───────────────────────────────────────────────────
interface ProduceContext {
  fingerprint: string
  imageModelId?: string
  dir: string
  priorRequest?: TimelineSegmentRenderRequest
}

interface SegmentOutcome {
  outputPath: string
  chargedCredits: number | null
}

interface PlanScene {
  id: string
  start_sec?: number
  end_sec?: number
  visual_prompt?: string
  motion_prompt?: string
  video_prompt?: string
}

async function sceneContext(slug: string, episodeId: string, startSec: number): Promise<{
  episodeDir: string
  scene: PlanScene | null
}> {
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const plan = await readScenePlanForEpisode(slug, episodeId, paths.episode_dir)
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes as unknown as PlanScene[] : []
  const scene = scenes.find(item => startSec >= Number(item.start_sec ?? NaN) && startSec < Number(item.end_sec ?? NaN))
    ?? scenes.find(item => startSec < Number(item.end_sec ?? NaN))
    ?? null
  return { episodeDir: paths.episode_dir, scene }
}

async function requireGatewayKey(): Promise<string> {
  const apiKey = (await getApiKey('genstudio').catch(() => '')).trim()
  if (!apiKey) {
    throw new Error('Add the Gateway API Key in Settings → This Mac before rendering paid segments.')
  }
  return apiKey
}

/**
 * The provider request identity for this exact segment content. A terminal
 * settled failure earns a new attempt (`:a1`, `:a2`, …) so a retry can buy
 * again; everything else reuses the persisted key, so a crash-replay is the
 * SAME Gateway job — never a second charge.
 */
function requestIdentityFor(
  slug: string,
  episodeId: string,
  segmentId: string,
  fingerprint: string,
  prior: TimelineSegmentRenderRequest | undefined,
): { requestIdentity: string; attempt: number } {
  const base = `timeline:${slug}:${episodeId}:${segmentId}:${fingerprint}`
  let attempt = prior?.attempt ?? 0
  if (prior?.last_state && TERMINAL_REQUEST_STATES.has(prior.last_state)) attempt += 1
  return { requestIdentity: attempt > 0 ? `${base}:a${attempt}` : base, attempt }
}

async function persistRenderedRequest(
  slug: string,
  episodeId: string,
  segment: EpisodeTimelineSegment,
  fingerprint: string,
  request: TimelineSegmentRenderRequest,
): Promise<void> {
  await updateTimelineRenderState(slug, episodeId, state => {
    state.segments[segment.id] = {
      media_type: segment.media_type,
      fingerprint,
      status: 'rendering',
      request,
      updated_at: new Date().toISOString(),
    }
  })
}

async function patchRenderedRequest(
  slug: string,
  episodeId: string,
  segmentId: string,
  patch: Partial<TimelineSegmentRenderRequest>,
): Promise<void> {
  await updateTimelineRenderState(slug, episodeId, state => {
    const current = state.segments[segmentId]
    if (!current?.request) return
    state.segments[segmentId] = {
      ...current,
      request: { ...current.request, ...patch },
      updated_at: new Date().toISOString(),
    }
  })
}

async function produceChart(
  job: Job,
  segment: EpisodeTimelineSegment,
  where: string,
  ctx: ProduceContext,
): Promise<SegmentOutcome> {
  if (!segment.chart) throw new Error(`${where} has no chart data — edit the segment's chart first.`)
  job.output_lines.push(`${where} — rendering chart locally, zero credit.`)
  const { png } = await renderChartPng(segment.chart)
  const out = path.join(ctx.dir, 'segments', `${segment.id}.png`)
  await fs.mkdir(path.dirname(out), { recursive: true })
  const temp = `${out}.partial-${process.pid}`
  await fs.writeFile(temp, png)
  await fs.rename(temp, out)
  // model-drift-allow: a local chart renderer calls no provider — zero is the observed cost of running it, not a published price
  return { outputPath: out, chargedCredits: 0 }
}

async function produceStock(
  job: Job,
  segment: EpisodeTimelineSegment,
  where: string,
): Promise<SegmentOutcome> {
  const sha256 = segment.footage_sha256
  if (!sha256) throw new Error(`${where} has no footage identity — pick a clip for it.`)
  let file = await resolveFootage(sha256)
  if (!file) {
    job.output_lines.push(`${where} — clip not on this Mac; fetching from the Gateway library (local first).`)
    file = await fetchFootage(sha256)
  }
  // The clip's own past cost is the preflight's figure; this render bought no
  // new media, and what (if anything) the Gateway settled is not checked here.
  return { outputPath: file, chargedCredits: null }
}

async function produceStill(
  job: Job,
  timeline: EpisodeTimeline,
  segment: EpisodeTimelineSegment,
  where: string,
  ctx: ProduceContext,
): Promise<SegmentOutcome> {
  const { scene } = await sceneContext(job.project_slug, job.episode_id, segment.start_sec)
  const prompt = segment.prompt?.trim() || scene?.visual_prompt?.trim() || ''
  if (!prompt) {
    throw new Error(`${where} has no prompt — write one on the segment or the scene plan.`)
  }
  const apiKey = await requireGatewayKey()
  const images = (await listImageModelsSnapshot(apiKey)).value
  const model: GenStudioImageModel | undefined = images.find(item => item.id === ctx.imageModelId)
  if (!model) {
    throw new Error(
      `The Gateway no longer publishes the chosen image model (${ctx.imageModelId}). `
      + 'Choose another model in Preflight and render again.',
    )
  }
  if (!model.available) throw new Error(`${model.display_name} is currently unavailable in the Gateway.`)
  const aspectRatio = model.default_aspect_ratio || model.aspect_ratios[0]
  if (!aspectRatio) throw new Error(`${model.display_name} publishes no aspect ratio.`)
  if (model.max_prompt_characters && prompt.length > model.max_prompt_characters) {
    throw new Error(
      `${where}'s prompt is ${prompt.length} characters; ${model.display_name} accepts up to ${model.max_prompt_characters}.`,
    )
  }

  const { requestIdentity, attempt } = requestIdentityFor(
    job.project_slug, job.episode_id, segment.id, ctx.fingerprint, ctx.priorRequest,
  )
  const idempotencyKey = buildGenStudioImageIdempotencyKey({
    prompt: prompt.trim(),
    modelId: model.id,
    aspectRatio,
    requestIdentity,
  })
  const request: TimelineSegmentRenderRequest = {
    input_hash: ctx.fingerprint,
    idempotency_key: idempotencyKey,
    attempt,
    last_state: 'prepared',
  }
  // Persisted BEFORE the charged POST: a lost response replays this key.
  await persistRenderedRequest(job.project_slug, job.episode_id, segment, ctx.fingerprint, request)

  job.output_lines.push(`${where} — still via Gateway / ${model.display_name}.`)
  job.progress = 20
  let result: Awaited<ReturnType<typeof generateImageWithGenStudio>>
  try {
    result = await generateImageWithGenStudio(apiKey, {
      prompt,
      modelId: model.id,
      aspectRatio,
      ...(model.requires_admission_permit ? { requiresAdmissionPermit: true } : {}),
      requestIdentity,
      idempotencyKey,
      isCancelled: () => isCancelled(job.job_id),
      onJobAccepted: async (providerJobId, acceptedKey) => {
        await patchRenderedRequest(job.project_slug, job.episode_id, segment.id, {
          task_id: providerJobId,
          idempotency_key: acceptedKey,
          last_state: 'accepted',
        })
        job.output_lines.push(`${where} sent to the Gateway.`)
      },
      onState: async state => {
        await patchRenderedRequest(job.project_slug, job.episode_id, segment.id, { last_state: String(state) })
      },
    })
  } catch (error) {
    if (error instanceof GenStudioTerminalFailureError) {
      await patchRenderedRequest(job.project_slug, job.episode_id, segment.id, { last_state: 'failed' })
    }
    throw error
  }

  const out = path.join(ctx.dir, 'segments', `${segment.id}.png`)
  await fs.mkdir(path.dirname(out), { recursive: true })
  const temp = await stageGenStudioImage(result.url, out)
  await fs.rename(temp, out)
  job.progress = 90
  return { outputPath: out, chargedCredits: result.settledCredits ?? null }
}

async function produceVideo(
  job: Job,
  segment: EpisodeTimelineSegment,
  where: string,
  ctx: ProduceContext,
): Promise<SegmentOutcome> {
  const apiKey = await requireGatewayKey()
  const videos = (await listVideoModelsSnapshot(apiKey)).value
  const operation = timelineVideoOperation(segment.media_type)
  const buy = selectTimelineVideoBuy(videos, operation)
  if (!buy) {
    throw new Error(
      `${where} asks for ${operation}, but the Gateway publishes no available ${operation} model right now. `
      + 'Choose another media type or wait for a published model.',
    )
  }
  const { model, variant } = buy

  const { episodeDir, scene } = await sceneContext(job.project_slug, job.episode_id, segment.start_sec)
  let sourceImagePath: string | undefined
  let prompt: string
  if (segment.media_type === 't2v') {
    prompt = segment.prompt?.trim() || scene?.video_prompt?.trim() || scene?.visual_prompt?.trim() || ''
    if (!prompt) {
      throw new Error(`${where} has no prompt — write one on the segment or the scene plan.`)
    }
  } else {
    if (!scene?.id) {
      throw new Error(`${where} falls outside the scene plan — no source image can be found for it.`)
    }
    sourceImagePath = await resolveSceneImageReadPath(
      job.project_slug, job.episode_id.toUpperCase(), episodeDir, scene.id,
    ) ?? undefined
    if (!sourceImagePath) {
      throw new Error(
        `${where} has no source image to animate — generate this scene's image in Scene Review first.`,
      )
    }
    prompt = segment.motion_prompt?.trim() || segment.prompt?.trim() || scene.motion_prompt?.trim() || ''
    if (!prompt) {
      throw new Error(`${where} has no motion instruction — write one on the segment or the scene plan.`)
    }
  }

  const sourceSha256 = segment.media_type === 't2v'
    ? `text-to-video:${createHash('sha256').update(prompt.trim()).digest('hex')}`
    : createHash('sha256').update(await fs.readFile(sourceImagePath!)).digest('hex')
  const { requestIdentity, attempt } = requestIdentityFor(
    job.project_slug, job.episode_id, segment.id, ctx.fingerprint, ctx.priorRequest,
  )
  const idempotencyKey = buildGenStudioVideoIdempotencyKey({
    prompt: prompt.trim(),
    modelId: model.id,
    sourceSha256,
    ...(variant.aspect_ratio ? { aspectRatio: variant.aspect_ratio } : {}),
    operation,
    durationSeconds: variant.duration_seconds,
    resolution: variant.resolution,
    requestIdentity,
  })
  const request: TimelineSegmentRenderRequest = {
    input_hash: ctx.fingerprint,
    idempotency_key: idempotencyKey,
    attempt,
    last_state: 'prepared',
  }
  await persistRenderedRequest(job.project_slug, job.episode_id, segment, ctx.fingerprint, request)

  job.output_lines.push(
    `${where} — ${operation} via Gateway / ${model.display_name}: `
    + `${variant.operation} ${variant.duration_seconds}s ${variant.resolution} — ${variant.credits_per_video} credits (published row).`,
  )
  job.progress = 20
  let result: Awaited<ReturnType<typeof generateVideoWithGenStudio>>
  try {
    result = await generateVideoWithGenStudio(apiKey, {
      prompt: prompt.trim(),
      modelId: model.id,
      ...(sourceImagePath ? { sourceImagePath } : {}),
      ...(variant.aspect_ratio ? { aspectRatio: variant.aspect_ratio } : {}),
      operation,
      durationSeconds: variant.duration_seconds,
      resolution: variant.resolution,
      requestIdentity,
      idempotencyKey,
      isCancelled: () => isCancelled(job.job_id),
      onJobAccepted: async (providerJobId, acceptedKey) => {
        await patchRenderedRequest(job.project_slug, job.episode_id, segment.id, {
          task_id: providerJobId,
          idempotency_key: acceptedKey,
          last_state: 'accepted',
        })
        job.output_lines.push(`${where} sent to the Gateway.`)
      },
      onState: async state => {
        await patchRenderedRequest(job.project_slug, job.episode_id, segment.id, { last_state: String(state) })
      },
    })
  } catch (error) {
    if (error instanceof GenStudioTerminalFailureError) {
      await patchRenderedRequest(job.project_slug, job.episode_id, segment.id, { last_state: 'failed' })
    }
    throw error
  }

  const out = path.join(ctx.dir, 'segments', `${segment.id}.mp4`)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await downloadVideo(result.videoUrl, out, undefined, result.downloadHeaders)
  job.progress = 90
  return { outputPath: out, chargedCredits: result.creditCost ?? null }
}

async function produceSegment(
  job: Job,
  timeline: EpisodeTimeline,
  segment: EpisodeTimelineSegment,
  where: string,
  ctx: ProduceContext,
): Promise<SegmentOutcome> {
  switch (segment.media_type) {
    case 'chart':
      return produceChart(job, segment, where, ctx)
    case 'stock':
      return produceStock(job, segment, where)
    case 't2i':
      return produceStill(job, timeline, segment, where, ctx)
    case 't2v':
    case 'i2v':
      return produceVideo(job, segment, where, ctx)
    case 'sketch':
      throw new Error(
        `${where} is a sketch segment — the Timeline does not draw sketches yet (v1.4.402). `
        + 'Set it to another media type, or render the sketch from Scene Review.',
      )
  }
}

/** One segment's job: reuse, produce, record, then nudge assembly when the last one lands. */
export async function runTimelineSegmentJob(job: Job): Promise<void> {
  const params = job.params as {
    segment_id?: string
    media_type?: TimelineMediaType
    image_model_id?: string
  }
  const segmentId = params.segment_id
  if (!segmentId) throw new Error('This timeline job names no segment.')
  const timeline = await readEpisodeTimeline(job.project_slug, job.episode_id)
  if (!timeline) throw new Error('This episode no longer has a timeline.')
  const segment = timeline.segments.find(item => item.id === segmentId)
  if (!segment) throw new Error('That segment is no longer on the timeline.')
  const where = segmentWhere(timeline, segment)
  if (isCancelled(job.job_id)) throw new Error('Cancelled by user')

  const fingerprint = fingerprintSegment(segment, params.image_model_id)
  const dir = await timelineRenderDir(job.project_slug, job.episode_id)
  await fs.mkdir(path.join(dir, 'segments'), { recursive: true })
  const state = await readTimelineRenderState(job.project_slug, job.episode_id)
  const existing = state.segments[segment.id]
  if (
    existing?.status === 'done'
    && existing.fingerprint === fingerprint
    && existing.output_path
    && await fileExists(existing.output_path)
  ) {
    job.output_lines.push(`${where} — already rendered; reusing ${existing.output_path}.`)
    job.progress = 100
    return
  }

  job.output_lines.push(`${where} — rendering ${segment.media_type}.`)
  job.progress = 5
  const ctx: ProduceContext = {
    fingerprint,
    ...(params.image_model_id ? { imageModelId: params.image_model_id } : {}),
    dir,
    ...(existing?.request && existing.request.input_hash === fingerprint
      ? { priorRequest: existing.request }
      : {}),
  }
  try {
    const outcome = await produceSegment(job, timeline, segment, where, ctx)
    await updateTimelineRenderState(job.project_slug, job.episode_id, draft => {
      const previous = draft.segments[segment.id]
      draft.segments[segment.id] = {
        ...(previous ?? {}),
        media_type: segment.media_type,
        fingerprint,
        status: 'done',
        output_path: outcome.outputPath,
        charged_credits: outcome.chargedCredits,
        error: undefined,
        updated_at: new Date().toISOString(),
      }
      delete draft.segments[segment.id]!.error
    })
    job.output_lines.push(`${where} — rendered: ${outcome.outputPath}`)
    await checkpointJobState(job)
    job.progress = 95
    const assemblyQueued = await maybeEnqueueTimelineAssembly(job.project_slug, job.episode_id)
    if (assemblyQueued) job.output_lines.push('Every segment is rendered — timeline assembly queued.')
    job.progress = 100
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateTimelineRenderState(job.project_slug, job.episode_id, draft => {
      const previous = draft.segments[segment.id]
      draft.segments[segment.id] = {
        ...(previous ?? {}),
        media_type: segment.media_type,
        fingerprint,
        status: 'error',
        error: message,
        updated_at: new Date().toISOString(),
      }
    }).catch(() => {})
    job.output_lines.push(`${where} — failed: ${message}`)
    throw error
  }
}

// ── Assembly ────────────────────────────────────────────────────────────────
/**
 * One local FFmpeg pass: every segment trimmed (stills and long clips) or
 * looped (short clips) to its exact duration, normalised onto one canvas,
 * concatenated in timeline order, then probe-verified against the timeline's
 * own duration before the result is recorded.
 */
export async function runTimelineAssembleJob(job: Job): Promise<void> {
  const code = job.episode_id
  const timeline = await readEpisodeTimeline(job.project_slug, code)
  if (!timeline) throw new Error('This episode no longer has a timeline.')
  const state = await readTimelineRenderState(job.project_slug, code)

  const inputs: Array<{ filePath: string; seconds: number }> = []
  for (const [index, segment] of timeline.segments.entries()) {
    const record = state.segments[segment.id]
    const label = `Segment ${index + 1} (${clockSec(segment.start_sec)}–${clockSec(segment.end_sec)})`
    if (!record || record.status !== 'done') {
      throw new Error(
        `${label} has not finished rendering${record?.error ? `: ${record.error}` : ''} `
        + '— fix that segment, then assemble again.',
      )
    }
    if (!record.output_path || !(await fileExists(record.output_path))) {
      throw new Error(`${label}'s rendered file is missing — render that segment again.`)
    }
    inputs.push({ filePath: record.output_path, seconds: segment.end_sec - segment.start_sec })
  }

  const expected = timeline.total_duration_sec
  const fingerprint = assemblyFingerprint(timeline, state)
  job.output_lines.push(`Assembling ${inputs.length} segments into one ${expected.toFixed(2)}s video.`)
  job.progress = 10
  const canvas = resolveRenderCanvas()
  const dir = await timelineRenderDir(job.project_slug, code)
  await fs.mkdir(dir, { recursive: true })
  const outPath = path.join(dir, 'timeline.mp4')
  const tmpPath = path.join(dir, `.tmp-timeline-${job.job_id}.mp4`)
  await fs.rm(tmpPath, { force: true }).catch(() => {})

  try {
    if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
    const inputArgs: string[] = []
    const filterParts: string[] = []
    inputs.forEach((input, index) => {
      const still = /\.(png|jpe?g|webp)$/i.test(input.filePath)
      if (still) {
        inputArgs.push('-loop', '1', '-framerate', String(ASSEMBLE_FPS), '-t', String(input.seconds), '-i', input.filePath)
      } else {
        inputArgs.push('-stream_loop', '-1', '-t', String(input.seconds), '-i', input.filePath)
      }
      filterParts.push(
        `[${index}:v]scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=decrease:flags=lanczos,`
        + `pad=${canvas.w}:${canvas.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${ASSEMBLE_FPS},`
        + `trim=duration=${input.seconds},setpts=PTS-STARTPTS[v${index}]`,
      )
    })
    const concatInputs = inputs.map((_, index) => `[v${index}]`).join('')
    const filterComplex = `${filterParts.join(';')};${concatInputs}concat=n=${inputs.length}:v=1:a=0[vout]`
    const args = [
      '-y', ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[vout]', '-an',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tmpPath,
    ]
    job.output_lines.push(`Canvas ${canvas.w}×${canvas.h} @ ${ASSEMBLE_FPS}fps — each segment is trimmed or looped to its exact duration.`)
    job.progress = 30
    // ffmpeg has no cancel channel here; the ceiling scales with the timeline
    // so a short episode never waits on a long-episode allowance.
    await runFfmpeg(args, { timeoutMs: 600_000 + Math.round(expected * 10_000) })
    job.progress = 80

    const probe = await probeForUpload(tmpPath)
    if (!probe.ok || !(probe.durationSec > 0)) {
      throw new Error(
        `Assembly finished but its own duration check found no usable video${probe.error ? `: ${probe.error}` : ''}. `
        + `The partial file was kept at ${tmpPath}.`,
      )
    }
    const tolerance = (timeline.segments.length + 2) / ASSEMBLE_FPS
    if (Math.abs(probe.durationSec - expected) > tolerance) {
      throw new Error(
        `Assembly is ${probe.durationSec.toFixed(2)}s for a ${expected.toFixed(2)}s timeline `
        + `(frame-rounding allowance ${tolerance.toFixed(2)}s). The partial file was kept at ${tmpPath}.`,
      )
    }
    await fs.rename(tmpPath, outPath)
    await updateTimelineRenderState(job.project_slug, code, draft => {
      draft.assembly = {
        fingerprint,
        status: 'done',
        output_path: outPath,
        updated_at: new Date().toISOString(),
      }
    })
    job.output_lines.push(`Assembled: ${outPath} (${probe.durationSec.toFixed(2)}s for ${expected.toFixed(2)}s of timeline).`)
    job.progress = 100
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateTimelineRenderState(job.project_slug, code, draft => {
      draft.assembly = {
        fingerprint,
        status: 'error',
        error: message,
        ...(draft.assembly?.output_path ? { output_path: draft.assembly.output_path } : {}),
        updated_at: new Date().toISOString(),
      }
    }).catch(() => {})
    job.output_lines.push(`Assembly failed: ${message}`)
    throw error
  }
}
