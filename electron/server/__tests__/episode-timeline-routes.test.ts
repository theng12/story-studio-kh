/**
 * The episode timeline's routes — the contract the Timeline page calls.
 *
 * What is pinned here: building from a scene plan, the 100% coverage rule
 * refusing a bad edit, the split/merge/set-media round trip, and one preflight
 * priced from a FIXTURE catalogue — a published price is used as published, an
 * unpublished one is reported as "price not published" rather than invented as
 * 0, and charts and stock stay free.
 *
 * Zero paid calls: every catalogue answer comes from a stubbed `fetch`.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const IMAGE_MODEL_ID = 'priced-image-v1'
const UNPRICED_IMAGE_MODEL_ID = 'unpriced-image-v1'
const STOCK_SHA = 'a'.repeat(64)

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let service: typeof import('../services/episode-timeline.js')
let setApiKey: typeof import('../services/app-secrets-store.js')['setApiKey']
let clearGenStudioCatalogCache: typeof import('../lib/genstudio-client.js')['clearGenStudioCatalogCache']

let slug = ''
let episodeId = ''
let episodeNoPlan = ''

/** The catalogue this stub serves; every preflight case swaps it in. */
let imageRows: Array<Record<string, unknown>> = []
let videoRows: Array<Record<string, unknown>> = []
const originalFetch = globalThis.fetch

function pricedImageRow(): Record<string, unknown> {
  return {
    id: IMAGE_MODEL_ID,
    display_name: 'Priced Image',
    available: true,
    qualification_only: false,
    aspect_ratios: ['16:9'],
    default_resolution: '1K',
    credits_per_image: 4,
    price_version: 'fixture-price-v1',
    output_options: [
      { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true, credits_per_image: 4, price_version: 'fixture-price-v1' },
    ],
  }
}

/** A model the Gateway publishes but has priced nowhere. */
function unpricedImageRow(): Record<string, unknown> {
  return {
    id: UNPRICED_IMAGE_MODEL_ID,
    display_name: 'Unpriced Image',
    available: true,
    qualification_only: false,
    aspect_ratios: ['16:9'],
    default_resolution: '1K',
    output_options: [
      { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true },
    ],
  }
}

function availableVideoRow(): Record<string, unknown> {
  return {
    id: 'fixture-video-v1',
    display_name: 'Fixture Video',
    available: true,
    modes: ['image-to-video'],
    aspect_ratios: ['16:9'],
    variants: [
      { operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'fixture-video-v1' },
    ],
  }
}

function unavailableVideoRow(): Record<string, unknown> {
  return { ...availableVideoRow(), id: 'offline-video-v1', available: false }
}

async function writeScenePlan(code: string, withPlan: boolean): Promise<void> {
  const paths = await (await import('../services/utils.js')).resolveEpisodePathsByCode(slug, code)
  if (!withPlan) return
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(`${paths.scene_prompts_dir}/scene_plan.json`, JSON.stringify({
    schema_version: 1,
    total_duration_sec: 60,
    scenes: [
      { id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 20, visual_prompt: 'A lantern in a quiet archive.' },
      { id: 'scene-002', scene_index: 2, start_sec: 20, end_sec: 60, visual_prompt: 'A river at dusk.' },
    ],
  }))
}

