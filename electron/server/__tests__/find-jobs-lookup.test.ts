import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let app: express.Express

async function writeJobs(slug: string, count: number) {
  await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'jobs.json'), JSON.stringify({
    jobs: Array.from({ length: count }, (_, i) => ({
      job_id: `${slug}-job-${i}`, project_slug: slug, type: i % 2 ? 'audio' : 'images', episode_id: `EP${String(i).padStart(4, '0')}`,
      title: 't', status: 'done', created_at: '2026-10-01T00:00:00Z', started_at: '2026-10-01T00:00:00Z',
      finished_at: '2026-10-01T00:00:00Z', error: null, output_lines: [],
      params: { generation_action: { id: `op-${i}`, kind: 'fresh' } },
    })),
  }))
}

describe('findJobs serialises only the matching jobs (S3)', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    jq = await import('../services/job-queue.js')
    const { router } = await import('../routes/jobs.js')
    app = express().use(express.json()).use('/api', router)
  })
  after(async () => { await tmp.cleanup() })

  test('a lookup returns the same row getJobs would, cloning one job instead of the whole history', async () => {
    const { slug } = await pm.createProject({ name: 'Find Jobs' })
    await writeJobs(slug, 40)
    const all = await jq.getJobs(slug)
    jq._resetJobPersistenceCountersForTesting()
    const found = await jq.findJobs(slug, job => job.params?.generation_action?.id === 'op-7')
    assert.equal(jq._getJobPersistenceCountersForTesting().public_serializations, 1)
    assert.deepEqual(found, [all.find(job => job.params?.generation_action?.id === 'op-7')])
    // The returned row is a clone: editing it must not reach the queue's record.
    found[0]!.params.generation_action.id = 'mutated'
    assert.equal((await jq.findJobs(slug, job => job.job_id === `${slug}-job-7`))[0]!.params.generation_action.id, 'op-7')
    assert.deepEqual(await jq.findJobs(slug, () => false), [])
  })

  test('the per-project job routes and the all-projects lookup find a job without serialising the rest', async () => {
    const { slug } = await pm.createProject({ name: 'Find Jobs Routes' })
    await writeJobs(slug, 30)
    await jq.getJobs(slug)
    jq._resetJobPersistenceCountersForTesting()
    await request(app).post(`/api/projects/${slug}/jobs/${slug}-job-3/hide`).expect(200)
    assert.ok(jq._getJobPersistenceCountersForTesting().public_serializations <= 3, 'hide looked up one job, not thirty')
    await request(app).post(`/api/projects/${slug}/jobs/no-such-job/hide`).expect(404)
    jq._resetJobPersistenceCountersForTesting()
    const res = await request(app).post(`/api/jobs/all/${slug}-job-5/hide`)
    assert.notEqual(res.status, 404, 'the all-projects lookup still finds the job')
    assert.ok(jq._getJobPersistenceCountersForTesting().public_serializations <= 3)
  })

  test('GET ?view=stream returns the slim view the REST fallbacks poll with (S5)', async () => {
    const { slug } = await pm.createProject({ name: 'Slim Fallback' })
    await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'jobs.json'), JSON.stringify({ jobs: [{
      job_id: `${slug}-big`, project_slug: slug, type: 'continuity_render', episode_id: 'EP0001', title: 't', status: 'done',
      created_at: '2026-10-01T00:00:00Z', started_at: null, finished_at: '2026-10-01T00:00:00Z', error: null, output_lines: [],
      params: { scenes: Array.from({ length: 50 }, (_, i) => ({ id: i })) },
      genstudio_jobs: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, operation: 'image.generation', state: 'succeeded' })),
    }] }))
    const full = (await request(app).get(`/api/projects/${slug}/jobs`).expect(200)).body.jobs[0]
    const slim = (await request(app).get(`/api/projects/${slug}/jobs?view=stream`).expect(200)).body.jobs[0]
    assert.equal(full.genstudio_jobs.length, 20)
    assert.equal(slim.genstudio_jobs, undefined)
    assert.equal(slim.genstudio_jobs_count, 20)
    assert.equal(slim.params.scenes, undefined)
    const all = (await request(app).get('/api/jobs/all?view=stream').expect(200)).body.jobs.find((job: any) => job.job_id === `${slug}-big`)
    assert.equal(all.genstudio_jobs, undefined)
  })
})
