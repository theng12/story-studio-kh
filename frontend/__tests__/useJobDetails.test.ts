import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { jobDetailKey, mergeJobDetail, needsJobDetail, useJobDetails, RUNNING_DETAIL_REFRESH_MS } from '../composables/useJobDetails.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function streamed(overrides: Record<string, unknown> = {}): any {
  return {
    job_id: 'job-1', project_slug: 'show', status: 'done', params: { model: 'm' },
    genstudio_jobs_count: 300, genstudio_jobs_updated_at: '2026-10-06T00:00:00.000Z', ...overrides,
  }
}
const full = (overrides: Record<string, unknown> = {}): any => ({
  job_id: 'job-1', project_slug: 'show', status: 'done', params: { model: 'old', genstudio_recovery: { assets: {} }, scenes: [1] },
  genstudio_jobs: [{ id: 'g1', operation: 'image.generation', state: 'succeeded' }], ...overrides,
})

describe('useJobDetails — full records for the cards a page shows', () => {
  test('only a slim job with evidence needs a fetch; the key moves with the evidence', () => {
    assert.equal(needsJobDetail(streamed()), true)
    assert.equal(needsJobDetail(streamed({ genstudio_jobs_count: 0 })), false)
    assert.equal(needsJobDetail(full()), false, 'a job that already carries its evidence is complete')
    assert.notEqual(jobDetailKey(streamed()), jobDetailKey(streamed({ genstudio_jobs_updated_at: '2026-10-06T00:00:01.000Z' })))
  })

  test('the merged card keeps the streamed fields and the fetched evidence', () => {
    const merged = mergeJobDetail(streamed({ status: 'error' }), full())
    assert.equal(merged.status, 'error')
    assert.equal(merged.params.model, 'm', 'the stream is fresher than the fetched copy')
    assert.deepEqual(merged.params.genstudio_recovery, { assets: {} })
    assert.equal(merged.genstudio_jobs?.length, 1)
  })

  test('fetches once per version through the per-job GET, and forgets jobs no longer shown', async () => {
    const paths: string[] = []
    const details = useJobDetails(async path => { paths.push(path); return full() })
    details.ensure([streamed()])
    details.ensure([streamed()])
    await tick()
    assert.deepEqual(paths, ['/projects/show/jobs/job-1'])
    assert.equal(details.withDetail(streamed()).genstudio_jobs?.length, 1)
    details.ensure([streamed()])
    await tick()
    assert.equal(paths.length, 1, 'an unchanged job is not fetched again')
    details.ensure([streamed({ genstudio_jobs_updated_at: '2026-10-06T00:01:00.000Z' })])
    await tick()
    assert.equal(paths.length, 2, 'new evidence refetches')
    details.ensure([])
    assert.equal(details.withDetail(streamed()).genstudio_jobs, undefined)
    details.ensure([streamed({ job_id: 'app-1', project_slug: '_app_' })])
    await tick()
    assert.equal(paths.at(-1), '/jobs/app/app-1')
  })

  test('a running job is refetched at most once per refresh window', async () => {
    let clock = 0
    const paths: string[] = []
    const details = useJobDetails(async path => { paths.push(path); return full({ status: 'running' }) }, () => clock)
    details.ensure([streamed({ status: 'running', genstudio_jobs_updated_at: 'a' })])
    await tick()
    details.ensure([streamed({ status: 'running', genstudio_jobs_updated_at: 'b' })])
    details.ensure([streamed({ status: 'running', genstudio_jobs_updated_at: 'c' })])
    await tick()
    assert.equal(paths.length, 1, 'changes inside the window wait')
    details.stop()
    clock = RUNNING_DETAIL_REFRESH_MS
    details.ensure([streamed({ status: 'running', genstudio_jobs_updated_at: 'd' })])
    await tick()
    assert.equal(paths.length, 2)
  })

  test('the Jobs page renders the merged view and asks for the cards it shows', () => {
    const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)), 'utf8')
    assert.match(page, /const jobs = computed\(\(\) => streamedJobs\.value\.map\(job => jobDetails\.withDetail\(job\)\)/)
    // Only the Active rows on screen (capped at 25 until Show All) ask for detail.
    assert.match(page, /\.\.\.visibleActiveJobs\.value, \.\.\.paginatedHistory\.value/)
  })
})
