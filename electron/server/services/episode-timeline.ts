/**
 * The episode's one timeline (owner 2026-11-13/14, plan
 * `_orchestra/youtube-stack/unified-timeline/PLAN.md`).
 *
 * Scene Plan owns the timing (its boundaries come from the narration). This service layers the
 * editorial choices on top: each segment's media type, its chart data or footage identity, and the
 * one preflight that prices and times the whole episode before anything runs. Scene plan entries are
 * the starting segments; split/merge edit them without losing the 100% rule.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import {
  TIMELINE_MEDIA_TYPES,
  VIDEO_MEDIA_TYPES,
  validateTimeline,
  type EpisodeTimeline,
  type EpisodeTimelineSegment,
  type TimelineChartSpec,
  type TimelineMediaType,
  type TimelineValidationOptions,
} from '../contracts/episode-timeline.js'
import { resolveEpisodePathsByCode } from './utils.js'

export const EPISODE_TIMELINE_SIDECAR = 'episode-timeline.json'

export async function timelinePath(slug: string, episodeId: string): Promise<string> {
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  return path.join(paths.episode_dir, EPISODE_TIMELINE_SIDECAR)
}

export async function readEpisodeTimeline(slug: string, episodeId: string): Promise<EpisodeTimeline | null> {
  try {
    const raw = JSON.parse(await fs.readFile(await timelinePath(slug, episodeId), 'utf8'))
    return raw && typeof raw === 'object' && raw.schema_version === 1 ? raw as EpisodeTimeline : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeEpisodeTimeline(
  slug: string,
  episodeId: string,
  timeline: EpisodeTimeline,
  options: TimelineValidationOptions,
): Promise<EpisodeTimeline> {
  const validated = validateTimeline({ ...timeline, episode_id: episodeId }, options)
  const filePath = await timelinePath(slug, episodeId)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await writeJsonAtomic(filePath, validated, { mode: 0o644 })
  return validated
}

/**
 * Starting segments: one per scene plan entry, in scene order. Their durations are the plan's own,
 * so shares total 100% by construction. The media starts at `t2i`; the operator changes it per
 * segment. No scene plan is a plain error — the timeline cannot invent timing.
 */
export function buildTimelineFromScenePlan(
  plan: { total_duration_sec?: number; scenes?: Array<{ start_sec?: number; end_sec?: number; visual_prompt?: string; motion_prompt?: string }> },
  episodeId: string,
): EpisodeTimeline {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : []
  const total = Number(plan?.total_duration_sec)
  if (!(total > 0) || scenes.length === 0) {
    throw new Error('This episode has no scene plan yet. Build the scene plan first, then the timeline starts from it.')
  }
  const segments: EpisodeTimelineSegment[] = scenes.map(scene => ({
    id: randomUUID(),
    start_sec: Number(scene.start_sec),
    end_sec: Number(scene.end_sec),
    media_type: 't2i' as const,
    ...(scene.visual_prompt ? { prompt: scene.visual_prompt } : {}),
    ...(scene.motion_prompt ? { motion_prompt: scene.motion_prompt } : {}),
  }))
  return { schema_version: 1, episode_id: episodeId, generated_at: new Date().toISOString(), total_duration_sec: total, segments }
}

/** Split one segment at a time strictly inside it. Both halves keep the segment's media. */
export function splitTimelineSegment(
  timeline: EpisodeTimeline,
  segmentId: string,
  atSec: number,
): EpisodeTimeline {
  const index = timeline.segments.findIndex(segment => segment.id === segmentId)
  if (index < 0) throw new Error('That segment is no longer on the timeline.')
  const segment = timeline.segments[index]!
  if (!(atSec > segment.start_sec && atSec < segment.end_sec)) {
    throw new Error(`Choose a split point inside the segment (${segment.start_sec.toFixed(2)}s–${segment.end_sec.toFixed(2)}s).`)
  }
  const segments = [...timeline.segments]
  segments.splice(index, 1,
    { ...segment, end_sec: atSec },
    { ...segment, id: randomUUID(), start_sec: atSec },
  )
  return { ...timeline, segments }
}

/**
 * Merge two ADJACENT segments. The surviving segment keeps the first one's media; merging different
 * media types is refused unless the caller names the media that should survive, so nothing is
 * silently re-decided (AGENTS §5).
 */
export function mergeTimelineSegments(
  timeline: EpisodeTimeline,
  firstId: string,
  secondId: string,
  survivingMedia?: TimelineMediaType,
): EpisodeTimeline {
  const firstIndex = timeline.segments.findIndex(segment => segment.id === firstId)
  const secondIndex = timeline.segments.findIndex(segment => segment.id === secondId)
  if (firstIndex < 0 || secondIndex < 0) throw new Error('Those segments are no longer on the timeline.')
  if (secondIndex !== firstIndex + 1) throw new Error('Only two neighbouring segments can be merged.')
  const first = timeline.segments[firstIndex]!
  const second = timeline.segments[secondIndex]!
  const media = survivingMedia ?? first.media_type
  if (!TIMELINE_MEDIA_TYPES.includes(media)) throw new Error('Choose a supported media type for the merged segment.')
  if (first.media_type !== second.media_type && survivingMedia === undefined) {
    throw new Error(`These segments use different media (${first.media_type} and ${second.media_type}). Choose which one survives.`)
  }
  const merged: EpisodeTimelineSegment = {
    id: first.id,
    start_sec: first.start_sec,
    end_sec: second.end_sec,
    media_type: media,
    ...(first.prompt ? { prompt: first.prompt } : {}),
    ...(first.motion_prompt ? { motion_prompt: first.motion_prompt } : {}),
  }
  if (media === 'chart') {
    // Chart data belongs to the segment that carried it; merging two charts keeps the first's
    // data unless the second had data and the first did not.
    const chart = first.chart ?? second.chart
    if (chart) merged.chart = chart
  }
  if (media === 'stock') {
    const footage = first.footage_sha256 ?? second.footage_sha256
    if (footage) merged.footage_sha256 = footage
  }
  // Merged segments return to "derive the prompt from the scene text" when the two prompts differ;
  // an explicit prompt is only kept when both agreed.
  if (first.prompt && second.prompt && first.prompt !== second.prompt) delete merged.prompt
  const segments = [...timeline.segments]
  segments.splice(firstIndex, 2, merged)
  return { ...timeline, segments }
}

