import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TimelineInvalidError,
  timelineShares,
  validateTimeline,
  type EpisodeTimeline,
} from '../contracts/episode-timeline.js'
import {
  buildTimelineFromScenePlan,
  mergeTimelineSegments,
  preflightTimeline,
  setSegmentMedia,
  splitTimelineSegment,
} from '../services/episode-timeline.js'

const seg = (id: string, start: number, end: number, media_type: EpisodeTimeline['segments'][number]['media_type'] = 't2i') => ({
  id, start_sec: start, end_sec: end, media_type,
})
const timeline = (segments: EpisodeTimeline['segments'], total = 60): EpisodeTimeline => ({
  schema_version: 1, episode_id: 'EP0001', generated_at: '2026-11-14T00:00:00Z', total_duration_sec: total, segments,
})
const messageOf = (error: unknown): string => error instanceof Error ? error.message : ''
const noVideo = { hasPublishedVideoModel: false }
const withVideo = { hasPublishedVideoModel: true }

test('a timeline must cover every second exactly once', () => {
  assert.equal(validateTimeline(timeline([seg('a', 0, 20), seg('b', 20, 60)]), noVideo).segments.length, 2)

  assert.throws(() => validateTimeline(timeline([seg('a', 0, 20), seg('b', 25, 60)]), noVideo),
    (error: unknown) => error instanceof TimelineInvalidError && /must start where the previous one ended/.test(error.message))
  assert.throws(() => validateTimeline(timeline([seg('a', 0, 20)]), noVideo),
    (error: unknown) => error instanceof TimelineInvalidError && /every second must belong to one segment/.test(error.message))
  assert.throws(() => validateTimeline(timeline([seg('a', 0, 20), seg('a', 20, 60)]), noVideo),
    (error: unknown) => /repeats segment id/.test(messageOf(error)))
})

test('shares come from the durations and total 100', () => {
  const shares = timelineShares(timeline([seg('a', 0, 15), seg('b', 15, 45), seg('c', 45, 60)]))
  assert.deepEqual(shares, [25, 50, 25])
  assert.equal(shares.reduce((sum, value) => sum + value, 0), 100)
})

test('video media needs a published video model; charts and stock need their payload', () => {
  assert.throws(() => validateTimeline(timeline([seg('a', 0, 60, 't2v')]), noVideo),
    (error: unknown) => /Gateway publishes no video model/.test(messageOf(error)))
  assert.equal(validateTimeline(timeline([seg('a', 0, 60, 't2v')]), withVideo).segments.length, 1)

  assert.throws(() => validateTimeline(timeline([seg('a', 0, 60, 'chart')]), noVideo),
    (error: unknown) => /chart without a supported chart type/.test(messageOf(error)))
  assert.equal(validateTimeline(timeline([{
    ...seg('a', 0, 60, 'chart'),
    chart: { kind: 'bar', labels: ['a', 'b'], values: [1, 2] },
  }]), noVideo).segments.length, 1)

  assert.throws(() => validateTimeline(timeline([seg('a', 0, 60, 'stock')]), noVideo),
    (error: unknown) => /no footage identity/.test(messageOf(error)))
  assert.equal(validateTimeline(timeline([{
    ...seg('a', 0, 60, 'stock'), footage_sha256: 'a'.repeat(64),
  }]), noVideo).segments.length, 1)
})

test('a scene plan becomes one segment per scene, in order, with its own timing', () => {
  const built = buildTimelineFromScenePlan({
    total_duration_sec: 30,
    scenes: [
      { start_sec: 0, end_sec: 10, visual_prompt: 'A lantern', motion_prompt: 'slow drift' },
      { start_sec: 10, end_sec: 30, visual_prompt: 'A river' },
    ],
  }, 'EP0009')
  assert.equal(built.episode_id, 'EP0009')
  assert.equal(built.segments.length, 2)
  assert.deepEqual(built.segments.map(s => [s.start_sec, s.end_sec, s.media_type]), [[0, 10, 't2i'], [10, 30, 't2i']])
  assert.equal(built.segments[0]!.prompt, 'A lantern')
  assert.deepEqual(timelineShares(built), [33.33, 66.67])
  assert.throws(() => buildTimelineFromScenePlan({ total_duration_sec: 0, scenes: [] }, 'EP0009'), /no scene plan yet/)
})

test('split and merge keep the timing continuous and never silently re-decide media', () => {
  const base = timeline([seg('a', 0, 20), seg('b', 20, 60)])
  const split = splitTimelineSegment(base, 'a', 8)
  assert.equal(split.segments.length, 3)
  assert.deepEqual(split.segments.map(s => [s.start_sec, s.end_sec]), [[0, 8], [8, 20], [20, 60]])
  assert.throws(() => splitTimelineSegment(base, 'a', 25), /inside the segment/)

  const merged = mergeTimelineSegments(split, split.segments[0]!.id, split.segments[1]!.id)
  assert.deepEqual(merged.segments.map(s => [s.start_sec, s.end_sec]), [[0, 20], [20, 60]])
  assert.equal(merged.segments[0]!.id, split.segments[0]!.id)

  const mixed = timeline([seg('a', 0, 20, 't2i'), seg('b', 20, 60, 'chart')])
  assert.throws(() => mergeTimelineSegments(mixed, 'a', 'b'), /different media/)
  const chosen = mergeTimelineSegments(mixed, 'a', 'b', 'chart')
  assert.equal(chosen.segments.length, 1)
  assert.equal(chosen.segments[0]!.media_type, 'chart')
})

test('changing a segment media drops the payload that does not belong to it', () => {
  const charted = timeline([{
    ...seg('a', 0, 60, 'chart'), chart: { kind: 'pie', labels: ['x', 'y'], values: [1, 3] },
  }])
  const stock = setSegmentMedia(charted, 'a', 'stock', { footage_sha256: 'b'.repeat(64) })
  assert.equal(stock.segments[0]!.media_type, 'stock')
  assert.equal(stock.segments[0]!.footage_sha256, 'b'.repeat(64))
  assert.equal(stock.segments[0]!.chart, undefined)
})

test('preflight prices live evidence and estimates the whole run', () => {
  const run = timeline([
    seg('a', 0, 10), seg('b', 10, 20), seg('c', 20, 30),
    { ...seg('d', 30, 40, 'chart'), chart: { kind: 'bar', labels: ['a'], values: [1] } },
    { ...seg('e', 40, 60, 'stock'), footage_sha256: 'c'.repeat(64) },
  ])
  const result = preflightTimeline(run, {
    imageCredits: () => 2,
    videoCreditsPerSecond: () => 5,
    stockCredits: () => 0,
    segmentSeconds: (media, seconds) => media === 'chart' ? 2 : seconds * 3,
    assemblySeconds: total => total / 10,
  })
  assert.equal(result.segments, 5)
  assert.equal(result.credits, 6, 'three t2i images at 2 credits; chart and stock cost nothing')
  assert.equal(result.by_media.chart?.credits, 0)
  assert.equal(result.by_media.stock?.credits, 0)
  assert.equal(result.assembly_seconds, 6)
  // 30 seconds of images at 3x, a chart at 2s, 20s of stock at 3x, then 6s assembly.
  assert.equal(result.estimated_seconds, 90 + 2 + 60 + 6)
})
