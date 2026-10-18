/**
 * What one read of the Jobs list costs.
 *
 * WHY THIS FILE EXISTS. On 1.4.320 the production Mac mini answered a jobs read
 * in 30.8 s while `operations` took 0.78 s and `publishable` 1.1 s in the same
 * minute. The read is `/api/jobs/all` (and the `/api/jobs/all/stream` snapshot
 * the dashboard layout opens on every page) — `useAllJobs.refresh()` polls it
 * with `?view=stream` and the SSE snapshot carries the same body. Nothing about
 * it is bounded: it serializes EVERY job of EVERY channel, and the whole fleet
 * is the input. Measured on a 19-channel fixture at the 750-row-per-channel
 * retention cap (14,250 jobs): one 55 MB response, ~1 s of main-thread work in
 * a single synchronous block, 14,250 public serializations, and 4.7 million
 * strings walked through the redaction seam — of which the old shape copied
 * each string twice per registered key, ~1.2 GB of garbage per request.
 *
 * So this file pins the three things that made one read cost that much, and
 * that a future edit could quietly put back:
 *   1. the read never re-reads `jobs.json` (the fleet is already in memory);
 *   2. each job is serialized exactly once, and the public row is still a copy
 *      the caller can mutate without reaching the queue's record;
 *   3. the redaction seam copies nothing it does not have to change.
 *
 * WHAT IT CANNOT CATCH. A wall-clock budget on a busy machine. The timing
 * assertion below is deliberately loose — it is there to fail on a change of
 * *shape* (a per-job file probe, a second serialization pass, an O(n²) scan),
 * not to police milliseconds. It says nothing about the size of the response,
 * which is still proportional to the whole fleet's history.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { redactSecrets, registerSecretForRedaction } from '../lib/redact-secrets.js'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let app: express.Express

const PROJECTS = 19
const JOBS_PER_PROJECT = 120
const JOB_COUNT = PROJECTS * JOBS_PER_PROJECT

/** A job shaped like the ones a channel really holds: a log, params, evidence. */
function fixtureJob(slug: string, i: number) {
  return {
    job_id: `${slug}-job-${i}`,
    project_slug: slug,
    type: i % 3 === 0 ? 'continuity_render' : i % 3 === 1 ? 'audio' : 'youtube_upload',
    episode_id: `EP${String(i % 40).padStart(4, '0')}`,
    title: `Episode ${i}`,
    status: 'done',
    created_at: '2026-10-01T00:00:00Z',
    started_at: '2026-10-01T00:00:00Z',
    finished_at: '2026-10-01T00:05:00Z',
    error: null,
    output_lines: Array.from({ length: 40 }, (_, n) => `  ✓ Scene ${n}: saved EP${i}_Scene${n}_v1.png (3.2 MB) in 12.3s`),
    params: {
      generation_action: { id: `op-${i}`, kind: 'fresh' },
      episode_id: `EP${String(i % 40).padStart(4, '0')}`,
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
  }
}

describe('one read of the Jobs list', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    jq = await import('../services/job-queue.js')
    const { router } = await import('../routes/jobs.js')
    app = express().use(express.json()).use('/api', router)
    for (let p = 0; p < PROJECTS; p += 1) {
      const { slug } = await pm.createProject({ name: `Channel ${p}` })
      await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'jobs.json'), JSON.stringify({
        jobs: Array.from({ length: JOBS_PER_PROJECT }, (_, i) => fixtureJob(slug, i)),
      }))
    }
  })
  after(async () => { await tmp.cleanup() })

  test('the list never re-reads jobs.json, and serializes each job exactly once', async () => {
    // First read hydrates the fleet. Everything after it is in memory.
    await request(app).get('/api/jobs/all?view=stream').expect(200)
    jq._resetJobPersistenceCountersForTesting()
    const res = await request(app).get('/api/jobs/all?view=stream').expect(200)
    const counters = jq._getJobPersistenceCountersForTesting()

    assert.equal(res.body.jobs.length, JOB_COUNT)
    assert.equal(counters.project_snapshot_reads, 0,
      'the list must serve the in-memory queue, not re-read every channel\'s jobs.json')
    assert.equal(counters.atomic_writes, 0, 'a read must not write anything')
    assert.equal(counters.public_serializations, JOB_COUNT,
      'one public serialization per job: a second pass over every job is the regression this pins')
  })

  test('a read of the whole fleet returns inside its budget', async () => {
    await request(app).get('/api/jobs/all?view=stream').expect(200)
    const started = process.hrtime.bigint()
    await request(app).get('/api/jobs/all?view=stream').expect(200)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    // Measured 47 ms for these 2,280 jobs when this was written. The ceiling is
    // an order of magnitude of headroom for a loaded CI machine; what it fails
    // on is a change of shape, not a slow day.
    assert.ok(elapsedMs < 2_000,
      `a warm fleet read took ${elapsedMs.toFixed(0)} ms — the list path grew a per-job cost again`)
  })

  test('the rows a read hands out are copies, not the queue\'s own records', async () => {
    const first = (await request(app).get('/api/jobs/all?view=stream').expect(200)).body.jobs
    const row = first.find((job: any) => job.output_lines?.length)
    assert.ok(row, 'the fixture must produce rows with logs')
    row.output_lines.push('mutated by the reader')
    row.params.generation_action.id = 'mutated'
    const second = (await request(app).get('/api/jobs/all?view=stream').expect(200)).body.jobs
      .find((job: any) => job.job_id === row.job_id)
    assert.equal(second.output_lines.includes('mutated by the reader'), false,
      'editing a returned row must not reach the queue record')
    assert.notEqual(second.params.generation_action.id, 'mutated')
  })

  test('redaction copies no text it does not have to change', () => {
    registerSecretForRedaction('gsk_abcdefghijklmnopqrstuvwxyz012345')
    const line = '  ✓ Scene 12: saved EP0001_Scene12_v1.png (3.2 MB) in 12.3s'
    assert.ok(redactSecrets(line) === line,
      'a line with no secret must come back as the same string, not a rebuilt copy of it')
    // The other half: the skip must never let a real secret through, in either case.
    for (const text of [
      'Bearer gsk_abcdefghijklmnopqrstuvwxyz012345',
      'key GSK_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    ]) {
      const out = redactSecrets(text)
      assert.ok(out.includes('[REDACTED]'), `${text} was not redacted`)
      assert.equal(out.includes('012345'), false)
    }
  })
})
