/**
 * The episode timeline's API (v1.4.402).
 *
 * One timeline per episode: read it, build it from the Scene Plan, edit one
 * segment at a time, and price the whole thing against the LIVE Gateway
 * catalogue before anything renders. Scene Plan owns the timing — this router
 * owns the editorial layer and the preflight.
 *
 *   GET    /api/projects/:slug/episodes/:code/timeline
 *   POST   /api/projects/:slug/episodes/:code/timeline
 *   PATCH  /api/projects/:slug/episodes/:code/timeline/segments/:segmentId
 *   POST   /api/projects/:slug/episodes/:code/timeline/segments/:segmentId/split
 *   POST   /api/projects/:slug/episodes/:code/timeline/merge
 *   POST   /api/projects/:slug/episodes/:code/timeline/preflight
 */
import { Router } from 'express'
import type { Response } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'

import { humanizeBackendError, respondWithError } from '../lib/humanize-backend-error.js'
import {
  listImageModelsSnapshot,
  listVideoModelsSnapshot,
  type GenStudioImageModel,
  type GenStudioVideoModel,
} from '../lib/genstudio-client.js'
import { getFootageRoot } from '../services/app-settings.js'
import { getApiKey } from '../services/app-secrets-store.js'
import {
  TIMELINE_MEDIA_TYPES,
  VIDEO_MEDIA_TYPES,
  timelineShares,
  validateTimeline,
  type EpisodeTimeline,
  type TimelineMediaType,
  type TimelineValidationOptions,
} from '../contracts/episode-timeline.js'
import {
  buildTimelineFromScenePlan,
  mergeTimelineSegments,
  preflightTimeline,
  readEpisodeTimeline,
  setSegmentMedia,
  splitTimelineSegment,
  writeEpisodeTimeline,
} from '../services/episode-timeline.js'
import { readScenePlanForEpisode } from '../services/local-screening-episode-reader.js'
import { resolveEpisodePathsByCode, resolveEpisodeTitleByCode } from '../services/utils.js'

export const router = Router()

const NO_PLAN_MESSAGE =
  'This episode has no scene plan yet. Build the scene plan first, then the timeline starts from it.'

/**
 * Timing estimates for the preflight — STARTING VALUES, not measurements.
 *
 * They exist so one number can be shown before a render runs; nothing here has
 * been timed on this machine yet, so the first real runs should replace these
 * with observed averages. One segment is one unit of work: a still, a sketch,
 * a chart, a stock clip already on disk, or one video clip (a segment longer
 * than the model's clip length is held or chained by the renderer and is not
 * counted as extra clips here).
 */
const SEGMENT_SECONDS: Record<TimelineMediaType, number> = {
  t2i: 12,
  sketch: 6,
  chart: 2,
  stock: 1,
  t2v: 30,
  i2v: 30,
}
/** Assembly: ~1 minute per 2 minutes of episode. */
const ASSEMBLY_SECONDS_PER_EPISODE_SECOND = 60 / 120

/**
 * Operator mistakes from the timeline service are plain messages with no
 * status of their own; a real I/O failure carries an errno `code`. Everything
 * else that fails here (a domain error, a Gateway refusal) already states its
 * own status.
 */
function editStatus(error: unknown): number {
  const e = error as any
  if (typeof e?.statusCode === 'number') return e.statusCode
  return typeof e?.code === 'string' ? 500 : 400
}

function failEdit(res: Response, error: unknown, fallback: string): void {
  res.status(editStatus(error)).json(humanizeBackendError(error, fallback))
}

/** The stored timeline, or a 404 with the one action that fixes it. */
async function requireTimeline(slug: string, code: string): Promise<EpisodeTimeline> {
  const timeline = await readEpisodeTimeline(slug, code)
  if (!timeline) {
    throw Object.assign(
      new Error('This episode has no timeline yet — build it from the scene plan first.'),
      { statusCode: 404, expose: true },
    )
  }
  return timeline
}

/**
 * Both live catalogues behind the saved Gateway key.
 *
 * Every price in this router comes from here — never from a stored number —
 * because the catalogue is the only authority on what a render costs today.
 * A missing key or an unreachable Gateway is reported, never guessed around.
 */