async function makeEpisode(title: string): Promise<string> {
  const [idea] = await ideas.addIdeas(slug, [{
    title,
    logline: 'Timeline route fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea, 'the fixture episode must be accepted')
  const accepted = await ideas.acceptIdea(slug, idea.id, false)
  return accepted.episode_code
}

const timelineUrl = () => `/api/projects/${slug}/episodes/${episodeId}/timeline`

function sharesSum(shares: number[]): number {
  return Math.round(shares.reduce((sum, value) => sum + value, 0) * 100) / 100
}

describe('episode timeline routes', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    ideas = await import('../services/idea-manager.js')
    service = await import('../services/episode-timeline.js')
    clearGenStudioCatalogCache = (await import('../lib/genstudio-client.js')).clearGenStudioCatalogCache
    setApiKey = (await import('../services/app-secrets-store.js')).setApiKey

    const { router } = await import('../routes/episode-timeline.js')
    app = express()
    app.use(express.json())
    app.use('/api', router)

    await setApiKey('genstudio', 'gsk_fixture_timeline_key')

    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.endsWith('/v1/image/models')) return Response.json(imageRows)
      if (url.endsWith('/v1/videos/models')) return Response.json(videoRows)
      return Response.json({ detail: 'Unexpected fixture request.' }, { status: 404 })
    }) as typeof globalThis.fetch

    const project = await pm.createProject({ name: 'Timeline Routes', episode_prefix: 'EP', episode_digits: 3 })
    slug = project.slug
    episodeId = await makeEpisode('Lantern River')
    await writeScenePlan(episodeId, true)
    episodeNoPlan = await makeEpisode('No Plan Yet')
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await tmp.cleanup()
  })

  test('with no timeline stored, GET offers to build from the scene plan', async () => {
    const response = await request(app).get(timelineUrl()).expect(200)
    assert.equal(response.body.timeline, null)
    assert.equal(response.body.can_build, true)
    assert.equal(response.body.scene_plan.scene_count, 2)
    assert.equal(response.body.scene_plan.total_duration_sec, 60)
    assert.equal(response.body.episode_title, 'Lantern River')
  })

  test('an episode with no scene plan answers with a plain message, not a 500', async () => {
    const response = await request(app)
      .get(`/api/projects/${slug}/episodes/${episodeNoPlan}/timeline`)
      .expect(200)
    assert.equal(response.body.timeline, null)
    assert.equal(response.body.can_build, false)
    assert.match(response.body.message, /no scene plan yet/)
  })

  test('POST builds one segment per scene and the shares total 100', async () => {
    const response = await request(app).post(timelineUrl()).send({}).expect(201)
    assert.equal(response.body.timeline.segments.length, 2)
    assert.deepEqual(
      response.body.timeline.segments.map((segment: any) => [segment.start_sec, segment.end_sec, segment.media_type]),
      [[0, 20, 't2i'], [20, 60, 't2i']],
    )
    assert.equal(sharesSum(response.body.shares), 100)
    assert.equal(response.body.timeline.episode_id, episodeId)
  })

  test('a second build refuses to overwrite unless replace is asked for', async () => {
    const refused = await request(app).post(timelineUrl()).send({}).expect(409)
    assert.match(refused.body.detail, /already has a timeline/)
    const replaced = await request(app).post(timelineUrl()).send({ replace: true }).expect(201)
    assert.equal(replaced.body.timeline.segments.length, 2)
    assert.equal(sharesSum(replaced.body.shares), 100)
  })

  test('an edit that would leave a second uncovered is refused', async () => {
    // Corrupt the stored file the way a bad writer would, so the refusal is
    // the validator's and not something the routes themselves could produce.
    const file = await service.timelinePath(slug, episodeId)
    const stored = JSON.parse(await fs.readFile(file, 'utf8'))
    stored.segments[1].start_sec = 25
    await fs.writeFile(file, JSON.stringify(stored))

    const response = await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(stored.segments[0].id)}`)
      .send({ media_type: 'sketch' })
      .expect(400)
    assert.match(response.body.detail, /every second must belong to one segment/)

    // The timeline is whole again for the rest of the file.
    await request(app).post(timelineUrl()).send({ replace: true }).expect(201)
  })

  test('set-media, split and merge round-trip and keep the shares at 100', async () => {
    const built = (await request(app).get(timelineUrl()).expect(200)).body
    const [first, second] = built.timeline.segments

    // Chart: the payload travels with the media choice.
    const chart = await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(first.id)}`)
      .send({ media_type: 'chart', chart: { kind: 'bar', labels: ['Q1', 'Q2'], values: [3, 5] } })
      .expect(200)
    assert.equal(chart.body.timeline.segments[0].media_type, 'chart')
    assert.deepEqual(chart.body.timeline.segments[0].chart.labels, ['Q1', 'Q2'])
    assert.equal(sharesSum(chart.body.shares), 100)

    // Stock refuses a segment with no clip identity, and accepts one with it.
    const noClip = await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(first.id)}`)
      .send({ media_type: 'stock' })
      .expect(400)
    assert.match(noClip.body.detail, /Pick a footage clip/)
    const withClip = await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(first.id)}`)
      .send({ media_type: 'stock', footage_sha256: STOCK_SHA })
      .expect(200)
    assert.equal(withClip.body.timeline.segments[0].footage_sha256, STOCK_SHA)

    // Back to a still, then split and merge the halves back together.
    const still = await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(first.id)}`)
      .send({ media_type: 't2i' })
      .expect(200)
    assert.equal(still.body.timeline.segments[0].media_type, 't2i')
    assert.equal(still.body.timeline.segments[0].chart, undefined)

    const split = await request(app)
      .post(`${timelineUrl()}/segments/${encodeURIComponent(first.id)}/split`)
      .send({ at_sec: 10 })
      .expect(200)
    assert.equal(split.body.timeline.segments.length, 3)
    // Rounding each share to two decimals can land a third of a cent over 100.
    assert.ok(Math.abs(sharesSum(split.body.shares) - 100) <= 0.02, 'shares must still total 100')

    const [a, b] = split.body.timeline.segments
    const merged = await request(app)
      .post(`${timelineUrl()}/merge`)
      .send({ first_id: a.id, second_id: b.id })
      .expect(200)
    assert.equal(merged.body.timeline.segments.length, 2)
    assert.equal(sharesSum(merged.body.shares), 100)
    assert.equal(merged.body.timeline.segments[0].media_type, 't2i')
  })

  test('video media is refused while the Gateway publishes no video model', async () => {
    imageRows = [pricedImageRow()]
    videoRows = [unavailableVideoRow()]
    clearGenStudioCatalogCache()

    const built = (await request(app).get(timelineUrl()).expect(200)).body
    const response = await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(built.timeline.segments[0].id)}`)
      .send({ media_type: 't2v' })
      .expect(400)
    assert.match(response.body.detail, /Gateway publishes no video model/)
  })

  test('preflight prices the timeline from the live catalogue', async () => {
    imageRows = [pricedImageRow(), unpricedImageRow()]
    videoRows = [availableVideoRow()]
    clearGenStudioCatalogCache()

    // A chart and a stock clip in the mix: both must cost nothing.
    const built = (await request(app).get(timelineUrl()).expect(200)).body
    const [first, second] = built.timeline.segments
    await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(second.id)}`)
      .send({ media_type: 'chart', chart: { kind: 'line', labels: ['a'], values: [1] } })
      .expect(200)
    await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(first.id)}`)
      .send({ media_type: 'stock', footage_sha256: STOCK_SHA })
      .expect(200)

    const response = await request(app)
      .post(`${timelineUrl()}/preflight`)
      .send({ image_model_id: IMAGE_MODEL_ID })
      .expect(200)

    // Live price, used as published: 4 credits for the one t2i segment left.
    assert.equal(response.body.image.price, 'published')
    assert.equal(response.body.image.credits_per_image, 4)
    assert.equal(response.body.has_published_video_model, true)
    // 50 credits / 5 seconds, from the catalogue's own variant.
    assert.equal(response.body.video.price, 'published')
    assert.equal(response.body.video.credits_per_second, 10)
    assert.equal(response.body.preflight.credits, 0, 'stock and chart segments are free; the t2i was replaced')
    assert.equal(response.body.preflight.by_media.chart.credits, 0)
    assert.equal(response.body.preflight.by_media.stock.credits, 0)
    assert.ok(response.body.preflight.estimated_seconds > 0)
    assert.ok(response.body.preflight.assembly_seconds > 0)
    assert.match(response.body.timing_note, /estimate/i)
  })

  test('a price the catalogue never published is reported, never invented', async () => {
    imageRows = [unpricedImageRow()]
    videoRows = []
    clearGenStudioCatalogCache()

    // Put a still back on the timeline: the image price is only consulted when
    // a segment would actually spend it.
    const built = (await request(app).get(timelineUrl()).expect(200)).body
    const still = built.timeline.segments.find((segment: any) => segment.media_type !== 't2i')
      || built.timeline.segments[0]
    await request(app)
      .patch(`${timelineUrl()}/segments/${encodeURIComponent(still.id)}`)
      .send({ media_type: 't2i' })
      .expect(200)

    const response = await request(app)
      .post(`${timelineUrl()}/preflight`)
      .send({ image_model_id: UNPRICED_IMAGE_MODEL_ID })
      .expect(200)

    assert.equal(response.body.image.price, 'price not published')
    assert.equal(response.body.image.credits_per_image, null)
    assert.equal(response.body.video.price, 'price not published')
    assert.equal(response.body.has_published_video_model, false)
    // No fabricated total: the answer says the price is missing instead of 0.
    assert.equal(response.body.preflight.credits, null)
    assert.equal(response.body.preflight.credits_note, 'price not published')
    assert.equal(response.body.preflight.by_media, undefined)
    // The duration estimate still stands on its own.
    assert.ok(response.body.preflight.estimated_seconds > 0)
  })

  test('preflight needs a chosen image model and a stored timeline', async () => {
    const noModel = await request(app)
      .post(`${timelineUrl()}/preflight`)
      .send({})
      .expect(400)
    assert.match(noModel.body.detail, /Choose an image model/)

    const noTimeline = await request(app)
      .post(`/api/projects/${slug}/episodes/${episodeNoPlan}/timeline/preflight`)
      .send({ image_model_id: IMAGE_MODEL_ID })
      .expect(404)
    assert.match(noTimeline.body.detail, /build it from the scene plan/)
  })
})
