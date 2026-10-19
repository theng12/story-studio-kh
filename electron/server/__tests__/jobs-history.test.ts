/**
 * The finished-history read: paged, searched and counted on the server.
 *
 * WHY THIS FILE EXISTS. The Jobs page used to hold every job of every channel
 * in memory — ~14k rows and ~128 MB per read at production size, most of it
 * `output_lines` no collapsed card renders — and did its searching, paging and
 * select-all there. `GET /jobs/all/history` moves the heavy half to the server.
 * What this file pins:
 *   1. paging is keyset and lossless: every row appears exactly once, in one
 *      order, across the pages;
 *   2. the search matches what the page's own `matchesEpisodeSearch` matches —
 *      the rule lives in `contracts/jobs-history.ts` and both sides import it;
 *   3. `total` counts matches, not the page, so "select all N matching" is
 *      still the truth;
 *   4. `ids=1` is the cheap selector a bulk action takes;
 *   5. a row carries the three small fields the card reads instead of the log;
 *   6. the live snapshot's size does not grow with finished history — the
 *      regression that made every page pay for the fleet's whole past.
 *
 * WHAT IT CANNOT CATCH. Wall-clock on a busy machine: the timing assertion is
 * deliberately loose and fails on a change of SHAPE, not on a slow day.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { matchesEpisodeSearch } from '../contracts/jobs-history.js'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let app: express.Express

const HISTORY_PER_PROJECT = 60
const LIVE_PER_PROJECT = 3

/** Strictly increasing with `i`, so "newest finished first" is exactly "highest index first". */
const stamp = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString()

/** A finished job shaped like the ones a channel really holds: a log, params, evidence. */
function finishedJob(slug: string, i: number, overrides: Record<string, unknown> = {}) {
  const episode = `EP${String(i % 12).padStart(4, '0')}`
  return {
    job_id: `${slug}-job-${String(i).padStart(3, '0')}`,
    project_slug: slug,
    type: i % 3 === 0 ? 'continuity_render' : i % 3 === 1 ? 'audio' : 'youtube_upload',
    episode_id: episode,
    title: `Episode ${i} of ${slug}`,
    status: 'done',
    created_at: stamp(i),
    started_at: stamp(i),
    finished_at: stamp(i + 1),
    error: null,
    output_lines: [
      `Chapter ${i} sent to the Gateway.`,
      ...Array.from({ length: 40 }, (_, n) => `  ✓ Scene ${n}: saved ${episode}_Scene${n}_v1.png (3.2 MB) in 12.3s`),
      `All images saved to: /Users/someone/Story Studio/${slug}/episodes/${episode}`,
    ],
    params: {
      generation_action: { id: `op-${i}`, kind: 'fresh' },
      episode_id: episode,
      model: 'some-model',
      scenes: Array.from({ length: 12 }, (_, n) => ({ id: n, prompt: 'x'.repeat(120) })),
    },
    progress: 100,
    item_progress: { done: 12, total: 12, failed: 0 },
    genstudio_jobs: Array.from({ length: 4 }, (_, n) => ({
      id: `task-${i}-${n}`,
      operation: n % 2 ? 'image.generation' : 'voice.tts',
      state: 'succeeded',
      updated_at: '2026-10-01T00:04:00Z',
      reserved_credits: 4, settled_credits: 4, released_credits: 0,
      request: { idempotency_key: `story-${i}-${n}` },
    })),
    ...overrides,
  }
}

function liveJob(slug: string, i: number) {
  return {
    job_id: `${slug}-live-${i}`,
    project_slug: slug,
    type: 'audio',
    episode_id: `LIVE${i}`,
    title: `Live ${i}`,
    // Paused, never `running` or `queued`: hydration marks a loaded `running`
    // row "Interrupted by app restart" and the queue dispatches a loaded
    // `queued` row into a real executor, so either would make this fixture's
    // counts depend on another subsystem's behaviour.
    status: 'paused',
    created_at: '2026-10-03T00:00:00Z',
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: ['Working.'],
    params: { episode_id: `LIVE${i}` },
  }
}

async function seed(slug: string, count: number, live: number) {
  const { slug: created } = await pm.createProject({ name: slug })
  await fs.writeFile(path.join(pm.getProjectDir(created)!, 'jobs.json'), JSON.stringify({
    jobs: [
      ...Array.from({ length: count }, (_, i) => finishedJob(created, i)),
      ...Array.from({ length: live }, (_, i) => liveJob(created, i)),
    ],
  }))
  return created
}

const pageOf = (body: any) => body.jobs as any[]