async function liveCatalogue(): Promise<{ images: GenStudioImageModel[]; videos: GenStudioVideoModel[] }> {
  const apiKey = (await getApiKey('genstudio').catch(() => '')).trim()
  if (!apiKey) {
    throw Object.assign(
      new Error('Add the Gateway API Key in Settings → This Mac before pricing a timeline.'),
      { statusCode: 409, expose: true },
    )
  }
  try {
    const [images, videos] = await Promise.all([
      listImageModelsSnapshot(apiKey),
      listVideoModelsSnapshot(apiKey),
    ])
    return { images: images.value, videos: videos.value }
  } catch (error: any) {
    throw Object.assign(
      new Error(`The Gateway model catalogues could not be read: ${error?.message || String(error)}`),
      { statusCode: 502, expose: true },
    )
  }
}

function hasPublishedVideoModel(videos: readonly GenStudioVideoModel[]): boolean {
  return videos.some(model => model.available)
}

/**
 * What `validateTimeline` needs to know about video models.
 *
 * The catalogue is only read when a segment actually asks for t2v/i2v — a
 * timeline of stills, sketches, charts and stock must not need a Gateway
 * round trip to edit. When no segment asks, the answer is unused by
 * validation, so `false` is passed rather than inventing a network call.
 */
async function validationOptions(timeline: EpisodeTimeline): Promise<TimelineValidationOptions> {
  const needsVideo = timeline.segments.some(segment => VIDEO_MEDIA_TYPES.has(segment.media_type))
  if (!needsVideo) return { hasPublishedVideoModel: false }
  const { videos } = await liveCatalogue()
  return { hasPublishedVideoModel: hasPublishedVideoModel(videos) }
}

/**
 * The image price of one still, from the selected model's own published
 * number: the model's flat `credits_per_image` when it publishes one, else
 * the default output combination's price. `null` means the catalogue
 * published no price — never 0, which would read as free.
 */
function publishedImageCredits(model: GenStudioImageModel | null | undefined): number | null {
  if (!model) return null
  const flat = model.credits_per_image
  if (typeof flat === 'number' && Number.isFinite(flat) && flat >= 0) return flat
  const fallback = model.output_options?.find(option => option.is_default)?.credits_per_image
    ?? model.output_options?.[0]?.credits_per_image
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0 ? fallback : null
}

/**
 * Per-second video price from the live catalogue's own published variants.
 *
 * Preflight reports the MAXIMUM the timeline may spend, so the highest
 * available per-second rate wins rather than the cheapest. `null` when no
 * available model publishes a variant price — reported as "price not
 * published", never as 0.
 */
function publishedVideoCreditsPerSecond(videos: readonly GenStudioVideoModel[]): number | null {
  let highest: number | null = null
  for (const model of videos) {
    if (!model.available) continue
    for (const variant of model.variants) {
      if (!(variant.duration_seconds > 0)) continue
      const perSecond = variant.credits_per_video / variant.duration_seconds
      if (highest === null || perSecond > highest) highest = perSecond
    }
  }
  return highest
}

/**
 * Stock credits from the clip's own sidecar beside the footage in the
 * configured root. A local or free clip publishes no price and costs 0; a
 * missing sidecar or an unreadable root is the same answer, because this Mac
 * already holds the bytes.
 */
async function stockCredits(sha256: string): Promise<number> {
  try {
    const root = await getFootageRoot()
    const raw = JSON.parse(await fs.readFile(path.join(root, `${sha256}.json`), 'utf8'))
    const credits = Number((raw as any)?.credits)
    // model-drift-allow: a local clip's own sidecar publishes what it cost; no provider is
    // called for footage already on this Mac, so an absent figure is a real zero, not a guess
    return Number.isFinite(credits) && credits >= 0 ? credits : 0
  } catch {
    return 0
  }
}

// ── GET /timeline ────────────────────────────────────────────────────────
router.get('/projects/:slug/episodes/:code/timeline', async (req, res) => {
  const { slug, code } = req.params
  try {
    const episode_title = await resolveEpisodeTitleByCode(slug, code).catch(() => '')
    const timeline = await readEpisodeTimeline(slug, code)
    if (timeline) {
      return res.json({
        episode_id: code,
        episode_title,
        timeline,
        shares: timelineShares(timeline),
        can_build: false,
      })
    }
    const paths = await resolveEpisodePathsByCode(slug, code)
    const plan = await readScenePlanForEpisode(slug, code, paths.episode_dir)
    // The same test `buildTimelineFromScenePlan` applies: a plan exists and
    // carries timings, or there is nothing to build from.
    const sceneCount = Array.isArray(plan?.scenes) ? plan.scenes.length : 0
    const planDuration = Number(plan?.total_duration_sec) || 0
    const canBuild = !!plan && sceneCount > 0 && planDuration > 0
    return res.json({
      episode_id: code,
      episode_title,
      timeline: null,
      can_build: canBuild,
      scene_plan: canBuild ? { scene_count: sceneCount, total_duration_sec: planDuration } : null,
      // A missing scene plan is an ordinary state, not a failure: a plain
      // message, never a 500.
      message: canBuild
        ? undefined
        : plan
          ? "This episode's scene plan has no scenes or duration yet — run Scene Plan first."
          : NO_PLAN_MESSAGE,
    })
  } catch (error) {
    respondWithError(res, error, "Could not read this episode's timeline")
  }
})

