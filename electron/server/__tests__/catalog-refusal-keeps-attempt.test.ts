/**
 * A refusal BEFORE submission must not spend one of the job's attempts.
 *
 * HMH0110 (`pipeline-handoff-94693f85a01cd7a58bce7607`, 2026-11-16 16:08:44Z)
 * reached `auto_retry: 3 of 3, exhausted` on: "The Gateway voice model
 * catalogue could not be refreshed and the cached copy is 31 minute(s) old,
 * beyond the 30-minute staleness limit … nothing was requested and no credits
 * were charged." Nothing was sent, no Mac was tried, nothing was charged — and
 * the row still spent all three attempts on it. Gateway 0.2.263 already treats a
 * refusal that accepted nothing as not spending an attempt; Story must agree.
 *
 * The decisive number is how many times the executor is called: three before the
 * fix (one attempt each), four after (the refused turn handed back).
 */
import { after, before, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { waitFor } from './_timing.js'
import '../../../scripts/testing/loopback-supertest.mjs'

let tempDir = ''
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let wasQueuePaused = false
const fixtureProjects = new Set<string>()
const previousEnvironment = new Map(
  ['STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]),
)

function restoreEnvironment(): void {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function waitForSettled(projectSlug: string, label: string): Promise<void> {
  await waitFor(async () => {
    const jobs = await jq.getJobs(projectSlug)
    return jobs.every(job => !jq._isJobWorkerActiveForTesting(job.job_id) && job.status !== 'queued')
  }, { label })
  await jq._waitForJobPersistenceForTesting()
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the retained owner-only root is isolated')
  tempDir = await fs.mkdtemp(path.join(harnessRoot, 'catalog-refusal-retained-'))
  await fs.chmod(tempDir, 0o700)
  process.env.STORY_STUDIO_DATA_DIR = tempDir
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  wasQueuePaused = jq.isQueuePaused()
  await jq.setQueuePaused(false)
})

after(async () => {
  try {
    if (!jq) return
    await jq.setQueuePaused(false)
    for (const projectSlug of fixtureProjects) await waitForSettled(projectSlug, `${projectSlug} workers settle`)
    await jq._waitForJobPersistenceForTesting()
    await jq.setQueuePaused(wasQueuePaused)
    await jq._waitForJobPersistenceForTesting()
  } finally {
    restoreEnvironment()
  }
})

async function fixture(t: TestContext, name: string) {
  const project = await pm.createProject({ name })
  fixtureProjects.add(project.slug)
  const restorers: Array<() => void> = []
  t.after(async () => {
    for (const restore of restorers.reverse()) restore()
    await waitForSettled(project.slug, `${name} workers settle`)
  })
  return { project, restoreWith: (restore: () => void) => restorers.push(restore) }
}

test('a stale-catalogue refusal hands its attempt back, so the job still has tries left', async t => {
  const f = await fixture(t, 'Catalogue refusal keeps attempt')
  const { _setJobAutoRetryDelaysForTesting } = await import('../services/job-retry-policy.js')
  const { GenStudioCatalogUnavailableError } = await import('../lib/genstudio-client.js')
  _setJobAutoRetryDelaysForTesting(0)
  f.restoreWith(() => _setJobAutoRetryDelaysForTesting(null))
  jq._setCatalogRefusalCeilingForTesting(60_000)
  f.restoreWith(() => jq._setCatalogRefusalCeilingForTesting(null))

  let calls = 0
  f.restoreWith(jq._setExecutorForTesting('audio', async (job: Job) => {
    calls += 1
    if (calls === 1) {
      // Nothing was submitted: the catalogue was 31 minutes stale.
      throw new GenStudioCatalogUnavailableError('tts-models', 31 * 60_000)
    }
    // Every later turn fails for an ordinary reason, so the attempts that remain
    // are the ones the refusal did not spend.
    throw new Error('Narration chunk 03 failed at the provider.')
  }))

  const job = await jq.enqueue({
    project_slug: f.project.slug,
    type: 'audio',
    episode_id: 'HMH0110',
    title: 'Pipeline: Audio — HMH0110',
    params: { episode_id: 'HMH0110', model: 'studio-hub::demo/Breeze-TTS-2-mlx-4bit', sections: 'all' },
  })

  await waitFor(async () => {
    const rows = await jq.getJobs(f.project.slug)
    const row = rows.find(candidate => candidate.job_id === job.job_id)
    return !!row && !jq._isJobWorkerActiveForTesting(row.job_id) && row.status === 'error'
  }, { label: 'the job settles' })
  await waitForSettled(f.project.slug, 'catalogue refusal job settles')

  const rows = await jq.getJobs(f.project.slug)
  const settled = rows.find(candidate => candidate.job_id === job.job_id)!
  assert.equal(settled.status, 'error')
  assert.equal(settled.auto_retry?.max_attempts, 3, 'the fixture must publish three attempts')
  assert.equal(calls, 4,
    'the refused turn must be handed back: three ordinary failures still fit inside three attempts')
  assert.ok(settled.output_lines.some(line => line.includes('no attempt was used')),
    'the row must say the refused turn was not spent')
  assert.match(settled.error || '', /Narration chunk 03 failed/, 'the row keeps the ordinary failure it ended on')
})
