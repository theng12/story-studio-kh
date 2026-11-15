/**
 * The timeline render path — the four pins the owner asked for:
 *
 *   1. a mixed timeline dispatches one job per segment of the right type;
 *   2. a segment that already succeeded is reused, never re-submitted;
 *   3. the assembled video's duration equals the timeline's duration;
 *   4. an unpublished price never becomes 0 (preflight stays null, the
 *      render refuses rather than spending blind).
 *
 * Zero paid calls: the catalogue comes from a stubbed `fetch`; the assembly
 * runs real local FFmpeg over locally rendered chart PNGs.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

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
let render: typeof import('../services/episode-timeline-render.js')
let jq: typeof import('../services/job-queue.js')
let setApiKey: typeof import('../services/app-secrets-store.js')['setApiKey']
let clearGenStudioCatalogCache: typeof import('../lib/genstudio-client.js')['clearGenStudioCatalogCache']

let slug = ''
let episodeId = ''
let mixedEpisodeId = ''
const restoreExecutors: Array<() => void> = []

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
    modes: ['image-to-video', 'text-to-video'],
    aspect_ratios: ['16:9'],
    variants: [
      { operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'fixture-video-v1' },
      { operation: 'text-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 40, minimum_credits: 40, price_version: 'fixture-video-v1' },
    ],
  }
}

async function writeScenePlan(code: string, scenes: Array<[number, number]>): Promise<void> {
  const paths = await (await import('../services/utils.js')).resolveEpisodePathsByCode(slug, code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(`${paths.scene_prompts_dir}/scene_plan.json`, JSON.stringify({
    schema_version: 1,
    total_duration_sec: scenes[scenes.length - 1]![1],
    scenes: scenes.map(([start, end], index) => ({
      id: `scene-${String(index + 1).padStart(3, '0')}`,
      scene_index: index + 1,
      start_sec: start,
      end_sec: end,
      visual_prompt: `Scene ${index + 1} prompt.`,
    })),
  }))
}

async function makeEpisode(title: string): Promise<string> {
  const [idea] = await ideas.addIdeas(slug, [{
    title,
    logline: 'Timeline render fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea, 'the fixture episode must be accepted')
  const accepted = await ideas.acceptIdea(slug, idea.id, false)
  return accepted.episode_code
}

const timelineUrl = (code: string) => `/api/projects/${slug}/episodes/${code}/timeline`

describe('episode timeline render path', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    ideas = await import('../services/idea-manager.js')
    service = await import('../services/episode-timeline.js')
    render = await import('../services/episode-timeline-render.js')
    jq = await import('../services/job-queue.js')
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

    // No-op executors so dispatched jobs reach a terminal state without any
    // provider work; the dispatch pins only need the queue to accept them.
    for (const type of ['timeline_image', 'timeline_sketch', 'timeline_chart', 'timeline_stock', 'timeline_video', 'timeline_assemble'] as const) {
      restoreExecutors.push(jq._setExecutorForTesting(type, async () => {}))
    }

    const project = await pm.createProject({ name: 'Timeline Render', episode_prefix: 'TR', episode_digits: 3 })
    slug = project.slug
    episodeId = await makeEpisode('Lantern River')
    mixedEpisodeId = await makeEpisode('Mixed Timeline')
    imageRows = [pricedImageRow()]
    videoRows = [availableVideoRow()]
    clearGenStudioCatalogCache()

    // Four scenes → four segments, one per media family in the dispatch pin.
    await writeScenePlan(mixedEpisodeId, [[0, 10], [10, 25], [25, 40], [40, 60]])
    await request(app).post(timelineUrl(mixedEpisodeId)).send({}).expect(201)
  })

  after(async () => {
    for (const restore of restoreExecutors) restore()
    globalThis.fetch = originalFetch
    await tmp.cleanup()
  })

  test('a mixed timeline dispatches one job per segment of the right type', async () => {
    const built = (await request(app).get(timelineUrl(mixedEpisodeId)).expect(200)).body
    assert.equal(built.timeline.segments.length, 4)
    const [first, second, third, fourth] = built.timeline.segments

    await request(app)
      .patch(`${timelineUrl(mixedEpisodeId)}/segments/${encodeURIComponent(first.id)}`)
      .send({ media_type: 'chart', chart: { kind: 'bar', labels: ['Q1'], values: [3] } })
      .expect(200)
    await request(app)
      .patch(`${timelineUrl(mixedEpisodeId)}/segments/${encodeURIComponent(second.id)}`)
      .send({ media_type: 'stock', footage_sha256: STOCK_SHA })
      .expect(200)
    // third stays t2i (the built default); fourth becomes text-to-video.
    await request(app)
      .patch(`${timelineUrl(mixedEpisodeId)}/segments/${encodeURIComponent(fourth.id)}`)
      .send({ media_type: 't2v' })
      .expect(200)

    const response = await request(app)
      .post(`${timelineUrl(mixedEpisodeId)}/render`)
      .send({ image_model_id: IMAGE_MODEL_ID })
      .expect(200)

    assert.equal(response.body.dispatched.length, 4, 'one job per segment')
    const bySegment = new Map<string, string>(
      response.body.dispatched.map((entry: any) => [entry.segment_id, entry.job_type]),
    )
    assert.equal(bySegment.get(first.id), 'timeline_chart')
    assert.equal(bySegment.get(second.id), 'timeline_stock')
    assert.equal(bySegment.get(third.id), 'timeline_image')
    assert.equal(bySegment.get(fourth.id), 'timeline_video')
    const jobIds = new Set(response.body.dispatched.map((entry: any) => entry.job_id))
    assert.equal(jobIds.size, 4, 'each segment got its own job')
    // The render's quote is the preflight's quote — same helper, same figures.
    assert.equal(response.body.preflight.credits, 4 + 40, 'one still at 4 + one t2v at the published clip price')
    assert.equal(response.body.image.credits_per_image, 4)
  })

  test('a segment that already succeeded is reused, not re-submitted', async () => {
    const built = (await request(app).get(timelineUrl(mixedEpisodeId)).expect(200)).body
    const chartSegment = built.timeline.segments.find((segment: any) => segment.media_type === 'chart')
    assert.ok(chartSegment, 'the chart segment from the dispatch pin')

    // A finished render for exactly this content, output still on disk.
    const fingerprint = render.fingerprintSegment(chartSegment, IMAGE_MODEL_ID)
    const dir = await render.timelineRenderDir(slug, mixedEpisodeId)
    const outputPath = path.join(dir, 'segments', `${chartSegment.id}.png`)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, Buffer.from('already-rendered'))
    await render.updateTimelineRenderState(slug, mixedEpisodeId, state => {
      state.segments[chartSegment.id] = {
        media_type: 'chart',
        fingerprint,
        status: 'done',
        output_path: outputPath,
        charged_credits: 0,
        updated_at: new Date().toISOString(),
      }
    })

    const response = await request(app)
      .post(`${timelineUrl(mixedEpisodeId)}/render`)
      .send({ image_model_id: IMAGE_MODEL_ID, segment_ids: [chartSegment.id] })
      .expect(200)

    assert.deepEqual(response.body.reused, [chartSegment.id])
    assert.equal(response.body.dispatched.length, 0, 'the finished segment must not be bought again')
    assert.equal(response.body.already_queued.length, 0)
  })

  test('an unpublished price never becomes 0', async () => {
    imageRows = [unpricedImageRow()]
    videoRows = []
    clearGenStudioCatalogCache()

    // A still back on the timeline so the image price is actually consulted.
    await writeScenePlan(episodeId, [[0, 20], [20, 60]])
    const built = (await request(app).get(timelineUrl(episodeId)).expect(200)).body
    if (!built.timeline) {
      await request(app).post(timelineUrl(episodeId)).send({}).expect(201)
    }
    const current = (await request(app).get(timelineUrl(episodeId)).expect(200)).body
    const still = current.timeline.segments[0]
    await request(app)
      .patch(`${timelineUrl(episodeId)}/segments/${encodeURIComponent(still.id)}`)
      .send({ media_type: 't2i' })
      .expect(200)

    const preflight = await request(app)
      .post(`${timelineUrl(episodeId)}/preflight`)
      .send({ image_model_id: UNPRICED_IMAGE_MODEL_ID })
      .expect(200)
    assert.equal(preflight.body.preflight.credits, null, 'unknown stays null, never 0')
    assert.equal(preflight.body.preflight.credits_note, 'price not published')

    // The render refuses with the same null quote instead of spending blind.
    const refused = await request(app)
      .post(`${timelineUrl(episodeId)}/render`)
      .send({ image_model_id: UNPRICED_IMAGE_MODEL_ID })
      .expect(409)
    assert.equal(refused.body.preflight.credits, null)
    assert.match(refused.body.detail, /publishes no price/)
    assert.equal(refused.body.dispatched, undefined, 'nothing is dispatched on an unknown price')
    assert.notEqual(refused.body.preflight.credits, 0)

    // Restore the priced catalogue for anything after this pin.
    imageRows = [pricedImageRow()]
    videoRows = [availableVideoRow()]
    clearGenStudioCatalogCache()
  })

  test("the assembled video's duration equals the timeline's duration", async () => {
    // A dedicated 4.0s episode: two chart segments (1.5s + 2.5s), both frame-
    // aligned at 30fps, rendered locally and assembled by the real executor.
    const asmEpisodeId = await makeEpisode('Assembly Duration')
    await writeScenePlan(asmEpisodeId, [[0, 1.5], [1.5, 4]])
    await request(app).post(timelineUrl(asmEpisodeId)).send({}).expect(201)
    const built = (await request(app).get(timelineUrl(asmEpisodeId)).expect(200)).body
    const [first, second] = built.timeline.segments
    for (const segment of [first, second]) {
      await request(app)
        .patch(`${timelineUrl(asmEpisodeId)}/segments/${encodeURIComponent(segment.id)}`)
        .send({ media_type: 'chart', chart: { kind: 'bar', labels: ['a', 'b'], values: [1, 2] } })
        .expect(200)
    }
    const timeline = (await request(app).get(timelineUrl(asmEpisodeId)).expect(200)).body.timeline
    assert.equal(timeline.total_duration_sec, 4)

    // Two real chart PNGs as the segment outputs — the producers the dispatch
    // would have run, minus the queue.
    const chart = await import('../services/chart-render.js')
    const dir = await render.timelineRenderDir(slug, asmEpisodeId)
    const outputs: string[] = []
    for (const segment of timeline.segments) {
      const { png } = await chart.renderChartPng({ kind: 'bar', labels: ['a', 'b'], values: [1, 2] })
      const out = path.join(dir, 'segments', `${segment.id}.png`)
      await fs.mkdir(path.dirname(out), { recursive: true })
      await fs.writeFile(out, png)
      outputs.push(out)
    }
    await render.updateTimelineRenderState(slug, asmEpisodeId, state => {
      timeline.segments.forEach((segment: any, index: number) => {
        state.segments[segment.id] = {
          media_type: 'chart',
          fingerprint: render.fingerprintSegment(segment),
          status: 'done',
          output_path: outputs[index],
          charged_credits: 0,
          updated_at: new Date().toISOString(),
        }
      })
    })

    const job: any = {
      job_id: 'test-assembly',
      project_slug: slug,
      type: 'timeline_assemble',
      episode_id: asmEpisodeId,
      title: 'Timeline assembly',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
    }
    await render.runTimelineAssembleJob(job)

    const state = await render.readTimelineRenderState(slug, asmEpisodeId)
    assert.equal(state.assembly?.status, 'done')
    assert.ok(state.assembly?.output_path, 'the assembly records where the video landed')
    const { probeForUpload } = await import('../lib/ffprobe-check.js')
    const probe = await probeForUpload(state.assembly!.output_path!)
    assert.ok(probe.ok, `assembled file must probe: ${probe.error ?? 'ok'}`)
    assert.ok(
      Math.abs(probe.durationSec - timeline.total_duration_sec) <= 0.15,
      `assembled ${probe.durationSec}s must equal the ${timeline.total_duration_sec}s timeline within frame rounding`,
    )
  })
})