// ── POST /timeline — build from the scene plan ───────────────────────────
router.post('/projects/:slug/episodes/:code/timeline', async (req, res) => {
  const { slug, code } = req.params
  try {
    const existing = await readEpisodeTimeline(slug, code)
    if (existing && req.body?.replace !== true) {
      return res.status(409).json({
        detail: 'This episode already has a timeline. Send { "replace": true } to rebuild it from the scene plan — the segments on it now would be replaced.',
      })
    }
    const paths = await resolveEpisodePathsByCode(slug, code)
    const plan = await readScenePlanForEpisode(slug, code, paths.episode_dir)
    if (!plan) return res.status(400).json({ detail: NO_PLAN_MESSAGE })
    const built = buildTimelineFromScenePlan(plan, code)
    const saved = await writeEpisodeTimeline(slug, code, built, await validationOptions(built))
    const episode_title = await resolveEpisodeTitleByCode(slug, code).catch(() => '')
    return res.status(201).json({
      episode_id: code,
      episode_title,
      timeline: saved,
      shares: timelineShares(saved),
    })
  } catch (error) {
    failEdit(res, error, 'Could not build the timeline')
  }
})

// ── PATCH /timeline/segments/:segmentId — one segment's media ────────────
router.patch('/projects/:slug/episodes/:code/timeline/segments/:segmentId', async (req, res) => {
  const { slug, code, segmentId } = req.params
  try {
    const current = await requireTimeline(slug, code)
    if (!current.segments.some(segment => segment.id === segmentId)) {
      return res.status(404).json({ detail: 'That segment is no longer on the timeline.' })
    }
    const mediaType = req.body?.media_type as TimelineMediaType | undefined
    if (!mediaType || !TIMELINE_MEDIA_TYPES.includes(mediaType)) {
      return res.status(400).json({ detail: `Choose one of: ${TIMELINE_MEDIA_TYPES.join(', ')}.` })
    }
    const payload: { chart?: any; footage_sha256?: string } = {}
    if (mediaType === 'chart') {
      // validateTimeline owns the chart's own rules; passing it through here
      // means a bad chart is refused with the contract's sentence.
      if (req.body?.chart !== undefined) payload.chart = req.body.chart
    }
    if (mediaType === 'stock') {
      const sha256 = typeof req.body?.footage_sha256 === 'string' ? req.body.footage_sha256.trim() : ''
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        return res.status(400).json({ detail: 'Pick a footage clip for a stock segment first.' })
      }
      payload.footage_sha256 = sha256
    }
    const next = setSegmentMedia(current, segmentId, mediaType, payload)
    const saved = await writeEpisodeTimeline(slug, code, next, await validationOptions(next))
    return res.json({ timeline: saved, shares: timelineShares(saved) })
  } catch (error) {
    failEdit(res, error, 'Could not save this segment')
  }
})

// ── POST /timeline/segments/:segmentId/split ─────────────────────────────
router.post('/projects/:slug/episodes/:code/timeline/segments/:segmentId/split', async (req, res) => {
  const { slug, code, segmentId } = req.params
  try {
    const atSec = Number(req.body?.at_sec)
    if (!Number.isFinite(atSec)) {
      return res.status(400).json({ detail: 'Enter the split point in seconds, inside the segment.' })
    }
    const current = await requireTimeline(slug, code)
    const next = splitTimelineSegment(current, segmentId, atSec)
    const saved = await writeEpisodeTimeline(slug, code, next, await validationOptions(next))
    return res.json({ timeline: saved, shares: timelineShares(saved) })
  } catch (error) {
    failEdit(res, error, 'Could not split this segment')
  }
})

