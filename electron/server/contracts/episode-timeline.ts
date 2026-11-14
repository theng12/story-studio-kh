/**
 * One timeline per episode (owner 2026-11-13/14).
 *
 * The episode is split into ordered segments that cover its whole duration; each segment chooses
 * its media. Scene Plan remains the source of timing (it already derives scene boundaries from the
 * narration); the timeline is the editorial layer on top of it. Shares always come from the
 * durations and must add to 100%, so a segment can never be silently lost or double-counted.
 *
 * What a segment may choose now: `t2i` (generated still), `sketch` (local Sketch Draw), `chart`
 * (deterministic local renderer, zero credit), `stock` (footage from the configured media root or
 * the Gateway catalogue). `t2v` and `i2v` are accepted only when a live video model is published;
 * validation takes that as an input rather than guessing it.
 */

export const TIMELINE_MEDIA_TYPES = ['t2i', 'sketch', 'chart', 'stock', 't2v', 'i2v'] as const
export type TimelineMediaType = typeof TIMELINE_MEDIA_TYPES[number]

/** Media that only a published video model may use. */
export const VIDEO_MEDIA_TYPES: ReadonlySet<TimelineMediaType> = new Set(['t2v', 'i2v'])

export interface TimelineChartSpec {
  kind: 'bar' | 'line' | 'pie'
  title?: string
  labels: string[]
  values: number[]
}

export interface EpisodeTimelineSegment {
  /** Stable id — survives split, merge and reorder. */
  id: string
  /** Seconds on the episode's stitched narration. */
  start_sec: number
  end_sec: number
  media_type: TimelineMediaType
  /** Chart data when `media_type` is `chart`; absent for every other type. */
  chart?: TimelineChartSpec
  /** Footage identity when `media_type` is `stock`; absent for every other type. */
  footage_sha256?: string
  /** Prompt / motion instruction the renderer uses; blank means "derive from the scene text". */
  prompt?: string
  motion_prompt?: string
}

export interface EpisodeTimeline {
  schema_version: 1
  episode_id: string
  generated_at: string
  /** Whole episode duration these segments cover, in seconds. */
  total_duration_sec: number
  segments: EpisodeTimelineSegment[]
}

export class TimelineInvalidError extends Error {
  readonly statusCode = 400
  readonly expose = true
  constructor(message: string) {
    super(message)
    this.name = 'TimelineInvalidError'
  }
}

export interface TimelineValidationOptions {
  /** True only when the live catalogue currently publishes a video model. */
  hasPublishedVideoModel: boolean
}

const EPSILON_SEC = 0.01

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Validate a timeline and return it. Throws a plain, actionable message — this runs before any
 * render is submitted, so a bad share must never reach a provider.
 */
export function validateTimeline(
  timeline: EpisodeTimeline,
  options: TimelineValidationOptions,
): EpisodeTimeline {
  if (!timeline || typeof timeline !== 'object') throw new TimelineInvalidError('The timeline is invalid.')
  if (timeline.schema_version !== 1) throw new TimelineInvalidError('The timeline has an unsupported version.')
  if (typeof timeline.episode_id !== 'string' || !timeline.episode_id) {
    throw new TimelineInvalidError('The timeline names no episode.')
  }
  if (!finitePositive(timeline.total_duration_sec)) {
    throw new TimelineInvalidError('The timeline has no episode duration yet — build it from the scene plan first.')
  }
  if (!Array.isArray(timeline.segments) || timeline.segments.length === 0) {
    throw new TimelineInvalidError('The timeline has no segments.')
  }
  const ids = new Set<string>()
  let cursor = 0
  let covered = 0
  for (const [index, segment] of timeline.segments.entries()) {
    const where = `Segment ${index + 1}`
    if (!segment || typeof segment.id !== 'string' || !segment.id) throw new TimelineInvalidError(`${where} has no id.`)
    if (ids.has(segment.id)) throw new TimelineInvalidError(`${where} repeats segment id ${segment.id}.`)
    ids.add(segment.id)
    if (!TIMELINE_MEDIA_TYPES.includes(segment.media_type)) {
      throw new TimelineInvalidError(`${where} has an unknown media type.`)
    }
    if (!Number.isFinite(segment.start_sec) || !Number.isFinite(segment.end_sec) || segment.end_sec <= segment.start_sec) {
      throw new TimelineInvalidError(`${where} has no positive duration.`)
    }
    if (Math.abs(segment.start_sec - cursor) > EPSILON_SEC) {
      throw new TimelineInvalidError(`${where} must start where the previous one ended (${cursor.toFixed(2)}s).`)
    }
    cursor = segment.end_sec
    covered += segment.end_sec - segment.start_sec
    const isVideo = VIDEO_MEDIA_TYPES.has(segment.media_type)
    if (isVideo && !options.hasPublishedVideoModel) {
      throw new TimelineInvalidError(`${where} asks for ${segment.media_type.toUpperCase()}, but the Gateway publishes no video model right now. Choose another media type or wait for a published model.`)
    }
    if (segment.media_type === 'chart') {
      validateChart(segment.chart, where)
    } else if (segment.chart) {
      throw new TimelineInvalidError(`${where} carries chart data but is not a chart segment.`)
    }
    if (segment.media_type === 'stock') {
      if (typeof segment.footage_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(segment.footage_sha256)) {
        throw new TimelineInvalidError(`${where} has no footage identity yet. Pick a clip for it.`)
      }
    } else if (segment.footage_sha256) {
      throw new TimelineInvalidError(`${where} carries a footage identity but is not a stock segment.`)
    }
  }
  // Shares come from the durations: covering the episode exactly is the 100% rule, and the
  // tolerance is far below one frame at any supported frame rate.
  if (Math.abs(covered - timeline.total_duration_sec) > EPSILON_SEC) {
    throw new TimelineInvalidError(
      `The segments cover ${covered.toFixed(2)}s of a ${timeline.total_duration_sec.toFixed(2)}s episode — every second must belong to one segment.`,
    )
  }
  return timeline
}

function validateChart(chart: TimelineChartSpec | undefined, where: string): void {
  if (!chart || !['bar', 'line', 'pie'].includes(chart.kind)) {
    throw new TimelineInvalidError(`${where} is a chart without a supported chart type.`)
  }
  if (!Array.isArray(chart.labels) || chart.labels.length < 1 || chart.labels.length > 24) {
    throw new TimelineInvalidError(`${where}'s chart needs 1–24 labels.`)
  }
  if (!Array.isArray(chart.values) || chart.values.length !== chart.labels.length) {
    throw new TimelineInvalidError(`${where}'s chart needs one value per label.`)
  }
  if (!chart.values.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new TimelineInvalidError(`${where}'s chart has a value that is not a number.`)
  }
  if (chart.labels.some(label => typeof label !== 'string' || !label.trim() || label.length > 80)) {
    throw new TimelineInvalidError(`${where}'s chart has an empty or too-long label.`)
  }
  if (chart.kind === 'pie' && chart.values.some(value => value < 0)) {
    throw new TimelineInvalidError(`${where}'s pie chart cannot use negative values.`)
  }
}

/** Percent of the episode each segment covers, in order. Always sums to 100 for a valid timeline. */
export function timelineShares(timeline: EpisodeTimeline): number[] {
  return timeline.segments.map(segment =>
    Math.round(((segment.end_sec - segment.start_sec) / timeline.total_duration_sec) * 10_000) / 100,
  )
}