/** Replace one segment's media choice and its related payload, keeping the timing untouched. */
export function setSegmentMedia(
  timeline: EpisodeTimeline,
  segmentId: string,
  mediaType: TimelineMediaType,
  payload: { chart?: TimelineChartSpec; footage_sha256?: string } = {},
): EpisodeTimeline {
  if (!TIMELINE_MEDIA_TYPES.includes(mediaType)) throw new Error('Choose a supported media type.')
  const segments = timeline.segments.map(segment => {
    if (segment.id !== segmentId) return segment
    const next: EpisodeTimelineSegment = {
      id: segment.id, start_sec: segment.start_sec, end_sec: segment.end_sec, media_type: mediaType,
    }
    if (segment.prompt) next.prompt = segment.prompt
    if (segment.motion_prompt) next.motion_prompt = segment.motion_prompt
    // A segment that was a chart/stock and is now another type must not keep the old payload;
    // dropping it here is the point of the explicit choice.
    if (mediaType === 'chart' && payload.chart) next.chart = payload.chart
    if (mediaType === 'stock' && payload.footage_sha256) next.footage_sha256 = payload.footage_sha256
    return next
  })
  return { ...timeline, segments }
}

export interface TimelinePreflightDeps {
  /** Live per-image price for the selected model, in credits; `null` when the Gateway published none. */
  imageCredits(): number | null
  /** Live per-second price for the selected video model, in credits; `null` when the Gateway published none. */
  videoCreditsPerSecond(): number | null
  /**
   * Exact price of ONE video segment — the published clip the render will
   * actually buy. When present it replaces the per-second estimate, so the
   * shown total is the charged total; absent, the per-second figure is used.
   * `null` means the Gateway publishes no buyable row for this segment.
   */
  videoSegmentCredits?(segment: EpisodeTimelineSegment): number | null
  /** Credits a chosen footage clip costs (free providers and local clips are 0). */
  stockCredits(sha256: string): number
  /** Estimated seconds to produce one segment of this type at this duration. */
  segmentSeconds(mediaType: TimelineMediaType, seconds: number): number
  /** Estimated seconds for final assembly at this episode duration. */
  assemblySeconds(totalSeconds: number): number
}

export interface TimelinePreflight {
  segments: number
  duration_seconds: number
  /**
   * Maximum credits this timeline may spend — computed from live prices only.
   *
   * `null` when the Gateway published no price for a media type this timeline uses: the
   * figure is then unknowable, and stating `0` would tell the customer a paid render is
   * free. The Gateway's own figure is the only one Story Studio ever quotes.
   */
  credits: number | null
  estimated_seconds: number
  by_media: Partial<Record<TimelineMediaType, { segments: number; seconds: number; credits: number | null }>>
  /** Whole seconds of assembly at the end, included in `estimated_seconds`. */
  assembly_seconds: number
}

/** One summary before anything runs: live price evidence plus an estimated wall-clock duration. */
export function preflightTimeline(timeline: EpisodeTimeline, deps: TimelinePreflightDeps): TimelinePreflight {
  const byMedia: TimelinePreflight['by_media'] = {}
  // model-drift-allow: a running total's starting point, never a price Story Studio states
  let credits = 0
  let unpriced = false
  let renderSeconds = 0
  for (const segment of timeline.segments) {
    const seconds = segment.end_sec - segment.start_sec
    const imagePrice = deps.imageCredits()
    const videoPrice = deps.videoCreditsPerSecond()
    const segmentCredits = segment.media_type === 't2i' ? imagePrice
      : VIDEO_MEDIA_TYPES.has(segment.media_type)
        ? (deps.videoSegmentCredits
          ? deps.videoSegmentCredits(segment)
          : (videoPrice === null ? null : videoPrice * seconds))
        : segment.media_type === 'stock' && segment.footage_sha256 ? deps.stockCredits(segment.footage_sha256)
          : 0
    if (segmentCredits === null) unpriced = true
    else credits += segmentCredits
    renderSeconds += deps.segmentSeconds(segment.media_type, seconds)
    // model-drift-allow: the empty bucket's counters start at zero before any segment is added
    const bucket = byMedia[segment.media_type] ?? { segments: 0, seconds: 0, credits: 0 }
    bucket.segments += 1
    bucket.seconds += seconds
    bucket.credits = bucket.credits === null || segmentCredits === null
      ? null
      : bucket.credits + segmentCredits
    byMedia[segment.media_type] = bucket
  }
  const assembly = deps.assemblySeconds(timeline.total_duration_sec)
  return {
    segments: timeline.segments.length,
    duration_seconds: timeline.total_duration_sec,
    credits: unpriced ? null : Math.round(credits * 100) / 100,
    estimated_seconds: Math.round(renderSeconds + assembly),
    by_media: byMedia,
    assembly_seconds: Math.round(assembly),
  }
}