// ── POST /timeline/merge — two neighbouring segments ─────────────────────
router.post('/projects/:slug/episodes/:code/timeline/merge', async (req, res) => {
  const { slug, code } = req.params
  try {
    const firstId = typeof req.body?.first_id === 'string' ? req.body.first_id.trim() : ''
    const secondId = typeof req.body?.second_id === 'string' ? req.body.second_id.trim() : ''
    if (!firstId || !secondId) {
      return res.status(400).json({ detail: 'Name the two neighbouring segments to merge.' })
    }
    const mediaType = req.body?.media_type as TimelineMediaType | undefined
    if (mediaType !== undefined && !TIMELINE_MEDIA_TYPES.includes(mediaType)) {
      return res.status(400).json({ detail: `Choose one of: ${TIMELINE_MEDIA_TYPES.join(', ')}.` })
    }
    const current = await requireTimeline(slug, code)
    const next = mergeTimelineSegments(current, firstId, secondId, mediaType)
    const saved = await writeEpisodeTimeline(slug, code, next, await validationOptions(next))
    return res.json({ timeline: saved, shares: timelineShares(saved) })
  } catch (error) {
    failEdit(res, error, 'Could not merge these segments')
  }
})

// ── POST /timeline/preflight — credits and duration before any render ────
router.post('/projects/:slug/episodes/:code/timeline/preflight', async (req, res) => {
  const { slug, code } = req.params
  try {
    const timeline = await requireTimeline(slug, code)
    const imageModelId = typeof req.body?.image_model_id === 'string' ? req.body.image_model_id.trim() : ''
    if (!imageModelId) {
      return res.status(400).json({ detail: 'Choose an image model to price the stills with.' })
    }
    const { images, videos } = await liveCatalogue()
    // A timeline validation refusal is reported before any number is shown —
    // pricing a broken timeline would dress up a broken answer.
    validateTimeline(timeline, { hasPublishedVideoModel: hasPublishedVideoModel(videos) })

    const selected = images.find(model => model.id === imageModelId) || null
    const imageCreditsPerImage = publishedImageCredits(selected)
    const videoCreditsPerSecond = publishedVideoCreditsPerSecond(videos)

    const needsImage = timeline.segments.some(segment => segment.media_type === 't2i')
    const needsVideo = timeline.segments.some(segment => VIDEO_MEDIA_TYPES.has(segment.media_type))
    // A total that omits a media type whose price is unknown would read as a
    // complete number; it is reported as unknown instead.
    const creditsKnown = (!needsImage || imageCreditsPerImage !== null)
      && (!needsVideo || videoCreditsPerSecond !== null)

    const stockIds = [...new Set(
      timeline.segments
        .filter(segment => segment.media_type === 'stock' && segment.footage_sha256)
        .map(segment => segment.footage_sha256!),
    )]
    const stockById = new Map<string, number>(
      await Promise.all(stockIds.map(async id => [id, await stockCredits(id)] as const)),
    )

    const result = preflightTimeline(timeline, {
      imageCredits: () => imageCreditsPerImage ?? null,
      videoCreditsPerSecond: () => videoCreditsPerSecond ?? null,
      stockCredits: sha256 => stockById.get(sha256) ?? 0,
      segmentSeconds: mediaType => SEGMENT_SECONDS[mediaType],
      assemblySeconds: totalSeconds => totalSeconds * ASSEMBLY_SECONDS_PER_EPISODE_SECOND,
    })

    return res.json({
      has_published_video_model: hasPublishedVideoModel(videos),
      image: {
        model_id: selected?.id ?? imageModelId,
        model_label: selected?.display_name ?? null,
        credits_per_image: imageCreditsPerImage,
        price: imageCreditsPerImage === null ? 'price not published' : 'published',
      },
      video: {
        credits_per_second: videoCreditsPerSecond,
        price: videoCreditsPerSecond === null ? 'price not published' : 'published',
      },
      // The figures below are starting estimates, not measurements.
      timing_note: 'Estimated time uses starting constants for each media type plus assembly — an estimate, not a measurement.',
      preflight: {
        segments: result.segments,
        duration_seconds: result.duration_seconds,
        estimated_seconds: result.estimated_seconds,
        assembly_seconds: result.assembly_seconds,
        ...(creditsKnown
          ? { credits: result.credits }
          : { credits: null, credits_note: 'price not published' }),
        ...(creditsKnown ? { by_media: result.by_media } : {}),
      },
    })
  } catch (error) {
    failEdit(res, error, 'Could not price this timeline')
  }
})