describe('finished history read', () => {
  let slugs: string[] = []

  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    jq = await import('../services/job-queue.js')
    const { router } = await import('../routes/jobs.js')
    app = express().use(express.json()).use('/api', router)
    slugs = [await seed('channel-one', HISTORY_PER_PROJECT, LIVE_PER_PROJECT)]
  })
  after(async () => { await tmp.cleanup() })

  test('the history is paged newest-finished-first, and the pages tile the whole set', async () => {
    const first = await request(app).get('/api/jobs/all/history?limit=10').expect(200)
    assert.equal(pageOf(first.body).length, 10)
    assert.equal(first.body.total, HISTORY_PER_PROJECT)
    assert.ok(first.body.next_cursor, 'a full page must offer a cursor')

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const url: string = `/api/jobs/all/history?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const body: any = (await request(app).get(url).expect(200)).body
      seen.push(...pageOf(body).map((job: any) => job.job_id))
      cursor = body.next_cursor
      pages += 1
      assert.ok(pages < 20, 'paging must terminate')
    } while (cursor)

    assert.equal(seen.length, HISTORY_PER_PROJECT, 'every finished row appears exactly once')
    assert.equal(new Set(seen).size, seen.length, 'no row appears twice across pages')

    const finished = seen.map(id => Number(id.split('-').pop()))
    const sorted = [...finished].sort((a, b) => b - a)
    assert.deepEqual(finished, sorted, 'newest finished first, across the page boundary too')
  })

  test('a live job is not history, and a recovered failure reads recovered', async () => {
    const slug = await seed('channel-recovered', 6, 2)
    await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'jobs.json'), JSON.stringify({
      jobs: [
        finishedJob(slug, 0, {
          status: 'error',
          error: 'boom',
          resolved: { at: '2026-10-02T01:00:00Z', reason: 'files were made later' },
        }),
        finishedJob(slug, 1, { status: 'error', error: 'boom' }),
        finishedJob(slug, 2, { status: 'cancelled' }),
        liveJob(slug, 0),
      ],
    }))
    await request(app).get(`/api/projects/${slug}/jobs/history?limit=1`).expect(200)

    const all = await request(app).get(`/api/projects/${slug}/jobs/history?limit=50`).expect(200)
    assert.equal(all.body.total, 3, 'the running row is not part of the history')
    assert.equal(all.body.facets, undefined, 'facets are opt-in')

    const recovered = await request(app).get(`/api/projects/${slug}/jobs/history?status=recovered`).expect(200)
    assert.deepEqual(pageOf(recovered.body).map((job: any) => job.job_id), [`${slug}-job-000`])

    const errors = await request(app).get(`/api/projects/${slug}/jobs/history?status=error`).expect(200)
    assert.deepEqual(pageOf(errors.body).map((job: any) => job.job_id), [`${slug}-job-001`],
      'a recovered failure is history that reads recovered, not a row that needs attention')

    const facets = await request(app).get(`/api/projects/${slug}/jobs/history?facets=1`).expect(200)
    assert.equal(facets.body.facets.status.recovered, 1)
    assert.equal(facets.body.facets.status.error, 1)
    assert.equal(facets.body.facets.status.cancelled, 1)
    assert.equal(facets.body.facets.stats.paused, 1, 'the header counts describe the whole scope')
  })

  test('the search matches exactly what the page\'s own matcher matches', async () => {
    const slug = slugs[0]!
    for (const query of ['EP0003', 'episode 7', 'CHANNEL-ONE', '  ', 'nothing-matches-this']) {
      const server = await request(app)
        .get(`/api/projects/${slug}/jobs/history?all=1&q=${encodeURIComponent(query)}`)
        .expect(200)
      const rows = pageOf(server.body)
      const expected = Array.from({ length: HISTORY_PER_PROJECT }, (_, i) => finishedJob(slug, i))
        .filter(job => matchesEpisodeSearch(job, query))
      assert.equal(rows.length, expected.length, `"${query}" matched a different set on the server`)
      assert.deepEqual(
        new Set(rows.map((job: any) => job.job_id)),
        new Set(expected.map(job => job.job_id)),
        `"${query}" matched different rows on the server`,
      )
      assert.equal(server.body.total, expected.length, `"${query}" reported the wrong total`)
    }
  })

  test('total counts every match, not the page, and ids=1 is the cheap selector', async () => {
    const slug = slugs[0]!
    const page = await request(app).get(`/api/projects/${slug}/jobs/history?limit=5&type=audio`).expect(200)
    const expected = Array.from({ length: HISTORY_PER_PROJECT }, (_, i) => finishedJob(slug, i))
      .filter(job => job.type === 'audio')
    assert.equal(pageOf(page.body).length, 5)
    assert.equal(page.body.total, expected.length, 'total is the matching count, not the page size')

    const ids = await request(app).get(`/api/projects/${slug}/jobs/history?ids=1&type=audio`).expect(200)
    assert.deepEqual(ids.body.jobs, [], 'the selector carries ids, not rows')
    assert.equal(ids.body.ids.length, expected.length, 'the selector covers every matching row, not one page')
    assert.equal(ids.body.total, expected.length)
    assert.deepEqual(ids.body.ids, pageOf(page.body).map((job: any) => job.job_id).slice(0, 5).concat(
      ids.body.ids.slice(5),
    ), 'ids come back in the page order')
  })

  test('a history row carries the summary fields instead of the log', async () => {
    const slug = slugs[0]!
    const body = (await request(app).get(`/api/projects/${slug}/jobs/history?limit=3`).expect(200)).body
    for (const row of pageOf(body)) {
      assert.equal(row.output_lines, undefined, 'a closed row must not ship its log')
      assert.equal(row.output_line_count, 42, 'the card still knows how many steps there were')
      assert.match(row.summary_line, /All images saved to: /, 'the summary line the card shows')
      assert.equal(row.output_dir, `/Users/someone/Story Studio/${slug}/episodes/${row.episode_id}`)
      assert.equal(row.genstudio_jobs, undefined, 'the slim view still omits full evidence')
      assert.equal(row.genstudio_jobs_count, 4)
    }
  })

  test('an unknown project is a 404, and a bad limit is refused rather than guessed', async () => {
    await request(app).get('/api/projects/no-such-channel/jobs/history').expect(404)
    await request(app).get('/api/jobs/all/history?limit=0').expect(400)
    await request(app).get('/api/jobs/all/history?limit=100000').expect(400)
    await request(app).get('/api/jobs/all/history?status=exploded').expect(400)
  })

  test('the live snapshot does not grow with finished history', async () => {
    const small = await seed('snapshot-small', 2, LIVE_PER_PROJECT)
    const large = await seed('snapshot-large', 400, LIVE_PER_PROJECT)
    const bodyOf = async (url: string) => (await request(app).get(url).expect(200)).body
    const bytesOf = async (url: string) => Buffer.byteLength(JSON.stringify(await bodyOf(url)))

    const smallBody = await bodyOf(`/api/projects/${small}/jobs?view=active`)
    const largeBody = await bodyOf(`/api/projects/${large}/jobs?view=active`)
    assert.equal(smallBody.jobs.length, LIVE_PER_PROJECT)
    assert.equal(largeBody.jobs.length, LIVE_PER_PROJECT,
      '400 finished rows in one channel must not add a single row to the live snapshot')
    assert.equal(largeBody.stats.total, 400 + LIVE_PER_PROJECT,
      'the header counts still describe the whole scope, not just the live rows')

    const smallBytes = await bytesOf(`/api/projects/${small}/jobs?view=active`)
    const largeBytes = await bytesOf(`/api/projects/${large}/jobs?view=active`)
    assert.ok(largeBytes - smallBytes < 200,
      `the live snapshot grew by ${largeBytes - smallBytes} B when the channel's history grew by 398 rows`)

    const activeBytes = await bytesOf('/api/jobs/all?view=active')
    const streamBytes = await bytesOf('/api/jobs/all?view=stream')
    const started = process.hrtime.bigint()
    await bodyOf('/api/jobs/all?view=active')
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    // The numbers are reported, not asserted to a millisecond: what this fails
    // on is the live read growing back into the fleet's whole past.
    console.log(`[jobs-history] fleet snapshot: active ${activeBytes} B vs stream ${streamBytes} B, warm read ${elapsedMs.toFixed(0)} ms`)
    const historyRows = await bytesOf(`/api/jobs/all/history?all=1&project=${large}`)
    const historyStream = await bytesOf(`/api/projects/${large}/jobs?view=stream`)
    console.log(`[jobs-history] ${large}: history rows ${historyRows} B vs stream rows ${historyStream} B`)
    // The row drops the log (the bulk of a streamed row); what is left is params
    // and evidence the page still reads. Re-adding `output_lines` would take this
    // ratio back under 1.
    assert.ok(historyRows * 2 < historyStream,
      `a history row is ${historyRows} B against the stream view's ${historyStream} B — the log is back on the wire`)
    assert.ok(activeBytes * 4 < streamBytes,
      `the live snapshot is ${activeBytes} B against the history-carrying view's ${streamBytes} B — it is scaling with history again`)
    assert.ok(elapsedMs < 2_000, `a warm active read took ${elapsedMs.toFixed(0)} ms`)
  })

  test('the paged history read serializes only the page it returns', async () => {
    await request(app).get('/api/jobs/all/history?limit=10').expect(200)
    jq._resetJobPersistenceCountersForTesting()
    const body = (await request(app).get('/api/jobs/all/history?limit=10').expect(200)).body
    const counters = jq._getJobPersistenceCountersForTesting()
    assert.equal(pageOf(body).length, 10)
    assert.equal(counters.project_snapshot_reads, 0, 'the fleet is already in memory')
    assert.equal(counters.public_serializations, 10,
      'one serialization per returned row — filtering and sorting read the raw queue')
  })
})
