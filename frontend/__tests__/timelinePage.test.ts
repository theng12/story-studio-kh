/**
 * The Timeline page's core controls, asserted from source — the same lane as
 * the rest of the frontend tests.
 *
 * What is pinned: one episode frame, the segmented list with its share/media
 * readout, the per-segment media picker (video types only behind a published
 * video model), the chart editor, the stock search with its honest
 * "not connected yet" sentence, Split and Merge, one Preflight action — and
 * no native `confirm`/`alert`/`prompt` anywhere, because in a packaged
 * macOS webview those are silent no-ops.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const page = read('../pages/projects/[slug]/timeline.vue')
const flow = read('../composables/useProjectFlow.ts')

test('the page never reaches for a native dialog', () => {
  assert.doesNotMatch(page, /window\.(confirm|alert|prompt)\s*\(/)
  assert.doesNotMatch(page, /(^|[^.\w])(confirm|alert|prompt)\s*\(/m)
})

test('one frame carries the episode title and the picker that chooses it', () => {
  assert.match(page, /<EpisodeSelector/)
  assert.match(page, /v-if="episodeTitle"/)
  assert.match(page, /tl-episode-title/)
})

test('the segmented list shows start-end, share and media for every segment', () => {
  assert.match(page, /tl-rows/)
  assert.match(page, /formatClock\(segment\.start_sec\)/)
  assert.match(page, /formatClock\(segment\.end_sec\)/)
  assert.match(page, /\{\{ shares\[index\] \?\? 0 \}\}%/)
  assert.match(page, /mediaLabel\(segment\.media_type\)/)
  assert.match(page, /shares total 100%/)
})

test('every segment picks its media, and video types wait for a published model', () => {
  assert.match(page, /@change="changeMedia\(segment, index, \$event\)"/)
  for (const media of ['t2i', 'sketch', 'chart', 'stock']) {
    assert.match(page, new RegExp(`value="${media}"`), `the picker must offer ${media}`)
  }
  for (const media of ['t2v', 'i2v']) {
    assert.match(page, new RegExp(`<option v-if="hasPublishedVideoModel" value="${media}">`))
  }
  // The gate is the preflight's own answer, never a guess made on the page.
  assert.match(page, /hasPublishedVideoModel\.value = answer\.has_published_video_model/)
})

test('chart segments get a type, labels and values editor', () => {
  assert.match(page, /v-if="segment\.media_type === 'chart'"/)
  assert.match(page, /Chart type/)
  assert.match(page, /chartDraftFor\(segment\)\.labels/)
  assert.match(page, /chartDraftFor\(segment\)\.values/)
  assert.match(page, /Save chart data/)
  assert.match(page, /No credits — charts render locally\./)
})

test('stock segments search footage and say honestly when the client is absent', () => {
  assert.match(page, /Footage client not connected yet/)
  assert.match(page, /Search stock clips/)
  assert.match(page, /Use this clip/)
  // A stock segment is only written once a clip identity exists.
  assert.match(page, /media_type: 'stock', footage_sha256/)
})

test('each row splits and merges, and Preflight runs once for the episode', () => {
  assert.match(page, /Split at \(seconds\)/)
  assert.match(page, /@click="split\(segment\)"/)
  assert.match(page, /Merge with next/)
  assert.match(page, /different media/)
  assert.match(page, /@click="runPreflight"/)
  assert.match(page, /Maximum credits/)
  assert.match(page, /Estimated time/)
  assert.match(page, /price not published/)
  assert.match(page, /Choose an image model to price|Choose a model/)
})

test('the sidebar links the page the way every other workflow step is linked', () => {
  assert.match(flow, /key: 'timeline',\s+label: 'Timeline',\s+icon: '[^']+',\s+path: '\/timeline'/)
  assert.match(flow, /STEP\.scenePlan, STEP\.timeline, STEP\.soundAndLabels/)
  // Optional: it must never hold an episode back from reading done.
  assert.match(flow, /path: '\/timeline',\s+phase: 'video', optional: true/)
  assert.ok(!/timeline: 'timeline_/.test(flow), 'the timeline has no per-episode status field to block on')
})
