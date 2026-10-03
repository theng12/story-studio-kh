/**
 * Job types removed from Story Studio (Expression markup, the legacy script-only
 * lane): an old row saved by a previous version must still list, must not crash
 * boot or the Jobs page, and Retry must refuse with one plain sentence. The
 * routes that created them are gone too.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import type { Job, JobType } from '../models/types.js'

const REFUSAL = /removed from Story Studio, so it cannot be retried/

function oldJob(slug: string, id: string, type: string, status: Job['status']): Job {
  const now = new Date().toISOString()
  return {
    job_id: id, project_slug: slug, type: type as JobType, episode_id: 'EP0001', title: `Old ${type}`,
    status, created_at: now, started_at: now, finished_at: status === 'queued' ? null : now,
    error: status === 'error' ? 'Original run failed.' : null, output_lines: [], params: { episode_id: 'EP0001' },
  } as Job
}

void test('old expression_markup and script-only jobs still list and Retry refuses plainly', async () => {
  const temp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')
    const { labelForJobType } = await import('../services/job-notifier.js')
    const project = await pm.createProject({ name: 'Removed job types' })

    const rows = [
      oldJob(project.slug, 'old-expression', 'expression_markup', 'error'),
      oldJob(project.slug, 'old-script', 'script-only', 'error'),
      oldJob(project.slug, 'old-script-done', 'script-only', 'done'),
      oldJob(project.slug, 'old-script-queued', 'script-only', 'queued'),
    ]
    await fs.writeFile(path.join(temp.dir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: rows }))

    // Loading must not throw, and every row is listed.
    const listed = await jq.getJobs(project.slug)
    assert.deepEqual(
      ['old-expression', 'old-script', 'old-script-done', 'old-script-queued'].filter(id => listed.some(job => job.job_id === id)),
      ['old-expression', 'old-script', 'old-script-done', 'old-script-queued'],
    )
    const viaRoute = await request(app).get(`/api/projects/${project.slug}/jobs`)
    assert.equal(viaRoute.status, 200, JSON.stringify(viaRoute.body))

    // They still read as words, not slugs.
    assert.equal(labelForJobType('expression_markup'), 'Expression markup')
    assert.equal(labelForJobType('script-only'), 'Script')

    for (const id of ['old-expression', 'old-script']) {
      const refused = await request(app).post(`/api/projects/${project.slug}/jobs/${id}/retry`).send({})
      assert.equal(refused.status, 409, JSON.stringify(refused.body))
      assert.match(refused.body.detail, REFUSAL)
      const refusedUniversal = await request(app).post(`/api/jobs/all/${id}/retry`).send({})
      assert.equal(refusedUniversal.status, 409, JSON.stringify(refusedUniversal.body))
      assert.match(refusedUniversal.body.detail, REFUSAL)
      assert.equal(jq.getJob(id)?.job_id, id, 'a refused retry keeps the old row')
    }

    // Even a caller that skips the route's own check cannot enqueue a lane that no longer exists.
    assert.throws(() => jq.retryTerminalJob(project.slug, 'old-script'), REFUSAL)
    assert.equal(jq.knownJobTypes().includes('script-only' as JobType), false)
    assert.equal(jq.knownJobTypes().includes('expression_markup' as JobType), false)
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

void test('the routes that made those jobs, and the debug route, are gone', async () => {
  const temp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = (await import('../app.js')).app
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Removed routes' })
    const base = `/api/projects/${project.slug}`

    for (const [method, url] of [
      ['post', `${base}/generate/script-only`],
      ['get', `${base}/episodes/EP0001/expression`],
      ['post', `${base}/episodes/EP0001/expression/generate-all`],
      ['post', `${base}/episodes/EP0001/expression/generate`],
      ['put', `${base}/episodes/EP0001/expression`],
      ['get', '/api/debug/info'],
    ] as const) {
      const response = await request(app)[method](url).send({})
      assert.equal(response.status, 404, `${method.toUpperCase()} ${url} should be gone`)
    }

    const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const ideas = readFileSync(path.join(serverRoot, 'routes/ideas.ts'), 'utf8')
    assert.doesNotMatch(ideas, /auto_generate_script/)
    const audio = readFileSync(path.join(serverRoot, 'generators/audio.ts'), 'utf8')
    assert.doesNotMatch(audio, /use_expression|fish_autopace/)

    // The request schema drops the old preset fields instead of passing them to the generator.
    const { GenerateAudioSchema } = await import('../schemas/index.js')
    const parsed = GenerateAudioSchema.parse({
      episode_id: 'EP0001', model: 'm', voice: 'v', use_expression: true, fish_autopace: true, expression_model: 'x',
    }) as Record<string, unknown>
    assert.equal('use_expression' in parsed, false)
    assert.equal('fish_autopace' in parsed, false)
    assert.equal('expression_model' in parsed, false)
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

void test('Pipeline no longer has a B-Roll step (the B-Roll page and its jobs are untouched)', async () => {
  const pipeline = await import('../routes/pipeline.js')
  assert.equal(pipeline.VALID_STEPS.includes('broll' as never), false)
  assert.equal('broll' in pipeline.PRESET_KEYS, false)
  assert.equal('broll' in pipeline.STEP_JOB_TYPE, false)
  const jq = await import('../services/job-queue.js')
  for (const type of ['broll_select', 'broll_assemble', 'broll_normalize']) {
    assert.equal(jq.knownJobTypes().includes(type as JobType), true, `${type} still has a lane`)
  }
})
